'use server';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agents, resources, type NewResource } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  BPS_DIVISOR,
} from '@/lib/wallet-constants';
import {
  getOrCreateWallet,
  getWalletBalance,
  purchaseFromWallet,
  getPlatformWallet,
  getSettlementWalletForAgent,
} from '@/lib/wallet';
import { calculateLegacyCheckoutFeesCents } from '@/lib/fees';
import { resolveMarketplaceFeePolicy } from '@/lib/marketplace-fees';
import { canView } from '@/lib/permissions';
import { resolvePostOfferingDeal } from '@/lib/post-offer-deals';
import { getResource } from '@/lib/queries/resources';
import { getAgent } from '@/lib/queries/agents';
import { getOrCreateStripeCustomer, getStripe } from '@/lib/billing';
import { consumeBookingSlot, hasBookableSchedule, isBookingSlotAvailable } from '@/lib/booking-slots';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getCurrentUserId } from './helpers';
import { isUuid, isPositiveInteger, getAcceptedCurrencies, getAvailableInventory } from './types';

type EventTicketSelectionInput = {
  ticketProductId: string;
  quantity: number;
}

type ResolvedEventTicketSelection = {
  ticketProductId: string;
  ticketName: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

export async function resolveTicketSelectionsForEvent(eventId: string, selections: EventTicketSelectionInput[]): Promise<{
  selections: ResolvedEventTicketSelection[];
  organizerAgentId: string;
  eventName: string;
  eventTargetType: 'resource' | 'agent';
}> {
  let organizerAgentId: string | null = null;
  let eventName = 'Event';
  let defaultTicketPrice = 0;
  let eventTargetType: 'resource' | 'agent' = 'resource';

  const eventResource = await getResource(eventId);
  if (eventResource && eventResource.type === 'event') {
    organizerAgentId = eventResource.ownerId;
    eventName = eventResource.name;
    eventTargetType = 'resource';
    const meta = (eventResource.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.price === 'number') defaultTicketPrice = meta.price;
  } else {
    const eventAgent = await getAgent(eventId);
    if (!eventAgent || eventAgent.type !== 'event') {
      throw new Error('Event not found.');
    }
    eventName = eventAgent.name;
    eventTargetType = 'agent';
    const eventMeta = (eventAgent.metadata ?? {}) as Record<string, unknown>;
    organizerAgentId =
      (typeof eventMeta.creatorId === 'string' && eventMeta.creatorId) ||
      (typeof eventMeta.organizerId === 'string' && eventMeta.organizerId) ||
      eventAgent.parentId ||
      null;
    if (typeof eventMeta.price === 'number') defaultTicketPrice = eventMeta.price;
  }

  if (!organizerAgentId) {
    throw new Error('Event organizer could not be resolved.');
  }

  const normalizedSelections = selections
    .filter((selection) => isUuid(selection.ticketProductId) && isPositiveInteger(selection.quantity))
    .map((selection) => ({
      ticketProductId: selection.ticketProductId,
      quantity: selection.quantity,
    }));

  if (normalizedSelections.length === 0) {
    const fallbackRows = await db.execute(sql`
      SELECT id
      FROM resources
      WHERE deleted_at IS NULL
        AND owner_id = ${organizerAgentId}::uuid
        AND metadata->>'eventId' = ${eventId}
        AND lower(coalesce(metadata->>'listingType', '')) = 'product'
        AND lower(coalesce(metadata->>'productKind', '')) = 'ticket'
        AND coalesce(metadata->>'status', 'active') != 'archived'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const fallback = (fallbackRows as Array<Record<string, unknown>>)[0];
    if (!fallback || typeof fallback.id !== "string") {
      const [created] = await db
        .insert(resources)
        .values({
          name: `${eventName} Ticket`,
          type: 'listing',
          description: `Ticket product for ${eventName}`,
          ownerId: organizerAgentId,
          visibility: 'public',
          tags: [eventId, 'ticket', 'event', 'product'],
          metadata: {
            eventId,
            listingType: 'product',
            productKind: 'ticket',
            resourceKind: 'product',
            status: 'active',
            totalPriceCents: defaultTicketPrice > 0 ? Math.round(defaultTicketPrice * 100) : 0,
            ticketPriceCents: defaultTicketPrice > 0 ? Math.round(defaultTicketPrice * 100) : 0,
            price: defaultTicketPrice,
          },
        } as NewResource)
        .returning({ id: resources.id });
      normalizedSelections.push({ ticketProductId: created.id, quantity: 1 });
    } else {
      normalizedSelections.push({ ticketProductId: fallback.id, quantity: 1 });
    }
  }

  const ticketIds = normalizedSelections.map((selection) => selection.ticketProductId);
  const ticketRows = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      name: resources.name,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(inArray(resources.id, ticketIds), eq(resources.type, "listing"), sql`${resources.deletedAt} IS NULL`));

  const ticketMap = new Map(ticketRows.map((row) => [row.id, row]));
  const resolvedSelections = normalizedSelections.map((selection) => {
    const ticket = ticketMap.get(selection.ticketProductId);
    if (!ticket) {
      throw new Error("Selected ticket was not found.");
    }
    if (ticket.ownerId !== organizerAgentId) {
      throw new Error("Selected ticket does not belong to this event organizer.");
    }
    const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
    if (String(metadata.eventId ?? "") !== eventId) {
      throw new Error("Selected ticket does not belong to this event.");
    }
    const unitPriceCents =
      typeof metadata.totalPriceCents === "number"
        ? metadata.totalPriceCents
        : typeof metadata.ticketPriceCents === "number"
          ? metadata.ticketPriceCents
          : typeof metadata.price === "number"
            ? Math.round(metadata.price * 100)
            : 0;
    return {
      ticketProductId: selection.ticketProductId,
      ticketName: ticket.name,
      quantity: selection.quantity,
      unitPriceCents,
      subtotalCents: unitPriceCents * selection.quantity,
    };
  });

  return {
    selections: resolvedSelections,
    organizerAgentId,
    eventName,
    eventTargetType,
  };
}

/**
 * Purchases a marketplace listing using the current user's wallet balance.
 * Looks up the listing's owner to determine seller wallet type, then transfers
 * funds atomically from buyer to seller wallet with platform fee applied for products.
 *
 * @param {string} listingId - Listing resource UUID.
 * @param {number} subtotalCents - Listing subtotal in cents.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if wallet/resource dependencies fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await purchaseWithWalletAction('11111111-1111-4111-8111-111111111111', 12000);
 * ```
 */
export async function purchaseWithWalletAction(
  listingId: string,
  subtotalCents: number,
  dealPostId?: string | null,
  bookingDate?: string | null,
  bookingSlot?: string | null,
): Promise<{ success: boolean; receiptId?: string; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to make a purchase.' };
  }

  // Rate limit applies before resource lookups to reduce load from abusive clients.
  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(listingId)) {
    return { success: false, error: 'Invalid listing.' };
  }

  if (!isPositiveInteger(subtotalCents)) {
    return { success: false, error: 'Subtotal must be a positive integer (in cents).' };
  }

  const result = await updateFacade.execute(
    {
      type: 'purchaseWithWalletAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { listingId, subtotalCents, dealPostId, bookingDate, bookingSlot },
    },
    async () => {
      const listing = await getResource(listingId);
      if (!listing || listing.deletedAt) {
        throw new Error('Listing not found.');
      }

      const listingMeta = (listing.metadata ?? {}) as Record<string, unknown>;
      const listingType = String(listingMeta.listingType ?? '').toLowerCase();
      const resourceKind = String(listingMeta.resourceKind ?? '').toLowerCase();
      const isPurchasable = listingType === 'product' || listingType === 'service' || resourceKind === 'offering';
      if (!isPurchasable) {
        throw new Error('Resource is not a purchasable marketplace listing.');
      }

      if (listing.ownerId === agentId) {
        throw new Error('You cannot purchase your own listing.');
      }

      const listingUnitPriceCents =
        typeof listingMeta.totalPriceCents === 'number'
          ? listingMeta.totalPriceCents
          : typeof listingMeta.priceCents === 'number'
            ? listingMeta.priceCents
            : 0;

      if (listingUnitPriceCents <= 0) {
        throw new Error('This listing has no price.');
      }

      const deal =
        typeof dealPostId === 'string' && dealPostId.length > 0
          ? await resolvePostOfferingDeal(dealPostId, listingId)
          : null;
      const unitPriceCents = deal?.dealPriceCents ?? listingUnitPriceCents;

      if (subtotalCents % unitPriceCents !== 0) {
        throw new Error('Invalid purchase amount for this listing.');
      }

      const requestedQuantity = subtotalCents / unitPriceCents;
      if (!isPositiveInteger(requestedQuantity)) {
        throw new Error('Invalid quantity for this listing.');
      }

      const acceptedCurrencies = getAcceptedCurrencies(listingMeta);
      if (acceptedCurrencies.length > 0 && !acceptedCurrencies.includes('USD')) {
        throw new Error('This listing cannot be purchased with wallet USD.');
      }

      const bookingSelection =
        bookingDate && bookingSlot
          ? { date: bookingDate, slot: bookingSlot }
          : null;

      if (hasBookableSchedule(listingMeta) && !bookingSelection) {
        throw new Error('Select a booking window before purchasing.');
      }

      if (!isBookingSlotAvailable(listingMeta, bookingSelection)) {
        throw new Error('Selected booking window is no longer available.');
      }

      const { quantityAvailable, quantitySold, quantityRemaining } = getAvailableInventory(listingMeta);
      if (quantityAvailable != null && requestedQuantity > (quantityRemaining ?? 0)) {
        throw new Error('Not enough inventory remaining for this purchase.');
      }

      // Business rule: marketplace platform fee is charged on product listings only.
      const marketplaceFeePolicy = await resolveMarketplaceFeePolicy({
        ownerAgentId: listing.ownerId,
        listingMetadata: listingMeta,
      });
      const feeCents =
        listingType === 'product'
          ? Math.round((subtotalCents * marketplaceFeePolicy.feeBps) / BPS_DIVISOR)
          : 0;
      const totalChargeCents = subtotalCents + feeCents;

      const buyerWallet = await getOrCreateWallet(agentId, 'personal');
      const balance = await getWalletBalance(buyerWallet.id);

      // Server-side balance check is authoritative; never trust client-calculated affordability.
      if (balance.balanceCents < totalChargeCents) {
        throw new Error('Insufficient wallet balance.');
      }

      const [sellerAgent] = await db
        .select({ type: agents.type })
        .from(agents)
        .where(eq(agents.id, listing.ownerId))
        .limit(1);

      if (!sellerAgent) {
        throw new Error('Listing owner not found.');
      }

      const sellerWallet = await getSettlementWalletForAgent(listing.ownerId);
      const platformWallet = feeCents > 0 ? await getPlatformWallet() : null;

      // Run wallet debit, inventory update, and receipt creation in a single
      // transaction with FOR UPDATE row locking to prevent overselling under
      // concurrent purchases (fixes #57).
      const receiptId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        // Lock the listing row to serialize concurrent inventory checks.
        const [lockedResource] = (await tx.execute(
          sql`SELECT metadata FROM resources WHERE id = ${listing.id} LIMIT 1 FOR UPDATE`
        )) as unknown as { metadata: Record<string, unknown> }[];

        const lockedMeta = (lockedResource?.metadata ?? {}) as Record<string, unknown>;

        // Re-check inventory under lock — the pre-lock check above is optimistic.
        if (!isBookingSlotAvailable(lockedMeta, bookingSelection)) {
          throw new Error('INVENTORY:Selected booking window is no longer available.');
        }
        const locked = getAvailableInventory(lockedMeta);
        if (locked.quantityAvailable != null && requestedQuantity > (locked.quantityRemaining ?? 0)) {
          throw new Error('INVENTORY:Not enough inventory remaining for this purchase.');
        }

        // Wallet debit + credit within the same transaction.
        await purchaseFromWallet(
          buyerWallet.id,
          sellerWallet.id,
          totalChargeCents,
          feeCents,
          'resource',
          listing.id,
          `Marketplace purchase: ${listing.name}`,
          platformWallet?.id,
          tx
        );

        // Update inventory inside the same transaction.
        if (locked.quantityAvailable != null || bookingSelection) {
          const nextQuantitySold = locked.quantitySold + requestedQuantity;
          const nextQuantityRemaining =
            locked.quantityAvailable != null
              ? Math.max(locked.quantityAvailable - nextQuantitySold, 0)
              : null;
          const nextMetadata = consumeBookingSlot(lockedMeta, bookingSelection);
          await tx
            .update(resources)
            .set({
              metadata: {
                ...nextMetadata,
                ...(locked.quantityAvailable != null
                  ? {
                      quantityAvailable: locked.quantityAvailable,
                      quantitySold: nextQuantitySold,
                      quantityRemaining: nextQuantityRemaining,
                      ...(nextQuantityRemaining === 0 ? { status: 'sold_out' } : {}),
                    }
                  : {}),
              },
            })
            .where(eq(resources.id, listing.id));
        }

        // Create receipt resource inside the same transaction.
        await tx.insert(resources).values({
          id: receiptId,
          name: `Receipt: ${listing.id}`,
          type: 'receipt',
          ownerId: agentId,
          description: `Purchase receipt for listing ${listing.id}`,
          metadata: {
            originalListingId: listing.id,
            buyerAgentId: agentId,
            sellerAgentId: listing.ownerId,
            priceCents: subtotalCents,
            platformFeeCents: feeCents,
            marketplaceFeeBpsApplied: listingType === 'product' ? marketplaceFeePolicy.feeBps : 0,
            marketplaceFeePolicySource: marketplaceFeePolicy.source,
            marketplaceFeePolicyAgentId: marketplaceFeePolicy.policyAgentId,
            totalCents: totalChargeCents,
            feeCents,
            dealPostId: deal?.postId ?? null,
            quantity: requestedQuantity,
            bookingDate: bookingSelection?.date ?? null,
            bookingSlot: bookingSelection?.slot ?? null,
            purchasedAt: new Date().toISOString(),
            status: 'completed',
            paymentMethod: 'wallet',
            currency: 'usd',
          },
        });
      });

      return { success: true, receiptId } as { success: boolean; receiptId?: string; error?: string };
    },
  );

  if (!result.success) {
    // Surface inventory/booking errors as user-facing messages.
    const errorMsg = result.error ?? 'Purchase failed. Please try again later.';
    if (errorMsg.startsWith('INVENTORY:')) {
      return { success: false, error: errorMsg.slice('INVENTORY:'.length) };
    }
    console.error('purchaseWithWalletAction failed:', errorMsg);
    return { success: false, error: errorMsg };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.LISTING_PURCHASED,
    entityType: 'resource',
    entityId: listingId,
    actorId: agentId,
    payload: { listingId, subtotalCents, receiptId: result.data?.receiptId },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Estimates event ticket checkout totals using legacy fee/tax rules.
 *
 * @param {number} subtotalCents - Ticket subtotal amount in cents.
 * @returns {Promise<{ success: boolean; breakdown?: { subtotalCents: number; platformFeeCents: number; salesTaxCents: number; paymentFeeCents: number; totalCents: number; }; error?: string }>} Fee breakdown or error.
 * @throws {Error} Can throw if fee calculation fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const estimate = await estimateEventTicketCheckoutAction(8500);
 * ```
 */
export async function estimateEventTicketCheckoutAction(subtotalCents: number): Promise<{
  success: boolean;
  breakdown?: {
    subtotalCents: number;
    platformFeeCents: number;
    salesTaxCents: number;
    paymentFeeCents: number;
    totalCents: number;
  };
  error?: string;
}> {
  if (!isPositiveInteger(subtotalCents)) {
    return { success: false, error: 'Subtotal must be a positive integer (in cents).' };
  }

  try {
    const breakdown = calculateLegacyCheckoutFeesCents(subtotalCents);
    return { success: true, breakdown };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to estimate checkout.' };
  }
}

/**
 * Creates a Stripe Checkout session for event ticket purchase.
 *
 * @param {string} eventId - Event UUID.
 * @param {number} subtotalCents - Ticket subtotal in cents.
 * @returns {Promise<{ success: boolean; url?: string; error?: string }>} Redirect URL for Stripe Checkout or error.
 * @throws {Error} Can throw if event resolution or Stripe session creation fails unexpectedly outside guarded handling.
 * @example
 * ```ts
 * const result = await createEventTicketCheckoutAction(eventId, 15000);
 * if (result.success) window.location.assign(result.url!);
 * ```
 */
export async function createEventTicketCheckoutAction(
  eventId: string,
  selections: EventTicketSelectionInput[]
): Promise<{ success: boolean; url?: string; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to purchase tickets.' };
  }

  if (!isUuid(eventId)) {
    return { success: false, error: 'Invalid event.' };
  }
  const normalizedSelections = selections.filter((selection) => isUuid(selection.ticketProductId) && isPositiveInteger(selection.quantity));
  if (normalizedSelections.length === 0) {
    return { success: false, error: 'Select at least one ticket.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'createEventTicketCheckoutAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { eventId, selections: normalizedSelections },
    },
    async () => {
      const {
        selections: resolvedSelections,
        organizerAgentId: eventOwnerId,
        eventName,
        eventTargetType,
      } = await resolveTicketSelectionsForEvent(eventId, normalizedSelections);

      const visible = await canView(agentId, eventId, eventTargetType);
      if (!visible.allowed) {
        throw new Error('This event is not available for ticket checkout.');
      }

      if (eventOwnerId === agentId) {
        throw new Error('You cannot purchase tickets to your own event.');
      }

      const subtotalCents = resolvedSelections.reduce((sum, selection) => sum + selection.subtotalCents, 0);
      const breakdown = calculateLegacyCheckoutFeesCents(subtotalCents);
      const customerId = await getOrCreateStripeCustomer(agentId);
      const stripe = getStripe();
      const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

      // Metadata is duplicated on both checkout session and payment intent so webhook handlers
      // can recover purchase context regardless of which Stripe object is inspected.
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'payment',
        line_items: [
          ...resolvedSelections.map((selection) => ({
            price_data: {
              currency: 'usd',
              product_data: {
                name: selection.ticketName,
                metadata: {
                  eventId,
                  ticketProductId: selection.ticketProductId,
                },
              },
              unit_amount: selection.unitPriceCents,
            },
            quantity: selection.quantity,
          })),
          ...(breakdown.totalCents > subtotalCents
            ? [{
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: `${eventName} Platform fee`,
                  },
                  unit_amount: breakdown.totalCents - subtotalCents,
                },
                quantity: 1,
              }]
            : []),
        ],
        success_url: `${baseUrl}/events/${eventId}/registered?checkout=success`,
        cancel_url: `${baseUrl}/events/${eventId}/tickets?checkout=cancel`,
        metadata: {
          purchaseType: 'event_ticket',
          eventId,
          ticketSelectionsJson: JSON.stringify(resolvedSelections.map((selection) => ({
            ticketProductId: selection.ticketProductId,
            quantity: selection.quantity,
            unitPriceCents: selection.unitPriceCents,
            subtotalCents: selection.subtotalCents,
          }))),
          ticketProductId: resolvedSelections[0]?.ticketProductId ?? "",
          buyerAgentId: agentId,
          organizerAgentId: eventOwnerId,
          subtotalCents: String(breakdown.subtotalCents),
          platformFeeCents: String(breakdown.platformFeeCents),
          salesTaxCents: String(breakdown.salesTaxCents),
          paymentFeeCents: String(breakdown.paymentFeeCents),
          totalCents: String(breakdown.totalCents),
        },
        payment_intent_data: {
          metadata: {
            purchaseType: 'event_ticket',
            eventId,
            ticketSelectionsJson: JSON.stringify(resolvedSelections.map((selection) => ({
              ticketProductId: selection.ticketProductId,
              quantity: selection.quantity,
              unitPriceCents: selection.unitPriceCents,
              subtotalCents: selection.subtotalCents,
            }))),
            ticketProductId: resolvedSelections[0]?.ticketProductId ?? "",
            buyerAgentId: agentId,
            organizerAgentId: eventOwnerId,
            subtotalCents: String(breakdown.subtotalCents),
            platformFeeCents: String(breakdown.platformFeeCents),
            salesTaxCents: String(breakdown.salesTaxCents),
            paymentFeeCents: String(breakdown.paymentFeeCents),
            totalCents: String(breakdown.totalCents),
          },
        },
      });

      if (!session.url) {
        throw new Error('Unable to create checkout session.');
      }

      return { success: true, url: session.url } as { success: boolean; url?: string; error?: string };
    },
  );

  if (!result.success) {
    console.error('createEventTicketCheckoutAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to start card checkout. Please try again later.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.LISTING_PURCHASED,
    entityType: 'resource',
    entityId: eventId,
    actorId: agentId,
    payload: { eventId, purchaseType: 'event_ticket_checkout' },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Purchases event tickets directly with wallet balance.
 *
 * @param {string} eventId - Event UUID.
 * @param {number} subtotalCents - Ticket subtotal in cents.
 * @returns {Promise<{ success: boolean; error?: string }>} Operation outcome.
 * @throws {Error} Can throw if ticket wallet transfer dependencies fail unexpectedly outside guarded handling.
 * @example
 * ```ts
 * await purchaseEventTicketsWithWalletAction(eventId, 9000);
 * ```
 */
export async function purchaseEventTicketsWithWalletAction(
  eventId: string,
  selections: EventTicketSelectionInput[]
): Promise<{ success: boolean; error?: string }> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in to purchase tickets.' };
  }

  // Wallet-ticket purchases reuse wallet limiter to throttle repeated debit attempts.
  const check = await rateLimit(
    `wallet:${agentId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs
  );
  if (!check.success) {
    return { success: false, error: 'Rate limit exceeded. Please try again later.' };
  }

  if (!isUuid(eventId)) {
    return { success: false, error: 'Invalid event.' };
  }
  const normalizedSelections = selections.filter((selection) => isUuid(selection.ticketProductId) && isPositiveInteger(selection.quantity));
  if (normalizedSelections.length === 0) {
    return { success: false, error: 'Select at least one ticket.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'purchaseEventTicketsWithWalletAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { eventId, selections: normalizedSelections },
    },
    async () => {
      const {
        selections: resolvedSelections,
        organizerAgentId: eventOwnerId,
        eventTargetType,
      } = await resolveTicketSelectionsForEvent(eventId, normalizedSelections);

      const visible = await canView(agentId, eventId, eventTargetType);
      if (!visible.allowed) {
        throw new Error('This event is not available for ticket purchase.');
      }

      if (eventOwnerId === agentId) {
        throw new Error('You cannot purchase tickets to your own event.');
      }

      const subtotalCents = resolvedSelections.reduce((sum, selection) => sum + selection.subtotalCents, 0);
      const breakdown = calculateLegacyCheckoutFeesCents(subtotalCents);
      const feeCents =
        breakdown.platformFeeCents + breakdown.salesTaxCents + breakdown.paymentFeeCents;
      const totalChargeCents = breakdown.totalCents;

      const buyerWallet = await getOrCreateWallet(agentId, 'personal');
      const balance = await getWalletBalance(buyerWallet.id);
      if (balance.balanceCents < totalChargeCents) {
        throw new Error('Insufficient wallet balance.');
      }

      const [organizerAgent] = await db
        .select({ type: agents.type })
        .from(agents)
        .where(eq(agents.id, eventOwnerId))
        .limit(1);
      if (!organizerAgent) {
        throw new Error('Event organizer not found.');
      }

      const organizerWallet = await getSettlementWalletForAgent(eventOwnerId);
      const platformWallet = feeCents > 0 ? await getPlatformWallet() : null;

      let remainingFeeCents = feeCents;
      for (const [index, selection] of resolvedSelections.entries()) {
        const selectionFeeCents =
          index === resolvedSelections.length - 1
            ? remainingFeeCents
            : Math.floor((feeCents * selection.subtotalCents) / subtotalCents);
        remainingFeeCents -= selectionFeeCents;

        await purchaseFromWallet(
          buyerWallet.id,
          organizerWallet.id,
          selection.subtotalCents + selectionFeeCents,
          selectionFeeCents,
          'resource',
          selection.ticketProductId,
          `Event ticket purchase (${selection.ticketName})`,
          platformWallet?.id
        );
      }

      return { success: true } as { success: boolean; error?: string };
    },
  );

  if (!result.success) {
    console.error('purchaseEventTicketsWithWalletAction failed:', result.error);
    return { success: false, error: result.error ?? 'Ticket purchase failed. Please try again later.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.LISTING_PURCHASED,
    entityType: 'resource',
    entityId: eventId,
    actorId: agentId,
    payload: { eventId, purchaseType: 'event_ticket' },
  }).catch(() => {});

  return result.data ?? { success: true };
}

/**
 * Creates a PaymentIntent for an offering purchase via Connect destination charge.
 * Returns the client secret for the Payment Request Button.
 *
 * @param {string} offeringId - Offering resource UUID.
 * @returns {Promise<{ success: boolean; clientSecret?: string; totalCents?: number; breakdown?: object; error?: string }>}
 */
export async function createProvidePaymentAction(offeringId: string): Promise<{
  success: boolean;
  clientSecret?: string;
  totalCents?: number;
  breakdown?: {
    subtotalCents: number;
    platformFeeCents: number;
    salesTaxCents: number;
    paymentFeeCents: number;
    totalCents: number;
  };
  error?: string;
}> {
  const agentId = await getCurrentUserId();
  if (!agentId) {
    return { success: false, error: 'You must be logged in.' };
  }

  if (!isUuid(offeringId)) {
    return { success: false, error: 'Invalid offering.' };
  }

  const result = await updateFacade.execute(
    {
      type: 'createProvidePaymentAction',
      actorId: agentId,
      targetAgentId: agentId,
      payload: { offeringId },
    },
    async () => {
      // Look up offering
      const [offering] = await db
        .select({
          id: resources.id,
          ownerId: resources.ownerId,
          name: resources.name,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(and(eq(resources.id, offeringId), eq(resources.type, 'listing')))
        .limit(1);

      if (!offering) {
        throw new Error('Offering not found.');
      }

      if (offering.ownerId === agentId) {
        throw new Error('You cannot purchase your own offering.');
      }

      const meta = (offering.metadata ?? {}) as Record<string, unknown>;
      const totalPriceCents = typeof meta.totalPriceCents === 'number' ? meta.totalPriceCents : 0;

      if (totalPriceCents <= 0) {
        throw new Error('This offering has no price.');
      }

      // Check seller Connect account
      const sellerWallet = await getSettlementWalletForAgent(offering.ownerId);

      const sellerMeta = (sellerWallet.metadata ?? {}) as Record<string, unknown>;
      const connectAccountId = sellerMeta.stripeConnectAccountId as string | undefined;

      if (!connectAccountId || sellerMeta.connectChargesEnabled !== true) {
        throw new Error('Seller is not set up to receive payments.');
      }

      // Calculate fees
      const breakdown = calculateLegacyCheckoutFeesCents(totalPriceCents);

      // Create PaymentIntent with destination charge
      const stripe = getStripe();
      const paymentIntent = await stripe.paymentIntents.create({
        amount: breakdown.totalCents,
        currency: 'usd',
        application_fee_amount: breakdown.platformFeeCents,
        transfer_data: { destination: connectAccountId },
        metadata: {
          type: 'offering_purchase',
          offeringId,
          buyerId: agentId,
          sellerId: offering.ownerId,
          subtotalCents: String(totalPriceCents),
          platformFeeCents: String(breakdown.platformFeeCents),
          totalCents: String(breakdown.totalCents),
        },
      });

      return {
        success: true,
        clientSecret: paymentIntent.client_secret ?? undefined,
        totalCents: breakdown.totalCents,
        breakdown,
      };
    },
  );

  if (!result.success) {
    console.error('createProvidePaymentAction failed:', result.error);
    return { success: false, error: result.error ?? 'Unable to start payment. Please try again.' };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.LISTING_PURCHASED,
    entityType: 'resource',
    entityId: offeringId,
    actorId: agentId,
    payload: { offeringId, purchaseType: 'offering_payment' },
  }).catch(() => {});

  return result.data ?? { success: true };
}
