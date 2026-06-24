/**
 * Tests for the pure Layer-2 project-net distribution planner (EPIC J7).
 *
 * The planner turns resolved per-individual bps shares plus a net cents amount
 * into EXACT integer-cent per-recipient credits. These tests assert the money
 * invariants: amounts sum exactly to the net (recipients + org-keep), the org
 * keeps the undistributed remainder, largest-remainder rounding never over- or
 * under-credits, and corrupt/over-allocated input is rejected. All DB-free.
 */
import { describe, it, expect } from 'vitest';
import {
  planProjectNetDistribution,
  ORG_KEEP_ROLE,
} from '@/lib/net-distribution-run';
import {
  NET_ALLOCATION_FULL_PIE_BPS,
  type ResolvedNetAllocation,
} from '@/lib/net-allocation';

function resolved(
  parts: Array<{ recipientId: string; bps: number }>,
): ResolvedNetAllocation[] {
  return parts.map((p) => ({
    recipientId: p.recipientId,
    bps: p.bps,
    sourceTargetType: 'individual',
    sourceTargetId: p.recipientId,
  }));
}

describe('planProjectNetDistribution', () => {
  it('rejects a non-integer or negative net', () => {
    expect(() => planProjectNetDistribution(10.5, [])).toThrow(/non-negative integer/);
    expect(() => planProjectNetDistribution(-1, [])).toThrow(/non-negative integer/);
  });

  it('rejects resolved shares that over-allocate the full pie', () => {
    const over = resolved([
      { recipientId: 'a', bps: 6000 },
      { recipientId: 'b', bps: 5000 },
    ]);
    expect(() => planProjectNetDistribution(10000, over)).toThrow(/over-allocates/);
  });

  it('returns an empty plan for a zero net (org keeps everything)', () => {
    const plan = planProjectNetDistribution(0, resolved([{ recipientId: 'a', bps: 5000 }]));
    expect(plan.credits).toEqual([]);
    expect(plan.distributedCents).toBe(0);
    expect(plan.orgKeepCents).toBe(0);
  });

  it('returns an empty plan when no shares are resolved (empty tree result)', () => {
    const plan = planProjectNetDistribution(10000, []);
    expect(plan.credits).toEqual([]);
    expect(plan.distributedCents).toBe(0);
    // With no recipients, the org keeps the entire net.
    expect(plan.orgKeepCents).toBe(10000);
  });

  it('distributes a clean split exactly, with the org keeping the remainder', () => {
    // 50% + 25% of 10000 cents = 5000 + 2500; org keeps the other 2500 cents.
    const plan = planProjectNetDistribution(
      10000,
      resolved([
        { recipientId: 'a', bps: 5000 },
        { recipientId: 'b', bps: 2500 },
      ]),
    );

    const byId = new Map(plan.credits.map((c) => [c.recipientId, c.amountCents]));
    expect(byId.get('a')).toBe(5000);
    expect(byId.get('b')).toBe(2500);
    expect(plan.distributedCents).toBe(7500);
    expect(plan.orgKeepCents).toBe(2500);
    expect(plan.distributedCents + plan.orgKeepCents).toBe(10000);
  });

  it('credits the FULL net when shares sum to the full pie (org keeps nothing)', () => {
    const plan = planProjectNetDistribution(
      9999,
      resolved([
        { recipientId: 'a', bps: 3333 },
        { recipientId: 'b', bps: 3333 },
        { recipientId: 'c', bps: 3334 },
      ]),
    );
    expect(plan.distributedCents).toBe(9999);
    expect(plan.orgKeepCents).toBe(0);
    const total = plan.credits.reduce((s, c) => s + c.amountCents, 0);
    expect(total).toBe(9999);
  });

  it('uses largest-remainder so cents sum EXACTLY despite indivisible amounts', () => {
    // 3 recipients each 3333 bps (full pie 9999 bps), org keeps 1 bps share.
    // Net 100 cents cannot divide cleanly; the plan must still balance to 100.
    const plan = planProjectNetDistribution(
      100,
      resolved([
        { recipientId: 'a', bps: 3333 },
        { recipientId: 'b', bps: 3333 },
        { recipientId: 'c', bps: 3333 },
      ]),
    );

    const total = plan.credits.reduce((s, c) => s + c.amountCents, 0);
    expect(total + plan.orgKeepCents).toBe(100);
    expect(plan.distributedCents).toBe(total);
    // No recipient is over/under by more than one cent from the floor (3333/10000*100 = 33.33).
    for (const c of plan.credits) {
      expect(c.amountCents === 33 || c.amountCents === 34).toBe(true);
    }
  });

  it('never over- or under-credits across many odd net amounts', () => {
    const shares = resolved([
      { recipientId: 'a', bps: 1234 },
      { recipientId: 'b', bps: 4321 },
      { recipientId: 'c', bps: 2000 },
    ]); // distributes 7555 bps; org keeps 2445 bps
    for (const net of [1, 7, 13, 99, 100, 101, 9999, 10000, 123457]) {
      const plan = planProjectNetDistribution(net, shares);
      const total = plan.credits.reduce((s, c) => s + c.amountCents, 0);
      expect(plan.distributedCents).toBe(total);
      expect(plan.distributedCents + plan.orgKeepCents).toBe(net);
      // Distributed cents never exceed the net.
      expect(plan.distributedCents).toBeLessThanOrEqual(net);
      // No negative credits.
      for (const c of plan.credits) expect(c.amountCents).toBeGreaterThan(0);
    }
  });

  it('sums duplicate-resolved bps via the resolver shape and reports distributedBps', () => {
    const plan = planProjectNetDistribution(
      10000,
      resolved([
        { recipientId: 'a', bps: 1000 },
        { recipientId: 'b', bps: 2000 },
      ]),
    );
    expect(plan.distributedBps).toBe(3000);
    expect(plan.netCents).toBe(10000);
  });

  it('exposes ORG_KEEP_ROLE as a stable constant', () => {
    expect(ORG_KEEP_ROLE).toBe('distribution');
    expect(NET_ALLOCATION_FULL_PIE_BPS).toBe(10000);
  });
});
