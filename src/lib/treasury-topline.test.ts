import { describe, expect, it } from "vitest"
import { computeTreasuryTopline } from "@/lib/treasury-topline"

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)

describe("computeTreasuryTopline", () => {
  it("sums unallocated + fund balances + Connect available (the open-issues 07-07/07-08 fix)", () => {
    // Bob's MAB scenario: $18 unallocated after a $20 fund move + a $12 payout,
    // plus $20 still parked in a fund and no Connect account.
    const result = computeTreasuryTopline(
      { balanceDollars: 18, hasConnectAccount: false, connectAvailableCents: null },
      2000, // $20 in funds
      formatCurrency
    )

    expect(result.totalDollars).toBe(38)
    expect(result.breakdown).toEqual(["Treasury: $18.00", "Funds: $20.00"])
  })

  it("omits the Funds line entirely when no fund holds a balance", () => {
    const result = computeTreasuryTopline(
      { balanceDollars: 50, hasConnectAccount: false, connectAvailableCents: null },
      0,
      formatCurrency
    )

    expect(result.totalDollars).toBe(50)
    expect(result.breakdown).toEqual(["Treasury: $50.00"])
  })

  it("adds Connect available balance when a Connect account is linked", () => {
    const result = computeTreasuryTopline(
      { balanceDollars: 10, hasConnectAccount: true, connectAvailableCents: 500 },
      0,
      formatCurrency
    )

    expect(result.totalDollars).toBe(15)
    expect(result.breakdown).toEqual(["Treasury: $10.00", "Sales: $5.00"])
  })

  it("combines unallocated, funds, and Connect available together", () => {
    const result = computeTreasuryTopline(
      { balanceDollars: 30, hasConnectAccount: true, connectAvailableCents: 1250 },
      4500,
      formatCurrency
    )

    expect(result.totalDollars).toBe(30 + 45 + 12.5)
    expect(result.breakdown).toEqual(["Treasury: $30.00", "Funds: $45.00", "Sales: $12.50"])
  })

  it("ignores a null connectAvailableCents when hasConnectAccount is true (no throw, treated as zero)", () => {
    const result = computeTreasuryTopline(
      { balanceDollars: 5, hasConnectAccount: true, connectAvailableCents: null },
      0,
      formatCurrency
    )

    expect(result.totalDollars).toBe(5)
    expect(result.breakdown).toEqual(["Treasury: $5.00", "Sales: $0.00"])
  })
})
