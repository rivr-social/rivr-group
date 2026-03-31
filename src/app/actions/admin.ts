"use server";

/**
 * Server actions for the admin panel.
 *
 * Purpose:
 * - Fetch all agents for user management.
 * - Toggle agent active/inactive status via soft delete.
 * - Approve/reject tasks by updating resource metadata.
 * - Assign/remove badge ledger entries.
 * - Create badge resources (delegates to createBadgeResourceAction).
 *
 * Auth: All actions require an authenticated session with admin privileges.
 * The `requireAdmin()` helper verifies `metadata.siteRole === "admin"` on
 * the agent record before allowing any operation.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
} from "@/db/schema";
import { eq, isNull, desc, and, sql, count } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminActionResult {
  success: boolean;
  message: string;
  error?: { code: string; details?: string };
}

export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  type: string;
  status: "active" | "inactive";
  joinDate: string;
  badgeCount: number;
}

// ─── Error codes ─────────────────────────────────────────────────────────────

const AUTH_ERROR_UNAUTHORIZED = "Unauthorized";
const AUTH_ERROR_FORBIDDEN = "Forbidden: admin privileges required";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function requireAuthenticatedUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id ?? null;
  if (!userId) throw new Error(AUTH_ERROR_UNAUTHORIZED);
  return userId;
}

/**
 * Verifies the current session user has platform admin privileges.
 *
 * Admin status is determined by `metadata.siteRole === "admin"` on the
 * agent record. This is the server-side enforcement that complements the
 * client-side `isSuperAdmin()` check in the UserContext.
 *
 * @returns The authenticated admin user's agent ID.
 * @throws {Error} If user is not authenticated or lacks admin privileges.
 */
async function requireAdmin(): Promise<string> {
  const userId = await requireAuthenticatedUserId();

  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  if (!agent) {
    throw new Error(AUTH_ERROR_UNAUTHORIZED);
  }

  const metadata =
    agent.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  if (metadata.siteRole !== "admin") {
    throw new Error(AUTH_ERROR_FORBIDDEN);
  }

  return userId;
}

// ─── Agent / User Management ──────────────────────────────────────────────────

/**
 * Fetches all person-type agents for the admin user list, including badge counts.
 */
export async function fetchAdminUsers(): Promise<AdminUser[]> {
  await requireAdmin();

  // Fetch all person agents (including soft-deleted for admin visibility)
  const allAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      image: agents.image,
      type: agents.type,
      deletedAt: agents.deletedAt,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.type, "person"))
    .orderBy(desc(agents.createdAt));

  // Batch-fetch badge counts for all users via ledger
  const badgeCounts = await db.execute(sql`
    SELECT l.subject_id, COUNT(*)::int AS badge_count
    FROM ledger l
    JOIN resources r ON l.resource_id = r.id
    WHERE l.verb = 'assign'
      AND l.is_active = true
      AND r.type = 'badge'
      AND r.deleted_at IS NULL
    GROUP BY l.subject_id
  `) as { subject_id: string; badge_count: number }[];

  const badgeCountMap = new Map<string, number>();
  for (const row of badgeCounts) {
    badgeCountMap.set(row.subject_id, row.badge_count);
  }

  return allAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    email: agent.email,
    image: agent.image,
    type: agent.type,
    status: agent.deletedAt ? "inactive" as const : "active" as const,
    joinDate: agent.createdAt instanceof Date
      ? agent.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : String(agent.createdAt),
    badgeCount: badgeCountMap.get(agent.id) ?? 0,
  }));
}

/**
 * Toggles a user's active status by setting/clearing the soft-delete timestamp.
 */
export async function toggleUserActiveStatus(userId: string): Promise<AdminActionResult> {
  await requireAdmin();

  const [agent] = await db
    .select({ id: agents.id, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  if (!agent) {
    return { success: false, message: "User not found", error: { code: "NOT_FOUND" } };
  }

  const isCurrentlyActive = !agent.deletedAt;
  const newDeletedAt = isCurrentlyActive ? new Date() : null;

  await db
    .update(agents)
    .set({ deletedAt: newDeletedAt, updatedAt: new Date() })
    .where(eq(agents.id, userId));

  revalidatePath("/admin/users");
  revalidatePath("/admin");

  return {
    success: true,
    message: isCurrentlyActive ? "User deactivated" : "User activated",
  };
}

// ─── Task Approval ────────────────────────────────────────────────────────────

/**
 * Approves a task by updating its status in the shift resource's metadata.
 */
export async function approveTaskAction(
  taskId: string,
  shiftResourceId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  return updateTaskStatus(taskId, shiftResourceId, "completed");
}

/**
 * Rejects a task by updating its status in the shift resource's metadata.
 */
export async function rejectTaskAction(
  taskId: string,
  shiftResourceId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  return updateTaskStatus(taskId, shiftResourceId, "rejected");
}

async function updateTaskStatus(
  taskId: string,
  shiftResourceId: string,
  newStatus: "completed" | "rejected"
): Promise<AdminActionResult> {
  const [resource] = await db
    .select({ id: resources.id, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, shiftResourceId), isNull(resources.deletedAt)))
    .limit(1);

  if (!resource) {
    return { success: false, message: "Shift resource not found", error: { code: "NOT_FOUND" } };
  }

  const meta = (resource.metadata ?? {}) as Record<string, unknown>;
  const tasks = (meta.tasks as Array<{ id: string; status: string; [key: string]: unknown }>) ?? [];

  const taskIndex = tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, message: "Task not found in shift", error: { code: "NOT_FOUND" } };
  }

  tasks[taskIndex] = { ...tasks[taskIndex], status: newStatus, completed: newStatus === "completed" };

  await db
    .update(resources)
    .set({
      metadata: { ...meta, tasks },
      updatedAt: new Date(),
    })
    .where(eq(resources.id, shiftResourceId));

  revalidatePath("/admin/tasks");
  revalidatePath("/admin");

  return {
    success: true,
    message: newStatus === "completed" ? "Task approved" : "Task rejected",
  };
}

