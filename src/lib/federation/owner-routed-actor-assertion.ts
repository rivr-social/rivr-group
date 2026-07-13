// src/lib/federation/owner-routed-actor-assertion.ts

import { randomBytes } from "node:crypto";

import {
  canonicalize,
  signPayload,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";

/**
 * Home-signed actor assertion for OWNER-ROUTED federation writes (buyer rail,
 * open-issues P0 2026-07-07).
 *
 * When a user takes a write action on a resource whose home is a foreign
 * instance (e.g. a dev/global user booking a bob-homed listing), the write is
 * forwarded to the resource's home via `POST /api/federation/mutations`. The
 * receiver authenticates the sending peer (peer-secret) but, post-F1, refuses
 * to act for an arbitrary body `actorId` unless a `federation_entity_map` row
 * already binds that peer→actor. A first-time cross-instance buyer has no such
 * row, so the write is (correctly) rejected.
 *
 * This module carries the missing piece: a short-lived, single-use,
 * audience-bound Ed25519 assertion, SIGNED BY THE ACTOR'S HOME INSTANCE node
 * key, that vouches for the actor's identity. The receiver verifies it against
 * that peer's REGISTERED public key (`nodes.publicKey` — the same key the
 * signed-event and F4 `mutationSignature` rails use), then materializes the
 * actor via the existing projection rail and binds `federation_entity_map`
 * before proceeding. Nothing here grants AUTHORITY — only identity; every
 * downstream authority check still runs against the receiver's own graph.
 *
 * Divergence from {@link import("./sso-assertion").verifySsoAssertion}: the SSO
 * assertion is issuer-bound to `GLOBAL_IDENTITY_AUTHORITY_URL`. This assertion
 * is bound to the AUTHENTICATED TRANSPORT PEER (`homeNodeId === peerNodeId`),
 * which generalizes to sovereign↔sovereign forwarding where the signer is not
 * the global hub.
 *
 * Reuses `@/lib/federation-crypto` for canonicalization + Ed25519 so no new
 * crypto primitive is introduced. The signed surface is the undefined-stripped
 * claim set (JCS-canonical), identical signer/verifier bytes.
 */

/** Upper bound on assertion lifetime, in seconds. */
export const OWNER_ROUTED_ASSERTION_MAX_LIFETIME_SEC = 5 * 60;

/** Default lifetime — callers may override but never beyond the max. */
export const OWNER_ROUTED_ASSERTION_DEFAULT_LIFETIME_SEC = 2 * 60;

/** Nonce length in bytes — 16 bytes → 128 bits of entropy. */
export const OWNER_ROUTED_ASSERTION_NONCE_BYTES = 16;

/** Default clock-skew tolerance, in seconds. */
export const OWNER_ROUTED_ASSERTION_DEFAULT_SKEW_SEC = 60;

/**
 * Claim set covered by the signature. Every value returned on the wire (except
 * `kid` and `signature`) is inside this surface so nothing material can be
 * rewritten without invalidating the signature.
 */
export interface OwnerRoutedActorAssertionClaims {
  /** Actor's id on the HOME (sending) instance. Must equal the body `actorId`. */
  actorId: string;
  /** Sending node's id. Must equal the receiver's authenticated `peerNodeId`. */
  homeNodeId: string;
  /** Sending instance base URL. */
  homeBaseUrl: string;
  /** Audience binding — the receiving instance this assertion is for. */
  audienceBaseUrl: string;
  /** Display name resolved at mint time. Optional. */
  name?: string;
  /** Email resolved at mint time. Optional. */
  email?: string;
  /** Handle resolved at mint time. Optional. */
  handle?: string;
  /** Avatar URL resolved at mint time. Optional. */
  avatarUrl?: string;
  /** Owning account id when `actorId` is a persona; null/absent otherwise. */
  parentAgentId?: string | null;
  /** Issued-at, UNIX seconds UTC. */
  iat: number;
  /** Expiry, UNIX seconds UTC. Receiver rejects if now > exp. */
  exp: number;
  /** Base64url nonce — single-use dedup key for the receiver. */
  nonce: string;
}

/** Fully signed assertion envelope attached to the forwarded mutation body. */
export interface SignedOwnerRoutedActorAssertion
  extends OwnerRoutedActorAssertionClaims {
  /** Key identifier: `<base_url>#<slug>` of the signing (home) node. */
  kid: string;
  /** Base64 Ed25519 signature over the canonicalized claim set. */
  signature: string;
}

/** Thrown when required input to {@link signOwnerRoutedActorAssertion} is missing. */
export class OwnerRoutedActorAssertionSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerRoutedActorAssertionSigningError";
  }
}

