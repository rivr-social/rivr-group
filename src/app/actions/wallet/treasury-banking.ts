'use server';

/**
 * Group banking lane — per-subgroup Treasury FinancialAccounts + Issuing
 * cards + the aggregated treasury overview (Phase 2/3 of
 * docs/active/payments-stripe-connect-treasury-architecture-2026-07-01.md).
 *
 * Model (§3.3/§3.4 of the architecture doc):
 * - The PARENT group's Custom Connect account hosts every subgroup
 *   FinancialAccount (simpler compliance; promote a subgroup to its own
 *   connected account only when it needs independent payouts/liability).
 * - Each subgroup treasury gets ONE FA (idempotent provisioning) and may
 *   carry issued virtual cards tethered to that FA — funds isolation plus a
 *   mandatory spending limit (platform liability control).
 * - Ids persist on the SUBGROUP's settlement wallet metadata:
 *   `stripeFinancialAccountId`, `stripeHostConnectAccountId`,
 *   `stripeIssuingCardholderId`. The host id is stored because the FA lives
 *   on the parent's connected account, not the subgroup's.
 *
 * Everything stays dormant behind the STRIPE_TREASURY_ENABLED /
 * STRIPE_ISSUING_ENABLED flags exactly like the foundation module.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { agents, wallets } from '@/db/schema';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getSettlementWalletForAgent } from '@/lib/wallet';
import { getConnectBalance } from '@/lib/stripe-connect';
import {
  createIssuingCardholder,
  createTreasuryFinancialAccount,
  createTreasuryIssuingCard,
  getExternalBankBalance,
  getTreasuryFinancialAccountBalance,
  isIssuingEnabled,
  isTreasuryEnabled,
  listIssuingCardsForCardholder,
  type IssuedCardSummary,
} from '@/lib/stripe-treasury';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';

const DEFAULT_CARD_MONTHLY_LIMIT_CENTS = 50_000; // $500/month unless the admin sets one

interface WalletRow {
  id: string;
  metadata: Record<string, unknown>;
}

async function getWalletRow(walletId: string): Promise<WalletRow> {
  const [wallet] = await db
    .select({ id: wallets.id, metadata: wallets.metadata })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);
  if (!wallet) throw new Error('Treasury wallet not found.');
  return { id: wallet.id, metadata: (wallet.metadata ?? {}) as Record<string, unknown> };
}

/**
 * Resolve + authorize the (parent group, subgroup) pair:
 * - the caller must be allowed to manage the PARENT group's wallet, and
 * - the subgroup must be a live child of the parent (agents.parentId).
 * Returns the parent's connect account id and the subgroup's wallet row.
 */
async function resolveSubgroupBankingTarget(
  currentUserId: string,
  groupId: string,
  subgroupId: string,
): Promise<{
  hostConnectAccountId: string;
  subgroupName: string;
  subgroupWallet: WalletRow;
}> {
  // Admin gate on the PARENT group (the account host + liability owner).
  const parentTarget = await resolveManagedWalletTarget(currentUserId, groupId);

  const [subgroup] = await db
    .select({ id: agents.id, name: agents.name, parentId: agents.parentId, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, subgroupId))
    .limit(1);
  if (!subgroup || subgroup.deletedAt) throw new Error('Subgroup not found.');
  if (subgroup.parentId !== groupId) {
    throw new Error('That treasury is not a subgroup of this group.');
  }

  const parentWallet = await getWalletRow(parentTarget.walletId);
  const hostConnectAccountId = parentWallet.metadata.stripeConnectAccountId as string | undefined;
  if (!hostConnectAccountId) {
    throw new Error('The group has no payment account yet. Set up group payments first.');
  }

  const subgroupSettlement = await getSettlementWalletForAgent(subgroupId);
  const subgroupWallet = await getWalletRow(subgroupSettlement.id);

  return { hostConnectAccountId, subgroupName: subgroup.name, subgroupWallet };
}

/**
 * Provision a Treasury FinancialAccount for a SUBGROUP treasury, hosted on
 * the parent group's connected account. Idempotent: returns the existing FA
 * id when one is already recorded.
 */
