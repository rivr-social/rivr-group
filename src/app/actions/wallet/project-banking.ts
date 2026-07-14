'use server';

/**
 * Per-project Treasury FinancialAccounts + Issuing cards (2026-07-14, backlog
 * B13 — extend the dormant banking lane to PROJECTS).
 *
 * Completes the cascade "group → subgroup → project → job payout": a project
 * treasury (the resource-bound `type:'project'` wallet that already funds job
 * payouts) can now hold its OWN FinancialAccount and carry an FA-scoped Issuing
 * card, mirroring the subgroup-banking and treasury-funds lanes exactly.
 *
 * Model (same as subgroup/fund banking):
 * - The FA is HOSTED on the owning GROUP's Custom Connect account (the
 *   one-platform host); ids persist on the PROJECT WALLET metadata
 *   (`stripeFinancialAccountId`, `stripeHostConnectAccountId`,
 *   `stripeIssuingCardholderId`).
 * - Everything stays dormant behind STRIPE_TREASURY_ENABLED /
 *   STRIPE_ISSUING_ENABLED (separate Stripe program approvals). The internal
 *   ledger funding cascade (transferProjectBalanceAction / job payouts) works
 *   WITHOUT these flags; only the real Stripe FA/card lives behind them.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { resources, wallets } from '@/db/schema';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getGroupSubtreeIds } from '@/lib/queries/stakes';
import { getOrCreateProjectWallet } from '@/lib/wallet';
import {
  createIssuingCardholder,
  createTreasuryFinancialAccount,
  createTreasuryIssuingCard,
  getTreasuryFinancialAccountBalance,
  isIssuingEnabled,
  isTreasuryEnabled,
  listIssuingCardsForCardholder,
  type IssuedCardSummary,
} from '@/lib/stripe-treasury';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isUuid, isPositiveInteger } from './types';

const PROJECT_TREASURY_KIND = 'project';
const DEFAULT_PROJECT_CARD_MONTHLY_LIMIT_CENTS = 50_000; // $500/month

interface ProjectRow {
  id: string;
  name: string;
  ownerId: string;
}

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
 * Resolve + authorize the (group, project) pair: the caller must manage the
 * GROUP's wallet (the FA host + liability owner) and the project must be a live
 * `project` resource owned by an agent in the group's subtree. Returns the host
 * connect account id and the project's wallet row (created on demand).
 */
async function resolveProjectBankingTarget(
  currentUserId: string,
  groupId: string,
  projectId: string,
): Promise<{ hostConnectAccountId: string; project: ProjectRow; projectWallet: WalletRow }> {
  const groupTarget = await resolveManagedWalletTarget(currentUserId, groupId);

  const [project] = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
      ownerId: resources.ownerId,
    })
    .from(resources)
    .where(and(eq(resources.id, projectId), isNull(resources.deletedAt)))
    .limit(1);
  if (!project || project.type !== 'project') throw new Error('Project not found.');

  const subtreeIds = await getGroupSubtreeIds(groupId);
  if (!subtreeIds.includes(project.ownerId)) {
    throw new Error('That project does not belong to this group.');
  }

  const groupWallet = await getWalletRow(groupTarget.walletId);
  const hostConnectAccountId = groupWallet.metadata.stripeConnectAccountId as string | undefined;
  if (!hostConnectAccountId) {
    throw new Error('The group has no payment account yet. Set up group payments first.');
  }

  const wallet = await getOrCreateProjectWallet(project.id, project.ownerId);
  const projectWallet = await getWalletRow(wallet.id);

  return {
    hostConnectAccountId,
    project: { id: project.id, name: project.name, ownerId: project.ownerId },
    projectWallet,
  };
}

/**
 * Provisions a Stripe Treasury FinancialAccount for a project, hosted on the
 * owning group's Connect account. Idempotent; no-ops with an explanatory error
 * while STRIPE_TREASURY_ENABLED is off.
 *
 * @param {string} groupId - The hosting group agent UUID.
 * @param {string} projectId - The `resources.id` of the project resource.
 * @returns {Promise<{ success: boolean; financialAccountId?: string; error?: string }>} Outcome with the FA id.
 */
