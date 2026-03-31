/**
 * SQL LIKE pattern utilities.
 *
 * This module provides helpers for safely preparing user-provided search text
 * for `LIKE` and `ILIKE` expressions.
 *
 * Key exports:
 * - `escapeLikePattern`: escapes wildcard and escape characters.
 * - `toContainsLikePattern`: wraps escaped input for `%...%` contains matching.
 *
 * Dependencies:
 * - No runtime dependencies.
 */

/**
 * Escapes SQL `LIKE`/`ILIKE` wildcard characters in user input.
 *
 * Security:
 * This function prevents accidental wildcard expansion (`%`, `_`) by escaping
 * those characters and backslashes so user input is treated as literal text.
 *
 * @param input - Raw user-provided text that may contain wildcard characters.
 * @returns A string safe to use with `LIKE ... ESCAPE '\\'` semantics.
 * @throws {TypeError} If `input` is not a string (native `.replace` behavior).
 * @example
 * const safe = escapeLikePattern("100%_match");
 * // "100\\%\\_match"
 */
export function escapeLikePattern(input: string): string {
  // Escape `\`, `%`, and `_` so they are interpreted literally by Postgres.
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Wraps escaped input in `%...%` for substring matching.
 *
 * @param input - Raw user-provided text to be used in a contains query.
 * @returns An escaped `%token%` pattern suitable for `LIKE`/`ILIKE`.
 * @throws {TypeError} If `input` is not a string (propagated from `escapeLikePattern`).
 * @example
 * const pattern = toContainsLikePattern("alice");
 * // "%alice%"
 */
export function toContainsLikePattern(input: string): string {
  // Reuse escaping to ensure wildcard control is preserved in contains search.
  return `%${escapeLikePattern(input)}%`;
}
