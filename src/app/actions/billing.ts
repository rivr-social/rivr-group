'use server';

/**
 * Billing server actions for membership checkout, subscription status lookup, and local free-trial bootstrap.
 *
 * Purpose:
 * - Validate authenticated user input before initiating Stripe checkout.
 * - Provide a normalized active subscription payload for UI entitlement decisions.
 * - Create or update synthetic trial subscriptions so authorization checks work immediately.
 *
 * Key exports:
 * - `createCheckoutAction`
 * - `getSubscriptionStatusAction`
 * - `startFreeTrialAction`
 *
 * Core dependencies:
 * - Authentication (`@/auth`)
 * - Billing services (`@/lib/billing`)
 * - Subscription persistence (`@/db`, `@/db/schema`, `drizzle-orm`)
 *
 * Auth/error handling notes:
 * - All write operations require an authenticated session.
 * - This module does not currently apply explicit action-level rate limiting.
 * - Input validation is performed before external provider calls.
 * - Failures are logged and transformed into safe error messages for callers.
 */
import { auth } from '@/auth';
import { db } from '@/db';
import { agents, emailLog, subscriptions, type SubscriptionStatus } from '@/db/schema';
import { and, eq, gte, lte } from 'drizzle-orm';
import {
  createCheckoutSession,
  getActiveSubscription,
  getAllActiveSubscriptions,
  MEMBERSHIP_TIERS,
  DEFAULT_MEMBERSHIP_TRIAL_DAYS,
} from '@/lib/billing';
import type { MembershipTier } from '@/db/schema';
import { sendTransactionalEmail } from '@/lib/mailer';
import { trialEndingReminderEmail } from '@/lib/email-templates';

const VALID_TIERS = new Set<string>(Object.keys(MEMBERSHIP_TIERS));

type BillingResult = {
  success: boolean;
  url?: string;
  error?: string;
};

/**
 * Creates a Stripe Checkout session and returns its redirect URL.
 *
 * @param {string} tier - Membership tier key expected in `MEMBERSHIP_TIERS`.
 * @param {'monthly' | 'yearly'} billingPeriod - Billing cadence.
 * @returns {Promise<BillingResult>} Checkout URL on success, otherwise an error payload.
 * @throws {Error} Can throw if checkout session creation fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await createCheckoutAction('organizer', 'monthly');
 * if (result.success) window.location.assign(result.url!);
 * ```
 */
export async function createCheckoutAction(
  tier: string,
  billingPeriod: 'monthly' | 'yearly',
  returnPath?: string
): Promise<BillingResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: 'You must be logged in to subscribe.' };
  }

  if (!VALID_TIERS.has(tier)) {
    return { success: false, error: `Invalid membership tier: ${tier}` };
  }

  if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') {
    return { success: false, error: 'Billing period must be "monthly" or "yearly".' };
  }

  try {
    // Tier/cadence are already validated, so casting is safe at this point.
    const url = await createCheckoutSession(
      session.user.id,
      tier as MembershipTier,
      billingPeriod,
      {
        trialDays: DEFAULT_MEMBERSHIP_TRIAL_DAYS,
        successPath: returnPath
          ? `/api/stripe/subscription-success?return_path=${encodeURIComponent(returnPath)}`
          : undefined,
      }
    );
    return { success: true, url };
  } catch (error) {
    console.error('createCheckoutAction failed:', error);
    return {
      success: false,
      error: 'Unable to start checkout. Please try again later.',
    };
  }
}

/**
 * Returns the caller's active subscription details (if present).
 *
 * @param {Record<string, never>} [_args] - No input parameters are accepted.
 * @returns {Promise<{ tier: MembershipTier; status: SubscriptionStatus; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null>} Active subscription summary, or `null` when unauthenticated/no active sub.
 * @throws {Error} Can throw if subscription lookup fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const status = await getSubscriptionStatusAction();
 * if (status) console.log(status.tier, status.status);
 * ```
 */
