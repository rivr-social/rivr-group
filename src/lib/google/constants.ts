/**
 * Constants for Google Workspace OAuth on rivr-group (PR1).
 *
 * Purpose:
 * - Centralizes provider identifiers, OAuth endpoints, and scope names so
 *   no string drifts between connect, callback, settings, and mailer paths.
 *
 * Scope rationale:
 * - `calendar` is required so PR2 can sync the group's calendar without
 *   another consent prompt.
 * - `https://mail.google.com/` is required because PR1 sends via SMTP
 *   XOAUTH2 to smtp.gmail.com. Per Google's Gmail XOAUTH2 protocol docs,
 *   IMAP/POP/SMTP access requires this single full-access scope; the
 *   narrower `gmail.send` scope is only valid for the Gmail REST API
 *   (`users.messages.send`) and will not authenticate over SMTP.
 *   If we later switch the send path to the Gmail REST API for least
 *   privilege, downgrade this back to `gmail.send`.
 * - `userinfo.email` + `openid` lets the callback resolve the linked
 *   account email for display and audit.
 *
 * Operator note:
 * - This scope is classified by Google as "restricted." Workspace admins
 *   may need to allow-list this app in Google Admin > Security > API
 *   Controls before group admins can complete the connect flow.
 *
 * Error codes:
 * - Stable identifiers used in the connect/callback redirect query so the
 *   Connections UI can render specific error states. Never leak provider
 *   error bodies in URLs — the codes here are the public surface.
 */

/** Stable provider identifier used in `groupConnections.provider`. */
export const GOOGLE_WORKSPACE_PROVIDER = 'google_workspace' as const;

/** Google OAuth 2.0 authorization endpoint. */
export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google OAuth 2.0 token exchange + refresh endpoint. */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** OIDC userinfo endpoint used to resolve the linked account email. */
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Granted scopes for a group-admin Workspace link. Joined into a single
 * space-delimited string at request time.
 */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/calendar',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

/** Cookie name for the per-flow OAuth state nonce. HMAC-signed in the cookie value. */
export const GOOGLE_OAUTH_STATE_COOKIE = 'group_google_oauth_state';

/** Cookie max age in seconds — short-lived, just long enough to consent. */
export const GOOGLE_OAUTH_STATE_MAX_AGE_SECONDS = 600;

/**
 * Static callback path for the per-group Google Workspace OAuth flow.
 *
 * Google OAuth Console requires a fixed allow-list of redirect URIs and does
 * NOT accept path-template segments like `[groupId]`. The target group is
 * therefore carried inside the signed `state` parameter, not the URL.
 *
 * Operator: register `${baseUrl}${GROUP_GOOGLE_CALLBACK_PATH}` for each
 * deployed origin (e.g. `https://group.rivr.social/api/group/connections/google/callback`).
 */
export const GROUP_GOOGLE_CALLBACK_PATH =
  '/api/group/connections/google/callback' as const;

/**
 * Cookie path for the per-flow OAuth state nonce.
 *
 * Must be a prefix common to BOTH the connect route
 * (`/api/group/[groupId]/connections/google/connect`) and the static
 * callback route (`/api/group/connections/google/callback`). `/api/group`
 * is the tightest prefix that covers both. Concurrent OAuth dances are
 * still distinguished by the cookie value vs the signed-state nonce match.
 */
export const GOOGLE_OAUTH_STATE_COOKIE_PATH = '/api/group' as const;

/**
 * Stable error codes surfaced through `?error=...` on the Connections page.
 * Keep the values short and provider-agnostic.
 */
export const GOOGLE_OAUTH_ERRORS = {
  NOT_CONFIGURED: 'not_configured',
  STATE_MISCONFIGURED: 'state_misconfigured',
  FORBIDDEN: 'forbidden',
  STATE_MISMATCH: 'state_mismatch',
  STATE_MISSING: 'state_missing',
  CODE_MISSING: 'code_missing',
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  NO_ACCESS_TOKEN: 'no_access_token',
  USERINFO_FAILED: 'userinfo_failed',
  PROVIDER_ERROR: 'provider_error',
  INVALID_GROUP: 'invalid_group',
} as const;

export type GoogleOAuthErrorCode =
  (typeof GOOGLE_OAUTH_ERRORS)[keyof typeof GOOGLE_OAUTH_ERRORS];
