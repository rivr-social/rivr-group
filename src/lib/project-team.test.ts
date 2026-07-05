/**
 * Tests for the pure job-claim eligibility logic (EPIC J2 + configurable claim
 * gating). Covers the badge/slot gates AND the creator-selectable membership /
 * admin gates added for the job-claim approval flow.
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

const baseContext: JobClaimContext = {
  heldBadgeIds: [],
  activeClaimCount: 0,
  alreadyClaimed: false,
  isMember: false,
  isAdmin: false,
};

describe('evaluateJobClaimEligibility — base gates', () => {
  it('allows an ungated, open, unclaimed job', () => {
    expect(evaluateJobClaimEligibility(openScope, baseContext)).toEqual({ eligible: true });
  });

  it('rejects a non-claimable job first', () => {
    const r = evaluateJobClaimEligibility({ ...openScope, claimable: false }, baseContext);
    expect(r).toEqual({ eligible: false, reason: 'job_not_claimable' });
  });

  it('rejects when the claimant already holds a claim', () => {
    const r = evaluateJobClaimEligibility(openScope, { ...baseContext, alreadyClaimed: true });
    expect(r).toEqual({ eligible: false, reason: 'already_claimed' });
  });

  it('rejects a missing required badge', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, requiredBadges: ['badge-a'] },
      baseContext,
    );
    expect(r).toEqual({ eligible: false, reason: 'missing_required_badge' });
  });

  it('rejects when no open slots remain', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, maxAssignees: 2 },
      { ...baseContext, activeClaimCount: 2 },
    );
    expect(r).toEqual({ eligible: false, reason: 'no_open_slots' });
  });
});

describe('evaluateJobClaimEligibility — membership gate', () => {
  it('rejects a non-member when membership is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateMembership: true },
      { ...baseContext, isMember: false },
    );
    expect(r).toEqual({ eligible: false, reason: 'not_a_member' });
  });

  it('allows a member when membership is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateMembership: true },
      { ...baseContext, isMember: true },
    );
    expect(r).toEqual({ eligible: true });
  });

  it('allows an admin through the membership gate even if not a plain member', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateMembership: true },
      { ...baseContext, isMember: false, isAdmin: true },
    );
    expect(r).toEqual({ eligible: true });
  });
});

describe('evaluateJobClaimEligibility — admin gate', () => {
  it('rejects a member who is not an admin when admin is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateAdmin: true },
      { ...baseContext, isMember: true, isAdmin: false },
    );
    expect(r).toEqual({ eligible: false, reason: 'not_an_admin' });
  });

  it('allows an admin when admin is gated', () => {
    const r = evaluateJobClaimEligibility(
      { ...openScope, gateAdmin: true },
      { ...baseContext, isAdmin: true },
    );
    expect(r).toEqual({ eligible: true });
  });
});

describe('evaluateJobClaimEligibility — gate ordering', () => {
  it('reports the membership denial before badge/slot when multiple gates fail', () => {
    const r = evaluateJobClaimEligibility(
      { claimable: true, requiredBadges: ['badge-a'], maxAssignees: 1, gateMembership: true },
      { ...baseContext, isMember: false, activeClaimCount: 1 },
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
  it('hasOpenSlot: null/zero maxAssignees is unlimited', () => {
    expect(hasOpenSlot(null, 999)).toBe(true);
    expect(hasOpenSlot(0, 999)).toBe(true);
    expect(hasOpenSlot(3, 2)).toBe(true);
    expect(hasOpenSlot(3, 3)).toBe(false);
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
