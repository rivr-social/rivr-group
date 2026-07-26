import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestTransaction } from '@/test/db';
import {
  createTestAgent,
  createTestGroup,
  createTestWallet,
} from '@/test/fixtures';
import { mockAuthSession, mockUnauthenticated } from '@/test/auth-helpers';

vi.mock('@/db', async () => {
  const { getTestDbModule } = await import('@/test/db');
  return getTestDbModule();
});

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/headers', async () => {
  const { setupNextHeadersMock } = await import('@/test/external-mocks');
  return setupNextHeadersMock();
});

vi.mock('next/cache', async () => {
  const { setupNextCacheMock } = await import('@/test/external-mocks');
  return setupNextCacheMock();
});

vi.mock('@/lib/ai', () => ({
  embedResource: vi.fn(),
  scheduleEmbedding: vi.fn(),
}));

vi.mock('@/lib/murmurations', () => ({
  syncMurmurationsProfilesForActor: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from '@/auth';
import {
  ensureConnectAccountForAgent,
  ensureConnectAccountForWallet,
} from '@/lib/connect-account';
import { resetInstanceConfig } from '@/lib/federation/instance-config';
import { backfillConnectAccountsAction } from '../connect-backfill';

const ORIGINAL_PRIMARY_AGENT_ID = process.env.PRIMARY_AGENT_ID;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_PRIMARY_AGENT_ID === undefined) {
    delete process.env.PRIMARY_AGENT_ID;
  } else {
    process.env.PRIMARY_AGENT_ID = ORIGINAL_PRIMARY_AGENT_ID;
  }
  resetInstanceConfig();
});

describe('Global-owned connected account references', () => {
  it('reuses a globally-issued account reference already mirrored locally', () =>
    withTestTransaction(async (testDb) => {
      const member = await createTestAgent(testDb);
      await createTestWallet(testDb, member.id, {
        metadata: {
          stripeConnectAccountId: 'acct_global_1',
          connectChargesEnabled: true,
        },
      });

      await expect(ensureConnectAccountForAgent(member.id)).resolves.toEqual({
        connectAccountId: 'acct_global_1',
        created: false,
      });
    }));

  it('uses the owner-scoped group wallet for a group agent', () =>
    withTestTransaction(async (testDb) => {
      const group = await createTestGroup(testDb);
      await createTestWallet(testDb, group.id, {
        type: 'group',
        metadata: { stripeConnectAccountId: 'acct_global_group' },
      });

      await expect(ensureConnectAccountForAgent(group.id)).resolves.toEqual({
        connectAccountId: 'acct_global_group',
        created: false,
      });
    }));

  it('fails closed without creating a wallet when no mirror exists', () =>
    withTestTransaction(async (testDb) => {
      const member = await createTestAgent(testDb);

      await expect(ensureConnectAccountForAgent(member.id)).rejects.toThrow(
        /no mirrored payment account/i,
      );

      const wallets = await testDb.query.wallets.findMany({
        where: (table, { eq }) => eq(table.ownerId, member.id),
      });
      expect(wallets).toHaveLength(0);
    }));

  it('rejects an unknown or deleted agent', () =>
    withTestTransaction(async (testDb) => {
      await expect(
        ensureConnectAccountForAgent('00000000-0000-0000-0000-00000000dead'),
      ).rejects.toThrow(/agent not found/i);

      const deleted = await createTestAgent(testDb, { deletedAt: new Date() });
      await expect(ensureConnectAccountForAgent(deleted.id)).rejects.toThrow(
        /agent not found/i,
      );
    }));

  it('does not disclose a mirrored account through a mismatched owner', () =>
    withTestTransaction(async (testDb) => {
      const owner = await createTestAgent(testDb);
      const other = await createTestAgent(testDb);
      const wallet = await createTestWallet(testDb, owner.id, {
        metadata: { stripeConnectAccountId: 'acct_private' },
      });

      await expect(
        ensureConnectAccountForWallet({
          walletId: wallet.id,
          ownerId: other.id,
          walletType: 'personal',
        }),
      ).rejects.toThrow(/does not match/i);
    }));
});

describe('backfillConnectAccountsAction boundary and gating', () => {
  it('requires authentication', async () => {
    vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
    await expect(backfillConnectAccountsAction()).resolves.toEqual({
      success: false,
      error: 'You must be logged in.',
    });
  });

  it('fails cleanly when no target group is configured', () =>
    withTestTransaction(async (testDb) => {
      const admin = await createTestAgent(testDb, {
        metadata: { siteRole: 'admin' },
      });
      delete process.env.PRIMARY_AGENT_ID;
      resetInstanceConfig();
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/primary group/i);
    }));

  it('rejects a caller without manage access before exposing the boundary', () =>
    withTestTransaction(async (testDb) => {
      const group = await createTestGroup(testDb);
      const outsider = await createTestAgent(testDb);
      process.env.PRIMARY_AGENT_ID = group.id;
      resetInstanceConfig();
      vi.mocked(auth).mockResolvedValue(mockAuthSession(outsider.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not allowed/i);
      expect(result.error).not.toMatch(/owned by Global/i);
    }));

  it('authorizes a group manager, then rejects local provisioning', () =>
    withTestTransaction(async (testDb) => {
      const manager = await createTestAgent(testDb);
      const group = await createTestGroup(testDb, {
        metadata: { adminIds: [manager.id] },
      });
      process.env.PRIMARY_AGENT_ID = group.id;
      resetInstanceConfig();
      vi.mocked(auth).mockResolvedValue(mockAuthSession(manager.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/owned by Global/i);
    }));

  it('authorizes a site admin, then rejects local provisioning', () =>
    withTestTransaction(async (testDb) => {
      const group = await createTestGroup(testDb);
      const admin = await createTestAgent(testDb, {
        metadata: { siteRole: 'admin' },
      });
      process.env.PRIMARY_AGENT_ID = group.id;
      resetInstanceConfig();
      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));

      const result = await backfillConnectAccountsAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/owned by Global/i);
    }));
});
