import { describe, it, expect } from "vitest";

import {
  FREE_PRICE_CENTS,
  formatPriceCents,
  normalizeOfferingPrice,
  toPriceCents,
} from "@/lib/offering-pricing";
import { dollarsToCents } from "@/app/actions/resource-creation/types";

/**
 * The offering form (`create-offering-form.tsx`) turns the typed price string
 * into integer cents before it ever reaches the action:
 *   `Math.round(parseFloat(raw) * 100)`
 * Reproduce that exactly here so the test covers the real writer chain rather
 * than a hand-picked number.
 */
const formPriceInputToCents = (raw: string): number =>
  Math.round(parseFloat(raw) * 100);

describe("offering price normalization", () => {
  describe("normalizeOfferingPrice", () => {
    // ── Regression: the P1 money defect ──────────────────────────────────────
    // A Service offering created with price input "15" stored
    // basePrice/totalPriceCents 150000 and price "$1500.00" because a
    // dollars→cents conversion ran on a value that was already cents. The
    // purchase page divided basePrice by 100 while checkout charged
    // totalPriceCents, so display and charge disagreed by 100x.
    it("stores $15 as 1500 cents with a matching '$15.00' label (no double x100)", () => {
      const basePrice = formPriceInputToCents("15");
      expect(basePrice).toBe(1500);

      const result = normalizeOfferingPrice({ basePrice });

      expect(result.basePriceCents).toBe(1500);
      expect(result.totalPriceCents).toBe(1500);
      expect(result.priceLabel).toBe("$15.00");
      // The exact defect signature, asserted so it cannot silently return.
      expect(result.totalPriceCents).not.toBe(150000);
      expect(result.priceLabel).not.toBe("$1500.00");
    });

    it("keeps the charged total, the stored base, and the label in agreement", () => {
      for (const raw of ["15", "15.99", "0.01", "1250", "7.5"]) {
        const basePrice = formPriceInputToCents(raw);
        const result = normalizeOfferingPrice({ basePrice });

        expect(result.basePriceCents).toBe(basePrice);
        expect(result.totalPriceCents).toBe(basePrice);
        expect(result.priceLabel).toBe(
          `$${(basePrice / 100).toFixed(2)}`,
        );
      }
    });

    it("prices a bundled offering as the sum of its item cents", () => {
      const result = normalizeOfferingPrice({
        basePrice: 1500,
        items: [{ priceCents: 1000 }, { priceCents: 250 }],
      });

      // Items win over the base price for the charged total.
      expect(result.totalPriceCents).toBe(1250);
      expect(result.priceLabel).toBe("$12.50");
      expect(result.basePriceCents).toBe(1500);
    });

    it("returns a null label for a free offering", () => {
      expect(normalizeOfferingPrice({}).priceLabel).toBeNull();
      expect(normalizeOfferingPrice({ basePrice: 0 }).priceLabel).toBeNull();
      expect(normalizeOfferingPrice({}).totalPriceCents).toBe(FREE_PRICE_CENTS);
    });

    it("ignores unpriced bundled terms without dropping the priced ones", () => {
      const result = normalizeOfferingPrice({
        items: [{ priceCents: 500 }, { priceCents: null }, {}],
      });

      expect(result.totalPriceCents).toBe(500);
      expect(result.priceLabel).toBe("$5.00");
    });
  });

  describe("toPriceCents", () => {
    it("rounds to whole cents and floors invalid input at free", () => {
      expect(toPriceCents(1500)).toBe(1500);
      expect(toPriceCents(1500.4)).toBe(1500);
      expect(toPriceCents(1500.6)).toBe(1501);
      expect(toPriceCents(0)).toBe(FREE_PRICE_CENTS);
      expect(toPriceCents(-100)).toBe(FREE_PRICE_CENTS);
      expect(toPriceCents(Number.NaN)).toBe(FREE_PRICE_CENTS);
      expect(toPriceCents(undefined)).toBe(FREE_PRICE_CENTS);
      expect(toPriceCents(null)).toBe(FREE_PRICE_CENTS);
    });
  });

  describe("formatPriceCents", () => {
    it("formats integer cents as a two-decimal dollar string", () => {
      expect(formatPriceCents(1500)).toBe("$15.00");
      expect(formatPriceCents(1599)).toBe("$15.99");
      expect(formatPriceCents(1)).toBe("$0.01");
    });
  });

  describe("dollar-denominated boundaries", () => {
    // The MCP agent tool (`rivr.offerings.create`) documents its `basePrice` in
    // DOLLARS, so it — and only it — converts before calling the action.
    it("converts a dollars-in MCP argument to the same cents the form emits", () => {
      const fromMcpTool = dollarsToCents(15);
      const fromForm = formPriceInputToCents("15");

      expect(fromMcpTool).toBe(fromForm);
      expect(normalizeOfferingPrice({ basePrice: fromMcpTool }).priceLabel).toBe(
        "$15.00",
      );
    });
  });
});
