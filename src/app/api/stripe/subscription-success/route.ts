/**
 * Post-subscription success redirect handler.
 *
 * Purpose:
 * After a membership subscription checkout completes, Stripe redirects here.
 * This route checks whether the user already has a Stripe Connect Express
 * account set up. If not, it creates one and redirects to Stripe's hosted
 * onboarding flow so the user can receive payments. If Connect is already
 * configured, it redirects to the profile page.
 *
 * Auth: Requires an authenticated session to look up wallet/Connect state.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents, wallets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createConnectAccount, createAccountLink } from '@/lib/stripe-connect';
import { getOrCreateWallet } from '@/lib/wallet';

/**
 * GET handler invoked by Stripe's `success_url` redirect after checkout.
 *
 * Flow:
 * 1. Verify authentication.
 * 2. Check wallet metadata for an existing `stripeConnectAccountId`.
 * 3. If missing, create a Connect Express account and redirect to onboarding.
 * 4. If present, redirect to `/profile?subscription=success`.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const returnPath = request.nextUrl.searchParams.get('return_path');
  const resolvedReturnPath = returnPath && returnPath.startsWith("/") ? returnPath : "/profile?subscription=success";

  if (!userId) {
    return NextResponse.redirect(`${baseUrl}/auth/login`);
  }

  try {
    const wallet = await getOrCreateWallet(userId, 'personal');
    const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    const connectAccountId = walletMeta.stripeConnectAccountId as string | undefined;

    // User already has a Connect account — skip onboarding.
    if (connectAccountId) {
      return NextResponse.redirect(new URL(resolvedReturnPath, baseUrl));
    }

    // Look up user email for the new Connect account.
    const [agent] = await db
      .select({ email: agents.email })
      .from(agents)
      .where(eq(agents.id, userId))
      .limit(1);

    const account = await createConnectAccount(userId, agent?.email ?? '');

    // Persist the Connect account ID in wallet metadata.
    await db
      .update(wallets)
      .set({
        metadata: { ...walletMeta, stripeConnectAccountId: account.id },
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    // Redirect to Stripe's hosted Express onboarding.
    const onboardingUrl = await createAccountLink(
      account.id,
      `${baseUrl}/api/stripe/connect?account_id=${account.id}&return_path=${encodeURIComponent(resolvedReturnPath)}`,
      `${baseUrl}/api/stripe/connect?account_id=${account.id}&return_path=${encodeURIComponent(resolvedReturnPath)}`,
    );

    return NextResponse.redirect(onboardingUrl);
  } catch (error) {
    console.error('[subscription-success] Connect onboarding setup failed:', error);
    // Fall through to profile even on error — subscription is already active.
    return NextResponse.redirect(new URL(`${resolvedReturnPath}${resolvedReturnPath.includes("?") ? "&" : "?"}connect=error`, baseUrl));
  }
}