/** Narrow input to {@link signOwnerRoutedActorAssertion}; iat/exp/nonce are computed. */
export interface SignOwnerRoutedActorAssertionInput {
  actorId: string;
  homeNodeId: string;
  homeBaseUrl: string;
  audienceBaseUrl: string;
  name?: string;
  email?: string;
  handle?: string;
  avatarUrl?: string;
  parentAgentId?: string | null;
  /** Optional lifetime override — clamped to ≤ max. */
  lifetimeSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
  /** Optional fixed nonce override for tests. */
  nonce?: string;
}

/**
 * Sign an owner-routed actor assertion with the home node's Ed25519 private key.
 *
 * @param input Claim fields plus test-overridable clock/nonce.
 * @param privateKeyPem PEM-encoded Ed25519 private key of the home node.
 * @param kid Key identifier `<base_url>#<slug>` for the home node.
 * @returns A signed assertion envelope ready to attach to the mutation body.
 * @throws {OwnerRoutedActorAssertionSigningError} When required input is missing.
 */
export function signOwnerRoutedActorAssertion(
  input: SignOwnerRoutedActorAssertionInput,
  privateKeyPem: string,
  kid: string,
): SignedOwnerRoutedActorAssertion {
  validateSignInput(input, privateKeyPem, kid);

  const lifetimeSec = clampLifetime(input.lifetimeSec);
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + lifetimeSec;
  const nonce = input.nonce ?? generateNonce();

  const claims: OwnerRoutedActorAssertionClaims = {
    actorId: input.actorId,
    homeNodeId: input.homeNodeId,
    homeBaseUrl: input.homeBaseUrl,
    audienceBaseUrl: input.audienceBaseUrl,
    ...(input.name ? { name: input.name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.handle ? { handle: input.handle } : {}),
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    iat,
    exp,
    nonce,
  };

  const signature = signPayload(
    stripUndefined(claims) as unknown as Record<string, unknown>,
    privateKeyPem,
  );

  return { ...claims, kid, signature };
}

/**
 * Produce the canonical JSON string that gets signed/verified. Exposed for
 * byte-for-byte equivalence tests.
 */
export function canonicalizeOwnerRoutedActorAssertion(
  claims: OwnerRoutedActorAssertionClaims,
): string {
  return canonicalize(stripUndefined(claims));
}

/** Reason an assertion failed verification. Stable strings for structured logs. */
export type OwnerRoutedActorAssertionVerifyFailure =
  | "malformed"
  | "audience-mismatch"
  | "home-node-mismatch"
  | "expired"
  | "not-yet-valid"
  | "no-peer-key"
  | "signature-invalid";

/** Outcome envelope for {@link verifyOwnerRoutedActorAssertion}. */
export type OwnerRoutedActorAssertionVerifyResult =
  | { ok: true; claims: OwnerRoutedActorAssertionClaims }
  | { ok: false; reason: OwnerRoutedActorAssertionVerifyFailure };

/** Input to {@link verifyOwnerRoutedActorAssertion}. */
export interface VerifyOwnerRoutedActorAssertionInput {
  /** Full signed assertion as received on the wire. */
  assertion: unknown;
  /** Local base URL this receiver advertises — must match `audienceBaseUrl`. */
  expectedAudienceBaseUrl: string;
  /** The authenticated sending peer's node id — must match `homeNodeId`. */
  expectedHomeNodeId: string;
  /** PEM-encoded Ed25519 public key of the authenticated sending peer. */
  peerPublicKey: string | null | undefined;
  /** Max clock skew (seconds). Default 60. */
  maxClockSkewSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
}

/**
 * Verify an owner-routed actor assertion against the receiver's expectations
 * and the authenticated peer's registered public key.
 *
 * Checks layered cheapest-first: parse → audience → home-node → expiry →
 * signature. Never throws; every failure is a stable reason string.
 */
export function verifyOwnerRoutedActorAssertion(
  input: VerifyOwnerRoutedActorAssertionInput,
): OwnerRoutedActorAssertionVerifyResult {
  const parsed = parseSignedAssertion(input.assertion);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }
  const { claims, signature } = parsed;

  // Audience binding — cheapest meaningful check.
  const expectedAudience = normalizeOrigin(input.expectedAudienceBaseUrl);
  const assertionAudience = normalizeOrigin(claims.audienceBaseUrl);
  if (!expectedAudience || expectedAudience !== assertionAudience) {
    return { ok: false, reason: "audience-mismatch" };
  }

  // Home-node binding — an authenticated peer can only assert ITS OWN node as
  // the home. This is what anchors trust to the peer registry rather than to a
  // caller-named issuer.
  if (!input.expectedHomeNodeId || claims.homeNodeId !== input.expectedHomeNodeId) {
    return { ok: false, reason: "home-node-mismatch" };
  }

  // Expiry / not-yet-valid with skew.
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const skew = clampSkew(input.maxClockSkewSec);
  if (claims.exp + skew <= nowSec) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iat - skew > nowSec) {
    return { ok: false, reason: "not-yet-valid" };
  }

  // Peer key must be present before we attempt verification.
  if (!input.peerPublicKey) {
    return { ok: false, reason: "no-peer-key" };
  }

  const ok = verifyPayloadSignature(
    stripUndefined(claims) as unknown as Record<string, unknown>,
    signature,
    input.peerPublicKey,
  );
  if (!ok) {
    return { ok: false, reason: "signature-invalid" };
  }

  return { ok: true, claims };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function validateSignInput(
  input: SignOwnerRoutedActorAssertionInput,
  privateKeyPem: string,
  kid: string,
): void {
  if (!input.actorId) throw new OwnerRoutedActorAssertionSigningError("actorId is required");
  if (!input.homeNodeId) throw new OwnerRoutedActorAssertionSigningError("homeNodeId is required");
  if (!input.homeBaseUrl) throw new OwnerRoutedActorAssertionSigningError("homeBaseUrl is required");
  if (!input.audienceBaseUrl) {
    throw new OwnerRoutedActorAssertionSigningError("audienceBaseUrl is required");
  }
  if (!privateKeyPem) throw new OwnerRoutedActorAssertionSigningError("privateKeyPem is required");
  if (!kid) throw new OwnerRoutedActorAssertionSigningError("kid is required");
  for (const [field, value] of [
    ["homeBaseUrl", input.homeBaseUrl],
    ["audienceBaseUrl", input.audienceBaseUrl],
  ] as const) {
    try {
      // eslint-disable-next-line no-new
      new URL(value);
    } catch {
      throw new OwnerRoutedActorAssertionSigningError(
        `${field} must be a valid URL; got "${value}"`,
      );
    }
  }
}

