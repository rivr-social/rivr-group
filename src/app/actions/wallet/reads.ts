'use server';

import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, ledger, resources, wallets } from '@/db/schema';
import {
  getOrCreateWallet,
  getWalletBalance,
  getUserWallets,
  getTransactionHistory,
} from '@/lib/wallet';
import { getConnectBalance } from '@/lib/stripe-connect';
import type { WalletBalance, WalletTransactionView } from '@/types';
import { getCurrentUserId, canManageWalletOwner } from './helpers';
import { isUuid } from './types';
import { releaseTestConnectBalanceToWalletInternal } from './seller';

async function getThanksWalletSummary(agentId: string): Promise<{
  thanksTokenCount: number;
  thanksTokensBurned: number;
  thanksTransferred: number;
  thanksReceived: number;
  thanksFlowRatio: number | null;
}> {
  const [
    activeTokenCountResult,
    burnedCountResult,
    transferredCountResult,
    receivedCountResult,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, agentId),
          eq(resources.type, 'thanks_token'),
          sql`${resources.deletedAt} IS NULL`,
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, agentId),
          eq(ledger.verb, 'consume'),
          sql`${ledger.metadata}->>'interactionType' = 'thanks-token-demurrage-burn'`,
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(sum(coalesce(
        (${ledger.metadata}->>'tokenCount')::int, 1
      )), 0)::int` })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, agentId),
          eq(ledger.verb, 'gift'),
          sql`${ledger.metadata}->>'interactionType' = 'thanks-token-transfer'`,
        ),
      ),
    db
      .select({ count: sql<number>`coalesce(sum(
        CASE
          WHEN ${ledger.verb} = 'earn' THEN coalesce((${ledger.metadata}->>'thanksTokenCount')::int, 100)
          ELSE coalesce((${ledger.metadata}->>'tokenCount')::int, 1)
        END
      ), 0)::int` })
      .from(ledger)
      .where(
        or(
          and(
            eq(ledger.objectId, agentId),
            eq(ledger.verb, 'gift'),
            sql`${ledger.metadata}->>'interactionType' = 'thanks-token-transfer'`,
          ),
          and(
            eq(ledger.subjectId, agentId),
            eq(ledger.verb, 'earn'),
            sql`${ledger.metadata}->>'interactionType' = 'subscription-thanks-grant'`,
          ),
        ),
      ),
  ]);

  const thanksTokenCount = Number(activeTokenCountResult[0]?.count ?? 0);
  const thanksTokensBurned = Number(burnedCountResult[0]?.count ?? 0);
  const thanksTransferred = Number(transferredCountResult[0]?.count ?? 0);
  const thanksReceived = Number(receivedCountResult[0]?.count ?? 0);
  const thanksFlowRatio =
    thanksReceived > 0 ? thanksTransferred / thanksReceived : thanksTransferred > 0 ? null : 0;

  return {
    thanksTokenCount,
    thanksTokensBurned,
    thanksTransferred,
    thanksReceived,
    thanksFlowRatio,
  };
}

/**
 * Returns the current user's personal wallet balance.
 *
 * @param {Record<string, never>} [_args] - No input parameters are accepted.
 * @returns {Promise<{ success: boolean; wallet?: WalletBalance; error?: string }>} Wallet balance payload on success, otherwise an error message.
 * @throws {Error} Can throw if unexpected runtime failures occur outside guarded handling.
 * @example
 * ```ts
 * const result = await getMyWalletAction();
 * if (result.success) console.log(result.wallet?.balanceCents);
 * ```
 */
export async function getMyWalletAction(): Promise<{
  success: boolean;
  wallet?: WalletBalance;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to view your wallet.' };
  }

  try {
    let wallet = await getOrCreateWallet(agentId, 'personal');
    let balance = await getWalletBalance(wallet.id);

    // Enrich with Stripe Connect balance when available
    let walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;
    const chargesEnabled = walletMeta.connectChargesEnabled === true;

    if (connectAccountId && chargesEnabled) {
      try {
        let connectBal = await getConnectBalance(connectAccountId);
        balance.connectAvailableCents = connectBal.availableCents;
        balance.connectPendingCents = connectBal.pendingCents;
        balance.hasConnectAccount = true;
        if ((process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) {
          const previouslyReleasedCents =
            typeof walletMeta.testConnectReleasedCents === 'number' ? walletMeta.testConnectReleasedCents : 0;
          const releasableCents = Math.max(
            0,
            connectBal.availableCents + connectBal.pendingCents - previouslyReleasedCents,
          );
          if (releasableCents > 0) {
            await releaseTestConnectBalanceToWalletInternal(agentId, agentId);
            wallet = await getOrCreateWallet(agentId, 'personal');
            walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
            balance = await getWalletBalance(wallet.id);
            connectBal = await getConnectBalance(connectAccountId);
            balance.connectAvailableCents = connectBal.availableCents;
            balance.connectPendingCents = connectBal.pendingCents;
          }
          const refreshedReleasedCents =
            typeof walletMeta.testConnectReleasedCents === 'number' ? walletMeta.testConnectReleasedCents : 0;
          balance.testReleasableCents = Math.max(
            0,
            connectBal.availableCents + connectBal.pendingCents - refreshedReleasedCents,
          );
        }
      } catch (connectErr) {
        console.error('getMyWalletAction: Connect balance fetch failed (non-fatal):', connectErr);
        balance.hasConnectAccount = true;
        balance.connectAvailableCents = 0;
        balance.connectPendingCents = 0;
      }
    } else {
      balance.hasConnectAccount = !!connectAccountId;
    }

    const thanksSummary = await getThanksWalletSummary(agentId);
    balance.thanksTokenCount = thanksSummary.thanksTokenCount;
    balance.thanksTokensBurned = thanksSummary.thanksTokensBurned;
    balance.thanksTransferred = thanksSummary.thanksTransferred;
    balance.thanksReceived = thanksSummary.thanksReceived;
    balance.thanksFlowRatio = thanksSummary.thanksFlowRatio;

    return { success: true, wallet: balance };
  } catch (error) {
    console.error('getMyWalletAction failed:', error);
    return { success: false, error: 'Unable to retrieve wallet. Please try again later.' };
  }
}

/**
 * Returns all wallets for the current user (personal + any group wallets they own).
 *
 * @param {Record<string, never>} [_args] - No input parameters are accepted.
 * @returns {Promise<{ success: boolean; wallets?: WalletBalance[]; error?: string }>} Wallet list payload on success, otherwise an error.
 * @throws {Error} Can throw if unexpected runtime failures occur outside guarded handling.
 * @example
 * ```ts
 * const result = await getMyWalletsAction();
 * if (result.success) console.log(result.wallets?.map((w) => w.type));
 * ```
 */
export async function getMyWalletsAction(): Promise<{
  success: boolean;
  wallets?: WalletBalance[];
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to view your wallets.' };
  }

  try {
    const wallets = await getUserWallets(agentId);
    return { success: true, wallets };
  } catch (error) {
    console.error('getMyWalletsAction failed:', error);
    return { success: false, error: 'Unable to retrieve wallets. Please try again later.' };
  }
}

/**
 * Returns the wallet balance for a group the current user belongs to.
 *
 * @param {string} groupId - Group UUID.
 * @returns {Promise<{ success: boolean; wallet?: WalletBalance; error?: string }>} Group wallet balance if membership validation passes.
 * @throws {Error} Can throw if membership/wallet queries fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await getGroupWalletAction(groupId);
 * ```
 */
