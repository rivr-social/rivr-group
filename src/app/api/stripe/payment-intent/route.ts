/**
 * Offering payment-intent API route.
 *
 * Purpose:
 * - Preserves the existing API surface for offering purchases.
 * - Delegates to the same server-side Stripe Connect implementation used by
 *   the app UI so offering payment logic has a single source of truth.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createProvidePaymentAction } from '@/app/actions/wallet';
import {
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
} from '@/lib/http-status';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  // Security boundary: only authenticated principals can create payment intents.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const clientIp = getClientIp(request.headers);
  const limiter = await rateLimit(
    `payment-intent:${clientIp}:${session.user.id}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  let body: { offeringId?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  if (!body.offeringId) {
    return NextResponse.json(
      { error: 'offeringId is required' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    const result = await createProvidePaymentAction(body.offeringId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? 'Failed to create payment intent' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    return NextResponse.json(
      {
        clientSecret: result.clientSecret,
        totalCents: result.totalCents,
        breakdown: result.breakdown,
      },
      { status: STATUS_OK },
    );
  } catch (error) {
    console.error('[PaymentIntent] Error creating payment intent:', error);
    return NextResponse.json(
      { error: 'Failed to create payment intent' },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
