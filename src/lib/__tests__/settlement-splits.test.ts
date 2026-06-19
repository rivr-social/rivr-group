/**
 * Tests for the project-scoped settlement resolver.
 *
 * The pure split math (`parseProjectDistribution`, `clampDistributionBps`,
 * `allocateByBps`) is exercised directly. `resolveSettlementSplits` reads the
 * project resource from the database, so it runs against the real test database
 * via `withTestTransaction` (mocked `@/db` resolves to the tx-scoped instance),
 * with every row rolled back after each test.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

import { withTestTransaction } from "@/test/db";
import { createTestGroup, createTestResource } from "@/test/fixtures";
import {
  parseProjectDistribution,
  clampDistributionBps,
  allocateByBps,
  resolveSettlementSplits,
  FULL_PIE_BPS,
  type SettlementSplit,
} from "@/lib/settlement-splits";

// ---------------------------------------------------------------------------
// parseProjectDistribution
// ---------------------------------------------------------------------------

describe("parseProjectDistribution", () => {
  it("returns [] for missing or non-array distribution", () => {
    expect(parseProjectDistribution(null)).toEqual([]);
    expect(parseProjectDistribution({})).toEqual([]);
    expect(parseProjectDistribution({ distribution: "nope" })).toEqual([]);
    expect(parseProjectDistribution({ distribution: 42 })).toEqual([]);
  });

  it("keeps valid entries and floors fractional bps", () => {
    const out = parseProjectDistribution({
      distribution: [
        { recipientId: "org-1", bps: 1500.9, role: "parent_org" },
        { recipientId: "ally-1", bps: 500 },
      ],
    });
    expect(out).toEqual([
      { recipientId: "org-1", bps: 1500, role: "parent_org" },
      { recipientId: "ally-1", bps: 500, role: undefined },
    ]);
  });

  it("drops malformed entries (missing id, non-positive bps, bad shape)", () => {
    const out = parseProjectDistribution({
      distribution: [
        { recipientId: "", bps: 1000 },
        { recipientId: "ok", bps: 0 },
        { recipientId: "ok2", bps: -5 },
        { bps: 100 },
        null,
        "string",
        { recipientId: "good", bps: 250 },
      ],
    });
    expect(out).toEqual([{ recipientId: "good", bps: 250, role: undefined }]);
  });

  it("ignores unrecognized role values", () => {
    const out = parseProjectDistribution({
      distribution: [{ recipientId: "r", bps: 100, role: "seller" }],
    });
    expect(out[0].role).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clampDistributionBps
// ---------------------------------------------------------------------------

describe("clampDistributionBps", () => {
  it("passes through when total is within budget", () => {
    const entries = [
      { recipientId: "a", bps: 1000 },
      { recipientId: "b", bps: 2000 },
    ];
    expect(clampDistributionBps(entries, FULL_PIE_BPS)).toEqual(entries);
  });

  it("trims from the tail (lowest priority) when over budget", () => {
    const entries = [
      { recipientId: "a", bps: 6000 },
      { recipientId: "b", bps: 6000 },
    ];
    // Budget 10000: a keeps 6000, b is trimmed to 4000.
    expect(clampDistributionBps(entries, FULL_PIE_BPS)).toEqual([
      { recipientId: "a", bps: 6000 },
      { recipientId: "b", bps: 4000 },
    ]);
  });

  it("drops entries entirely once budget is exhausted", () => {
    const entries = [
      { recipientId: "a", bps: 10000 },
      { recipientId: "b", bps: 5000 },
    ];
    expect(clampDistributionBps(entries, FULL_PIE_BPS)).toEqual([
      { recipientId: "a", bps: 10000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// allocateByBps
// ---------------------------------------------------------------------------

function split(bps: number, owner = "x"): SettlementSplit {
  return { walletKind: "agent", ownerAgentId: owner, role: "seller", bps };
}

describe("allocateByBps", () => {
  it("allocates the full amount to a single 100% split", () => {
    const out = allocateByBps(12345, [split(FULL_PIE_BPS)]);
    expect(out[0].amountCents).toBe(12345);
  });

  it("sums EXACTLY to the total with no rounding leakage", () => {
    // 100 cents split 1/3 + 1/3 + 1/3 → 33,33,34 (largest remainders win).
    const out = allocateByBps(100, [
      split(3333, "a"),
      split(3333, "b"),
      split(3334, "c"),
    ]);
    const sum = out.reduce((s, o) => s + o.amountCents, 0);
    expect(sum).toBe(100);
    expect(out.map((o) => o.amountCents)).toEqual([33, 33, 34]);
  });

  it("hands leftover cents to the largest fractional remainders first", () => {
    // 10 cents over 7000/3000 → 7,3 exactly (no leftover).
    expect(
      allocateByBps(10, [split(7000, "a"), split(3000, "b")]).map(
        (o) => o.amountCents,
      ),
    ).toEqual([7, 3]);

    // 1 cent over 5000/5000 → leftover goes to the first (stable by index).
    expect(
      allocateByBps(1, [split(5000, "a"), split(5000, "b")]).map(
        (o) => o.amountCents,
      ),
    ).toEqual([1, 0]);
  });

  it("returns zero-amount entries for zero-cent totals", () => {
    const out = allocateByBps(0, [split(5000, "a"), split(5000, "b")]);
    expect(out.map((o) => o.amountCents)).toEqual([0, 0]);
  });

  it("throws when bps do not sum to the full pie", () => {
    expect(() => allocateByBps(100, [split(5000)])).toThrow(/sum to 10000/);
    expect(() =>
      allocateByBps(100, [split(6000, "a"), split(6000, "b")]),
    ).toThrow(/sum to 10000/);
  });

  it("rejects negative or non-integer totals", () => {
    expect(() => allocateByBps(-1, [split(FULL_PIE_BPS)])).toThrow();
    expect(() => allocateByBps(1.5, [split(FULL_PIE_BPS)])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveSettlementSplits (integration — real test DB)
// ---------------------------------------------------------------------------

describe("resolveSettlementSplits", () => {
  it("credits the seller 100% when the offering has no projectId", () =>
    withTestTransaction(async (db) => {
      const seller = await createTestGroup(db);
      const splits = await resolveSettlementSplits({
        sellerId: seller.id,
        listingMeta: {},
      });
      expect(splits).toEqual([
        {
          walletKind: "agent",
          ownerAgentId: seller.id,
          role: "seller",
          bps: FULL_PIE_BPS,
        },
      ]);
    }));

  it("falls back to the seller when projectId is not a project resource", () =>
    withTestTransaction(async (db) => {
      const seller = await createTestGroup(db);
      const notAProject = await createTestResource(db, seller.id, {
        type: "document",
      });
      const splits = await resolveSettlementSplits({
        sellerId: seller.id,
        listingMeta: { projectId: notAProject.id },
      });
      expect(splits).toEqual([
        expect.objectContaining({ role: "seller", bps: FULL_PIE_BPS }),
      ]);
    }));

  it("credits the project treasury 100% when there is no distribution", () =>
    withTestTransaction(async (db) => {
      const org = await createTestGroup(db);
      const seller = await createTestGroup(db);
      const project = await createTestResource(db, org.id, {
        type: "project",
        metadata: {},
      });
      const splits = await resolveSettlementSplits({
        sellerId: seller.id,
        listingMeta: { projectId: project.id },
      });
      expect(splits).toEqual([
        {
          walletKind: "project",
          ownerAgentId: org.id,
          projectResourceId: project.id,
          role: "project",
          bps: FULL_PIE_BPS,
        },
      ]);
    }));

  it("splits keep + downstream distribution, dropping self/seller/buyer", () =>
    withTestTransaction(async (db) => {
      const org = await createTestGroup(db);
      const parent = await createTestGroup(db);
      const ally = await createTestGroup(db);
      const seller = await createTestGroup(db);
      const buyer = await createTestGroup(db);
      const project = await createTestResource(db, org.id, {
        type: "project",
        metadata: {
          distribution: [
            { recipientId: parent.id, bps: 2000, role: "parent_org" },
            { recipientId: ally.id, bps: 1000, role: "ally" },
            // self-reference (project owner) — must be dropped
            { recipientId: org.id, bps: 5000 },
            // seller and buyer — must be dropped
            { recipientId: seller.id, bps: 500 },
            { recipientId: buyer.id, bps: 500 },
          ],
        },
      });

      const splits = await resolveSettlementSplits({
        sellerId: seller.id,
        buyerId: buyer.id,
        listingMeta: { projectId: project.id },
      });

      // keep = 10000 - (2000 + 1000) = 7000
      expect(splits).toEqual([
        {
          walletKind: "project",
          ownerAgentId: org.id,
          projectResourceId: project.id,
          role: "project",
          bps: 7000,
        },
        {
          walletKind: "agent",
          ownerAgentId: parent.id,
          role: "parent_org",
          bps: 2000,
        },
        { walletKind: "agent", ownerAgentId: ally.id, role: "ally", bps: 1000 },
      ]);
      // Sanity: total is always the full pie so allocateByBps accepts it.
      expect(splits.reduce((s, x) => s + x.bps, 0)).toBe(FULL_PIE_BPS);
    }));

  it("clamps an over-allocated distribution and leaves no project keep", () =>
    withTestTransaction(async (db) => {
      const org = await createTestGroup(db);
      const parent = await createTestGroup(db);
      const ally = await createTestGroup(db);
      const seller = await createTestGroup(db);
      const project = await createTestResource(db, org.id, {
        type: "project",
        metadata: {
          distribution: [
            { recipientId: parent.id, bps: 8000, role: "parent_org" },
            { recipientId: ally.id, bps: 5000, role: "ally" },
          ],
        },
      });

      const splits = await resolveSettlementSplits({
        sellerId: seller.id,
        listingMeta: { projectId: project.id },
      });

      // parent keeps 8000, ally trimmed to 2000, project keep = 0 (omitted).
      expect(splits).toEqual([
        {
          walletKind: "agent",
          ownerAgentId: parent.id,
          role: "parent_org",
          bps: 8000,
        },
        { walletKind: "agent", ownerAgentId: ally.id, role: "ally", bps: 2000 },
      ]);
      expect(splits.reduce((s, x) => s + x.bps, 0)).toBe(FULL_PIE_BPS);
    }));
});
