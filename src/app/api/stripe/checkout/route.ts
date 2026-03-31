/**
 * Stripe Checkout Session creation API route.
 *
 * Purpose:
 * - Validates an authenticated user's membership checkout request.
 * - Enforces allowed membership tiers and billing periods before calling billing services.
 *
 * Key exports:
 * - `POST`: Creates a Stripe Checkout Session URL for a membership purchase.
 *
 * Dependencies:
 * - `auth` for session authentication.
 * - `createCheckoutSession` and `MEMBERSHIP_TIERS` from billing utilities.
 * - Shared HTTP status constants for consistent API responses.
 *
 * Auth requirements:
 * - Requires a logged-in user with `session.user.id`.
 *
 * Rate limiting:
 * - No explicit route-level rate limiting is applied here.
 *
 * Error handling pattern:
 * - Validation and parse issues return `400`.
 * - Missing authentication returns `401`.
 * - Downstream billing failures are logged and return `500`.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createCheckoutSession, MEMBERSHIP_TIERS } from '@/lib/billing';
import type { MembershipTier } from '@/db/schema';
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_INTERNAL_ERROR,
  STATUS_TOO_MANY_REQUESTS,
} from '@/lib/http-status';
import { getClientIp } from '@/lib/client-ip';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';

const VALID_TIERS = new Set<string>(Object.keys(MEMBERSHIP_TIERS));
const VALID_PERIODS = new Set(['monthly', 'yearly']);

/**
 * Creates a membership checkout session for the authenticated user.
 *
 * @param {NextRequest} request - Incoming HTTP request with JSON body `{ tier, billingPeriod }`.
 * @returns {Promise<NextResponse>} JSON response with checkout URL on success, or an error payload on failure.
 * @throws {Error} When unexpected runtime errors occur outside the guarded parsing and billing sections.
 * @example
 * ```ts
 * // POST /api/stripe/checkout
 * // Body: { "tier": "pro", "billingPeriod": "monthly" }
 * ```
 */
export async function POST(request: NextRequest) {
  // Security boundary: only authenticated principals can initiate paid membership flows.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  const clientIp = getClientIp(request.headers);
  const limiter = await rateLimit(
    `membership-checkout:${clientIp}:${session.user.id}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: STATUS_TOO_MANY_REQUESTS }
    );
  }

  let body: { tier?: string; billingPeriod?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const { tier, billingPeriod } = body;

  // Business rule: tier must match known configured Stripe price mappings.
  if (!tier || !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `Invalid tier. Must be one of: ${[...VALID_TIERS].join(', ')}` },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Business rule: only monthly/yearly cycles are supported by current billing catalog.
  if (!billingPeriod || !VALID_PERIODS.has(billingPeriod)) {
    return NextResponse.json(
      { error: 'Invalid billingPeriod. Must be "monthly" or "yearly"' },
      { status: STATUS_BAD_REQUEST }
    );
  }

  try {
    // Casting is safe after explicit allow-list validation above.
    const url = await createCheckoutSession(
      session.user.id,
      tier as MembershipTier,
      billingPeriod as 'monthly' | 'yearly'
    );
    return NextResponse.json({ url });
  } catch (error) {
    // Avoid leaking downstream provider details to clients; keep detailed context in server logs.
    console.error('Checkout session creation failed:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
