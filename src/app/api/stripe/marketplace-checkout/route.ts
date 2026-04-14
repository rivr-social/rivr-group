/**
 * Marketplace Checkout Session creation API route.
 *
 * Purpose:
 * Creates a Stripe Checkout Session for marketplace listing purchases with
 * platform-collected funds. Purchase proceeds settle into Rivr-managed
 * capital accounts in the webhook, while Stripe Connect remains a payout rail.
 *
 * Key exports:
 * `POST` - Creates a Stripe Checkout Session and returns the redirect URL.
 *
 * Dependencies:
 * - `auth` for session authentication.
 * - Drizzle DB for resource/wallet/ledger lookups.
 * - `calculateCheckoutFees` for fee computation.
 * - `getStripe` for Stripe SDK access.
 *
 * Auth requirements:
 * - Authentication is optional (supports guest checkout).
 * - When authenticated, the buyer's agent ID is attached to session metadata.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/db';
import { resources, ledger, agents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getStripe } from '@/lib/billing';
import { calculateCheckoutFees } from '@/lib/checkout-fees';
import { resolveMarketplaceFeePolicy } from '@/lib/marketplace-fees';
import { resolvePostOfferingDeal } from '@/lib/post-offer-deals';
import { hasBookableSchedule, isBookingSlotAvailable } from '@/lib/booking-slots';
import {
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
  STATUS_TOO_MANY_REQUESTS,
} from '@/lib/http-status';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';

function getAcceptedCurrencies(metadata: Record<string, unknown>): string[] {
  const raw = metadata.acceptedCurrencies;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
    .filter((value): value is string => value.length > 0);
}

function getQuantityRemaining(metadata: Record<string, unknown>): number | null {
  if (typeof metadata.quantityRemaining === 'number' && Number.isFinite(metadata.quantityRemaining)) {
    return metadata.quantityRemaining;
  }
  if (typeof metadata.quantityAvailable === 'number' && Number.isFinite(metadata.quantityAvailable)) {
    const quantitySold =
      typeof metadata.quantitySold === 'number' && Number.isFinite(metadata.quantitySold)
        ? metadata.quantitySold
        : 0;
    return Math.max(metadata.quantityAvailable - quantitySold, 0);
  }
  return null;
}

/**
 * POST handler to create a Stripe Checkout Session for a marketplace purchase.
 *
 * Request body:
 * - listingId: UUID of the listing resource
 * - quantity: number of units (default 1)
 * - hours: number of hours for hourly offerings (default 1)
 * - buyerAgentId: UUID of the buyer agent (optional, falls back to session user)
 *
 * Returns:
 * - url: Stripe Checkout Session URL for redirect
 */
