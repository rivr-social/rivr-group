/**
 * Tests for the Stripe webhook API route.
 *
 * Stripe signature verification and billing helpers are mocked (external services).
 * Database operations use the real test database via withTestTransaction — the
 * route's subscription upserts, wallet deposit confirmations, and event-ticket
 * payment handlers all execute real queries that are rolled back after each test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { resources, subscriptions, wallets, walletTransactions } from "@/db/schema";

// ---------------------------------------------------------------------------
// vi.hoisted — set env vars before module evaluation
// ---------------------------------------------------------------------------

const { mockConstructEvent, mockSubscriptionsRetrieve, mockTierForPriceId, mockTransfersCreate } =
  vi.hoisted(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    return {
      mockConstructEvent: vi.fn(),
      mockSubscriptionsRetrieve: vi.fn(),
      mockTierForPriceId: vi.fn(),
      mockTransfersCreate: vi.fn(),
    };
  });

// ---------------------------------------------------------------------------
// Module-level mocks — external services only
// ---------------------------------------------------------------------------

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("stripe", () => {
  function StripeMock() {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: mockSubscriptionsRetrieve },
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: 'pi_test', transfer_data: null }) },
    };
  }
  return { default: StripeMock };
});

vi.mock("@/lib/billing", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
    transfers: { create: mockTransfersCreate },
    paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: 'pi_test', transfer_data: null }) },
  }),
  tierForPriceId: (...args: unknown[]) => mockTierForPriceId(...args),
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue('cus_test'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { POST } from "../route";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestWallet } from "@/test/fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_URL = "http://localhost:3000/api/stripe/webhook";
const VALID_SIGNATURE = "sig_test_valid";

function makeWebhookRequest(
  body: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(WEBHOOK_URL, {
    method: "POST",
    body,
    headers: new Headers(headers),
  });
}

function unixTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

const PERIOD_START = new Date("2026-01-01T00:00:00Z");
const PERIOD_END = new Date("2026-02-01T00:00:00Z");

function makeStripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test_123",
    customer: "cus_test_456",
    status: "active",
    cancel_at_period_end: false,
    metadata: { agentId: "agent-placeholder", tier: "host" },
    items: {
      data: [
        {
          price: { id: "price_host_monthly" },
          current_period_start: unixTimestamp(PERIOD_START),
          current_period_end: unixTimestamp(PERIOD_END),
        },
      ],
    },
    ...overrides,
  };
}

function makeStripeEvent(type: string, dataObject: unknown) {
  return { type, data: { object: dataObject } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Missing stripe-signature header
  // -----------------------------------------------------------------------

  describe("missing stripe-signature header", () => {
    it("returns 400 when stripe-signature header is absent", async () => {
      const request = makeWebhookRequest("{}");
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toBe("Missing stripe-signature header");
    });
  });

  // -----------------------------------------------------------------------
  // 2. Signature verification failure
  // -----------------------------------------------------------------------

  describe("signature verification failure", () => {
    it("returns 400 when constructEvent throws an Error", async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error("Invalid signature");
      });

      const request = makeWebhookRequest('{"fake":"payload"}', {
        "stripe-signature": "sig_invalid",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toContain("Webhook signature verification failed");
      expect(body.error).toContain("Invalid signature");
    });

    it("handles non-Error throw from constructEvent", async () => {
      mockConstructEvent.mockImplementation(() => {
        throw "raw string error";
      });

      const request = makeWebhookRequest('{"fake":"payload"}', {
        "stripe-signature": "sig_invalid",
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_BAD_REQUEST);
      expect(body.error).toContain("Unknown error");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Unhandled event types — acknowledged but not processed
  // -----------------------------------------------------------------------

  describe("unhandled event types", () => {
    it("returns 200 with received:true for unrecognized event types", async () => {
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("invoice.payment_succeeded", { id: "inv_456" })
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_OK);
      expect(body.received).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. constructEvent invocation — verifies correct args
  // -----------------------------------------------------------------------

  describe("constructEvent invocation", () => {
    it("passes raw body, signature, and webhook secret to constructEvent", async () => {
      const rawPayload = '{"id":"evt_test","type":"ping"}';

      mockConstructEvent.mockReturnValue(
        makeStripeEvent("ping", { id: "evt_test" })
      );

      const request = makeWebhookRequest(rawPayload, {
        "stripe-signature": "sig_my_custom",
      });

      await POST(request);

      expect(mockConstructEvent).toHaveBeenCalledWith(
        rawPayload,
        "sig_my_custom",
        "whsec_test_secret"
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. checkout.session.completed — subscription mode (real DB)
  // -----------------------------------------------------------------------

  describe("checkout.session.completed (subscription mode)", () => {
    it("retrieves subscription from Stripe and inserts into DB", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          id: "sub_checkout_new",
          metadata: { agentId: agent.id, tier: "host" },
        });
        const session = {
          id: "cs_test_session",
          mode: "subscription",
          subscription: "sub_checkout_new",
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("checkout.session.completed", session)
        );
        mockSubscriptionsRetrieve.mockResolvedValue(stripeSub);
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);
        expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(
          "sub_checkout_new"
        );

        // Verify subscription was created in the real DB
        const [created] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_checkout_new"))
          .limit(1);

        expect(created).toBeDefined();
        expect(created.agentId).toBe(agent.id);
        expect(created.stripeCustomerId).toBe("cus_test_456");
        expect(created.status).toBe("active");
        expect(created.membershipTier).toBe("host");
      }));

    it("handles subscription object (not string) in session.subscription", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          id: "sub_obj_456",
          metadata: { agentId: agent.id, tier: "host" },
        });
        const session = {
          id: "cs_test_session",
          mode: "subscription",
          subscription: { id: "sub_obj_456" },
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("checkout.session.completed", session)
        );
        mockSubscriptionsRetrieve.mockResolvedValue(stripeSub);
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);
        expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith("sub_obj_456");
      }));

    it("does nothing when mode is not subscription and not payment", async () => {
      const session = {
        id: "cs_setup_session",
        mode: "setup",
        subscription: null,
      };
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", session)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_OK);
      expect(body.received).toBe(true);
      expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    });

    it("does nothing when subscription is null on a subscription-mode session", async () => {
      const session = {
        id: "cs_no_sub",
        mode: "subscription",
        subscription: null,
      };
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", session)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
      expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 6. customer.subscription.created — inserts into real DB
  // -----------------------------------------------------------------------

  describe("customer.subscription.created", () => {
    it("inserts a new subscription record when none exists", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          metadata: { agentId: agent.id, tier: "host" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.created", stripeSub)
        );
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);
        expect(mockTierForPriceId).toHaveBeenCalledWith("price_host_monthly");

        // Verify subscription was created
        const [created] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_test_123"))
          .limit(1);

        expect(created).toBeDefined();
        expect(created.agentId).toBe(agent.id);
        expect(created.stripeCustomerId).toBe("cus_test_456");
        expect(created.stripePriceId).toBe("price_host_monthly");
        expect(created.status).toBe("active");
        expect(created.membershipTier).toBe("host");
        expect(created.cancelAtPeriodEnd).toBe(false);
        expect(created.currentPeriodStart).toEqual(PERIOD_START);
        expect(created.currentPeriodEnd).toEqual(PERIOD_END);
      }));

    it("handles customer as an object with id property", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          customer: { id: "cus_object_789" },
          metadata: { agentId: agent.id, tier: "host" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.created", stripeSub)
        );
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        const [created] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_test_123"))
          .limit(1);

        expect(created.stripeCustomerId).toBe("cus_object_789");
      }));

    it("falls back to metadata.tier when tierForPriceId returns null", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          metadata: { agentId: agent.id, tier: "organizer" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.created", stripeSub)
        );
        mockTierForPriceId.mockReturnValue(null);

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        const [created] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_test_123"))
          .limit(1);

        expect(created.membershipTier).toBe("organizer");
      }));
  });

  // -----------------------------------------------------------------------
  // 7. customer.subscription.updated — updates existing record
  // -----------------------------------------------------------------------

  describe("customer.subscription.updated", () => {
    it("updates an existing subscription record in the DB", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        // Insert an existing subscription
        await db.insert(subscriptions).values({
          agentId: agent.id,
          stripeCustomerId: "cus_test_456",
          stripeSubscriptionId: "sub_test_123",
          stripePriceId: "price_host_monthly",
          status: "active",
          membershipTier: "host",
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: PERIOD_END,
        });

        const stripeSub = makeStripeSubscription({
          status: "past_due",
          metadata: { agentId: agent.id, tier: "host" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.updated", stripeSub)
        );
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);

        // Verify subscription was updated
        const [updated] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_test_123"))
          .limit(1);

        expect(updated.status).toBe("past_due");
      }));

    it("inserts when no existing subscription record is found", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        const stripeSub = makeStripeSubscription({
          id: "sub_no_prior",
          metadata: { agentId: agent.id, tier: "host" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.updated", stripeSub)
        );
        mockTierForPriceId.mockReturnValue("host");

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        const [created] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_no_prior"))
          .limit(1);

        expect(created).toBeDefined();
        expect(created.agentId).toBe(agent.id);
      }));
  });

  // -----------------------------------------------------------------------
  // 8. customer.subscription.deleted — marks subscription canceled
  // -----------------------------------------------------------------------

  describe("customer.subscription.deleted", () => {
    it("marks the subscription as canceled in the DB", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);

        // Insert an active subscription
        await db.insert(subscriptions).values({
          agentId: agent.id,
          stripeCustomerId: "cus_test_456",
          stripeSubscriptionId: "sub_test_123",
          stripePriceId: "price_host_monthly",
          status: "active",
          membershipTier: "host",
          currentPeriodStart: PERIOD_START,
          currentPeriodEnd: PERIOD_END,
        });

        const stripeSub = makeStripeSubscription({
          status: "canceled",
          metadata: { agentId: agent.id, tier: "host" },
        });
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("customer.subscription.deleted", stripeSub)
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);

        // Verify subscription was marked canceled
        const [canceled] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, "sub_test_123"))
          .limit(1);

        expect(canceled.status).toBe("canceled");
        expect(canceled.cancelAtPeriodEnd).toBe(true);
      }));
  });

  // -----------------------------------------------------------------------
  // 9. Missing agentId metadata — skips processing
  // -----------------------------------------------------------------------

  describe("missing agentId metadata", () => {
    it("skips processing and returns 200 when agentId is missing", async () => {
      const stripeSub = makeStripeSubscription({ metadata: {} });
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", stripeSub)
      );

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_OK);
      expect(body.received).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing agentId metadata"),
        "sub_test_123"
      );

      consoleWarnSpy.mockRestore();
    });

    it("skips processing when metadata is undefined", async () => {
      const stripeSub = makeStripeSubscription({ metadata: undefined });
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", stripeSub)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Missing price — skips processing
  // -----------------------------------------------------------------------

  describe("missing price", () => {
    it("skips processing when items.data is empty", async () => {
      const stripeSub = makeStripeSubscription({
        items: { data: [] },
        metadata: { agentId: "agent-abc" },
      });
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", stripeSub)
      );

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_OK);
      expect(body.received).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no price"),
        "sub_test_123"
      );

      consoleWarnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 11. Unresolvable tier — skips processing
  // -----------------------------------------------------------------------

  describe("unresolvable tier", () => {
    it("skips when tierForPriceId returns null and metadata.tier is absent", async () => {
      const stripeSub = makeStripeSubscription({
        metadata: { agentId: "agent-abc" },
      });
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", stripeSub)
      );
      mockTierForPriceId.mockReturnValue(null);

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not resolve tier"),
        "price_host_monthly"
      );

      consoleWarnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 12. payment_intent.succeeded — wallet deposit (real DB)
  // -----------------------------------------------------------------------

  describe("payment_intent.succeeded", () => {
    it("confirms a pending wallet deposit in the DB", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);
        const wallet = await createTestWallet(db, agent.id);

        // Create a pending wallet transaction
        await db.insert(walletTransactions).values({
          type: "stripe_deposit",
          toWalletId: wallet.id,
          amountCents: 5000,
          feeCents: 0,
          currency: "usd",
          description: "Test deposit",
          stripePaymentIntentId: "pi_deposit_success",
          status: "pending",
          metadata: {},
        });

        const paymentIntent = {
          id: "pi_deposit_success",
          metadata: { walletId: wallet.id },
        };
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("payment_intent.succeeded", paymentIntent)
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);

        // Verify the transaction was marked completed
        const [tx] = await db
          .select()
          .from(walletTransactions)
          .where(
            eq(
              walletTransactions.stripePaymentIntentId,
              "pi_deposit_success"
            )
          )
          .limit(1);

        expect(tx.status).toBe("completed");
      }));

    it("does nothing when payment_intent has no walletId metadata", async () => {
      const paymentIntent = {
        id: "pi_no_wallet",
        metadata: {},
      };
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("payment_intent.succeeded", paymentIntent)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
    });
  });

  // -----------------------------------------------------------------------
  // 13. payment_intent.payment_failed — wallet deposit failure (real DB)
  // -----------------------------------------------------------------------

  describe("payment_intent.payment_failed", () => {
    it("marks a pending wallet deposit as failed in the DB", () =>
      withTestTransaction(async (db) => {
        const agent = await createTestAgent(db);
        const wallet = await createTestWallet(db, agent.id);

        // Create a pending wallet transaction
        await db.insert(walletTransactions).values({
          type: "stripe_deposit",
          toWalletId: wallet.id,
          amountCents: 3000,
          feeCents: 0,
          currency: "usd",
          description: "Test deposit that will fail",
          stripePaymentIntentId: "pi_deposit_fail",
          status: "pending",
          metadata: {},
        });

        const paymentIntent = {
          id: "pi_deposit_fail",
          metadata: { walletId: wallet.id },
        };
        mockConstructEvent.mockReturnValue(
          makeStripeEvent("payment_intent.payment_failed", paymentIntent)
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);

        // Verify the transaction was marked failed
        const [tx] = await db
          .select()
          .from(walletTransactions)
          .where(
            eq(walletTransactions.stripePaymentIntentId, "pi_deposit_fail")
          )
          .limit(1);

        expect(tx.status).toBe("failed");
      }));

    it("does nothing when payment_intent has no walletId metadata", async () => {
      const paymentIntent = {
        id: "pi_no_wallet_fail",
        metadata: {},
      };
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("payment_intent.payment_failed", paymentIntent)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
    });
  });

  // -----------------------------------------------------------------------
  // 14. checkout.session.completed — payment mode (event ticket, real DB)
  // -----------------------------------------------------------------------

  describe("checkout.session.completed (payment mode — event ticket)", () => {
    it("creates a wallet transaction and ledger entry for an event ticket", () =>
      withTestTransaction(async (db) => {
        const buyer = await createTestAgent(db);
        const organizer = await createTestAgent(db);
        const platformOrg = await createTestGroup(db, { name: "RIVR" });
        const organizerWallet = await createTestWallet(db, organizer.id);
        const platformWallet = await createTestWallet(db, platformOrg.id, {
          type: "group",
        });

        // Create a resource for the ticket product (FK constraint on ledger.resourceId)
        const { createTestResource } = await import("@/test/fixtures");
        const ticketProduct = await createTestResource(db, organizer.id, {
          name: "Concert Ticket",
          type: "listing",
        });

        const session = {
          id: "cs_ticket_session",
          mode: "payment",
          payment_intent: "pi_ticket_123",
          currency: "usd",
          metadata: {
            purchaseType: "event_ticket",
            eventId: "evt_concert_abc",
            ticketProductId: ticketProduct.id,
            buyerAgentId: buyer.id,
            organizerAgentId: organizer.id,
            subtotalCents: "900",
            platformFeeCents: "50",
            salesTaxCents: "30",
            paymentFeeCents: "20",
            totalCents: "1000",
          },
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("checkout.session.completed", session)
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(STATUS_OK);
        expect(body.received).toBe(true);

        // Verify wallet transaction was created
        const [tx] = await db
          .select()
          .from(walletTransactions)
          .where(
            eq(walletTransactions.stripePaymentIntentId, "pi_ticket_123")
          )
          .limit(1);

        expect(tx).toBeDefined();
        expect(tx.type).toBe("event_ticket");
        expect(tx.amountCents).toBe(1000);
        expect(tx.feeCents).toBe(100); // 50 + 30 + 20
        expect(tx.status).toBe("completed");

        const [updatedOrganizerWallet] = await db
          .select()
          .from(wallets)
          .where(eq(wallets.id, organizerWallet.id))
          .limit(1);
        const [updatedPlatformWallet] = await db
          .select()
          .from(wallets)
          .where(eq(wallets.id, platformWallet.id))
          .limit(1);

        expect(updatedOrganizerWallet?.balanceCents).toBe(900);
        expect(updatedPlatformWallet?.balanceCents).toBe(100);

        const settlementRows = await db
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.ledgerEntryId, tx.ledgerEntryId!));

        expect(
          settlementRows.some(
            (row) =>
              row.type === "marketplace_payout" &&
              row.toWalletId === organizerWallet.id &&
              row.amountCents === 900,
          ),
        ).toBe(true);
        expect(
          settlementRows.some(
            (row) =>
              row.type === "service_fee" &&
              row.toWalletId === platformWallet.id &&
              row.amountCents === 100,
          ),
        ).toBe(true);
      }));

    it("is idempotent — does not duplicate wallet transaction", () =>
      withTestTransaction(async (db) => {
        const buyer = await createTestAgent(db);
        const organizer = await createTestAgent(db);

        const { createTestResource } = await import("@/test/fixtures");
        const ticketProduct = await createTestResource(db, organizer.id, {
          name: "Concert Ticket",
          type: "listing",
        });

        // Pre-create a wallet transaction with the same PI
        await db.insert(walletTransactions).values({
          type: "event_ticket",
          amountCents: 1000,
          feeCents: 100,
          currency: "usd",
          description: "Pre-existing",
          stripePaymentIntentId: "pi_ticket_dup",
          status: "completed",
          metadata: {},
        });

        const session = {
          id: "cs_ticket_dup",
          mode: "payment",
          payment_intent: "pi_ticket_dup",
          currency: "usd",
          metadata: {
            purchaseType: "event_ticket",
            eventId: "evt_abc",
            ticketProductId: ticketProduct.id,
            buyerAgentId: buyer.id,
            organizerAgentId: organizer.id,
            totalCents: "1000",
          },
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("checkout.session.completed", session)
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        // Should still be only one transaction
        const allTx = await db
          .select()
          .from(walletTransactions)
          .where(
            eq(walletTransactions.stripePaymentIntentId, "pi_ticket_dup")
          );

        expect(allTx).toHaveLength(1);
      }));

    it("skips non-event-ticket payment checkouts", async () => {
      const session = {
        id: "cs_generic_payment",
        mode: "payment",
        payment_intent: "pi_generic",
        metadata: { purchaseType: "donation" },
      };

      mockConstructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", session)
      );

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);

      expect(response.status).toBe(STATUS_OK);
    });
  });

  describe("checkout.session.completed (payment mode — marketplace)", () => {
    it("records a guest marketplace card purchase and creates a receipt", () =>
      withTestTransaction(async (db) => {
        const seller = await createTestAgent(db);
        const { createTestResource } = await import("@/test/fixtures");
        const listing = await createTestResource(db, seller.id, {
          name: "Handmade Bowl",
          type: "listing",
        });

        const session = {
          id: "cs_marketplace_guest",
          mode: "payment",
          payment_intent: "pi_marketplace_guest",
          currency: "usd",
          customer_details: {
            email: "guest-buyer@example.com",
            name: "Guest Buyer",
          },
          metadata: {
            purchaseType: "marketplace_purchase",
            listingId: listing.id,
            buyerAgentId: "",
            sellerAgentId: seller.id,
            orgId: "",
            orgConnectAccountId: "",
            orgCommissionCents: "0",
            platformFeeCents: "75",
            priceCents: "1500",
          },
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("checkout.session.completed", session),
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        const [tx] = await db
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.stripePaymentIntentId, "pi_marketplace_guest"))
          .limit(1);

        expect(tx?.type).toBe("marketplace_purchase");
        expect(tx?.amountCents).toBe(1500);
        expect(tx?.feeCents).toBe(75);

        const [guestReceipt] = await db
          .select()
          .from(resources)
          .where(eq(resources.type, "receipt"))
          .limit(1);

        expect(guestReceipt).toBeDefined();
        expect((guestReceipt?.metadata as Record<string, unknown>)?.customerEmail).toBe("guest-buyer@example.com");
      }));
  });

  describe("payment_intent.succeeded (offering purchase)", () => {
    it("records offering purchases completed through Connect card payment", () =>
      withTestTransaction(async (db) => {
        const buyer = await createTestAgent(db);
        const seller = await createTestAgent(db);
        const { createTestResource } = await import("@/test/fixtures");
        const offering = await createTestResource(db, seller.id, {
          name: "Consulting Session",
          type: "listing",
        });

        const paymentIntent = {
          id: "pi_offering_123",
          amount: 4242,
          metadata: {
            type: "offering_purchase",
            offeringId: offering.id,
            buyerId: buyer.id,
            sellerId: seller.id,
            subtotalCents: "4000",
            platformFeeCents: "242",
            totalCents: "4242",
          },
        };

        mockConstructEvent.mockReturnValue(
          makeStripeEvent("payment_intent.succeeded", paymentIntent),
        );

        const request = makeWebhookRequest("{}", {
          "stripe-signature": VALID_SIGNATURE,
        });
        const response = await POST(request);

        expect(response.status).toBe(STATUS_OK);

        const [tx] = await db
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.stripePaymentIntentId, "pi_offering_123"))
          .limit(1);

        expect(tx?.type).toBe("marketplace_purchase");
        expect(tx?.amountCents).toBe(4242);
        expect(tx?.feeCents).toBe(242);

        const [receipt] = await db
          .select()
          .from(resources)
          .where(eq(resources.type, "receipt"))
          .limit(1);

        expect(receipt?.ownerId).toBe(buyer.id);
      }));
  });

  // -----------------------------------------------------------------------
  // 15. Handler errors — returns 500
  // -----------------------------------------------------------------------

  describe("handler errors", () => {
    it("returns 500 when subscription upsert throws", async () => {
      // Use an agentId that doesn't exist to trigger a FK violation
      const stripeSub = makeStripeSubscription({
        metadata: { agentId: "00000000-0000-0000-0000-000000000099", tier: "host" },
      });
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", stripeSub)
      );
      mockTierForPriceId.mockReturnValue("host");

      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_INTERNAL_ERROR);
      expect(body.error).toBe("Webhook handler error");

      consoleErrorSpy.mockRestore();
    });

    it("returns 500 when checkout handler fails to retrieve subscription", async () => {
      const session = {
        id: "cs_failing",
        mode: "subscription",
        subscription: "sub_failing",
      };
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", session)
      );
      mockSubscriptionsRetrieve.mockRejectedValue(
        new Error("Stripe API error")
      );

      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const request = makeWebhookRequest("{}", {
        "stripe-signature": VALID_SIGNATURE,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(STATUS_INTERNAL_ERROR);
      expect(body.error).toBe("Webhook handler error");

      consoleErrorSpy.mockRestore();
    });
  });
});
