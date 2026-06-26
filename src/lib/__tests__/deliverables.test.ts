/**
 * Tests for the pure project-deliverable logic (EPIC J3): status normalization,
 * progress roll-up from task statuses, and auto-derivation of deliverable status
 * from that progress. These functions are DB-free and tested directly.
 */
import { describe, it, expect } from 'vitest';
import {
  DELIVERABLE_STATUSES,
  DEFAULT_DELIVERABLE_STATUS,
  normalizeDeliverableStatus,
  computeDeliverableProgress,
  deriveDeliverableStatus,
  type DeliverableTaskRef,
} from '@/lib/deliverables';

describe('normalizeDeliverableStatus', () => {
  it('passes through every valid status', () => {
    for (const status of DELIVERABLE_STATUSES) {
      expect(normalizeDeliverableStatus(status)).toBe(status);
    }
  });

  it('falls back to the default for unknown/empty/non-string input', () => {
    expect(normalizeDeliverableStatus('nope')).toBe(DEFAULT_DELIVERABLE_STATUS);
    expect(normalizeDeliverableStatus('')).toBe(DEFAULT_DELIVERABLE_STATUS);
    expect(normalizeDeliverableStatus(null)).toBe(DEFAULT_DELIVERABLE_STATUS);
    expect(normalizeDeliverableStatus(42)).toBe(DEFAULT_DELIVERABLE_STATUS);
    expect(normalizeDeliverableStatus(undefined)).toBe(DEFAULT_DELIVERABLE_STATUS);
  });
});

describe('computeDeliverableProgress', () => {
  it('returns all-zero (never NaN) for an empty task set', () => {
    expect(computeDeliverableProgress([])).toEqual({
      total: 0,
      completed: 0,
      inProgress: 0,
      ratio: 0,
      percent: 0,
    });
  });

  it('counts completed vs in-flight tasks and computes ratio/percent', () => {
    const tasks: DeliverableTaskRef[] = [
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'completed' },
      { id: 't3', status: 'in_progress' },
      { id: 't4', status: 'not_started' },
    ];
    const progress = computeDeliverableProgress(tasks);
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(2);
    expect(progress.inProgress).toBe(1);
    expect(progress.ratio).toBe(0.5);
    expect(progress.percent).toBe(50);
  });

  it('treats awaiting_approval as in-progress, not completed', () => {
    const progress = computeDeliverableProgress([
      { id: 't1', status: 'awaiting_approval' },
      { id: 't2', status: 'completed' },
    ]);
    expect(progress.completed).toBe(1);
    expect(progress.inProgress).toBe(1);
    expect(progress.percent).toBe(50);
  });

  it('rounds percent to the nearest whole number', () => {
    const progress = computeDeliverableProgress([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'not_started' },
      { id: 'c', status: 'not_started' },
    ]);
    expect(progress.ratio).toBeCloseTo(1 / 3, 5);
    expect(progress.percent).toBe(33);
  });

  it('handles missing/null statuses as not-done', () => {
    const progress = computeDeliverableProgress([
      { id: 'a' },
      { id: 'b', status: null },
      { id: 'c', status: 'completed' },
    ]);
    expect(progress.completed).toBe(1);
    expect(progress.inProgress).toBe(0);
    expect(progress.total).toBe(3);
  });
});

describe('deriveDeliverableStatus', () => {
  const progressOf = (tasks: DeliverableTaskRef[]) =>
    computeDeliverableProgress(tasks);

  it('advances planned → in_progress when work has started', () => {
    const progress = progressOf([
      { id: 'a', status: 'in_progress' },
      { id: 'b', status: 'not_started' },
    ]);
    expect(deriveDeliverableStatus('planned', progress)).toBe('in_progress');
  });

  it('advances to completed when all tasks are completed', () => {
    const progress = progressOf([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ]);
    expect(deriveDeliverableStatus('in_progress', progress)).toBe('completed');
  });

  it('keeps planned when no task has any progress', () => {
    const progress = progressOf([
      { id: 'a', status: 'not_started' },
      { id: 'b', status: 'not_started' },
    ]);
    expect(deriveDeliverableStatus('planned', progress)).toBe('planned');
  });

  it('never auto-overrides a manual terminal status', () => {
    const progress = progressOf([{ id: 'a', status: 'in_progress' }]);
    expect(deriveDeliverableStatus('completed', progress)).toBe('completed');
    expect(deriveDeliverableStatus('cancelled', progress)).toBe('cancelled');
  });

  it('keeps a blocked deliverable blocked until all tasks complete', () => {
    const partial = progressOf([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'in_progress' },
    ]);
    expect(deriveDeliverableStatus('blocked', partial)).toBe('blocked');

    const allDone = progressOf([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ]);
    expect(deriveDeliverableStatus('blocked', allDone)).toBe('completed');
  });

  it('treats an empty deliverable as not-complete (no false completion)', () => {
    const progress = progressOf([]);
    expect(deriveDeliverableStatus('in_progress', progress)).toBe('in_progress');
    expect(deriveDeliverableStatus('planned', progress)).toBe('planned');
  });
});
