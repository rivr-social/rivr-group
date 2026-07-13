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
 * - `volunteer`: no cash — per assignee, post-hoc, mint a Thanks voucher owned
 *   by the volunteer and have the GROUP claim/redeem it through the shared
 *   voucher-redemption rail (`mintThanksTokensForVoucherRedemption`), valued
 *   from their claim-complete skillfulness/difficulty ratings × hours worked.
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
import { getOrCreateProjectWallet, getSettlementWalletForAgent, transferP2P } from "@/lib/wallet";
import { MAX_TRANSFER_CENTS, MIN_TRANSFER_CENTS } from "@/lib/wallet-constants";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";
import { recordJobContributionAction } from "@/app/actions/interactions/project-team";
import { mintThanksTokensForVoucherRedemption } from "@/app/actions/interactions/thanks-tokens";
import { computeVoucherThanksValue } from "@/lib/voucher-valuation";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Ledger interaction type for an active project-team job claim (mirrors project-team.ts). */
const JOB_CLAIM_INTERACTION = "job-claim";

/** Ledger interaction type for job-timer work segments (mirrors job-timer.ts). */
const TIMER_INTERACTION_TYPE = "time_entry";

/** Ledger interaction type marking a cash payout earned for a completed job. */
const JOB_CASH_PAYOUT_INTERACTION = "job-cash-payout";

/**
 * Ledger interaction type anchoring a volunteer job's post-hoc voucher mint +
 * group redemption (idempotency: one active edge per assignee+job).
 */
const JOB_VOLUNTEER_VOUCHER_INTERACTION = "job-volunteer-voucher";

/** Interaction type of the group's redemption edge on a volunteer voucher. */
const VOUCHER_REDEMPTION_INTERACTION = "voucher-redemption";

/**
 * Fallback skillfulness/difficulty when a volunteer never recorded
 * claim-complete self-ratings (e.g. an admin marked the job done directly).
 * Conservative minimum so an absent rating never over-values the voucher.
 */
const DEFAULT_VOLUNTEER_RATING = 1;

/** Fallback hours when a volunteer tracked no timer time and the job has no budget. */
const DEFAULT_VOLUNTEER_HOURS = 1;

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
   * `already_paid`: an earlier run settled this assignee (idempotency skip).
   * `no_tracked_time`: hourly job, assignee has no stopped timer segments.
   * `below_minimum`: computed amount is under the ledger's minimum transfer.
   * `volunteer_voucher`: volunteer job — a Thanks voucher was minted for the
   *   volunteer and claimed by the group (no cash moved).
   */
  status:
    | "paid"
    | "pending_funds"
    | "already_paid"
    | "no_tracked_time"
    | "below_minimum"
    | "volunteer_voucher";
  /** Payment-stub receipt id (cash payouts) or minted voucher id (volunteer). */
  receiptId?: string;
  /** Thanks tokens minted to the volunteer (set when status is `volunteer_voucher`). */
  thanksMinted?: number;
}

