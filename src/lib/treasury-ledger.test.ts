import { describe, expect, it } from "vitest"
import {
  classifyTreasuryLeg,
  summarizeTreasuryLegs,
  type TreasuryWalletScope,
} from "@/lib/treasury-ledger"

// A group treasury tree: the group's main wallet, one fund, one project, and a
// subgroup's settlement wallet. The scenario mirrors backlog B10: a $2 fixed
// job payout debits the PROJECT wallet, paid out to an external member.
const GROUP: TreasuryWalletScope = { walletId: "w-group", kind: "group", label: "Spirit treasury", ownerId: "a-group" }
const FUND: TreasuryWalletScope = { walletId: "w-fund", kind: "fund", label: "Operations Fund fund", ownerId: "a-group" }
const PROJECT: TreasuryWalletScope = { walletId: "w-proj", kind: "project", label: "Build Shed project", ownerId: "a-group" }
const SUBGROUP: TreasuryWalletScope = { walletId: "w-sub", kind: "subgroup", label: "Kitchen Circle treasury", ownerId: "a-sub" }

const scopeMap = new Map<string, TreasuryWalletScope>([
  [GROUP.walletId, GROUP],
  [FUND.walletId, FUND],
  [PROJECT.walletId, PROJECT],
  [SUBGROUP.walletId, SUBGROUP],
])

describe("classifyTreasuryLeg", () => {
  it("classifies a job payout OUT of the project wallet to an external member (the B10 $2)", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-proj", toWalletId: "w-external-member", amountCents: 200 },
      scopeMap,
    )
    expect(result.direction).toBe("out")
    expect(result.signedAmountCents).toBe(-200)
    expect(result.fromScope).toEqual(PROJECT)
    expect(result.toScope).toBeNull()
  })

  it("classifies an external sale INTO the group wallet as inflow", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-buyer", toWalletId: "w-group", amountCents: 5000 },
      scopeMap,
    )
    expect(result.direction).toBe("in")
    expect(result.signedAmountCents).toBe(5000)
    expect(result.fromScope).toBeNull()
    expect(result.toScope).toEqual(GROUP)
  })

  it("classifies group -> fund funding as internal (net-zero, never an expense)", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-group", toWalletId: "w-fund", amountCents: 10000 },
      scopeMap,
    )
    expect(result.direction).toBe("internal")
    expect(result.signedAmountCents).toBe(0)
    expect(result.fromScope).toEqual(GROUP)
    expect(result.toScope).toEqual(FUND)
  })

  it("classifies group -> project funding (cascade fund-down) as internal", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-group", toWalletId: "w-proj", amountCents: 2500 },
      scopeMap,
    )
    expect(result.direction).toBe("internal")
    expect(result.signedAmountCents).toBe(0)
  })

  it("treats a project_expense (null toWalletId) as an outflow", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-proj", toWalletId: null, amountCents: 750 },
      scopeMap,
    )
    expect(result.direction).toBe("out")
    expect(result.signedAmountCents).toBe(-750)
  })

  it("normalizes a negatively-signed amount to a positive gross before signing", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-proj", toWalletId: "w-external", amountCents: -200 },
      scopeMap,
    )
    expect(result.signedAmountCents).toBe(-200)
  })

  it("defensively treats a leg touching no treasury wallet as net-zero internal", () => {
    const result = classifyTreasuryLeg(
      { fromWalletId: "w-x", toWalletId: "w-y", amountCents: 999 },
      scopeMap,
    )
    expect(result.direction).toBe("internal")
    expect(result.signedAmountCents).toBe(0)
  })
})

describe("summarizeTreasuryLegs", () => {
  it("sums inflows and outflows while excluding internal moves (no double-count)", () => {
    const legs = [
      classifyTreasuryLeg({ fromWalletId: "w-buyer", toWalletId: "w-group", amountCents: 5000 }, scopeMap), // +5000 in
      classifyTreasuryLeg({ fromWalletId: "w-group", toWalletId: "w-proj", amountCents: 2500 }, scopeMap), // internal
      classifyTreasuryLeg({ fromWalletId: "w-proj", toWalletId: "w-member", amountCents: 200 }, scopeMap), // -200 out
      classifyTreasuryLeg({ fromWalletId: "w-sub", toWalletId: null, amountCents: 300 }, scopeMap), // -300 out (expense)
    ]

    const totals = summarizeTreasuryLegs(legs)
    expect(totals.inflowCents).toBe(5000)
    expect(totals.outflowCents).toBe(500)
    expect(totals.netCents).toBe(4500)
    expect(totals.internalCount).toBe(1)
  })

  it("returns zeros for an empty ledger", () => {
    const totals = summarizeTreasuryLegs([])
    expect(totals).toEqual({ inflowCents: 0, outflowCents: 0, netCents: 0, internalCount: 0 })
  })
})
