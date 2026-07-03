/**
 * Tests for the pure org net %-allocation tree logic (EPIC J7): parsing stored
 * trees, validating against the full pie, and resolving class/individual rules
 * into exact-sum per-individual bps shares. All DB-free, tested directly.
 */
import { describe, it, expect } from 'vitest';
import {
  NET_ALLOCATION_FULL_PIE_BPS,
  parseNetAllocationTree,
  validateNetAllocationTree,
  resolveNetAllocation,
  type NetAllocationTree,
} from '@/lib/net-allocation';

describe('parseNetAllocationTree', () => {
  it('returns an empty tree for missing/non-object metadata', () => {
    expect(parseNetAllocationTree(null)).toEqual({ rules: [] });
    expect(parseNetAllocationTree({})).toEqual({ rules: [] });
    expect(parseNetAllocationTree({ netAllocation: 'x' })).toEqual({ rules: [] });
    expect(parseNetAllocationTree({ netAllocation: { rules: 'x' } })).toEqual({
      rules: [],
    });
  });

  it('parses well-formed class and individual rules, flooring bps', () => {
    const tree = parseNetAllocationTree({
      netAllocation: {
        rules: [
          { targetType: 'class', targetId: 'host', bps: 1500.9, label: 'Hosts' },
          { targetType: 'individual', targetId: 'agent-1', bps: 500 },
        ],
      },
    });
    expect(tree.rules).toEqual([
      { targetType: 'class', targetId: 'host', bps: 1500, label: 'Hosts' },
      { targetType: 'individual', targetId: 'agent-1', bps: 500, label: undefined },
    ]);
  });

  it('drops malformed rules (bad type, empty id, non-positive bps)', () => {
    const tree = parseNetAllocationTree({
      netAllocation: {
        rules: [
          { targetType: 'class', targetId: 'good', bps: 100 },
          { targetType: 'region', targetId: 'x', bps: 100 }, // bad type
          { targetType: 'individual', targetId: '', bps: 100 }, // empty id
          { targetType: 'individual', targetId: 'z', bps: 0 }, // zero bps
          { targetType: 'class', targetId: 'n', bps: -50 }, // negative
          'garbage',
        ],
      },
    });
    expect(tree.rules).toEqual([
      { targetType: 'class', targetId: 'good', bps: 100, label: undefined },
    ]);
  });
});

describe('validateNetAllocationTree', () => {
  it('accepts a tree summing below the full pie (org keeps remainder)', () => {
    const tree: NetAllocationTree = {
      rules: [
        { targetType: 'class', targetId: 'host', bps: 3000 },
        { targetType: 'individual', targetId: 'a', bps: 2000 },
      ],
    };
    expect(validateNetAllocationTree(tree)).toEqual({ valid: true, totalBps: 5000 });
  });

  it('accepts a tree summing to exactly the full pie', () => {
    const tree: NetAllocationTree = {
      rules: [{ targetType: 'class', targetId: 'all', bps: NET_ALLOCATION_FULL_PIE_BPS }],
    };
    expect(validateNetAllocationTree(tree)).toEqual({
      valid: true,
      totalBps: NET_ALLOCATION_FULL_PIE_BPS,
    });
  });

  it('rejects over-allocation beyond the full pie', () => {
    const tree: NetAllocationTree = {
      rules: [
        { targetType: 'class', targetId: 'a', bps: 6000 },
        { targetType: 'class', targetId: 'b', bps: 5000 },
      ],
    };
    const result = validateNetAllocationTree(tree);
    expect(result.valid).toBe(false);
    expect(result.totalBps).toBe(11000);
  });
});

