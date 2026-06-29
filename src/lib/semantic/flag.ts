/**
 * @file flag.ts — client-safe feature gate for the semantic parser v1 rollout.
 *
 * The new semantic parser (`src/lib/semantic/*`) is wired into the conditional
 * composer (`query-composer.tsx`) and the command bar (`CommandBar.tsx`) BEHIND
 * this flag. When the flag is OFF (the default), both surfaces fall back to the
 * legacy `parseNaturalLanguageV2` path byte-for-byte — production behavior is
 * unchanged until an operator opts in.
 *
 * The flag is read from a `NEXT_PUBLIC_*` env var so it is inlined at build time
 * and safe to evaluate in client components (mirrors `isMapboxConfigured` in
 * `src/lib/integrations/mapbox.ts`). It is intentionally string-compared against
 * the canonical "on" value so a missing/empty/typo'd value reads as OFF.
 *
 * @dependencies none (pure env lookup; no db/IO).
 */

/** Env var that gates the semantic parser v1 wiring. */
export const SEMANTIC_PARSER_V1_FLAG = "NEXT_PUBLIC_SEMANTIC_PARSER_V1" as const;

/** The only value that turns the flag ON. Anything else (incl. unset) is OFF. */
export const SEMANTIC_PARSER_V1_ON_VALUE = "1" as const;

/**
 * Whether the semantic parser v1 path is enabled.
 *
 * Default OFF: returns `true` only when `NEXT_PUBLIC_SEMANTIC_PARSER_V1` is
 * exactly `"1"`. To enable, set `NEXT_PUBLIC_SEMANTIC_PARSER_V1=1` in the
 * environment at build time (it is a `NEXT_PUBLIC_*` var, so it must be present
 * when `next build` runs to be inlined into the client bundle).
 *
 * @returns `true` when the flag is explicitly set on, otherwise `false`.
 */
export function isSemanticParserV1Enabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_SEMANTIC_PARSER_V1?.trim() ===
    SEMANTIC_PARSER_V1_ON_VALUE
  );
}
