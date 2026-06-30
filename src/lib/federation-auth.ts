import { auth } from "@/auth";
import { db } from "@/db";
import { federationEntityMap, nodePeers, nodes } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import { timingSafeEqual } from "crypto";

/**
 * Federation authentication and configuration validation utilities.
 *
 * Purpose:
 * - Authorize inbound federation requests using one of three methods.
 * - Create and verify per-peer shared-secret hashes for server-to-server trust.
 * - Validate required federation auth configuration at startup.
 *
 * Key exports:
 * - {@link hashPeerSecret}
 * - {@link generatePeerSecret}
 * - {@link authorizeFederationRequest}
 * - {@link validateFederationConfig}
 *
 * Dependencies:
 * - `@/auth` for session-based authentication.
 * - `@/db` and federation tables for peer credential lookups.
 * - Node.js `crypto` for hashing, random secret generation, and timing-safe comparison.
 *
 * Configuration pattern:
 * - `NODE_ADMIN_KEY` is required for admin-key fallback authentication.
 * - Peer-secret auth (`x-peer-slug` + `x-peer-secret`) is the preferred integration mode.
 */

/**
 * Authorization outcome returned by federation auth flows.
 */
export interface FederationAuthResult {
  authorized: boolean;
  actorId?: string;
  peerNodeId?: string;
  reason?: string;
}

export interface FederationActorBindingResult {
  authorized: boolean;
  actorId?: string;
  reason?: string;
}

/**
 * Returns the configured NODE_ADMIN_KEY.
 * No fallback is provided — the key must be explicitly set via the
 * NODE_ADMIN_KEY environment variable in all environments.
 */
function resolveAdminKey(): string | undefined {
  return getEnv("NODE_ADMIN_KEY")?.trim() || undefined;
}

