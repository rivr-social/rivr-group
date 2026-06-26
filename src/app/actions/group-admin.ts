"use server";

/**
 * @file Server actions for group administration settings.
 * @description Exports password-management and settings-management actions for groups,
 * including join settings and membership plans. All exported actions require authentication
 * and admin-level authorization checks through ledger-backed membership records.
 * @dependencies `@/auth`, `@/db`, `@/db/schema`, `@node-rs/bcrypt`, `next/cache`,
 * `@/lib/types`, `@/lib/group-memberships`, `drizzle-orm`
 */

import { db } from "@/db";
import { agents, ledger, type MembershipTier } from "@/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { hash } from "@node-rs/bcrypt";
import { revalidatePath } from "next/cache";
import {
  JoinType,
  ALL_GROUP_TAB_KEYS,
  CONFIG_TAB_LOCKED_VISIBILITY,
  isConfigTab,
  type GroupJoinSettings,
  type TabVisibilitySettings,
  type TabVisibilityLevel,
} from "@/lib/types";
import {
  normalizeGroupMembershipPlans,
  readGroupMembershipPlans,
  type GroupMembershipPlan,
} from "@/lib/group-memberships";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import {
  MAX_MARKETPLACE_FEE_BPS,
  MIN_MARKETPLACE_FEE_BPS,
  normalizeMarketplaceFeeBps,
} from "@/lib/marketplace-fees";
import { getAuthenticatedActorId } from "@/lib/server-auth";

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
const MEMBERSHIP_TIER_VALUES: MembershipTier[] = [
  "basic",
  "host",
  "seller",
  "organizer",
  "steward",
];

// =============================================================================
// Result types
// =============================================================================

type GroupAdminResult = {
  success: boolean;
  error?: string;
};

/**
 * Stable, machine-readable failure codes for {@link fetchGroupAdminSettings}.
 * The settings page keys redirect behavior on `FORBIDDEN`/`UNAUTHENTICATED`
 * rather than matching error message text.
 */
export const GROUP_SETTINGS_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_GROUP: "INVALID_GROUP",
  NOT_FOUND: "NOT_FOUND",
} as const;
export type GroupSettingsErrorCode =
  (typeof GROUP_SETTINGS_ERROR_CODES)[keyof typeof GROUP_SETTINGS_ERROR_CODES];

type GroupSettingsResult = {
  success: boolean;
  error?: string;
  code?: GroupSettingsErrorCode;
  group?: {
    id: string;
    name: string;
    groupType: string;
    joinSettings: GroupJoinSettings;
    membershipPlans: GroupMembershipPlan[];
    writeMembershipTier?: MembershipTier | null;
    writeMembershipPlanId?: string | null;
    marketplaceFeeBps?: number;
    tabVisibility: TabVisibilitySettings;
    modelUrl?: string;
    hasPassword: boolean;
  };
};

async function requireActorId(): Promise<string | null> {
  return getAuthenticatedActorId();
}

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
  const actorId = await requireActorId();
  if (!actorId) {
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

  const facadeResult = await updateFacade.execute(
    {
      type: "setGroupPassword",
      actorId,
      targetAgentId: groupId,
      payload: { newPassword },
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
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "removeGroupPassword",
      actorId,
      targetAgentId: groupId,
      payload: { groupId },
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
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required.", code: GROUP_SETTINGS_ERROR_CODES.UNAUTHENTICATED };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier.", code: GROUP_SETTINGS_ERROR_CODES.INVALID_GROUP };
  }

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can view group settings.", code: GROUP_SETTINGS_ERROR_CODES.FORBIDDEN };
  }

  const [group] = await db
    .select({ id: agents.id, name: agents.name, metadata: agents.metadata, groupPasswordHash: agents.groupPasswordHash })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found.", code: GROUP_SETTINGS_ERROR_CODES.NOT_FOUND };
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
      writeMembershipTier:
        typeof metadata.writeMembershipTier === "string" &&
        MEMBERSHIP_TIER_VALUES.includes(metadata.writeMembershipTier as MembershipTier)
          ? (metadata.writeMembershipTier as MembershipTier)
          : null,
      writeMembershipPlanId:
        typeof metadata.writeMembershipPlanId === "string" && metadata.writeMembershipPlanId.trim().length > 0
          ? metadata.writeMembershipPlanId.trim()
          : null,
      marketplaceFeeBps: normalizeMarketplaceFeeBps(metadata.marketplaceFeeBps) ?? undefined,
      tabVisibility: parseTabVisibility(metadata.tabVisibility),
      modelUrl: typeof metadata.modelUrl === "string" ? metadata.modelUrl : undefined,
      hasPassword: Boolean(group.groupPasswordHash),
    },
  };
}

