"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── Constants ──────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DESCRIPTION_LENGTH = 5000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface UpdateResult {
  success: boolean;
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getAuthUserId(): Promise<string | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  return session?.user?.id ?? null;
}

// ─── Server Actions ─────────────────────────────────────────────────────────

/**
 * Updates a task's description. Only group admins may perform this action.
 * Checks admin role via hasGroupWriteAccess on the task's owning group.
 */
export async function updateTaskDescription(
  taskId: string,
  description: string,
): Promise<UpdateResult> {
  const userId = await getAuthUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to edit tasks." };
  }

  if (!UUID_PATTERN.test(taskId)) {
    return { success: false, message: "Invalid task ID." };
  }

  const trimmedDescription = description.trim();
  if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
    return { success: false, message: `Description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.` };
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
      ownerId: resources.ownerId,
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

  // Check group admin access via ledger-based hasGroupWriteAccess.
  const { hasGroupWriteAccess } = await import("@/app/actions/create-resources");
  const isGroupAdmin = await hasGroupWriteAccess(userId, task.ownerId);
  const isDirectOwner = task.ownerId === userId;

  if (!isDirectOwner && !isGroupAdmin) {
    return { success: false, message: "Only group admins can edit task descriptions." };
  }

  await db
    .update(resources)
    .set({
      description: trimmedDescription,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, taskId));

  revalidatePath("/");

  return { success: true, message: "Task description updated." };
}
