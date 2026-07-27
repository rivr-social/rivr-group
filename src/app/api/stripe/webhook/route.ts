/**
 * Stripe webhook ingestion API route.
 *
 * Purpose:
 * - Verifies inbound Stripe webhook signatures using the raw request payload.
 * - Dispatches supported webhook event types to internal billing and wallet handlers.
 * - Persists subscription and wallet transaction state updates in the database.
 *
 * Key exports:
 * - `POST`: Main Stripe webhook endpoint.
 *
 * Dependencies:
 * - Stripe SDK for event construction and type models.
 * - Drizzle database client + schema models for ledger/subscription/wallet persistence.
 * - Billing helpers (`getStripe`, `tierForPriceId`) and wallet reconciliation helpers.
 *
 * Auth requirements:
 * - No user auth/session is used; authenticity is enforced via Stripe signature validation.
 *
 * Rate limiting:
 * - No application-level rate limiting is applied to preserve Stripe retry semantics.
 *
 * Error handling pattern:
 * - Missing/invalid webhook setup or signature issues return `400`/`500`.
 * - Handler failures are logged and return `500` so Stripe can retry safely.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { db } from '@/db';
import { agents, capitalEntries, groupMembershipSubscriptions, ledger, resources, subscriptions, wallets, walletTransactions, type NewLedgerEntry } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getStripe, tierForPriceId } from '@/lib/billing';
import { grantGroupMembership, revokeGroupMembership } from '@/lib/group-subscriptions';
import {
  confirmDeposit,
  failDeposit,
  getOrCreateWallet,
  getPlatformWallet,
  getPlatformWalletOrNull,
  getSettlementWalletForAgent,
  creditWalletCapital,
} from '@/lib/wallet';
import { resolveSettlementSplits } from '@/lib/settlement-splits';
import {
  getPaymentIntentPayoutEligibleAt,
  getResourceProjectId,
  incrementListingInventory,
  lockWallets,
  resolveSettlementTargets,
  settleSellerNet,
} from '@/lib/settlement-accounting';
import {
  resolveGuestBuyerAgentId,
  settleMarketplacePurchase,
} from '@/lib/marketplace-settlement';
import { settleEventTicketPurchase } from '@/lib/event-ticket-settlement';
import { STATUS_BAD_REQUEST, STATUS_INTERNAL_ERROR } from '@/lib/http-status';
import { eventMatchesRuntimeMode, getStripeRuntimeMode, stripeModeOfLivemode } from '@/lib/stripe-mode';
import { assertAmountReconciled } from '@/lib/stripe-reconcile';
import { reconcileTaxExclusiveCheckout } from '@/lib/stripe-checkout-settlement';
import {
  clawbackChargeback,
  clawbackRefund,
  reverseChargebackClawback,
} from '@/lib/chargeback';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const MONTHLY_SUBSCRIPTION_THANKS_GRANT = 100;

/**
 * Stripe webhook handler.
 * Verifies the signature using the raw request body, then dispatches
 * to per-event-type handlers that upsert subscription records.
 *
 * @param {NextRequest} request - Incoming webhook HTTP request from Stripe.
 * @returns {Promise<NextResponse>} JSON acknowledgment response for Stripe.
 * @throws {Error} When unexpected runtime failures occur outside handled branches.
 * @example
 * ```ts
 * // Stripe sends a signed POST to /api/stripe/webhook
 * // Header: stripe-signature: t=...,v1=...
 * ```
 */
