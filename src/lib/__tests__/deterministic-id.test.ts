/**
 * Content-addressed idempotency ids (PAY-41 / T-52 substrate).
 *
 * These ids are what make a retried money action a REPLAY instead of a second
 * payment, so the properties that matter are: same content → same id (always),
 * different content → different id (including the ways content can be made to
 * *look* the same), and a shape the strict payout-lane validator accepts.
 */
import { describe, it, expect } from 'vitest';

import {
  DETERMINISTIC_ID_NAMESPACES,
  canonicalizeIdParts,
  deterministicUuid,
} from '@/lib/deterministic-id';

/** The exact validator `lib/connect-bank-payout.ts` gates payout ids on. */
const CONNECT_BANK_PAYOUT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NS = DETERMINISTIC_ID_NAMESPACES.MCP_PAYOUT_REQUEST;

describe('canonicalizeIdParts', () => {
  it('treats null and undefined as an absent value (same canonical form)', () => {
    expect(canonicalizeIdParts(['a', null, 'b'])).toBe(canonicalizeIdParts(['a', undefined, 'b']));
  });

  it('keeps adjacent parts separable — no blending across the boundary', () => {
    expect(canonicalizeIdParts(['a', 'bc'])).not.toBe(canonicalizeIdParts(['ab', 'c']));
  });

  it('renders numbers and booleans stably', () => {
    expect(canonicalizeIdParts([1200, true])).toBe(canonicalizeIdParts(['1200', 'true']));
  });
});

describe('deterministicUuid', () => {
  it('is stable: identical namespace + content always yields the identical id', () => {
    const a = deterministicUuid(NS, ['agent-1', 'agent-1', 2500, 'standard', '']);
    const b = deterministicUuid(NS, ['agent-1', 'agent-1', 2500, 'standard', '']);
    expect(a).toBe(b);
  });

  it('produces a UUID the payout lane accepts (version 5, RFC variant)', () => {
    for (let i = 0; i < 200; i++) {
      const id = deterministicUuid(NS, ['agent', i, 'standard']);
      expect(id).toMatch(CONNECT_BANK_PAYOUT_UUID_RE);
    }
  });

  it('changes when ANY content part changes', () => {
    const base = ['agent-1', 'owner-1', 2500, 'standard', ''];
    const baseId = deterministicUuid(NS, base);
    expect(deterministicUuid(NS, ['agent-2', 'owner-1', 2500, 'standard', ''])).not.toBe(baseId);
    expect(deterministicUuid(NS, ['agent-1', 'owner-2', 2500, 'standard', ''])).not.toBe(baseId);
    expect(deterministicUuid(NS, ['agent-1', 'owner-1', 2501, 'standard', ''])).not.toBe(baseId);
    expect(deterministicUuid(NS, ['agent-1', 'owner-1', 2500, 'instant', ''])).not.toBe(baseId);
    expect(deterministicUuid(NS, ['agent-1', 'owner-1', 2500, 'standard', 'tok'])).not.toBe(baseId);
  });

  it('does not collide across namespaces for identical content', () => {
    const parts = ['same', 'content', 100];
    expect(deterministicUuid(DETERMINISTIC_ID_NAMESPACES.MCP_PAYOUT_REQUEST, parts)).not.toBe(
      deterministicUuid(DETERMINISTIC_ID_NAMESPACES.NET_DISTRIBUTION_RUN, parts),
    );
  });

  it('does not collide when parts are re-cut at a different boundary', () => {
    expect(deterministicUuid(NS, ['ab', 'c'])).not.toBe(deterministicUuid(NS, ['a', 'bc']));
  });

  it('yields distinct ids across a large content sweep (no truncation collisions)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(deterministicUuid(NS, ['agent-1', i]));
    expect(ids.size).toBe(2000);
  });

  it('spreads the variant nibble across the RFC-4122 range', () => {
    const variants = new Set<string>();
    for (let i = 0; i < 500; i++) variants.add(deterministicUuid(NS, ['v', i])[19]);
    expect(variants.size).toBeGreaterThan(1);
    for (const v of variants) expect('89ab').toContain(v);
  });
});
