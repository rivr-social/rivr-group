/**
 * @fileoverview Unit tests for `buildAutomaticTax` — the Checkout-Session tax
 * config. Locks that automatic tax is enabled and that the marketplace-facilitator
 * liability posture is applied ONLY on the Connect (destination-charge) rail.
 */
import { describe, expect, it } from "vitest";
import {
  buildAutomaticTax,
  RIVR_TAX_BEHAVIOR,
  STRIPE_TAX_CODE_DEFAULT,
  STRIPE_TAX_CODE_GENERAL_GOODS,
  taxCodeForListingMetadata,
} from "@/lib/stripe-tax";

describe("buildAutomaticTax", () => {
  it("enables automatic tax with no liability override by default", () => {
    const cfg = buildAutomaticTax();
    expect(cfg.enabled).toBe(true);
    expect(cfg.liability).toBeUndefined();
  });

  it("marks RIVR (the platform) liable on the Connect rail", () => {
    const cfg = buildAutomaticTax({ platformLiable: true });
    expect(cfg.enabled).toBe(true);
    expect(cfg.liability).toEqual({ type: "self" });
  });

  it("omits the liability override when platformLiable is false", () => {
    const cfg = buildAutomaticTax({ platformLiable: false });
    expect(cfg.liability).toBeUndefined();
  });

  it("prices tax on top of the listed amount (exclusive behavior)", () => {
    expect(RIVR_TAX_BEHAVIOR).toBe("exclusive");
  });
});

describe("taxCodeForListingMetadata", () => {
  it("codes an explicit product listing as tangible goods", () => {
    expect(taxCodeForListingMetadata({ listingType: "product" })).toBe(
      STRIPE_TAX_CODE_GENERAL_GOODS,
    );
  });

  it("keeps event tickets in product clothing on the services code", () => {
    expect(
      taxCodeForListingMetadata({ listingType: "product", productKind: "ticket" }),
    ).toBe(STRIPE_TAX_CODE_DEFAULT);
    expect(
      taxCodeForListingMetadata({ listingType: "product", offeringType: "Ticket" }),
    ).toBe(STRIPE_TAX_CODE_DEFAULT);
  });

  it("keeps services, vouchers, and other listing types on the services code", () => {
    expect(taxCodeForListingMetadata({ listingType: "service" })).toBe(
      STRIPE_TAX_CODE_DEFAULT,
    );
    expect(taxCodeForListingMetadata({ listingType: "voucher" })).toBe(
      STRIPE_TAX_CODE_DEFAULT,
    );
  });

  it("treats a missing listingType as services (under-collect, never over-charge)", () => {
    expect(taxCodeForListingMetadata({})).toBe(STRIPE_TAX_CODE_DEFAULT);
  });
});