export async function provisionSubgroupFinancialAccountAction(
  groupId: string,
  subgroupId: string,
): Promise<{ success: boolean; financialAccountId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled()) {
    return { success: false, error: 'Stripe Treasury is not enabled on this platform yet.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'provisionSubgroupFinancialAccountAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, subgroupId },
    },
    async () => {
      const { hostConnectAccountId, subgroupWallet } = await resolveSubgroupBankingTarget(
        currentUserId,
        groupId,
        subgroupId,
      );

      const existingFaId = subgroupWallet.metadata.stripeFinancialAccountId as string | undefined;
      if (existingFaId) {
        return { success: true, financialAccountId: existingFaId } as {
          success: boolean;
          financialAccountId?: string;
          error?: string;
        };
      }

      const financialAccount = await createTreasuryFinancialAccount({
        connectedAccountId: hostConnectAccountId,
        metadata: {
          walletId: subgroupWallet.id,
          ownerId: subgroupId,
          parentGroupId: groupId,
          treasuryKind: 'subgroup',
        },
      });

      await db
        .update(wallets)
        .set({
          metadata: {
            ...subgroupWallet.metadata,
            stripeFinancialAccountId: financialAccount.id,
            stripeHostConnectAccountId: hostConnectAccountId,
          },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, subgroupWallet.id));

      return { success: true, financialAccountId: financialAccount.id } as {
        success: boolean;
        financialAccountId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('provisionSubgroupFinancialAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to provision the subgroup treasury account.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: subgroupId,
    actorId: currentUserId,
    payload: {
      action: 'provision_subgroup_financial_account',
      groupId,
      subgroupId,
      financialAccountId: result.data?.financialAccountId,
    },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Issue a virtual card to a SUBGROUP treasury, tethered to its
 * FinancialAccount (the card can only spend that FA's balance). Creates the
 * subgroup's company cardholder on first use. The spending limit is
 * mandatory — platform liability control per architecture doc §4.2.
 */
export async function issueSubgroupCardAction(
  groupId: string,
  subgroupId: string,
  options?: { spendingLimitCents?: number; spendingLimitInterval?: 'daily' | 'weekly' | 'monthly' },
): Promise<{ success: boolean; cardId?: string; last4?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled() || !isIssuingEnabled()) {
    return { success: false, error: 'Card issuing is not enabled on this platform yet.' };
  }

  const requestedLimit = options?.spendingLimitCents ?? DEFAULT_CARD_MONTHLY_LIMIT_CENTS;
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    return { success: false, error: 'The card spending limit must be a positive whole number of cents.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'issueSubgroupCardAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, subgroupId, spendingLimitCents: requestedLimit },
    },
    async () => {
      const { hostConnectAccountId, subgroupName, subgroupWallet } = await resolveSubgroupBankingTarget(
        currentUserId,
        groupId,
        subgroupId,
      );

      const financialAccountId = subgroupWallet.metadata.stripeFinancialAccountId as string | undefined;
      if (!financialAccountId) {
        throw new Error('Provision the subgroup treasury account before issuing a card.');
      }

      let cardholderId = subgroupWallet.metadata.stripeIssuingCardholderId as string | undefined;
      if (!cardholderId) {
        const cardholder = await createIssuingCardholder({
          connectedAccountId: hostConnectAccountId,
          name: subgroupName,
          metadata: { ownerId: subgroupId, parentGroupId: groupId, treasuryKind: 'subgroup' },
        });
        cardholderId = cardholder.id;
        await db
          .update(wallets)
          .set({
            metadata: { ...subgroupWallet.metadata, stripeIssuingCardholderId: cardholderId },
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, subgroupWallet.id));
      }

      const card = await createTreasuryIssuingCard({
        connectedAccountId: hostConnectAccountId,
        cardholderId,
        financialAccountId,
        spendingLimitCents: requestedLimit,
        spendingLimitInterval: options?.spendingLimitInterval ?? 'monthly',
        metadata: { ownerId: subgroupId, parentGroupId: groupId },
      });

      return { success: true, cardId: card.id, last4: card.last4 } as {
        success: boolean;
        cardId?: string;
        last4?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('issueSubgroupCardAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to issue the card.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: subgroupId,
    actorId: currentUserId,
    payload: { action: 'issue_subgroup_card', groupId, subgroupId, cardId: result.data?.cardId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

export interface SubgroupBankingRow {
  subgroupId: string;
  subgroupName: string;
  financialAccountId: string | null;
  faCashCents: number | null;
  cards: IssuedCardSummary[];
}

export interface GroupTreasuryBankingOverview {
  treasuryEnabled: boolean;
  issuingEnabled: boolean;
  groupConnectAccountId: string | null;
  groupConnectBalance: { availableCents: number; pendingCents: number } | null;
  groupFinancialAccountId: string | null;
  groupFaCashCents: number | null;
  externalBank: { currentCents: number | null; availableCents: number | null; asOf: number | null } | null;
  subgroups: SubgroupBankingRow[];
}

/**
 * Aggregated banking view for the group treasury tab: the group's Connect
 * balance, its own FA balance, the linked external bank balance (Financial
 * Connections), and every live subgroup's FA balance + issued cards. Reads
 * degrade to nulls — the tab renders whatever exists.
 */
export async function getGroupTreasuryBankingOverviewAction(
  groupId: string,
): Promise<{ success: boolean; overview?: GroupTreasuryBankingOverview; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };

  try {
    const parentTarget = await resolveManagedWalletTarget(currentUserId, groupId);
    const parentWallet = await getWalletRow(parentTarget.walletId);
    const groupConnectAccountId =
      (parentWallet.metadata.stripeConnectAccountId as string | undefined) ?? null;
    const groupFaId = (parentWallet.metadata.stripeFinancialAccountId as string | undefined) ?? null;
    const groupFcId =
      (parentWallet.metadata.financialConnectionsAccountId as string | undefined) ?? null;

    const [groupConnectBalance, groupFaBalance, externalBank] = await Promise.all([
      groupConnectAccountId ? getConnectBalance(groupConnectAccountId).catch(() => null) : Promise.resolve(null),
      groupConnectAccountId && groupFaId
        ? getTreasuryFinancialAccountBalance(groupConnectAccountId, groupFaId).catch(() => null)
        : Promise.resolve(null),
      groupConnectAccountId && groupFcId
        ? getExternalBankBalance(groupConnectAccountId, groupFcId, false).catch(() => null)
        : Promise.resolve(null),
    ]);

    const children = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.parentId, groupId), isNull(agents.deletedAt)));

    const subgroups = await Promise.all(
      children.map(async (child): Promise<SubgroupBankingRow> => {
        try {
          const settlement = await getSettlementWalletForAgent(child.id);
          const row = await getWalletRow(settlement.id);
          const faId = (row.metadata.stripeFinancialAccountId as string | undefined) ?? null;
          const host =
            (row.metadata.stripeHostConnectAccountId as string | undefined) ?? groupConnectAccountId;
          const cardholderId =
            (row.metadata.stripeIssuingCardholderId as string | undefined) ?? null;

          const [faBalance, cards] = await Promise.all([
            faId && host
              ? getTreasuryFinancialAccountBalance(host, faId).catch(() => null)
              : Promise.resolve(null),
            cardholderId && host
              ? listIssuingCardsForCardholder(host, cardholderId).catch(() => [])
              : Promise.resolve([] as IssuedCardSummary[]),
          ]);

          return {
            subgroupId: child.id,
            subgroupName: child.name,
            financialAccountId: faId,
            faCashCents: faBalance?.cash?.usd ?? null,
            cards,
          };
        } catch {
          return {
            subgroupId: child.id,
            subgroupName: child.name,
            financialAccountId: null,
            faCashCents: null,
            cards: [],
          };
        }
      }),
    );

    return {
      success: true,
      overview: {
        treasuryEnabled: isTreasuryEnabled(),
        issuingEnabled: isIssuingEnabled(),
        groupConnectAccountId,
        groupConnectBalance: groupConnectBalance ?? null,
        groupFinancialAccountId: groupFaId,
        groupFaCashCents: groupFaBalance?.cash?.usd ?? null,
        externalBank: externalBank
          ? {
              currentCents: externalBank.current?.usd ?? null,
              availableCents: externalBank.available?.usd ?? null,
              asOf: externalBank.asOf,
            }
          : null,
        subgroups,
      },
    };
  } catch (error) {
    console.error('getGroupTreasuryBankingOverviewAction failed:', error);
    return { success: false, error: 'Unable to load the treasury banking overview.' };
  }
}
