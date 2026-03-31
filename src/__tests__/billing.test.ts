/**
 * Tests for the Stripe billing module
 * Validates tier hierarchy, entitlement checks, price-to-tier mapping,
 * and checkout session creation with mocked Stripe + DB layers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — runs before any vi.mock factory and before module evaluation.
// ---------------------------------------------------------------------------

const {
  mockStripeCustomersList,
  mockStripeCustomersCreate,
  mockStripeCheckoutSessionsCreate,
  mockDbSelect,
  mockDbInsert,
} = vi.hoisted(() => {
  // Environment variables must be set before the billing module is loaded,
  // because MEMBERSHIP_TIERS reads process.env at module init.
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_basic_monthly';
  process.env.STRIPE_PRICE_BASIC_YEARLY = 'price_basic_yearly';
  process.env.STRIPE_PRICE_HOST_MONTHLY = 'price_host_monthly';
  process.env.STRIPE_PRICE_HOST_YEARLY = 'price_host_yearly';
  process.env.STRIPE_PRICE_SELLER_MONTHLY = 'price_seller_monthly';
  process.env.STRIPE_PRICE_SELLER_YEARLY = 'price_seller_yearly';
  process.env.STRIPE_PRICE_ORGANIZER_MONTHLY = 'price_organizer_monthly';
  process.env.STRIPE_PRICE_ORGANIZER_YEARLY = 'price_organizer_yearly';
  process.env.STRIPE_PRICE_STEWARD_MONTHLY = 'price_steward_monthly';
  process.env.STRIPE_PRICE_STEWARD_YEARLY = 'price_steward_yearly';
  process.env.NEXTAUTH_URL = 'http://localhost:3000';

  return {
    mockStripeCustomersList: vi.fn(),
    mockStripeCustomersCreate: vi.fn(),
    mockStripeCheckoutSessionsCreate: vi.fn(),
    mockDbSelect: vi.fn(),
    mockDbInsert: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('stripe', () => {
  // Must return a constructor-compatible function (class-like)
  function StripeMock() {
    return {
      customers: {
        list: mockStripeCustomersList,
        create: mockStripeCustomersCreate,
      },
      checkout: {
        sessions: {
          create: mockStripeCheckoutSessionsCreate,
        },
      },
      webhooks: { constructEvent: vi.fn() },
    };
  }
  return { default: StripeMock };
});

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
}));

vi.mock('@/db/schema', () => ({
  agents: { id: 'agents.id', email: 'agents.email', name: 'agents.name' },
  subscriptions: {
    id: 'subscriptions.id',
    agentId: 'subscriptions.agentId',
    stripeCustomerId: 'subscriptions.stripeCustomerId',
    status: 'subscriptions.status',
    $inferInsert: {},
  },
  subscriptionStatusEnum: { enumValues: ['active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'unpaid', 'paused'] },
  membershipTierEnum: { enumValues: ['basic', 'host', 'seller', 'organizer', 'steward'] },
}));

vi.mock('@/lib/integrations/stripe', () => ({
  getStripeSecretKey: () => 'sk_test_mock',
  STRIPE_API_VERSION: '2024-12-18.acacia',
}));

vi.mock('@/lib/membership-pricing', () => ({
  getMembershipConnectSurchargeCents: vi.fn((period: string) => period === 'yearly' ? 2400 : 200),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _col, _val })),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
}));

import {
  MEMBERSHIP_TIERS,
  TIER_HIERARCHY,
  tierForPriceId,
  getOrCreateStripeCustomer,
  getActiveSubscription,
  hasEntitlement,
  createCheckoutSession,
} from '@/lib/billing';
import type { MembershipTier } from '@/db/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fluent chain that resolves to `result` at the terminal call. */
function chainResult(result: unknown) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(result)),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('billing – MEMBERSHIP_TIERS', () => {
  it('has five tiers with correct names', () => {
    expect(Object.keys(MEMBERSHIP_TIERS)).toEqual(['basic', 'host', 'seller', 'organizer', 'steward']);
    expect(MEMBERSHIP_TIERS.basic.name).toBe('Basic');
    expect(MEMBERSHIP_TIERS.host.name).toBe('Host');
    expect(MEMBERSHIP_TIERS.seller.name).toBe('Seller');
    expect(MEMBERSHIP_TIERS.organizer.name).toBe('Organizer');
    expect(MEMBERSHIP_TIERS.steward.name).toBe('Steward');
  });

  it('loads price IDs from environment variables', () => {
    expect(MEMBERSHIP_TIERS.basic.monthlyPriceId).toBe('price_basic_monthly');
    expect(MEMBERSHIP_TIERS.basic.yearlyPriceId).toBe('price_basic_yearly');
    expect(MEMBERSHIP_TIERS.host.monthlyPriceId).toBe('price_host_monthly');
    expect(MEMBERSHIP_TIERS.host.yearlyPriceId).toBe('price_host_yearly');
    expect(MEMBERSHIP_TIERS.steward.monthlyPriceId).toBe('price_steward_monthly');
    expect(MEMBERSHIP_TIERS.steward.yearlyPriceId).toBe('price_steward_yearly');
  });
});

