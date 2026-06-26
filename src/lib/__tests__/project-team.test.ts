/**
 * Tests for the pure project-team / job-claim eligibility logic (EPIC J2):
 * badge-fit gating, assignee-slot capacity, claim de-duplication, the combined
 * eligibility resolver with deterministic denial ordering, and team derivation.
 * All DB-free and tested directly.
 */
import { describe, it, expect } from 'vitest';
import {
  meetsBadgeRequirement,
  hasOpenSlot,
  evaluateJobClaimEligibility,
  deriveProjectTeam,
  JOB_CLAIM_DENIAL_MESSAGES,
  type JobClaimScope,
  type JobClaimContext,
} from '@/lib/project-team';

describe('meetsBadgeRequirement', () => {
  it('passes when no badges are required', () => {
    expect(meetsBadgeRequirement([], [])).toBe(true);
    expect(meetsBadgeRequirement([], ['x'])).toBe(true);
  });

  it('passes when the claimant holds at least one required badge', () => {
    expect(meetsBadgeRequirement(['b1', 'b2'], ['b2'])).toBe(true);
  });

  it('fails when the claimant holds none of the required badges', () => {
    expect(meetsBadgeRequirement(['b1', 'b2'], ['b3'])).toBe(false);
    expect(meetsBadgeRequirement(['b1'], [])).toBe(false);
  });
});

describe('hasOpenSlot', () => {
  it('treats null/undefined/non-positive max as unlimited', () => {
    expect(hasOpenSlot(null, 999)).toBe(true);
    expect(hasOpenSlot(undefined, 999)).toBe(true);
    expect(hasOpenSlot(0, 999)).toBe(true);
    expect(hasOpenSlot(-3, 999)).toBe(true);
  });

  it('returns true while claims are below the cap', () => {
    expect(hasOpenSlot(3, 0)).toBe(true);
    expect(hasOpenSlot(3, 2)).toBe(true);
  });

  it('returns false once the cap is reached', () => {
    expect(hasOpenSlot(3, 3)).toBe(false);
    expect(hasOpenSlot(1, 1)).toBe(false);
  });
});

describe('evaluateJobClaimEligibility', () => {
  const baseScope: JobClaimScope = {
    claimable: true,
    requiredBadges: [],
    maxAssignees: null,
  };
  const baseContext: JobClaimContext = {
    heldBadgeIds: [],
    activeClaimCount: 0,
    alreadyClaimed: false,
  };

  it('allows an open, ungated, uncapped job', () => {
    expect(evaluateJobClaimEligibility(baseScope, baseContext)).toEqual({
      eligible: true,
    });
  });

  it('denies a non-claimable job first', () => {
    const result = evaluateJobClaimEligibility(
      { ...baseScope, claimable: false, requiredBadges: ['b1'] },
      { ...baseContext, alreadyClaimed: true },
    );
    expect(result).toEqual({ eligible: false, reason: 'job_not_claimable' });
  });

  it('denies an already-claimed job before checking badges/slots', () => {
    const result = evaluateJobClaimEligibility(
      { ...baseScope, requiredBadges: ['b1'], maxAssignees: 1 },
      { ...baseContext, alreadyClaimed: true, activeClaimCount: 5 },
    );
    expect(result).toEqual({ eligible: false, reason: 'already_claimed' });
  });

  it('denies when the claimant lacks the required badge', () => {
    const result = evaluateJobClaimEligibility(
      { ...baseScope, requiredBadges: ['b1'] },
      { ...baseContext, heldBadgeIds: ['other'] },
    );
    expect(result).toEqual({ eligible: false, reason: 'missing_required_badge' });
  });

  it('denies when no assignee slot is open', () => {
    const result = evaluateJobClaimEligibility(
      { ...baseScope, maxAssignees: 2 },
      { ...baseContext, activeClaimCount: 2 },
    );
    expect(result).toEqual({ eligible: false, reason: 'no_open_slots' });
  });

  it('allows a badge-gated, capped job when the claimant fits and a slot is open', () => {
    const result = evaluateJobClaimEligibility(
      { claimable: true, requiredBadges: ['b1', 'b2'], maxAssignees: 3 },
      { heldBadgeIds: ['b2'], activeClaimCount: 2, alreadyClaimed: false },
    );
    expect(result).toEqual({ eligible: true });
  });

  it('exposes a human-readable message for every denial reason', () => {
    expect(JOB_CLAIM_DENIAL_MESSAGES.job_not_claimable).toMatch(/not open/i);
    expect(JOB_CLAIM_DENIAL_MESSAGES.missing_required_badge).toMatch(/badge/i);
    expect(JOB_CLAIM_DENIAL_MESSAGES.no_open_slots).toMatch(/slot/i);
    expect(JOB_CLAIM_DENIAL_MESSAGES.already_claimed).toMatch(/already/i);
  });
});

describe('deriveProjectTeam', () => {
  it('returns the unique set of claimants across the project jobs', () => {
    const team = deriveProjectTeam([
      { claimantId: 'a', jobId: 'j1' },
      { claimantId: 'b', jobId: 'j1' },
      { claimantId: 'a', jobId: 'j2' }, // dup claimant on another job
      { claimantId: 'c', jobId: 'j3' },
    ]);
    expect(team).toEqual(['a', 'b', 'c']);
  });

  it('preserves first-seen order and skips empty ids', () => {
    const team = deriveProjectTeam([
      { claimantId: '', jobId: 'j1' },
      { claimantId: 'z', jobId: 'j1' },
      { claimantId: 'y', jobId: 'j2' },
    ]);
    expect(team).toEqual(['z', 'y']);
  });

  it('returns [] for no claims', () => {
    expect(deriveProjectTeam([])).toEqual([]);
  });
});
