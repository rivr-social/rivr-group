import { describe, expect, it } from "vitest"
import {
  TREASURY_CSV_HEADER,
  buildTreasuryCsvRows,
  classifyTreasuryLeg,
  resolveVisibleTreasuryWalletIds,
  summarizeTreasuryLegs,
  toCsvText,
  type TreasuryCsvEntry,
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

// ---------------------------------------------------------------------------
// Audit T1-1 (P1, member-facing): one group must report ONE P&L.
//
// The defect: the member's truncated wallet list doubled as the
// internal/external predicate, so a group -> fund transfer looked EXTERNAL to a
// member (revenue on the way in, expense on the way out) and internal to an
// admin. On MAB in July 2026 the same month read +$1.21 to the admin and
// -$41.15 to the member — a sign-flipped statement on the only financial
// surface non-admins can see.
// ---------------------------------------------------------------------------

const TREE: TreasuryWalletScope[] = [GROUP, FUND, PROJECT, SUBGROUP]

/** The audit's July window on MAB: two external legs, five internal moves. */
const JULY_LEGS = [
  { fromWalletId: "w-buyer", toWalletId: "w-group", amountCents: 3471 },
  { fromWalletId: "w-group", toWalletId: "w-vendor", amountCents: 3350 },
  { fromWalletId: "w-group", toWalletId: "w-proj", amountCents: 700 },
  { fromWalletId: "w-proj", toWalletId: "w-group", amountCents: 800 },
  { fromWalletId: "w-group", toWalletId: "w-fund", amountCents: 100 },
  { fromWalletId: "w-fund", toWalletId: "w-group", amountCents: 234 },
  { fromWalletId: "w-group", toWalletId: "w-sub", amountCents: 175 },
]

const totalsFor = (scopes: readonly TreasuryWalletScope[]) =>
  summarizeTreasuryLegs(
    JULY_LEGS.map((leg) =>
      classifyTreasuryLeg(leg, new Map(scopes.map((scope) => [scope.walletId, scope]))),
    ),
  )

describe("one group, one P&L (audit T1-1)", () => {
  it("counts only external legs when classifying against the full tree", () => {
    const totals = totalsFor(TREE)
    expect(totals.inflowCents).toBe(3471)
    expect(totals.outflowCents).toBe(3350)
    expect(totals.netCents).toBe(121)
    expect(totals.internalCount).toBe(5)
  })

  it("reproduces the DEFECT when the scope map is truncated to a member's visible wallet", () => {
    const totals = totalsFor([GROUP])
    // Internal plumbing gets booked as real activity on BOTH sides: every
    // inbound internal leg inflates revenue and every outbound one inflates
    // expenses, so the statement no longer describes the group's actual
    // trading. (On MAB's real July data the distortion was large enough to flip
    // the sign, +$1.21 -> -$41.15; the exact magnitude depends on the month's
    // mix of internal moves, so what this pins is the DIVERGENCE.)
    expect(totals.inflowCents).toBe(3471 + 800 + 234)
    expect(totals.outflowCents).toBe(3350 + 700 + 100 + 175)
    expect(totals.internalCount).toBe(0)
    expect(totals.netCents).not.toBe(121)
  })

  it("agrees between the member and admin lanes now that both classify against the tree", () => {
    expect(totalsFor(TREE)).toEqual(totalsFor(TREE))
    expect(totalsFor(TREE).netCents).toBe(121)
  })
})

describe("resolveVisibleTreasuryWalletIds", () => {
  it("gives a manager every wallet in the tree", () => {
    expect(resolveVisibleTreasuryWalletIds(TREE, true)).toEqual([
      "w-group",
      "w-fund",
      "w-proj",
      "w-sub",
    ])
  })

  it("limits a member to the group's own settlement-wallet rows", () => {
    expect(resolveVisibleTreasuryWalletIds(TREE, false)).toEqual(["w-group"])
  })

  it("is a ROW-visibility decision only — it must never be reused as the classification set", () => {
    const visible = resolveVisibleTreasuryWalletIds(TREE, false)
    expect(visible.length).toBeLessThan(TREE.length)
    // Classifying against the visible subset is precisely the defect above.
    const visibleScopes = TREE.filter((scope) => visible.includes(scope.walletId))
    expect(totalsFor(visibleScopes).netCents).not.toBe(totalsFor(TREE).netCents)
  })

  it("returns an empty list when the tree carries no group settlement wallet", () => {
    expect(resolveVisibleTreasuryWalletIds([FUND, PROJECT], false)).toEqual([])
  })
})

describe("treasury CSV export (audit T1-2)", () => {
  const INTERNAL: TreasuryCsvEntry = {
    createdAt: "2026-07-15T12:00:00.000Z",
    type: "p2p_transfer",
    description: 'Fund "Logistics" allocation',
    direction: "internal",
    scopeLabel: "MAB treasury",
    counterpartyLabel: "Logistics Fund",
    grossAmountCents: 500,
    signedAmountCents: 0,
    status: "completed",
  }
  const SALE: TreasuryCsvEntry = {
    createdAt: "2026-07-16T12:00:00.000Z",
    type: "marketplace_purchase",
    description: null,
    direction: "in",
    scopeLabel: "MAB treasury",
    counterpartyLabel: null,
    grossAmountCents: 1234,
    signedAmountCents: 1234,
    status: "completed",
  }

  it("exports the GROSS amount for an internal leg instead of 0.00", () => {
    const rows = buildTreasuryCsvRows([INTERNAL])
    const amountCol = TREASURY_CSV_HEADER.indexOf("Amount (USD)")
    const effectCol = TREASURY_CSV_HEADER.indexOf("Treasury effect (USD)")
    expect(rows[1][amountCol]).toBe("5.00")
    expect(rows[1][amountCol]).not.toBe("0.00")
    expect(rows[1][effectCol]).toBe("0.00") // net-zero to the treasury, disclosed via Direction
  })

  it("keeps gross and signed equal for an external inflow, cents-exact", () => {
    const rows = buildTreasuryCsvRows([SALE])
    expect(rows[1]).toContain("12.34")
    expect(rows[1][TREASURY_CSV_HEADER.indexOf("Direction")]).toBe("in")
  })

  it("emits the header as the first row and one row per entry", () => {
    const rows = buildTreasuryCsvRows([INTERNAL, SALE])
    expect(rows[0]).toEqual([...TREASURY_CSV_HEADER])
    expect(rows).toHaveLength(3)
  })

  it("blanks null description and counterparty", () => {
    const rows = buildTreasuryCsvRows([SALE])
    expect(rows[1][TREASURY_CSV_HEADER.indexOf("Description")]).toBe("")
    expect(rows[1][TREASURY_CSV_HEADER.indexOf("Counterparty")]).toBe("")
  })

  it("quotes every cell and doubles embedded quotes in CSV text", () => {
    const text = toCsvText(buildTreasuryCsvRows([INTERNAL]))
    expect(text).toContain('"Fund ""Logistics"" allocation"')
    expect(text.split("\n")[0].startsWith('"Date","Type"')).toBe(true)
  })
})
