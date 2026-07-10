/**
 * DB tests for group membership INVITATIONS (`@/app/actions/group-members`):
 * consent model — inviting never creates membership; only the invitee's
 * accept does. Covers authority gating, invite idempotency, accept (edge +
 * adminIds), decline, cancel, invitee-only response, and search exclusions.
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

// The unified session resolver — pointed at the acting user per step.
const currentUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/app/actions/interactions/helpers", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/interactions/helpers")>(
    "@/app/actions/interactions/helpers",
  );
  return { ...actual, getCurrentUserId: () => currentUserId() };
});

import {
  inviteGroupMemberAction,
  respondToGroupInviteAction,
  cancelGroupInviteAction,
  listGroupInvites,
  getMyPendingGroupInvite,
  searchAddableAgents,
} from "@/app/actions/group-members";

beforeEach(() => {
  currentUserId.mockReset();
});

async function scaffold(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
  const group = await createTestGroup(db, { name: "INV Test Group" });
  const admin = await createTestAgent(db, { name: "INV Admin", type: "person" });
  await createMembership(db, admin.id, group.id, "admin");
  const person = await createTestAgent(db, { name: "INV Newcomer", type: "person" });
  return { group, admin, person };
}

async function activeMembership(
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

describe("inviteGroupMemberAction", () => {
  it("rejects non-admin callers", () =>
    withTestTransaction(async (db) => {
      const { group, person } = await scaffold(db);
      const outsider = await createTestAgent(db, { name: "INV Outsider", type: "person" });
      currentUserId.mockResolvedValue(outsider.id);

      const result = await inviteGroupMemberAction(group.id, person.id, "member");
      expect(result.success).toBe(false);
    }));

  it("creates a PENDING invite — and NO membership", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const result = await inviteGroupMemberAction(group.id, person.id, "member");
      expect(result.success).toBe(true);

      // Consent model: inviting must never create the membership edge.
      expect(await activeMembership(db, person.id, group.id)).toBeNull();

      const invites = await listGroupInvites(group.id);
      expect(invites).toHaveLength(1);
      expect(invites[0].inviteeId).toBe(person.id);
      expect(invites[0].role).toBe("member");
    }));

  it("is idempotent — re-inviting refreshes the pending invite (role update)", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      await inviteGroupMemberAction(group.id, person.id, "member");
      await inviteGroupMemberAction(group.id, person.id, "admin");

      const invites = await listGroupInvites(group.id);
      expect(invites).toHaveLength(1);
      expect(invites[0].role).toBe("admin");
    }));

  it("rejects inviting an existing member and non-person targets", () =>
    withTestTransaction(async (db) => {
      const { group, admin } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const already = await inviteGroupMemberAction(group.id, admin.id, "member");
      expect(already.success).toBe(false);

      const otherGroup = await createTestGroup(db, { name: "INV Other Group" });
      const notPerson = await inviteGroupMemberAction(group.id, otherGroup.id, "member");
      expect(notPerson.success).toBe(false);
    }));
});

describe("respondToGroupInviteAction", () => {
  it("accept creates the membership with the invited role (+ adminIds for admin)", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      await inviteGroupMemberAction(group.id, person.id, "admin");
      const [invite] = await listGroupInvites(group.id);

      currentUserId.mockResolvedValue(person.id);
      const result = await respondToGroupInviteAction(invite.id, true);
      expect(result.success).toBe(true);

      const edge = await activeMembership(db, person.id, group.id);
      expect(edge?.role).toBe("admin");
      expect(Number(edge?.n)).toBe(1);

      const adminIds = (await db.execute(sql`
        SELECT COALESCE(metadata->'adminIds','[]'::jsonb) ? ${person.id} AS listed
        FROM agents WHERE id = ${group.id}::uuid
      `)) as Array<{ listed: boolean }>;
      expect(adminIds[0]?.listed).toBe(true);

      // Resolved — no longer pending anywhere.
      currentUserId.mockResolvedValue(admin.id);
      expect(await listGroupInvites(group.id)).toHaveLength(0);
    }));

  it("decline resolves the invite WITHOUT membership", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      await inviteGroupMemberAction(group.id, person.id, "member");
      const [invite] = await listGroupInvites(group.id);

      currentUserId.mockResolvedValue(person.id);
      const result = await respondToGroupInviteAction(invite.id, false);
      expect(result.success).toBe(true);
      expect(await activeMembership(db, person.id, group.id)).toBeNull();

      // A resolved invite cannot be responded to again.
      const again = await respondToGroupInviteAction(invite.id, true);
      expect(again.success).toBe(false);
    }));

  it("only the invitee may respond", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      await inviteGroupMemberAction(group.id, person.id, "member");
      const [invite] = await listGroupInvites(group.id);

      const impostor = await createTestAgent(db, { name: "INV Impostor", type: "person" });
      currentUserId.mockResolvedValue(impostor.id);
      const result = await respondToGroupInviteAction(invite.id, true);
      expect(result.success).toBe(false);
      expect(await activeMembership(db, person.id, group.id)).toBeNull();
    }));
});

describe("cancelGroupInviteAction + getMyPendingGroupInvite", () => {
  it("admin cancels a pending invite; invitee banner reflects state", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);
      await inviteGroupMemberAction(group.id, person.id, "member");
      const [invite] = await listGroupInvites(group.id);

      currentUserId.mockResolvedValue(person.id);
      const mine = await getMyPendingGroupInvite(group.id);
      expect(mine?.id).toBe(invite.id);
      expect(mine?.inviterName).toBe("INV Admin");

      currentUserId.mockResolvedValue(admin.id);
      const cancelled = await cancelGroupInviteAction(invite.id);
      expect(cancelled.success).toBe(true);
      expect(await listGroupInvites(group.id)).toHaveLength(0);

      currentUserId.mockResolvedValue(person.id);
      expect(await getMyPendingGroupInvite(group.id)).toBeNull();
      // Cancelled invites cannot be accepted.
      const late = await respondToGroupInviteAction(invite.id, true);
      expect(late.success).toBe(false);
    }));
});

describe("searchAddableAgents", () => {
  it("returns matches excluding existing members; empty for non-admins", () =>
    withTestTransaction(async (db) => {
      const { group, admin, person } = await scaffold(db);
      currentUserId.mockResolvedValue(admin.id);

      const found = await searchAddableAgents(group.id, "INV Newcomer");
      expect(found.some((a) => a.id === person.id)).toBe(true);
      const self = await searchAddableAgents(group.id, "INV Admin");
      expect(self.some((a) => a.id === admin.id)).toBe(false);

      currentUserId.mockResolvedValue(person.id);
      expect(await searchAddableAgents(group.id, "INV")).toEqual([]);
    }));
});
