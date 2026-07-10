/**
 * Tests for the pure job-claim eligibility logic (EPIC J2 + baseline
 * membership gate, 2026-07-10). Membership in the owning group (or
 * group/ancestor admin authority) is ALWAYS required; admins bypass the badge
 * gate; the creator-selectable admin gate still narrows claiming to admins.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateJobClaimEligibility,
  meetsBadgeRequirement,
  hasOpenSlot,
  deriveProjectTeam,
  JOB_CLAIM_DENIAL_MESSAGES,
  type JobClaimScope,
  type JobClaimContext,
} from './project-team';

const openScope: JobClaimScope = {
  claimable: true,
  requiredBadges: [],
  maxAssignees: null,
};

/** A plain member with no badges — the baseline eligible claimant. */
const memberContext: JobClaimContext = {
  heldBadgeIds: [],
  activeClaimCount: 0,
  alreadyClaimed: false,
  isMember: true,
  isAdmin: false,
};

/** Neither a member nor an admin — baseline-ineligible. */
const outsiderContext: JobClaimContext = {
  ...memberContext,
  isMember: false,
};

describe('evaluateJobClaimEligibility — base gates', () => {
  it('allows an ungated, open, unclaimed job for a member', () => {
    expect(evaluateJobClaimEligibility(openScope, memberContext)).toEqual({ eligible: true });
  });

  it('rejects a non-claimable job first', () => {
    const r = evaluateJobClaimEligibility({ ...openScope, claimable: false }, memberContext);
    expect(r).toEqual({ eligible: false, reason: 'job_not_claimable' });
  });

  it('rejects when the claimant already holds a claim', () => {
    const r = evaluateJobClaimEligibility(openScope, { ...memberContext, alreadyClaimed: true });
    expect(r).toEqual({ eligible: false, reason: 'already_claimed' });
  });

  it('rejects a member missing a required badge', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, requiredBadges: ['badge-a'] },
      memberContext,
    );
    expect(r).toEqual({ eligible: false, reason: 'missing_required_badge' });
  });

  it('rejects when no open slots remain', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, maxAssignees: 2 },
      { ...memberContext, activeClaimCount: 2 },
    );
    expect(r).toEqual({ eligible: false, reason: 'no_open_slots' });
  });
});

describe('evaluateJobClaimEligibility — baseline membership gate', () => {
  it('rejects a non-member on an otherwise ungated job', () => {
    const r = evaluateJobClaimEligibility(openScope, outsiderContext);
    expect(r).toEqual({ eligible: false, reason: 'not_a_member' });
  });

  it('rejects a non-member even when the legacy gateMembership flag is false', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateMembership: false },
      outsiderContext,
    );
    expect(r).toEqual({ eligible: false, reason: 'not_a_member' });
  });

  it('allows a group/ancestor admin who is not a plain member', () => {
    const r = evaluateJobClaimEligibility(openScope, { ...outsiderContext, isAdmin: true });
    expect(r).toEqual({ eligible: true });
  });
});

describe('evaluateJobClaimEligibility — badge gate vs admin authority', () => {
  it('admin bypasses the required-badge gate', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, requiredBadges: ['badge-a'] },
      { ...memberContext, isAdmin: true },
    );
    expect(r).toEqual({ eligible: true });
  });

  it('member holding one of the required badges passes', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, requiredBadges: ['badge-a', 'badge-b'] },
      { ...memberContext, heldBadgeIds: ['badge-b'] },
    );
    expect(r).toEqual({ eligible: true });
  });

  it('admin does NOT bypass the slot limit', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, maxAssignees: 1 },
      { ...memberContext, isAdmin: true, activeClaimCount: 1 },
    );
    expect(r).toEqual({ eligible: false, reason: 'no_open_slots' });
  });
});

describe('evaluateJobClaimEligibility — admin gate', () => {
  it('rejects a member who is not an admin when admin is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateAdmin: true },
      memberContext,
    );
    expect(r).toEqual({ eligible: false, reason: 'not_an_admin' });
  });

  it('allows an admin when admin is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateAdmin: true },
      { ...memberContext, isAdmin: true },
    );
    expect(r).toEqual({ eligible: true });
  });
});

describe('evaluateJobClaimEligibility — gate ordering', () => {
  it('reports the membership denial before badge/slot when multiple gates fail', () => {
    const r = evaluateJobClaimEligibility(
      { claimable: true, requiredBadges: ['badge-a'], maxAssignees: 1 },
      { ...outsiderContext, activeClaimCount: 1 },
    );
    expect(r).toEqual({ eligible: false, reason: 'not_a_member' });
  });
});

describe('helpers', () => {
  it('meetsBadgeRequirement: empty requirement is always satisfied', () => {
    expect(meetsBadgeRequirement([], [])).toBe(true);
  });
  it('meetsBadgeRequirement: satisfied by holding at least one', () => {
    expect(meetsBadgeRequirement(['a', 'b'], ['b'])).toBe(true);
    expect(meetsBadgeRequirement(['a', 'b'], ['c'])).toBe(false);
  });
  it('hasOpenSlot: null/undefined/non-positive maxAssignees is unlimited', () => {
    expect(hasOpenSlot(null, 999)).toBe(true);
    expect(hasOpenSlot(undefined, 999)).toBe(true);
    expect(hasOpenSlot(0, 999)).toBe(true);
    expect(hasOpenSlot(-3, 999)).toBe(true);
    expect(hasOpenSlot(3, 2)).toBe(true);
    expect(hasOpenSlot(3, 3)).toBe(false);
  });
  it('denies a non-claimable job before every other gate', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, claimable: false, requiredBadges: ['b1'] },
      { ...outsiderContext, alreadyClaimed: true },
    );
    expect(r).toEqual({ eligible: false, reason: 'job_not_claimable' });
  });
  it('deriveProjectTeam: unique claimants in first-seen order', () => {
    expect(
      deriveProjectTeam([
        { claimantId: 'x', jobId: 'j1' },
        { claimantId: 'y', jobId: 'j2' },
        { claimantId: 'x', jobId: 'j3' },
        { claimantId: '', jobId: 'j4' },
      ]),
    ).toEqual(['x', 'y']);
  });
});

describe('denial messages', () => {
  it('has a message for every denial reason', () => {
    for (const reason of [
      'job_not_claimable',
      'missing_required_badge',
      'no_open_slots',
      'already_claimed',
      'not_a_member',
      'not_an_admin',
    ] as const) {
      expect(typeof JOB_CLAIM_DENIAL_MESSAGES[reason]).toBe('string');
      expect(JOB_CLAIM_DENIAL_MESSAGES[reason].length).toBeGreaterThan(0);
    }
  });
});