export async function updateGroupWriteAccessPolicy(
  groupId: string,
  policy: {
    writeMembershipTier?: MembershipTier | null;
    writeMembershipPlanId?: string | null;
  },
): Promise<GroupAdminResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const requestedTier = policy.writeMembershipTier ?? null;
  if (requestedTier !== null && !MEMBERSHIP_TIER_VALUES.includes(requestedTier)) {
    return { success: false, error: "Invalid write membership tier." };
  }
  const requestedPlanId =
    typeof policy.writeMembershipPlanId === "string" && policy.writeMembershipPlanId.trim().length > 0
      ? policy.writeMembershipPlanId.trim()
      : null;

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupWriteAccessPolicy",
      actorId,
      targetAgentId: groupId,
      payload: { writeMembershipTier: requestedTier, writeMembershipPlanId: requestedPlanId },
    },
    async () => {
      if (!(await isGroupAdmin(actorId, groupId))) {
        return { success: false, error: "Only group admins can edit access policy settings." };
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

      const nextMetadata: Record<string, unknown> = { ...existingMetadata };
      if (requestedTier === null) {
        delete nextMetadata.writeMembershipTier;
      } else {
        nextMetadata.writeMembershipTier = requestedTier;
      }
      if (requestedPlanId === null) {
        delete nextMetadata.writeMembershipPlanId;
      } else {
        nextMetadata.writeMembershipPlanId = requestedPlanId;
      }

      await db
        .update(agents)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(agents.id, groupId));

      revalidatePath(`/groups/${groupId}`);
      revalidatePath(`/groups/${groupId}/settings`);
      return { success: true } as GroupAdminResult;
    },
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: {
          setting: "writeAccessPolicy",
          writeMembershipTier: requestedTier,
          writeMembershipPlanId: requestedPlanId,
        },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to update access policy settings." };
}

export async function updateGroupMarketplaceFeeBps(
  groupId: string,
  marketplaceFeeBps: number | null,
): Promise<GroupAdminResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const normalizedFee =
    marketplaceFeeBps === null ? null : normalizeMarketplaceFeeBps(marketplaceFeeBps);
  if (marketplaceFeeBps !== null && normalizedFee === null) {
    return {
      success: false,
      error: `Marketplace fee must be an integer between ${MIN_MARKETPLACE_FEE_BPS} and ${MAX_MARKETPLACE_FEE_BPS} basis points.`,
    };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupMarketplaceFeeBps",
      actorId,
      targetAgentId: groupId,
      payload: { marketplaceFeeBps: normalizedFee },
    },
    async () => {
      if (!(await isGroupAdmin(actorId, groupId))) {
        return { success: false, error: "Only group admins can edit marketplace fee settings." };
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

      const nextMetadata =
        normalizedFee === null
          ? (() => {
              const { marketplaceFeeBps: _ignored, ...rest } = existingMetadata;
              return rest;
            })()
          : {
              ...existingMetadata,
              marketplaceFeeBps: normalizedFee,
            };

      await db
        .update(agents)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(agents.id, groupId));

      revalidatePath(`/groups/${groupId}`);
      revalidatePath(`/groups/${groupId}/settings`);

      return { success: true } as GroupAdminResult;
    },
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "marketplaceFeeBps", marketplaceFeeBps: normalizedFee },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to update marketplace fee settings." };
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
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupJoinSettings",
      actorId,
      targetAgentId: groupId,
      payload: { joinSettings },
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
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }
  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupMembershipPlans",
      actorId,
      targetAgentId: groupId,
      payload: { membershipPlans },
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

/**
 * Update per-tab visibility settings for a group's public page.
 *
 * Auth requirement: caller must be authenticated and authorized as a group admin.
 * Each tab key is validated against the canonical set; unknown keys are dropped.
 * Visibility values are restricted to the allow-list to prevent injection.
 *
 * @param {string} groupId - UUID of the target group.
 * @param {TabVisibilitySettings} tabVisibility - Map of tab key to visibility level.
 * @returns {Promise<GroupAdminResult>} Success flag or user-facing error message.
 */
export async function updateGroupTabVisibility(
  groupId: string,
  tabVisibility: TabVisibilitySettings,
): Promise<GroupAdminResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "updateGroupTabVisibility",
      actorId,
      targetAgentId: groupId,
      payload: { tabVisibility },
    },
    async () => {
      if (!(await isGroupAdmin(actorId, groupId))) {
        return { success: false, error: "Only group admins can edit tab visibility settings." };
      }

      const normalized = normalizeTabVisibility(tabVisibility);

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

      const nextMetadata = {
        ...existingMetadata,
        tabVisibility: normalized,
      };

      await db
        .update(agents)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(agents.id, groupId));

      revalidatePath(`/groups/${groupId}`);
      revalidatePath(`/groups/${groupId}/settings`);

      return { success: true } as GroupAdminResult;
    },
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAdminResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { setting: "tabVisibility" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to update tab visibility settings." };
}

// =============================================================================
// Internal helpers
// =============================================================================

const VALID_TAB_VISIBILITY_LEVELS: TabVisibilityLevel[] = ["public", "members", "admin", "hidden"];
const VALID_TAB_KEYS = new Set<string>(ALL_GROUP_TAB_KEYS);