describe('billing – TIER_HIERARCHY', () => {
  it('orders tiers from lowest to highest', () => {
    expect(TIER_HIERARCHY).toEqual(['basic', 'host', 'seller', 'organizer', 'steward']);
  });

  it('basic has the lowest index', () => {
    expect(TIER_HIERARCHY.indexOf('basic')).toBe(0);
  });

  it('steward has the highest index', () => {
    expect(TIER_HIERARCHY.indexOf('steward')).toBe(4);
  });
});

describe('billing – tierForPriceId', () => {
  it('maps a monthly price to the correct tier', () => {
    expect(tierForPriceId('price_basic_monthly')).toBe('basic');
    expect(tierForPriceId('price_host_monthly')).toBe('host');
    expect(tierForPriceId('price_seller_monthly')).toBe('seller');
    expect(tierForPriceId('price_organizer_monthly')).toBe('organizer');
    expect(tierForPriceId('price_steward_monthly')).toBe('steward');
  });

  it('maps a yearly price to the correct tier', () => {
    expect(tierForPriceId('price_basic_yearly')).toBe('basic');
    expect(tierForPriceId('price_host_yearly')).toBe('host');
    expect(tierForPriceId('price_steward_yearly')).toBe('steward');
  });

  it('returns null for an unknown price ID', () => {
    expect(tierForPriceId('price_unknown')).toBeNull();
    expect(tierForPriceId('')).toBeNull();
  });
});

describe('billing – getActiveSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an active subscription if found', async () => {
    const mockSub = {
      id: 'sub-1',
      agentId: 'agent-1',
      status: 'active',
      membershipTier: 'host',
    };

    mockDbSelect.mockReturnValueOnce(chainResult([mockSub]));

    const result = await getActiveSubscription('agent-1');
    expect(result).toEqual(mockSub);
  });

  it('returns a trialing subscription (single query with or())', async () => {
    const mockTrialSub = {
      id: 'sub-2',
      agentId: 'agent-1',
      status: 'trialing',
      membershipTier: 'seller',
    };

    mockDbSelect.mockReturnValueOnce(chainResult([mockTrialSub]));

    const result = await getActiveSubscription('agent-1');
    expect(result).toEqual(mockTrialSub);
  });

  it('returns null when no subscription exists', async () => {
    mockDbSelect.mockReturnValueOnce(chainResult([]));

    const result = await getActiveSubscription('agent-1');
    expect(result).toBeNull();
  });
});

describe('billing – hasEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when the agent has no subscription', async () => {
    mockDbSelect.mockReturnValue(chainResult([]));

    const result = await hasEntitlement('agent-1', 'host');
    expect(result).toBe(false);
  });

  it('returns true when agent tier matches the required tier', async () => {
    const mockSub = { membershipTier: 'seller', status: 'active' };
    mockDbSelect.mockReturnValueOnce(chainResult([mockSub]));

    const result = await hasEntitlement('agent-1', 'seller');
    expect(result).toBe(true);
  });

  it('returns true when agent tier is higher than required', async () => {
    const mockSub = { membershipTier: 'steward', status: 'active' };
    mockDbSelect.mockReturnValueOnce(chainResult([mockSub]));

    const result = await hasEntitlement('agent-1', 'host');
    expect(result).toBe(true);
  });

  it('returns false when agent tier is lower than required', async () => {
    const mockSub = { membershipTier: 'host', status: 'active' };
    mockDbSelect.mockReturnValueOnce(chainResult([mockSub]));

    const result = await hasEntitlement('agent-1', 'steward');
    expect(result).toBe(false);
  });

  it('steward includes all lower tier entitlements', async () => {
    const mockSub = { membershipTier: 'steward', status: 'active' };

    for (const tier of TIER_HIERARCHY) {
      vi.clearAllMocks();
      mockDbSelect.mockReturnValueOnce(chainResult([mockSub]));
      const result = await hasEntitlement('agent-1', tier);
      expect(result).toBe(true);
    }
  });
});

