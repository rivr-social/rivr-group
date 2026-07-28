/**
 * @module lib/checkout-obligations
 *
 * The origin-side record of a Global-mediated checkout.
 *
 * When this instance submits a checkout obligation to Global it records the
 * FULL settlement payload locally first, keyed by the obligation id. The
 * settlement receiver then settles from THIS record — the peer's notice
 * contributes only what Stripe actually charged (total/tax/payment intent) and
 * the buyer identity Stripe collected. A notice naming an unknown obligation
 * settles nothing, so a compromised peer cannot mint arbitrary ledger credits.
 * This mirrors Global's own refund contract, where the caller's body decides
 * nothing.
 *
 * Storage: a private `resources` row (`type: 'resource'`,
 * `metadata.resourceKind: 'checkout_obligation'`) owned by the instance's
 * primary agent — the same no-migration convention as treasury funds, which
 * matters because sovereign database migrations are applied by hand.
 */
import { db } from '@/db';
import { resources } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export const CHECKOUT_OBLIGATION_RESOURCE_KIND = 'checkout_obligation';

export type CheckoutObligationStatus = 'pending' | 'settled';

export interface MarketplaceObligationPayload {
  kind: 'marketplace_purchase';
  listingId: string;
  sellerAgentId: string;
  /** Server-derived buyer, or null for a guest checkout. */
  buyerAgentId: string | null;
  orgId: string | null;
  orgCommissionCents: number;
  platformFeeCents: number;
  buyerPlatformFeeCents: number;
  priceCents: number;
  buyerTotalCents: number;
  quantity: number;
  bookingSelection: { date: string; slot: string } | null;
  dealPostId: string | null;
}

export interface EventTicketObligationPayload {
  kind: 'event_ticket';
  eventId: string;
  ticketProductId: string;
  ticketSelections: Array<{
    ticketProductId: string;
    quantity: number;
    subtotalCents: number;
  }>;
  buyerAgentId: string;
  organizerAgentId: string;
  totalCents: number;
  subtotalCents: number;
  platformFeeCents: number;
  legacySalesTaxCents: number;
  paymentFeeCents: number;
  /** Organizer-declared admission tax (settles to the organizer; they remit). */
  organizerTaxCents?: number;
  organizerTaxName?: string;
}

export type CheckoutObligationPayload =
  | MarketplaceObligationPayload
  | EventTicketObligationPayload;

export interface CheckoutObligationRecord {
  resourceId: string;
  obligationId: string;
  status: CheckoutObligationStatus;
  /** Pre-tax total Global is expected to charge; asserted on settlement. */
  expectedTotalCents: number;
  payload: CheckoutObligationPayload;
}

function requirePrimaryAgentId(): string {
  const primaryAgentId = process.env.PRIMARY_AGENT_ID?.trim();
  if (!primaryAgentId) {
    throw new Error(
      'PRIMARY_AGENT_ID is not configured; cannot record a checkout obligation.',
    );
  }
  return primaryAgentId;
}

/**
 * Records a pending mediated-checkout obligation. Called BEFORE the request to
 * Global, so a settlement notice can never reference an obligation this
 * instance has no record of.
 */
export async function recordCheckoutObligation(params: {
  obligationId: string;
  expectedTotalCents: number;
  payload: CheckoutObligationPayload;
}): Promise<void> {
  await db.insert(resources).values({
    name: `Checkout obligation ${params.obligationId}`,
    type: 'resource',
    ownerId: requirePrimaryAgentId(),
    visibility: 'private',
    description: `Global-mediated checkout obligation (${params.payload.kind})`,
    metadata: {
      resourceKind: CHECKOUT_OBLIGATION_RESOURCE_KIND,
      obligationId: params.obligationId,
      status: 'pending' satisfies CheckoutObligationStatus,
      expectedTotalCents: params.expectedTotalCents,
      payload: params.payload,
      createdVia: 'global_mediated_checkout',
    },
  });
}

/**
 * Loads an obligation by id. Returns null when this instance never recorded
 * it — the receiver treats that as a hard rejection.
 */
export async function findCheckoutObligation(
  obligationId: string,
): Promise<CheckoutObligationRecord | null> {
  const [row] = await db
    .select({ id: resources.id, metadata: resources.metadata })
    .from(resources)
    .where(
      and(
        eq(resources.type, 'resource'),
        sql`${resources.metadata}->>'resourceKind' = ${CHECKOUT_OBLIGATION_RESOURCE_KIND}`,
        sql`${resources.metadata}->>'obligationId' = ${obligationId}`,
      ),
    )
    .limit(1);

  if (!row) return null;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const payload = metadata.payload as CheckoutObligationPayload | undefined;
  if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') {
    return null;
  }

  return {
    resourceId: row.id,
    obligationId,
    status: metadata.status === 'settled' ? 'settled' : 'pending',
    expectedTotalCents:
      typeof metadata.expectedTotalCents === 'number' ? metadata.expectedTotalCents : 0,
    payload,
  };
}

/**
 * Stamps an obligation settled with what actually happened. Recorded after the
 * settlement transaction commits; the settlement itself stays idempotent on
 * the payment intent, so a crash between the two only re-runs a no-op settle.
 */
export async function markCheckoutObligationSettled(params: {
  resourceId: string;
  sessionId: string;
  paymentIntentId: string;
  amountTotalCents: number;
  taxCents: number;
}): Promise<void> {
  await db
    .update(resources)
    .set({
      metadata: sql`${resources.metadata} || ${JSON.stringify({
        status: 'settled' satisfies CheckoutObligationStatus,
        settledAt: new Date().toISOString(),
        stripeCheckoutSessionId: params.sessionId,
        stripePaymentIntentId: params.paymentIntentId,
        settledAmountTotalCents: params.amountTotalCents,
        settledTaxCents: params.taxCents,
      })}::jsonb`,
    })
    .where(eq(resources.id, params.resourceId));
}