function secureEqual(a: string, b: string): boolean {
  // `timingSafeEqual` requires equal-length inputs; return early to avoid exceptions.
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Constant-time comparison reduces timing side-channel leakage for secrets and hashes.
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Hash a peer secret using SHA-256 for storage comparison.
 *
 * @param secret Plaintext peer secret presented during authentication.
 * @returns Hex-encoded SHA-256 hash used for database storage and comparison.
 * @throws {Error} Throws if hashing fails due to runtime crypto errors.
 * @example
 * ```ts
 * const hash = hashPeerSecret("peer-secret-value");
 * ```
 */
export function hashPeerSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/**
 * Generate a cryptographically random peer secret (48 bytes, base64url-encoded).
 * Returns both the plaintext secret (to show once) and the hash (to store).
 *
 * @param None This function does not accept arguments.
 * @returns Object containing a one-time plaintext `secret` and persisted `hash`.
 * @throws {Error} Throws if secure random generation fails.
 * @example
 * ```ts
 * const { secret, hash } = generatePeerSecret();
 * ```
 */
export function generatePeerSecret(): { secret: string; hash: string } {
  const secret = crypto.randomBytes(48).toString("base64url");
  return { secret, hash: hashPeerSecret(secret) };
}

/**
 * Authorize a federation API request. Checks authentication in this order:
 *
 * 1. **Session auth** — logged-in user with a valid session
 * 2. **Per-peer secret** — `x-peer-slug` + `x-peer-secret` headers identify a specific trusted peer
 * 3. **Global admin key** — `x-node-admin-key` header for backward compatibility
 *
 * Per-peer secrets are the recommended auth method for server-to-server federation calls.
 * The global admin key remains as a fallback for initial setup and backward compatibility.
 *
 * @param request Incoming HTTP request carrying federation auth headers.
 * @returns Authorization result including `authorized` state and optional actor/peer identity.
 * @throws {Error} May propagate session or database errors during auth checks.
 * @example
 * ```ts
 * const result = await authorizeFederationRequest(request);
 * if (!result.authorized) {
 *   return new Response(result.reason ?? "Unauthorized", { status: 401 });
 * }
 * ```
 */
export async function authorizeFederationRequest(request: Request): Promise<FederationAuthResult> {
  // 1. Session auth — only the owner of a hosted local node gets session-based access.
  const session = await auth();
  if (session?.user?.id) {
    const hostedNode = await db.query.nodes.findFirst({
      where: and(
        eq(nodes.ownerAgentId, session.user.id),
        eq(nodes.isHosted, true),
      ),
      columns: { id: true },
    });
    if (hostedNode) {
      return { authorized: true, actorId: session.user.id };
    }
  }

  // 2. Per-peer secret auth — preferred for server-to-server because it is scoped per relationship.
  const peerSlug = request.headers.get("x-peer-slug")?.trim();
  const peerSecret = request.headers.get("x-peer-secret")?.trim();

  if (peerSlug && peerSecret) {
    return authorizePeerSecret(peerSlug, peerSecret);
  }

  // 3. Global admin key auth — global key is less granular and should be phased out where possible.
  const configuredKey = resolveAdminKey();
  const requestKey = request.headers.get("x-node-admin-key")?.trim();

  if (!configuredKey) {
    return {
      authorized: false,
      reason: "NODE_ADMIN_KEY is not configured. Set this environment variable to enable federation admin access.",
    };
  }

  if (requestKey && secureEqual(requestKey, configuredKey)) {
    return { authorized: true };
  }

  return { authorized: false, reason: "Authentication required" };
}

/**
 * Bind a federation request to a SPECIFIC, verified actor id.
 *
 * This is the trust-rail authority gate for the mutation pipeline (F1). It never
 * trusts an ambient body-supplied `actorId` on the strength of the peer secret
 * alone — a holder of the shared secret or the fleet admin key must NOT be able
 * to write as an arbitrary actor. Instead, every peer-secret request is bound to
 * a receiver-local agent id through a PRE-EXISTING `federation_entity_map` row
 * (populated by the materializer during normal sync); a request with no binding
 * row is rejected.
 *
 * A single human has a distinct agent id on each sovereign instance (e.g.
 * Cameron is `aa29fa2d…` on his Camalot person instance but `ea079076…` — the
 * group creator/admin — on the Regen Hub group instance). The peer may identify
 * the actor by EITHER this instance's local id (2a) or the forwarder's local id,
 * i.e. our `externalEntityId` (2b). Either way the receiver-local id is returned
 * so downstream authority checks (`hasGroupWriteAccess`, ledger membership
 * lookups) run against THIS instance's own graph.
 *
 * @param authorization The result of {@link authorizeFederationRequest}.
 * @param requestedActorId The actor id supplied by the caller (session/body).
 * @returns A binding result carrying the receiver-local actor id, or a rejection.
 */
export async function bindAuthorizedFederationActor(
  authorization: FederationAuthResult,
  requestedActorId: string | undefined,
): Promise<FederationActorBindingResult> {
  if (!authorization.authorized) {
    return { authorized: false, reason: authorization.reason ?? "Authentication required" };
  }

  if (!requestedActorId) {
    return { authorized: false, reason: "actorId is required" };
  }

  // Path 1: session auth — actor must match the session.
  if (authorization.actorId) {
    if (authorization.actorId !== requestedActorId) {
      return {
        authorized: false,
        reason: "Authenticated actor does not match requested actorId.",
      };
    }
    return { authorized: true, actorId: authorization.actorId };
  }

  // Path 2: peer-secret auth — look up the entity map. The peer may identify
  // the actor by EITHER this instance's local id (2a) or the forwarder's local
  // id, i.e. our externalEntityId (2b). Either way we return the receiver-local
  // id so downstream authority checks run against this instance's own graph.
  if (authorization.peerNodeId) {
    // (2a) requestedActorId is already this instance's local agent id.
    const localMatch = await db.query.federationEntityMap.findFirst({
      where: and(
        eq(federationEntityMap.originNodeId, authorization.peerNodeId),
        eq(federationEntityMap.localEntityId, requestedActorId),
        eq(federationEntityMap.entityType, "agent"),
      ),
      columns: { id: true },
    });

    if (localMatch) {
      return { authorized: true, actorId: requestedActorId };
    }

    // (2b) requestedActorId is the forwarder's local id (our externalEntityId);
    // resolve it to the receiver-local agent id. Strict, read-only — no minting,
    // because an authority decision must not invent identity.
    const externalMatch = await db.query.federationEntityMap.findFirst({
      where: and(
        eq(federationEntityMap.originNodeId, authorization.peerNodeId),
        eq(federationEntityMap.externalEntityId, requestedActorId),
        eq(federationEntityMap.entityType, "agent"),
      ),
      columns: { localEntityId: true },
    });

    if (externalMatch) {
      return { authorized: true, actorId: externalMatch.localEntityId };
    }

    return {
      authorized: false,
      reason:
        "Peer is not authorized to act for this agent. No federation_entity_map row binds the peer to the requested actor.",
    };
  }

  // Path 3: admin-key auth without a peer or session. Admin tokens are
  // intentionally NOT allowed to bind an arbitrary actor because that would
  // let one shared secret impersonate any user. Setup flows that need an
  // unbound admin call should bypass this binding entirely.
  return {
    authorized: false,
    reason: "Federation mutations require an actor-bound session or remote viewer token.",
  };
}

/**
 * Authenticate a request using per-peer credentials.
 * Looks up the peer by slug, verifies the shared secret hash,
 * and checks for expiry and trust state.
 */
async function authorizePeerSecret(
  peerSlug: string,
  peerSecret: string
): Promise<FederationAuthResult> {
  // Look up the peer node by slug
  const peerNode = await db.query.nodes.findFirst({
    where: eq(nodes.slug, peerSlug),
  });

  if (!peerNode) {
    return { authorized: false, reason: "Unknown peer node" };
  }

  // Find the peer relationship that has credentials and is explicitly trusted.
  const peerLink = await db.query.nodePeers.findFirst({
    where: and(
      eq(nodePeers.peerNodeId, peerNode.id),
      eq(nodePeers.trustState, "trusted"),
    ),
  });

  if (!peerLink) {
    return { authorized: false, reason: "Peer is not trusted" };
  }

  if (!peerLink.peerSecretHash) {
    return {
      authorized: false,
      reason: "Peer has no credentials configured. Use the admin API to generate peer credentials.",
    };
  }

  // Expired credentials are rejected even if the hash matches.
  if (peerLink.secretExpiresAt && peerLink.secretExpiresAt < new Date()) {
    return {
      authorized: false,
      reason: "Peer credentials have expired. Rotate the peer secret to restore access.",
    };
  }

  // Compare hashes in constant time to avoid leaking which credential prefix matched.
  const providedHash = hashPeerSecret(peerSecret);
  if (!secureEqual(providedHash, peerLink.peerSecretHash)) {
    return { authorized: false, reason: "Invalid peer credentials" };
  }

  // Peer-secret auth is server-to-server. The peer node id is returned so the
  // mutation pipeline can bind the request to a verified, pre-mapped actor via
  // bindAuthorizedFederationActor — the body-supplied actorId is NEVER trusted
  // on the strength of the shared secret alone (F1).
  return { authorized: true, peerNodeId: peerNode.id };
}

export interface FederationConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates that federation configuration is properly set up.
 * Call at startup to surface misconfigurations early.
 *
 * @param None This function does not accept arguments.
 * @returns Validation object containing blocking `errors` and non-blocking `warnings`.
 * @throws {never} This function performs synchronous checks and does not throw intentionally.
 * @example
 * ```ts
 * const config = validateFederationConfig();
 * if (!config.valid) console.error(config.errors);
 * ```
 */
export function validateFederationConfig(): FederationConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const adminKey = getEnv("NODE_ADMIN_KEY")?.trim();

  if (!adminKey) {
    errors.push(
      "NODE_ADMIN_KEY is not set. Federation admin endpoints will reject all admin-key requests. Set this environment variable in .env.local (dev) or your deployment config (production)."
    );
  }

  if (adminKey && adminKey.length < 16) {
    warnings.push(
      "NODE_ADMIN_KEY is shorter than 16 characters. Consider using a longer, more secure key."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