export async function getSubscriptionStatusAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const sub = await getActiveSubscription(session.user.id);
  if (!sub) return null;

  return {
    tier: sub.membershipTier,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

/**
 * Starts or restores a local 30-day free trial for the selected membership tier.
 *
 * @param {MembershipTier} [tier='organizer'] - Tier to trial.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation result.
 * @throws {Error} Can throw if database persistence fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await startFreeTrialAction('organizer');
 * ```
 */
export async function startFreeTrialAction(
  tier: MembershipTier = 'organizer',
  returnPath?: string
): Promise<{ success: boolean; error?: string; url?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: 'You must be logged in to start a trial.' };
  }

  if (!VALID_TIERS.has(tier)) {
    return { success: false, error: `Invalid membership tier: ${tier}` };
  }

  const active = await getActiveSubscription(session.user.id);
  if (active && (active.status === 'active' || active.status === 'trialing')) {
    return { success: true };
  }

  try {
    const url = await createCheckoutSession(
      session.user.id,
      tier,
      'monthly',
      {
        trialDays: DEFAULT_MEMBERSHIP_TRIAL_DAYS,
        successPath: returnPath
          ? `/api/stripe/subscription-success?return_path=${encodeURIComponent(returnPath)}`
          : undefined,
      }
    );
    return { success: true, url };
  } catch (error) {
    console.error('startFreeTrialAction failed:', error);
    return {
      success: false,
      error: 'Unable to start the Stripe trial checkout. Please try again later.',
    };
  }
}

/**
 * Returns all active/trialing subscriptions for the current user.
 *
 * @returns Array of { tier, status } objects, or empty array if unauthenticated.
 */
export async function getAllSubscriptionStatusesAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return [];
  }

  const subs = await getAllActiveSubscriptions(session.user.id);
  return subs.map((sub) => ({
    tier: sub.membershipTier,
    status: sub.status,
  }));
}

export async function sendTrialEndingRemindersAction(): Promise<{
  success: boolean;
  sent: number;
  error?: string;
}> {
  // Admin-only: this action mutates subscription state and sends emails.
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, sent: 0, error: "Authentication required." };
  }
  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);
  const agentMeta =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};
  if (agentMeta.siteRole !== "admin") {
    return { success: false, sent: 0, error: "Admin access required." };
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);

  try {
    const dueSubscriptions = await db
      .select({
        subscriptionId: subscriptions.id,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        membershipTier: subscriptions.membershipTier,
        agentId: subscriptions.agentId,
        agentName: agents.name,
        agentEmail: agents.email,
      })
      .from(subscriptions)
      .innerJoin(agents, eq(subscriptions.agentId, agents.id))
      .where(
        and(
          eq(subscriptions.status, 'trialing'),
          gte(subscriptions.currentPeriodEnd, windowStart),
          lte(subscriptions.currentPeriodEnd, windowEnd)
        )
      );

    let sent = 0;

    for (const sub of dueSubscriptions) {
      if (!sub.agentEmail) continue;

      const [existingReminder] = await db
        .select({ id: emailLog.id })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.recipientAgentId, sub.agentId),
            eq(emailLog.emailType, 'trial_ending_reminder')
          )
        )
        .limit(1);

      if (existingReminder) continue;

      const tierConfig = MEMBERSHIP_TIERS[sub.membershipTier];
      const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
      const email = trialEndingReminderEmail(
        sub.agentName || 'there',
        tierConfig?.name ?? sub.membershipTier,
        sub.currentPeriodEnd,
        `${baseUrl}/profile`
      );

      const result = await sendTransactionalEmail({
        kind: 'transactional',
        to: sub.agentEmail,
        ...email,
        recipientAgentId: sub.agentId,
        meta: { flow: 'trial_ending_reminder' },
      });

      await db.insert(emailLog).values({
        recipientEmail: sub.agentEmail,
        recipientAgentId: sub.agentId,
        subject: email.subject,
        emailType: 'trial_ending_reminder',
        status: result.success ? 'sent' : 'failed',
        messageId: result.success ? result.messageId ?? null : null,
        error: result.success ? null : result.error ?? 'Unknown email error',
        metadata: {
          stripeSubscriptionId: sub.stripeSubscriptionId,
          membershipTier: sub.membershipTier,
          currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        },
      });

      if (result.success) sent += 1;
    }

    return { success: true, sent };
  } catch (error) {
    console.error('sendTrialEndingRemindersAction failed:', error);
    return { success: false, sent: 0, error: 'Unable to send trial reminders.' };
  }
}
