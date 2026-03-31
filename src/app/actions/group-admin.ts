"use server";

/**
 * @file Server actions for group administration settings.
 * @description Exports password-management and settings-management actions for groups,
 * including join settings and membership plans. All exported actions require authentication
 * and admin-level authorization checks through ledger-backed membership records.
 * @dependencies `@/auth`, `@/db`, `@/db/schema`, `@node-rs/bcrypt`, `next/cache`,
 * `@/lib/types`, `@/lib/group-memberships`, `drizzle-orm`
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { revalidatePath } from "next/cache";
import { JoinType, type GroupJoinSettings } from "@/lib/types";
import {
  normalizeGroupMembershipPlans,
  readGroupMembershipPlans,
  type GroupMembershipPlan,
} from "@/lib/group-memberships";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";

// =============================================================================
// Constants
// =============================================================================

/** bcrypt cost factor — OWASP recommends >= 10 for password storage */
const BCRYPT_COST = 12;

/** Minimum password length per NIST SP 800-63B */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum password length to prevent bcrypt DoS (bcrypt truncates at 72 bytes) */
const MAX_PASSWORD_LENGTH = 72;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// =============================================================================
// Result types
// =============================================================================

type GroupAdminResult = {
  success: boolean;
  error?: string;
};

type GroupSettingsResult = {
  success: boolean;
  error?: string;
  group?: {
    id: string;
    name: string;
    groupType: string;
    joinSettings: GroupJoinSettings;
    membershipPlans: GroupMembershipPlan[];
    modelUrl?: string;
    hasPassword: boolean;
  };
};

// =============================================================================
// Server actions
// =============================================================================

/**
 * Set or update a group's password hash.
 *
 * Auth requirement: caller must be authenticated and recognized as a group admin.
 * Error handling pattern: validation and authorization failures return `{ success: false, error }`.
 * Rate limiting: no action-level rate limiter is applied in this module.
 *
 * @param {string} groupId - UUID of the target group agent.
 * @param {string} newPassword - Plaintext password to hash and store.
 * @returns {Promise<GroupAdminResult>} Success flag or user-facing error message.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await setGroupPassword(groupId, "correct horse battery staple");
 * if (!result.success) console.error(result.error);
 */
