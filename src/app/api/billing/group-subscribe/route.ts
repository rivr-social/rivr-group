/**
 * POST /api/billing/group-subscribe
 *
 * Starts a member's subscription to a sovereign group's own membership plan.
 *
 * Security:
 * - The subscribing member is ALWAYS the authenticated session user. Client
 *   input never supplies buyer/member identity (P0 server-derivation rule).
 *
 * Request body: `{ groupId: string, planId: string, billingPeriod?: 'monthly' | 'yearly' }`
 * Response:
 * - Free plan: `{ free: true, membershipId }`
 * - Paid plan: `{ url }` (hosted Stripe Checkout)
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
import { ensureLocalActorAgent } from '@/lib/federation/actor-projection';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { readGroupMembershipPlans } from '@/lib/group-memberships';
import {
  createGroupSubscriptionCheckout,
  type GroupSubscriptionBillingPeriod,
} from '@/lib/group-subscriptions';

const STATUS_UNAUTHORIZED = 401;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL_ERROR = 500;

const VALID_BILLING_PERIODS: readonly GroupSubscriptionBillingPeriod[] = ['monthly', 'yearly'];

export async function POST(request: Request) {
  // Unified session: a sovereign group's dues-paying members include
  // federated remote-viewers (SSO'd from their home instance, no local
  // NextAuth JWT). Plain `auth()` here 401'd them — the 2026-07-11 toybox
  // campaign saw a dev-homed member who could JOIN + POST (those use the
  // unified session) but got "Authentication required" on the paid dues
  // checkout. Normalize any federated id to this instance's local agent so
  // the subscription/customer/membership bind to the correct local member.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: STATUS_UNAUTHORIZED });
  }
  const memberAgentId =
    session.user.authMethod === 'federated'
      ? await resolveLocalActorId(session.user.id)
      : session.user.id;

  // First-contact enrollment: a federated member subscribing before any local
  // write has no `agents` row on this sovereign, so getOrCreateStripeCustomer /
  // grantGroupMembership threw "Agent not found" (toybox campaign 2026-07-11 —
  // a dev-homed member landed recognized via SSO but couldn't enroll). Project
  // a private local mirror of the verified principal (verified-principal model,
  // same helper the importer + direct write path use); no-op if it exists.
  if (session.user.authMethod === 'federated') {
    await ensureLocalActorAgent(memberAgentId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: STATUS_BAD_REQUEST });
  }

  const { groupId, planId, billingPeriod: rawBillingPeriod } = (body ?? {}) as {
    groupId?: unknown;
    planId?: unknown;
    billingPeriod?: unknown;
  };

  if (typeof groupId !== 'string' || !groupId) {
    return NextResponse.json({ error: 'groupId is required.' }, { status: STATUS_BAD_REQUEST });
  }
  if (typeof planId !== 'string' || !planId) {
    return NextResponse.json({ error: 'planId is required.' }, { status: STATUS_BAD_REQUEST });
  }

  const billingPeriod: GroupSubscriptionBillingPeriod =
    typeof rawBillingPeriod === 'string' &&
    VALID_BILLING_PERIODS.includes(rawBillingPeriod as GroupSubscriptionBillingPeriod)
      ? (rawBillingPeriod as GroupSubscriptionBillingPeriod)
      : 'monthly';

  const [group] = await db
    .select({ id: agents.id, type: agents.type, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, groupId))
    .limit(1);

  if (!group) {
    return NextResponse.json({ error: 'Group not found.' }, { status: STATUS_NOT_FOUND });
  }

  const metadata =
    group.metadata && typeof group.metadata === 'object' && !Array.isArray(group.metadata)
      ? (group.metadata as Record<string, unknown>)
      : {};

  const plans = readGroupMembershipPlans(metadata);
  const plan = plans.find((p) => p.id === planId && p.active);
  if (!plan) {
    return NextResponse.json(
      { error: 'Membership plan not found or inactive.' },
      { status: STATUS_NOT_FOUND },
    );
  }

  try {
    const result = await createGroupSubscriptionCheckout({
      memberAgentId,
      groupId,
      plan,
      billingPeriod,
    });

    if (result.kind === 'free') {
      return NextResponse.json({ free: true, membershipId: result.membershipId });
    }
    return NextResponse.json({ url: result.url });
  } catch (err) {
    console.error('group-subscribe failed:', err);
    const message = err instanceof Error ? err.message : 'Failed to start subscription.';
    return NextResponse.json({ error: message }, { status: STATUS_INTERNAL_ERROR });
  }
}
