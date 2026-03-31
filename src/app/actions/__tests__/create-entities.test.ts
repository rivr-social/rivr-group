import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
}));

vi.mock("@/lib/permissions", () => ({
  canView: vi.fn().mockResolvedValue({ allowed: true, reason: "ok" }),
}));

vi.mock("@/lib/ai", () => ({
  embedAgent: vi.fn(),
  embedResource: vi.fn(),
  scheduleEmbedding: vi.fn((fn: () => void) => fn()),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { canView } from "@/lib/permissions";
import { createEntitiesFromScaffold } from "../create-entities";
import type { CreateEntitiesPayload, ConfirmedEntity } from "../create-entities";

// =============================================================================
// Helpers
// =============================================================================

function makeEntity(overrides: Partial<ConfirmedEntity> = {}): ConfirmedEntity {
  return {
    tempId: "e1",
    type: "project",
    name: "River Cleanup",
    properties: [],
    ...overrides,
  };
}

function makePayload(overrides: Partial<CreateEntitiesPayload> = {}): CreateEntitiesPayload {
  return {
    entities: [makeEntity()],
    relationships: [],
    originalInput: "create a project called River Cleanup",
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("create-entities actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
    vi.mocked(canView).mockResolvedValue({ allowed: true, reason: "ok" });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe("authentication", () => {
    it("returns unauthenticated error when not logged in", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await createEntitiesFromScaffold(makePayload());

        expect(result.success).toBe(false);
        expect(result.errors).toContain("UNAUTHENTICATED");
        expect(result.message).toContain("logged in");
      }));
  });

  // ===========================================================================
  // Rate limiting
  // ===========================================================================

  describe("rate limiting", () => {
    it("returns rate limited error when limit exceeded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValue({ success: false, resetMs: 30000 });

        const result = await createEntitiesFromScaffold(makePayload());

        expect(result.success).toBe(false);
        expect(result.errors).toContain("RATE_LIMITED");
        expect(result.message).toContain("30 seconds");
      }));
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe("validation", () => {
    it("returns invalid payload error when entities array is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(makePayload({ entities: [] }));

        expect(result.success).toBe(false);
        expect(result.errors).toContain("INVALID_PAYLOAD");
      }));

    it("returns invalid payload error when entity has no name", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({ entities: [makeEntity({ name: "" })] })
        );

        expect(result.success).toBe(false);
        expect(result.errors).toContain("INVALID_PAYLOAD");
      }));

    it("returns invalid payload error for invalid entity type", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [makeEntity({ type: "invalid_type" as ConfirmedEntity["type"] })],
          })
        );

        expect(result.success).toBe(false);
        expect(result.errors).toContain("INVALID_PAYLOAD");
        expect(result.message).toContain("invalid type");
      }));
  });

  // ===========================================================================
  // Successful creation
  // ===========================================================================

  describe("successful creation", () => {
    it("creates a project entity in resources table", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(makePayload());

        expect(result.success).toBe(true);
        expect(result.createdIds.length).toBe(1);
        expect(result.createdIds[0].name).toBe("River Cleanup");
        expect(result.createdIds[0].type).toBe("project");
        expect(result.message).toContain("Created 1 entity");
      }));

    it("creates a person entity in agents table", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [makeEntity({ tempId: "p1", type: "person", name: "Jane Doe" })],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds[0].type).toBe("person");
      }));

    it("creates an organization entity in agents table", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [makeEntity({ tempId: "o1", type: "organization", name: "Rivr Org" })],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds[0].type).toBe("organization");
      }));

    it("creates multiple entities in a single call", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [
              makeEntity({ tempId: "e1", type: "project", name: "Project A" }),
              makeEntity({ tempId: "e2", type: "event", name: "Event B" }),
            ],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds.length).toBe(2);
        expect(result.message).toContain("Created 2 entities");
      }));

    it("stores entity properties in metadata", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [
              makeEntity({
                properties: [
                  { key: "description", value: "Community cleanup day" },
                  { key: "location", value: "Downtown" },
                ],
              }),
            ],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds.length).toBe(1);
      }));
  });

  // ===========================================================================
  // Existing entity linking
  // ===========================================================================

  describe("existing entity linking", () => {
    it("links an existing entity instead of creating a new one", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const existing = await createTestResource(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [
              makeEntity({
                isExisting: true,
                existingId: existing.id,
                targetTable: "resources",
              }),
            ],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds[0].dbId).toBe(existing.id);
        expect(result.message).toContain("Linked 1 existing");
      }));

    it("rejects linking when view permission is denied", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const existing = await createTestResource(db, user.id);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(canView).mockResolvedValue({ allowed: false, reason: "private" });

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [
              makeEntity({
                isExisting: true,
                existingId: existing.id,
                targetTable: "resources",
              }),
            ],
          })
        );

        expect(result.success).toBe(false);
        expect(result.errors).toContain("CREATION_FAILED");
        expect(result.message).toContain("permission");
      }));
  });

  // ===========================================================================
  // Relationships
  // ===========================================================================

  describe("relationships", () => {
    it("creates ledger entries for entity relationships", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [
              makeEntity({ tempId: "e1", type: "event", name: "Community Event" }),
              makeEntity({ tempId: "e2", type: "project", name: "Green Project" }),
            ],
            relationships: [
              { type: "related_to", fromTempId: "e1", toTempId: "e2" },
            ],
          })
        );

        expect(result.success).toBe(true);
        expect(result.createdIds.length).toBe(2);
      }));

    it("skips relationships with unresolved temp ids", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createEntitiesFromScaffold(
          makePayload({
            entities: [makeEntity({ tempId: "e1" })],
            relationships: [
              { type: "related_to", fromTempId: "e1", toTempId: "nonexistent" },
            ],
          })
        );

        expect(result.success).toBe(true);
      }));
  });
});
