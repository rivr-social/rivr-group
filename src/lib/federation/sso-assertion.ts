// src/lib/federation/sso-assertion.ts

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { nodes } from "@/db/schema";
import {
  canonicalize,
  signPayload,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";
import { getInstanceConfig } from "./instance-config";

/**
 * Short-lived, single-use SSO assertion signing for federation-auth ticket
 * #83 (GitHub issue rivr-social/rivr-app#83).
 *
 * Purpose:
 * - Build the canonical claim set that `/api/federation/sso/issue` returns
 *   to a remote target after global successfully authenticates an agent.
 * - Sign it with this instance's Ed25519 private key (the same key used by
 *   `authority-events.ts` and the rest of the federation stack) so the
 *   target only needs a single primitive to verify.
 *
 * Why a dedicated module:
 * - Authority events cover cross-instance mutation statements; SSO
 *   assertions cover transient proof-of-authentication. Both are signed
 *   with the same key, but their envelopes are different (assertion adds
 *   `exp`, `nonce`, `kid`, audience binding) and their verifier lives in a
 *   different code path (target-side ticket #3, not this ticket).
 * - Isolating assertion signing here keeps authority-events.ts narrow and
 *   keeps the route handler in #83 small (it orchestrates lookup + verify
 *   + sign; it does not know Ed25519 details).
 *
 * Key exports:
 * - {@link SSO_ASSERTION_MAX_LIFETIME_SEC}
 * - {@link SsoAssertionClaims}
 * - {@link SignedSsoAssertion}
 * - {@link SsoAssertionSigningError}
 * - {@link signSsoAssertion}
 * - {@link canonicalizeSsoAssertion}
 *
 * Security properties (user-confirmed in HANDOFF):
 * - Expiry ≤5 min so stolen assertions rot quickly.
 * - Audience-bound (`targetBaseUrl`) so the same assertion cannot be
 *   replayed against another peer.
 * - Single-use enforcement is the target's responsibility (it stores the
 *   `nonce` until expiry and rejects re-presentation); global emits the
 *   nonce here so the target has a stable dedupe key.
 * - `agentId` + `homeBaseUrl` + `globalIssuerBaseUrl` + `targetBaseUrl` +
 *   `nonce` are all inside the signed surface so nothing material about
 *   the assertion can be rewritten by a MITM without invalidating the
 *   signature.
 */

/** Upper bound on assertion lifetime, in seconds. User-confirmed ≤5 min. */
export const SSO_ASSERTION_MAX_LIFETIME_SEC = 5 * 60;

/** Default lifetime — callers may override but never beyond the max. */
export const SSO_ASSERTION_DEFAULT_LIFETIME_SEC = 2 * 60;

/** Nonce length in bytes — 16 bytes of randomness → 128 bits of entropy. */
export const SSO_ASSERTION_NONCE_BYTES = 16;

/**
 * Claim set covered by the signature.
 *
 * Every value returned to the client (except `signature`, `kid`, and the
 * envelope header `signedBy` when/if it is ever added) is inside this
 * surface so the target cannot accept a tampered version.
 */
export interface SsoAssertionClaims {
  /** Authenticated agent's UUID. */
  actorId: string;
  /** Echo of the email supplied at issue, lowercased. Present iff used. */
  email?: string;
  /** Echo of the handle supplied at issue, lowercased. Present iff used. */
  handle?: string;
  /** Canonical home authority base URL resolved from identity_authority. */
  homeBaseUrl: string;
  /** Base URL of the global issuer that signed this assertion. */
  globalIssuerBaseUrl: string;
  /** Audience binding — the target instance this assertion is for. */
  targetBaseUrl: string;
  /** Monotonic credential version recorded on identity_authority. */
  credentialVersion: number;
  /** Home authority version (for detecting stale/home-changed state). */
  homeAuthorityVersion: number;
  /** Which class the home authority is (hosted-federated | sovereign). */
  instanceClass: "hosted-federated" | "sovereign";
  /**
   * Parent agent id when `actorId` is a persona, null otherwise.
   * User-confirmed: personas are first-class agents carrying their own
   * actorId, but the target needs to know the owning real account.
   */
  parentAgentId: string | null;
  /** Issued-at time, UNIX seconds UTC. */
  iat: number;
  /** Expiry, UNIX seconds UTC. Target rejects if now > exp. */
  exp: number;
  /** Base64url nonce — single-use dedup key for the target. */
  nonce: string;
}

/**
 * Fully signed assertion envelope returned by `/api/federation/sso/issue`.
 *
 * `kid` identifies which signing key to verify against. It follows the
 * same `<base_url>#<slug>` convention as `authority_event_log.signed_by`
 * so target-side code can share the peer-lookup path.
 */
export interface SignedSsoAssertion extends SsoAssertionClaims {
  /** Key identifier: `<base_url>#<slug>`. */
  kid: string;
  /** Base64 Ed25519 signature over the canonicalized claim set. */
  signature: string;
}

/**
 * Error thrown when the local instance cannot sign an assertion (missing
 * `nodes` row, missing private key, invalid input). Distinct type so
 * callers can map it cleanly to a 500 without swallowing validation errors.
 */
export class SsoAssertionSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoAssertionSigningError";
  }
}