export async function POST(request: NextRequest) {
  if (!WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured');
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: STATUS_INTERNAL_ERROR }
    );
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header' },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Read raw body for signature verification
  // Security requirement: Stripe signature verification must use the exact raw payload bytes.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Webhook signature verification failed:', message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Reject cross-mode deliveries before dispatching. A correctly signed event
  // whose livemode disagrees with our keys came from an endpoint pointed at the
  // wrong instance, and retrying can never fix that — acknowledge with 200
  // instead of letting Stripe redeliver indefinitely.
  if (!eventMatchesRuntimeMode(event.livemode)) {
    console.error(
      `[stripe-webhook] Rejected ${stripeModeOfLivemode(event.livemode)}-mode event ${event.id} (${event.type}); instance mode is ${getStripeRuntimeMode() ?? 'unconfigured'}`,
    );
    return NextResponse.json({ received: true, ignored: 'stripe-mode-mismatch' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.paid':
        await handlePaidInvoice(event.data.object as Stripe.Invoice);
        break;

      case 'payment_intent.succeeded': {
        const piSucceeded = event.data.object as Stripe.PaymentIntent;
        if (piSucceeded.metadata?.walletId) {
          await handleWalletDepositSucceeded(piSucceeded.id);
        }
        if (piSucceeded.metadata?.type === 'offering_purchase') {
          await handleOfferingPurchaseSucceeded(piSucceeded);
        }
        break;
      }

      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;

      case 'payout.paid':
        await handlePayoutStatusUpdate(event.data.object as Stripe.Payout, 'completed');
        break;

      case 'payout.failed':
        await handlePayoutStatusUpdate(event.data.object as Stripe.Payout, 'failed');
        break;

      case 'payment_intent.payment_failed': {
        const piFailed = event.data.object as Stripe.PaymentIntent;
        if (piFailed.metadata?.walletId) {
          await handleWalletDepositFailed(piFailed.id);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const refundPiId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id;

        if (refundPiId) {
          await clawbackRefund({
            eventId: event.id,
            paymentIntentId: refundPiId,
            chargeAmountCents: charge.amount,
            totalRefundedCents: charge.amount_refunded,
          });

          const [matchedReceipt] = await db
            .select({ id: resources.id, metadata: resources.metadata })
            .from(resources)
            .where(
              and(
                eq(resources.type, 'receipt'),
                sql`${resources.metadata}->>'stripePaymentIntentId' = ${refundPiId}`
              )
            )
            .limit(1);

          if (matchedReceipt) {
            const meta = (matchedReceipt.metadata ?? {}) as Record<string, unknown>;
            await db
              .update(resources)
              .set({
                metadata: { ...meta, status: 'refunded', refundedAt: new Date().toISOString() },
              })
              .where(eq(resources.id, matchedReceipt.id));
          }
        }
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id;
        if (!paymentIntentId) {
          throw new Error(`Dispute ${dispute.id} has no payment intent`);
        }
        if (typeof dispute.charge === 'string') {
          throw new Error(
            `Dispute ${dispute.id} must be forwarded by Global with an expanded charge`,
          );
        }
        const charge = dispute.charge;
        await clawbackChargeback({
          eventId: event.id,
          paymentIntentId,
          disputeId: dispute.id,
          chargeAmountCents: charge.amount,
          disputeAmountCents: dispute.amount,
        });
        break;
      }

      case 'charge.dispute.funds_reinstated': {
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId =
          typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id;
        if (!paymentIntentId) {
          throw new Error(`Reinstated dispute ${dispute.id} has no payment intent`);
        }
        await reverseChargebackClawback({
          eventId: event.id,
          paymentIntentId,
          disputeId: dispute.id,
        });
        break;
      }

      case 'balance.available': {
        // Stripe reports newly-available balance. Clear ONLY the pending capital
        // entries whose own scheduled availability date has actually passed.
        //
        // Each entry's `availableOn` is set at settlement from the originating
        // charge's `balance_transaction.available_on`, so gating on
        // `availableOn <= now()` clears exactly the entries Stripe has scheduled
        // to be available by now and leaves entries with a future availableOn
        // pending. The `balance.available` event payload is a Balance object and
        // carries NO reference to a specific charge/transfer/payout, so the
        // entries cannot be correlated by id — time-scoping on each entry's own
        // payout schedule is the correct gate. This replaces the previous
        // blanket clear, which flipped EVERY pending entry fleet-wide regardless
        // of its payout schedule (premature payout-eligibility). Entries with a
        // NULL availableOn (settlement could not read the Stripe schedule) are
        // deliberately left pending rather than cleared by an unrelated event.
        // `availableOn` is intentionally NOT overwritten, preserving the
        // originating charge's settlement date for audit (COM-SEC-001).
        const cleared = await db
          .update(capitalEntries)
          .set({
            settlementStatus: 'cleared',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(capitalEntries.settlementStatus, 'pending'),
              sql`${capitalEntries.remainingCents} > 0`,
              sql`${capitalEntries.availableOn} IS NOT NULL`,
              sql`${capitalEntries.availableOn} <= now()`,
            ),
          )
          .returning({ id: capitalEntries.id });
        if (cleared.length > 0) {
          console.log(
            `[balance.available] Cleared ${cleared.length} pending capital entries past their availableOn`,
          );
        }
        break;
      }

      default:
        // Unhandled event types are still acknowledged to prevent unnecessary Stripe retries.
        break;
    }
  } catch (err) {
    // Return 500 for processing errors so Stripe can retry according to its backoff policy.
    console.error(`Error handling webhook event ${event.type}:`, err);
    return NextResponse.json(
      { error: 'Webhook handler error' },
      { status: STATUS_INTERNAL_ERROR }
    );
  }

  return NextResponse.json({ received: true });
}

/**
 * Handles checkout.session.completed.
 * At this point the subscription may not exist in our DB yet,
 * so we fetch it from Stripe and upsert.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode === 'payment') {
    // One-time payment checkouts (event tickets) follow a separate persistence path.
    await handlePaymentCheckoutCompleted(session);
    return;
  }

  if (session.mode !== 'subscription' || !session.subscription) {
    return;
  }

  const stripe = getStripe();
  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription.id;

  // Fetch canonical state from Stripe because webhook ordering can be non-deterministic.
  const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
  await handleSubscriptionUpsert(stripeSubscription);
}

/**
 * Handles one-time payment checkouts (event tickets).
 * Idempotent by stripePaymentIntentId unique key.
 */
async function handlePaymentCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid') {
    return;
  }

  const metadata = session.metadata ?? {};

  if (metadata.purchaseType === 'marketplace_purchase') {
    await handleMarketplacePurchaseCompleted(session);
    return;
  }

  if (metadata.purchaseType !== 'event_ticket') {
    // Only event ticket and marketplace purchases are handled in this branch.
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.warn('Event ticket checkout missing payment intent:', session.id);
    return;
  }

  const eventId = metadata.eventId;
  const ticketProductId = metadata.ticketProductId;
  const parsedSelections = (() => {
    try {
      const raw = metadata.ticketSelectionsJson;
      if (!raw) return [];
      const decoded = JSON.parse(String(raw));
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  })();
  const buyerAgentId = metadata.buyerAgentId;
  const organizerAgentId = metadata.organizerAgentId;
  if (!eventId || !ticketProductId || !buyerAgentId || !organizerAgentId) {
    console.warn('Event ticket checkout missing required metadata:', session.id);
    return;
  }

  const totalCents = Number(metadata.totalCents ?? 0);
  const platformFeeCents = Number(metadata.platformFeeCents ?? 0);
  const legacySalesTaxCents = Number(metadata.salesTaxCents ?? 0);
  const paymentFeeCents = Number(metadata.paymentFeeCents ?? 0);

  const checkoutAmounts = reconcileTaxExclusiveCheckout(
    session,
    totalCents,
    `event-ticket:${session.id}`,
  );

  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(paymentIntentId);
  const ticketSelections = parsedSelections.length > 0
    ? parsedSelections
        .map((selection) => ({
          ticketProductId: String(selection.ticketProductId ?? ""),
          quantity: Number(selection.quantity ?? 0),
          subtotalCents: Number(selection.subtotalCents ?? 0),
        }))
        .filter((selection) => selection.ticketProductId && selection.quantity > 0 && selection.subtotalCents >= 0)
    : [{
        ticketProductId,
        quantity: 1,
        subtotalCents: Number(metadata.subtotalCents ?? totalCents),
      }];

  await settleEventTicketPurchase({
    eventId,
    ticketProductId,
    ticketSelections,
    buyerAgentId,
    organizerAgentId,
    totalCents,
    subtotalCents: Number(metadata.subtotalCents ?? 0),
    feeProrationBaseCents: Number(metadata.subtotalCents ?? totalCents),
    platformFeeCents,
    legacySalesTaxCents,
    paymentFeeCents,
    chargedTotalCents: checkoutAmounts.chargedTotalCents,
    taxCents: checkoutAmounts.taxCents,
    currency: session.currency ?? 'usd',
    checkoutSessionId: session.id,
    paymentIntentId,
    payoutEligibleAt,
  });
}

