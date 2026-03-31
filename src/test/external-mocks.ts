/**
 * External service mocks — Stripe + SMTP.
 *
 * Only external network services are mocked. Database, schema, and all
 * internal modules use real implementations against the test database.
 *
 * Usage:
 *   import { STRIPE_MOCK, EMAIL_MOCK, setupStripeMock, setupEmailMock } from '@/test/external-mocks';
 */

import { vi } from "vitest";

// =============================================================================
// Stripe mock
// =============================================================================

/**
 * Builds a mock Stripe customer object.
 *
 * @param id - Stripe customer ID (defaults to "cus_test_123").
 * @returns A minimal Stripe customer-shaped object.
 */
function mockCustomer(id: string = "cus_test_123") {
  return {
    id,
    object: "customer" as const,
    email: "test@test.local",
    name: "Test User",
    metadata: {},
    created: Math.floor(Date.now() / 1000),
  };
}

/**
 * Builds a mock Stripe PaymentIntent object.
 *
 * @param id - PaymentIntent ID (defaults to "pi_test_123").
 * @param amount - Amount in cents (defaults to 1000 = $10.00).
 * @returns A minimal Stripe PaymentIntent-shaped object with status "succeeded".
 */
function mockPaymentIntent(
  id: string = "pi_test_123",
  amount: number = 1000
) {
  return {
    id,
    object: "payment_intent" as const,
    amount,
    currency: "usd",
    status: "succeeded" as const,
    client_secret: `${id}_secret_test`,
    metadata: {},
    created: Math.floor(Date.now() / 1000),
  };
}

/**
 * Builds a mock Stripe Checkout Session object.
 *
 * @param id - Checkout session ID (defaults to "cs_test_123").
 * @returns A minimal Stripe Checkout Session with status "complete" and payment "paid".
 */
function mockCheckoutSession(id: string = "cs_test_123") {
  return {
    id,
    object: "checkout.session" as const,
    url: `https://checkout.stripe.com/test/${id}`,
    payment_status: "paid" as const,
    status: "complete" as const,
    customer: "cus_test_123",
    subscription: "sub_test_123",
    metadata: {},
    created: Math.floor(Date.now() / 1000),
  };
}

/**
 * Builds a mock Stripe Subscription object.
 *
 * @param id - Subscription ID (defaults to "sub_test_123").
 * @returns A minimal Stripe Subscription with status "active" and a 30-day period.
 */
function mockSubscription(id: string = "sub_test_123") {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "subscription" as const,
    customer: "cus_test_123",
    status: "active" as const,
    current_period_start: now,
    current_period_end: now + 30 * 24 * 60 * 60,
    items: {
      data: [
        {
          id: "si_test_123",
          price: { id: "price_test_123", unit_amount: 999 },
        },
      ],
    },
    metadata: {},
    created: now,
  };
}

/**
 * Creates a complete Stripe API mock with all commonly used endpoints.
 *
 * Each method is a `vi.fn()` pre-configured with sensible defaults.
 * The `_builders` property exposes the individual mock object factories
 * so tests can customize return values for specific scenarios.
 *
 * @returns A Stripe-shaped mock object covering customers, payment intents,
 *          checkout sessions, subscriptions, and webhook construction.
 */
export function createStripeMock() {
  return {
    customers: {
      create: vi.fn().mockResolvedValue(mockCustomer()),
      retrieve: vi.fn().mockResolvedValue(mockCustomer()),
      update: vi.fn().mockResolvedValue(mockCustomer()),
      list: vi.fn().mockResolvedValue({ data: [mockCustomer()] }),
    },
    paymentIntents: {
      create: vi.fn().mockResolvedValue(mockPaymentIntent()),
      retrieve: vi.fn().mockResolvedValue(mockPaymentIntent()),
      confirm: vi.fn().mockResolvedValue(mockPaymentIntent()),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue(mockCheckoutSession()),
        retrieve: vi.fn().mockResolvedValue(mockCheckoutSession()),
      },
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue(mockSubscription()),
      retrieve: vi.fn().mockResolvedValue(mockSubscription()),
      update: vi.fn().mockResolvedValue(mockSubscription()),
      cancel: vi.fn().mockResolvedValue({ ...mockSubscription(), status: "canceled" }),
    },
    webhooks: {
      constructEvent: vi.fn().mockReturnValue({
        id: "evt_test_123",
        type: "checkout.session.completed",
        data: { object: mockCheckoutSession() },
      }),
    },
    // Expose builders for custom overrides in specific tests
    _builders: {
      mockCustomer,
      mockPaymentIntent,
      mockCheckoutSession,
      mockSubscription,
    },
  };
}