/**
 * Produce the canonical JSON string that gets signed/verified. Exposed so
 * tests (and any future target-side verifier written in this repo) can
 * check byte-for-byte equivalence without calling through the full signer.
 *
 * The key order in the signed surface is implicit — `canonicalize` sorts
 * keys so signer and verifier never disagree even if callers pass fields
 * in a different order.
 */
export function canonicalizeSsoAssertion(claims: SsoAssertionClaims): string {
  return canonicalize(stripUndefined(claims));
}

/**
 * Input accepted by {@link signSsoAssertion}. Narrower than
 * {@link SsoAssertionClaims} — we compute `iat`, `exp`, `nonce` inside the
 * signer so the caller cannot accidentally mint a long-lived assertion or
 * forget a nonce.
 */
export interface SignSsoAssertionInput {
  actorId: string;
  email?: string;
  handle?: string;
  homeBaseUrl: string;
  targetBaseUrl: string;
  credentialVersion: number;
  homeAuthorityVersion: number;
  instanceClass: "hosted-federated" | "sovereign";
  parentAgentId: string | null;
  /** Optional override for lifetime — clamped to ≤ max. */
  lifetimeSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
  /** Optional fixed nonce override for tests. */
  nonce?: string;
}

/**
 * Sign a short-lived SSO assertion using this instance's Ed25519 private
 * key. Loads the key lazily from the `nodes` row for this instance so the
 * signer picks up rotations without requiring a process restart.
 *
 * @param input Input claim fields plus test-overridable clock/nonce.
 * @returns A signed assertion envelope ready to JSON-serialize.
 * @throws {SsoAssertionSigningError} When the local node is missing, has
 *   no private key, or input is malformed.
 */
export async function signSsoAssertion(
  input: SignSsoAssertionInput,
): Promise<SignedSsoAssertion> {
  validateInput(input);

  const { privateKey, kid, baseUrl } = await loadLocalSigningKey();

  const lifetimeSec = clampLifetime(input.lifetimeSec);
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + lifetimeSec;
  const nonce = input.nonce ?? generateNonce();

  const claims: SsoAssertionClaims = {
    actorId: input.actorId,
    ...(input.email ? { email: input.email } : {}),
    ...(input.handle ? { handle: input.handle } : {}),
    homeBaseUrl: input.homeBaseUrl,
    globalIssuerBaseUrl: baseUrl,
    targetBaseUrl: input.targetBaseUrl,
    credentialVersion: input.credentialVersion,
    homeAuthorityVersion: input.homeAuthorityVersion,
    instanceClass: input.instanceClass,
    parentAgentId: input.parentAgentId,
    iat,
    exp,
    nonce,
  };

  // signPayload re-canonicalizes internally, but we pass a plain object
  // with undefined-stripped keys so the signed surface matches
  // canonicalizeSsoAssertion(claims) byte-for-byte. The double cast via
  // `unknown` is required because `SsoAssertionClaims` is a typed
  // interface and TS refuses to convert it directly to an index-signature
  // shape, even though the runtime object satisfies it.
  const signature = signPayload(
    stripUndefined(claims) as unknown as Record<string, unknown>,
    privateKey,
  );

  return { ...claims, kid, signature };
}