/**
 * Handles marketplace purchase checkout completion.
 * Records the purchase in the ledger and wallet transactions, then
 * redistributes org commission via Stripe transfer if applicable.
 */
async function handleMarketplacePurchaseCompleted(session: Stripe.Checkout.Session) {
  const metadata = session.metadata ?? {};
  const listingId = metadata.listingId;
  const sellerAgentId = metadata.sellerAgentId;
  const orgId = metadata.orgId || null;
  const orgCommissionCents = Number(metadata.orgCommissionCents ?? 0);
  const platformFeeCents = Number(metadata.platformFeeCents ?? 0);
  const buyerPlatformFeeCents = Number(
    metadata.buyerPlatformFeeCents ?? metadata.applicationFeeCents ?? 0,
  );
  const priceCents = Number(metadata.priceCents ?? 0);
  const buyerTotalCents = Number(
    metadata.buyerTotalCents ?? priceCents + buyerPlatformFeeCents,
  );
  const requestedQuantity = Number(metadata.quantity ?? 1);
  const bookingSelection =
    metadata.bookingDate && metadata.bookingSlot
      ? { date: metadata.bookingDate, slot: metadata.bookingSlot }
      : null;

  let buyerAgentId = metadata.buyerAgentId || null;

  const checkoutAmounts = reconcileTaxExclusiveCheckout(
    session,
    buyerTotalCents,
    `marketplace:${session.id}`,
  );

  if (!listingId || !sellerAgentId) {
    console.warn('Marketplace purchase checkout missing required metadata:', session.id);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.warn('Marketplace purchase checkout missing payment intent:', session.id);
    return;
  }

  // Guest checkout: attribute the purchase from the identity Stripe collected.
  if (!buyerAgentId && session.customer_details?.email) {
    buyerAgentId = await resolveGuestBuyerAgentId(
      session.customer_details.email,
      session.customer_details.name ?? null,
    );
  }

  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(paymentIntentId);

  await settleMarketplacePurchase({
    listingId,
    sellerAgentId,
    buyerAgentId,
    orgId,
    orgCommissionCents,
    platformFeeCents,
    buyerPlatformFeeCents,
    priceCents,
    buyerTotalCents,
    quantity: requestedQuantity,
    bookingSelection,
    chargedTotalCents: checkoutAmounts.chargedTotalCents,
    taxCents: checkoutAmounts.taxCents,
    currency: session.currency ?? 'usd',
    checkoutSessionId: session.id,
    paymentIntentId,
    payoutEligibleAt,
    customerEmail: session.customer_details?.email || null,
    customerName: session.customer_details?.name || null,
  });
}

/**
 * Upserts a subscription record from a Stripe subscription object.
 */
