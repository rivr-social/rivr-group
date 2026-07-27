/**
 * @module lib/marketplace-settlement
 *
 * Marketplace purchase settlement — the accounting orchestration previously
 * trapped inside the Stripe webhook route. The webhook now adapts a verified
 * Stripe Checkout Session into a {@link MarketplaceSettlementInput}; the
 * federated settlement receiver adapts a Global settlement notice into the
 * SAME input. Both lanes credit the local ledger through this one function, so
 * a mediated sale settles IDENTICALLY to a local one.
 *
 * Idempotency: `paymentIntentId` is the settlement reference. One checkout
 * obligation maps to exactly one Stripe session (Global's checkout creation is
 * idempotent on the obligation id), so one payment intent — the existing
 * `wallet_transactions.stripe_payment_intent_id` guard therefore also makes
 * the federated receiver idempotent per obligation.
 */
import { db } from '@/db';
import {
  agents,
  ledger,
  resources,
  wallets,
  walletTransactions,
  type NewLedgerEntry,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getPlatformWallet, getSettlementWalletForAgent, creditWalletCapital } from '@/lib/wallet';
import { resolveSettlementSplits } from '@/lib/settlement-splits';
import {
  getResourceProjectId,
  incrementListingInventory,
  lockWallets,
  resolveSettlementTargets,
  settleSellerNet,
} from '@/lib/settlement-accounting';

export interface MarketplaceSettlementInput {
  listingId: string;
  sellerAgentId: string;
  /** Server-derived buyer, or null for an unattributed guest purchase. */
  buyerAgentId: string | null;
  orgId: string | null;
  orgCommissionCents: number;
  /** RIVR margin component of the buyer fee (metadata `platformFeeCents`). */
  platformFeeCents: number;
  /** Full buyer-paid fee (metadata `buyerPlatformFeeCents`). */
  buyerPlatformFeeCents: number;
  /** Seller face value; the amount the seller-net cascade distributes. */
  priceCents: number;
  /** Pre-tax buyer total (face + buyer fee) the fees were derived from. */
  buyerTotalCents: number;
  quantity: number;
  bookingSelection: { date: string; slot: string } | null;
  /** What was ACTUALLY charged (tax-inclusive), from Stripe's own totals. */
  chargedTotalCents: number;
  taxCents: number;
  currency: string;
  checkoutSessionId: string;
  /** Settlement reference + idempotency key. Required on every lane. */
  paymentIntentId: string;
  payoutEligibleAt: string | null;
  /** Buyer identity Stripe collected; used only for the receipt record. */
  customerEmail: string | null;
  customerName: string | null;
  /** Present when the sale settled via Global mediation; audit-only. */
  federatedObligationId?: string;
}

/**
 * Resolves a guest checkout to a local buyer agent from the identity Stripe
 * collected. Reuses an existing agent only when it is a genuine guest (no
 * password, no verified email) — a registered user's account is never silently
 * assigned a guest purchase.
 */
export async function resolveGuestBuyerAgentId(
  guestEmail: string,
  guestNameRaw: string | null,
): Promise<string | null> {
  const guestName = guestNameRaw || `Guest (${guestEmail})`;

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
      return existingAgent.id;
    }
    // Real registered user — do not silently reuse their account for a guest purchase
    console.warn('Guest checkout email matches registered user, skipping reuse:', guestEmail);
    return null;
  }

  const [newAgent] = await db
    .insert(agents)
    .values({
      name: guestName,
      type: 'person',
      email: guestEmail,
      metadata: { source: 'guest_checkout', noSignin: true },
    })
    .returning({ id: agents.id });
  return newAgent.id;
}

/**
 * Settles a completed marketplace purchase into the local ledger: inventory,
 * purchase ledger entry + wallet transaction, seller-net cascade (project
 * splits included), org commission, platform revenue, seller notification, and
 * the buyer's receipt. Exactly the accounting the Stripe webhook has always
 * performed — extracted so the federated receiver can perform it too.
 *
 * Idempotent on `paymentIntentId`: an already-settled reference returns
 * without writing.
 */