export async function getGroupWalletAction(groupId: string): Promise<{
  success: boolean;
  wallet?: WalletBalance;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to view a group wallet.' };
  }

  if (!isUuid(groupId)) {
    return { success: false, error: 'Invalid group.' };
  }

  try {
    const canManage = await canManageWalletOwner(agentId, groupId);
    if (!canManage) {
      // Ordinary viewers still need an active join/belong edge.
      const membership = await db.query.ledger.findFirst({
        where: and(
          eq(ledger.subjectId, agentId),
          eq(ledger.objectId, groupId),
          eq(ledger.isActive, true)
        ),
        columns: { id: true, verb: true },
      });

      if (!membership || (membership.verb !== 'join' && membership.verb !== 'belong')) {
        return { success: false, error: 'You must be a member of this group to view its wallet.' };
      }
    }

    const wallet = await getOrCreateWallet(groupId, 'group');
    const balance = await getWalletBalance(wallet.id);

    // Enrich with Stripe Connect balance when the group has a Connect account
    const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;
    const chargesEnabled = walletMeta.connectChargesEnabled === true;

    if (connectAccountId && chargesEnabled) {
      try {
        const connectBal = await getConnectBalance(connectAccountId);
        balance.connectAvailableCents = connectBal.availableCents;
        balance.connectPendingCents = connectBal.pendingCents;
        balance.hasConnectAccount = true;
      } catch (connectErr) {
        console.error('getGroupWalletAction: Connect balance fetch failed (non-fatal):', connectErr);
        balance.hasConnectAccount = true;
        balance.connectAvailableCents = 0;
        balance.connectPendingCents = 0;
      }
    } else {
      balance.hasConnectAccount = !!connectAccountId;
    }

    return { success: true, wallet: balance };
  } catch (error) {
    console.error('getGroupWalletAction failed:', error);
    return { success: false, error: 'Unable to retrieve group wallet. Please try again later.' };
  }
}

