"use server";

/**
 * Job completion + cash payout (2026-07-07 projects/treasury sprint).
 *
 * Marking a job done is the money moment of the projects flow: the job's
 * status flips to `completed`, every assignee gets a `job-contribution`
 * stakeholder edge, and — when the job carries cash compensation — each
 * assignee is paid from the owning group's treasury wallet through the
 * internal ledger rail (`transferP2P`), with per-assignee idempotency so the
 * action can be safely re-run to retry payouts that failed on an underfunded
 * treasury.
 *
 * Pay model (see `JobShift.payKind`):
 * - `fixed`: `payAmountCents` split equally across assignees (deterministic
 *   remainder to the first assignee by sorted id).
 * - `hourly`: `hourlyRateCents` × each assignee's tracked job-timer time
 *   (stopped `time_entry` ledger rows on the job).
 * - `null`: points-only job — completion records contributions, moves no cash.
 *
 * Money safety: cash moves ONLY inside this instance's internal USD ledger
 * (the same rail as deposits/purchases). Stripe Treasury `OutboundTransfer`
 * legs replace/augment this once the platform's Treasury application is
 * approved — the payout entries recorded here are the reconciliation anchor.
 */

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { federatedWrite } from "@/lib/federation/remote-write";
import { getSettlementWalletForAgent, transferP2P } from "@/lib/wallet";
import { MAX_TRANSFER_CENTS, MIN_TRANSFER_CENTS } from "@/lib/wallet-constants";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import { recordJobContributionAction } from "@/app/actions/interactions/project-team";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Ledger interaction type for an active project-team job claim (mirrors project-team.ts). */
const JOB_CLAIM_INTERACTION = "job-claim";

/** Ledger interaction type for job-timer work segments (mirrors job-timer.ts). */
const TIMER_INTERACTION_TYPE = "time_entry";

/** Ledger interaction type marking a cash payout earned for a completed job. */
const JOB_CASH_PAYOUT_INTERACTION = "job-cash-payout";

/** Milliseconds per hour, for hourly-rate payout computation. */
const MS_PER_HOUR = 3_600_000;

/** Job resource types accepted by completion (current + legacy). */
const JOB_RESOURCE_TYPES = ["job", "shift"] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Per-assignee payout outcome recorded on the job and returned to the caller. */
export interface JobPayoutEntry {
  assigneeId: string;
  amountCents: number;
  /**
   * `paid`: transferred to the assignee's wallet.
   * `pending_funds`: treasury balance was insufficient — re-run to retry.
   * `already_paid`: an earlier run paid this assignee (idempotency skip).
   * `no_tracked_time`: hourly job, assignee has no stopped timer segments.
   * `below_minimum`: computed amount is under the ledger's minimum transfer.
   */
  status: "paid" | "pending_funds" | "already_paid" | "no_tracked_time" | "below_minimum";
  /** Payment-stub receipt resource id, set when status is `paid`. */
  receiptId?: string;
}

