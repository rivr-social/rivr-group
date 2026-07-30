// src/lib/stripe-webhook-errors.ts
//
// Error classification for the Stripe webhook's top-level catch. Kept out of
// the route module so it is independently unit-testable (Next.js route files
// may only export request handlers).

/**
 * The wallet/engine/billing throw for an agent id that has no row on THIS
 * instance (`lib/wallet.ts` getOrCreateWallet, `lib/engine.ts`,
 * `lib/connect-account.ts`, `lib/billing.ts` all raise this exact shape).
 */
export const FOREIGN_ENTITY_ERROR_PATTERN = /^Agent not found:/;

/**
 * Is this failure about an entity that does not live on this instance?
 *
 * Every instance shares the ONE Stripe platform account, so the webhook sees
 * events for other instances' entities. The per-lane `localAgentExists` guards
 * catch the shapes we know; anything that slips past them reaches a wallet or
 * engine lookup and throws `Agent not found: <id>`. A retry can NEVER succeed
 * for a non-local (or deleted) entity, so the handler acknowledges those with
 * 200 instead of feeding a Stripe retry storm (audit M-6). Every other error
 * still returns 500 so Stripe retries on its backoff policy.
 */
export function isForeignEntityError(err: unknown): boolean {
  return err instanceof Error && FOREIGN_ENTITY_ERROR_PATTERN.test(err.message);
}
