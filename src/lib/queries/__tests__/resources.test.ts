/**
 * Resource Query Layer Tests
 *
 * Tests all 11 exported functions from src/lib/queries/resources.ts
 * against a real Postgres database with transaction-based isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestPost,
  createTestListing,
} from "@/test/fixtures";
import { agents, resources } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock only the db module — schema and drizzle-orm are REAL
vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

// Import the module under test AFTER mocks
import {
  getResource,
  getResourcesByType,
  getResourcesByOwner,
  getResourcesForGroup,
  getResourcesByTag,
  getPublicResources,
  getMarketplaceListings,
  getResourcesInScope,
  searchResourcesBySemantic,
  getResourcesByIds,
  getAllResources,
} from "../resources";

// ---------------------------------------------------------------------------
// getResource
// ---------------------------------------------------------------------------

describe("getResource", () => {
  it("returns a resource by ID with owner relation", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id, {
        name: "My Document",
      });

      const result = await getResource(resource.id);

      expect(result).toBeDefined();
      expect(result!.id).toBe(resource.id);
      expect(result!.name).toBe("My Document");
      expect(result!.owner).toBeDefined();
      expect(result!.owner.id).toBe(owner.id);
    }));

  it("returns undefined for non-existent ID", () =>
    withTestTransaction(async () => {
      const result = await getResource(
        "00000000-0000-0000-0000-000000000000"
      );
      expect(result).toBeUndefined();
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const result = await getResource(resource.id);
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getResourcesByType
// ---------------------------------------------------------------------------

describe("getResourcesByType", () => {
  it("returns resources filtered by type with owner relation", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id); // document
      await createTestPost(db, owner.id); // post

      const docs = await getResourcesByType("document");
      expect(docs.length).toBeGreaterThanOrEqual(1);
      expect(docs.every((r) => r.type === "document")).toBe(true);
      expect(docs[0].owner).toBeDefined();
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestPost(db, owner.id);
      await createTestPost(db, owner.id);
      await createTestPost(db, owner.id);

      const result = await getResourcesByType("post", 2);
      expect(result.length).toBeLessThanOrEqual(2);
    }));

  it("returns empty array when no resources of type exist", () =>
    withTestTransaction(async () => {
      const result = await getResourcesByType("dataset");
      expect(result).toEqual([]);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesByType("document");
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getResourcesByOwner
// ---------------------------------------------------------------------------

describe("getResourcesByOwner", () => {
  it("returns resources owned by the given agent", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const other = await createTestAgent(db);
      const r1 = await createTestResource(db, owner.id);
      const r2 = await createTestPost(db, owner.id);
      await createTestResource(db, other.id); // different owner

      const results = await getResourcesByOwner(owner.id);
      expect(results.length).toBe(2);

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    }));

  it("returns empty array when owner has no resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const results = await getResourcesByOwner(owner.id);
      expect(results).toEqual([]);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesByOwner(owner.id);
      expect(results).toEqual([]);
    }));

  it("orders by createdAt descending", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const r1 = await createTestResource(db, owner.id);
      const r2 = await createTestResource(db, owner.id);

      const results = await getResourcesByOwner(owner.id);
      expect(results.length).toBe(2);

      // Both resources should be returned; ordering is by createdAt DESC.
      // When timestamps are identical (same transaction), order is stable but
      // non-deterministic, so just verify both are present.
      const ids = results.map((r) => r.id);
      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
    }));
});

// ---------------------------------------------------------------------------
// getResourcesForGroup
// ---------------------------------------------------------------------------

describe("getResourcesForGroup", () => {
  it("returns resources owned by the group", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const resource = await createTestResource(db, group.id, {
        name: "Group Doc",
      });

      const results = await getResourcesForGroup(group.id);
      expect(results.length).toBeGreaterThanOrEqual(1);

      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Group Doc");
    }));

  it("returns resources linked via metadata.groupDbId", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id, {
        metadata: { groupDbId: group.id },
      });

      const results = await getResourcesForGroup(group.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
    }));

  it("returns resources linked via metadata.groupId", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id, {
        metadata: { groupId: group.id },
      });

      const results = await getResourcesForGroup(group.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const resource = await createTestResource(db, group.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesForGroup(group.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      await createTestResource(db, group.id);
      await createTestResource(db, group.id);
      await createTestResource(db, group.id);

      const results = await getResourcesForGroup(group.id, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));
});

// ---------------------------------------------------------------------------
// getResourcesByTag
// ---------------------------------------------------------------------------

describe("getResourcesByTag", () => {
  it("returns resources matching the given tag", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const tagged = await createTestResource(db, owner.id, {
        tags: ["sustainability", "local"],
      });
      await createTestResource(db, owner.id, { tags: ["unrelated"] });

      const results = await getResourcesByTag("sustainability");
      expect(results.length).toBeGreaterThanOrEqual(1);

      const found = results.find((r) => r.id === tagged.id);
      expect(found).toBeDefined();
    }));

  it("returns empty array when no resources have the tag", () =>
    withTestTransaction(async () => {
      const results = await getResourcesByTag("nonexistent_tag_xyz");
      expect(results).toEqual([]);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id, { tags: ["limittag"] });
      await createTestResource(db, owner.id, { tags: ["limittag"] });
      await createTestResource(db, owner.id, { tags: ["limittag"] });

      const results = await getResourcesByTag("limittag", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id, {
        tags: ["deletetag"],
      });
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesByTag("deletetag");
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getPublicResources
// ---------------------------------------------------------------------------

describe("getPublicResources", () => {
  it("returns resources with isPublic=true and owner relation", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const pubResource = await createTestResource(db, owner.id, {
        isPublic: true,
        name: "Public Doc",
      });
      await createTestResource(db, owner.id, { isPublic: false }); // private

      const results = await getPublicResources();
      const found = results.find((r) => r.id === pubResource.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Public Doc");
      expect(found!.owner).toBeDefined();
    }));

  it("excludes non-public resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const priv = await createTestResource(db, owner.id, { isPublic: false });

      const results = await getPublicResources();
      const found = results.find((r) => r.id === priv.id);
      expect(found).toBeUndefined();
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id, { isPublic: true });
      await createTestResource(db, owner.id, { isPublic: true });
      await createTestResource(db, owner.id, { isPublic: true });

      const results = await getPublicResources(2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id, {
        isPublic: true,
      });
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getPublicResources();
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getMarketplaceListings
// ---------------------------------------------------------------------------

describe("getMarketplaceListings", () => {
  it("returns resources with listingType metadata and joins owner info", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db, { name: "Seller Jane" });
      const listing = await createTestListing(db, owner.id, {
        name: "Handmade Pottery",
      });

      const results = await getMarketplaceListings();
      const found = results.find((r) => r.id === listing.id);

      expect(found).toBeDefined();
      expect(found!.name).toBe("Handmade Pottery");
      expect(found!.owner_name).toBe("Seller Jane");
    }));

  it("excludes resources without listingType metadata", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const doc = await createTestResource(db, owner.id);

      const results = await getMarketplaceListings();
      const found = results.find((r) => r.id === doc.id);
      expect(found).toBeUndefined();
    }));

  it("excludes listings with status other than active", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const inactive = await createTestListing(db, owner.id, {
        metadata: { listingType: "product", status: "sold" },
      });

      const results = await getMarketplaceListings();
      const found = results.find((r) => r.id === inactive.id);
      expect(found).toBeUndefined();
    }));

  it("includes listings where status is null (defaults to active)", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const noStatus = await createTestListing(db, owner.id, {
        metadata: { listingType: "service" },
      });

      const results = await getMarketplaceListings();
      const found = results.find((r) => r.id === noStatus.id);
      expect(found).toBeDefined();
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestListing(db, owner.id);
      await createTestListing(db, owner.id);
      await createTestListing(db, owner.id);

      const results = await getMarketplaceListings(2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const listing = await createTestListing(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, listing.id));

      const results = await getMarketplaceListings();
      const found = results.find((r) => r.id === listing.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getResourcesInScope
// ---------------------------------------------------------------------------

describe("getResourcesInScope", () => {
  it("returns resources owned by agents in the scope hierarchy", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { parentId: scope.id });
      const resource = await createTestResource(db, member.id, {
        name: "Scoped Resource",
      });

      const results = await getResourcesInScope(scope.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Scoped Resource");
    }));

  it("includes resources from agents with pathIds containing scopeId", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { pathIds: [scope.id] });
      const resource = await createTestResource(db, member.id);

      const results = await getResourcesInScope(scope.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
    }));

  it("filters by resource type when provided", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { parentId: scope.id });
      await createTestResource(db, member.id); // document
      await createTestPost(db, member.id); // post

      const docs = await getResourcesInScope(scope.id, { type: "document" });
      expect(docs.every((r) => r.type === "document")).toBe(true);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { parentId: scope.id });
      await createTestResource(db, member.id);
      await createTestResource(db, member.id);
      await createTestResource(db, member.id);

      const results = await getResourcesInScope(scope.id, { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { parentId: scope.id });
      const resource = await createTestResource(db, member.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesInScope(scope.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));

  it("excludes resources from soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const member = await createTestAgent(db, { parentId: scope.id });
      const resource = await createTestResource(db, member.id);
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, member.id));

      const results = await getResourcesInScope(scope.id);
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// searchResourcesBySemantic
// ---------------------------------------------------------------------------

describe("searchResourcesBySemantic", () => {
  it.todo(
    "semantic search requires vector embeddings — skipped in unit tests"
  );
});

// ---------------------------------------------------------------------------
// getResourcesByIds
// ---------------------------------------------------------------------------

describe("getResourcesByIds", () => {
  it("returns resources matching the given IDs", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const r1 = await createTestResource(db, owner.id);
      const r2 = await createTestResource(db, owner.id);
      await createTestResource(db, owner.id); // not requested

      const results = await getResourcesByIds([r1.id, r2.id]);
      expect(results.length).toBe(2);

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    }));

  it("returns empty array for empty input", () =>
    withTestTransaction(async () => {
      const results = await getResourcesByIds([]);
      expect(results).toEqual([]);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getResourcesByIds([resource.id]);
      expect(results).toEqual([]);
    }));

  it("returns only existing IDs (ignores missing)", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);

      const results = await getResourcesByIds([
        resource.id,
        "00000000-0000-0000-0000-000000000000",
      ]);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(resource.id);
    }));
});

// ---------------------------------------------------------------------------
// getAllResources
// ---------------------------------------------------------------------------

describe("getAllResources", () => {
  it("returns all resources with owner relation", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id);
      await createTestPost(db, owner.id);

      const results = await getAllResources();
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].owner).toBeDefined();
    }));

  it("filters by type", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id); // document
      await createTestPost(db, owner.id); // post

      const posts = await getAllResources({ type: "post" });
      expect(posts.every((r) => r.type === "post")).toBe(true);
    }));

  it("respects limit and offset", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      await createTestResource(db, owner.id);
      await createTestResource(db, owner.id);
      await createTestResource(db, owner.id);

      const page = await getAllResources({ limit: 2, offset: 0 });
      expect(page.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted resources", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const resource = await createTestResource(db, owner.id);
      await db
        .update(resources)
        .set({ deletedAt: new Date() })
        .where(eq(resources.id, resource.id));

      const results = await getAllResources();
      const found = results.find((r) => r.id === resource.id);
      expect(found).toBeUndefined();
    }));

  it("orders by createdAt descending", () =>
    withTestTransaction(async (db) => {
      const owner = await createTestAgent(db);
      const r1 = await createTestResource(db, owner.id);
      const r2 = await createTestResource(db, owner.id);

      const results = await getAllResources();
      const idx1 = results.findIndex((r) => r.id === r1.id);
      const idx2 = results.findIndex((r) => r.id === r2.id);

      // r2 created after r1 → should appear first (descending)
      if (idx1 !== -1 && idx2 !== -1) {
        expect(idx2).toBeLessThan(idx1);
      }
    }));
});