export interface MarkJobDoneResult {
  success: boolean;
  message: string;
  status?: "completed";
  payout?: {
    kind: "fixed" | "hourly" | "volunteer" | null;
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
  /** Wallet the payout debits: the job's project treasury wallet when the job
   * belongs to a project, else the owning group/subgroup settlement wallet. */
  payerWalletId: string;
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
      input.payerWalletId,
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

// ─── Volunteer voucher payout ─────────────────────────────────────────────────

/** Whether an assignee already holds a volunteer-voucher edge for this job. */
async function hasExistingVolunteerVoucher(jobId: string, assigneeId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ledger
    WHERE verb = 'earn'
      AND subject_id = ${assigneeId}::uuid
      AND is_active = true
      AND metadata->>'interactionType' = ${JOB_VOLUNTEER_VOUCHER_INTERACTION}
      AND metadata->>'jobId' = ${jobId}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/**
 * The assignee's claim-complete self-ratings (skillfulness + difficulty, the
 * voucher-style 1–100 sliders on their `work-completion-claim` edge for the
 * job). Missing/invalid ratings fall back to `DEFAULT_VOLUNTEER_RATING`.
 */
async function getAssigneeClaimRatings(
  jobId: string,
  assigneeId: string,
): Promise<{ skillfulness: number; difficulty: number }> {
  const rows = (await db.execute(sql`
    SELECT metadata
    FROM ledger
    WHERE subject_id = ${assigneeId}::uuid
      AND verb = 'complete'
      AND object_id = ${jobId}::uuid
      AND metadata->>'interactionType' = 'work-completion-claim'
    ORDER BY timestamp DESC
    LIMIT 1
  `)) as Array<{ metadata: Record<string, unknown> }>;
  const meta = rows[0]?.metadata ?? {};
  const skillfulness =
    typeof meta.skillfulness === "number" && Number.isFinite(meta.skillfulness)
      ? meta.skillfulness
      : DEFAULT_VOLUNTEER_RATING;
  const difficulty =
    typeof meta.difficulty === "number" && Number.isFinite(meta.difficulty)
      ? meta.difficulty
      : DEFAULT_VOLUNTEER_RATING;
  return { skillfulness, difficulty };
}

/**
 * Hours credited to a volunteer for voucher valuation: their actual tracked
 * timer time on the job, else the job's `maxHours` estimate, else a 1-hour
 * floor — so a volunteer who never ran the timer still receives a voucher.
 */
async function resolveVolunteerHours(
  jobId: string,
  assigneeId: string,
  maxHours: number | null,
): Promise<number> {
  const trackedMs = await getTrackedMsForAssignee(jobId, assigneeId);
  if (trackedMs > 0) return trackedMs / MS_PER_HOUR;
  if (typeof maxHours === "number" && maxHours > 0) return maxHours;
  return DEFAULT_VOLUNTEER_HOURS;
}

/**
 * Post-hoc volunteer settlement for one assignee, atomically in a transaction:
 *   1. mints a `voucher` resource OWNED BY THE VOLUNTEER, valued in Thanks from
 *      their claim-complete ratings × hours (voucher already marked completed,
 *      claimed by the group);
 *   2. records the group's `voucher-redemption` edge — the group is the
 *      redeemer/claimant, the volunteer is the owner;
 *   3. mints `thanksCount` Thanks to the volunteer via the SAME
 *      `mintThanksTokensForVoucherRedemption` rail any voucher redemption uses
 *      (voucher owner = volunteer receives the Thanks);
 *   4. writes the `job-volunteer-voucher` earn edge that anchors idempotency.
 *
 * No cash moves. Returns the voucher id and Thanks minted.
 */
async function mintVolunteerVoucher(input: {
  jobId: string;
  jobName: string;
  groupId: string;
  assigneeId: string;
  thanksCount: number;
  skillfulness: number;
  difficulty: number;
  projectId: string | null;
  recordedBy: string;
}): Promise<{ voucherId: string; thanksMinted: number }> {
  return db.transaction(async (tx) => {
    const redeemedAt = new Date().toISOString();

    // 1. Voucher owned by the volunteer, already claimed/redeemed by the group.
    const [voucher] = await tx
      .insert(resources)
      .values({
        name: `Volunteer voucher: ${input.jobName}`,
        type: "voucher",
        ownerId: input.assigneeId,
        description: `Voucher for volunteer work on "${input.jobName}", claimed by the group.`,
        visibility: "members",
        tags: [input.groupId],
        metadata: {
          entityType: "voucher",
          resourceKind: "voucher",
          voucherKind: "volunteer",
          ringId: input.groupId,
          groupId: input.groupId,
          groupTags: [input.groupId],
          jobId: input.jobId,
          projectId: input.projectId,
          skillfulness: input.skillfulness,
          difficulty: input.difficulty,
          // Thanks valuation (same field the redemption rail reads).
          voucherValues: { thanksValue: input.thanksCount },
          thanksValue: input.thanksCount,
          status: "completed",
          claimedBy: input.groupId,
          claimedAt: redeemedAt,
          redeemedBy: input.groupId,
          redeemedAt,
          completedAt: redeemedAt,
        },
      } as typeof resources.$inferInsert)
      .returning({ id: resources.id });

    // 2. The group's redemption edge — group redeems (claims) the volunteer's
    //    voucher; the Thanks flow to the voucher owner (the volunteer).
    await tx.insert(ledger).values({
      subjectId: input.groupId,
      verb: "redeem",
      objectId: voucher.id,
      objectType: "resource",
      resourceId: voucher.id,
      isActive: true,
      metadata: {
        interactionType: VOUCHER_REDEMPTION_INTERACTION,
        targetId: voucher.id,
        targetType: "resource",
        redeemedBy: input.groupId,
        voucherOwnerId: input.assigneeId,
        redeemedAt,
        thanksTokenCount: input.thanksCount,
        source: "volunteer-job",
        jobId: input.jobId,
        projectId: input.projectId,
      },
    } as NewLedgerEntry);

    // 3. Mint the Thanks to the volunteer (voucher owner) via the shared rail.
    await mintThanksTokensForVoucherRedemption(
      tx,
      voucher.id,
      input.assigneeId,
      input.groupId,
      input.thanksCount,
    );

    // 4. Idempotency anchor: one active edge per assignee+job.
    await tx.insert(ledger).values({
      verb: "earn",
      subjectId: input.assigneeId,
      objectId: input.jobId,
      objectType: "resource",
      resourceId: input.jobId,
      isActive: true,
      metadata: {
        interactionType: JOB_VOLUNTEER_VOUCHER_INTERACTION,
        jobId: input.jobId,
        projectId: input.projectId,
        voucherId: voucher.id,
        thanksTokenCount: input.thanksCount,
        skillfulness: input.skillfulness,
        difficulty: input.difficulty,
        recordedBy: input.recordedBy,
        redeemedAt,
      },
    } as NewLedgerEntry);

    return { voucherId: voucher.id, thanksMinted: input.thanksCount };
  });
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
  const payKind =
    meta.payKind === "fixed" || meta.payKind === "hourly" || meta.payKind === "volunteer"
      ? meta.payKind
      : null;
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

      const mintsVolunteerVouchers = payKind === "volunteer" && assignees.length > 0;

      if (mintsVolunteerVouchers) {
        // Volunteer pay: no cash moves. Per assignee, post-hoc, mint a Thanks
        // voucher owned by the volunteer and have the GROUP claim/redeem it —
        // the same voucher-redemption rail that mints Thanks to a voucher's
        // owner on any redemption. Idempotent per assignee+job.
        for (const assigneeId of assignees) {
          if (await hasExistingVolunteerVoucher(jobId, assigneeId)) {
            entries.push({ assigneeId, amountCents: 0, status: "already_paid" });
            continue;
          }
          const { skillfulness, difficulty } = await getAssigneeClaimRatings(jobId, assigneeId);
          const hours = await resolveVolunteerHours(jobId, assigneeId, maxHours);
          const thanksCount = computeVoucherThanksValue({ skillfulness, difficulty, hours });
          const { voucherId, thanksMinted } = await mintVolunteerVoucher({
            jobId,
            jobName: job.name,
            groupId: job.ownerId,
            assigneeId,
            thanksCount,
            skillfulness,
            difficulty,
            projectId,
            recordedBy: userId,
          });
          entries.push({
            assigneeId,
            amountCents: 0,
            status: "volunteer_voucher",
            receiptId: voucherId,
            thanksMinted,
          });
        }
      } else if (paysCash) {
        // Paying wallet: a job on a PROJECT draws from the project's treasury
        // wallet — the budget the group approved INTO the project is what its
        // jobs spend. An underfunded project parks payouts as pending_funds
        // (fund the project wallet, then re-run mark-done); it never silently
        // dips into the group settlement wallet. Project-less jobs pay from
        // the owning group/subgroup settlement wallet as before.
        const payerWallet = projectId
          ? await getOrCreateProjectWallet(projectId, job.ownerId)
          : await getSettlementWalletForAgent(job.ownerId);
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
              payerWalletId: payerWallet.id,
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
      const payoutStatus = mintsVolunteerVouchers
        ? "voucher"
        : !paysCash
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
      const voucherEntries = entries.filter((entry) => entry.status === "volunteer_voucher");
      const thanksMintedTotal = voucherEntries.reduce((sum, entry) => sum + (entry.thanksMinted ?? 0), 0);
      const message = mintsVolunteerVouchers
        ? voucherEntries.length > 0
          ? `Job marked done — minted ${thanksMintedTotal} Thanks across ${voucherEntries.length} volunteer voucher${voucherEntries.length === 1 ? "" : "s"} (claimed by the group).`
          : "Job marked done — volunteer vouchers already settled."
        : payKind === null
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

  // Job-level point pool (task-less jobs): split by peer allocation (each
  // assignee's sliders over the others, equal split until inputs exist) and
  // award as attested stake points — mark-done IS the attestation
  // (idempotent: one active points edge per assignee+job).
  const jobPoints =
    typeof meta.points === "number" && Number.isFinite(meta.points) && meta.points > 0 ? meta.points : null;
  if (jobPoints !== null && assignees.length > 0) {
    const { allocatePointsByShares } = await import("@/lib/peer-allocation");
    const { attestWork } = await import("@/lib/work-completion");
    const rawInputs = meta.pointShareInputs;
    const allocation = allocatePointsByShares(
      jobPoints,
      assignees,
      rawInputs && typeof rawInputs === "object" ? (rawInputs as Record<string, Record<string, number>>) : null,
    );
    for (const assigneeId of assignees) {
      const points = allocation.get(assigneeId) ?? 0;
      if (points <= 0) continue;
      await attestWork({
        verifierId: userId,
        workerId: assigneeId,
        ref: { targetId: jobId, targetType: "job", ownerId: job.ownerId, jobId, projectId },
        points,
        outcome: "verified",
      }).catch(() => {});
    }
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
