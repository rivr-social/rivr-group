/**
 * @module lib/event-ticket-settlement
 *
 * Event-ticket purchase settlement — the accounting the Stripe webhook has
 * always performed for `purchaseType: 'event_ticket'`, extracted from the
 * route so the federated settlement receiver can perform the identical
 * crediting for a Global-mediated ticket sale.
 *
 * Idempotent on `paymentIntentId` via the same
 * `wallet_transactions.stripe_payment_intent_id` guard as marketplace
 * settlement (one obligation → one session → one payment intent).
 */
import { db } from '@/db';
import {
  ledger,
  wallets,
  walletTransactions,
  type NewLedgerEntry,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getPlatformWallet, getSettlementWalletForAgent, creditWalletCapital } from '@/lib/wallet';

export interface EventTicketSelection {
  ticketProductId: string;
  quantity: number;
  subtotalCents: number;
}

export interface EventTicketSettlementInput {
  eventId: string;
  ticketProductId: string;
  ticketSelections: EventTicketSelection[];
  buyerAgentId: string;
  organizerAgentId: string;
  /** Pre-tax buyer total the fee breakdown was computed from. */
  totalCents: number;
  subtotalCents: number;
  /**
   * Divisor for prorating the fee across selections — the webhook has always
   * used `metadata.subtotalCents ?? totalCents`, kept verbatim.
   */
  feeProrationBaseCents: number;
  platformFeeCents: number;
  legacySalesTaxCents: number;
  paymentFeeCents: number;
  /** What was ACTUALLY charged (tax-inclusive), from Stripe's own totals. */
  chargedTotalCents: number;
  taxCents: number;
  currency: string;
  checkoutSessionId: string;
  /** Settlement reference + idempotency key. Required on every lane. */
  paymentIntentId: string;
  payoutEligibleAt: string | null;
  /** Present when the sale settled via Global mediation; audit-only. */
  federatedObligationId?: string;
  /**
   * Organizer-declared admission tax collected with this sale. Settles to the
   * ORGANIZER inside the seller-net (it rides totalCents); stamped here so
   * the ledger separately states what the organizer owes their taxing
   * authority. RIVR never remits it.
   */
  organizerTaxCents?: number;
  organizerTaxName?: string;
}

/**
 * Settles a completed event-ticket purchase: purchase ledger entry, the
 * per-selection ticket transactions, the organizer's seller-net credit, and
 * the platform fee — identically for the local webhook lane and the federated
 * receiver lane.
 */
export async function settleEventTicketPurchase(
  input: EventTicketSettlementInput,
): Promise<{ settled: boolean }> {
  const {
    eventId,
    ticketProductId,
    ticketSelections,
    buyerAgentId,
    organizerAgentId,
    totalCents,
    subtotalCents,
    feeProrationBaseCents,
    platformFeeCents,
    legacySalesTaxCents,
    paymentFeeCents,
    chargedTotalCents,
    taxCents,
    currency,
    checkoutSessionId,
    paymentIntentId,
    payoutEligibleAt,
  } = input;

  const preTaxFeeCents = platformFeeCents + legacySalesTaxCents + paymentFeeCents;
  const sellerNetCents = totalCents - preTaxFeeCents;

  // Idempotency guard: check once before opening a transaction to short-circuit duplicates.
  const [existingTx] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (existingTx) {
    return { settled: false };
  }

  const organizerWallet = await getSettlementWalletForAgent(organizerAgentId);
  const platformWallet = preTaxFeeCents > 0 ? await getPlatformWallet() : null;

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
          checkoutSessionId,
          paymentIntentId,
          eventId,
          ...(input.organizerTaxCents
            ? {
                organizerTaxCents: input.organizerTaxCents,
                organizerTaxName: input.organizerTaxName ?? null,
                organizerTaxRemitsBy: 'organizer',
              }
            : {}),
          ticketProductId,
          subtotalCents,
          platformFeeCents,
          salesTaxCents: taxCents,
          legacySalesTaxCents,
          paymentFeeCents,
          preTaxTotalCents: totalCents,
          totalCents: chargedTotalCents,
          ...(input.federatedObligationId
            ? { federatedObligationId: input.federatedObligationId }
            : {}),
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    await tx.insert(walletTransactions).values({
      type: 'marketplace_purchase',
      amountCents: chargedTotalCents,
      feeCents: preTaxFeeCents + taxCents,
      currency,
      // Business traceability: description helps with back-office reconciliation.
      description: `Event ticket purchase for event ${eventId}`,
      stripePaymentIntentId: paymentIntentId,
      referenceType: 'resource',
      referenceId: ticketProductId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
      metadata: {
        checkoutSessionId,
        eventId,
        ticketProductId,
        buyerAgentId,
        organizerAgentId,
        ...(input.federatedObligationId
          ? { federatedObligationId: input.federatedObligationId }
          : {}),
      },
    });

    let remainingFeeCents = preTaxFeeCents;
    for (const [index, selection] of ticketSelections.entries()) {
      const lineFeeCents =
        index === ticketSelections.length - 1
          ? remainingFeeCents
          : Math.floor((preTaxFeeCents * selection.subtotalCents) / Math.max(1, feeProrationBaseCents));
      remainingFeeCents -= lineFeeCents;

      await tx.insert(walletTransactions).values({
        type: 'event_ticket',
        amountCents: selection.subtotalCents + lineFeeCents,
        feeCents: lineFeeCents,
        currency,
        description: `Event ticket purchase for event ${eventId}`,
        referenceType: 'resource',
        referenceId: selection.ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          checkoutSessionId,
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
        currency,
        description: `Stripe ticket settlement for event ${eventId}`,
        referenceType: 'resource',
        referenceId: ticketSelections[0]?.ticketProductId ?? ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_event_ticket',
          checkoutSessionId,
          paymentIntentId,
          organizerAgentId,
          eventId,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, organizerWallet.id, sellerNetCents, {
        settlementStatus: 'pending',
        availableOn: payoutEligibleAt ? new Date(payoutEligibleAt) : null,
        sourceType: 'stripe_event_ticket',
        sourceTransactionId: sellerPayoutTx.id,
        metadata: {
          eventId,
          paymentIntentId,
        },
      });
    }

    if (preTaxFeeCents > 0 && platformWallet) {
      await tx
        .update(wallets)
        .set({
          balanceCents: sql`${wallets.balanceCents} + ${preTaxFeeCents}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, platformWallet.id));

      const [platformFeeTx] = await tx.insert(walletTransactions).values({
        type: 'service_fee',
        toWalletId: platformWallet.id,
        amountCents: preTaxFeeCents,
        feeCents: 0,
        currency,
        description: `Service fee for event ticket ${eventId}`,
        referenceType: 'resource',
        referenceId: ticketProductId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_event_ticket',
          checkoutSessionId,
          paymentIntentId,
          organizerAgentId,
          eventId,
        },
      }).returning({ id: walletTransactions.id });

      await creditWalletCapital(tx, platformWallet.id, preTaxFeeCents, {
        settlementStatus: 'pending',
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

  return { settled: true };
}