// ─── Agent Name Lookup (for tasks/dashboard) ─────────────────────────────────

/**
 * Fetches agent names and images by IDs, for resolving assignee display info.
 * Returns a map of agentId -> { name, image }.
 */
export async function fetchAgentDisplayMap(
  agentIds: string[]
): Promise<Record<string, { name: string; image: string | null }>> {
  if (agentIds.length === 0) return {};

  await requireAdmin();

  const rows = await db.execute(sql`
    SELECT id, name, image
    FROM agents
    WHERE id = ANY(${agentIds}::uuid[])
  `) as { id: string; name: string; image: string | null }[];

  const map: Record<string, { name: string; image: string | null }> = {};
  for (const row of rows) {
    map[row.id] = { name: row.name, image: row.image };
  }
  return map;
}

// ─── Badge Assignment (Ledger-Backed) ─────────────────────────────────────────

/**
 * Assigns a badge to a user by creating an active 'assign' ledger entry.
 */
export async function assignBadgeToUser(
  userId: string,
  badgeId: string
): Promise<AdminActionResult> {
  const actorId = await requireAdmin();

  // Verify user exists
  const [user] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  if (!user) {
    return { success: false, message: "User not found", error: { code: "NOT_FOUND" } };
  }

  // Verify badge exists
  const [badge] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, badgeId), eq(resources.type, "badge"), isNull(resources.deletedAt)))
    .limit(1);

  if (!badge) {
    return { success: false, message: "Badge not found", error: { code: "NOT_FOUND" } };
  }

  // Check if already assigned
  const existing = await db.execute(sql`
    SELECT id FROM ledger
    WHERE subject_id = ${userId}::uuid
      AND resource_id = ${badgeId}::uuid
      AND verb = 'assign'
      AND is_active = true
    LIMIT 1
  `) as { id: string }[];

  if (existing.length > 0) {
    return { success: false, message: "Badge already assigned to this user", error: { code: "DUPLICATE" } };
  }

  // Create ledger entry
  await db.insert(ledger).values({
    verb: "assign",
    subjectId: userId,
    objectId: badgeId,
    objectType: "resource",
    resourceId: badgeId,
    isActive: true,
    metadata: { assignedBy: actorId, assignedAt: new Date().toISOString() },
  });

  revalidatePath("/admin/badges");
  revalidatePath("/admin");

  return { success: true, message: "Badge assigned successfully" };
}

/**
 * Removes a badge from a user by deactivating the 'assign' ledger entry.
 */
export async function removeBadgeFromUser(
  userId: string,
  badgeId: string
): Promise<AdminActionResult> {
  await requireAdmin();

  const result = await db.execute(sql`
    UPDATE ledger
    SET is_active = false
    WHERE subject_id = ${userId}::uuid
      AND resource_id = ${badgeId}::uuid
      AND verb = 'assign'
      AND is_active = true
  `);

  revalidatePath("/admin/badges");
  revalidatePath("/admin");

  return { success: true, message: "Badge removed successfully" };
}

// ─── Badge Creation (admin-level, no group required) ──────────────────────────

/**
 * Creates a new badge resource at the platform level (owned by the admin user).
 */
export async function createAdminBadgeAction(input: {
  name: string;
  description: string;
  icon?: string;
  level?: "beginner" | "intermediate" | "advanced" | "expert";
}): Promise<AdminActionResult & { resourceId?: string }> {
  const actorId = await requireAdmin();

  if (!input.name?.trim() || !input.description?.trim()) {
    return {
      success: false,
      message: "Name and description are required",
      error: { code: "INVALID_INPUT" },
    };
  }

  const [inserted] = await db.insert(resources).values({
    name: input.name.trim(),
    type: "badge",
    description: input.description.trim(),
    content: input.description.trim(),
    ownerId: actorId,
    visibility: "public",
    tags: [],
    metadata: {
      resourceKind: "badge",
      entityType: "badge",
      icon: input.icon?.trim() || "",
      category: "community",
      level: input.level ?? "beginner",
      requirements: [],
      holders: [],
      jobsUnlocked: [],
      trainingModules: [],
    },
  }).returning({ id: resources.id });

  // Record creation in ledger
  await db.insert(ledger).values({
    verb: "create",
    subjectId: actorId,
    objectId: inserted.id,
    objectType: "resource",
    resourceId: inserted.id,
    isActive: true,
    metadata: { action: "admin_badge_create" },
  });

  revalidatePath("/admin/badges");
  revalidatePath("/admin");

  return {
    success: true,
    message: `Badge "${input.name.trim()}" created successfully`,
    resourceId: inserted.id,
  };
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────

/**
 * Fetches the total count of person-type agents (for dashboard stats).
 */
export async function fetchTotalUserCount(): Promise<number> {
  await requireAdmin();

  const [result] = await db
    .select({ total: count() })
    .from(agents)
    .where(and(eq(agents.type, "person"), isNull(agents.deletedAt)));

  return result?.total ?? 0;
}
