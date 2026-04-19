import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the federation authority guard (rivr-group #1).
 *
 * Verifies that the guard:
 * - Allows sessions when no authority events exist.
 * - Rejects sessions asserted from a revoked home after a consumed
 *   `authority.revoke` event.
 * - Returns the superseding home URL when a `successor.authority.claim` has
 *   been received and the asserted home is the old home.
 * - Bypasses the TTL cache when invoked with `{ sensitive: true }`.
 *
 * The guard module uses `@/` path aliases that are not resolved by the
 * repo's vitest runner, so we import through a relative path.
 */

// ---------------------------------------------------------------------------
// Mocks — we mock the two schema dependencies of the guard with relative paths
// so we don't depend on any `@/` alias resolution.
// ---------------------------------------------------------------------------

type Row = {
  agentId: string;
  eventType: string;
  homeBaseUrl: string;
  successorHomeBaseUrl: string | null;
  receivedAt: Date;
  authorityStatus: string;
};

const cacheRows: Row[] = [];

let nextCallSequence: Array<[string, string]> = [];
let nextCallIndex = 0;

const findFirstMock = vi.fn(async () => {
  const seq = nextCallSequence[nextCallIndex++] ?? nextCallSequence[nextCallSequence.length - 1];
  if (!seq) return null;
  const [agentId, eventType] = seq;
  const candidates = cacheRows
    .filter((r) => r.agentId === agentId && r.eventType === eventType)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return candidates[0] ?? null;
});

vi.mock("@/db", () => ({
  db: {
    query: {
      authorityEventCache: {
        findFirst: findFirstMock,
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  AUTHORITY_EVENT_TYPES: {
    CREDENTIAL_UPDATED: "credential.updated",
    AUTHORITY_REVOKE: "authority.revoke",
    SUCCESSOR_AUTHORITY_CLAIM: "successor.authority.claim",
    CREDENTIAL_TEMPWRITE_FROM_GLOBAL: "credential.tempwrite.from-global",
  },
  AUTHORITY_STATUS: {
    ACTIVE: "active",
    REVOKED: "revoked",
    SUPERSEDED: "superseded",
  },
  authorityEventCache: {
    agentId: "agent_id",
    eventType: "event_type",
    receivedAt: "received_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => ({ __and: true }),
  desc: (..._args: unknown[]) => ({ __desc: true }),
  eq: (..._args: unknown[]) => ({ __eq: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadGuard() {
  const mod = await import("@/lib/federation/authority-guard");
  mod.clearAuthorityGuardCache();
  return mod;
}

async function callCheck(
  check: (
    agentId: string,
    homeBaseUrl: string,
    options?: { sensitive?: boolean },
  ) => Promise<{ allowed: boolean; reason?: string; newHomeBaseUrl?: string }>,
  agentId: string,
  homeBaseUrl: string,
  options?: { sensitive?: boolean },
) {
  // Guard calls findLatest twice in this order:
  //   1. AUTHORITY_REVOKE
  //   2. SUCCESSOR_AUTHORITY_CLAIM
  nextCallSequence = [
    [agentId, "authority.revoke"],
    [agentId, "successor.authority.claim"],
  ];
  nextCallIndex = 0;
  return check(agentId, homeBaseUrl, options);
}

beforeEach(() => {
  cacheRows.length = 0;
  findFirstMock.mockClear();
  nextCallIndex = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authority-guard / checkAuthorityForSession", () => {
  it("allows session when no authority events exist for agent", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: true },
    );

    expect(result).toEqual({ allowed: true });
  });

  it("rejects session after an authority.revoke event is received", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "authority.revoke",
      homeBaseUrl: "https://home.example",
      successorHomeBaseUrl: null,
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "revoked",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: true },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("returns superseded with newHomeBaseUrl when a newer successor claim names a different home", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "authority.revoke",
      homeBaseUrl: "https://old-home.example",
      successorHomeBaseUrl: null,
      receivedAt: new Date(Date.now() - 5000),
      authorityStatus: "revoked",
    });
    cacheRows.push({
      agentId: "agent-123",
      eventType: "successor.authority.claim",
      homeBaseUrl: "https://old-home.example",
      successorHomeBaseUrl: "https://new-home.example",
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "superseded",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://old-home.example",
      { sensitive: true },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("superseded-by-successor");
    expect(result.newHomeBaseUrl).toBe("https://new-home.example");
  });

  it("does not block the new home when only a successor claim exists", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "successor.authority.claim",
      homeBaseUrl: "https://old-home.example",
      successorHomeBaseUrl: "https://new-home.example",
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "superseded",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://new-home.example",
      { sensitive: true },
    );

    expect(result.allowed).toBe(true);
  });

  it("sensitive=true bypasses TTL cache so a freshly imported revoke takes effect immediately", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    // First call: no revoke event yet -> allowed and cached.
    let result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: false },
    );
    expect(result.allowed).toBe(true);

    // A revoke arrives after the non-sensitive read.
    cacheRows.push({
      agentId: "agent-123",
      eventType: "authority.revoke",
      homeBaseUrl: "https://home.example",
      successorHomeBaseUrl: null,
      receivedAt: new Date(),
      authorityStatus: "revoked",
    });

    // Non-sensitive read within TTL still sees cached allow (by design).
    result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: false },
    );
    expect(result.allowed).toBe(true);

    // Sensitive read must skip cache and surface the revoke.
    result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: true },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("rejects with revoked reason on empty inputs (defensive)", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    const result = await callCheck(checkAuthorityForSession, "", "https://home.example");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("ignores revoke rows that target a different home than the asserted one", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "authority.revoke",
      homeBaseUrl: "https://other-home.example",
      successorHomeBaseUrl: null,
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "revoked",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: true },
    );

    expect(result).toEqual({ allowed: true });
  });

  it("normalizes trailing slashes when comparing homeBaseUrl", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "authority.revoke",
      homeBaseUrl: "https://home.example",
      successorHomeBaseUrl: null,
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "revoked",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example///",
      { sensitive: true },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("returns allowed when the superseded claim targets an unrelated old home", async () => {
    const { checkAuthorityForSession } = await loadGuard();

    cacheRows.push({
      agentId: "agent-123",
      eventType: "successor.authority.claim",
      homeBaseUrl: "https://some-other-home.example",
      successorHomeBaseUrl: "https://new-home.example",
      receivedAt: new Date(Date.now() - 1000),
      authorityStatus: "superseded",
    });

    const result = await callCheck(
      checkAuthorityForSession,
      "agent-123",
      "https://home.example",
      { sensitive: true },
    );

    expect(result).toEqual({ allowed: true });
  });
});

