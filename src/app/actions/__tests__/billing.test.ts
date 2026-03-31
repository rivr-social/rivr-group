import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock setup — must be declared before importing the module under   */
/*  test so that vi.mock hoisting replaces the real dependencies.     */
/* ------------------------------------------------------------------ */

const mockAuth = vi.fn();
const mockCreateCheckoutSession = vi.fn();
const mockGetActiveSubscription = vi.fn();

vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/billing", () => ({
  createCheckoutSession: (...args: unknown[]) =>
    mockCreateCheckoutSession(...args),
  getActiveSubscription: (...args: unknown[]) =>
    mockGetActiveSubscription(...args),
  DEFAULT_MEMBERSHIP_TRIAL_DAYS: 30,
  MEMBERSHIP_TIERS: {
    host: {
      name: "Host",
      monthlyPriceId: "price_host_monthly",
      yearlyPriceId: "price_host_yearly",
    },
    seller: {
      name: "Seller",
      monthlyPriceId: "price_seller_monthly",
      yearlyPriceId: "price_seller_yearly",
    },
    organizer: {
      name: "Organizer",
      monthlyPriceId: "price_organizer_monthly",
      yearlyPriceId: "price_organizer_yearly",
    },
    steward: {
      name: "Steward",
      monthlyPriceId: "price_steward_monthly",
      yearlyPriceId: "price_steward_yearly",
    },
  },
}));

/* ------------------------------------------------------------------ */
/*  Import the server actions AFTER mocks are registered.             */
/* ------------------------------------------------------------------ */

