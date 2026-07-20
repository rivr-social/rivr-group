import { describe, expect, it } from "vitest";

import { calculateCheckoutFees } from "@/lib/checkout-fees";

describe("calculateCheckoutFees — micro-transaction overhead scaling", () => {
  it("recovers Connect overhead proportionally on small carts (the $6 case)", () => {
    // Was $2.86 (~48%) under the flat $2 overhead. Now: platform 5% (30¢) +
    // scaled overhead min(200, 5% of 600 = 30¢) → gross-up to $7.11, fee $1.11.
    const fees = calculateCheckoutFees(600);
    expect(fees.connectAccountFeeEstimateCents).toBe(30);
    expect(fees.buyerTotalCents).toBe(711);
    expect(fees.buyerPlatformFeeCents).toBe(111);
    expect(fees.sellerNetCents).toBe(600);
  });

  it("caps at the flat overhead so carts ≥ $40 price exactly as before", () => {
    const fees = calculateCheckoutFees(4_000);
    expect(fees.connectAccountFeeEstimateCents).toBe(200);
    expect(fees.buyerTotalCents).toBe(Math.ceil(4_430 / (1 - 0.029)));
  });

  it("an explicit connectOverheadCents override still wins (dues pass 0)", () => {
    const fees = calculateCheckoutFees(600, { connectOverheadCents: 0 });
    expect(fees.connectAccountFeeEstimateCents).toBe(0);
  });
});
