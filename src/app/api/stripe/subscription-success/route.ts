/**
 * Post-subscription success redirect handler.
 *
 * Purpose:
 * After a membership subscription checkout completes, Stripe redirects here.
 * Connected-account onboarding is owned by Global, the ecosystem's sole
 * Stripe platform. This sovereign route only completes the local subscription
 * redirect and never creates accounts or account links with local credentials.
 *
 * Auth: Requires an authenticated session to look up wallet/Connect state.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
import { ensureLocalActorAgent } from '@/lib/federation/actor-projection';
import { db } from '@/db';
import { agents, wallets } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { isGroupAgentType } from '@/lib/agent-types';

/**
 * GET handler invoked by Stripe's `success_url` redirect after checkout.
 *
 * Flow:
 * 1. Verify authentication.
 * 2. Project a federated actor locally when needed.
 * 3. Preserve the normal success redirect when a Global-issued account is
 *    already mirrored locally; otherwise add a Global-onboarding marker.
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
    const [agent] = await db
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, userId))
      .limit(1);
    const walletType = isGroupAgentType(agent?.type) ? 'group' : 'personal';
    const [wallet] = await db
      .select({ metadata: wallets.metadata })
      .from(wallets)
      .where(
        and(
          eq(wallets.ownerId, userId),
          eq(wallets.type, walletType),
          isNull(wallets.resourceId),
        ),
      )
      .limit(1);
    const walletMeta = (wallet?.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof walletMeta.stripeConnectAccountId === 'string' &&
      walletMeta.stripeConnectAccountId.length > 0
    ) {
      return NextResponse.redirect(new URL(resolvedReturnPath, baseUrl));
    }

    const separator = resolvedReturnPath.includes('?') ? '&' : '?';
    return NextResponse.redirect(
      new URL(`${resolvedReturnPath}${separator}connect=global_required`, baseUrl),
    );
  } catch (error) {
    console.error('[subscription-success] Unable to read mirrored payment account:', error);
    const separator = resolvedReturnPath.includes('?') ? '&' : '?';
    return NextResponse.redirect(
      new URL(`${resolvedReturnPath}${separator}connect=error`, baseUrl),
    );
  }
}