export async function provisionProjectFinancialAccountAction(
  groupId: string,
  projectId: string,
): Promise<{ success: boolean; financialAccountId?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled()) {
    return { success: false, error: 'Stripe Treasury is not enabled on this platform yet.' };
  }
  if (!isUuid(groupId) || !isUuid(projectId)) {
    return { success: false, error: 'Invalid project.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'provisionProjectFinancialAccountAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, projectId },
    },
    async () => {
      const { hostConnectAccountId, project, projectWallet } = await resolveProjectBankingTarget(
        currentUserId,
        groupId,
        projectId,
      );

      const existingFaId = projectWallet.metadata.stripeFinancialAccountId as string | undefined;
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
          walletId: projectWallet.id,
          ownerId: project.id,
          parentGroupId: groupId,
          treasuryKind: PROJECT_TREASURY_KIND,
        },
      });

      await db
        .update(wallets)
        .set({
          metadata: {
            ...projectWallet.metadata,
            stripeFinancialAccountId: financialAccount.id,
            stripeHostConnectAccountId: hostConnectAccountId,
          },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, projectWallet.id));

      return { success: true, financialAccountId: financialAccount.id } as {
        success: boolean;
        financialAccountId?: string;
        error?: string;
      };
    },
  );

  if (!result.success) {
    console.error('provisionProjectFinancialAccountAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to provision the project account.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: projectId,
    actorId: currentUserId,
    payload: {
      action: 'provision_project_financial_account',
      groupId,
      projectId,
      financialAccountId: result.data?.financialAccountId,
    },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Issues a virtual card to a project, tethered to the project's
 * FinancialAccount (spends only that FA's balance). Creates the project's
 * company cardholder on first use; the spending limit is mandatory. No-ops
 * while STRIPE_TREASURY_ENABLED / STRIPE_ISSUING_ENABLED are off.
 *
 * @param {string} groupId - The hosting group agent UUID.
 * @param {string} projectId - The `resources.id` of the project resource.
 * @param {{ spendingLimitCents?: number; spendingLimitInterval?: 'daily' | 'weekly' | 'monthly' }} [options] - Spending limit override (defaults $500/month).
 * @returns {Promise<{ success: boolean; cardId?: string; last4?: string; error?: string }>} Outcome with card id/last4.
 */
export async function issueProjectCardAction(
  groupId: string,
  projectId: string,
  options?: { spendingLimitCents?: number; spendingLimitInterval?: 'daily' | 'weekly' | 'monthly' },
): Promise<{ success: boolean; cardId?: string; last4?: string; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isTreasuryEnabled() || !isIssuingEnabled()) {
    return { success: false, error: 'Card issuing is not enabled on this platform yet.' };
  }
  if (!isUuid(groupId) || !isUuid(projectId)) {
    return { success: false, error: 'Invalid project.' };
  }

  const requestedLimit = options?.spendingLimitCents ?? DEFAULT_PROJECT_CARD_MONTHLY_LIMIT_CENTS;
  if (!isPositiveInteger(requestedLimit)) {
    return { success: false, error: 'The card spending limit must be a positive whole number of cents.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'issueProjectCardAction',
      actorId: currentUserId,
      targetAgentId: groupId,
      payload: { groupId, projectId, spendingLimitCents: requestedLimit },
    },
    async () => {
      const { hostConnectAccountId, project, projectWallet } = await resolveProjectBankingTarget(
        currentUserId,
        groupId,
        projectId,
      );

      const financialAccountId = projectWallet.metadata.stripeFinancialAccountId as string | undefined;
      if (!financialAccountId) {
        throw new Error('Provision the project account before issuing a card.');
      }

      let cardholderId = projectWallet.metadata.stripeIssuingCardholderId as string | undefined;
      if (!cardholderId) {
        const cardholder = await createIssuingCardholder({
          connectedAccountId: hostConnectAccountId,
          name: project.name,
          metadata: { ownerId: project.id, parentGroupId: groupId, treasuryKind: PROJECT_TREASURY_KIND },
        });
        cardholderId = cardholder.id;
        await db
          .update(wallets)
          .set({
            metadata: { ...projectWallet.metadata, stripeIssuingCardholderId: cardholderId },
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, projectWallet.id));
      }

      const card = await createTreasuryIssuingCard({
        connectedAccountId: hostConnectAccountId,
        cardholderId,
        financialAccountId,
        spendingLimitCents: requestedLimit,
        spendingLimitInterval: options?.spendingLimitInterval ?? 'monthly',
        metadata: { ownerId: project.id, parentGroupId: groupId },
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
    console.error('issueProjectCardAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to issue the card.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: projectId,
    actorId: currentUserId,
    payload: { action: 'issue_project_card', groupId, projectId, cardId: result.data?.cardId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

export interface ProjectBankingOverview {
  treasuryEnabled: boolean;
  issuingEnabled: boolean;
  hostConnectAccountId: string | null;
  financialAccountId: string | null;
  faCashCents: number | null;
  cards: IssuedCardSummary[];
}

/**
 * Banking overview for a single project's treasury tab: its FA balance +
 * issued cards (degrading to nulls/empties when unbound or Treasury is
 * dormant). Admin-gated via the hosting group's managed-wallet target.
 *
 * @param {string} groupId - The hosting group agent UUID.
 * @param {string} projectId - The `resources.id` of the project resource.
 * @returns {Promise<{ success: boolean; overview?: ProjectBankingOverview; error?: string }>} Overview payload or error.
 */
export async function getProjectBankingOverviewAction(
  groupId: string,
  projectId: string,
): Promise<{ success: boolean; overview?: ProjectBankingOverview; error?: string }> {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false, error: 'You must be logged in.' };
  if (!isUuid(groupId) || !isUuid(projectId)) {
    return { success: false, error: 'Invalid project.' };
  }

  try {
    const { hostConnectAccountId, projectWallet } = await resolveProjectBankingTarget(
      currentUserId,
      groupId,
      projectId,
    );
    const faId = (projectWallet.metadata.stripeFinancialAccountId as string | undefined) ?? null;
    const host =
      (projectWallet.metadata.stripeHostConnectAccountId as string | undefined) ?? hostConnectAccountId;
    const cardholderId = (projectWallet.metadata.stripeIssuingCardholderId as string | undefined) ?? null;

    const [faBalance, cards] = await Promise.all([
      faId && host
        ? getTreasuryFinancialAccountBalance(host, faId).catch(() => null)
        : Promise.resolve(null),
      cardholderId && host
        ? listIssuingCardsForCardholder(host, cardholderId).catch(() => [])
        : Promise.resolve([] as IssuedCardSummary[]),
    ]);

    return {
      success: true,
      overview: {
        treasuryEnabled: isTreasuryEnabled(),
        issuingEnabled: isIssuingEnabled(),
        hostConnectAccountId,
        financialAccountId: faId,
        faCashCents: faBalance?.cash?.usd ?? null,
        cards,
      },
    };
  } catch (error) {
    console.error('getProjectBankingOverviewAction failed:', error);
    return { success: false, error: 'Unable to load the project banking overview.' };
  }
}
