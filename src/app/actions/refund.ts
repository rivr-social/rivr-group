'use server';

import { auth } from '@/auth';
import { db } from '@/db';
import { resources, ledger, type NewLedgerEntry } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getStripe } from '@/lib/billing';
import { headers } from 'next/headers';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * Requests a refund for a receipt. The buyer must own the receipt.
 * Creates a Stripe refund and updates the receipt status.
 */
export async function requestRefundAction(receiptId: string): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

  const headersList = await headers();
  const clientIp = getClientIp(headersList);
  const limiter = await rateLimit(
    `refund:${clientIp}:${session.user.id}`,
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
  if (receipt.ownerId !== session.user.id) return { success: false, error: 'Not authorized' };

  const meta = (receipt.metadata ?? {}) as Record<string, unknown>;

  if (meta.status === 'refund_requested' || meta.status === 'refunded') {
    return { success: false, error: 'Refund already requested' };
  }

  const paymentIntentId = meta.stripePaymentIntentId as string | undefined;
  if (!paymentIntentId) return { success: false, error: 'No payment intent found' };

  try {
    const stripe = getStripe();

    // Verify the payment intent via Stripe API before issuing refund
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const receiptTotalCents = Number(meta.totalCents ?? 0);
    if (receiptTotalCents > 0 && Math.abs(pi.amount - receiptTotalCents) > 1) {
      console.error('Refund PI amount mismatch', { paymentIntentId, piAmount: pi.amount, receiptTotal: receiptTotalCents });
      return { success: false, error: 'Payment verification failed' };
    }
    if (pi.status !== 'succeeded') {
      return { success: false, error: 'Payment is not in a refundable state' };
    }

    await stripe.refunds.create({ payment_intent: paymentIntentId });

    await db
      .update(resources)
      .set({
        metadata: { ...meta, status: 'refund_requested', refundRequestedAt: new Date().toISOString() },
      })
      .where(eq(resources.id, receiptId));

    await db.insert(ledger).values({
      verb: 'refund',
      subjectId: session.user.id,
      objectId: meta.sellerAgentId as string,
      objectType: 'agent',
      resourceId: receiptId,
      metadata: {
        kind: 'refund-request',
        originalListingId: meta.originalListingId,
        paymentIntentId,
        priceCents: meta.priceCents,
      },
    } as NewLedgerEntry);

    return { success: true };
  } catch (err: unknown) {
    console.error('requestRefundAction failed:', err);
    return { success: false, error: 'Refund failed. Please try again later.' };
  }
}
