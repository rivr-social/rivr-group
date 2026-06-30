// src/lib/federation/sso-nonce-store.ts

import { lt } from "drizzle-orm";

import { db } from "@/db";
import { ssoNonces } from "@/db/schema";

/**
 * Single-use enforcement for SSO assertion nonces (F3 — SSO replay
 * protection).
 *
 * A signed SSO assertion already carries a `nonce` and an `exp` (see
 * `sso-assertion.ts`); the verifier proves the assertion is authentic and
 * in-window, but authenticity alone does not stop the SAME assertion from
 * being presented twice inside its ≤5-minute validity window (a captured
 * `/sso/land` URL, a replayed POST body). This store makes the nonce
 * single-use: the SSO accept paths call {@link burnSsoNonce} BEFORE minting
 * the `rivr_remote_viewer` cookie, and the first presentation wins.
 *
 * Atomicity: a single `INSERT ... ON CONFLICT (issuer, nonce) DO NOTHING`
 * with `RETURNING` is the burn. Postgres serializes concurrent inserts on
 * the unique index, so exactly one of two racing requests gets a returned
 * row; the loser gets an empty result and is rejected. No read-then-write
 * TOCTOU window exists.
 *
 * Keyed by `(issuer, nonce)` so two distinct issuers can never shadow each
 * other's nonces.
 */

/** Outcome of an atomic nonce burn. */
export type BurnSsoNonceResult =
  /** The nonce was unused; it is now burned and the caller may proceed. */
  | { ok: true }
  /** The nonce was already burned (replay) — caller must reject. */
  | { ok: false; reason: "replayed" };

/** Input to {@link burnSsoNonce}. */
export interface BurnSsoNonceInput {
  /** The signed `globalIssuerBaseUrl` claim — namespaces the nonce. */
  issuer: string;
  /** The signed `nonce` claim from the assertion. */
  nonce: string;
  /** The signed `exp` claim (UNIX seconds UTC) — used as the TTL. */
  expUnixSec: number;
  /** Optional actor id, stored for audit only; never used for trust. */
  actorId?: string | null;
}

/**
 * Atomically burn an SSO assertion nonce. Returns `{ ok: true }` exactly
 * once per `(issuer, nonce)`; every subsequent presentation returns
 * `{ ok: false, reason: "replayed" }`.
 *
 * The caller MUST treat a non-`ok` result as a hard authentication failure
 * (do not mint a session). Must be invoked only after the assertion has
 * already passed {@link import("./sso-assertion").verifySsoAssertion} so an
 * attacker cannot pollute the table with arbitrary `(issuer, nonce)` pairs.
 *
 * @param input Verified issuer/nonce/exp from the assertion claims.
 * @returns `{ ok: true }` on first use; `{ ok: false }` on replay.
 */
export async function burnSsoNonce(
  input: BurnSsoNonceInput,
): Promise<BurnSsoNonceResult> {
  const expiresAt = new Date(input.expUnixSec * 1000);

  const inserted = await db
    .insert(ssoNonces)
    .values({
      issuer: input.issuer,
      nonce: input.nonce,
      actorId: input.actorId ?? null,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [ssoNonces.issuer, ssoNonces.nonce],
    })
    .returning({ id: ssoNonces.id });

  if (inserted.length === 0) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true };
}

/**
 * Delete expired nonce rows. Correctness does not depend on this running —
 * the unique constraint enforces single-use for the whole validity window
 * regardless of pruning — but a periodic sweep keeps the table bounded.
 *
 * @param now Optional fixed clock (ms since epoch) for tests.
 * @returns The number of rows deleted.
 */
export async function pruneExpiredSsoNonces(now?: number): Promise<number> {
  const cutoff = new Date(typeof now === "number" ? now : Date.now());
  const deleted = await db
    .delete(ssoNonces)
    .where(lt(ssoNonces.expiresAt, cutoff))
    .returning({ id: ssoNonces.id });
  return deleted.length;
}
