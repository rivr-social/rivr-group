/**
 * Content-addressed identifiers for DURABLE IDEMPOTENCY on money actions.
 *
 * Every real-money lane in this app is made retry-safe the same way: the caller
 * supplies a stable request id, the write lane keys its durable row on it, and a
 * replay converges on the original row instead of paying again (see
 * `lib/connect-bank-payout.ts` and the distribution runs' `idempotencyKey`).
 *
 * That only holds while the id is STABLE ACROSS RETRIES. A caller that mints a
 * fresh `crypto.randomUUID()` per attempt defeats the whole mechanism — the
 * retry looks like a brand-new request and the money moves twice. Programmatic
 * callers (MCP agents, scripts) have no form state to hang a once-generated
 * token on, so they need the id DERIVED from what they are asking for.
 *
 * {@link deterministicUuid} is that derivation: same request content in, same
 * id out, in a shape the existing lanes already accept (an RFC-4122 UUID, which
 * `connect-bank-payout.ts` validates strictly). Callers that legitimately want
 * to repeat an identical request mix in their own distinguishing token — that
 * is a deliberate act, not an accidental double-submit.
 */
import { createHash } from 'node:crypto';

/**
 * Namespaces keep two different money lanes from colliding on identical-looking
 * content (e.g. an amount + agent id that means something different per lane).
 */
export const DETERMINISTIC_ID_NAMESPACES = {
  /** MCP-initiated seller payout request (`rivr.wallet.request_payout`). */
  MCP_PAYOUT_REQUEST: 'rivr.payout.mcp-request',
  /** Layer-2 net distribution run (group pie / project tree). */
  NET_DISTRIBUTION_RUN: 'rivr.distribution.run',
} as const;

export type DeterministicIdNamespace =
  (typeof DETERMINISTIC_ID_NAMESPACES)[keyof typeof DETERMINISTIC_ID_NAMESPACES];

/** A part of the content a deterministic id is derived from. */
export type DeterministicIdPart = string | number | boolean | null | undefined;

/** Unit separator — cannot appear in ids/amounts, so parts can never blend. */
const PART_SEPARATOR = '\u001F';

/**
 * Canonical string for a list of content parts.
 *
 * `null`/`undefined` collapse to the empty string (an absent optional and an
 * empty one mean the same request), and the separator makes `["a","bc"]`
 * distinct from `["ab","c"]`.
 */
export function canonicalizeIdParts(parts: readonly DeterministicIdPart[]): string {
  return parts.map((part) => (part === null || part === undefined ? '' : String(part))).join(
    PART_SEPARATOR,
  );
}

/**
 * Derives a stable RFC-4122 UUID (version 5, variant 10xx) from a namespace and
 * request content.
 *
 * Deterministic and collision-resistant: the id is the first 128 bits of
 * SHA-256 over `namespace + parts`, with the version/variant nibbles stamped so
 * strict validators (`connect-bank-payout.ts`) accept it. Identical content
 * ALWAYS yields the identical id — that is the point: it is what turns a
 * duplicate submission into a replay.
 *
 * @param namespace Lane namespace — see {@link DETERMINISTIC_ID_NAMESPACES}.
 * @param parts Stable request content (ids, amounts, a caller-supplied token).
 * @returns A lowercase UUID string.
 */
export function deterministicUuid(
  namespace: DeterministicIdNamespace | string,
  parts: readonly DeterministicIdPart[],
): string {
  const hash = createHash('sha256')
    .update(namespace)
    .update(PART_SEPARATOR)
    .update(canonicalizeIdParts(parts))
    .digest('hex');

  const hex = hash.slice(0, 32);
  // Version 5 (name-based, SHA family) and the RFC-4122 variant (10xx →
  // 8/9/a/b), chosen from the hash so the id stays evenly distributed.
  const version = '5';
  const variant = '89ab'[parseInt(hex[16], 16) % 4];

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version + hex.slice(13, 16),
    variant + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}
