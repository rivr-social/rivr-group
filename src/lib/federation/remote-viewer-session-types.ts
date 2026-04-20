/**
 * Shared value + type surface for the remote-viewer session cookie.
 *
 * Reason this file exists:
 * - Edge middleware can't import from `remote-viewer-session.ts` because that
 *   module pulls in `node:crypto`, which is unavailable in the edge runtime.
 * - The middleware only needs the cookie name and the payload shape — no
 *   encoding/decoding. Putting those in their own pure module lets middleware
 *   import them without dragging in node:crypto.
 * - Both the Node and edge modules import from here so their payload shapes
 *   stay in lockstep by construction.
 */

/** Cookie name — namespaced so it cannot collide with NextAuth's cookies. */
export const REMOTE_VIEWER_COOKIE_NAME = "rivr_remote_viewer";

/**
 * How this session was authenticated. Exposed on the signed payload so
 * downstream code (audit, capability gating) can reason about the
 * difference between "federated via global", "direct home assertion",
 * and "local credentials provider on this instance".
 */
export type RemoteViewerAuthMethod =
  | "federated-sso"
  | "home-assertion"
  | "local-credentials";

/**
 * Signed payload stored inside the `rivr_remote_viewer` cookie.
 *
 * The three `authMethod` values correspond to:
 * - `federated-sso` — assertion was issued by the global identity authority
 *   after verifying the user's credential; `globalIssuerBaseUrl` is set.
 * - `home-assertion` — a sovereign home instance vouched for the user
 *   directly to this peer; `globalIssuerBaseUrl` may be null.
 * - `local-credentials` — the user authenticated with a password against
 *   this peer's own `agents` table; included for audit symmetry even
 *   though local credentials typically use the NextAuth session.
 */
export interface RemoteViewerSessionPayload {
  /** Agent UUID — the authenticated actor. */
  actorId: string;
  /** Canonical home base URL recorded at authentication time. */
  homeBaseUrl: string;
  /**
   * Global issuer that signed the upstream SSO assertion. Required for
   * `authMethod === "federated-sso"`, null otherwise.
   */
  globalIssuerBaseUrl: string | null;
  /** Monotonic credential version recorded on identity_authority. */
  credentialVersion: number;
  /** Home authority version at authentication time. */
  homeAuthorityVersion: number;
  /** Distinguishes hosted-federated vs sovereign home authority. */
  instanceClass: "hosted-federated" | "sovereign";
  /** Parent agent id when `actorId` is a persona, null otherwise. */
  parentAgentId: string | null;
  /** How this session was authenticated. */
  authMethod: RemoteViewerAuthMethod;
  /** Issued-at time, UNIX seconds UTC. */
  iat: number;
  /** Expiry, UNIX seconds UTC. Decoder rejects if now > exp. */
  exp: number;
}
