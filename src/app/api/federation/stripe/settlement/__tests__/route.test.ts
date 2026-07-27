/**
 * Tests for the federated settlement receiver.
 *
 * Peer authentication and the Global-origin check are mocked (they are
 * exercised per-branch); everything downstream — obligation lookup, the
 * settlement accounting, idempotent replay — runs against the real test
 * database, because the whole point of the receiver is that a mediated sale
 * credits the ledger identically to a local one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@/db', async () => {
  const { getTestDbModule } = await import('@/test/db');
  return getTestDbModule();
});

const mockAuthorize = vi.fn();
vi.mock('@/lib/federation-auth', () => ({
  authorizeFederationRequest: (...args: unknown[]) => mockAuthorize(...args),
}));

vi.mock('@/lib/federation/global-url', () => ({
  getGlobalUrl: (path: string) => `https://global.test${path}`,
}));

import { wallets, walletTransactions, resources, nodes } from '@/db/schema';
import { withTestTransaction } from '@/test/db';
import {
  createTestAgent,
  createTestGroup,
  createTestResource,
  createTestWallet,
} from '@/test/fixtures';
import { recordCheckoutObligation, findCheckoutObligation } from '@/lib/checkout-obligations';
import { POST } from '../route';

const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_CONFLICT = 409;

function makeNoticeRequest(body: Record<string, unknown>): Request {
  return new Request('https://origin.test/api/federation/stripe/settlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function baseNotice(obligationId: string, overrides: Record<string, unknown> = {}) {
  return {
    obligationId,
    sessionId: 'cs_mediated_1',
    paymentIntentId: `pi_mediated_${obligationId.slice(0, 8)}`,
    amountTotalCents: 1575,
    amountSubtotalCents: 1575,
    taxCents: 0,
    currency: 'usd',
    settlementModel: 'platform_capital',
    customerEmail: null,
    customerName: null,
    originMetadata: {},
    ...overrides,
  };
}

async function seedGlobalPeer(
  db: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
): Promise<string> {
  const [node] = await db
    .insert(nodes)
    .values({
      slug: `global-${crypto.randomUUID().slice(0, 8)}`,
      displayName: 'Global',
      baseUrl: 'https://global.test',
      role: 'global',
    })
    .returning({ id: nodes.id });
  return node.id;
}

describe('POST /api/federation/stripe/settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated caller', async () => {
    mockAuthorize.mockResolvedValue({ authorized: false, reason: 'nope' });
    const response = await POST(makeNoticeRequest(baseNotice(crypto.randomUUID())));
    expect(response.status).toBe(STATUS_UNAUTHORIZED);
  });

  it('rejects an authenticated peer that is not our Global', () =>
    withTestTransaction(async (db) => {
      // A peer node whose baseUrl is NOT the configured global origin.
      const [otherNode] = await db
        .insert(nodes)
        .values({
          slug: `other-${crypto.randomUUID().slice(0, 8)}`,
          displayName: 'Some sovereign',
          baseUrl: 'https://not-global.test',
          role: 'group',
        })
        .returning({ id: nodes.id });
      mockAuthorize.mockResolvedValue({ authorized: true, peerNodeId: otherNode.id });

      const response = await POST(makeNoticeRequest(baseNotice(crypto.randomUUID())));
      expect(response.status).toBe(STATUS_FORBIDDEN);
    }));

  it('rejects a notice for an obligation this instance never recorded', () =>
    withTestTransaction(async (db) => {
      const peerNodeId = await seedGlobalPeer(db);
      mockAuthorize.mockResolvedValue({ authorized: true, peerNodeId });

      const response = await POST(makeNoticeRequest(baseNotice(crypto.randomUUID())));
      expect(response.status).toBe(STATUS_CONFLICT);
    }));

  it('settles a recorded marketplace obligation identically to a local sale, idempotently', () =>
    withTestTransaction(async (db) => {
      const peerNodeId = await seedGlobalPeer(db);
      mockAuthorize.mockResolvedValue({ authorized: true, peerNodeId });

      const seller = await createTestAgent(db);
      const buyer = await createTestAgent(db);
      const primaryGroup = await createTestGroup(db);
      const platformOrg = await createTestGroup(db, { name: 'RIVR' });
      vi.stubEnv('PRIMARY_AGENT_ID', primaryGroup.id);
      vi.stubEnv('PLATFORM_AGENT_ID', platformOrg.id);
      const sellerWallet = await createTestWallet(db, seller.id);
      await createTestWallet(db, platformOrg.id, { type: 'group' });
      const listing = await createTestResource(db, seller.id, {
        name: 'Mediated Bowl',
        type: 'listing',
      });

      const obligationId = crypto.randomUUID();
      await recordCheckoutObligation({
        obligationId,
        expectedTotalCents: 1575,
        payload: {
          kind: 'marketplace_purchase',
          listingId: listing.id,
          sellerAgentId: seller.id,
          buyerAgentId: buyer.id,
          orgId: null,
          orgCommissionCents: 0,
          platformFeeCents: 75,
          buyerPlatformFeeCents: 75,
          priceCents: 1500,
          buyerTotalCents: 1575,
          quantity: 1,
          bookingSelection: null,
          dealPostId: null,
        },
      });

      const notice = baseNotice(obligationId);
      const response = await POST(makeNoticeRequest(notice));
      expect(response.status).toBe(STATUS_OK);
      expect(await response.json()).toEqual({ status: 'settled' });

      // Seller credited exactly the face value, like a local sale.
      const [sellerAfter] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, sellerWallet.id));
      expect(sellerAfter.balanceCents).toBe(1500);

      // The purchase transaction references Global's payment intent.
      const [purchaseTx] = await db
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.stripePaymentIntentId, notice.paymentIntentId as string));
      expect(purchaseTx).toBeDefined();
      expect(purchaseTx.amountCents).toBe(1575);

      // A receipt lands in the buyer's purchase history.
      const receipts = await db
        .select()
        .from(resources)
        .where(eq(resources.ownerId, buyer.id));
      expect(
        receipts.some(
          (row) =>
            row.type === 'receipt' &&
            (row.metadata as Record<string, unknown>)?.federatedObligationId === obligationId,
        ),
      ).toBe(true);

      // The obligation is stamped settled.
      const settled = await findCheckoutObligation(obligationId);
      expect(settled?.status).toBe('settled');

      // Replay: same notice again returns already_settled and writes nothing.
      const replay = await POST(makeNoticeRequest(notice));
      expect(replay.status).toBe(STATUS_OK);
      expect(await replay.json()).toEqual({ status: 'already_settled' });
      const [sellerReplay] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, sellerWallet.id));
      expect(sellerReplay.balanceCents).toBe(1500);
    }));

  it('refuses to settle when the charged subtotal does not match the recorded obligation', () =>
    withTestTransaction(async (db) => {
      const peerNodeId = await seedGlobalPeer(db);
      mockAuthorize.mockResolvedValue({ authorized: true, peerNodeId });

      const seller = await createTestAgent(db);
      const primaryGroup = await createTestGroup(db);
      vi.stubEnv('PRIMARY_AGENT_ID', primaryGroup.id);
      const listing = await createTestResource(db, seller.id, {
        name: 'Tampered Bowl',
        type: 'listing',
      });

      const obligationId = crypto.randomUUID();
      await recordCheckoutObligation({
        obligationId,
        expectedTotalCents: 1575,
        payload: {
          kind: 'marketplace_purchase',
          listingId: listing.id,
          sellerAgentId: seller.id,
          buyerAgentId: null,
          orgId: null,
          orgCommissionCents: 0,
          platformFeeCents: 75,
          buyerPlatformFeeCents: 75,
          priceCents: 1500,
          buyerTotalCents: 1575,
          quantity: 1,
          bookingSelection: null,
          dealPostId: null,
        },
      });

      const response = await POST(
        makeNoticeRequest(baseNotice(obligationId, { amountSubtotalCents: 999, amountTotalCents: 999 })),
      );
      expect(response.status).toBe(STATUS_CONFLICT);

      const still = await findCheckoutObligation(obligationId);
      expect(still?.status).toBe('pending');
    }));

  it('settles a recorded event-ticket obligation and credits the organizer', () =>
    withTestTransaction(async (db) => {
      const peerNodeId = await seedGlobalPeer(db);
      mockAuthorize.mockResolvedValue({ authorized: true, peerNodeId });

      const buyer = await createTestAgent(db);
      const organizer = await createTestAgent(db);
      const primaryGroup = await createTestGroup(db);
      const platformOrg = await createTestGroup(db, { name: 'RIVR' });
      vi.stubEnv('PRIMARY_AGENT_ID', primaryGroup.id);
      vi.stubEnv('PLATFORM_AGENT_ID', platformOrg.id);
      const organizerWallet = await createTestWallet(db, organizer.id);
      await createTestWallet(db, platformOrg.id, { type: 'group' });
      const ticketProduct = await createTestResource(db, organizer.id, {
        name: 'Mediated Ticket',
        type: 'listing',
      });

      const obligationId = crypto.randomUUID();
      await recordCheckoutObligation({
        obligationId,
        expectedTotalCents: 1100,
        payload: {
          kind: 'event_ticket',
          eventId: crypto.randomUUID(),
          ticketProductId: ticketProduct.id,
          ticketSelections: [
            { ticketProductId: ticketProduct.id, quantity: 1, subtotalCents: 1000 },
          ],
          buyerAgentId: buyer.id,
          organizerAgentId: organizer.id,
          totalCents: 1100,
          subtotalCents: 1000,
          platformFeeCents: 100,
          legacySalesTaxCents: 0,
          paymentFeeCents: 0,
        },
      });

      const response = await POST(
        makeNoticeRequest(
          baseNotice(obligationId, { amountSubtotalCents: 1100, amountTotalCents: 1100 }),
        ),
      );
      expect(response.status).toBe(STATUS_OK);

      // Organizer nets face value (1000 = 1100 - 100 platform fee).
      const [organizerAfter] = await db
        .select({ balanceCents: wallets.balanceCents })
        .from(wallets)
        .where(eq(wallets.id, organizerWallet.id));
      expect(organizerAfter.balanceCents).toBe(1000);
    }));
});