describe('resolveNetAllocation', () => {
  it('passes individual rules straight through', () => {
    const tree: NetAllocationTree = {
      rules: [
        { targetType: 'individual', targetId: 'a', bps: 1000 },
        { targetType: 'individual', targetId: 'b', bps: 500 },
      ],
    };
    const resolved = resolveNetAllocation(tree, new Map());
    expect(resolved).toEqual([
      { recipientId: 'a', bps: 1000, sourceTargetType: 'individual', sourceTargetId: 'a' },
      { recipientId: 'b', bps: 500, sourceTargetType: 'individual', sourceTargetId: 'b' },
    ]);
  });

  it('splits a class rule equally with exact-sum largest-remainder rounding', () => {
    const tree: NetAllocationTree = {
      rules: [{ targetType: 'class', targetId: 'host', bps: 1000 }],
    };
    const members = new Map([['host', ['m1', 'm2', 'm3']]]);
    const resolved = resolveNetAllocation(tree, members);
    // 1000 / 3 = 334, 333, 333 (first gets the remainder)
    expect(resolved.map((r) => r.bps)).toEqual([334, 333, 333]);
    expect(resolved.reduce((s, r) => s + r.bps, 0)).toBe(1000);
    expect(resolved.map((r) => r.recipientId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('contributes nothing for an empty class (share stays with the org)', () => {
    const tree: NetAllocationTree = {
      rules: [
        { targetType: 'class', targetId: 'empty', bps: 4000 },
        { targetType: 'individual', targetId: 'a', bps: 1000 },
      ],
    };
    const resolved = resolveNetAllocation(tree, new Map([['empty', []]]));
    expect(resolved).toEqual([
      { recipientId: 'a', bps: 1000, sourceTargetType: 'individual', sourceTargetId: 'a' },
    ]);
  });

  it('sums shares for a recipient appearing in both a class and an individual rule', () => {
    const tree: NetAllocationTree = {
      rules: [
        { targetType: 'class', targetId: 'host', bps: 1000 },
        { targetType: 'individual', targetId: 'm1', bps: 500 },
      ],
    };
    const members = new Map([['host', ['m1', 'm2']]]);
    const resolved = resolveNetAllocation(tree, members);
    const m1 = resolved.find((r) => r.recipientId === 'm1');
    // m1 gets 500 from the class split (1000/2) plus 500 individual = 1000
    expect(m1?.bps).toBe(1000);
    expect(resolved.reduce((s, r) => s + r.bps, 0)).toBe(1500);
  });

  it('returns [] for an empty tree', () => {
    expect(resolveNetAllocation({ rules: [] }, new Map())).toEqual([]);
  });
});

describe('resolveNetAllocation — points-weighted class splits', () => {
  const tree: NetAllocationTree = {
    rules: [{ targetType: 'class', targetId: 'host', bps: 1000 }],
  };
  const members = new Map([['host', ['m1', 'm2', 'm3']]]);

  it('splits a class proportionally to member points', () => {
    const weights = new Map([
      ['m1', 60],
      ['m2', 30],
      ['m3', 10],
    ]);
    const resolved = resolveNetAllocation(tree, members, weights);
    expect(resolved.map((r) => [r.recipientId, r.bps])).toEqual([
      ['m1', 600],
      ['m2', 300],
      ['m3', 100],
    ]);
  });

  it('rounds proportional shares to an exact sum (largest remainder)', () => {
    const weights = new Map([
      ['m1', 1],
      ['m2', 1],
      ['m3', 1],
    ]);
    const resolved = resolveNetAllocation(tree, members, weights);
    expect(resolved.map((r) => r.bps)).toEqual([334, 333, 333]);
    expect(resolved.reduce((sum, r) => sum + r.bps, 0)).toBe(1000);
  });

  it('gives zero-weight members nothing, including remainder bps', () => {
    const weights = new Map([
      ['m1', 2],
      ['m2', 1],
      // m3 has earned no points
    ]);
    const resolved = resolveNetAllocation(tree, members, weights);
    const byId = new Map(resolved.map((r) => [r.recipientId, r.bps]));
    expect(byId.get('m1')).toBe(667);
    expect(byId.get('m2')).toBe(333);
    // Zero-share recipients are omitted from the resolved list entirely
    // (same convention as the distribution planner's credit omission).
    expect(byId.has('m3')).toBe(false);
    expect(resolved.reduce((sum, r) => sum + r.bps, 0)).toBe(1000);
  });

  it('falls back to an equal split when no member of the class holds points', () => {
    const resolved = resolveNetAllocation(tree, members, new Map());
    expect(resolved.map((r) => r.bps)).toEqual([334, 333, 333]);
  });

  it('ignores non-finite and negative weights', () => {
    const weights = new Map([
      ['m1', Number.NaN],
      ['m2', -50],
      ['m3', 10],
    ]);
    const resolved = resolveNetAllocation(tree, members, weights);
    const byId = new Map(resolved.map((r) => [r.recipientId, r.bps]));
    expect(byId.has('m1')).toBe(false);
    expect(byId.has('m2')).toBe(false);
    expect(byId.get('m3')).toBe(1000);
  });

  it('weights only affect class splits — individual rules pass through unchanged', () => {
    const mixed: NetAllocationTree = {
      rules: [
        { targetType: 'individual', targetId: 'solo', bps: 500 },
        { targetType: 'class', targetId: 'host', bps: 1000 },
      ],
    };
    const weights = new Map([['m1', 5]]);
    const resolved = resolveNetAllocation(mixed, members, weights);
    const byId = new Map(resolved.map((r) => [r.recipientId, r.bps]));
    expect(byId.get('solo')).toBe(500);
    expect(byId.get('m1')).toBe(1000);
    expect(byId.has('m2')).toBe(false);
    expect(byId.has('m3')).toBe(false);
  });
});