/**
 * Fetches the ETH address from a given agent's personal wallet.
 * Used on the purchase page to determine the seller's crypto receiving address.
 *
 * @param agentId - The agent/seller whose ETH address to look up.
 * @returns The ETH address if set, or null.
 */
export async function getAgentEthAddressAction(
  agentId: string
): Promise<{ ethAddress: string | null }> {
  if (!agentId || !isUuid(agentId)) return { ethAddress: null };

  const [row] = await db
    .select({ ethAddress: wallets.ethAddress })
    .from(wallets)
    .where(and(eq(wallets.ownerId, agentId), eq(wallets.type, 'personal')))
    .limit(1);

  return { ethAddress: row?.ethAddress ?? null };
}

/**
 * Returns paginated transaction history for the current user's personal wallet.
 *
 * @param {{ limit?: number; offset?: number }} [options] - Optional pagination controls.
 * @returns {Promise<{ success: boolean; transactions?: WalletTransactionView[]; total?: number; error?: string }>} Transaction list with total count.
 * @throws {Error} Can throw if history retrieval fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await getTransactionHistoryAction({ limit: 20, offset: 0 });
 * ```
 */
export async function getTransactionHistoryAction(options?: {
  limit?: number;
  offset?: number;
}): Promise<{
  success: boolean;
  transactions?: WalletTransactionView[];
  total?: number;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to view transactions.' };
  }

  try {
    const wallet = await getOrCreateWallet(agentId, 'personal');
    const result = await getTransactionHistory(wallet.id, options);
    return { success: true, transactions: result.transactions, total: result.total };
  } catch (error) {
    console.error('getTransactionHistoryAction failed:', error);
    return { success: false, error: 'Unable to retrieve transactions. Please try again later.' };
  }
}

/**
 * Returns completed ticket purchases for the current user, including
 * wallet-based and Stripe checkout ticket purchases backed by ticket product objects.
 *
 * @param {Record<string, never>} [_args] - No input parameters are accepted.
 * @returns {Promise<{ success: boolean; purchases?: Array<{ transactionId: string; ticketProductId: string; ticketProductName: string; eventId?: string; eventName?: string; amountCents: number; feeCents: number; totalDollars: number; purchasedAt: string; paymentMethod: 'wallet' | 'card' }>; error?: string }>} Unified ticket purchase history.
 * @throws {Error} Can throw if SQL execution fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await getMyTicketPurchasesAction();
 * if (result.success) console.log(result.purchases?.length);
 * ```
 */