async function handleSubscriptionUpsert(stripeSub: Stripe.Subscription) {
  // Group membership subscriptions are settled on a separate rail and tracked
  // in `group_membership_subscriptions`, not the cooperative `subscriptions`.
  if (stripeSub.metadata?.groupSubscription === 'true') {
    await handleGroupSubscriptionUpsert(stripeSub);
    return;
  }

  const agentId = stripeSub.metadata?.agentId;
  if (!agentId) {
    // Metadata contract violation: without agent ownership we cannot safely map this subscription.
    console.warn('Subscription missing agentId metadata, skipping:', stripeSub.id);
    return;
  }

  const customerId =
    typeof stripeSub.customer === 'string'
      ? stripeSub.customer
      : stripeSub.customer.id;

  const priceId = stripeSub.items.data[0]?.price?.id;
  if (!priceId) {
    console.warn('Subscription has no price, skipping:', stripeSub.id);
    return;
  }

  const tier = tierForPriceId(priceId) ?? (stripeSub.metadata?.tier as string);
  if (!tier) {
    // Reject unknown catalog entries to avoid writing ambiguous entitlements.
    console.warn('Could not resolve tier for price:', priceId);
    return;
  }

  const now = new Date();

  const values = {
    agentId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
    stripePriceId: priceId,
    status: stripeSub.status as typeof subscriptions.$inferInsert.status,
    membershipTier: tier as typeof subscriptions.$inferInsert.membershipTier,
    currentPeriodStart: new Date(stripeSub.items.data[0].current_period_start * 1000),
    currentPeriodEnd: new Date(stripeSub.items.data[0].current_period_end * 1000),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    updatedAt: now,
  };

  // Try to update existing record first
  const [existing] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSub.id))
    .limit(1);

  await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(subscriptions)
        .set(values)
        .where(eq(subscriptions.id, existing.id));
    } else {
      // Insert when first observed from Stripe; includes createdAt only on initial create.
      await tx.insert(subscriptions).values({
        ...values,
        createdAt: now,
      });
    }

    if (stripeSub.status === 'active' || stripeSub.status === 'trialing') {
      await mintSubscriptionThanksGrant(tx, agentId, stripeSub);
    }
  });

}

async function mintSubscriptionThanksGrant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  agentId: string,
  stripeSub: Stripe.Subscription,
) {
  const currentPeriodStart = stripeSub.items.data[0]?.current_period_start;
  const currentPeriodEnd = stripeSub.items.data[0]?.current_period_end;

  if (!currentPeriodStart || !currentPeriodEnd) {
    return;
  }

  const cycleKey = `${stripeSub.id}:${currentPeriodStart}`;

  const [existingGrant] = await tx
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, agentId),
        eq(ledger.verb, 'earn'),
        sql`${ledger.metadata}->>'interactionType' = 'subscription-thanks-grant'`,
        sql`${ledger.metadata}->>'cycleKey' = ${cycleKey}`,
      ),
    )
    .limit(1);

  if (existingGrant) {
    return;
  }

  const mintedAt = new Date().toISOString();
  const enteredAccountAt = new Date(mintedAt);
  const tokenValues = Array.from({ length: MONTHLY_SUBSCRIPTION_THANKS_GRANT }, () => ({
    name: 'Thanks Token',
    type: 'thanks_token' as const,
    ownerId: agentId,
    enteredAccountAt,
    description: 'A thanks token minted from an active membership subscription period.',
    metadata: {
      entityType: 'thanks_token',
      creatorId: agentId,
      currentOwnerId: agentId,
      source: 'subscription',
      sourceSubscriptionId: stripeSub.id,
      sourceSubscriptionCycleKey: cycleKey,
      mintedAt,
      transferHistory: [
        {
          from: null,
          to: agentId,
          at: mintedAt,
          kind: 'subscription_grant',
          sourceSubscriptionId: stripeSub.id,
          cycleKey,
        },
      ],
    },
  }));

  await tx.insert(resources).values(tokenValues);
  await tx.insert(ledger).values({
    subjectId: agentId,
    verb: 'earn',
    objectId: agentId,
    objectType: 'agent',
    metadata: {
      interactionType: 'subscription-thanks-grant',
      cycleKey,
      stripeSubscriptionId: stripeSub.id,
      membershipTier: stripeSub.metadata?.tier ?? null,
      currentPeriodStart: new Date(currentPeriodStart * 1000).toISOString(),
      currentPeriodEnd: new Date(currentPeriodEnd * 1000).toISOString(),
      thanksTokenCount: MONTHLY_SUBSCRIPTION_THANKS_GRANT,
      grantedAt: mintedAt,
    },
  } as NewLedgerEntry);
}

/**
 * Marks a subscription as canceled when Stripe deletes it.
 */
async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  if (stripeSub.metadata?.groupSubscription === 'true') {
    await handleGroupSubscriptionDeleted(stripeSub);
    return;
  }

  await db
    .update(subscriptions)
    .set({
      status: 'canceled',
      cancelAtPeriodEnd: true,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSub.id));
}

/**
 * Upserts a group membership subscription row and grants/revokes the member's
 * group-membership ledger edge based on the Stripe subscription status. On the
 * platform-capital fallback rail, also settles the charge internally.
 */
