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
import { agents, capitalEntries, ledger, resources, subscriptions, wallets, walletTransactions, type NewLedgerEntry } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getStripe, tierForPriceId } from '@/lib/billing';
import {
  confirmDeposit,
  failDeposit,
  getPlatformWallet,
  getSettlementWalletForAgent,
  creditWalletCapital,
} from '@/lib/wallet';
import { STATUS_BAD_REQUEST, STATUS_INTERNAL_ERROR } from '@/lib/http-status';
import { consumeBookingSlot, isBookingSlotAvailable } from '@/lib/booking-slots';
import { assertAmountReconciled } from '@/lib/stripe-reconcile';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const MONTHLY_SUBSCRIPTION_THANKS_GRANT = 100;

function getInventoryState(metadata: Record<string, unknown>): {
  quantityAvailable: number | null;
  quantitySold: number;
  quantityRemaining: number | null;
} {
  const quantityAvailable =
    typeof metadata.quantityAvailable === 'number' && Number.isFinite(metadata.quantityAvailable)
      ? metadata.quantityAvailable
      : null;
  const quantitySold =
    typeof metadata.quantitySold === 'number' && Number.isFinite(metadata.quantitySold)
      ? metadata.quantitySold
      : 0;
  const quantityRemaining =
    typeof metadata.quantityRemaining === 'number' && Number.isFinite(metadata.quantityRemaining)
      ? metadata.quantityRemaining
      : quantityAvailable != null
        ? Math.max(quantityAvailable - quantitySold, 0)
        : null;

  return { quantityAvailable, quantitySold, quantityRemaining };
}

function sortedUniqueWalletIds(walletIds: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      walletIds.filter(
        (walletId): walletId is string => typeof walletId === 'string' && walletId.length > 0,
      ),
    ),
  ).sort();
}

async function lockWallets(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  walletIds: Array<string | null | undefined>,
): Promise<void> {
  for (const walletId of sortedUniqueWalletIds(walletIds)) {
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
  }
}

async function incrementListingInventory(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  resourceId: string,
  requestedQuantity: number,
  bookingSelection?: { date: string; slot: string } | null,
): Promise<void> {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) return;

  // Lock the row to prevent concurrent webhooks from reading stale inventory
  const [resource] = await tx.execute(
    sql`SELECT metadata FROM resources WHERE id = ${resourceId} LIMIT 1 FOR UPDATE`
  ) as unknown as { metadata: Record<string, unknown> }[];

  const metadata = (resource?.metadata ?? {}) as Record<string, unknown>;
  if (!isBookingSlotAvailable(metadata, bookingSelection)) {
    throw new Error(`Booking slot unavailable for resource ${resourceId}`);
  }
  const { quantityAvailable, quantitySold, quantityRemaining } = getInventoryState(metadata);
  if (quantityAvailable == null && !bookingSelection) return;

  if (quantityAvailable != null && requestedQuantity > (quantityRemaining ?? 0)) {
    throw new Error(`Inventory exceeded for resource ${resourceId}`);
  }

  const nextQuantitySold = quantitySold + requestedQuantity;
  const nextQuantityRemaining =
    quantityAvailable != null ? Math.max(quantityAvailable - nextQuantitySold, 0) : null;
  const nextMetadata = consumeBookingSlot(metadata, bookingSelection);

  await tx
    .update(resources)
    .set({
      metadata: {
        ...nextMetadata,
        ...(quantityAvailable != null
          ? {
              quantityAvailable,
              quantitySold: nextQuantitySold,
              quantityRemaining: nextQuantityRemaining,
              ...(nextQuantityRemaining === 0 ? { status: 'sold_out' } : {}),
            }
          : {}),
      },
    })
    .where(eq(resources.id, resourceId));
}