/**
 * Resolve the local node's Ed25519 private key + kid. Mirrors the helper
 * in authority-events.ts; kept as a private helper here (not exported
 * from authority-events) so both call sites stay self-contained and
 * testable without crossing module boundaries. Using the same lookup
 * means authority events and SSO assertions are always signed by the
 * same key pair.
 */
async function loadLocalSigningKey(): Promise<{
  privateKey: string;
  kid: string;
  baseUrl: string;
}> {
  const config = getInstanceConfig();

  const [node] = await db
    .select({
      privateKey: nodes.privateKey,
      slug: nodes.slug,
      baseUrl: nodes.baseUrl,
    })
    .from(nodes)
    .where(eq(nodes.id, config.instanceId))
    .limit(1);

  if (!node) {
    throw new SsoAssertionSigningError(
      `Local node ${config.instanceId} not found. ensureLocalNode() must run before issuing SSO assertions.`,
    );
  }
  if (!node.privateKey) {
    throw new SsoAssertionSigningError(
      `Local node ${config.instanceId} has no private key configured. SSO assertions cannot be signed.`,
    );
  }

  const kid = `${node.baseUrl}#${node.slug}`;
  return { privateKey: node.privateKey, kid, baseUrl: node.baseUrl };
}

/**
 * Reject inputs that would otherwise produce nonsensical assertions.
 * Keeping these checks here (not in the route handler) means any future
 * caller — including tests or internal admin tooling — cannot mint a
 * malformed assertion by accident.
 */
function validateInput(input: SignSsoAssertionInput): void {
  if (!input.actorId) {
    throw new SsoAssertionSigningError("actorId is required");
  }
  if (!input.homeBaseUrl) {
    throw new SsoAssertionSigningError("homeBaseUrl is required");
  }
  if (!input.targetBaseUrl) {
    throw new SsoAssertionSigningError("targetBaseUrl is required");
  }
  if (!Number.isInteger(input.credentialVersion) || input.credentialVersion < 1) {
    throw new SsoAssertionSigningError(
      `credentialVersion must be a positive integer; got ${input.credentialVersion}`,
    );
  }
  if (!Number.isInteger(input.homeAuthorityVersion) || input.homeAuthorityVersion < 1) {
    throw new SsoAssertionSigningError(
      `homeAuthorityVersion must be a positive integer; got ${input.homeAuthorityVersion}`,
    );
  }
  if (input.instanceClass !== "hosted-federated" && input.instanceClass !== "sovereign") {
    throw new SsoAssertionSigningError(
      `instanceClass must be hosted-federated|sovereign; got ${String(input.instanceClass)}`,
    );
  }
  if (!input.email && !input.handle) {
    throw new SsoAssertionSigningError(
      "either email or handle must be present on the signed claims",
    );
  }
  // Validate URLs eagerly so the signed surface never contains garbage.
  try {
    // eslint-disable-next-line no-new
    new URL(input.homeBaseUrl);
  } catch {
    throw new SsoAssertionSigningError(
      `homeBaseUrl must be a valid URL; got "${input.homeBaseUrl}"`,
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(input.targetBaseUrl);
  } catch {
    throw new SsoAssertionSigningError(
      `targetBaseUrl must be a valid URL; got "${input.targetBaseUrl}"`,
    );
  }
}

/**
 * Clamp the caller-supplied lifetime into `(0, MAX]`. A non-positive or
 * non-finite value falls back to the default; anything over the maximum is
 * pinned to the maximum so the 5-minute cap cannot be bypassed by
 * supplying a huge `lifetimeSec`.
 */
function clampLifetime(requested: number | undefined): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return SSO_ASSERTION_DEFAULT_LIFETIME_SEC;
  }
  return Math.min(Math.floor(requested), SSO_ASSERTION_MAX_LIFETIME_SEC);
}

/**
 * Produce a base64url-encoded random nonce. base64url (not plain base64)
 * keeps the nonce safe to embed in URLs, query strings, or cookies
 * without additional encoding.
 */
