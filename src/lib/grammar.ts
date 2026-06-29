/**
 * @file grammar.ts — tiny English helpers for rendering rule/agreement summaries
 * in a human-readable, easeful way (e.g. "any agent joins" not "any agent join").
 *
 * Pure string transforms — no IO. Used by the conditional/agreement composer and
 * the profile "Agreements" tab so a third-person trigger subject reads naturally.
 */

const IRREGULAR_THIRD_PERSON: Record<string, string> = {
  be: "is",
  have: "has",
  do: "does",
  go: "goes",
};

/**
 * Conjugate a base-form verb to third-person singular present
 * ("join" → "joins", "watch" → "watches", "carry" → "carries").
 *
 * Conservative: operates on a single lowercase-ish token; leaves multi-word or
 * already-inflected input alone enough to be safe for display. Returns the input
 * unchanged when it is empty.
 */
export function thirdPersonSingular(verb: string | null | undefined): string {
  if (!verb) return "";
  const v = verb.trim();
  if (!v) return "";
  // Only conjugate a single word; phrases pass through (e.g. "opt in").
  if (/\s/.test(v)) return v;

  const lower = v.toLowerCase();
  if (IRREGULAR_THIRD_PERSON[lower]) return IRREGULAR_THIRD_PERSON[lower];

  // sibilant endings → +es
  if (/(s|sh|ch|x|z|o)$/.test(lower)) return `${v}es`;
  // consonant + y → ies (vowel + y → +s, handled by the default)
  if (/[^aeiou]y$/.test(lower)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}