async function getPaymentIntentPayoutEligibleAt(paymentIntentId: string): Promise<string | null> {
  try {
    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });

    const latestCharge =
      paymentIntent.latest_charge && typeof paymentIntent.latest_charge !== 'string'
        ? paymentIntent.latest_charge
        : null;
    const balanceTransaction =
      latestCharge?.balance_transaction &&
      typeof latestCharge.balance_transaction !== 'string'
        ? latestCharge.balance_transaction
        : null;

    if (!balanceTransaction?.available_on) {
      return null;
    }

    return new Date(balanceTransaction.available_on * 1000).toISOString();
  } catch (error) {
    console.error('Failed to fetch payment intent payout eligibility:', paymentIntentId, error);
    return null;
  }
}

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

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
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

      case 'balance.available': {
        // Stripe cleared funds — flip matching pending capital entries to cleared
        const cleared = await db
          .update(capitalEntries)
          .set({
            settlementStatus: 'cleared',
            availableOn: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(capitalEntries.settlementStatus, 'pending'),
              sql`${capitalEntries.remainingCents} > 0`,
            ),
          )
          .returning({ id: capitalEntries.id });
        if (cleared.length > 0) {
          console.log(`[balance.available] Cleared ${cleared.length} pending capital entries`);
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
  const salesTaxCents = Number(metadata.salesTaxCents ?? 0);
  const paymentFeeCents = Number(metadata.paymentFeeCents ?? 0);
  const feeCents = platformFeeCents + salesTaxCents + paymentFeeCents;
  const sellerNetCents = totalCents - feeCents;

  // Reconcile metadata amounts against Stripe's authoritative charge
  assertAmountReconciled(session.amount_total ?? 0, totalCents, `event-ticket:${session.id}`);

  // Idempotency guard: check once before opening a transaction to short-circuit duplicates.
  const [existingTx] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (existingTx) {
    return;
  }

  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(paymentIntentId);
  const organizerWallet = await getSettlementWalletForAgent(organizerAgentId);
  const platformWallet = feeCents > 0 ? await getPlatformWallet() : null;
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

  await db.transaction(async (tx) => {
    // Re-check inside the transaction to avoid race conditions across concurrent webhook deliveries.
    const [existingInTx] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (existingInTx) return;

    for (const walletId of Array.from(new Set([
      organizerWallet.id,
      platformWallet?.id,
    ].filter((walletId): walletId is string => typeof walletId === 'string' && walletId.length > 0))).sort()) {
      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`);
    }

    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'buy',
        subjectId: buyerAgentId,
        objectId: organizerAgentId,
        objectType: 'agent',
        resourceId: ticketProductId,
        metadata: {
          interactionType: 'event-ticket-purchase',
          checkoutSessionId: session.id,
          paymentIntentId,
          eventId,
          ticketProductId,
          subtotalCents: Number(metadata.subtotalCents ?? 0),
          platformFeeCents,
          salesTaxCents,
          paymentFeeCents,
          totalCents,
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    await tx.insert(walletTransactions).values({
      type: 'marketplace_purchase',
      amountCents: totalCents,
      feeCents,
      currency: session.currency ?? 'usd',
      // Business traceability: description helps with back-office reconciliation.
      description: `Event ticket purchase for event ${eventId}`,
      stripePaymentIntentId: paymentIntentId,
      referenceType: 'resource',
      referenceId: ticketProductId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
      metadata: {
        checkoutSessionId: session.id,
        eventId,
        ticketProductId,
        buyerAgentId,
        organizerAgentId,
      },
    });

    let remainingFeeCents = feeCents;
    for (const [index, selection] of ticketSelections.entries()) {
      const lineFeeCents =
        index === ticketSelections.length - 1
          ? remainingFeeCents
          : Math.floor((feeCents * selection.subtotalCents) / Math.max(1, Number(metadata.subtotalCents ?? totalCents)));
      remainingFeeCents -= lineFeeCents;

      await tx.insert(walletTransactions).values({
        type: 'event_ticket',
        amountCents: selection.subtotalCents + lineFeeCents,
        feeCents: lineFeeCents,
        currency: session.currency ?? 'usd',
        description: `Event ticket purchase for event ${eventId}`,
        referenceType: 'resource',
        referenceId: selection.ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          checkoutSessionId: session.id,
          eventId,
          ticketProductId: selection.ticketProductId,
          buyerAgentId,
          organizerAgentId,
          quantity: selection.quantity,
        },
      });
    }

    if (sellerNetCents > 0) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${sellerNetCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, organizerWallet.id));

      const [sellerPayoutTx] = await tx.insert(walletTransactions).values({
        type: 'marketplace_payout',
        toWalletId: organizerWallet.id,
        amountCents: sellerNetCents,
        feeCents: 0,
        currency: session.currency ?? 'usd',
        description: `Stripe ticket settlement for event ${eventId}`,
        referenceType: 'resource',
        referenceId: ticketSelections[0]?.ticketProductId ?? ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_event_ticket',
          checkoutSessionId: session.id,
          paymentIntentId,
          organizerAgentId,
          eventId,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, organizerWallet.id, sellerNetCents, {
        settlementStatus: payoutEligibleAt ? 'pending' : 'cleared',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'stripe_event_ticket',
        sourceTransactionId: sellerPayoutTx.id,
        metadata: {
          eventId,
          paymentIntentId,
        },
      });
    }

    if (feeCents > 0 && platformWallet) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${feeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, platformWallet.id));

      const [platformFeeTx] = await tx.insert(walletTransactions).values({
        type: 'service_fee',
        toWalletId: platformWallet.id,
        amountCents: feeCents,
        feeCents: 0,
        currency: session.currency ?? 'usd',
        description: `Service fee for event ticket ${eventId}`,
        referenceType: 'resource',
        referenceId: ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_event_ticket',
          checkoutSessionId: session.id,
          paymentIntentId,
          organizerAgentId,
          eventId,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, platformWallet.id, feeCents, {
        settlementStatus: payoutEligibleAt ? 'pending' : 'cleared',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'stripe_event_ticket_fee',
        sourceTransactionId: platformFeeTx.id,
        metadata: {
          eventId,
          paymentIntentId,
        },
      });
    }
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

  // Reconcile metadata amounts against Stripe's authoritative charge
  assertAmountReconciled(session.amount_total ?? 0, buyerTotalCents, `marketplace:${session.id}`);

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

  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(paymentIntentId);
  const sellerWallet = await getSettlementWalletForAgent(sellerAgentId);
  const orgWallet = orgId ? await getSettlementWalletForAgent(orgId) : null;
  const platformWallet = await getPlatformWallet();
  const sellerCreditCents = priceCents;
  const platformRevenueCents = Math.max(0, buyerTotalCents - sellerCreditCents - orgCommissionCents);

  // Idempotency guard
  const [existingTx] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (existingTx) return;

  // If no buyer agent (guest checkout), create a guest agent from customer details.
  // Only reuse an existing agent if it's a genuine guest (no password, no email verification).
  // Never silently assign purchases to a registered user's account.
  if (!buyerAgentId && session.customer_details?.email) {
    const guestEmail = session.customer_details.email;
    const guestName =
      session.customer_details.name || `Guest (${guestEmail})`;

    const [existingAgent] = await db
      .select({
        id: agents.id,
        passwordHash: agents.passwordHash,
        emailVerified: agents.emailVerified,
      })
      .from(agents)
      .where(eq(agents.email, guestEmail))
      .limit(1);

    if (existingAgent) {
      const isGuest = !existingAgent.passwordHash && !existingAgent.emailVerified;
      if (isGuest) {
        buyerAgentId = existingAgent.id;
      } else {
        // Real registered user — do not silently reuse their account for a guest purchase
        console.warn('Guest checkout email matches registered user, skipping reuse:', guestEmail);
      }
    } else {
      const [newAgent] = await db
        .insert(agents)
        .values({
          name: guestName,
          type: 'person',
          email: guestEmail,
          metadata: { source: 'guest_checkout', noSignin: true },
        })
        .returning({ id: agents.id });
      buyerAgentId = newAgent.id;
    }
  }

  const totalFeeCents = platformFeeCents + orgCommissionCents;

  await db.transaction(async (tx) => {
    // Re-check inside transaction for idempotency
    const [existingInTx] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (existingInTx) return;

    await incrementListingInventory(tx, listingId, requestedQuantity, bookingSelection);
    await lockWallets(tx, [sellerWallet.id, orgWallet?.id, platformWallet.id]);

    // Create ledger entry for the purchase
    const [ledgerEntry] = await tx
      .insert(ledger)
      .values({
        verb: 'buy',
        subjectId: buyerAgentId || sellerAgentId,
        objectId: sellerAgentId,
        objectType: 'agent',
        resourceId: listingId,
        metadata: {
          interactionType: 'marketplace-purchase',
          checkoutSessionId: session.id,
          paymentIntentId,
          listingId,
          priceCents,
          quantity: requestedQuantity,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
          platformFeeCents,
          orgCommissionCents,
          orgId,
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    // Record wallet transaction
    await tx.insert(walletTransactions).values({
      type: 'marketplace_purchase',
      amountCents: buyerTotalCents,
      feeCents: buyerTotalCents - sellerCreditCents,
      currency: session.currency ?? 'usd',
      description: `Marketplace purchase: ${listingId}`,
      stripePaymentIntentId: paymentIntentId,
      referenceType: 'resource',
      referenceId: listingId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
      metadata: {
        checkoutSessionId: session.id,
        listingId,
        buyerAgentId: buyerAgentId || null,
        sellerAgentId,
        quantity: requestedQuantity,
        bookingDate: bookingSelection?.date ?? null,
        bookingSlot: bookingSelection?.slot ?? null,
        orgId,
        purchaseType: 'marketplace_purchase',
      },
    });

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${sellerCreditCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, sellerWallet.id));

    const [sellerPayoutTx] = await tx.insert(walletTransactions).values({
      type: 'marketplace_payout',
      toWalletId: sellerWallet.id,
      amountCents: sellerCreditCents,
      feeCents: 0,
      currency: session.currency ?? 'usd',
      description: `Marketplace settlement for listing ${listingId}`,
      referenceType: 'resource',
      referenceId: listingId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
        metadata: {
          source: 'stripe_marketplace_checkout',
          checkoutSessionId: session.id,
          paymentIntentId,
          sellerAgentId,
        listingId,
        payoutEligibleAt,
      },
    }).returning({ id: walletTransactions.id });

    await creditWalletCapital(tx, sellerWallet.id, sellerCreditCents, {
      settlementStatus: 'pending',
      availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
      sourceType: 'stripe_marketplace_checkout',
      sourceTransactionId: sellerPayoutTx.id,
      metadata: {
        paymentIntentId,
        stripePaymentIntentId: paymentIntentId,
        listingId,
      },
    });

    if (orgCommissionCents > 0 && orgWallet) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${orgCommissionCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, orgWallet.id));

      const [orgPayoutTx] = await tx.insert(walletTransactions).values({
        type: 'marketplace_payout',
        toWalletId: orgWallet.id,
        amountCents: orgCommissionCents,
        feeCents: 0,
        currency: session.currency ?? 'usd',
        description: `Org commission for listing ${listingId}`,
        referenceType: 'resource',
        referenceId: listingId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_marketplace_checkout',
          checkoutSessionId: session.id,
          paymentIntentId,
          orgId,
          listingId,
          payoutEligibleAt,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, orgWallet.id, orgCommissionCents, {
        settlementStatus: 'pending',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'stripe_marketplace_org_commission',
        sourceTransactionId: orgPayoutTx.id,
        metadata: {
          paymentIntentId,
          stripePaymentIntentId: paymentIntentId,
          listingId,
          orgId,
        },
      });
    }

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
        currency: session.currency ?? 'usd',
        description: `Platform fee for marketplace purchase ${listingId}`,
        referenceType: 'resource',
        referenceId: listingId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_marketplace_checkout',
          checkoutSessionId: session.id,
          paymentIntentId,
          listingId,
          buyerPlatformFeeCents,
          platformFeeCents,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, platformWallet.id, platformRevenueCents, {
        settlementStatus: 'pending',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'stripe_marketplace_platform_fee',
        sourceTransactionId: platformFeeTx.id,
        metadata: {
          paymentIntentId,
          stripePaymentIntentId: paymentIntentId,
          listingId,
        },
      });
    }

    // Create notification ledger entry for seller
    if (buyerAgentId) {
      await tx.insert(ledger).values({
        verb: 'buy',
        subjectId: buyerAgentId,
        objectId: sellerAgentId,
        objectType: 'agent',
        isActive: true,
        metadata: {
          kind: 'marketplace-purchase',
          listingId,
          amountCents: priceCents,
          message: 'purchased your listing',
        },
      } as NewLedgerEntry);
    }

    // Create receipt resource for buyer's purchase history
    if (buyerAgentId) {
      await tx.insert(resources).values({
        name: `Receipt: ${listingId}`,
        type: 'receipt',
        ownerId: buyerAgentId,
        description: `Purchase receipt for listing ${listingId}`,
        metadata: {
          originalListingId: listingId,
          buyerAgentId,
          sellerAgentId,
          stripePaymentIntentId: paymentIntentId,
          stripeCheckoutSessionId: session.id,
          priceCents,
          platformFeeCents: buyerPlatformFeeCents,
          platformMarginCents: platformFeeCents,
          orgCommissionCents,
          totalCents: buyerTotalCents,
          feeCents: buyerPlatformFeeCents,
          quantity: requestedQuantity,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
          purchasedAt: new Date().toISOString(),
          status: 'completed',
          currency: session.currency ?? 'usd',
          orgId,
          customerEmail: session.customer_details?.email || null,
          customerName: session.customer_details?.name || null,
        },
      });
    }
  });
}

/**
 * Upserts a subscription record from a Stripe subscription object.
 */
async function handleSubscriptionUpsert(stripeSub: Stripe.Subscription) {
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

  const payoutEligibleAt = await getPaymentIntentPayoutEligibleAt(pi.id);
  const sellerWallet = await getSettlementWalletForAgent(sellerId);
  const platformWallet = await getPlatformWallet();
  const sellerCreditCents = Number(metadata.subtotalCents ?? 0);
  const platformRevenueCents = Math.max(0, totalCents - sellerCreditCents);

  await db.transaction(async (tx) => {
    const [existingInTx] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, pi.id))
      .limit(1);

    if (existingInTx) return;

    await incrementListingInventory(tx, offeringId, requestedQuantity, bookingSelection);
    await lockWallets(tx, [sellerWallet.id, platformWallet.id]);

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

    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${sellerCreditCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, sellerWallet.id));

    const [sellerPayoutTx] = await tx.insert(walletTransactions).values({
      type: 'marketplace_payout',
      toWalletId: sellerWallet.id,
      amountCents: sellerCreditCents,
      feeCents: 0,
      currency: 'usd',
      description: `Offering settlement for ${offeringId}`,
      referenceType: 'resource',
      referenceId: offeringId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
        metadata: {
          source: 'stripe_offering_purchase',
          paymentIntentId: pi.id,
          sellerId,
        offeringId,
        payoutEligibleAt,
      },
    }).returning({ id: walletTransactions.id });

    await creditWalletCapital(tx, sellerWallet.id, sellerCreditCents, {
      settlementStatus: 'pending',
      availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
      sourceType: 'stripe_offering_purchase',
      sourceTransactionId: sellerPayoutTx.id,
      metadata: {
        paymentIntentId: pi.id,
        stripePaymentIntentId: pi.id,
        offeringId,
      },
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
