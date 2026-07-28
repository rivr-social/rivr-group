/**
 * @fileoverview Federated settlement receiver — the origin half of
 * Global-mediated checkout.
 *
 *   POST /api/federation/stripe/settlement
 *     body: FederatedSettlementNotice (see Global lib/federated-settlement-notify)
 *     -> { status: 'settled' | 'already_settled' }
 *
 * Global collected the buyer's money on its platform; this instance owns the
 * thing that was sold, so it must credit its own ledger IDENTICALLY to a local
 * sale. That happens through the extracted settlement modules
 * (`lib/marketplace-settlement`, `lib/event-ticket-settlement`) — the same
 * code the local Stripe webhook runs.
 *
 * Trust model: the notice may only come from THIS instance's Global peer, and
 * it settles nothing by itself — settlement amounts, recipients, and splits
 * come from the LOCALLY RECORDED checkout obligation
 * (`lib/checkout-obligations`). The notice contributes only what Stripe
 * actually charged (total/tax/payment intent) and the buyer identity Stripe
 * collected. An unknown obligation is rejected outright.
 *
 * Durability: Global lets Stripe retry the whole event on a non-2xx, so this
 * receiver is idempotent on the obligation — a replayed notice for a settled
 * obligation returns 200 without writing (the settlement itself also guards on
 * the payment intent id).
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { nodes } from '@/db/schema';
import { authorizeFederationRequest } from '@/lib/federation-auth';
import { getGlobalUrl } from '@/lib/federation/global-url';
import {
  findCheckoutObligation,
  markCheckoutObligationSettled,
  type CheckoutObligationRecord,
} from '@/lib/checkout-obligations';
import {
  resolveGuestBuyerAgentId,
  settleMarketplacePurchase,
} from '@/lib/marketplace-settlement';
import { settleEventTicketPurchase } from '@/lib/event-ticket-settlement';
import { STATUS_BAD_REQUEST, STATUS_UNAUTHORIZED } from '@/lib/http-status';

export const dynamic = 'force-dynamic';

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';
const STATUS_FORBIDDEN = 403;
const STATUS_CONFLICT = 409;

interface SettlementNoticeBody {
  obligationId?: string;
  sessionId?: string;
  paymentIntentId?: string | null;
  amountTotalCents?: number;
  amountSubtotalCents?: number;
  taxCents?: number;
  currency?: string;
  settlementModel?: string;
  customerEmail?: string | null;
  customerName?: string | null;
  originMetadata?: Record<string, string>;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The notice must come from the node this instance submits its checkout
 * obligations to — its Global. Any other authenticated peer is rejected.
 */
async function peerIsOurGlobal(peerNodeId: string): Promise<boolean> {
  const [peer] = await db
    .select({ baseUrl: nodes.baseUrl })
    .from(nodes)
    .where(eq(nodes.id, peerNodeId))
    .limit(1);
  if (!peer?.baseUrl) return false;

  try {
    return new URL(peer.baseUrl).origin === new URL(getGlobalUrl('/')).origin;
  } catch {
    return false;
  }
}