describe("authority-guard / persistAuthorityEvent", () => {
  it("maps authority.revoke to revoked status", async () => {
    const { persistAuthorityEvent } = await loadGuard();
    const result = await persistAuthorityEvent({
      agentId: "agent-revoked",
      eventType: "authority.revoke",
      homeBaseUrl: "https://home.example/",
      signedBy: "global",
      signedPayload: { agentId: "agent-revoked" },
    });
    expect(result.authorityStatus).toBe("revoked");
  });

  it("maps successor.authority.claim to superseded status", async () => {
    const { persistAuthorityEvent } = await loadGuard();
    const result = await persistAuthorityEvent({
      agentId: "agent-superseded",
      eventType: "successor.authority.claim",
      homeBaseUrl: "https://old.example",
      successorHomeBaseUrl: "https://new.example",
      signedBy: "global",
      signedPayload: {},
    });
    expect(result.authorityStatus).toBe("superseded");
  });

  it("maps credential.updated to active status", async () => {
    const { persistAuthorityEvent } = await loadGuard();
    const result = await persistAuthorityEvent({
      agentId: "agent-active",
      eventType: "credential.updated",
      homeBaseUrl: "https://home.example",
      credentialVersion: 7,
      signedBy: "global",
      signedPayload: {},
    });
    expect(result.authorityStatus).toBe("active");
  });
});

describe("authority-guard / isRecognizedAuthorityEventType", () => {
  it("recognizes all four known event types and rejects unknown ones", async () => {
    const { isRecognizedAuthorityEventType } = await loadGuard();
    expect(isRecognizedAuthorityEventType("authority.revoke")).toBe(true);
    expect(isRecognizedAuthorityEventType("successor.authority.claim")).toBe(true);
    expect(isRecognizedAuthorityEventType("credential.updated")).toBe(true);
    expect(isRecognizedAuthorityEventType("credential.tempwrite.from-global")).toBe(true);
    expect(isRecognizedAuthorityEventType("some.other.event")).toBe(false);
    expect(isRecognizedAuthorityEventType("")).toBe(false);
  });
});
