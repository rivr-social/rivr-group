/**
 * DB tests for admin member management (`@/app/actions/group-members`):
 * authority gating, membership-edge creation, idempotent role updates,
 * adminIds maintenance, and the addable-people search exclusions.
 *
 * Run with `pnpm test:db`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createMembership } from "@/test/fixtures";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// revalidatePath requires a live Next request store — no-op it in tests.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/federation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/federation")>("@/lib/federation");
  return { ...actual, emitDomainEvent: vi.fn().mockResolvedValue({ id: "test-event" }) };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true }),
  RATE_LIMITS: { SOCIAL: { limit: 100, windowMs: 60_000 } },
}));

// federatedWrite consults live node/peer config (absent in the test DB) and
// its failure would poison the shared transaction — run the local closure
// directly, preserving the facade's result contract.
vi.mock("@/lib/federation/remote-write", () => ({
  federatedWrite: async (_params: unknown, local: () => Promise<unknown>) => ({
    success: true,
    data: await local(),
  }),
}));

// The unified session resolver — pointed at the acting admin per test.
const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

import { addGroupMemberAction, searchAddableAgents } from "@/app/actions/group-members";

beforeEach(() => {
  currentUserId.mockReset();
});

async function scaffold(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const group = await createTestGroup(db, { name: "AM Test Group" });
  const admin = await createTestAgent(db, { name: "AM Admin", type: "person" });
  await createMembership(db, admin.id, group.id, "admin");
  const person = await createTestAgent(db, { name: "AM Newcomer", type: "person" });
  return { group, admin, person };
}

async function activeEdge(
  db: { execute: (q: unknown) => Promise<unknown> },
  agentId: string,
  groupId: string,
) {
  const rows = (await db.execute(sql`
    SELECT role, COUNT(*) OVER () AS n FROM ledger
    WHERE subject_id = ${agentId}::uuid AND object_id = ${groupId}::uuid
      AND verb IN ('join','belong') AND is_active = true
    LIMIT 1
  `)) as Array<{ role: string; n: number }>;
  return rows[0] ?? null;
}

describe("addGroupMemberAction", () => {
  it("rejects non-admin callers", () =>
    withTestTransaction(async (db) => {
      const { group, person } = await scaffold(db);
      const outsider = await createTestAgent(db, { name: "AM Outsider", type: "person" });
      currentUserId.mockResolvedValue(outsider.id);

      const result = await addGroupMemberAction(group.id, person.id, "member");
      expect(result.success).toBe(false);
      expect(await activeEdge(db, person.id, group.id)).toBeNull();
    }));

  it("adds a member edge with the standard membership shape", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const result = await addGroupMemberAction(group.id, person.id, "member");
      expect(result.success).toBe(true);
      const edge = await activeEdge(db, person.id, group.id);
      expect(edge?.role).toBe("member");
      expect(Number(edge?.n)).toBe(1);
    }));

  it("is idempotent and role-updates in place (member → admin, incl. adminIds)", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      await addGroupMemberAction(group.id, person.id, "member");
      await addGroupMemberAction(group.id, person.id, "member"); // no dup
      const promoted = await addGroupMemberAction(group.id, person.id, "admin");
      expect(promoted.success).toBe(true);

      const edge = await activeEdge(db, person.id, group.id);
      expect(edge?.role).toBe("admin");
      expect(Number(edge?.n)).toBe(1);

      const adminIds = (await db.execute(sql`
        SELECT COALESCE(metadata->'adminIds','[]'::jsonb) ? ${person.id} AS listed
        FROM agents WHERE id = ${group.id}::uuid
      `)) as Array<{ listed: boolean }>;
      expect(adminIds[0]?.listed).toBe(true);
    }));

  it("rejects non-person targets", () =>
    withTestTransaction(async (db) => {
      const { group, admin } = await scaffold(db);
      const otherGroup = await createTestGroup(db, { name: "AM Other Group" });
      currentUserId.mockResolvedValue(admin.id);

      const result = await addGroupMemberAction(group.id, otherGroup.id, "member");
      expect(result.success).toBe(false);
    }));
});

describe("searchAddableAgents", () => {
  it("returns matches excluding existing members; empty for non-admins", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const found = await searchAddableAgents(group.id, "AM Newcomer");
      expect(found.some((a) => a.id === person.id)).toBe(true);
      // The admin is already a member — never offered.
      const self = await searchAddableAgents(group.id, "AM Admin");
      expect(self.some((a) => a.id === admin.id)).toBe(false);

      currentUserId.mockResolvedValue(person.id); // not an admin
      expect(await searchAddableAgents(group.id, "AM")).toEqual([]);
    }));
});