/**
 * Normalize raw tab visibility input: drop unknown keys and invalid levels.
 *
 * Config/settings tabs are admin-only surfaces, so any stored level for them
 * is coerced to {@link CONFIG_TAB_LOCKED_VISIBILITY} regardless of the input —
 * the editor renders them locked, but this guards against tampered payloads.
 */
function normalizeTabVisibility(raw: unknown): TabVisibilitySettings {
  if (!raw || typeof raw !== "object") return {};
  const result: TabVisibilitySettings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_TAB_KEYS.has(key)) continue;
    if (isConfigTab(key)) {
      result[key] = CONFIG_TAB_LOCKED_VISIBILITY;
      continue;
    }
    if (typeof value !== "string" || !VALID_TAB_VISIBILITY_LEVELS.includes(value as TabVisibilityLevel)) continue;
    result[key as keyof TabVisibilitySettings] = value as TabVisibilityLevel;
  }
  return result;
}

/**
 * Parse stored tab visibility from metadata, returning safe defaults for missing/malformed data.
 */
function parseTabVisibility(raw: unknown): TabVisibilitySettings {
  return normalizeTabVisibility(raw);
}

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

/**
 * Check whether a user has any active membership in a group.
 *
 * Broader than {@link isGroupAdmin}: accepts admin, moderator, and plain
 * member roles. Used by federation import paths to gate which actors are
 * allowed to project resources into this group's local surface — without
 * this gate any trusted peer could federate events claiming arbitrary
 * actors as members of arbitrary local groups.
 *
 * Membership sources, in order:
 * - active `ledger` row with `verb in (belong, join)` and any role;
 * - group `metadata.creatorId === userId`;
 * - group `metadata.adminIds` includes `userId`;
 * - group `metadata.memberIds` includes `userId` (legacy / non-ledger groups).
 *
 * @param userId  Local agent id of the candidate member.
 * @param groupId Local agent id of the target group.
 * @returns true if the user has any positive-permission relationship to the group.
 */
export async function isGroupMember(
  userId: string,
  groupId: string,
): Promise<boolean> {
  const now = new Date();
  const [memberEntry] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > ${now}`),
      ),
    )
    .limit(1);

  if (memberEntry) return true;

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
    if (metadata.adminIds.some((id: unknown) => typeof id === "string" && id === userId)) {
      return true;
    }
  }

  if (Array.isArray(metadata.memberIds)) {
    if (metadata.memberIds.some((id: unknown) => typeof id === "string" && id === userId)) {
      return true;
    }
  }

  return false;
}

/**
 * Replace the admin roster for a group.
 *
 * Writes `metadata.adminIds` as the new canonical list of admin user IDs.
 * The caller must already be a group admin (checked via `isGroupAdmin`, which
 * covers ledger-based and metadata-based admin records).
 *
 * Each submitted id is upsert-tolerant: any UUID in the list is allowed,
 * whether the corresponding agent row is local-credentialled, remote-only
 * (mirrored), or a federated visitor that hasn't logged in yet. This is
 * intentional — the admin roster is a policy list, not a membership list,
 * and federated users can hold admin roles without a local credential.
 *
 * @param groupId — UUID of the group to update.
 * @param adminIds — complete replacement list of admin user IDs.
 */
export async function setGroupAdmins(
  groupId: string,
  adminIds: string[],
): Promise<GroupAdminResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!Array.isArray(adminIds)) {
    return { success: false, error: "`adminIds` must be an array." };
  }

  // Sanitize: keep only well-formed UUIDs, de-duplicate, cap at 100 to avoid
  // pathologically large metadata writes.
  const cleaned = Array.from(
    new Set(adminIds.filter((id) => typeof id === "string" && UUID_RE.test(id))),
  ).slice(0, 100);

  if (!(await isGroupAdmin(actorId, groupId))) {
    return {
      success: false,
      error: "Only group admins can manage the admin roster.",
    };
  }

  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);
  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const existingMeta =
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};

  // Preserve creatorId — creators remain implicit admins even when the list
  // is shrunk. This prevents a lock-out if an admin accidentally removes
  // themselves without setting a successor.
  const creatorId = typeof existingMeta.creatorId === "string" ? existingMeta.creatorId : null;
  const nextAdminIds = creatorId && !cleaned.includes(creatorId)
    ? [creatorId, ...cleaned]
    : cleaned;

  const nextMeta = { ...existingMeta, adminIds: nextAdminIds };

  await db
    .update(agents)
    .set({ metadata: nextMeta, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  await emitDomainEvent({
    eventType: EVENT_TYPES.GROUP_SETTINGS_UPDATED,
    entityType: "agent",
    entityId: groupId,
    actorId,
    payload: { setting: "adminIds", action: "replace", count: nextAdminIds.length },
  }).catch(() => {});

  revalidatePath(`/groups/${groupId}`);
  return { success: true };
}