async function settleFromObligation(
  obligation: CheckoutObligationRecord,
  notice: Required<Pick<SettlementNoticeBody, 'sessionId' | 'amountTotalCents' | 'taxCents'>> & {
    paymentIntentId: string;
    currency: string;
    customerEmail: string | null;
    customerName: string | null;
  },
): Promise<void> {
  const { payload } = obligation;

  if (payload.kind === 'marketplace_purchase') {
    // A guest checkout has no buyer at obligation time; attribute it from the
    // identity Stripe collected, exactly as the local webhook lane does.
    let buyerAgentId = payload.buyerAgentId;
    if (!buyerAgentId && notice.customerEmail) {
      buyerAgentId = await resolveGuestBuyerAgentId(
        notice.customerEmail,
        notice.customerName,
      );
    }

    await settleMarketplacePurchase({
      listingId: payload.listingId,
      sellerAgentId: payload.sellerAgentId,
      buyerAgentId,
      orgId: payload.orgId,
      orgCommissionCents: payload.orgCommissionCents,
      platformFeeCents: payload.platformFeeCents,
      buyerPlatformFeeCents: payload.buyerPlatformFeeCents,
      priceCents: payload.priceCents,
      buyerTotalCents: payload.buyerTotalCents,
      quantity: payload.quantity,
      bookingSelection: payload.bookingSelection,
      chargedTotalCents: notice.amountTotalCents,
      taxCents: notice.taxCents,
      currency: notice.currency,
      checkoutSessionId: notice.sessionId,
      paymentIntentId: notice.paymentIntentId,
      // Funds live on Global's platform; eligibility is tracked there.
      payoutEligibleAt: null,
      customerEmail: notice.customerEmail,
      customerName: notice.customerName,
      federatedObligationId: obligation.obligationId,
    });
    return;
  }

  await settleEventTicketPurchase({
    eventId: payload.eventId,
    ticketProductId: payload.ticketProductId,
    ticketSelections: payload.ticketSelections,
    buyerAgentId: payload.buyerAgentId,
    organizerAgentId: payload.organizerAgentId,
    totalCents: payload.totalCents,
    subtotalCents: payload.subtotalCents,
    feeProrationBaseCents: payload.subtotalCents || payload.totalCents,
    platformFeeCents: payload.platformFeeCents,
    legacySalesTaxCents: payload.legacySalesTaxCents,
    paymentFeeCents: payload.paymentFeeCents,
    chargedTotalCents: notice.amountTotalCents,
    taxCents: notice.taxCents,
    currency: notice.currency,
    checkoutSessionId: notice.sessionId,
    paymentIntentId: notice.paymentIntentId,
    payoutEligibleAt: null,
    federatedObligationId: obligation.obligationId,
    ...(payload.organizerTaxCents
      ? {
          organizerTaxCents: payload.organizerTaxCents,
          organizerTaxName: payload.organizerTaxName,
        }
      : {}),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorizeFederationRequest(request);
  if (!auth.authorized || !auth.peerNodeId) {
    return NextResponse.json(
      { error: auth.reason ?? 'Authenticated federation peer required' },
      { status: STATUS_UNAUTHORIZED, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  if (!(await peerIsOurGlobal(auth.peerNodeId))) {
    return NextResponse.json(
      { error: 'Settlement notices are only accepted from this instance’s Global peer' },
      { status: STATUS_FORBIDDEN, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  let body: SettlementNoticeBody;
  try {
    body = (await request.json()) as SettlementNoticeBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: STATUS_BAD_REQUEST, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  if (typeof body.obligationId !== 'string' || !body.obligationId) {
    return NextResponse.json(
      { error: 'obligationId is required' },
      { status: STATUS_BAD_REQUEST, headers: { 'Cache-Control': NO_STORE } },
    );
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    return NextResponse.json(
      { error: 'sessionId is required' },
      { status: STATUS_BAD_REQUEST, headers: { 'Cache-Control': NO_STORE } },
    );
  }
  if (
    !isNonNegativeInt(body.amountTotalCents) ||
    !isNonNegativeInt(body.amountSubtotalCents) ||
    !isNonNegativeInt(body.taxCents)
  ) {
    return NextResponse.json(
      { error: 'amountTotalCents, amountSubtotalCents and taxCents must be non-negative integers' },
      { status: STATUS_BAD_REQUEST, headers: { 'Cache-Control': NO_STORE } },
    );
  }
  // A paid payment-mode session always carries a payment intent; without it
  // there is no settlement reference and no idempotency anchor.
  if (typeof body.paymentIntentId !== 'string' || !body.paymentIntentId) {
    return NextResponse.json(
      { error: 'paymentIntentId is required' },
      { status: STATUS_BAD_REQUEST, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  const obligation = await findCheckoutObligation(body.obligationId);
  if (!obligation) {
    // Never settle what this instance did not originate. 409, not 404: the
    // notice is well-formed but permanently unfulfillable here, and the
    // operator-facing loudness lives in Global's webhook retry logs.
    return NextResponse.json(
      { error: `Unknown checkout obligation ${body.obligationId}` },
      { status: STATUS_CONFLICT, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  if (obligation.status === 'settled') {
    return NextResponse.json(
      { status: 'already_settled' },
      { headers: { 'Cache-Control': NO_STORE } },
    );
  }

  // What Stripe charged pre-tax must equal what this instance quoted when it
  // recorded the obligation — a mismatch means the session was tampered with
  // or the contract drifted, and settling would mint unbacked ledger credit.
  if (body.amountSubtotalCents !== obligation.expectedTotalCents) {
    return NextResponse.json(
      {
        error: `Settlement subtotal ${body.amountSubtotalCents} does not match the recorded obligation total ${obligation.expectedTotalCents}`,
      },
      { status: STATUS_CONFLICT, headers: { 'Cache-Control': NO_STORE } },
    );
  }

  try {
    await settleFromObligation(obligation, {
      sessionId: body.sessionId,
      paymentIntentId: body.paymentIntentId,
      amountTotalCents: body.amountTotalCents,
      taxCents: body.taxCents,
      currency: typeof body.currency === 'string' && body.currency ? body.currency : 'usd',
      customerEmail: typeof body.customerEmail === 'string' ? body.customerEmail : null,
      customerName: typeof body.customerName === 'string' ? body.customerName : null,
    });

    await markCheckoutObligationSettled({
      resourceId: obligation.resourceId,
      sessionId: body.sessionId,
      paymentIntentId: body.paymentIntentId,
      amountTotalCents: body.amountTotalCents,
      taxCents: body.taxCents,
    });

    return NextResponse.json(
      { status: 'settled' },
      { headers: { 'Cache-Control': NO_STORE } },
    );
  } catch (error) {
    // Non-2xx lets Stripe redeliver via Global; settlement is idempotent, so a
    // transient failure here is safe to retry.
    console.error('[federated-settlement] failed:', body.obligationId, error);
    return NextResponse.json(
      { error: 'Settlement failed' },
      { status: 500, headers: { 'Cache-Control': NO_STORE } },
    );
  }
}
