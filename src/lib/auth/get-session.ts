// src/lib/auth/get-session.ts

/**
 * Unified session helper for NextAuth + federated remote-viewer cookie (issue #105).
 *
 * Purpose:
 * - Present a single call-site for server components and API routes that need
 *   to know "who is the authenticated actor right now?".
 * - Accept **either** the NextAuth JWT session (`auth()`) **or** the signed
 *   `rivr_remote_viewer` cookie minted by `/api/federation/remote-auth`.
 * - Keep the two sources clearly labeled in the returned shape so downstream
 *   code can make capability decisions (e.g. a federated viewer from another
 *   home is allowed to read but should go through projection shaping).
 *
 * Trust model:
 * - NextAuth takes precedence. If the caller has a valid NextAuth JWT, we use
 *   that and do not even look at the cookie.
 * - The cookie is HMAC-verified on every read via
 *   {@link decodeRemoteViewerSession}, which internally rejects bad signatures
 *   and expired payloads. We never trust a cookie that did not round-trip
 *   through the verifier.
 *
 * Usage:
 * ```ts
 * import { getSession } from "@/lib/auth/get-session";
 *
 * const session = await getSession();
 * if (!session) return NextResponse.json({ error: "..." }, { status: 401 });
 * const userId = session.user.id;
 * if (session.user.authMethod === "federated") {
 *   // apply projection / ReBAC as the remote viewer, not local admin
 * }
 * ```
 */

import { cookies } from "next/headers";

import { auth } from "@/auth";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  decodeRemoteViewerSession,
  type RemoteViewerSessionPayload,
} from "@/lib/federation/remote-viewer-session";

/**
 * Authentication source the session was resolved from.
 *
 * - `nextauth` — classic NextAuth JWT session, set by the credentials provider
 *   on this instance.
 * - `federated` — signed `rivr_remote_viewer` cookie issued by another
 *   instance (typically the global identity authority via federated SSO, or
 *   a sovereign home asserting directly to this peer).
 */
export type SessionAuthMethod = "nextauth" | "federated";

/** Shape returned by {@link getSession}. */
export interface UnifiedSession {
  user: {
    /** Canonical actor/agent id. Always present. */
    id: string;
    /** Email address when known; federated cookies do not carry email. */
    email: string | null;
    /** Display name when known. */
    name: string | null;
    /** Avatar URL when known. */
    image: string | null;
    /** Home base URL for federated viewers; null for local NextAuth users. */
    homeBaseUrl: string | null;
    /** How this session was authenticated. */
    authMethod: SessionAuthMethod;
  };
  /** ISO expiry string. NextAuth stamps this itself; federated is derived from `exp`. */
  expires: string;
  /**
   * Full remote-viewer payload when {@link UnifiedSession.user.authMethod} is
   * `"federated"`. Provided so advanced callers can inspect `instanceClass`,
   * `credentialVersion`, `parentAgentId`, etc. without re-parsing the cookie.
   */
  remoteViewer?: RemoteViewerSessionPayload;
}

/**
 * Internal: read and verify the federated remote-viewer cookie, if present.
 *
 * Always HMAC-verified. Returns null when:
 * - cookie is absent
 * - signature is invalid
 * - payload is malformed
 * - `exp` is in the past (expire-check on every read, not just Max-Age)
 * - `AUTH_SECRET` is missing (we refuse to trust anything unverifiable)
 */
async function readFederatedSession(): Promise<UnifiedSession | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  const cookieStore = await cookies();
  const raw = cookieStore.get(REMOTE_VIEWER_COOKIE_NAME)?.value;
  if (!raw) return null;

  const payload = decodeRemoteViewerSession(raw, secret);
  if (!payload) return null;

  return {
    user: {
      id: payload.actorId,
      email: null,
      name: null,
      image: null,
      homeBaseUrl: payload.homeBaseUrl,
      authMethod: "federated",
    },
    expires: new Date(payload.exp * 1000).toISOString(),
    remoteViewer: payload,
  };
}

/**
 * Resolve the unified session for this request.
 *
 * Resolution order:
 * 1. NextAuth session via `auth()` — takes precedence.
 * 2. Federated `rivr_remote_viewer` cookie (HMAC-verified, expire-checked).
 * 3. `null` when neither source yields an authenticated actor.
 *
 * Safe to call from server components, route handlers, and server actions.
 * Not safe from middleware — use
 * {@link ../federation/remote-viewer-session-edge.decodeRemoteViewerSessionEdge}
 * and NextAuth's `getToken` directly in that runtime.
 *
 * @returns The unified session, or `null` if unauthenticated.
 */
export async function getSession(): Promise<UnifiedSession | null> {
  const nextAuthSession = await auth();
  if (nextAuthSession?.user?.id) {
    return {
      user: {
        id: nextAuthSession.user.id,
        email: nextAuthSession.user.email ?? null,
        name: nextAuthSession.user.name ?? null,
        image: nextAuthSession.user.image ?? null,
        homeBaseUrl: null,
        authMethod: "nextauth",
      },
      expires: nextAuthSession.expires,
    };
  }

  return readFederatedSession();
}
