"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── Constants ──────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 2000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskNote {
  text: string;
  authorId: string;
  createdAt: string;
}

interface NoteResult {
  success: boolean;
  message: string;
}

interface GetNotesResult {
  success: boolean;
  message: string;
  notes: TaskNote[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getAuthUserId(): Promise<string | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user?.id ?? null;
}

// ─── Server Actions ─────────────────────────────────────────────────────────

/**
 * Appends a note to a task's metadata.notes array.
 * Only the assigned user (metadata.assigneeId) can add notes.
 */
export async function addTaskNote(taskId: string, note: string): Promise<NoteResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to add notes." };
  }

  if (!UUID_PATTERN.test(taskId)) {
    return { success: false, message: "Invalid task ID." };
  }

  const trimmedNote = note.trim();
  if (trimmedNote.length === 0) {
    return { success: false, message: "Note cannot be empty." };
  }

  if (trimmedNote.length > MAX_NOTE_LENGTH) {
    return { success: false, message: `Note cannot exceed ${MAX_NOTE_LENGTH} characters.` };
  }

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) {
    return { success: false, message: "Rate limit exceeded. Please try again later." };
  }

  // Fetch the task resource.
  const [task] = await db
    .select({
      id: resources.id,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, taskId),
        eq(resources.type, "task"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!task) {
    return { success: false, message: "Task not found." };
  }

  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const assigneeId = typeof meta.assigneeId === "string" ? meta.assigneeId : undefined;
  const assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo : undefined;

  // Allow either assigneeId or assignedTo field to match.
  if (assigneeId !== userId && assignedTo !== userId) {
    return { success: false, message: "Only the assigned user can add notes to this task." };
  }

  const existingNotes = Array.isArray(meta.notes) ? (meta.notes as TaskNote[]) : [];
  const newNote: TaskNote = {
    text: trimmedNote,
    authorId: userId,
    createdAt: new Date().toISOString(),
  };

  await db
    .update(resources)
    .set({
      metadata: {
        ...meta,
        notes: [...existingNotes, newNote],
      },
      updatedAt: new Date(),
    })
    .where(eq(resources.id, taskId));

  revalidatePath("/");

  return { success: true, message: "Note added." };
}

/**
 * Returns the notes array from a task's metadata.
 */
export async function getTaskNotes(taskId: string): Promise<GetNotesResult> {
  if (!UUID_PATTERN.test(taskId)) {
    return { success: false, message: "Invalid task ID.", notes: [] };
  }

  const [task] = await db
    .select({
      id: resources.id,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, taskId),
        eq(resources.type, "task"),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!task) {
    return { success: false, message: "Task not found.", notes: [] };
  }

  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const notes = Array.isArray(meta.notes) ? (meta.notes as TaskNote[]) : [];

  return { success: true, message: "Notes retrieved.", notes };
}