export async function setGroupPassword(
  groupId: string,
  newPassword: string
): Promise<GroupAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return {
      success: false,
      error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }

  const actorId = session.user.id;

  const facadeResult = await updateFacade.execute(
    {
      type: "setGroupPassword",
      actorId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
  // Authorization is enforced server-side regardless of client UI role assumptions.
  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can manage the group password." };
  }

  // Verify the group exists
  const [group] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  // Store only a bcrypt hash; never persist plaintext credentials.
  const passwordHash = await hash(newPassword, BCRYPT_COST);

  await db
    .update(agents)
    .set({ groupPasswordHash: passwordHash, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  return { success: true } as GroupAdminResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "password", action: "set" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to set group password." };
}

/**
 * Remove a group's password requirement.
 *
 * Auth requirement: caller must be authenticated and authorized as a group admin.
 * Error handling pattern: returns structured errors for invalid IDs, auth failures, and missing groups.
 * Rate limiting: no action-level rate limiter is applied in this module.
 *
 * @param {string} groupId - UUID of the target group agent.
 * @returns {Promise<GroupAdminResult>} Success flag or user-facing error message.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await removeGroupPassword(groupId);
 * if (result.success) console.log("Group is no longer password-protected");
 */
export async function removeGroupPassword(
  groupId: string
): Promise<GroupAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const actorId = session.user.id;

  const facadeResult = await updateFacade.execute(
    {
      type: "removeGroupPassword",
      actorId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
  // Authorization is enforced server-side to prevent privilege bypass.
  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can manage the group password." };
  }

  // Verify the group exists
  const [group] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  await db
    .update(agents)
    .set({ groupPasswordHash: null, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  return { success: true } as GroupAdminResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "password", action: "remove" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to remove group password." };
}

/**
 * Fetch group settings visible to admins for management screens.
 *
 * Auth requirement: caller must be authenticated and authorized as a group admin.
 * Error handling pattern: returns typed failure payloads for auth, validation, and not-found states.
 * Rate limiting: no action-level rate limiter is applied in this module.
 *
 * @param {string} groupId - UUID of the group whose settings are requested.
 * @returns {Promise<GroupSettingsResult>} Group settings payload on success, otherwise an error.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await fetchGroupAdminSettings(groupId);
 * if (result.success) console.log(result.group?.joinSettings.joinType);
 */
export async function fetchGroupAdminSettings(
  groupId: string
): Promise<GroupSettingsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const admin = await isGroupAdmin(session.user.id, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can view group settings." };
  }

  const [group] = await db
    .select({ id: agents.id, name: agents.name, metadata: agents.metadata, groupPasswordHash: agents.groupPasswordHash })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  // Parse metadata defensively because historical records may not match current schema.
  const metadata =
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
  const rawJoin = metadata.joinSettings as Partial<GroupJoinSettings> | undefined;
  const joinTypeValue = rawJoin?.joinType;
  // Only accept known enum values; unknown values are safely downgraded to public join mode.
  const joinType = Object.values(JoinType).includes(joinTypeValue as JoinType)
    ? (joinTypeValue as JoinType)
    : JoinType.Public;

  const joinSettings: GroupJoinSettings = {
    joinType,
    visibility: rawJoin?.visibility === "hidden" ? "hidden" : "public",
    questions: Array.isArray(rawJoin?.questions)
      ? (rawJoin?.questions as GroupJoinSettings["questions"])
      : [],
    approvalRequired: Boolean(rawJoin?.approvalRequired),
    passwordRequired: Boolean(rawJoin?.passwordRequired),
    inviteLink: typeof rawJoin?.inviteLink === "string" ? rawJoin.inviteLink : undefined,
    applicationInstructions:
      typeof rawJoin?.applicationInstructions === "string"
        ? rawJoin.applicationInstructions
        : undefined,
  };

  return {
    success: true,
    group: {
      id: group.id,
      name: group.name,
      groupType: typeof metadata.groupType === "string" ? metadata.groupType : "basic",
      joinSettings,
      membershipPlans: readGroupMembershipPlans(metadata),
      modelUrl: typeof metadata.modelUrl === "string" ? metadata.modelUrl : undefined,
      hasPassword: Boolean(group.groupPasswordHash),
    },
  };
}

/**
 * Update how users can join a group and which application questions are required.
 *
 * Auth requirement: caller must be authenticated and authorized as a group admin.
 * Error handling pattern: returns validation/authorization/not-found errors as data.
 * Rate limiting: no action-level rate limiter is applied in this module.
 *
 * @param {string} groupId - UUID of the target group.
 * @param {GroupJoinSettings} joinSettings - Proposed join settings from the admin UI.
 * @returns {Promise<GroupAdminResult>} Success flag or user-facing error message.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await updateGroupJoinSettings(groupId, {
 *   joinType: JoinType.Approval,
 *   questions: [{ id: "q-1", question: "Why join?", required: true, type: "text" }],
 *   approvalRequired: true,
 * });
 */
export async function updateGroupJoinSettings(
  groupId: string,
  joinSettings: GroupJoinSettings
): Promise<GroupAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const actorId = session.user.id;

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupJoinSettings",
      actorId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
  if (!(await isGroupAdmin(actorId, groupId))) {
    return { success: false, error: "Only group admins can edit group settings." };
  }

  const joinTypeValue = joinSettings?.joinType;
  if (!Object.values(JoinType).includes(joinTypeValue)) {
    return { success: false, error: "Invalid join type." };
  }

  // Normalize and clamp user-provided settings to protect storage and rendering paths.
  const normalized: GroupJoinSettings = {
    joinType: joinTypeValue,
    visibility: joinSettings?.visibility === "hidden" ? "hidden" : "public",
    questions: Array.isArray(joinSettings.questions)
      ? joinSettings.questions.slice(0, 20).map((question, idx) => ({
          id:
            typeof question.id === "string" && question.id.trim().length > 0
              ? question.id.trim()
              : `q-${idx + 1}`,
          question:
            typeof question.question === "string"
              ? question.question.trim().slice(0, 200)
              : "",
          label:
            typeof question.label === "string"
              ? question.label.trim().slice(0, 120)
              : undefined,
          required: Boolean(question.required),
          // Restrict input types to a known allow-list to avoid unsupported UI/control states.
          type:
            question.type === "multipleChoice" ||
            question.type === "checkbox" ||
            question.type === "textarea" ||
            question.type === "radio"
              ? question.type
              : "text",
          options: Array.isArray(question.options)
            ? question.options
                .map((option) => {
                  if (typeof option === "string") return option.trim().slice(0, 120);
                  // Coerce polymorphic option shapes into a safe canonical representation.
                  if (option && typeof option === "object") {
                    const rec = option as Record<string, unknown>;
                    const value = typeof rec.value === "string" ? rec.value.trim().slice(0, 120) : "";
                    const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 120) : value;
                    return value ? { value, label } : null;
                  }
                  return null;
                })
                .filter((option): option is string | { value: string; label: string } => Boolean(option))
                .slice(0, 20)
            : undefined,
        }))
      : [],
    approvalRequired: Boolean(joinSettings.approvalRequired),
    passwordRequired: Boolean(joinSettings.passwordRequired),
    inviteLink:
      typeof joinSettings.inviteLink === "string" && joinSettings.inviteLink.trim().length > 0
        ? joinSettings.inviteLink.trim().slice(0, 300)
        : undefined,
    applicationInstructions:
      typeof joinSettings.applicationInstructions === "string" &&
      joinSettings.applicationInstructions.trim().length > 0
        ? joinSettings.applicationInstructions.trim().slice(0, 2000)
        : undefined,
  };

  const [current] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!current) {
    return { success: false, error: "Group not found." };
  }

  const existingMetadata =
    current.metadata && typeof current.metadata === "object"
      ? (current.metadata as Record<string, unknown>)
      : {};
  const scopedLocaleIds = Array.isArray(existingMetadata.scopedLocaleIds)
    ? existingMetadata.scopedLocaleIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  // Merge settings without discarding unrelated metadata keys.
  const nextMetadata = {
    ...existingMetadata,
    joinSettings: normalized,
  };
  const nextVisibility =
    normalized.visibility === "hidden"
      ? "private"
      : scopedLocaleIds.length > 0
        ? "locale"
        : "public";

  await db
    .update(agents)
    .set({
      metadata: nextMetadata,
      visibility: nextVisibility,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, groupId));

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/settings`);

  return { success: true } as GroupAdminResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "joinSettings" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to update join settings." };
}

/**
 * Update membership plan definitions stored on group metadata.
 *
 * Auth requirement: caller must be authenticated and authorized as a group admin.
 * Error handling pattern: invalid input, auth failures, and missing groups return structured errors.
 * Rate limiting: no action-level rate limiter is applied in this module.
 *
 * @param {string} groupId - UUID of the target group.
 * @param {unknown} membershipPlans - Raw plan payload from admin UI.
 * @returns {Promise<GroupAdminResult>} Success flag or user-facing error message.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await updateGroupMembershipPlans(groupId, [
 *   { name: "Standard", priceMonthly: 15, perks: ["Weekly calls"] },
 * ]);
 */
export async function updateGroupMembershipPlans(
  groupId: string,
  membershipPlans: unknown
): Promise<GroupAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const actorId = session.user.id;

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupMembershipPlans",
      actorId,
      targetAgentId: groupId,
      payload: {},
    },
    async () => {
  if (!(await isGroupAdmin(actorId, groupId))) {
    return { success: false, error: "Only group admins can edit membership plans." };
  }

  // Centralized normalization enforces plan shape and strips invalid entries.
  const normalizedPlans = normalizeGroupMembershipPlans(membershipPlans);
  if (normalizedPlans.length === 0) {
    return { success: false, error: "Add at least one membership plan." };
  }

  const [current] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!current) {
    return { success: false, error: "Group not found." };
  }

  const existingMetadata =
    current.metadata && typeof current.metadata === "object"
      ? (current.metadata as Record<string, unknown>)
      : {};
  // Keep legacy `membershipTiers` in sync for consumers that still rely on tier names.
  const nextMetadata = {
    ...existingMetadata,
    membershipPlans: normalizedPlans,
    membershipTiers: normalizedPlans.map((plan) => plan.name),
  };

  await db
    .update(agents)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/settings`);

  return { success: true } as GroupAdminResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "membershipPlans" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to update membership plans." };
}

// =============================================================================
// Internal helpers
// =============================================================================

export async function isGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const now = new Date();
  const [adminEntry] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
        or(eq(ledger.role, "admin"), eq(ledger.role, "moderator")),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > ${now}`)
      )
    )
    .limit(1);

  if (adminEntry) return true;

  // Fallback for groups that encode ownership/admin rights in metadata instead of ledger roles.
  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group?.metadata || typeof group.metadata !== "object") {
    return false;
  }

  const metadata = group.metadata as Record<string, unknown>;
  if (metadata.creatorId === userId) return true;

  if (Array.isArray(metadata.adminIds)) {
    return metadata.adminIds.some((id: unknown) => typeof id === "string" && id === userId);
  }

  return false;
}
