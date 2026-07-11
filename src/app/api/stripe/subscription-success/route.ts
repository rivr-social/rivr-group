/**
 * Post-subscription success redirect handler.
 *
 * Purpose:
 * After a membership subscription checkout completes, Stripe redirects here.
 * This route checks whether the user already has a Stripe Connect account
 * set up. If not, it provisions one via the shared core
 * (`@/lib/connect-account` — Custom controller account when enabled, else
 * Express) and redirects to Stripe's hosted onboarding flow so the member can
 * receive payments. If Connect is already configured, it redirects to the
 * profile page. The Stripe webhook (`handleSubscriptionUpsert`) provisions
 * the same account server-side on activation; both paths share the
 * idempotent core, so whichever runs first wins and the other reuses it.
 *
 * Auth: Requires an authenticated session to look up wallet/Connect state.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
import { ensureLocalActorAgent } from '@/lib/federation/actor-projection';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createAccountLink } from '@/lib/stripe-connect';
import { ensureConnectAccountForWallet } from '@/lib/connect-account';
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
  // Unified session: the post-checkout redirect must recognize federated
  // remote-viewer subscribers (no local NextAuth JWT) — plain `auth()` bounced
  // them to login and Connect onboarding never started. The wallet + agent
  // lookups are keyed on a local agents row, so a first-contact federated
  // subscriber is projected before `getOrCreateWallet`.
  const session = await getSession();
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const returnPath = request.nextUrl.searchParams.get('return_path');
  const resolvedReturnPath = returnPath && returnPath.startsWith("/") ? returnPath : "/profile?subscription=success";

  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/auth/login`);
  }
  const userId =
    session.user.authMethod === 'federated'
      ? await resolveLocalActorId(session.user.id)
      : session.user.id;
  if (session.user.authMethod === 'federated') {
    await ensureLocalActorAgent(userId);
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

    // Shared provisioning core (Custom controller account when enabled, else
    // Express) — persists the id on the wallet metadata and is idempotent, so
    // a webhook-provisioned account is simply reused here.
    const { connectAccountId: newAccountId } = await ensureConnectAccountForWallet({
      walletId: wallet.id,
      ownerId: userId,
      ownerEmail: agent?.email ?? null,
      walletType: wallet.type,
      accountMetadata: { returnPath: resolvedReturnPath },
    });

    // Redirect to Stripe's hosted onboarding.
    const onboardingUrl = await createAccountLink(
      newAccountId,
      `${baseUrl}/api/stripe/connect?account_id=${newAccountId}&return_path=${encodeURIComponent(resolvedReturnPath)}`,
      `${baseUrl}/api/stripe/connect?account_id=${newAccountId}&return_path=${encodeURIComponent(resolvedReturnPath)}`,
    );

    return NextResponse.redirect(onboardingUrl);
  } catch (error) {
    console.error('[subscription-success] Connect onboarding setup failed:', error);
    // Fall through to profile even on error — subscription is already active.
    return NextResponse.redirect(new URL(`${resolvedReturnPath}${resolvedReturnPath.includes("?") ? "&" : "?"}connect=error`, baseUrl));
  }
}
