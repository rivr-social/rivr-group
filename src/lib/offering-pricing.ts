/**
 * Offering price normalization — the WRITER-SIDE source of truth for the money
 * fields an offering resource persists in `resources.metadata`:
 *
 *   - `metadata.basePrice`       — integer CENTS
 *   - `metadata.totalPriceCents` — integer CENTS (what checkout charges)
 *   - `metadata.price`           — formatted display string (`"$15.00"`)
 *
 * All three are derived here from ONE input so they can never disagree. The
 * defect this closes: a service listing created at $15 stored
 * `basePrice: 150000` / `totalPriceCents: 150000` / `price: "$1500.00"` because
 * a dollars→cents conversion ran on a value that was already cents, so the
 * purchase page displayed one number and Stripe charged another.
 *
 * UNIT CONTRACT: `basePrice` arrives in CENTS. Every in-app writer already
 * produces cents — `create-offering-form`'s `OfferingDraftPayload`, the
 * marketplace edit path in `marketplace-item-page-client`, `items[].priceCents`
 * and `dealPrice` — and every reader (graph adapters, purchase page, checkout)
 * divides by 100. Callers whose OWN surface is denominated in dollars (the MCP
 * agent tools) convert at their boundary with `dollarsToCents`.
 */

export const CENTS_PER_DOLLAR = 100;
export const FREE_PRICE_CENTS = 0;
export const PRICE_LABEL_FRACTION_DIGITS = 2;

export type OfferingPriceItemInput = {
  /** Item price in integer CENTS. */
  priceCents?: number | null;
};

export type OfferingPriceInput = {
  /** Base price in integer CENTS (NOT dollars). */
  basePrice?: number | null;
  /** Bundled resource terms, each already priced in CENTS. */
  items?: readonly OfferingPriceItemInput[] | null;
};

export type NormalizedOfferingPrice = {
  /** Normalized base price in integer cents. */
  basePriceCents: number;
  /** What the offering charges: the item sum when bundled, else the base. */
  totalPriceCents: number;
  /** Formatted display string, or `null` for a free offering. */
  priceLabel: string | null;
};

/**
 * Coerce an untrusted cents value to a non-negative integer number of cents.
 * Non-finite, missing, and non-positive values collapse to "free" so callers
 * can compare against {@link FREE_PRICE_CENTS} to detect an unpriced offering.
 */
export function toPriceCents(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return FREE_PRICE_CENTS;
  }
  return Math.round(value);
}

/** Format integer cents as the `metadata.price` display string. */
export function formatPriceCents(cents: number): string {
  return `$${(cents / CENTS_PER_DOLLAR).toFixed(PRICE_LABEL_FRACTION_DIGITS)}`;
}

/**
 * Derive every persisted price field of an offering from one cents-denominated
 * input. Bundled offerings (`items`) price as the sum of their terms; a
 * standalone offering prices at its base.
 */
export function normalizeOfferingPrice(
  input: OfferingPriceInput,
): NormalizedOfferingPrice {
  const basePriceCents = toPriceCents(input.basePrice);
  const items = input.items ?? [];
  const totalPriceCents =
    items.length > 0
      ? items.reduce((sum, item) => sum + toPriceCents(item.priceCents), FREE_PRICE_CENTS)
      : basePriceCents;

  return {
    basePriceCents,
    totalPriceCents,
    priceLabel:
      totalPriceCents > FREE_PRICE_CENTS ? formatPriceCents(totalPriceCents) : null,
  };
}