import {
  createCheckoutAction,
  getSubscriptionStatusAction,
} from "../billing";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const USER_ID = "user-billing-123";
const CHECKOUT_URL = "https://checkout.stripe.com/c/cs_test_abc123";
const PERIOD_END = new Date("2026-03-18T00:00:00.000Z");

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("billing actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  });

  /* ================================================================ */
  /*  createCheckoutAction                                            */
  /* ================================================================ */

  describe("createCheckoutAction", () => {
    it("returns error when user is not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const result = await createCheckoutAction("host", "monthly");

      expect(result).toEqual({
        success: false,
        error: "You must be logged in to subscribe.",
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns error when session exists but user.id is missing", async () => {
      mockAuth.mockResolvedValueOnce({ user: {} });

      const result = await createCheckoutAction("host", "monthly");

      expect(result).toEqual({
        success: false,
        error: "You must be logged in to subscribe.",
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns error when session.user is undefined", async () => {
      mockAuth.mockResolvedValueOnce({});

      const result = await createCheckoutAction("seller", "yearly");

      expect(result).toEqual({
        success: false,
        error: "You must be logged in to subscribe.",
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns error for an invalid tier", async () => {
      const result = await createCheckoutAction("platinum", "monthly");

      expect(result).toEqual({
        success: false,
        error: "Invalid membership tier: platinum",
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns error for an empty tier string", async () => {
      const result = await createCheckoutAction("", "yearly");

      expect(result).toEqual({
        success: false,
        error: "Invalid membership tier: ",
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns error for an invalid billing period", async () => {
      // Cast to bypass TypeScript's compile-time check since we want to
      // exercise the runtime guard inside the action.
      const result = await createCheckoutAction(
        "host",
        "weekly" as "monthly" | "yearly"
      );

      expect(result).toEqual({
        success: false,
        error: 'Billing period must be "monthly" or "yearly".',
      });
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("returns checkout URL on successful monthly checkout", async () => {
      mockCreateCheckoutSession.mockResolvedValueOnce(CHECKOUT_URL);

      const result = await createCheckoutAction("host", "monthly");

      expect(result).toEqual({
        success: true,
        url: CHECKOUT_URL,
      });
      expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        USER_ID,
        "host",
        "monthly",
        { trialDays: 30 }
      );
    });

    it("returns checkout URL on successful yearly checkout", async () => {
      mockCreateCheckoutSession.mockResolvedValueOnce(CHECKOUT_URL);

      const result = await createCheckoutAction("steward", "yearly");

      expect(result).toEqual({
        success: true,
        url: CHECKOUT_URL,
      });
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        USER_ID,
        "steward",
        "yearly",
        { trialDays: 30 }
      );
    });

    it.each(["host", "seller", "organizer", "steward"] as const)(
      "accepts the valid tier '%s'",
      async (tier) => {
        mockCreateCheckoutSession.mockResolvedValueOnce(CHECKOUT_URL);

        const result = await createCheckoutAction(tier, "monthly");

        expect(result.success).toBe(true);
        expect(result.url).toBe(CHECKOUT_URL);
        expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
          USER_ID,
          tier,
          "monthly",
          { trialDays: 30 }
        );
      }
    );

    it("returns generic error when createCheckoutSession throws", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      mockCreateCheckoutSession.mockRejectedValueOnce(
        new Error("Stripe API unreachable")
      );

      const result = await createCheckoutAction("organizer", "monthly");

      expect(result).toEqual({
        success: false,
        error: "Unable to start checkout. Please try again later.",
      });
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "createCheckoutAction failed:",
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it("does not leak internal error details to the caller", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      mockCreateCheckoutSession.mockRejectedValueOnce(
        new Error("stripe_secret_key is missing")
      );

      const result = await createCheckoutAction("seller", "yearly");

      expect(result.error).not.toContain("stripe_secret_key");
      expect(result.error).toBe(
        "Unable to start checkout. Please try again later."
      );

      vi.restoreAllMocks();
    });
  });

  /* ================================================================ */
  /*  getSubscriptionStatusAction                                     */
  /* ================================================================ */

  describe("getSubscriptionStatusAction", () => {
    it("returns null when user is not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);

      const result = await getSubscriptionStatusAction();

      expect(result).toBeNull();
      expect(mockGetActiveSubscription).not.toHaveBeenCalled();
    });

    it("returns null when session.user.id is missing", async () => {
      mockAuth.mockResolvedValueOnce({ user: {} });

      const result = await getSubscriptionStatusAction();

      expect(result).toBeNull();
      expect(mockGetActiveSubscription).not.toHaveBeenCalled();
    });

    it("returns null when no active subscription exists", async () => {
      mockGetActiveSubscription.mockResolvedValueOnce(null);

      const result = await getSubscriptionStatusAction();

      expect(result).toBeNull();
      expect(mockGetActiveSubscription).toHaveBeenCalledWith(USER_ID);
    });

    it("returns subscription details for an active subscription", async () => {
      mockGetActiveSubscription.mockResolvedValueOnce({
        membershipTier: "steward",
        status: "active",
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
      });

      const result = await getSubscriptionStatusAction();

      expect(result).toEqual({
        tier: "steward",
        status: "active",
        currentPeriodEnd: PERIOD_END.toISOString(),
        cancelAtPeriodEnd: false,
      });
      expect(mockGetActiveSubscription).toHaveBeenCalledOnce();
      expect(mockGetActiveSubscription).toHaveBeenCalledWith(USER_ID);
    });

    it("returns subscription details for a trialing subscription", async () => {
      const trialEnd = new Date("2026-04-01T12:00:00.000Z");
      mockGetActiveSubscription.mockResolvedValueOnce({
        membershipTier: "host",
        status: "trialing",
        currentPeriodEnd: trialEnd,
        cancelAtPeriodEnd: false,
      });

      const result = await getSubscriptionStatusAction();

      expect(result).toEqual({
        tier: "host",
        status: "trialing",
        currentPeriodEnd: trialEnd.toISOString(),
        cancelAtPeriodEnd: false,
      });
    });

    it("returns cancelAtPeriodEnd as true when subscription is set to cancel", async () => {
      mockGetActiveSubscription.mockResolvedValueOnce({
        membershipTier: "seller",
        status: "active",
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: true,
      });

      const result = await getSubscriptionStatusAction();

      expect(result).toEqual({
        tier: "seller",
        status: "active",
        currentPeriodEnd: PERIOD_END.toISOString(),
        cancelAtPeriodEnd: true,
      });
    });

    it("serializes currentPeriodEnd as an ISO 8601 string", async () => {
      const specificDate = new Date("2026-12-31T23:59:59.999Z");
      mockGetActiveSubscription.mockResolvedValueOnce({
        membershipTier: "organizer",
        status: "active",
        currentPeriodEnd: specificDate,
        cancelAtPeriodEnd: false,
      });

      const result = await getSubscriptionStatusAction();

      expect(result).not.toBeNull();
      expect(result!.currentPeriodEnd).toBe("2026-12-31T23:59:59.999Z");
      expect(typeof result!.currentPeriodEnd).toBe("string");
    });
  });
});