export async function getMyTicketPurchasesAction(): Promise<{
  success: boolean;
  purchases?: Array<{
    transactionId: string;
    ticketProductId: string;
    ticketProductName: string;
    eventId?: string;
    eventName?: string;
    amountCents: number;
    feeCents: number;
    totalDollars: number;
    purchasedAt: string;
    paymentMethod: 'wallet' | 'card';
  }>;
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to view ticket purchases.' };
  }

  try {
    const rows = await db.execute(sql`
      WITH buyer_wallets AS (
        SELECT id
        FROM wallets
        WHERE owner_id = ${agentId}::uuid
      ),
      -- Normalize wallet and card flows into a common schema for downstream UI rendering.
      wallet_ticket_purchases AS (
        SELECT
          wt.id AS transaction_id,
          wt.reference_id AS ticket_product_id,
          wt.amount_cents,
          wt.fee_cents,
          wt.created_at,
          'wallet'::text AS payment_method
        FROM wallet_transactions wt
        JOIN buyer_wallets bw ON bw.id = wt.from_wallet_id
        JOIN resources ticket ON ticket.id = wt.reference_id
        WHERE wt.status = 'completed'
          AND wt.reference_type = 'resource'
          AND ticket.deleted_at IS NULL
          AND lower(coalesce(ticket.metadata->>'productKind', '')) = 'ticket'
      ),
      stripe_ticket_purchases AS (
        SELECT
          wt.id AS transaction_id,
          wt.reference_id AS ticket_product_id,
          wt.amount_cents,
          wt.fee_cents,
          wt.created_at,
          'card'::text AS payment_method
        FROM wallet_transactions wt
        JOIN resources ticket ON ticket.id = wt.reference_id
        WHERE wt.status = 'completed'
          AND wt.type = 'event_ticket'
          AND wt.metadata->>'buyerAgentId' = ${agentId}
          AND ticket.deleted_at IS NULL
          AND lower(coalesce(ticket.metadata->>'productKind', '')) = 'ticket'
      ),
      all_purchases AS (
        SELECT * FROM wallet_ticket_purchases
        UNION ALL
        SELECT * FROM stripe_ticket_purchases
      )
      SELECT
        p.transaction_id,
        p.ticket_product_id,
        ticket.name AS ticket_product_name,
        ticket.metadata->>'eventId' AS event_id_text,
        coalesce(event_res.name, event_agent.name) AS event_name,
        p.amount_cents,
        p.fee_cents,
        p.created_at,
        p.payment_method
      FROM all_purchases p
      JOIN resources ticket ON ticket.id = p.ticket_product_id
      -- Regex-guarded UUID casts prevent malformed eventId metadata from causing SQL cast errors.
      LEFT JOIN resources event_res
        ON (
          ticket.metadata->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND event_res.id = (ticket.metadata->>'eventId')::uuid
        )
      LEFT JOIN agents event_agent
        ON (
          ticket.metadata->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND event_agent.id = (ticket.metadata->>'eventId')::uuid
        )
      ORDER BY p.created_at DESC
      LIMIT 200
    `);

    const purchases = (rows as Array<Record<string, unknown>>).map((row) => {
      const paymentMethod: 'wallet' | 'card' =
        String(row.payment_method) === 'wallet' ? 'wallet' : 'card';
      return {
      transactionId: String(row.transaction_id),
      ticketProductId: String(row.ticket_product_id),
      ticketProductName: String(row.ticket_product_name ?? 'Ticket'),
      eventId: typeof row.event_id_text === 'string' && row.event_id_text ? String(row.event_id_text) : undefined,
      eventName: typeof row.event_name === 'string' && row.event_name ? String(row.event_name) : undefined,
      amountCents: Number(row.amount_cents ?? 0),
      feeCents: Number(row.fee_cents ?? 0),
      totalDollars: Number(row.amount_cents ?? 0) / 100,
      purchasedAt: new Date(String(row.created_at)).toISOString(),
      paymentMethod,
    };
    });

    return { success: true, purchases };
  } catch (error) {
    console.error('getMyTicketPurchasesAction failed:', error);
    return { success: false, error: 'Unable to load ticket purchases.' };
  }
}
