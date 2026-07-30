/**
 * Durable idempotency for distribution runs (T-52).
 *
 * The run replays instead of paying twice ONLY when it carries a key, and the
 * key used to be an optional caller courtesy — a double-submitted button, a
 * retried script, or the group repo's UI-less project rail therefore paid every
 * recipient a SECOND time. The server now derives a key from the run's own
 * content whenever the caller supplies none; these tests pin what "the same
 * run" means, since that definition is exactly what stops the double-pay.
 */
import { describe, it, expect } from 'vitest';

import {
  deriveDistributionIdempotencyKey,
  digestDistributionPlan,
  type DistributionIdempotencyInput,
  type DistributionRunPlan,
} from '@/lib/net-distribution-run';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';

function plan(overrides: Partial<DistributionRunPlan> = {}): DistributionRunPlan {
  return {
    netCents: 10_000,
    distributedBps: 10_000,
    credits: [
      { recipientId: ALICE, amountCents: 6_000, bps: 6_000 },
      { recipientId: BOB, amountCents: 4_000, bps: 4_000 },
    ],
    distributedCents: 10_000,
    orgKeepCents: 0,
    ...overrides,
  };
}

function input(overrides: Partial<DistributionIdempotencyInput> = {}): DistributionIdempotencyInput {
  return {
    scope: 'group',
    scopeId: GROUP_ID,
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    plan: plan(),
    ...overrides,
  };
}

describe('digestDistributionPlan', () => {
  it('is identical for two independently computed but identical plans', () => {
    expect(digestDistributionPlan(plan())).toBe(digestDistributionPlan(plan()));
  });

  it('changes when a recipient amount changes by a single cent', () => {
    const shifted = plan({
      credits: [
        { recipientId: ALICE, amountCents: 6_001, bps: 6_000 },
        { recipientId: BOB, amountCents: 3_999, bps: 4_000 },
      ],
    });
    expect(digestDistributionPlan(shifted)).not.toBe(digestDistributionPlan(plan()));
  });

  it('changes when the recipient set changes', () => {
    const other = plan({
      credits: [{ recipientId: ALICE, amountCents: 10_000, bps: 10_000 }],
    });
    expect(digestDistributionPlan(other)).not.toBe(digestDistributionPlan(plan()));
  });

  it('changes when the org-keep remainder changes', () => {
    expect(digestDistributionPlan(plan({ orgKeepCents: 1 }))).not.toBe(
      digestDistributionPlan(plan()),
    );
  });
});

describe('deriveDistributionIdempotencyKey', () => {
  it('DOUBLE-SUBMIT: the same run submitted twice derives the same key', () => {
    expect(deriveDistributionIdempotencyKey(input())).toBe(
      deriveDistributionIdempotencyKey(input()),
    );
  });

  it('DOUBLE-SUBMIT within one authoring session (same client token) is one run', () => {
    const token = 'form-mount-token';
    expect(deriveDistributionIdempotencyKey(input({ clientToken: token }))).toBe(
      deriveDistributionIdempotencyKey(input({ clientToken: token })),
    );
  });

  it('DELIBERATE RE-RUN: a fresh client token is a different, payable run', () => {
    expect(deriveDistributionIdempotencyKey(input({ clientToken: 'mount-1' }))).not.toBe(
      deriveDistributionIdempotencyKey(input({ clientToken: 'mount-2' })),
    );
  });

  it('treats "no client token" and an empty client token as the same run', () => {
    expect(deriveDistributionIdempotencyKey(input({ clientToken: '' }))).toBe(
      deriveDistributionIdempotencyKey(input()),
    );
  });

  it('separates runs by treasury (scopeId)', () => {
    expect(
      deriveDistributionIdempotencyKey(input({ scopeId: '55555555-5555-4555-8555-555555555555' })),
    ).not.toBe(deriveDistributionIdempotencyKey(input()));
  });

  it('separates the group-pie rail from the project rail on identical content', () => {
    expect(deriveDistributionIdempotencyKey(input({ scope: 'project' }))).not.toBe(
      deriveDistributionIdempotencyKey(input({ scope: 'group' })),
    );
  });

  it('separates runs by governing org', () => {
    expect(
      deriveDistributionIdempotencyKey(input({ groupId: '66666666-6666-4666-8666-666666666666' })),
    ).not.toBe(deriveDistributionIdempotencyKey(input()));
  });

  it('separates runs by controller — two admins distributing are two runs', () => {
    expect(
      deriveDistributionIdempotencyKey(input({ actorId: '77777777-7777-4777-8777-777777777777' })),
    ).not.toBe(deriveDistributionIdempotencyKey(input()));
  });

  it('separates runs by amount — a re-run for a different net is a new run', () => {
    const bigger = plan({
      netCents: 20_000,
      distributedCents: 20_000,
      credits: [
        { recipientId: ALICE, amountCents: 12_000, bps: 6_000 },
        { recipientId: BOB, amountCents: 8_000, bps: 4_000 },
      ],
    });
    expect(deriveDistributionIdempotencyKey(input({ plan: bigger }))).not.toBe(
      deriveDistributionIdempotencyKey(input()),
    );
  });

  it('returns a UUID-shaped key (same shape the UI used to mint)', () => {
    expect(deriveDistributionIdempotencyKey(input())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
