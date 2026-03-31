/**
 * Stripe Connect onboarding return handler.
 *
 * Purpose:
 * - Handles the redirect after a user completes (or returns from) Stripe Express onboarding.
 * - Checks the Connect account status and updates wallet metadata.
 * - Redirects to the settings page with a status query parameter.
 *
 * Auth: Uses session-based auth to match the returning user to their Connect account.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/db';
import { wallets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAccountStatus } from '@/lib/stripe-connect';
import { getStripe } from '@/lib/billing';

/**
 * GET handler for Connect onboarding return.
 * Called when Stripe redirects back after Express onboarding.
 * Validates account ownership, updates wallet metadata, and redirects to settings.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;

  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

  if (!userId) {
    return NextResponse.redirect(`${baseUrl}/auth/login`);
  }

  const accountId = request.nextUrl.searchParams.get('account_id');
  const returnPath = request.nextUrl.searchParams.get('return_path');
  if (!accountId) {
    return NextResponse.redirect(`${baseUrl}/settings?connect=error&reason=missing_account`);
  }

  try {
    // Verify the Connect account belongs to the authenticated user
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);
    const ownerId = account.metadata?.ownerId ?? account.metadata?.agentId;
    if (ownerId !== userId) {
      return NextResponse.redirect(`${baseUrl}/settings?connect=error&reason=account_mismatch`);
    }

    const status = await getAccountStatus(accountId);

    const walletId = account.metadata?.walletId;
    const [wallet] = walletId
      ? await db
          .select({ id: wallets.id, metadata: wallets.metadata })
          .from(wallets)
          .where(eq(wallets.id, walletId))
          .limit(1)
      : [];

    if (wallet) {
      const existingMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(wallets)
        .set({
          metadata: {
            ...existingMeta,
            stripeConnectAccountId: accountId,
            connectChargesEnabled: status.chargesEnabled,
            connectPayoutsEnabled: status.payoutsEnabled,
            connectDetailsSubmitted: status.detailsSubmitted,
            connectStatusUpdatedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));
    }

    const connectStatus = status.chargesEnabled ? 'success' : 'pending';
    const destination = returnPath || account.metadata?.returnPath || '/settings';
    return NextResponse.redirect(`${baseUrl}${destination}${destination.includes('?') ? '&' : '?'}connect=${connectStatus}`);
  } catch (error) {
    console.error('[Connect return] Error checking account status:', error);
    return NextResponse.redirect(`${baseUrl}/settings?connect=error`);
  }
}
