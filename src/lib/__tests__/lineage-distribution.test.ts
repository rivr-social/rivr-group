/**
 * Tests for the directed referral-lineage distribution resolver (EPIC J6/J8).
 *
 * Pure parsing (`parseLineageConfig`) is exercised directly. The graph-walking
 * functions (`getProjectAncestorChain`, `getVerifiedCoalliedGroups`,
 * `resolveLineageDistribution`) read agents + ledger from the test database via
 * `withTestTransaction` (mocked `@/db`), with every row rolled back per test.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', async () => {
  const { getTestDbModule } = await import('@/test/db');
  return getTestDbModule();
});

import { withTestTransaction } from '@/test/db';
import { createTestGroup } from '@/test/fixtures';
import {
  parseLineageConfig,
  getProjectAncestorChain,
  getVerifiedCoalliedGroups,
  resolveLineageDistribution,
  COALLIED_RELATIONSHIP_TYPES,
} from '@/lib/lineage-distribution';
import { ledger } from '@/db/schema';

// ---------------------------------------------------------------------------
// parseLineageConfig
// ---------------------------------------------------------------------------

describe('parseLineageConfig', () => {
  it('returns disabled for missing/non-object lineage metadata', () => {
    expect(parseLineageConfig(null)).toEqual({ enabled: false });
    expect(parseLineageConfig({})).toEqual({ enabled: false });
    expect(parseLineageConfig({ lineage: 'nope' })).toEqual({ enabled: false });
    expect(parseLineageConfig({ lineage: 42 })).toEqual({ enabled: false });
  });

  it('parses enabled flag, levelBps, and coallied entries', () => {
    const config = parseLineageConfig({
      lineage: {
        enabled: true,
        levelBps: [1000, 500, 0],
        coallied: [{ agentId: 'a1', bps: 300 }],
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.levelBps).toEqual([1000, 500, 0]);
    expect(config.coallied).toEqual([{ agentId: 'a1', bps: 300 }]);
  });

  it('floors fractional level bps and zeroes invalid/negative ones', () => {
    const config = parseLineageConfig({
      lineage: { enabled: true, levelBps: [1000.9, -5, 'x' as unknown as number] },
    });
    expect(config.levelBps).toEqual([1000, 0, 0]);
  });

  it('drops malformed coallied entries (missing id or non-positive bps)', () => {
    const config = parseLineageConfig({
      lineage: {
        enabled: true,
        coallied: [
          { agentId: 'good', bps: 200 },
          { agentId: '', bps: 100 },
          { agentId: 'zero', bps: 0 },
          { bps: 100 },
          'garbage',
        ],
      },
    });
    expect(config.coallied).toEqual([{ agentId: 'good', bps: 200 }]);
  });

  it('treats enabled !== true as disabled', () => {
    expect(parseLineageConfig({ lineage: { enabled: 'yes' } }).enabled).toBe(false);
    expect(parseLineageConfig({ lineage: { enabled: 1 } }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProjectAncestorChain
// ---------------------------------------------------------------------------

describe('getProjectAncestorChain', () => {
  it('returns ancestors nearest-first, excluding the owner itself', () =>
    withTestTransaction(async (db) => {
      const grandparent = await createTestGroup(db, { name: 'GP' });
      const parent = await createTestGroup(db, { name: 'P', parentId: grandparent.id });
      const child = await createTestGroup(db, { name: 'C', parentId: parent.id });

      const chain = await getProjectAncestorChain(child.id);
      expect(chain).toEqual([parent.id, grandparent.id]);
    }));

  it('returns [] for a root group with no parent', () =>
    withTestTransaction(async (db) => {
      const root = await createTestGroup(db);
      const chain = await getProjectAncestorChain(root.id);
      expect(chain).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------
// getVerifiedCoalliedGroups
// ---------------------------------------------------------------------------

describe('getVerifiedCoalliedGroups', () => {
  it('returns [] when no ids are opted in', () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const verified = await getVerifiedCoalliedGroups(group.id, []);
      expect(verified.size).toBe(0);
    }));

  it('verifies an opted-in coalition edge in either direction', () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const allyOutbound = await createTestGroup(db);
      const allyInbound = await createTestGroup(db);
      const notOptedIn = await createTestGroup(db);

      // group -> allyOutbound (coalition)
      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: group.id,
        objectId: allyOutbound.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'coalition' },
      });
      // allyInbound -> group (affiliate)
      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: allyInbound.id,
        objectId: group.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'affiliate' },
      });
      // group -> notOptedIn (partner) but not in the opted-in set
      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: group.id,
        objectId: notOptedIn.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'partner' },
      });

      const verified = await getVerifiedCoalliedGroups(group.id, [
        allyOutbound.id,
        allyInbound.id,
      ]);
      expect(verified.has(allyOutbound.id)).toBe(true);
      expect(verified.has(allyInbound.id)).toBe(true);
      expect(verified.has(notOptedIn.id)).toBe(false);
    }));

  it('ignores non-coallied relationship types and inactive edges', () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const subgroup = await createTestGroup(db);
      const inactiveAlly = await createTestGroup(db);

      // 'subgroup' relationship type is NOT in COALLIED_RELATIONSHIP_TYPES.
      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: group.id,
        objectId: subgroup.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'subgroup' },
      });
      // inactive coalition edge
      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: group.id,
        objectId: inactiveAlly.id,
        objectType: 'agent',
        isActive: false,
        metadata: { relationshipType: 'coalition' },
      });

      const verified = await getVerifiedCoalliedGroups(group.id, [
        subgroup.id,
        inactiveAlly.id,
      ]);
      expect(verified.size).toBe(0);
    }));
});

// ---------------------------------------------------------------------------
// resolveLineageDistribution
// ---------------------------------------------------------------------------

describe('resolveLineageDistribution', () => {
  it('returns [] when lineage is disabled', () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const entries = await resolveLineageDistribution(group.id, { enabled: false });
      expect(entries).toEqual([]);
    }));

  it('returns [] when enabled but no levelBps and no coallied configured', () =>
    withTestTransaction(async (db) => {
      const group = await createTestGroup(db);
      const entries = await resolveLineageDistribution(group.id, { enabled: true });
      expect(entries).toEqual([]);
    }));

  it('emits one parent_org entry per ancestor with positive levelBps', () =>
    withTestTransaction(async (db) => {
      const grandparent = await createTestGroup(db);
      const parent = await createTestGroup(db, { parentId: grandparent.id });
      const owner = await createTestGroup(db, { parentId: parent.id });

      const entries = await resolveLineageDistribution(owner.id, {
        enabled: true,
        levelBps: [1000, 500], // parent gets 10%, grandparent 5%
      });

      expect(entries).toEqual([
        { recipientId: parent.id, bps: 1000, role: 'parent_org' },
        { recipientId: grandparent.id, bps: 500, role: 'parent_org' },
      ]);
    }));

  it('skips ancestor levels with zero bps', () =>
    withTestTransaction(async (db) => {
      const grandparent = await createTestGroup(db);
      const parent = await createTestGroup(db, { parentId: grandparent.id });
      const owner = await createTestGroup(db, { parentId: parent.id });

      const entries = await resolveLineageDistribution(owner.id, {
        enabled: true,
        levelBps: [0, 500], // skip parent, grandparent gets 5%
      });
      expect(entries).toEqual([
        { recipientId: grandparent.id, bps: 500, role: 'parent_org' },
      ]);
    }));

  it('adds only verified opted-in coallied groups', () =>
    withTestTransaction(async (db) => {
      const owner = await createTestGroup(db);
      const realAlly = await createTestGroup(db);
      const fakeAlly = await createTestGroup(db);

      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: owner.id,
        objectId: realAlly.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'coalition' },
      });

      const entries = await resolveLineageDistribution(owner.id, {
        enabled: true,
        coallied: [
          { agentId: realAlly.id, bps: 300 },
          { agentId: fakeAlly.id, bps: 300 }, // no edge -> dropped
        ],
      });

      expect(entries).toEqual([
        { recipientId: realAlly.id, bps: 300, role: 'ally' },
      ]);
    }));

  it('emits lineage entries before coallied entries', () =>
    withTestTransaction(async (db) => {
      const parent = await createTestGroup(db);
      const owner = await createTestGroup(db, { parentId: parent.id });
      const ally = await createTestGroup(db);

      await db.insert(ledger).values({
        verb: 'manage',
        subjectId: owner.id,
        objectId: ally.id,
        objectType: 'agent',
        isActive: true,
        metadata: { relationshipType: 'partner' },
      });

      const entries = await resolveLineageDistribution(owner.id, {
        enabled: true,
        levelBps: [1000],
        coallied: [{ agentId: ally.id, bps: 200 }],
      });

      expect(entries).toEqual([
        { recipientId: parent.id, bps: 1000, role: 'parent_org' },
        { recipientId: ally.id, bps: 200, role: 'ally' },
      ]);
    }));
});

describe('COALLIED_RELATIONSHIP_TYPES', () => {
  it('contains the opt-in-eligible relationship types', () => {
    expect(COALLIED_RELATIONSHIP_TYPES).toContain('coalition');
    expect(COALLIED_RELATIONSHIP_TYPES).toContain('affiliate');
    expect(COALLIED_RELATIONSHIP_TYPES).toContain('partner');
    expect(COALLIED_RELATIONSHIP_TYPES).not.toContain('subgroup');
  });
});
