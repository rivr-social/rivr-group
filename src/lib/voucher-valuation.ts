/**
 * Voucher Thanks valuation — the single source of truth for how a completed
 * piece of work is priced in Thanks tokens.
 *
 * The formula mirrors the interactive `VoucherBuilder` UI
 * (`src/components/modules/market/VoucherBuilder.tsx`):
 *
 *   thanks = round( sqrt(skillfulness × difficulty) × hours )
 *
 * where `skillfulness` and `difficulty` are 1–100 slider ratings and `hours`
 * is the time the work took. Volunteer-pay jobs reuse this exact mapping to
 * value the post-hoc voucher minted for each volunteer at completion, so the
 * builder preview and the settled voucher never diverge.
 */

/** Rating slider bounds (skillfulness / difficulty), matching the UI. */
export const VOUCHER_RATING_MIN = 1;
export const VOUCHER_RATING_MAX = 100;

/** Clamps a rating into the [MIN, MAX] slider range; NaN → MIN. */
function clampRating(value: number): number {
  if (!Number.isFinite(value)) return VOUCHER_RATING_MIN;
  return Math.min(VOUCHER_RATING_MAX, Math.max(VOUCHER_RATING_MIN, value));
}

/**
 * Computes a voucher's Thanks value from its skillfulness/difficulty ratings
 * and the hours worked. Ratings are clamped to the slider range; a
 * non-positive/non-finite `hours` yields 0. Result is a non-negative integer.
 */
export function computeVoucherThanksValue(input: {
  skillfulness: number;
  difficulty: number;
  hours: number;
}): number {
  const skillfulness = clampRating(input.skillfulness);
  const difficulty = clampRating(input.difficulty);
  const hours = Number.isFinite(input.hours) && input.hours > 0 ? input.hours : 0;
  return Math.max(0, Math.round(Math.sqrt(skillfulness * difficulty) * hours));
}