function generateNonce(): string {
  // Lazy require so this module stays tree-shakeable in environments that
  // don't hit the signer (e.g. target-side verifiers importing only the
  // canonicalize helper in tests).
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return randomBytes(SSO_ASSERTION_NONCE_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Remove `undefined` keys from a claims object before canonicalization.
 * `canonicalize` already skips undefined, but stripping here keeps the
 * signed claims object aligned with what `signSsoAssertion` returns so
 * comparisons with `canonicalizeSsoAssertion(result)` are exact.
 *
 * The input type is intentionally `object` rather than
 * `Record<string, unknown>`: TypeScript does not treat ordinary interfaces
 * (like `SsoAssertionClaims`) as assignable to index-signature types
 * implicitly, and widening every call site with a cast would defeat the
 * compile-time checking we want on the claim shape. Internally we iterate
 * with `Object.entries` for the same reason.
 */
function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Target-side verification (issue #102 — federated-SSO login on peers)
// ---------------------------------------------------------------------------

/**
 * Reason an assertion failed verification. Stable string so routes can log
 * or surface structured errors without leaking verifier internals.
 */
export type SsoAssertionVerifyFailure =
  | "malformed"
  | "expired"
  | "not-yet-valid"
  | "audience-mismatch"
  | "issuer-mismatch"
  | "issuer-unknown"
  | "issuer-no-public-key"
  | "signature-invalid"
  | "clock-skew-exceeded";

/** Outcome envelope for {@link verifySsoAssertion}. */
export type SsoAssertionVerifyResult =
  | { ok: true; claims: SsoAssertionClaims }
  | { ok: false; reason: SsoAssertionVerifyFailure; detail?: string };

/** Input to {@link verifySsoAssertion}. */
export interface VerifySsoAssertionInput {
  /** Full signed assertion as received from the wire. */
  assertion: unknown;
  /** Local base URL this peer advertises — must match `targetBaseUrl`. */
  expectedTargetBaseUrl: string;
  /**
   * When provided, the verifier restricts trust to this single issuer.
   * Callers that trust a list of issuers should pre-filter and pass one
   * value here, so the signed surface cannot be accepted from an
   * unexpected origin even if the `nodes` row exists for it.
   */
  expectedGlobalIssuerBaseUrl?: string;
  /**
   * Maximum allowed clock skew in seconds. Default 60s. Applied to both
   * `iat` (reject future-dated) and `exp` (already covered but belt-and-
   * braces) so minor NTP drift does not reject legitimate assertions.
   */
  maxClockSkewSec?: number;
  /** Optional fixed clock for tests. Milliseconds since epoch. */
  now?: number;
}

/** Minimal `nodes` shape the verifier needs. Exported for mockability. */
export interface IssuerPublicKeyLookup {
  /** Return the PEM-encoded Ed25519 public key for the given base URL. */
  (baseUrl: string): Promise<string | null>;
}

/**
 * Default issuer-public-key lookup: search `nodes` by base URL.
 *
 * Kept private so callers use the verifier entry point. The default
 * resolver hits the DB; tests should pass an in-memory stub via the
 * {@link verifySsoAssertion} `resolveIssuerPublicKey` argument below.
 */
async function defaultIssuerPublicKeyLookup(
  baseUrl: string,
): Promise<string | null> {
  const [node] = await db
    .select({ publicKey: nodes.publicKey })
    .from(nodes)
    .where(eq(nodes.baseUrl, baseUrl))
    .limit(1);
  return node?.publicKey ?? null;
}

/**
 * Verify a signed SSO assertion against this peer's expectations.
 *
 * The function layers checks from cheapest to most expensive so a malformed
 * or mis-audience'd payload is rejected before the DB is queried for the
 * issuer's public key.
 *
 * @param input Verification inputs (assertion + expected target/issuer).
 * @param resolveIssuerPublicKey Optional override of the `nodes` lookup,
 *   used by tests to avoid hitting the DB.
 * @returns `{ ok: true, claims }` on success; `{ ok: false, reason }` otherwise.
 */
export async function verifySsoAssertion(
  input: VerifySsoAssertionInput,
  resolveIssuerPublicKey: IssuerPublicKeyLookup = defaultIssuerPublicKeyLookup,
): Promise<SsoAssertionVerifyResult> {
  const parsed = parseSignedAssertion(input.assertion);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }
  const { claims, signature } = parsed;

  // Audience binding — reject early, cheapest check that matters.
  const expectedTarget = normalizeBaseUrl(input.expectedTargetBaseUrl);
  const assertionTarget = normalizeBaseUrl(claims.targetBaseUrl);
  if (!expectedTarget || expectedTarget !== assertionTarget) {
    return { ok: false, reason: "audience-mismatch" };
  }

  // Optional issuer allow-listing.
  if (input.expectedGlobalIssuerBaseUrl) {
    const expectedIssuer = normalizeBaseUrl(input.expectedGlobalIssuerBaseUrl);
    const claimsIssuer = normalizeBaseUrl(claims.globalIssuerBaseUrl);
    if (!expectedIssuer || expectedIssuer !== claimsIssuer) {
      return { ok: false, reason: "issuer-mismatch" };
    }
  }

  // Expiry / iat sanity.
  const nowMs = typeof input.now === "number" ? input.now : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const skew = clampSkew(input.maxClockSkewSec);
  if (claims.exp + skew <= nowSec) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iat - skew > nowSec) {
    return { ok: false, reason: "not-yet-valid" };
  }

  // Issuer public-key lookup.
  const publicKey = await resolveIssuerPublicKey(claims.globalIssuerBaseUrl);
  if (publicKey === null) {
    return { ok: false, reason: "issuer-unknown" };
  }
  if (!publicKey) {
    return { ok: false, reason: "issuer-no-public-key" };
  }

  // Ed25519 signature verification over the canonical claim set.
  const ok = verifyPayloadSignature(
    stripUndefined(claims) as unknown as Record<string, unknown>,
    signature,
    publicKey,
  );
  if (!ok) {
    return { ok: false, reason: "signature-invalid" };
  }

  return { ok: true, claims };
}

/**
 * Parse an unknown wire value into a {@link SignedSsoAssertion}. Returns
 * `null` when required fields are missing or wrong-typed.
 */
function parseSignedAssertion(
  raw: unknown,
): { claims: SsoAssertionClaims; signature: string; kid: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (
    typeof o.actorId !== "string" ||
    typeof o.homeBaseUrl !== "string" ||
    typeof o.globalIssuerBaseUrl !== "string" ||
    typeof o.targetBaseUrl !== "string" ||
    typeof o.credentialVersion !== "number" ||
    typeof o.homeAuthorityVersion !== "number" ||
    (o.instanceClass !== "hosted-federated" && o.instanceClass !== "sovereign") ||
    (o.parentAgentId !== null && typeof o.parentAgentId !== "string") ||
    typeof o.iat !== "number" ||
    typeof o.exp !== "number" ||
    typeof o.nonce !== "string" ||
    typeof o.kid !== "string" ||
    typeof o.signature !== "string"
  ) {
    return null;
  }
  if (o.email !== undefined && typeof o.email !== "string") return null;
  if (o.handle !== undefined && typeof o.handle !== "string") return null;

  const claims: SsoAssertionClaims = {
    actorId: o.actorId,
    ...(typeof o.email === "string" ? { email: o.email } : {}),
    ...(typeof o.handle === "string" ? { handle: o.handle } : {}),
    homeBaseUrl: o.homeBaseUrl,
    globalIssuerBaseUrl: o.globalIssuerBaseUrl,
    targetBaseUrl: o.targetBaseUrl,
    credentialVersion: o.credentialVersion,
    homeAuthorityVersion: o.homeAuthorityVersion,
    instanceClass: o.instanceClass,
    parentAgentId: o.parentAgentId as string | null,
    iat: o.iat,
    exp: o.exp,
    nonce: o.nonce,
  };
  return { claims, signature: o.signature, kid: o.kid };
}

/** Normalize a base URL to its canonical origin, or null when invalid. */
function normalizeBaseUrl(input: string | undefined | null): string | null {
  if (!input) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

/** Clamp the caller-supplied skew into `[0, 300]` seconds. */
function clampSkew(requested: number | undefined): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested < 0
  ) {
    return 60;
  }
  return Math.min(Math.floor(requested), 300);
}