export async function settleMarketplacePurchase(
  input: MarketplaceSettlementInput,
): Promise<{ settled: boolean }> {
  const {
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
    chargedTotalCents,
    taxCents,
    currency,
    checkoutSessionId,
    paymentIntentId,
    payoutEligibleAt,
  } = input;

  // Idempotency guard
  const [existingTx] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (existingTx) return { settled: false };

  const orgWallet = orgId ? await getSettlementWalletForAgent(orgId) : null;
  const platformWallet = await getPlatformWallet();
  const sellerCreditCents = priceCents;
  const platformRevenueCents = Math.max(0, buyerTotalCents - sellerCreditCents - orgCommissionCents);

  // Resolve how the seller-net is distributed. When the listing is bound to a
  // project (server-trusted `metadata.projectId`), the seller-net cascades to
  // the project treasury + configured downstream recipients; otherwise it is a
  // single split crediting the seller 100%.
  const settlementProjectId = await getResourceProjectId(listingId);
  const settlementSplits = await resolveSettlementSplits({
    sellerId: sellerAgentId,
    buyerId: buyerAgentId,
    listingMeta: settlementProjectId ? { projectId: settlementProjectId } : {},
  });
  const settlementTargets = await resolveSettlementTargets(settlementSplits);

  await db.transaction(async (tx) => {
    // Re-check inside transaction for idempotency
    const [existingInTx] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (existingInTx) return;

    await incrementListingInventory(tx, listingId, requestedQuantity, bookingSelection);
    await lockWallets(tx, [
      ...settlementTargets.map((t) => t.wallet.id),
      orgWallet?.id,
      platformWallet.id,
    ]);

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
          checkoutSessionId,
          paymentIntentId,
          listingId,
          priceCents,
          quantity: requestedQuantity,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
          platformFeeCents,
          orgCommissionCents,
          orgId,
          ...(input.federatedObligationId
            ? { federatedObligationId: input.federatedObligationId }
            : {}),
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    // Record wallet transaction
    await tx.insert(walletTransactions).values({
      type: 'marketplace_purchase',
      amountCents: chargedTotalCents,
      feeCents: chargedTotalCents - sellerCreditCents,
      currency,
      description: `Marketplace purchase: ${listingId}`,
      stripePaymentIntentId: paymentIntentId,
      referenceType: 'resource',
      referenceId: listingId,
      ledgerEntryId: ledgerEntry.id,
      status: 'completed',
      metadata: {
        checkoutSessionId,
        listingId,
        buyerAgentId: buyerAgentId || null,
        sellerAgentId,
        quantity: requestedQuantity,
        bookingDate: bookingSelection?.date ?? null,
        bookingSlot: bookingSelection?.slot ?? null,
        orgId,
        purchaseType: 'marketplace_purchase',
        stripeTaxCents: taxCents,
        preTaxTotalCents: buyerTotalCents,
        ...(input.federatedObligationId
          ? { federatedObligationId: input.federatedObligationId }
          : {}),
      },
    });

    await settleSellerNet(tx, settlementTargets, sellerCreditCents, payoutEligibleAt, {
      currency,
      referenceId: listingId,
      ledgerEntryId: ledgerEntry.id,
      paymentIntentId,
      sourceType: 'stripe_marketplace_checkout',
      descriptionPrefix: 'Marketplace settlement for listing',
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
        currency,
        description: `Org commission for listing ${listingId}`,
        referenceType: 'resource',
        referenceId: listingId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_marketplace_checkout',
          checkoutSessionId,
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
        currency,
        description: `Platform fee for marketplace purchase ${listingId}`,
        referenceType: 'resource',
        referenceId: listingId,
        ledgerEntryId: ledgerEntry.id,
        status: 'completed',
        metadata: {
          source: 'stripe_marketplace_checkout',
          checkoutSessionId,
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
          stripeCheckoutSessionId: checkoutSessionId,
          priceCents,
          platformFeeCents: buyerPlatformFeeCents,
          platformMarginCents: platformFeeCents,
          orgCommissionCents,
          preTaxTotalCents: buyerTotalCents,
          salesTaxCents: taxCents,
          totalCents: chargedTotalCents,
          feeCents: buyerPlatformFeeCents + taxCents,
          quantity: requestedQuantity,
          bookingDate: bookingSelection?.date ?? null,
          bookingSlot: bookingSelection?.slot ?? null,
          purchasedAt: new Date().toISOString(),
          status: 'completed',
          currency,
          orgId,
          customerEmail: input.customerEmail,
          customerName: input.customerName,
          ...(input.federatedObligationId
            ? { federatedObligationId: input.federatedObligationId }
            : {}),
        },
      });
    }
  });

  return { settled: true };
}