function parseSignedAssertion(
  raw: unknown,
): { claims: OwnerRoutedActorAssertionClaims; signature: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (
    typeof o.actorId !== "string" ||
    typeof o.homeNodeId !== "string" ||
    typeof o.homeBaseUrl !== "string" ||
    typeof o.audienceBaseUrl !== "string" ||
    typeof o.iat !== "number" ||
    typeof o.exp !== "number" ||
    typeof o.nonce !== "string" ||
    typeof o.kid !== "string" ||
    typeof o.signature !== "string"
  ) {
    return null;
  }
  if (o.name !== undefined && typeof o.name !== "string") return null;
  if (o.email !== undefined && typeof o.email !== "string") return null;
  if (o.handle !== undefined && typeof o.handle !== "string") return null;
  if (o.avatarUrl !== undefined && typeof o.avatarUrl !== "string") return null;
  if (
    o.parentAgentId !== undefined &&
    o.parentAgentId !== null &&
    typeof o.parentAgentId !== "string"
  ) {
    return null;
  }

  const claims: OwnerRoutedActorAssertionClaims = {
    actorId: o.actorId,
    homeNodeId: o.homeNodeId,
    homeBaseUrl: o.homeBaseUrl,
    audienceBaseUrl: o.audienceBaseUrl,
    ...(typeof o.name === "string" ? { name: o.name } : {}),
    ...(typeof o.email === "string" ? { email: o.email } : {}),
    ...(typeof o.handle === "string" ? { handle: o.handle } : {}),
    ...(typeof o.avatarUrl === "string" ? { avatarUrl: o.avatarUrl } : {}),
    ...(typeof o.parentAgentId === "string" ? { parentAgentId: o.parentAgentId } : {}),
    iat: o.iat,
    exp: o.exp,
    nonce: o.nonce,
  };
  return { claims, signature: o.signature };
}

function normalizeOrigin(input: string | undefined | null): string | null {
  if (!input) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function clampLifetime(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return OWNER_ROUTED_ASSERTION_DEFAULT_LIFETIME_SEC;
  }
  return Math.min(Math.floor(requested), OWNER_ROUTED_ASSERTION_MAX_LIFETIME_SEC);
}

function clampSkew(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
    return OWNER_ROUTED_ASSERTION_DEFAULT_SKEW_SEC;
  }
  return Math.min(Math.floor(requested), 300);
}

function generateNonce(): string {
  return randomBytes(OWNER_ROUTED_ASSERTION_NONCE_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
