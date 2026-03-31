import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents } from "@/db/schema";

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

let mockActivePersonaId: string | null = null;

vi.mock("@/lib/persona", () => ({
  MAX_PERSONAS_PER_ACCOUNT: 10,
  getActivePersonaId: vi.fn(async () => mockActivePersonaId),
  setActivePersonaCookie: vi.fn(async (id: string | null) => {
    mockActivePersonaId = id;
  }),
}));

vi.mock("@/lib/graph-serializers", () => ({
  serializeAgent: vi.fn((agent: Record<string, unknown>) => ({
    id: agent.id,
    name: agent.name,
    type: agent.type,
    image: agent.image ?? null,
    metadata: agent.metadata ?? {},
  })),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import {
  createPersona,
  listMyPersonas,
  updatePersona,
  deletePersona,
  switchActivePersona,
  getActivePersonaInfo,
} from "../personas";

// =============================================================================
// Constants
// =============================================================================

const MAX_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 40;
const MAX_BIO_LENGTH = 500;
const VALID_UUID = "00000000-0000-4000-8000-000000000001";

// =============================================================================
// Tests
// =============================================================================

describe("personas actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivePersonaId = null;
  });

  // ===========================================================================
  // createPersona
  // ===========================================================================

  describe("createPersona", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(createPersona({ name: "Alt" })).rejects.toThrow("Unauthorized");
      }));

    it("returns error when name is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({ name: "" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Name is required");
      }));

    it("returns error when name exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({ name: "A".repeat(MAX_NAME_LENGTH + 1) });
        expect(result.success).toBe(false);
        expect(result.error).toContain("under 100");
      }));

    it("returns error when username exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({
          name: "Alt",
          username: "a".repeat(MAX_USERNAME_LENGTH + 1),
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("under 40");
      }));

    it("returns error when bio exceeds max length", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({
          name: "Alt",
          bio: "B".repeat(MAX_BIO_LENGTH + 1),
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("under 500");
      }));

    it("creates a persona and returns its id", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({
          name: "My Alt",
          username: "myalt",
          bio: "Alternative persona",
        });

        expect(result.success).toBe(true);
        expect(result.personaId).toBeDefined();

        // Verify in DB
        const [persona] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.personaId!));
        expect(persona.name).toBe("My Alt");
        expect(persona.parentAgentId).toBe(user.id);
        expect(persona.type).toBe("person");
        const meta = persona.metadata as Record<string, unknown>;
        expect(meta.isPersona).toBe(true);
        expect(meta.username).toBe("myalt");
        expect(meta.bio).toBe("Alternative persona");
      }));

    it("sanitizes username to lowercase alphanumeric", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await createPersona({
          name: "Alt",
          username: "My User Name!",
        });

        expect(result.success).toBe(true);
        const [persona] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, result.personaId!));
        const meta = persona.metadata as Record<string, unknown>;
        expect(meta.username).toBe("myusername");
      }));

    it("returns error when username is already taken", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await createPersona({ name: "First", username: "taken" });
        const result = await createPersona({ name: "Second", username: "taken" });

        expect(result.success).toBe(false);
        expect(result.error).toContain("already taken");
      }));

    it("returns error when persona limit is reached", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // Create max personas
        for (let i = 0; i < 10; i++) {
          await createPersona({ name: `Persona ${i}` });
        }

        const result = await createPersona({ name: "One Too Many" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("at most 10");
      }));
  });

  // ===========================================================================
  // listMyPersonas
  // ===========================================================================

  describe("listMyPersonas", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(listMyPersonas()).rejects.toThrow("Unauthorized");
      }));

    it("returns empty list when user has no personas", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await listMyPersonas();
        expect(result.success).toBe(true);
        expect(result.personas).toEqual([]);
        expect(result.activePersonaId).toBeNull();
      }));

    it("returns user's personas", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        await createPersona({ name: "Alt 1" });
        await createPersona({ name: "Alt 2" });

        const result = await listMyPersonas();
        expect(result.success).toBe(true);
        expect(result.personas?.length).toBe(2);
      }));

    it("excludes deleted personas", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "To Delete" });
        await deletePersona(created.personaId!);

        const result = await listMyPersonas();
        expect(result.personas?.length).toBe(0);
      }));
  });

  // ===========================================================================
  // updatePersona
  // ===========================================================================

  describe("updatePersona", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(
          updatePersona({ personaId: VALID_UUID, name: "New" })
        ).rejects.toThrow("Unauthorized");
      }));

    it("returns error for invalid persona id format", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updatePersona({ personaId: "not-a-uuid", name: "New" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid persona ID");
      }));

    it("returns error when persona does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await updatePersona({ personaId: VALID_UUID, name: "New" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
      }));

    it("returns error when persona belongs to another user", () =>
      withTestTransaction(async (db) => {
        const user1 = await createTestAgent(db);
        const user2 = await createTestAgent(db);

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user1.id));
        const created = await createPersona({ name: "User1 Alt" });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user2.id));
        const result = await updatePersona({
          personaId: created.personaId!,
          name: "Hijack",
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("not owned by you");
      }));

    it("updates persona name", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Original" });
        const result = await updatePersona({
          personaId: created.personaId!,
          name: "Updated",
        });

        expect(result.success).toBe(true);

        const [persona] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, created.personaId!));
        expect(persona.name).toBe("Updated");
      }));

    it("returns error when updated name is empty", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Original" });
        const result = await updatePersona({
          personaId: created.personaId!,
          name: "",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Name is required");
      }));

    it("updates persona bio", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Alt" });
        const result = await updatePersona({
          personaId: created.personaId!,
          bio: "New bio",
        });

        expect(result.success).toBe(true);

        const [persona] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, created.personaId!));
        const meta = persona.metadata as Record<string, unknown>;
        expect(meta.bio).toBe("New bio");
      }));
  });

  // ===========================================================================
  // deletePersona
  // ===========================================================================

  describe("deletePersona", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(deletePersona(VALID_UUID)).rejects.toThrow("Unauthorized");
      }));

    it("returns error for invalid persona id", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deletePersona("not-a-uuid");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid persona ID");
      }));

    it("returns error when persona does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await deletePersona(VALID_UUID);
        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
      }));

    it("soft-deletes a persona", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "To Delete" });
        const result = await deletePersona(created.personaId!);

        expect(result.success).toBe(true);

        const [persona] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, created.personaId!));
        expect(persona.deletedAt).not.toBeNull();
      }));

    it("clears active persona cookie when deleting the active persona", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Active Alt" });
        mockActivePersonaId = created.personaId!;

        await deletePersona(created.personaId!);
        expect(mockActivePersonaId).toBeNull();
      }));
  });

  // ===========================================================================
  // switchActivePersona
  // ===========================================================================

  describe("switchActivePersona", () => {
    it("throws when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        await expect(switchActivePersona(VALID_UUID)).rejects.toThrow("Unauthorized");
      }));

    it("clears active persona when null is passed", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await switchActivePersona(null);
        expect(result.success).toBe(true);
      }));

    it("returns error for invalid persona id format", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await switchActivePersona("not-a-uuid");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid persona ID");
      }));

    it("returns error when persona is not owned by user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await switchActivePersona(VALID_UUID);
        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
      }));

    it("switches to an owned persona", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Switch Target" });
        const result = await switchActivePersona(created.personaId!);

        expect(result.success).toBe(true);
        expect(mockActivePersonaId).toBe(created.personaId);
      }));
  });

  // ===========================================================================
  // getActivePersonaInfo
  // ===========================================================================

  describe("getActivePersonaInfo", () => {
    it("returns inactive when no persona is active", () =>
      withTestTransaction(async () => {
        mockActivePersonaId = null;

        const result = await getActivePersonaInfo();
        expect(result.active).toBe(false);
        expect(result.persona).toBeUndefined();
      }));

    it("returns inactive when active persona id does not exist in DB", () =>
      withTestTransaction(async () => {
        mockActivePersonaId = VALID_UUID;

        const result = await getActivePersonaInfo();
        expect(result.active).toBe(false);
      }));

    it("returns persona info when active persona exists", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const created = await createPersona({ name: "Active Persona" });
        mockActivePersonaId = created.personaId!;

        const result = await getActivePersonaInfo();
        expect(result.active).toBe(true);
        expect(result.persona).toBeDefined();
        expect(result.persona?.name).toBe("Active Persona");
      }));
  });
});
