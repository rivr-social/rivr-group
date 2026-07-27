'use server';

import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
import { db } from '@/db';
import { resources } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { headers } from 'next/headers';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { submitGlobalRefund } from '@/lib/global-refund';

/**
 * Requests a refund for a receipt. The buyer must own the receipt.
 * Validates local receipt ownership, then fails closed until Global's
 * authenticated refund-obligation contract is available.
 */
export async function requestRefundAction(receiptId: string): Promise<{ success: boolean; error?: string }> {
  // Unified session: a federated remote-viewer's receipt is owned by their
  // LOCAL projected agent id, not their remote session id — plain `auth()`
  // denied them a refund on their own purchase ("Not authorized").
  const session = await getSession();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  const actorId =
    session.user.authMethod === 'federated'
      ? await resolveLocalActorId(session.user.id)
      : session.user.id;

  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const limiter = await rateLimit(
    `refund:${clientIp}:${actorId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return { success: false, error: 'Too many refund requests. Please try again later.' };
  }

  const [receipt] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, receiptId), eq(resources.type, 'receipt')))
    .limit(1);

  if (!receipt) return { success: false, error: 'Receipt not found' };
  if (receipt.ownerId !== actorId) return { success: false, error: 'Not authorized' };

  const meta = (receipt.metadata ?? {}) as Record<string, unknown>;

  if (meta.status === 'refund_requested' || meta.status === 'refunded') {
    return { success: false, error: 'Refund already requested' };
  }

  const paymentIntentId = meta.stripePaymentIntentId as string | undefined;
  if (!paymentIntentId) return { success: false, error: 'No payment intent found' };

  // Global is the only Stripe platform, so the refund is submitted to it as an
  // obligation rather than executed here. Global re-derives origin, owner,
  // amount, and payment intent from its OWN projection before moving money.
  const result = await submitGlobalRefund({
    receiptId: receipt.id,
    buyerAgentId: actorId,
  });

  switch (result.status) {
    case 'refunded':
    case 'already-requested':
      // Mirror the outcome locally so the buyer's receipt reflects it. Only
      // done on a definite verdict — an ambiguous result must not look settled.
      await db
        .update(resources)
        .set({
          metadata: {
            ...meta,
            status: 'refund_requested',
            refundRequestedAt: new Date().toISOString(),
            ...(result.refundId ? { refundId: result.refundId } : {}),
          },
        })
        .where(eq(resources.id, receipt.id));
      return { success: true };

    case 'disabled':
      return {
        success: false,
        error: 'Refunds are not enabled yet. Please contact the seller.',
      };

    case 'not-authorized':
      console.error('[refund] Global rejected the obligation:', result.detail);
      return { success: false, error: 'Not authorized' };

    case 'not-refundable':
      return { success: false, error: 'This payment is not in a refundable state.' };

    default:
      console.error('[refund] Global refund failed:', result.detail);
      return {
        success: false,
        error: 'Refund could not be completed. Please try again later.',
      };
  }
}
