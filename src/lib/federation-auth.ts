import { auth } from "@/auth";
import { db } from "@/db";
import { nodePeers, nodes } from "@/db/schema";
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

export function bindAuthorizedFederationActor(
  authorization: FederationAuthResult,
  requestedActorId: string | undefined,
): FederationActorBindingResult {
  if (!authorization.authorized) {
    return { authorized: false, reason: authorization.reason ?? "Authentication required" };
  }

  if (!requestedActorId) {
    return { authorized: false, reason: "actorId is required" };
  }

  if (!authorization.actorId) {
    return {
      authorized: false,
      reason: "Federation mutations require an actor-bound session or remote viewer token.",
    };
  }

  if (authorization.actorId !== requestedActorId) {
    return {
      authorized: false,
      reason: "Authenticated actor does not match requested actorId.",
    };
  }

  return { authorized: true, actorId: authorization.actorId };
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
