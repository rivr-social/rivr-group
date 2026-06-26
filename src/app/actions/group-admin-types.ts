/**
 * Public constant + type surface for the group-admin server actions.
 *
 * Reason this file exists:
 * - `group-admin.ts` is a `"use server"` file. Next.js 15 forbids a
 *   "use server" file from exporting anything other than async functions.
 *   The settings error-code constant and its derived type cannot live in
 *   that file anymore.
 * - Keeping the public surface here (no `"use server"` directive) lets the
 *   server-action code import from `./group-admin-types` and lets the
 *   settings UI import the same shapes without a build-time error.
 *
 * Do not add runtime behavior to this file.
 */

/**
 * Stable, machine-readable failure codes for `fetchGroupAdminSettings`.
 * The settings page keys redirect behavior on `FORBIDDEN`/`UNAUTHENTICATED`
 * rather than matching error message text.
 */
export const GROUP_SETTINGS_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_GROUP: "INVALID_GROUP",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type GroupSettingsErrorCode =
  (typeof GROUP_SETTINGS_ERROR_CODES)[keyof typeof GROUP_SETTINGS_ERROR_CODES];
