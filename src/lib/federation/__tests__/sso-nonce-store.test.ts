/**
 * Unit tests for {@link burnSsoNonce} / {@link pruneExpiredSsoNonces}.
 *
 * The store relies on a unique index over (issuer, nonce) plus
 * INSERT ... ON CONFLICT DO NOTHING RETURNING for atomic single-use. We mock
 * `@/db` with an in-memory keyed set that mirrors that semantic exactly:
 * the first insert for a key returns a row, conflicting inserts return [].
 */

import { beforeEach, describe, expect, it } from "vitest";

import { burnSsoNonce, pruneExpiredSsoNonces } from "../sso-nonce-store";

// ---------------------------------------------------------------------------
// In-memory db mock mirroring the unique (issuer, nonce) constraint.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  issuer: string;
  nonce: string;
  actorId: string | null;
  expiresAt: Date;
}

const store = new Map<string, Row>();
let idSeq = 0;

function key(issuer: string, nonce: string): string {
  return `${issuer}\u0000${nonce}`;
}

import { vi } from "vitest";

vi.mock("@/db", () => {
  return {
    db: {
      insert: () => ({
        values: (v: Omit<Row, "id">) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const k = key(v.issuer, v.nonce);
              if (store.has(k)) return [];
              const row: Row = { id: `id-${idSeq++}`, ...v };
              store.set(k, row);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      delete: () => ({
        where: (cutoff: Date) => ({
          returning: async () => {
            const removed: { id: string }[] = [];
            for (const [k, row] of store) {
              if (row.expiresAt < cutoff) {
                removed.push({ id: row.id });
                store.delete(k);
              }
            }
            return removed;
          },
        }),
      }),
    },
  };
});

// The real `lt(column, value)` returns a SQL fragment; our delete mock ignores
// the column and reads the cutoff Date straight off the call. Stub `lt` so it
// passes the Date through unchanged.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, lt: (_col: unknown, value: Date) => value };
});

vi.mock("@/db/schema", () => ({
  ssoNonces: { issuer: "issuer", nonce: "nonce", id: "id", expiresAt: "expiresAt" },
}));

// ---------------------------------------------------------------------------

const ISSUER = "https://app.rivr.social";
const NONCE = "nonce-abc";
const FUTURE_EXP = Math.floor(Date.now() / 1000) + 120;

describe("burnSsoNonce", () => {
  beforeEach(() => {
    store.clear();
    idSeq = 0;
  });

  it("accepts the first presentation of a nonce", async () => {
    const result = await burnSsoNonce({
      issuer: ISSUER,
      nonce: NONCE,
      expUnixSec: FUTURE_EXP,
      actorId: "actor-1",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a replayed nonce for the same issuer", async () => {
    const first = await burnSsoNonce({ issuer: ISSUER, nonce: NONCE, expUnixSec: FUTURE_EXP });
    const second = await burnSsoNonce({ issuer: ISSUER, nonce: NONCE, expUnixSec: FUTURE_EXP });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "replayed" });
  });

  it("namespaces nonces by issuer — same nonce under a different issuer is independent", async () => {
    const a = await burnSsoNonce({ issuer: ISSUER, nonce: NONCE, expUnixSec: FUTURE_EXP });
    const b = await burnSsoNonce({
      issuer: "https://other-global.rivr.social",
      nonce: NONCE,
      expUnixSec: FUTURE_EXP,
    });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it("only the first of N concurrent burns of the same nonce wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        burnSsoNonce({ issuer: ISSUER, nonce: NONCE, expUnixSec: FUTURE_EXP }),
      ),
    );
    const wins = results.filter((r) => r.ok).length;
    expect(wins).toBe(1);
  });
});

describe("pruneExpiredSsoNonces", () => {
  beforeEach(() => {
    store.clear();
    idSeq = 0;
  });

  it("deletes only rows whose expiresAt is before now", async () => {
    const now = Date.now();
    await burnSsoNonce({ issuer: ISSUER, nonce: "expired", expUnixSec: Math.floor(now / 1000) - 600 });
    await burnSsoNonce({ issuer: ISSUER, nonce: "live", expUnixSec: Math.floor(now / 1000) + 600 });

    const deleted = await pruneExpiredSsoNonces(now);
    expect(deleted).toBe(1);

    // The live nonce is still burned (cannot be reused).
    const replay = await burnSsoNonce({ issuer: ISSUER, nonce: "live", expUnixSec: Math.floor(now / 1000) + 600 });
    expect(replay).toEqual({ ok: false, reason: "replayed" });
  });
});