describe('billing – getOrCreateStripeCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing customer ID from subscription record', async () => {
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ stripeCustomerId: 'cus_existing' }])
    );

    const result = await getOrCreateStripeCustomer('agent-1');
    expect(result).toBe('cus_existing');
    expect(mockStripeCustomersList).not.toHaveBeenCalled();
  });

  it('searches Stripe by email when no local subscription exists', async () => {
    mockDbSelect.mockReturnValueOnce(chainResult([]));
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ id: 'agent-1', email: 'test@example.com', name: 'Test User' }])
    );

    mockStripeCustomersList.mockResolvedValueOnce({
      data: [{ id: 'cus_found' }],
    });

    const result = await getOrCreateStripeCustomer('agent-1');
    expect(result).toBe('cus_found');
    expect(mockStripeCustomersList).toHaveBeenCalledWith({
      email: 'test@example.com',
      limit: 1,
    });
  });

  it('creates a new Stripe customer when none found', async () => {
    mockDbSelect.mockReturnValueOnce(chainResult([]));
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ id: 'agent-1', email: 'new@example.com', name: 'New User' }])
    );

    mockStripeCustomersList.mockResolvedValueOnce({ data: [] });
    mockStripeCustomersCreate.mockResolvedValueOnce({ id: 'cus_created' });

    const result = await getOrCreateStripeCustomer('agent-1');
    expect(result).toBe('cus_created');
    expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
      email: 'new@example.com',
      name: 'New User',
      metadata: { agentId: 'agent-1' },
    });
  });

  it('throws when agent is not found', async () => {
    mockDbSelect.mockReturnValueOnce(chainResult([]));
    mockDbSelect.mockReturnValueOnce(chainResult([]));

    await expect(getOrCreateStripeCustomer('nonexistent')).rejects.toThrow(
      'Agent not found: nonexistent'
    );
  });
});

describe('billing – createCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a checkout session with the correct parameters', async () => {
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ stripeCustomerId: 'cus_test' }])
    );

    mockStripeCheckoutSessionsCreate.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/session_abc',
    });

    const url = await createCheckoutSession('agent-1', 'host', 'monthly');
    expect(url).toBe('https://checkout.stripe.com/session_abc');

    expect(mockStripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test',
        mode: 'subscription',
        payment_method_collection: 'always',
        line_items: expect.arrayContaining([
          { price: 'price_host_monthly', quantity: 1 },
        ]),
        success_url: expect.stringContaining('/api/stripe/subscription-success'),
        cancel_url: expect.stringContaining('/products/membership-host?subscription=canceled'),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ agentId: 'agent-1', tier: 'host' }),
        }),
        metadata: expect.objectContaining({ agentId: 'agent-1', tier: 'host', billingPeriod: 'monthly' }),
      })
    );
  });

  it('uses yearly price ID when billingPeriod is yearly', async () => {
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ stripeCustomerId: 'cus_test' }])
    );

    mockStripeCheckoutSessionsCreate.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/session_yearly',
    });

    await createCheckoutSession('agent-1', 'seller', 'yearly');

    expect(mockStripeCheckoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: expect.arrayContaining([
          { price: 'price_seller_yearly', quantity: 1 },
        ]),
      })
    );
  });

  it('throws for an unknown tier', async () => {
    await expect(
       
      createCheckoutSession('agent-1', 'invalid' as unknown as MembershipTier, 'monthly')
    ).rejects.toThrow('Unknown membership tier');
  });

  it('throws when Stripe returns no URL', async () => {
    mockDbSelect.mockReturnValueOnce(
      chainResult([{ stripeCustomerId: 'cus_test' }])
    );

    mockStripeCheckoutSessionsCreate.mockResolvedValueOnce({ url: null });

    await expect(
      createCheckoutSession('agent-1', 'host', 'monthly')
    ).rejects.toThrow('Stripe returned a checkout session without a URL');
  });
});
