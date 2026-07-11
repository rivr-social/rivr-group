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
import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
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
  // Unified session: a federated remote-viewer returning from Stripe hosted
  // onboarding carries no local NextAuth JWT — plain `auth()` bounced them to
  // login and the wallet metadata never updated. The Connect account's
  // `ownerId` metadata stores the LOCAL agent id, so the federated id must be
  // normalized before the ownership check.
  const session = await getSession();

  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/auth/login`);
  }
  const userId =
    session.user.authMethod === 'federated'
      ? await resolveLocalActorId(session.user.id)
      : session.user.id;

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
