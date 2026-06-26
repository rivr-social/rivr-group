/**
 * Project deliverables — grouping a job's tasks into shippable units (EPIC J3).
 *
 * Purpose:
 * A project's work decomposes as project → jobs → tasks. EPIC J3 adds an
 * intermediate organizing layer: a *deliverable* is a named, status-bearing
 * bundle of tasks (a shippable unit of work) inside a project. Deliverables are
 * first-class project-scoped resources (`resources.type = 'deliverable'`); a
 * task is linked to a deliverable purely through its `metadata.deliverableId`
 * (the resources table is metadata-driven, so no schema column is needed).
 *
 * This module holds the PURE deliverable logic — config parsing, status
 * derivation, and progress roll-up from task statuses — kept separate from the
 * `@/db`-touching server action (`createDeliverableAction` etc.) so the math is
 * unit-testable without a database. The action composes these helpers.
 */

/** Lifecycle status of a deliverable. */
export type DeliverableStatus =
  | 'planned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled';

/** The ordered set of valid deliverable statuses. */
export const DELIVERABLE_STATUSES: readonly DeliverableStatus[] = [
  'planned',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
] as const;

/** Default status a freshly created deliverable starts in. */
export const DEFAULT_DELIVERABLE_STATUS: DeliverableStatus = 'planned';

/**
 * The minimal shape of a task as far as deliverable roll-up cares: its id and
 * its current status string (as stored in `task.metadata.status`).
 */
export interface DeliverableTaskRef {
  id: string;
  status?: string | null;
}

/** Progress roll-up computed from a deliverable's member tasks. */
export interface DeliverableProgress {
  /** Total tasks linked to the deliverable. */
  total: number;
  /** Tasks whose status is `completed`. */
  completed: number;
  /** Tasks actively being worked (`in_progress` / `awaiting_approval`). */
  inProgress: number;
  /** Completion ratio in the range [0, 1], `0` when there are no tasks. */
  ratio: number;
  /** Whole-percent completion (`Math.round(ratio * 100)`). */
  percent: number;
}

/**
 * Narrows an arbitrary string to a {@link DeliverableStatus}, falling back to
 * {@link DEFAULT_DELIVERABLE_STATUS} for unknown/empty values. Used to sanitize
 * status coming from client input before it is written to resource metadata.
 */
export function normalizeDeliverableStatus(
  value: unknown,
): DeliverableStatus {
  return typeof value === 'string' &&
    (DELIVERABLE_STATUSES as readonly string[]).includes(value)
    ? (value as DeliverableStatus)
    : DEFAULT_DELIVERABLE_STATUS;
}

/**
 * Computes progress for a deliverable from its member tasks' statuses.
 *
 * `completed` counts tasks whose status is exactly `completed`; `inProgress`
 * counts `in_progress` and `awaiting_approval` (a task awaiting sign-off is
 * still work-in-flight, not done). The ratio/percent are based on completed
 * over total, with an empty task set yielding zeros (never NaN).
 */
export function computeDeliverableProgress(
  tasks: DeliverableTaskRef[],
): DeliverableProgress {
  const total = tasks.length;
  if (total === 0) {
    return { total: 0, completed: 0, inProgress: 0, ratio: 0, percent: 0 };
  }

  let completed = 0;
  let inProgress = 0;
  for (const task of tasks) {
    const status = typeof task.status === 'string' ? task.status : '';
    if (status === 'completed') {
      completed += 1;
    } else if (status === 'in_progress' || status === 'awaiting_approval') {
      inProgress += 1;
    }
  }

  const ratio = completed / total;
  return {
    total,
    completed,
    inProgress,
    ratio,
    percent: Math.round(ratio * 100),
  };
}

/**
 * Derives the status a deliverable *should* hold given its member tasks'
 * progress, used to auto-advance a deliverable as its tasks move. Explicit
 * terminal statuses (`completed`, `cancelled`) set manually by an admin are
 * sticky and are never auto-overridden.
 *
 * Rules (when current status is not a manual terminal):
 *   - all tasks completed (and there is at least one) → `completed`
 *   - any task in progress / some completed           → `in_progress`
 *   - otherwise                                       → keep current
 *
 * @param currentStatus The deliverable's current status.
 * @param progress Progress computed via {@link computeDeliverableProgress}.
 * @returns The status the deliverable should hold.
 */
export function deriveDeliverableStatus(
  currentStatus: DeliverableStatus,
  progress: DeliverableProgress,
): DeliverableStatus {
  // Manual terminal states are respected — an admin's explicit completion or
  // cancellation is authoritative and not recomputed from task churn.
  if (currentStatus === 'completed' || currentStatus === 'cancelled') {
    return currentStatus;
  }
  // A blocked deliverable stays blocked until explicitly unblocked.
  if (currentStatus === 'blocked') {
    return progress.total > 0 && progress.completed === progress.total
      ? 'completed'
      : 'blocked';
  }
  if (progress.total > 0 && progress.completed === progress.total) {
    return 'completed';
  }
  if (progress.inProgress > 0 || progress.completed > 0) {
    return 'in_progress';
  }
  return currentStatus;
}
