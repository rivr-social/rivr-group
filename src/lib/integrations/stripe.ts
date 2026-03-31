/**
 * @module stripe
 * @description Centralized Stripe integration helpers for currency normalization and
 * environment-backed key access.
 *
 * Purpose:
 * - Provide stable Stripe configuration constants used across the app.
 * - Convert user-facing dollar values to Stripe-compatible integer cents and back.
 * - Expose environment variable accessors for secret/publishable keys.
 *
 * Key exports:
 * - `STRIPE_API_VERSION`, `DEFAULT_CURRENCY`, `SUPPORTED_CURRENCIES`
 * - `toCents()`, `toDollars()`
 * - `getStripeSecretKey()`, `getStripePublishableKey()`, `isStripeConfigured()`
 *
 * Dependencies:
 * - `getEnv` from `@/lib/env` for validated environment access.
 *
 * Security:
 * - `STRIPE_SECRET_KEY` is server-only and must never be sent to clients.
 * - `STRIPE_PUBLISHABLE_KEY` is safe for browser usage.
 */

import { getEnv } from '@/lib/env';

/**
 * Stripe API version pin used to prevent behavior drift when Stripe introduces
 * backwards-incompatible defaults in newer versions.
 */
export const STRIPE_API_VERSION = '2024-12-18.acacia' as const;

/**
 * Default currency used when callers do not explicitly provide one.
 */
export const DEFAULT_CURRENCY = 'usd' as const;
/**
 * Allow-listed currencies intentionally constrained to known business-supported values.
 */
export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud'] as const;
/**
 * Union type derived from `SUPPORTED_CURRENCIES` to keep runtime and type-level
 * currency support synchronized.
 */
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Number of cents in one dollar. Stripe amount fields expect the smallest unit.
 */
export const CENTS_PER_DOLLAR = 100;

/**
 * Converts a dollar amount to cents for Stripe.
 *
 * @param dollars - Amount in dollars
 * @returns Amount in cents (integer)
 * @throws {TypeError} Propagates if callers pass a non-numeric value at runtime.
 * @example
 * ```ts
 * const cents = toCents(19.99); // 1999
 * ```
 */
export function toCents(dollars: number): number {
  // `Math.round` helps avoid floating-point precision artifacts (for example, 10.1 * 100).
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

/**
 * Converts a cent amount from Stripe to dollars.
 *
 * @param cents - Amount in cents
 * @returns Amount in dollars
 * @throws {TypeError} Propagates if callers pass a non-numeric value at runtime.
 * @example
 * ```ts
 * const dollars = toDollars(2599); // 25.99
 * ```
 */
export function toDollars(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}

/**
 * Returns the Stripe secret key for server-side API calls.
 * This must only be called on the server.
 *
 * @param _unused - This function does not accept parameters.
 * @returns The Stripe secret key
 * @throws Error if STRIPE_SECRET_KEY is not configured in production
 * @example
 * ```ts
 * const secretKey = getStripeSecretKey();
 * // Use only in server runtime contexts.
 * ```
 */
export function getStripeSecretKey(): string {
  // Centralized env lookup keeps validation/throw behavior consistent across callers.
  return getEnv('STRIPE_SECRET_KEY');
}

/**
 * Returns the Stripe publishable key for client-side usage.
 * This is safe to expose in the browser.
 *
 * @param _unused - This function does not accept parameters.
 * @returns The Stripe publishable key
 * @throws Error if STRIPE_PUBLISHABLE_KEY is required but missing by environment policy
 * @example
 * ```ts
 * const publishableKey = getStripePublishableKey();
 * ```
 */
export function getStripePublishableKey(): string {
  return getEnv('STRIPE_PUBLISHABLE_KEY');
}

/**
 * Checks whether Stripe is configured with both required keys.
 *
 * @param _unused - This function does not accept parameters.
 * @returns true if both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are set
 * @throws {TypeError} Never intentionally thrown; runtime errors are only possible from environment access failures.
 * @example
 * ```ts
 * if (!isStripeConfigured()) {
 *   // Skip Stripe-dependent flows in local/dev.
 * }
 * ```
 */
export function isStripeConfigured(): boolean {
  // Existence check avoids throwing and supports feature gating where partial config is expected.
  return !!(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_PUBLISHABLE_KEY
  );
}
