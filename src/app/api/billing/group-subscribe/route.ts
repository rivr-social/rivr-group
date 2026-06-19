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
import { auth } from '@/auth';
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
  const session = await auth();
  const memberAgentId = session?.user?.id;
  if (!memberAgentId) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: STATUS_UNAUTHORIZED });
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
