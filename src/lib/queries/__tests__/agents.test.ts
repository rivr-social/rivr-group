/**
 * Agent Query Layer Tests
 *
 * Tests all 17 exported functions from src/lib/queries/agents.ts
 * against a real Postgres database with transaction-based isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import {
  createTestAgent,
  createTestGroup,
  createTestPlace,
  createTestLedgerEntry,
  createMembership,
} from "@/test/fixtures";
import type { TestDatabase } from "@/test/db";
import { agents, ledger } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

// Mock only the db module — schema and drizzle-orm are REAL
vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

// Import the module under test AFTER mocks
import {
  getAgent,
  getAgentByName,
  getAgentByEmail,
  getAgentByUsername,
  getAgentsByType,
  getAgentsNearby,
  searchAgents,
  getAgentChildren,
  getAgentWithChildren,
  getAgentFeed,
  getAgentReputation,
  getGroupMembers,
  getAgentsInScope,
  searchAgentsInScope,
  getAgentsByIds,
  getAllAgents,
  getPlacesByPlaceType,
} from "../agents";

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  it("returns an agent by ID", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      const result = await getAgent(agent.id);

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
      expect(result!.name).toBe(agent.name);
      expect(result!.type).toBe("person");
    }));

  it("returns undefined for non-existent ID", () =>
    withTestTransaction(async () => {
      const result = await getAgent("00000000-0000-0000-0000-000000000000");
      expect(result).toBeUndefined();
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const result = await getAgent(agent.id);
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentByName
// ---------------------------------------------------------------------------

describe("getAgentByName", () => {
  it("finds agent by exact name (case-insensitive)", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, { name: "Alice Wonderland" });
      const result = await getAgentByName("alice wonderland");

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
    }));

  it("returns undefined when no match", () =>
    withTestTransaction(async () => {
      const result = await getAgentByName("Nonexistent Agent 999");
      expect(result).toBeUndefined();
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, { name: "DeletedByName" });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const result = await getAgentByName("DeletedByName");
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentByEmail
// ---------------------------------------------------------------------------

describe("getAgentByEmail", () => {
  it("finds agent by email", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        email: "unique-email-test@test.local",
      });
      const result = await getAgentByEmail("unique-email-test@test.local");

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
    }));

  it("returns undefined for non-existent email", () =>
    withTestTransaction(async () => {
      const result = await getAgentByEmail("nonexistent@nowhere.example");
      expect(result).toBeUndefined();
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        email: "soft-deleted-email@test.local",
      });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const result = await getAgentByEmail("soft-deleted-email@test.local");
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentByUsername
// ---------------------------------------------------------------------------

describe("getAgentByUsername", () => {
  it("finds person agent by metadata.username (case-insensitive)", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        metadata: { username: "AliceW" },
      });
      const result = await getAgentByUsername("alicew");

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
    }));

  it("falls back to a slugified name when metadata.username is missing", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        name: "Alice W. River",
        email: null,
        metadata: {},
      });
      const result = await getAgentByUsername("alice-w-river");

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
    }));

  it("falls back to the email local-part when metadata.username is missing", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        email: "riverfriend@test.local",
        metadata: {},
      });
      const result = await getAgentByUsername("riverfriend");

      expect(result).toBeDefined();
      expect(result!.id).toBe(agent.id);
    }));

  it("returns undefined for empty username", () =>
    withTestTransaction(async () => {
      const result = await getAgentByUsername("  ");
      expect(result).toBeUndefined();
    }));

  it("returns undefined for non-existent username", () =>
    withTestTransaction(async () => {
      const result = await getAgentByUsername("ghost_user_999");
      expect(result).toBeUndefined();
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        metadata: { username: "deleteduser" },
      });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const result = await getAgentByUsername("deleteduser");
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentsByType
// ---------------------------------------------------------------------------

describe("getAgentsByType", () => {
  it("returns agents filtered by type", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db); // person
      await createTestGroup(db); // organization
      await createTestAgent(db); // person

      const persons = await getAgentsByType("person");
      expect(persons.length).toBeGreaterThanOrEqual(2);
      expect(persons.every((a) => a.type === "person")).toBe(true);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db);
      await createTestAgent(db);
      await createTestAgent(db);

      const result = await getAgentsByType("person", 2);
      expect(result.length).toBeLessThanOrEqual(2);
    }));

  it("returns empty array when no agents of type exist", () =>
    withTestTransaction(async () => {
      // 'bot' type unlikely to exist in a clean transaction
      const result = await getAgentsByType("bot");
      expect(result).toEqual([]);
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const results = await getAgentsByType("person");
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentsNearby (PostGIS)
// ---------------------------------------------------------------------------

describe("getAgentsNearby", () => {
  it("returns agents within the given radius", () =>
    withTestTransaction(async (db) => {
      // Portland, OR (lat ~45.5, lng ~-122.6)
      const portlandLng = -122.6765;
      const portlandLat = 45.5231;

      // Create an agent with a location via raw SQL (PostGIS)
      const agent = await createTestAgent(db, { name: "Portland Agent" });
      await db.execute(
        sql`UPDATE agents SET location = ST_SetSRID(ST_MakePoint(${portlandLng}, ${portlandLat}), 4326) WHERE id = ${agent.id}::uuid`
      );

      // Search within 10 km of Portland
      const results = await getAgentsNearby(portlandLat, portlandLng, 10000);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Portland Agent");
    }));

  it("excludes agents outside the radius", () =>
    withTestTransaction(async (db) => {
      // Put an agent in New York
      const nyLng = -74.006;
      const nyLat = 40.7128;

      const agent = await createTestAgent(db, { name: "NY Agent" });
      await db.execute(
        sql`UPDATE agents SET location = ST_SetSRID(ST_MakePoint(${nyLng}, ${nyLat}), 4326) WHERE id = ${agent.id}::uuid`
      );

      // Search near Portland (thousands of km from NY)
      const results = await getAgentsNearby(45.5231, -122.6765, 5000);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeUndefined();
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const lng = -122.6765;
      const lat = 45.5231;

      const agent = await createTestAgent(db, { name: "Deleted Nearby" });
      await db.execute(
        sql`UPDATE agents SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) WHERE id = ${agent.id}::uuid`
      );
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const results = await getAgentsNearby(lat, lng, 10000);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// searchAgents
// ---------------------------------------------------------------------------

describe("searchAgents", () => {
  it("finds agents by partial name match (case-insensitive)", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db, { name: "Searchable Zephyr" });
      await createTestAgent(db, { name: "Another Zephyr" });

      const results = await searchAgents("zephyr");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((a) => a.name.toLowerCase().includes("zephyr"))).toBe(true);
    }));

  it("returns empty array when no match", () =>
    withTestTransaction(async () => {
      const results = await searchAgents("xyznonexistent999");
      expect(results).toEqual([]);
    }));

  it("respects limit parameter", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db, { name: "LimitTest Alpha" });
      await createTestAgent(db, { name: "LimitTest Beta" });
      await createTestAgent(db, { name: "LimitTest Gamma" });

      const results = await searchAgents("LimitTest", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));
});

// ---------------------------------------------------------------------------
// getAgentChildren
// ---------------------------------------------------------------------------

describe("getAgentChildren", () => {
  it("returns children of a parent agent", () =>
    withTestTransaction(async (db) => {
      const parent = await createTestGroup(db);
      const child1 = await createTestAgent(db, { parentId: parent.id });
      const child2 = await createTestAgent(db, { parentId: parent.id });

      const children = await getAgentChildren(parent.id);
      expect(children.length).toBe(2);

      const childIds = children.map((c) => c.id).sort();
      expect(childIds).toEqual([child1.id, child2.id].sort());
    }));

  it("returns empty array when no children", () =>
    withTestTransaction(async (db) => {
      const loner = await createTestAgent(db);
      const children = await getAgentChildren(loner.id);
      expect(children).toEqual([]);
    }));

  it("excludes soft-deleted children", () =>
    withTestTransaction(async (db) => {
      const parent = await createTestGroup(db);
      const child = await createTestAgent(db, { parentId: parent.id });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, child.id));

      const children = await getAgentChildren(parent.id);
      expect(children).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------
// getAgentWithChildren
// ---------------------------------------------------------------------------

describe("getAgentWithChildren", () => {
  it("returns agent with its children", () =>
    withTestTransaction(async (db) => {
      const parent = await createTestGroup(db, { name: "Parent Org" });
      await createTestAgent(db, { parentId: parent.id, name: "Child A" });
      await createTestAgent(db, { parentId: parent.id, name: "Child B" });

      const result = await getAgentWithChildren(parent.id);

      expect(result).toBeDefined();
      expect(result!.id).toBe(parent.id);
      expect(result!.name).toBe("Parent Org");
      expect(result!.children).toBeDefined();
      expect(result!.children.length).toBe(2);
    }));

  it("returns agent with empty children array when no children", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      const result = await getAgentWithChildren(agent.id);

      expect(result).toBeDefined();
      expect(result!.children).toEqual([]);
    }));

  it("returns undefined for non-existent agent", () =>
    withTestTransaction(async () => {
      const result = await getAgentWithChildren(
        "00000000-0000-0000-0000-000000000000"
      );
      expect(result).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// getAgentFeed
// ---------------------------------------------------------------------------

describe("getAgentFeed", () => {
  it("returns ledger entries where agent is subject", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await createTestLedgerEntry(db, agent.id, { verb: "view" });
      await createTestLedgerEntry(db, agent.id, { verb: "create" });

      const feed = await getAgentFeed(agent.id);
      expect(feed.length).toBe(2);
      expect(feed.every((e) => e.subjectId === agent.id)).toBe(true);
    }));

  it("returns ledger entries where agent is object", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      const other = await createTestAgent(db);
      await createTestLedgerEntry(db, other.id, {
        verb: "view",
        objectId: agent.id,
        objectType: "agent",
      });

      const feed = await getAgentFeed(agent.id);
      expect(feed.length).toBe(1);
      expect(feed[0].objectId).toBe(agent.id);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await createTestLedgerEntry(db, agent.id, { verb: "view" });
      await createTestLedgerEntry(db, agent.id, { verb: "create" });
      await createTestLedgerEntry(db, agent.id, { verb: "update" });

      const feed = await getAgentFeed(agent.id, 2);
      expect(feed.length).toBeLessThanOrEqual(2);
    }));

  it("returns empty array for agent with no feed", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      const feed = await getAgentFeed(agent.id);
      expect(feed).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------
// getAgentReputation
// ---------------------------------------------------------------------------

describe("getAgentReputation", () => {
  it("returns reputation from metadata", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        metadata: { reputation: 42 },
      });
      const rep = await getAgentReputation(agent.id);
      expect(rep).toBe(42);
    }));

  it("returns 0 when no reputation in metadata", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, { metadata: {} });
      const rep = await getAgentReputation(agent.id);
      expect(rep).toBe(0);
    }));

  it("returns 0 for non-existent agent", () =>
    withTestTransaction(async () => {
      const rep = await getAgentReputation(
        "00000000-0000-0000-0000-000000000000"
      );
      expect(rep).toBe(0);
    }));

  it("returns 0 when reputation is not a number", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db, {
        metadata: { reputation: "high" },
      });
      const rep = await getAgentReputation(agent.id);
      expect(rep).toBe(0);
    }));
});

// ---------------------------------------------------------------------------
// getGroupMembers
// ---------------------------------------------------------------------------

describe("getGroupMembers", () => {
  it("returns children of type person (hierarchical approach)", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const member1 = await createTestAgent(db, { parentId: group.id });
      const member2 = await createTestAgent(db, { parentId: group.id });

      const members = await getGroupMembers(group.id);
      expect(members.length).toBe(2);

      const memberIds = members.map((m) => m.id).sort();
      expect(memberIds).toEqual([member1.id, member2.id].sort());
    }));

  it("falls back to ledger-based membership when no children", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const member = await createTestAgent(db);
      await createMembership(db, member.id, group.id);

      const members = await getGroupMembers(group.id);
      expect(members.length).toBe(1);
      expect(members[0].id).toBe(member.id);
    }));

  it("falls back to creatorId when legacy groups have no membership edge", () =>
    withTestTransaction(async (db) => {
      const creator = await createTestAgent(db);
      const group = await createTestGroup(db, { metadata: { creatorId: creator.id } });

      const members = await getGroupMembers(group.id);
      expect(members.length).toBe(1);
      expect(members[0].id).toBe(creator.id);
    }));

  it("returns empty for group with no members", () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const members = await getGroupMembers(group.id);
      expect(members).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------
// getAgentsInScope
// ---------------------------------------------------------------------------

describe("getAgentsInScope", () => {
  it("returns agents whose parentId matches the scope", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const child = await createTestAgent(db, { parentId: scope.id });

      const results = await getAgentsInScope(scope.id);
      const found = results.find((a) => a.id === child.id);
      expect(found).toBeDefined();
    }));

  it("returns agents whose pathIds contain the scopeId", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const agent = await createTestAgent(db, { pathIds: [scope.id] });

      const results = await getAgentsInScope(scope.id);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeDefined();
    }));

  it("returns agents with matching chapterTags in metadata", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const agent = await createTestAgent(db, {
        metadata: { chapterTags: [scope.id] },
      });

      const results = await getAgentsInScope(scope.id);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeDefined();
    }));

  it("filters by type when provided", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      await createTestAgent(db, { parentId: scope.id }); // person
      await createTestGroup(db, { parentId: scope.id }); // organization

      const persons = await getAgentsInScope(scope.id, { type: "person" });
      expect(persons.every((a) => a.type === "person")).toBe(true);
    }));

  it("respects limit and offset", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      await createTestAgent(db, { parentId: scope.id });
      await createTestAgent(db, { parentId: scope.id });
      await createTestAgent(db, { parentId: scope.id });

      const page1 = await getAgentsInScope(scope.id, { limit: 2, offset: 0 });
      expect(page1.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      const agent = await createTestAgent(db, { parentId: scope.id });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const results = await getAgentsInScope(scope.id);
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeUndefined();
    }));
});

// ---------------------------------------------------------------------------
// searchAgentsInScope
// ---------------------------------------------------------------------------

describe("searchAgentsInScope", () => {
  it("finds agents by name within a scope", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      await createTestAgent(db, { parentId: scope.id, name: "ScopedAlpha" });
      await createTestAgent(db, { parentId: scope.id, name: "ScopedBeta" });
      // Agent outside scope
      await createTestAgent(db, { name: "ScopedAlpha Outside" });

      const results = await searchAgentsInScope(scope.id, "ScopedAlpha");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("ScopedAlpha");
    }));

  it("returns empty when no match in scope", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      await createTestAgent(db, { parentId: scope.id, name: "OnlyThis" });

      const results = await searchAgentsInScope(scope.id, "xyznotfound");
      expect(results).toEqual([]);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      const scope = await createTestGroup(db);
      await createTestAgent(db, { parentId: scope.id, name: "LimScope A" });
      await createTestAgent(db, { parentId: scope.id, name: "LimScope B" });
      await createTestAgent(db, { parentId: scope.id, name: "LimScope C" });

      const results = await searchAgentsInScope(scope.id, "LimScope", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));
});

// ---------------------------------------------------------------------------
// getAgentsByIds
// ---------------------------------------------------------------------------

describe("getAgentsByIds", () => {
  it("returns agents matching the given IDs", () =>
    withTestTransaction(async (db) => {
      const a1 = await createTestAgent(db);
      const a2 = await createTestAgent(db);
      await createTestAgent(db); // not requested

      const results = await getAgentsByIds([a1.id, a2.id]);
      expect(results.length).toBe(2);

      const ids = results.map((a) => a.id).sort();
      expect(ids).toEqual([a1.id, a2.id].sort());
    }));

  it("returns empty array for empty input", () =>
    withTestTransaction(async () => {
      const results = await getAgentsByIds([]);
      expect(results).toEqual([]);
    }));

  it("excludes soft-deleted agents from results", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const results = await getAgentsByIds([agent.id]);
      expect(results).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------
// getAllAgents
// ---------------------------------------------------------------------------

describe("getAllAgents", () => {
  it("returns all agents with no filter", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db);
      await createTestGroup(db);

      const results = await getAllAgents();
      expect(results.length).toBeGreaterThanOrEqual(2);
    }));

  it("filters by type", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db); // person
      await createTestGroup(db); // organization

      const orgs = await getAllAgents({ type: "organization" });
      expect(orgs.every((a) => a.type === "organization")).toBe(true);
    }));

  it("respects limit and offset", () =>
    withTestTransaction(async (db) => {
      await createTestAgent(db);
      await createTestAgent(db);
      await createTestAgent(db);

      const page = await getAllAgents({ limit: 2, offset: 0 });
      expect(page.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const agent = await createTestAgent(db);
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, agent.id));

      const results = await getAllAgents();
      const found = results.find((a) => a.id === agent.id);
      expect(found).toBeUndefined();
    }));

  it("orders by createdAt descending", () =>
    withTestTransaction(async (db) => {
      const a1 = await createTestAgent(db);
      // Force a1 to have an earlier timestamp so ordering is deterministic
      await db
        .update(agents)
        .set({ createdAt: new Date(Date.now() - 5000) })
        .where(eq(agents.id, a1.id));
      const a2 = await createTestAgent(db);

      const results = await getAllAgents();
      // Filter to only the two agents created in this test to avoid
      // interference from agents created by concurrent tests
      const testIds = new Set([a1.id, a2.id]);
      const filtered = results.filter((a) => testIds.has(a.id));

      expect(filtered.length).toBe(2);
      // a2 was created after a1, so it should appear first (descending)
      expect(filtered[0].id).toBe(a2.id);
      expect(filtered[1].id).toBe(a1.id);
    }));
});

// ---------------------------------------------------------------------------
// getPlacesByPlaceType
// ---------------------------------------------------------------------------

describe("getPlacesByPlaceType", () => {
  it("returns place agents with matching placeType metadata", () =>
    withTestTransaction(async (db) => {
      await createTestPlace(db, {
        metadata: { placeType: "chapter" },
      });
      await createTestPlace(db, {
        metadata: { placeType: "basin" },
      });

      const chapters = await getPlacesByPlaceType("chapter");
      expect(chapters.length).toBeGreaterThanOrEqual(1);
      expect(
        chapters.every(
          (a) =>
            (a.metadata as Record<string, unknown>)?.placeType === "chapter" ||
            (a.metadata as Record<string, unknown>)?.placeType === "locale"
        )
      ).toBe(true);
    }));

  it("returns organization agents with matching placeType metadata", () =>
    withTestTransaction(async (db) => {
      await createTestGroup(db, {
        metadata: { placeType: "chapter" },
      });

      const results = await getPlacesByPlaceType("chapter");
      expect(results.length).toBeGreaterThanOrEqual(1);
    }));

  it("resolves aliases (chapter ↔ locale)", () =>
    withTestTransaction(async (db) => {
      await createTestPlace(db, {
        metadata: { placeType: "locale" },
      });

      // Searching for "chapter" should also return "locale" due to aliases
      const results = await getPlacesByPlaceType("chapter");
      const hasLocale = results.some(
        (a) => (a.metadata as Record<string, unknown>)?.placeType === "locale"
      );
      expect(hasLocale).toBe(true);
    }));

  it("resolves aliases (basin ↔ region)", () =>
    withTestTransaction(async (db) => {
      await createTestPlace(db, {
        metadata: { placeType: "region" },
      });

      const results = await getPlacesByPlaceType("basin");
      const hasRegion = results.some(
        (a) => (a.metadata as Record<string, unknown>)?.placeType === "region"
      );
      expect(hasRegion).toBe(true);
    }));

  it("respects the limit parameter", () =>
    withTestTransaction(async (db) => {
      await createTestPlace(db, { metadata: { placeType: "council" } });
      await createTestPlace(db, { metadata: { placeType: "council" } });
      await createTestPlace(db, { metadata: { placeType: "council" } });

      const results = await getPlacesByPlaceType("council", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    }));

  it("excludes soft-deleted agents", () =>
    withTestTransaction(async (db) => {
      const place = await createTestPlace(db, {
        metadata: { placeType: "chapter" },
      });
      await db
        .update(agents)
        .set({ deletedAt: new Date() })
        .where(eq(agents.id, place.id));

      const results = await getPlacesByPlaceType("chapter");
      const found = results.find((a) => a.id === place.id);
      expect(found).toBeUndefined();
    }));
});