async function handleGroupSubscriptionUpsert(stripeSub: Stripe.Subscription) {
  const memberAgentId = stripeSub.metadata?.memberAgentId;
  const groupId = stripeSub.metadata?.groupId;
  const planId = stripeSub.metadata?.planId;
  if (!memberAgentId || !groupId || !planId) {
    console.warn('Group subscription missing metadata, skipping:', stripeSub.id);
    return;
  }

  const customerId =
    typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
  const priceId = stripeSub.items.data[0]?.price?.id;
  if (!priceId) {
    console.warn('Group subscription has no price, skipping:', stripeSub.id);
    return;
  }

  const settlementRail =
    stripeSub.metadata?.settlementRail === 'connect' ? 'connect' : 'platform_capital';
  const applicationFeeCents =
    Number.parseInt(stripeSub.metadata?.applicationFeeCents ?? '0', 10) || 0;
  const connectAccountId = stripeSub.metadata?.stripeConnectAccountId ?? null;

  const periodStartUnix = stripeSub.items.data[0].current_period_start;
  const periodEndUnix = stripeSub.items.data[0].current_period_end;
  const currentPeriodStart = new Date(periodStartUnix * 1000);
  const currentPeriodEnd = new Date(periodEndUnix * 1000);
  const now = new Date();

  const values = {
    agentId: memberAgentId,
    groupId,
    planId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
    stripePriceId: priceId,
    status: stripeSub.status as typeof groupMembershipSubscriptions.$inferInsert.status,
    settlementRail:
      settlementRail as typeof groupMembershipSubscriptions.$inferInsert.settlementRail,
    stripeConnectAccountId: connectAccountId,
    applicationFeeCents,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    updatedAt: now,
  };

  const [existing] = await db
    .select({ id: groupMembershipSubscriptions.id })
    .from(groupMembershipSubscriptions)
    .where(eq(groupMembershipSubscriptions.stripeSubscriptionId, stripeSub.id))
    .limit(1);

  if (existing) {
    await db
      .update(groupMembershipSubscriptions)
      .set(values)
      .where(eq(groupMembershipSubscriptions.id, existing.id));
  } else {
    await db.insert(groupMembershipSubscriptions).values({ ...values, createdAt: now });
  }

  const isActive = stripeSub.status === 'active' || stripeSub.status === 'trialing';
  if (isActive) {
    await grantGroupMembership({
      memberAgentId,
      groupId,
      planId,
      source: 'subscription',
      expiresAt: currentPeriodEnd,
      stripeSubscriptionId: stripeSub.id,
    });

  } else {
    await revokeGroupMembership({ memberAgentId, groupId });
  }
}

function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentSubscription = invoice.parent?.subscription_details?.subscription;
  if (typeof parentSubscription === 'string') return parentSubscription;
  if (parentSubscription && typeof parentSubscription === 'object') {
    return parentSubscription.id;
  }

  const legacySubscription = (
    invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    }
  ).subscription;
  if (typeof legacySubscription === 'string') return legacySubscription;
  return legacySubscription?.id ?? null;
}

function getInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  for (const payment of invoice.payments?.data ?? []) {
    if (payment.status !== 'paid') continue;
    const paymentIntent = payment.payment.payment_intent;
    if (typeof paymentIntent === 'string') return paymentIntent;
    if (paymentIntent && typeof paymentIntent === 'object') return paymentIntent.id;
  }
  return null;
}

async function handlePaidInvoice(invoice: Stripe.Invoice): Promise<void> {
  if (invoice.status !== 'paid' || invoice.amount_paid <= 0) return;

  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const [subscription] = await db
    .select({
      memberAgentId: groupMembershipSubscriptions.agentId,
      groupId: groupMembershipSubscriptions.groupId,
      planId: groupMembershipSubscriptions.planId,
      settlementRail: groupMembershipSubscriptions.settlementRail,
      applicationFeeCents: groupMembershipSubscriptions.applicationFeeCents,
    })
    .from(groupMembershipSubscriptions)
    .where(eq(groupMembershipSubscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (!subscription) {
    throw new Error(
      `Paid invoice ${invoice.id} arrived before its local group subscription record`,
    );
  }

  const canonicalInvoice = invoice;
  const paymentIntentId = getInvoicePaymentIntentId(canonicalInvoice);
  if (!paymentIntentId) {
    throw new Error(
      `Paid invoice ${invoice.id} must be forwarded by Global with its payment intent`,
    );
  }
  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(paymentIntentId);
  const preTaxInvoiceCents =
    canonicalInvoice.total_excluding_tax ??
    canonicalInvoice.subtotal_excluding_tax ??
    canonicalInvoice.subtotal;
  const grossCents = Math.max(
    0,
    Math.min(canonicalInvoice.amount_paid, preTaxInvoiceCents),
  );
  if (grossCents <= 0) return;

  const applicationFeeCents = Math.min(
    grossCents,
    Math.max(0, subscription.applicationFeeCents),
  );

  if (subscription.settlementRail === 'platform_capital') {
    await settleGroupSubscriptionCapital({
      invoice: canonicalInvoice,
      subscriptionId,
      groupId: subscription.groupId,
      grossCents,
      applicationFeeCents,
      paymentIntentId,
      payoutEligibleAt,
    });
  }

  await recordMemberDuesReceipt({
    invoice: canonicalInvoice,
    subscriptionId,
    memberAgentId: subscription.memberAgentId,
    groupId: subscription.groupId,
    planId: subscription.planId,
    grossCents,
    applicationFeeCents,
    paymentIntentId,
  });
}

/**
 * Writes the paying member's own record of a group-membership dues charge.
 *
 * Group subscriptions previously wrote only GROUP-side rows
 * ({@link settleGroupSubscriptionCapital} credits the group + platform
 * wallets), so a member who paid dues saw NOTHING in their personal wallet
 * history (persona finding, 2026-07-07). This mirrors the marketplace-purchase
 * shape — a completed `marketplace_purchase` `walletTransactions` row on the
 * member's PERSONAL wallet — so the charge appears as an outgoing line in the
 * member's Transaction History. A marketplace `receipt` resource is
 * deliberately NOT written: `ReceiptCard` / `/marketplace/<id>/receipt` are
 * hard-coupled to a marketplace listing and would render a broken card for a
 * subscription with no listing.
 *
 * Idempotent per billing cycle via `duesReceiptCycleKey` (`subId:periodStart`),
 * so the `created`/`updated` webhooks and Stripe retries within one period write
 * exactly one receipt, while each renewal (new period → new key) writes one
 * more. The member's wallet BALANCE is intentionally NOT touched: dues are
 * card-funded, so this is a history/receipt log row, never an internal debit.
 */
async function recordMemberDuesReceipt(params: {
  invoice: Stripe.Invoice;
  subscriptionId: string;
  memberAgentId: string;
  groupId: string;
  planId: string;
  grossCents: number;
  applicationFeeCents: number;
  paymentIntentId: string | null;
}): Promise<void> {
  const {
    invoice,
    subscriptionId,
    memberAgentId,
    groupId,
    planId,
    grossCents,
    applicationFeeCents,
    paymentIntentId,
  } = params;

  const memberWallet = await getOrCreateWallet(memberAgentId, 'personal');

  const [group] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, groupId))
    .limit(1);
  const groupLabel = group?.name ?? 'group';

  await db
    .insert(walletTransactions)
    .values({
      type: 'marketplace_purchase',
      fromWalletId: memberWallet.id,
      amountCents: invoice.amount_paid,
      feeCents: applicationFeeCents,
      currency: invoice.currency,
      stripePaymentIntentId: `stripe-invoice-receipt:${invoice.id}`,
      description: `Membership dues — ${groupLabel}`,
      referenceType: 'agent',
      referenceId: groupId,
      status: 'completed',
      metadata: {
        source: 'group_membership_dues',
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: invoice.id,
        paymentIntentId,
        grossCents,
        taxCents: Math.max(0, invoice.amount_paid - grossCents),
        groupId,
        planId,
        memberAgentId,
      },
    })
    // `wallet_transactions_stripe_pi_idx` is a PARTIAL unique index (WHERE
    // stripe_payment_intent_id IS NOT NULL, migration 0014); ON CONFLICT only
    // matches it when the inference clause carries the same predicate.
    .onConflictDoNothing({
      target: walletTransactions.stripePaymentIntentId,
      where: sql`stripe_payment_intent_id IS NOT NULL`,
    });
}