export async function POST(request: NextRequest) {
  // IP-based rate limiting (no auth required — supports guest checkout).
  const clientIp = getClientIp(request.headers);
  const limiter = await rateLimit(
    `marketplace-checkout:${clientIp}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;

  let body: {
    listingId?: string;
    quantity?: number;
    hours?: number;
    buyerAgentId?: string | null;
    dealPostId?: string | null;
    bookingDate?: string | null;
    bookingSlot?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const { listingId, quantity = 1, hours = 1 } = body;
  const buyerAgentId = body.buyerAgentId ?? sessionUserId;
  const dealPostId = body.dealPostId ?? null;
  const bookingSelection =
    body.bookingDate && body.bookingSlot
      ? { date: body.bookingDate, slot: body.bookingSlot }
      : null;

  if (!listingId) {
    return NextResponse.json(
      { error: 'listingId is required' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  if (quantity < 1 || !Number.isInteger(quantity)) {
    return NextResponse.json(
      { error: 'quantity must be a positive integer' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    // 1. Look up the listing resource
    const [listing] = await db
      .select({
        id: resources.id,
        name: resources.name,
        ownerId: resources.ownerId,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(eq(resources.id, listingId))
      .limit(1);

    if (!listing) {
      return NextResponse.json(
        { error: 'Listing not found' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    // 2. Get seller agent
    const sellerId = listing.ownerId;
    if (buyerAgentId && sellerId === buyerAgentId) {
      return NextResponse.json(
        { error: 'You cannot purchase your own listing' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    // 3. Determine price from listing metadata, optionally overridden by a validated post-linked deal.
    const listingMeta = (listing.metadata ?? {}) as Record<string, unknown>;
    const isMarketplaceListing =
      typeof listingMeta.listingType === 'string' ||
      String(listingMeta.listingKind ?? '').toLowerCase() === 'marketplace-listing';

    if (!isMarketplaceListing) {
      return NextResponse.json(
        { error: 'Resource is not a marketplace listing' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    const listingUnitPriceCents =
      typeof listingMeta.totalPriceCents === 'number'
        ? listingMeta.totalPriceCents
        : typeof listingMeta.priceCents === 'number'
          ? listingMeta.priceCents
          : 0;

    if (listingUnitPriceCents <= 0) {
      return NextResponse.json(
        { error: 'Listing has no price set' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    const acceptedCurrencies = getAcceptedCurrencies(listingMeta);
    if (acceptedCurrencies.length > 0 && !acceptedCurrencies.includes('USD')) {
      return NextResponse.json(
        { error: 'Listing does not accept USD checkout.' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    const quantityRemaining = getQuantityRemaining(listingMeta);
    if (quantityRemaining != null && quantity > quantityRemaining) {
      return NextResponse.json(
        { error: 'Not enough inventory remaining for this purchase.' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    if (hasBookableSchedule(listingMeta) && !bookingSelection) {
      return NextResponse.json(
        { error: 'Select a booking window before checkout.' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    if (!isBookingSlotAvailable(listingMeta, bookingSelection)) {
      return NextResponse.json(
        { error: 'Selected booking window is no longer available.' },
        { status: STATUS_BAD_REQUEST },
      );
    }

    const deal =
      typeof dealPostId === 'string' && dealPostId.length > 0
        ? await resolvePostOfferingDeal(dealPostId, listingId)
        : null;
    const unitPriceCents = deal?.dealPriceCents ?? listingUnitPriceCents;
    const sellerPriceCents = unitPriceCents * quantity * hours;
    const marketplaceFeePolicy = await resolveMarketplaceFeePolicy({
      ownerAgentId: sellerId,
      listingMetadata: listingMeta,
    });

    // 4. Check if listing belongs to an org and get org commission
    let orgId: string | null = null;
    let orgCommissionBps = 0;

    // Query ledger for a 'belong' edge from seller to any org-type agent
    const orgEdges = await db
      .select({
        objectId: ledger.objectId,
      })
      .from(ledger)
      .innerJoin(agents, eq(ledger.objectId, agents.id))
      .where(
        and(
          eq(ledger.subjectId, sellerId),
          eq(ledger.verb, 'belong'),
          eq(ledger.isActive, true),
          eq(agents.type, 'organization'),
        ),
      )
      .limit(1);

    if (orgEdges.length > 0 && orgEdges[0].objectId) {
      orgId = orgEdges[0].objectId;

      // Get org metadata for commission rate
      const [orgAgent] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, orgId))
        .limit(1);

      const orgMeta = (orgAgent?.metadata ?? {}) as Record<string, unknown>;
      orgCommissionBps =
        typeof orgMeta.commissionBps === 'number' ? orgMeta.commissionBps : 0;

    }

    // 5. Calculate fees
    const fees = calculateCheckoutFees(sellerPriceCents, {
      orgCommissionBps: orgCommissionBps > 0 ? orgCommissionBps : undefined,
      platformFeeBps: marketplaceFeePolicy.feeBps,
    });

    // 6. Create Stripe Checkout Session
    const stripe = getStripe();
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name:
                quantity * hours > 1
                  ? `${listing.name} x${quantity * hours}`
                  : listing.name,
            },
            unit_amount: fees.buyerTotalCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          settlementModel: 'platform_capital_accounts',
        },
      },
      metadata: {
        purchaseType: 'marketplace_purchase',
        listingId,
        buyerAgentId: buyerAgentId || '',
        sellerAgentId: sellerId,
        orgId: orgId || '',
        orgCommissionCents: String(fees.orgCommissionCents),
        platformFeeCents: String(fees.platformFeeCents),
        marketplaceFeeBpsApplied: String(marketplaceFeePolicy.feeBps),
        marketplaceFeePolicySource: marketplaceFeePolicy.source,
        marketplaceFeePolicyAgentId: marketplaceFeePolicy.policyAgentId ?? '',
        buyerPlatformFeeCents: String(fees.buyerPlatformFeeCents),
        priceCents: String(fees.sellerPriceCents),
        buyerTotalCents: String(fees.buyerTotalCents),
        applicationFeeCents: String(fees.applicationFeeCents),
        stripeProcessingFeeEstimateCents: String(
          fees.stripeProcessingFeeEstimateCents,
        ),
        connectAccountFeeEstimateCents: String(
          fees.connectAccountFeeEstimateCents,
        ),
        quantity: String(quantity),
        hours: String(hours),
        dealPostId: deal?.postId ?? '',
        bookingDate: bookingSelection?.date ?? '',
        bookingSlot: bookingSelection?.slot ?? '',
      },
      success_url: `${baseUrl}/marketplace/${listingId}/confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:
        deal?.postId
          ? `${baseUrl}/marketplace/${listingId}/purchase?dealPostId=${encodeURIComponent(deal.postId)}`
          : `${baseUrl}/marketplace/${listingId}/purchase`,
      ...(buyerAgentId ? {} : { customer_creation: 'always' as const }),
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error(
      '[MarketplaceCheckout] Error creating checkout session:',
      error,
    );
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
