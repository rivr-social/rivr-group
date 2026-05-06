"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── Constants ──────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TIMER_VERB = "work" as const;
const TIMER_OBJECT_TYPE = "resource";
const TIMER_INTERACTION_TYPE = "time_entry";

// ─── Result Types ───────────────────────────────────────────────────────────

interface TimerStartResult {
  success: boolean;
  message: string;
  entryId?: string;
}

interface TimerStopResult {
  success: boolean;
  message: string;
  durationMs?: number;
  tasksCompletedDuringPeriod?: string[];
}

interface TimerEntry {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
}

interface TimerStatusResult {
  success: boolean;
  message: string;
  activeTimer: TimerEntry | null;
  totalTimeMs: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getAuthUserId(): Promise<string | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user?.id ?? null;
}

function isRunningTimerEntry(metadata: Record<string, unknown>): boolean {
  return (
    metadata.interactionType === TIMER_INTERACTION_TYPE &&
    typeof metadata.startedAt === "string" &&
    metadata.stoppedAt === null
  );
}

// ─── Server Actions ─────────────────────────────────────────────────────────

/**
 * Starts a work timer on the given job for the authenticated user.
 * Only one running timer per user per job is allowed.
 */
export async function startJobTimer(jobId: string): Promise<TimerStartResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to start a timer." };
  }

  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID." };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  // Check for an existing running timer on this job for this user.
  const existing = await db
    .select({ id: ledger.id, metadata: ledger.metadata })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, TIMER_VERB),
        eq(ledger.objectId, jobId),
        eq(ledger.objectType, TIMER_OBJECT_TYPE),
        eq(ledger.isActive, true),
      ),
    );

  const runningEntry = existing.find((e) =>
    isRunningTimerEntry((e.metadata ?? {}) as Record<string, unknown>),
  );

  if (runningEntry) {
    return { success: false, message: "A timer is already running on this job." };
  }

  const now = new Date().toISOString();

  const [inserted] = await db
    .insert(ledger)
    .values({
      subjectId: userId,
      verb: TIMER_VERB,
      objectId: jobId,
      objectType: TIMER_OBJECT_TYPE,
      metadata: {
        interactionType: TIMER_INTERACTION_TYPE,
        startedAt: now,
        stoppedAt: null,
        durationMs: null,
      },
    } as NewLedgerEntry)
    .returning({ id: ledger.id });

  revalidatePath("/");

  return { success: true, message: "Timer started.", entryId: inserted.id };
}

/**
 * Stops the running work timer on the given job for the authenticated user.
 * Calculates the duration and persists it.
 */
export async function stopJobTimer(
  jobId: string,
  completedTaskIds: string[] = [],
): Promise<TimerStopResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to stop a timer." };
  }

  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID." };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  // Find the running timer.
  const entries = await db
    .select({ id: ledger.id, metadata: ledger.metadata })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, TIMER_VERB),
        eq(ledger.objectId, jobId),
        eq(ledger.objectType, TIMER_OBJECT_TYPE),
        eq(ledger.isActive, true),
      ),
    );

  const runningEntry = entries.find((e) =>
    isRunningTimerEntry((e.metadata ?? {}) as Record<string, unknown>),
  );

  if (!runningEntry) {
    return { success: false, message: "No running timer found for this job." };
  }

  const meta = (runningEntry.metadata ?? {}) as Record<string, unknown>;
  const startedAt = meta.startedAt as string;
  const now = new Date();
  const stoppedAt = now.toISOString();
  const durationMs = now.getTime() - new Date(startedAt).getTime();

  // Validate completedTaskIds — only keep valid UUIDs.
  const validTaskIds = completedTaskIds.filter((id) => UUID_PATTERN.test(id));

  await db
    .update(ledger)
    .set({
      metadata: {
        ...meta,
        stoppedAt,
        durationMs,
        tasksCompletedDuringPeriod: validTaskIds,
      },
    })
    .where(eq(ledger.id, runningEntry.id));

  revalidatePath("/");

  return {
    success: true,
    message: "Timer stopped.",
    durationMs,
    tasksCompletedDuringPeriod: validTaskIds,
  };
}

/**
 * Returns the current timer status for a job: active timer (if any) and total
 * time logged across all completed sessions.
 */
export async function getJobTimerStatus(jobId: string): Promise<TimerStatusResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "Not authenticated.", activeTimer: null, totalTimeMs: 0 };
  }

  if (!UUID_PATTERN.test(jobId)) {
    return { success: false, message: "Invalid job ID.", activeTimer: null, totalTimeMs: 0 };
  }

  const entries = await db
    .select({ id: ledger.id, metadata: ledger.metadata })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.verb, TIMER_VERB),
        eq(ledger.objectId, jobId),
        eq(ledger.objectType, TIMER_OBJECT_TYPE),
        eq(ledger.isActive, true),
      ),
    );

  let activeTimer: TimerEntry | null = null;
  let totalTimeMs = 0;

  for (const entry of entries) {
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    if (meta.interactionType !== TIMER_INTERACTION_TYPE) continue;

    const startedAt = typeof meta.startedAt === "string" ? meta.startedAt : null;
    if (!startedAt) continue;

    const stoppedAt = typeof meta.stoppedAt === "string" ? meta.stoppedAt : null;
    const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : null;

    if (stoppedAt === null) {
      // Active/running timer.
      activeTimer = {
        id: entry.id,
        startedAt,
        stoppedAt: null,
        durationMs: null,
      };
    } else if (durationMs !== null) {
      totalTimeMs += durationMs;
    }
  }

  return {
    success: true,
    message: activeTimer ? "Timer is running." : "No active timer.",
    activeTimer,
    totalTimeMs,
  };
}

/**
 * Returns aggregate total time logged (in ms) for a job across ALL users.
 * Used in the project header to show total work time.
 */
export async function getJobTotalTime(jobId: string): Promise<number> {
  const entries = await db
    .select({ metadata: ledger.metadata })
    .from(ledger)
    .where(
      and(
        eq(ledger.verb, TIMER_VERB),
        eq(ledger.objectId, jobId),
        eq(ledger.objectType, TIMER_OBJECT_TYPE),
        eq(ledger.isActive, true),
      ),
    );

  let totalMs = 0;
  for (const entry of entries) {
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    if (meta.interactionType !== TIMER_INTERACTION_TYPE) continue;
    if (typeof meta.durationMs === "number") {
      totalMs += meta.durationMs;
    }
  }
  return totalMs;
}