/**
 * Internal settlement for the platform-capital fallback rail. Credits the
 * group's settlement wallet with the net (gross minus platform fee) and the
 * platform wallet with the fee, mirroring the marketplace capital pattern.
 * Idempotent per paid invoice via durable invoice identifiers on the entries.
 */
async function settleGroupSubscriptionCapital(params: {
  invoice: Stripe.Invoice;
  subscriptionId: string;
  groupId: string;
  grossCents: number;
  applicationFeeCents: number;
  paymentIntentId: string | null;
  payoutEligibleAt: string | null;
}): Promise<void> {
  const {
    invoice,
    subscriptionId,
    groupId,
    grossCents,
    applicationFeeCents,
    paymentIntentId,
    payoutEligibleAt,
  } = params;

  const groupWallet = await getSettlementWalletForAgent(groupId);
  // A self-hosted SOVEREIGN group settling its OWN dues has no hosted-platform
  // intermediary — `PLATFORM_AGENT_ID` is unset there. Resolving the platform
  // wallet UNCONDITIONALLY used to throw on such instances, aborting the whole
  // settlement so the group's own net credit never landed either (toybox
  // campaign 2026-07-11: dues marked active, treasury never credited). Resolve
  // it lazily; when there is no sink, the fee is NOT skimmed and the group is
  // credited the full gross.
  const platformWallet = applicationFeeCents > 0 ? await getPlatformWalletOrNull() : null;
  const effectiveFeeCents = platformWallet ? applicationFeeCents : 0;
  const groupNetCents = Math.max(0, grossCents - effectiveFeeCents);
  const currency = invoice.currency;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${invoice.id}, 0))`);
    const [existingSettlement] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(
        eq(
          walletTransactions.stripePaymentIntentId,
          `stripe-invoice-settlement:${invoice.id}`,
        ),
      )
      .limit(1);
    if (existingSettlement) return;

    await lockWallets(tx, [groupWallet.id, platformWallet?.id]);

    const [groupTx] = await tx
      .insert(walletTransactions)
      .values({
        type: 'group_deposit',
        toWalletId: groupWallet.id,
        amountCents: groupNetCents,
        feeCents: effectiveFeeCents,
        currency,
        stripePaymentIntentId: `stripe-invoice-settlement:${invoice.id}`,
        description: `Paid group membership invoice ${invoice.id}`,
        referenceType: 'agent',
        referenceId: groupId,
        status: 'completed',
        metadata: {
          source: 'group_membership_subscription',
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subscriptionId,
          paymentIntentId,
          groupId,
        },
      })
      .returning({ id: walletTransactions.id });

    if (groupNetCents > 0) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${groupNetCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, groupWallet.id));

      await creditWalletCapital(tx, groupWallet.id, groupNetCents, {
        settlementStatus: 'pending',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'group_membership_subscription',
        sourceTransactionId: groupTx.id,
        metadata: {
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subscriptionId,
          paymentIntentId,
          groupId,
          side: 'group_net',
        },
      });
    }

    if (platformWallet && effectiveFeeCents > 0) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${effectiveFeeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, platformWallet.id));

      const [feeTx] = await tx
        .insert(walletTransactions)
        .values({
          type: 'service_fee',
          toWalletId: platformWallet.id,
          amountCents: effectiveFeeCents,
          feeCents: 0,
          currency,
          description: `Platform fee for group membership subscription ${subscriptionId}`,
          referenceType: 'agent',
          referenceId: groupId,
          status: 'completed',
          metadata: {
            source: 'group_membership_subscription_platform_fee',
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: subscriptionId,
            paymentIntentId,
            groupId,
          },
        })
        .returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, platformWallet.id, effectiveFeeCents, {
        settlementStatus: 'pending',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'group_membership_subscription_platform_fee',
        sourceTransactionId: feeTx.id,
        metadata: {
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subscriptionId,
          paymentIntentId,
          groupId,
          side: 'platform_fee',
        },
      });
    }
  });
}

/**
 * Marks a group membership subscription canceled and revokes the member's
 * group-membership ledger edge.
 */
async function handleGroupSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  await db
    .update(groupMembershipSubscriptions)
    .set({ status: 'canceled', cancelAtPeriodEnd: true, updatedAt: new Date() })
    .where(eq(groupMembershipSubscriptions.stripeSubscriptionId, stripeSub.id));

  const memberAgentId = stripeSub.metadata?.memberAgentId;
  const groupId = stripeSub.metadata?.groupId;
  if (memberAgentId && groupId) {
    await revokeGroupMembership({ memberAgentId, groupId });
  }
}

/**
 * Confirms a wallet deposit after Stripe payment_intent.succeeded.
 */
async function handleWalletDepositSucceeded(paymentIntentId: string) {
  try {
    await confirmDeposit(paymentIntentId);
  } catch (err) {
    // Re-throw to preserve webhook failure semantics and trigger Stripe retry behavior.
    console.error('Failed to confirm wallet deposit for PI:', paymentIntentId, err);
    throw err;
  }
}

/**
 * Marks a wallet deposit as failed after Stripe payment_intent.payment_failed.
 */
async function handleWalletDepositFailed(paymentIntentId: string) {
  try {
    await failDeposit(paymentIntentId);
  } catch (err) {
    // Re-throw so transient DB failures are retried by Stripe instead of being silently dropped.
    console.error('Failed to mark wallet deposit as failed for PI:', paymentIntentId, err);
    throw err;
  }
}

/**
 * Handles offering purchase completion via Connect destination charge.
 * Records the transaction and creates a notification for the seller.
 */
async function handleOfferingPurchaseSucceeded(pi: Stripe.PaymentIntent) {
  const metadata = pi.metadata ?? {};
  const offeringId = metadata.offeringId;
  const buyerId = metadata.buyerId;
  const sellerId = metadata.sellerId;

  if (!offeringId || !buyerId || !sellerId) {
    console.warn('Offering purchase PI missing required metadata:', pi.id);
    return;
  }

  const totalCents = Number(metadata.totalCents ?? pi.amount ?? 0);
  const platformFeeCents = Number(metadata.platformFeeCents ?? 0);
  const requestedQuantity = Number(metadata.quantity ?? 1);
  const bookingSelection =
    metadata.bookingDate && metadata.bookingSlot
      ? { date: metadata.bookingDate, slot: metadata.bookingSlot }
      : null;

  // Reconcile metadata amounts against Stripe's authoritative charge
  assertAmountReconciled(pi.amount, totalCents, `offering:${pi.id}`);

  // Idempotency guard
  const [existingTx] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.stripePaymentIntentId, pi.id))
    .limit(1);

  if (existingTx) return;

  // Rail gate (COM-DSN-002): a destination charge has already moved real funds
  // to the seller's Connect account (createProvidePaymentAction sets
  // transfer_data + settlementRail='connect'). Crediting the seller's internal
  // balance/capital on top would mint unbacked in-platform currency. So,
  // mirroring handleGroupSubscriptionUpsert's connect rail, we record an
  // audit-only ledger + wallet_transactions row and skip internal settlement.
  // Only a platform-capital offering (no Connect destination, RIVR collected the
  // full charge) settles internally. `pi.transfer_data.destination` is the
  // authoritative signal — it reflects how Stripe actually routed the money.
  const externallySettled =
    Boolean(pi.transfer_data?.destination) || metadata.settlementRail === 'connect';

  const payoutEligibleAt = externallySettled
    ? null
    : await getPaymentIntentPayoutEligibleAt(pi.id);
  const platformWallet = await getPlatformWallet();
  const sellerCreditCents = Number(metadata.subtotalCents ?? 0);
  const platformRevenueCents = Math.max(0, totalCents - sellerCreditCents);

  // Distribute the seller-net across the project treasury + downstream
  // recipients when the offering is project-bound; otherwise credit the seller.
  // Only resolved/needed on the internal (platform-capital) rail.
  let settlementTargets: Awaited<ReturnType<typeof resolveSettlementTargets>> = [];
  if (!externallySettled) {
    const settlementProjectId = await getResourceProjectId(offeringId);
    const settlementSplits = await resolveSettlementSplits({
      sellerId,
      buyerId,
      listingMeta: settlementProjectId ? { projectId: settlementProjectId } : {},
    });
    settlementTargets = await resolveSettlementTargets(settlementSplits);
  }

  await db.transaction(async (tx) => {
    const [existingInTx] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, pi.id))
      .limit(1);

    if (existingInTx) return;

    await incrementListingInventory(tx, offeringId, requestedQuantity, bookingSelection);
    // Only lock the wallets we are about to credit. On the externally-settled
    // (Connect) rail no internal balances move, so no locks are taken.
    if (!externallySettled) {
      await lockWallets(tx, [
        ...settlementTargets.map((t) => t.wallet.id),
        platformWallet.id,
      ]);
    }

    // Create ledger entry for the purchase
    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'buy',
        subjectId: buyerId,
        objectId: sellerId,
        objectType: 'agent',
        metadata: {
          interactionType: 'offering-purchase',
          paymentIntentId: pi.id,
          offeringId,
          subtotalCents: Number(metadata.subtotalCents ?? 0),
          platformFeeCents,
          totalCents,
          quantity: requestedQuantity,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    // Record wallet transaction
    await tx.insert(walletTransactions).values({
      type: 'marketplace_purchase',
      amountCents: totalCents,
      feeCents: platformFeeCents,
      currency: 'usd',
      description: `Offering purchase: ${offeringId}`,
      stripePaymentIntentId: pi.id,
      referenceType: 'resource',
      referenceId: offeringId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
      metadata: {
        offeringId,
        buyerId,
        sellerId,
        quantity: requestedQuantity,
        bookingDate: bookingSelection?.date ?? null,
        bookingSlot: bookingSelection?.slot ?? null,
        type: 'offering_purchase',
      },
    });

    // Internal settlement runs ONLY on the platform-capital rail. On the
    // externally-settled (Connect destination) rail the money already reached
    // the seller's bank, so the ledger + wallet_transactions rows above are the
    // audit trail and we credit no internal balance/capital (COM-DSN-002).
    if (!externallySettled) {
      await settleSellerNet(tx, settlementTargets, sellerCreditCents, payoutEligibleAt, {
        currency: 'usd',
        referenceId: offeringId,
        ledgerEntryId: ledgerEntry.id,
        paymentIntentId: pi.id,
        sourceType: 'stripe_offering_purchase',
        descriptionPrefix: 'Offering settlement for',
      });

      if (platformRevenueCents > 0) {
        await tx
          .update(wallets)
          .set({
            balanceCents: sql`${wallets.balanceCents} + ${platformRevenueCents}`,
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, platformWallet.id));

        const [platformFeeTx] = await tx.insert(walletTransactions).values({
          type: 'service_fee',
          toWalletId: platformWallet.id,
          amountCents: platformRevenueCents,
          feeCents: 0,
          currency: 'usd',
          description: `Platform fee for offering purchase ${offeringId}`,
          referenceType: 'resource',
          referenceId: offeringId,
          ledgerEntryId: ledgerEntry.id,
          status: 'completed',
          metadata: {
            source: 'stripe_offering_purchase',
            paymentIntentId: pi.id,
            offeringId,
            platformFeeCents,
          },
        }).returning({ id: walletTransactions.id });

        await creditWalletCapital(tx, platformWallet.id, platformRevenueCents, {
          settlementStatus: 'pending',
          availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
          sourceType: 'stripe_offering_platform_fee',
          sourceTransactionId: platformFeeTx.id,
          metadata: {
            paymentIntentId: pi.id,
            stripePaymentIntentId: pi.id,
            offeringId,
          },
        });
      }
    }

    // Create notification for seller
    await tx.insert(ledger).values({
      verb: 'buy',
      subjectId: buyerId,
      objectId: sellerId,
      objectType: 'agent',
      isActive: true,
      metadata: {
        kind: 'offering-purchase',
        offeringId,
        amountCents: totalCents,
        message: 'purchased your offering',
      },
    } as NewLedgerEntry);

    // Create receipt resource for buyer's purchase history
    await tx.insert(resources).values({
      name: `Receipt: ${offeringId}`,
      type: 'receipt',
      ownerId: buyerId,
      description: `Purchase receipt for offering ${offeringId}`,
      metadata: {
        originalListingId: offeringId,
        buyerAgentId: buyerId,
        sellerAgentId: sellerId,
        stripePaymentIntentId: pi.id,
        priceCents: Number(metadata.subtotalCents ?? 0),
        platformFeeCents,
        totalCents,
        feeCents: platformFeeCents,
        quantity: requestedQuantity,
        bookingDate: bookingSelection?.date ?? null,
        bookingSlot: bookingSelection?.slot ?? null,
        purchasedAt: new Date().toISOString(),
        status: 'completed',
        currency: 'usd',
      },
    });
  });
}

/**
 * Handles Stripe account.updated events for Connect accounts.
 * Updates wallet metadata with the latest account status.
 */
async function handleAccountUpdated(account: Stripe.Account) {
  const walletId = account.metadata?.walletId;
  if (!walletId) return;

  try {
    const [wallet] = await db
      .select({ id: wallets.id, metadata: wallets.metadata })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);

    if (!wallet) return;

    const existingMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(wallets)
      .set({
        metadata: {
          ...existingMeta,
          stripeConnectAccountId: account.id,
          connectChargesEnabled: account.charges_enabled,
          connectPayoutsEnabled: account.payouts_enabled,
          connectDetailsSubmitted: account.details_submitted,
          connectStatusUpdatedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));
  } catch (err) {
    console.error('handleAccountUpdated failed for account:', account.id, err);
  }
}

/**
 * Finalizes a connect_payout wallet transaction status based on Stripe payout lifecycle events.
 */
async function handlePayoutStatusUpdate(
  payout: Stripe.Payout,
  newStatus: 'completed' | 'failed'
) {
  try {
    await db
      .update(walletTransactions)
      .set({
        status: newStatus,
      })
      .where(
        and(
          eq(walletTransactions.type, 'connect_payout'),
          eq(walletTransactions.status, 'pending'),
          sql`${walletTransactions.metadata}->>'stripePayoutId' = ${payout.id}`
        )
      );
  } catch (err) {
    console.error('handlePayoutStatusUpdate failed for payout:', payout.id, err);
  }
}
