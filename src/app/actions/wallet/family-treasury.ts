'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { ledger } from '@/db/schema';
import type { NewLedgerEntry } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId } from './helpers';
import { isUuid, isPositiveInteger } from './types';

// =============================================================================
// Constants
// =============================================================================

const MIN_WITHDRAWAL_CENTS = 100;
const MAX_WITHDRAWAL_CENTS = 1_000_000;
const MAX_PURPOSE_LENGTH = 500;

// =============================================================================
// Server Actions
// =============================================================================

/**
 * Requests a withdrawal from a family treasury by creating a pending ledger entry.
 *
 * The withdrawal is recorded as a "request" verb with metadata capturing the
 * amount, purpose, and requesting member. A family admin must approve the
 * request before funds move.
 *
 * @param familyId - Family agent UUID.
 * @param amountCents - Withdrawal amount in cents.
 * @param purpose - Human-readable reason for the withdrawal.
 * @returns Operation outcome with success/failure.
 */
export async function requestFamilyWithdrawalAction(
  familyId: string,
  amountCents: number,
  purpose: string,
): Promise<{ success: boolean; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to request a withdrawal.' };
  }

  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(familyId)) {
    return { success: false, error: 'Invalid family ID.' };
  }

  if (!isPositiveInteger(amountCents)) {
    return { success: false, error: 'Amount must be a positive integer (in cents).' };
  }

  if (amountCents < MIN_WITHDRAWAL_CENTS) {
    return { success: false, error: `Minimum withdrawal is $${(MIN_WITHDRAWAL_CENTS / 100).toFixed(2)}.` };
  }

  if (amountCents > MAX_WITHDRAWAL_CENTS) {
    return { success: false, error: `Maximum withdrawal is $${(MAX_WITHDRAWAL_CENTS / 100).toFixed(2)}.` };
  }

  const trimmedPurpose = purpose?.trim();
  if (!trimmedPurpose) {
    return { success: false, error: 'A purpose is required for the withdrawal request.' };
  }

  if (trimmedPurpose.length > MAX_PURPOSE_LENGTH) {
    return { success: false, error: `Purpose must be ${MAX_PURPOSE_LENGTH} characters or fewer.` };
  }

  const result = await updateFacade.execute(
    {
      type: 'requestFamilyWithdrawalAction',
      actorId: agentId,
      targetAgentId: familyId,
      payload: { familyId, amountCents, purpose: trimmedPurpose },
    },
    async () => {
      // Verify the user is an active member of this family
      const membership = await db.query.ledger.findFirst({
        where: and(
          eq(ledger.subjectId, agentId),
          eq(ledger.objectId, familyId),
          eq(ledger.isActive, true)
        ),
        columns: { id: true, verb: true },
      });

      if (!membership || (membership.verb !== 'join' && membership.verb !== 'belong')) {
        throw new Error('You must be a member of this family to request a withdrawal.');
      }

      const now = new Date().toISOString();

      await db.insert(ledger).values({
        subjectId: agentId,
        verb: 'request',
        objectId: familyId,
        objectType: 'agent',
        isActive: true,
        metadata: {
          interactionType: 'family-withdrawal',
          targetId: familyId,
          targetType: 'family',
          amountCents,
          purpose: trimmedPurpose,
          withdrawalStatus: 'pending',
          requestedAt: now,
        },
      } as NewLedgerEntry);

      revalidatePath('/');
      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('requestFamilyWithdrawalAction failed:', result.error);
    return { success: false, error: result.error ?? 'Withdrawal request failed.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_TRANSFER,
    entityType: 'wallet',
    entityId: familyId,
    actorId: agentId,
    payload: { familyId, amountCents, purpose: trimmedPurpose },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Fetches contribution totals for each member of a family group.
 *
 * Queries the ledger for deposit/transfer entries targeting the family wallet
 * and groups amounts by the contributing member.
 *
 * @param familyId - Family agent UUID.
 * @returns Map of member IDs to their total contribution in cents.
 */
export async function getFamilyContributionsAction(familyId: string): Promise<{
  success: boolean;
  error?: string;
  contributions: Record<string, number>;
}> {
  if (!isUuid(familyId)) {
    return { success: false, error: 'Invalid family ID.', contributions: {} };
  }

  try {
    // Query wallet transaction ledger entries where the family was the recipient.
    // Deposits to group wallets use 'transfer' verb with the group as objectId,
    // as well as wallet_transaction records. We query both patterns.
    const rows = await db.execute(sql`
      SELECT
        l.subject_id AS member_id,
        COALESCE(SUM(CAST(l.metadata->>'amountCents' AS INTEGER)), 0) AS total_cents
      FROM ledger l
      WHERE l.object_id = ${familyId}::uuid
        AND l.verb IN ('transfer', 'fund', 'gift')
        AND l.is_active = true
        AND l.metadata->>'amountCents' IS NOT NULL
      GROUP BY l.subject_id
    `);

    // Also query the wallet_transactions table if deposits were recorded there
    const walletRows = await db.execute(sql`
      SELECT
        wt.sender_agent_id AS member_id,
        COALESCE(SUM(wt.amount_cents), 0) AS total_cents
      FROM wallet_transactions wt
      JOIN wallets w ON wt.recipient_wallet_id = w.id
      WHERE w.agent_id = ${familyId}::uuid
        AND wt.type IN ('transfer', 'deposit')
        AND wt.status = 'completed'
      GROUP BY wt.sender_agent_id
    `).catch(() => [] as Array<Record<string, unknown>>);

    const contributions: Record<string, number> = {};

    for (const row of rows as Array<Record<string, unknown>>) {
      const memberId = String(row.member_id ?? '');
      const totalCents = Number(row.total_cents ?? 0);
      if (memberId) {
        contributions[memberId] = (contributions[memberId] ?? 0) + totalCents;
      }
    }

    for (const row of walletRows as Array<Record<string, unknown>>) {
      const memberId = String(row.member_id ?? '');
      const totalCents = Number(row.total_cents ?? 0);
      if (memberId) {
        contributions[memberId] = (contributions[memberId] ?? 0) + totalCents;
      }
    }

    return { success: true, contributions };
  } catch (error) {
    console.error('getFamilyContributionsAction failed:', error);
    return { success: false, error: 'Failed to load contributions.', contributions: {} };
  }
}
