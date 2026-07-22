/**
 * Cross-instance mutation wire vocabulary — SHARED CONTRACT.
 *
 * This file is manifest-shared and MUST stay byte-identical across the
 * RIVR repos (see tools/shared-manifest.json in the workspace; the
 * parity check fails the drift guard when copies diverge). Emitters and
 * receivers both import it, so the 2026-07 class of bug — every repo
 * emitting `postCommentAction` while person/group receivers only knew a
 * retired `createComment` — cannot be reintroduced silently.
 *
 * Scope: NAMES ONLY. Payload shapes stay owned by the emitting actions;
 * receivers validate fields defensively. Adding a type here does not
 * obligate every receiver to support it — unsupported types must still
 * be rejected EXPLICITLY (501 MUTATION_NOT_IMPLEMENTED), never silently.
 */

/** Social-interaction mutations every RIVR emitter uses on the wire today. */
export const INTERACTION_MUTATION_TYPES = [
  "postCommentAction",
  "toggleLikeOnTarget",
  "setReactionOnTarget",
  "toggleThankOnTarget",
  "setEventRsvp",
] as const;

export type InteractionMutationType = (typeof INTERACTION_MUTATION_TYPES)[number];

/**
 * Retired wire names still accepted for compatibility, mapped to their
 * modern equivalent. No RIVR emitter has sent these since the
 * interaction actions unified on the action-name vocabulary; the aliases
 * exist so a stale peer can never be silently dropped.
 */
export const LEGACY_MUTATION_ALIASES: Record<string, InteractionMutationType> = {
  createComment: "postCommentAction",
  toggleReaction: "setReactionOnTarget",
};

/** Canonical wire name for an incoming mutation type (resolves aliases). */
export function canonicalMutationType(type: string): string {
  return (LEGACY_MUTATION_ALIASES as Record<string, string>)[type] ?? type;
}
