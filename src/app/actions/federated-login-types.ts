/**
 * Public type + constant surface for the federated login action.
 *
 * Reason this file exists:
 * - `federated-login.ts` is a `"use server"` file. Next.js 15 forbids a
 *   "use server" file from exporting anything other than async functions.
 *   The constants, types, and dependency-injection interface we want the
 *   login UI and tests to share cannot live in that file anymore.
 * - Keeping the public surface here (no `"use server"` directive) lets
 *   server-action code import from `./federated-login-types` and lets UI
 *   code import the same shapes without a build-time error.
 *
 * Do not add runtime behavior to this file.
 */

/**
 * Default global identity authority. Primary development edge is
 * `a.rivr.social` per the workspace deployment map. Any env override wins.
 */
export const DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL = "https://a.rivr.social";

/** Authentication path taken by the action. */
export type FederatedLoginMethod =
  | "federated-sso"
  | "local-credentials";

/** Envelope returned to the login form. */
export type FederatedLoginResult =
  | {
      success: true;
      /** Which path ultimately succeeded. */
      method: FederatedLoginMethod;
      /** Present only when `method === "federated-sso"`. */
      homeBaseUrl?: string;
      /** Present only when `method === "federated-sso"`. */
      globalIssuerBaseUrl?: string;
    }
  | {
      success: false;
      error: string;
    };

/** Input shape for the federated login action. */
export interface FederatedLoginInput {
  /** Plain-text email OR handle. Exactly one must be non-empty. */
  email?: string;
  /** Plain-text handle (Prism-style leading `@` tolerated). */
  handle?: string;
  /** Plain-text password. Length-bounded before network calls. */
  password: string;
  /**
   * Optional hint from the user about which home instance they belong to.
   * Used today as a UX signal and forwarded as-is if non-empty. The
   * authoritative home is always resolved by global's identity_authority.
   * If empty, we still attempt federated SSO.
   */
  homeBaseUrlHint?: string;
}

/**
 * Injection surface used by tests. Production code calls the default
 * exported `federatedLoginAction` directly which uses the defaults.
 */
export interface FederatedLoginDeps {
  /** Fetch used for BOTH global /sso/issue and the local /remote-auth call. */
  fetchImpl?: typeof fetch;
  /** Override the resolved base URL for this peer. */
  targetBaseUrl?: string;
  /** Override the global identity authority URL. */
  globalIdentityAuthorityUrl?: string;
  /** Override the local fallback so tests don't hit NextAuth signIn. */
  localLoginFallback?: (
    email: string,
    password: string,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Override the forwarded cookie setter for tests. */
  applyRemoteViewerCookie?: (setCookieHeader: string | null) => Promise<void>;
}