export interface MarkJobDoneResult {
  success: boolean;
  message: string;
  status?: "completed";
  payout?: {
    kind: "fixed" | "hourly" | null;
    totalPaidCents: number;
    entries: JobPayoutEntry[];
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** DISTINCT agent ids holding an active `job-claim` edge on the job. */
async function getActiveJobAssignees(jobId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT subject_id
    FROM ledger
    WHERE verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CLAIM_INTERACTION}
      AND metadata->>'targetId' = ${jobId}
  `)) as Array<Record<string, unknown>>;
  return rows
    .map((row) => String(row.subject_id ?? ""))
    .filter((id) => id.length > 0)
    .sort();
}

/**
 * Sum of an assignee's tracked time on the job, in ms — completed `workperiod`
 * records (the current timer) plus legacy `time_entry` ledger segments (the
 * old timer), so no historical tracked time is dropped from hourly pay.
 */
async function getTrackedMsForAssignee(jobId: string, assigneeId: string): Promise<number> {
  const workPeriodRows = (await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'durationMs')::bigint), 0) AS total_ms
    FROM resources
    WHERE type = 'resource'
      AND deleted_at IS NULL
      AND owner_id = ${assigneeId}::uuid
      AND metadata->>'resourceKind' = 'workperiod'
      AND metadata->>'jobId' = ${jobId}
      AND metadata->>'durationMs' IS NOT NULL
  `)) as Array<Record<string, unknown>>;

  const legacyRows = (await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'durationMs')::bigint), 0) AS total_ms
    FROM ledger
    WHERE verb = 'work'
      AND subject_id = ${assigneeId}::uuid
      AND object_id = ${jobId}::uuid
      AND metadata->>'interactionType' = ${TIMER_INTERACTION_TYPE}
      AND metadata->>'stoppedAt' IS NOT NULL
      AND metadata->>'durationMs' IS NOT NULL
  `)) as Array<Record<string, unknown>>;

  return Number(workPeriodRows[0]?.total_ms ?? 0) + Number(legacyRows[0]?.total_ms ?? 0);
}

/** Whether an assignee already holds a cash-payout edge for this job. */
async function hasExistingPayout(jobId: string, assigneeId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ledger
    WHERE verb = 'earn'
      AND subject_id = ${assigneeId}::uuid
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_CASH_PAYOUT_INTERACTION}
      AND metadata->>'jobId' = ${jobId}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/** An assignee's computed pay: amount owed plus tracked time (hourly jobs). */
interface OwedPay {
  amountCents: number;
  trackedMs: number | null;
}

/**
 * Computes each assignee's owed pay for the job's pay model. Fixed pay
 * splits equally with the integer remainder going to the first assignee (ids
 * pre-sorted for determinism); hourly pay is rate × tracked time, with total
 * payable time CLAMPED to the job's `maxHours` budget (2026-07-10): when the
 * summed tracked time exceeds the budget, each assignee's payable ms scales
 * down proportionally (floored — the treasury never pays past the cap).
 * Overage remains visible on the timesheet; it just doesn't pay.
 */
async function computeOwedPay(
  jobId: string,
  payKind: "fixed" | "hourly",
  payAmountCents: number | null,
  hourlyRateCents: number | null,
  assignees: string[],
  maxHours: number | null,
): Promise<Map<string, OwedPay>> {
  const owed = new Map<string, OwedPay>();
  if (payKind === "fixed") {
    const total = payAmountCents ?? 0;
    const base = Math.floor(total / assignees.length);
    const remainder = total - base * assignees.length;
    assignees.forEach((assigneeId, index) => {
      owed.set(assigneeId, { amountCents: base + (index === 0 ? remainder : 0), trackedMs: null });
    });
    return owed;
  }

  const rate = hourlyRateCents ?? 0;
  const trackedByAssignee = new Map<string, number>();
  let totalTrackedMs = 0;
  for (const assigneeId of assignees) {
    const trackedMs = await getTrackedMsForAssignee(jobId, assigneeId);
    trackedByAssignee.set(assigneeId, trackedMs);
    totalTrackedMs += trackedMs;
  }

  const maxMs = typeof maxHours === "number" && maxHours > 0 ? maxHours * MS_PER_HOUR : null;
  const overBudget = maxMs !== null && totalTrackedMs > maxMs;

  for (const assigneeId of assignees) {
    const trackedMs = trackedByAssignee.get(assigneeId) ?? 0;
    const payableMs = overBudget
      ? Math.floor((trackedMs * (maxMs as number)) / totalTrackedMs)
      : trackedMs;
    owed.set(assigneeId, {
      amountCents: Math.round((payableMs / MS_PER_HOUR) * rate),
      trackedMs,
    });
  }
  return owed;
}

/**
 * Transfers `amountCents` from the treasury wallet to the assignee's wallet in
 * MAX_TRANSFER_CENTS chunks (the ledger rail caps single transfers), records
 * the `job-cash-payout` earn edge that anchors idempotency, and mints a
 * payment-stub `receipt` resource for the payee (same receipt rail as
 * marketplace purchases) so every payout has an invoice-like artifact.
 *
 * @returns The receipt resource id.
 */
async function payAssignee(input: {
  jobId: string;
  jobName: string;
  groupId: string;
  groupWalletId: string;
  assigneeId: string;
  amountCents: number;
  payKind: "fixed" | "hourly";
  hourlyRateCents: number | null;
  trackedMs: number | null;
  recordedBy: string;
  projectId: string | null;
}): Promise<string> {
  const assigneeWallet = await getSettlementWalletForAgent(input.assigneeId);

  let remaining = input.amountCents;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TRANSFER_CENTS);
    await transferP2P(
      input.groupWalletId,
      assigneeWallet.id,
      chunk,
      `Job payout: ${input.jobName}`,
    );
    remaining -= chunk;
  }

  const paidAt = new Date().toISOString();

  // Payment stub: owned by the PAYEE (it's their earnings record), with the
  // paying group + job linkage in metadata for the group's books.
  const [receipt] = await db
    .insert(resources)
    .values({
      name: `Payment stub: ${input.jobName}`,
      type: "receipt",
      ownerId: input.assigneeId,
      description: `Job payout for "${input.jobName}"`,
      visibility: "private",
      metadata: {
        receiptKind: "job-payout",
        jobId: input.jobId,
        projectId: input.projectId,
        payerGroupId: input.groupId,
        payeeAgentId: input.assigneeId,
        amountCents: input.amountCents,
        payKind: input.payKind,
        ...(input.payKind === "hourly"
          ? {
              hourlyRateCents: input.hourlyRateCents,
              trackedMs: input.trackedMs,
              trackedHours:
                input.trackedMs !== null
                  ? Math.round((input.trackedMs / MS_PER_HOUR) * 100) / 100
                  : null,
            }
          : {}),
        approvedBy: input.recordedBy,
        paidAt,
        status: "completed",
        paymentMethod: "wallet",
        currency: "usd",
      },
    } as typeof resources.$inferInsert)
    .returning({ id: resources.id });

  await db.insert(ledger).values({
    verb: "earn",
    subjectId: input.assigneeId,
    objectId: input.jobId,
    objectType: "resource",
    resourceId: input.jobId,
    isActive: true,
    metadata: {
      interactionType: JOB_CASH_PAYOUT_INTERACTION,
      jobId: input.jobId,
      projectId: input.projectId,
      amountCents: input.amountCents,
      payKind: input.payKind,
      recordedBy: input.recordedBy,
      receiptId: receipt.id,
      paidAt,
    },
  } as NewLedgerEntry);

  return receipt.id;
}

// ─── Server Action ──────────────────────────────────────────────────────────

/**
 * Marks a job done and settles its compensation.
 *
 * Authorization: the job's owner (person-owned jobs) or a group-write-access
 * holder on the owning group — completion confers stakeholder standing and
 * moves treasury money, so it is an admin act (assignees complete TASKS,
 * which carry their own approval flow).
 *
 * Idempotent/re-runnable: assignees already paid are skipped; `pending_funds`
 * entries are retried on the next run (e.g. after the treasury is topped up).
 *
 * @param jobId UUID of the job (or legacy shift) resource.
 */
export async function markJobDoneAction(jobId: string): Promise<MarkJobDoneResult> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to mark a job done." };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return { success: false, message: "Invalid job id." };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [job] = await db
    .select({
      id: resources.id,
      name: resources.name,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, jobId),
        inArray(resources.type, [...JOB_RESOURCE_TYPES]),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!job) return { success: false, message: "Job not found." };

  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isOwner = job.ownerId === userId;
  const canComplete = isOwner ? true : await hasGroupWriteAccess(userId, job.ownerId);
  if (!canComplete) {
    return { success: false, message: "Only the job owner or a group admin can mark a job done." };
  }

  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const projectId = typeof meta.projectId === "string" ? meta.projectId : null;
  const payKind = meta.payKind === "fixed" || meta.payKind === "hourly" ? meta.payKind : null;
  const payAmountCents =
    typeof meta.payAmountCents === "number" && meta.payAmountCents > 0 ? meta.payAmountCents : null;
  const hourlyRateCents =
    typeof meta.hourlyRateCents === "number" && meta.hourlyRateCents > 0 ? meta.hourlyRateCents : null;
  // Hour budget: hourly payout never pays past this many hours (job-level).
  const maxHours =
    typeof meta.maxHours === "number" && Number.isFinite(meta.maxHours) && meta.maxHours > 0
      ? meta.maxHours
      : null;

  // Assignee set: active job-claim edges, falling back to legacy embedded assignees.
  let assignees = await getActiveJobAssignees(jobId);
  if (assignees.length === 0 && Array.isArray(meta.assignees)) {
    assignees = meta.assignees.filter((a): a is string => typeof a === "string").sort();
  }

  const facadeResult = await federatedWrite(
    {
      type: "markJobDoneAction",
      actorId: userId,
      targetAgentId: job.ownerId,
      payload: { jobId },
    },
    async () => {
      const now = new Date().toISOString();
      const entries: JobPayoutEntry[] = [];
      let totalPaidCents = 0;

      const paysCash =
        payKind !== null &&
        assignees.length > 0 &&
        ((payKind === "fixed" && payAmountCents !== null) ||
          (payKind === "hourly" && hourlyRateCents !== null));

      if (paysCash) {
        const groupWallet = await getSettlementWalletForAgent(job.ownerId);
        const owed = await computeOwedPay(
          jobId,
          payKind,
          payAmountCents,
          hourlyRateCents,
          assignees,
          maxHours,
        );

        for (const assigneeId of assignees) {
          const pay = owed.get(assigneeId) ?? { amountCents: 0, trackedMs: null };
          const amountCents = pay.amountCents;

          if (payKind === "hourly" && amountCents === 0) {
            entries.push({ assigneeId, amountCents: 0, status: "no_tracked_time" });
            continue;
          }
          if (amountCents < MIN_TRANSFER_CENTS) {
            entries.push({ assigneeId, amountCents, status: "below_minimum" });
            continue;
          }
          if (await hasExistingPayout(jobId, assigneeId)) {
            entries.push({ assigneeId, amountCents, status: "already_paid" });
            continue;
          }

          try {
            const receiptId = await payAssignee({
              jobId,
              jobName: job.name,
              groupId: job.ownerId,
              groupWalletId: groupWallet.id,
              assigneeId,
              amountCents,
              payKind,
              hourlyRateCents,
              trackedMs: pay.trackedMs,
              recordedBy: userId,
              projectId,
            });
            totalPaidCents += amountCents;
            entries.push({ assigneeId, amountCents, status: "paid", receiptId });
          } catch (error) {
            // Insufficient treasury balance (or a frozen wallet) parks the
            // entry as pending_funds; a re-run after a deposit retries it.
            const message = error instanceof Error ? error.message : String(error);
            if (/insufficient balance|frozen/i.test(message)) {
              entries.push({ assigneeId, amountCents, status: "pending_funds" });
            } else {
              throw error;
            }
          }
        }
      }

      const payoutStatuses = new Set(entries.map((entry) => entry.status));
      const payoutStatus = !paysCash
        ? "none"
        : payoutStatuses.has("pending_funds")
          ? "partial"
          : "paid";

      await db
        .update(resources)
        .set({
          metadata: {
            ...meta,
            status: "completed",
            completed: true,
            completedAt: typeof meta.completedAt === "string" ? meta.completedAt : now,
            completedBy: typeof meta.completedBy === "string" ? meta.completedBy : userId,
            payout: {
              kind: payKind,
              status: payoutStatus,
              computedAt: now,
              totalPaidCents,
              entries,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(resources.id, jobId));

      revalidatePath(`/jobs/${jobId}`);
      if (projectId) revalidatePath(`/projects/${projectId}`);
      revalidatePath(`/groups/${job.ownerId}`);

      const paidCount = entries.filter((entry) => entry.status === "paid").length;
      const pendingCount = entries.filter((entry) => entry.status === "pending_funds").length;
      const message =
        payKind === null
          ? "Job marked done."
          : pendingCount > 0
            ? `Job marked done — paid ${paidCount} of ${entries.length} assignees; ${pendingCount} pending treasury funds (re-run after depositing).`
            : paidCount > 0
              ? `Job marked done — paid ${paidCount} assignee${paidCount === 1 ? "" : "s"} $${(totalPaidCents / 100).toFixed(2)}.`
              : "Job marked done.";

      return {
        success: true,
        message,
        status: "completed" as const,
        payout: { kind: payKind, totalPaidCents, entries },
      } satisfies MarkJobDoneResult;
    },
  );

  if (!facadeResult.success) {
    return { success: false, message: facadeResult.error ?? "Failed to mark the job done." };
  }

  // Stakeholder standing for every assignee (idempotent per contributor+job).
  for (const assigneeId of assignees) {
    await recordJobContributionAction({ jobId, contributorId: assigneeId }).catch(() => {});
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.RESOURCE_UPDATED,
    entityType: "resource",
    entityId: jobId,
    actorId: userId,
    payload: { action: "job_marked_done", jobId },
  }).catch(() => {});

  return (
    facadeResult.data ?? {
      success: true,
      message: "Job marked done.",
      status: "completed",
    }
  );
}
