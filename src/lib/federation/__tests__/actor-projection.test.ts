import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for ensureLocalActorAgent() — the verified-principal projection
 * that guarantees a local `agents` row exists for a cross-instance actor before
 * a ledger write keyed on `subject_id` (FK → agents.id).
 *
 * Regression guarded: a federated SSO visitor (home on another instance) liking
 * or commenting on this sovereign used to violate `ledger_subject_id_agents_id_fk`
 * because their session id has no local agent row. We now materialize a private
 * mirror. Unlike global, the sovereign has no projection-sync backfill — the
 * name is upgraded in place by the next agent upsert the home peer federates.
 *
 * All DB / session / home-resolution calls are mocked.
 */

const mockAgentFindFirst = vi.fn();
const mockNodeRows = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflict = vi.fn();
const mockGetSession = vi.fn();
const mockResolveHomeInstance = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: (...args: unknown[]) => mockAgentFindFirst(...args),
      },
    },
    // resolveHomeByBaseUrl: db.select().from().where().limit()
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...args: unknown[]) => mockNodeRows(...args),
        }),
      }),
    }),
    // db.insert().values().onConflictDoNothing()
    insert: () => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return { onConflictDoNothing: (...a: unknown[]) => mockOnConflict(...a) };
      },
    }),
  },
}));

vi.mock("@/db/schema", () => ({ agents: { id: "id", baseUrl: "base_url" }, nodes: { baseUrl: "base_url" } }));
vi.mock("@/lib/auth/get-session", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock("../resolution", () => ({ resolveHomeInstance: (...a: unknown[]) => mockResolveHomeInstance(...a) }));

import { ensureLocalActorAgent } from "../actor-projection";

const ACTOR_ID = "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667";
const CAMALOT_NODE_ID = "22222222-2222-2222-2222-222222222222";

const camalotNode = {
  id: CAMALOT_NODE_ID,
  slug: "camalot",
  baseUrl: "https://rivr.camalot.me",
  instanceType: "person",
  migrationStatus: "active",
};

function federatedSession() {
  return {
    user: {
      id: ACTOR_ID,
      email: null,
      name: "Cameron Ely-Murdock",
      image: null,
      homeBaseUrl: "https://rivr.camalot.me",
      authMethod: "federated" as const,
      isOwner: false,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("ensureLocalActorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnConflict.mockResolvedValue(undefined);
  });

  it("is a no-op when a local agent row already exists", async () => {
    mockAgentFindFirst.mockResolvedValue({ id: ACTOR_ID });

    await ensureLocalActorAgent(ACTOR_ID);

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("does nothing for an empty actor id", async () => {
    await ensureLocalActorAgent("");
    expect(mockAgentFindFirst).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("projects a private mirror for a federated visitor whose home is a registered node", async () => {
    mockAgentFindFirst.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(federatedSession());
    mockNodeRows.mockResolvedValue([camalotNode]); // resolveHomeByBaseUrl hit

    await ensureLocalActorAgent(ACTOR_ID);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const row = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(row.id).toBe(ACTOR_ID);
    expect(row.name).toBe("Cameron Ely-Murdock");
    expect(row.type).toBe("person");
    expect(row.visibility).toBe("private");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.federatedPlaceholder).toBe(true);
    expect(meta.isProjection).toBe(true);
    expect(meta.externalEntityId).toBe(ACTOR_ID);
    expect(meta.homeInstanceUrl).toBe("https://rivr.camalot.me");
    expect(meta.sourceNodeId).toBe(CAMALOT_NODE_ID);
    expect(meta.sourceNodeSlug).toBe("camalot");
    expect(mockOnConflict).toHaveBeenCalled();
  });

  it("trusts the signed home claim when no local node is registered for it (typical sovereign case)", async () => {
    mockAgentFindFirst.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(federatedSession());
    mockNodeRows.mockResolvedValue([]); // no node registered locally for the home URL
    mockResolveHomeInstance.mockResolvedValue({
      nodeId: "global-node",
      instanceType: "global",
      slug: "global",
      baseUrl: "https://app.rivr.social",
      isLocal: false,
      migrationStatus: "active",
    });

    await ensureLocalActorAgent(ACTOR_ID);

    // Still projects: the verified homeBaseUrl claim is authoritative even when
    // the home is reached through the global hub rather than a local node row.
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const row = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.homeInstanceUrl).toBe("https://rivr.camalot.me");
  });

  it("refuses to fabricate an agent for a stale/local account with no remote home", async () => {
    mockAgentFindFirst.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(null); // no session hint
    mockNodeRows.mockResolvedValue([]);
    mockResolveHomeInstance.mockResolvedValue({
      nodeId: "local-node",
      instanceType: "person",
      slug: "self",
      baseUrl: "https://rivr.self.example",
      isLocal: true, // home resolves to THIS instance → not a federated visitor
      migrationStatus: "active",
    });

    await ensureLocalActorAgent(ACTOR_ID);

    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