/**
 * Pre-built Stripe mock singleton. Import and reference this in tests
 * to assert on specific Stripe API calls.
 */
export const STRIPE_MOCK = createStripeMock();

/**
 * Returns a vi.mock-compatible module factory for the `stripe` package.
 *
 * Use with `vi.mock('stripe', () => setupStripeMock())` at the top level
 * of your test file.
 *
 * @returns An object with `__esModule: true` and a default export that
 *          returns the shared `STRIPE_MOCK` instance.
 */
export function setupStripeMock() {
  return {
    __esModule: true,
    default: vi.fn().mockReturnValue(STRIPE_MOCK),
  };
}

// =============================================================================
// Email (nodemailer/SMTP) mock
// =============================================================================

export const EMAIL_MOCK = {
  sendEmail: vi.fn().mockResolvedValue({
    success: true,
    messageId: "test-message-id-123",
    error: undefined,
  }),
};

/**
 * Returns a vi.mock-compatible module factory for `@/lib/email`.
 *
 * Use with `vi.mock('@/lib/email', () => setupEmailMock())`.
 *
 * @returns An object whose `sendEmail` is the shared `EMAIL_MOCK.sendEmail` spy.
 */
export function setupEmailMock() {
  return {
    sendEmail: EMAIL_MOCK.sendEmail,
  };
}

// =============================================================================
// Next.js framework mocks
// =============================================================================

/**
 * Returns a vi.mock-compatible module factory for `next/headers`.
 *
 * Provides a fake `headers()` returning a Map-backed headers object
 * and a fake `cookies()` with get/set/delete spies. Tests can inject
 * custom headers via `_mockHeaders._set(key, value)`.
 *
 * @returns Module shape with `headers`, `cookies`, and `_mockHeaders` for
 *          programmatic header manipulation in tests.
 */
export function setupNextHeadersMock() {
  const headersMap = new Map<string, string>();
  headersMap.set("x-forwarded-for", "127.0.0.1");
  headersMap.set("user-agent", "vitest/1.0");

  const mockHeaders = {
    get: (key: string) => headersMap.get(key.toLowerCase()) ?? null,
    has: (key: string) => headersMap.has(key.toLowerCase()),
    entries: () => headersMap.entries(),
    forEach: (cb: (value: string, key: string) => void) => headersMap.forEach(cb),
    keys: () => headersMap.keys(),
    values: () => headersMap.values(),
    // Allow tests to add custom headers
    _set: (key: string, value: string) => headersMap.set(key.toLowerCase(), value),
    _clear: () => headersMap.clear(),
  };

  return {
    headers: vi.fn().mockResolvedValue(mockHeaders),
    cookies: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      delete: vi.fn(),
    }),
    _mockHeaders: mockHeaders,
  };
}

/**
 * Returns a vi.mock-compatible module factory for `next/cache`.
 *
 * All cache busting functions (`revalidatePath`, `revalidateTag`) are no-op
 * spies. `unstable_cache` passes through to the wrapped function directly
 * so cached server actions execute without a real cache layer.
 *
 * @returns Module shape with `revalidatePath`, `revalidateTag`, and
 *          `unstable_cache` stubs.
 */
export function setupNextCacheMock() {
  return {
    revalidatePath: vi.fn(),
    revalidateTag: vi.fn(),
    unstable_cache: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
  };
}
