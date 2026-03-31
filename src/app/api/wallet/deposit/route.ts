/**
 * Wallet deposit API route.
 *
 * Purpose:
 * - Validates a requested deposit amount for an authenticated user.
 * - Applies per-user rate limiting before creating a Stripe PaymentIntent.
 * - Ensures a personal wallet exists before issuing a deposit intent.
 *
 * Key exports:
 * - `POST`: Creates a client-secret-backed deposit PaymentIntent.
 *
 * Dependencies:
 * - `auth` for identity checks.
 * - `rateLimit` + `RATE_LIMITS.WALLET_DEPOSIT` for abuse prevention.
 * - Wallet helpers (`getOrCreateWallet`, `createDepositIntent`) and deposit bounds constants.
 *
 * Auth requirements:
 * - Requires a logged-in user with an agent ID.
 *
 * Rate limiting:
 * - Enforced using key `wallet-deposit:{agentId}` and configured wallet-deposit window/limit.
 *
 * Error handling pattern:
 * - Validation failures return `400`.
 * - Missing auth returns `401`.
 * - Rate-limit violations return `429`.
 * - Unexpected wallet/Stripe failures are logged and return `500`.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getOrCreateWallet, createDepositIntent } from '@/lib/wallet';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS } from '@/lib/wallet-constants';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';

/**
 * POST /api/wallet/deposit
 *
 * Creates a Stripe PaymentIntent for depositing funds into the
 * authenticated user's personal wallet.
 *
 * Body: { amountCents: number }
 * Returns: { clientSecret: string }
 *
 * @param {NextRequest} request - Incoming HTTP request with JSON body `{ amountCents }`.
 * @returns {Promise<NextResponse>} JSON response containing `clientSecret` on success or an error payload.
 * @throws {Error} When unexpected runtime errors occur before they are converted to API responses.
 * @example
 * ```ts
 * // POST /api/wallet/deposit
 * // Body: { "amountCents": 2500 }
 * ```
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  const agentId = session?.user?.id;

  if (!agentId) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  // Abuse protection: throttle deposit intent creation per authenticated agent.
  const check = await rateLimit(
    `wallet-deposit:${agentId}`,
    RATE_LIMITS.WALLET_DEPOSIT.limit,
    RATE_LIMITS.WALLET_DEPOSIT.windowMs,
  );

  if (!check.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  let body: { amountCents?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const amountCents = Number(body.amountCents);

  // Require integer cents to avoid floating-point currency ambiguity.
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json(
      { error: 'amountCents must be a positive integer' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  if (amountCents < MIN_DEPOSIT_CENTS) {
    return NextResponse.json(
      { error: `Minimum deposit is $${(MIN_DEPOSIT_CENTS / 100).toFixed(2)}` },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Business rule: cap large deposits to reduce fraud and operational risk.
  if (amountCents > MAX_DEPOSIT_CENTS) {
    return NextResponse.json(
      { error: `Maximum deposit is $${(MAX_DEPOSIT_CENTS / 100).toFixed(2)}` },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    // Wallet creation is lazy to support first-time depositors without pre-provisioning.
    const wallet = await getOrCreateWallet(agentId, 'personal');
    const result = await createDepositIntent(wallet.id, amountCents);
    return NextResponse.json(
      { clientSecret: result.clientSecret },
      { status: STATUS_OK },
    );
  } catch (error) {
    // Log server-side details while returning a generic message to avoid leaking internals.
    console.error('Wallet deposit route error:', error);
    return NextResponse.json(
      { error: 'Failed to create deposit' },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
