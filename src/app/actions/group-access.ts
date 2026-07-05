"use server";

/**
 * @file Server actions for password-protected group membership access.
 * @description Exports actions to challenge access with a password, renew membership,
 * revoke membership, and check active membership state. Membership is represented by
 * ledger `join`/`leave` entries with expiration semantics.
 * @dependencies `@/auth`, `@/db`, `@/db/schema`, `@/lib/rate-limit`,
 * `@node-rs/bcrypt`, `next/headers`, `drizzle-orm`
 */

import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { eq, and, or, sql, isNull } from "drizzle-orm";
import { verify } from "@node-rs/bcrypt";
import { headers } from "next/headers";
import { rateLimit } from "@/lib/rate-limit";
import { JoinType, type GroupJoinSettings, type JoinRequest } from "@/lib/types";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation";
import { getAuthenticatedActorId } from "@/lib/server-auth";
import { isGroupAdmin } from "@/app/actions/group-admin";

// =============================================================================
// Constants
// =============================================================================

const MEMBERSHIP_DURATION_DAYS = 30;
const MEMBERSHIP_DURATION_MS = MEMBERSHIP_DURATION_DAYS * 24 * 60 * 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Rate limit constants — relaxed in development for testing
const isDev = process.env.NODE_ENV !== "production";
const CHALLENGE_RATE_LIMIT = isDev ? 50 : 5;
const CHALLENGE_WINDOW_MS = isDev ? 60_000 : 15 * 60 * 1000; // 1min dev, 15min prod

// =============================================================================
// Result types
// =============================================================================

type GroupAccessResult = {
  success: boolean;
  error?: string;
  membershipId?: string;
  expiresAt?: string;
  status?: "joined" | "requested";
  requestId?: string;
};

type MembershipCheckResult = {
  isMember: boolean;
  membershipId?: string;
  role?: string;
  expiresAt?: string;
};

type JoinRuntimeResult = {
  joined: boolean;
  pendingRequestId?: string;
};

type JoinRequestRecord = JoinRequest & {
  userName?: string;
  username?: string;
  avatar?: string;
};

type JoinRequestListResult = {
  success: boolean;
  error?: string;
  requests?: JoinRequestRecord[];
  /** The group's configured join questions, so the admin UI can label answers. */
  questions?: GroupJoinSettings["questions"];
};

async function requireActorId(): Promise<string | null> {
  return getAuthenticatedActorId();
}

// =============================================================================
// Server actions
// =============================================================================

/**
 * Validate a group's password challenge and grant temporary membership.
 *
 * Auth requirement: caller must be authenticated.
 * Rate limiting: keyed by IP + user ID + group ID with stricter production limits.
 * Error handling pattern: returns user-safe errors for auth, validation, not-found, and throttling.
 *
 * @param {string} groupId - UUID of the password-protected group.
 * @param {string} password - Candidate plaintext password submitted by the user.
 * @returns {Promise<GroupAccessResult>} Membership metadata when successful, otherwise an error.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await challengeGroupAccess(groupId, "group-secret");
 * if (result.success) console.log(result.expiresAt);
 */
export async function challengeGroupAccess(
  groupId: string,
  password: string
): Promise<GroupAccessResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!password || password.length === 0) {
    return { success: false, error: "Password is required." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "challengeGroupAccess",
      actorId,
      targetAgentId: groupId,
      payload: { password },
    },
    async () => {
  // Throttle brute-force attempts by combining network and account identity in the key.
  const headersList = await headers();
  const ip =
    headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headersList.get("x-real-ip") ??
    "unknown";
  const rateLimitKey = `group-access:${ip}:${actorId}:${groupId}`;
  const limiter = await rateLimit(rateLimitKey, CHALLENGE_RATE_LIMIT, CHALLENGE_WINDOW_MS);
  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many attempts. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  // Deleted groups are excluded to prevent access against soft-deleted records.
  const [group] = await db
    .select({
      id: agents.id,
      groupPasswordHash: agents.groupPasswordHash,
      name: agents.name,
    })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  if (!group.groupPasswordHash) {
    return { success: false, error: "Group does not require password access." };
  }

  // Idempotency: avoid issuing duplicate active memberships for repeated successful calls.
  const existingMembership = await findActiveMembership(actorId, groupId);
  if (existingMembership) {
    return {
      success: true,
      membershipId: existingMembership.id,
      expiresAt: existingMembership.expiresAt?.toISOString(),
    };
  }

  // Compare plaintext against stored bcrypt hash; plaintext is never persisted.
  const valid = await verify(password, group.groupPasswordHash);
  if (!valid) {
    return { success: false, error: "Invalid group password." };
  }

  // Membership grants are intentionally time-bounded to enforce periodic re-validation.
  const expiresAt = new Date(Date.now() + MEMBERSHIP_DURATION_MS);

  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "join",
      subjectId: actorId,
      objectId: groupId,
      objectType: "agent",
      role: "member",
      isActive: true,
      expiresAt,
      metadata: {
        grantType: "password_challenge",
        grantedAt: new Date().toISOString(),
        interactionType: "membership",
        targetId: groupId,
        targetType: "group",
      },
    } as NewLedgerEntry)
    .returning({ id: ledger.id });

  return {
    success: true,
    membershipId: entry.id,
    expiresAt: expiresAt.toISOString(),
  } as GroupAccessResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAccessResult;
    if (data.success && data.membershipId) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_MEMBER_JOINED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { grantType: "password_challenge" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to challenge group access." };
}

/**
 * Revoke an active membership for a user in a password-protected group.
 *
 * Auth requirement: caller must be authenticated and be either the target member or group admin.
 * Rate limiting: no dedicated limiter; relies on authorization and low-frequency admin/member actions.
 * Error handling pattern: returns explicit authorization and validation failures.
 *
 * @param {string} groupId - UUID of the target group.
 * @param {string} memberId - UUID of the member whose access should be revoked.
 * @returns {Promise<GroupAccessResult>} Success flag or user-facing error message.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await revokeGroupMembership(groupId, memberId);
 * if (!result.success) console.error(result.error);
 */
export async function revokeGroupMembership(
  groupId: string,
  memberId: string
): Promise<GroupAccessResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!memberId || !UUID_RE.test(memberId)) {
    return { success: false, error: "Invalid member identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "revokeGroupMembership",
      actorId,
      targetAgentId: groupId,
      payload: { memberId },
    },
    async () => {
  // Only the member themselves or an admin of the group can revoke
  const isAdmin = await isGroupAdmin(actorId, groupId);
  if (actorId !== memberId && !isAdmin) {
    return { success: false, error: "Not authorized to revoke this membership." };
  }

  // Expire every active membership grant so no stale access remains valid.
  // Both `join` (current) and legacy `belong` rows count as membership by every
  // predicate (isGroupMember / member counts / isGroupAdmin), so revoke MUST
  // expire both verbs — expiring only `join` would leave a `belong`-backed
  // member fully active despite a "revoked" UI state (GRP-SEC-005).
  await db.execute(sql`
    UPDATE ledger
    SET is_active = false, expires_at = NOW()
    WHERE subject_id = ${memberId}
      AND object_id = ${groupId}
      AND verb IN ('join', 'belong')
      AND is_active = true
  `);

  // Write an immutable audit event that captures actor and affected member.
  await db.insert(ledger).values({
    verb: "leave",
    subjectId: actorId,
    objectId: groupId,
    objectType: "agent",
    isActive: true,
    metadata: {
      revokedMember: memberId,
      revokedBy: actorId,
      interactionType: "membership_revocation",
    },
  } as NewLedgerEntry);

  return { success: true } as GroupAccessResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAccessResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_MEMBER_LEFT,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { revokedMember: memberId },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to revoke membership." };
}

/**
 * Renew the caller's membership window using prior password-grant proof.
 *
 * Auth requirement: caller must be authenticated.
 * Rate limiting: no dedicated limiter for renewal flow.
 * Business rule: prior `password_challenge` grant is treated as reusable proof, so password
 * is not requested again during renewal.
 * Error handling pattern: returns structured errors for missing prior grants and invalid IDs.
 *
 * @param {string} groupId - UUID of the target group.
 * @returns {Promise<GroupAccessResult>} New membership expiration and identifier on success.
 * @throws {never} This function returns structured errors instead of throwing on expected failures.
 *
 * @example
 * const result = await renewGroupMembership(groupId);
 * if (result.success) console.log(`Renewed until ${result.expiresAt}`);
 */
export async function renewGroupMembership(
  groupId: string
): Promise<GroupAccessResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "renewGroupMembership",
      actorId,
      targetAgentId: groupId,
      payload: { groupId },
    },
    async () => {
  // Renewal is only allowed if a password challenge succeeded at least once historically.
  const [priorMembership] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.objectId, groupId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'grantType' = 'password_challenge'`
      )
    )
    .limit(1);

  if (!priorMembership) {
    return {
      success: false,
      error: "No prior membership found. Please use the group password to join.",
    };
  }

  // Keep a single active join grant by closing old active rows first.
  await db.execute(sql`
    UPDATE ledger
    SET is_active = false
    WHERE subject_id = ${actorId}
      AND object_id = ${groupId}
      AND verb = 'join'
      AND is_active = true
  `);

  // Create new membership with fresh expiration
  const expiresAt = new Date(Date.now() + MEMBERSHIP_DURATION_MS);

  const [entry] = await db
    .insert(ledger)
    .values({
      verb: "join",
      subjectId: actorId,
      objectId: groupId,
      objectType: "agent",
      role: "member",
      isActive: true,
      expiresAt,
      metadata: {
        grantType: "password_challenge",
        grantedAt: new Date().toISOString(),
        renewedFrom: priorMembership.id,
        interactionType: "membership",
        targetId: groupId,
        targetType: "group",
      },
    } as NewLedgerEntry)
    .returning({ id: ledger.id });

  return {
    success: true,
    membershipId: entry.id,
    expiresAt: expiresAt.toISOString(),
  } as GroupAccessResult;
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAccessResult;
    if (data.success) {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_MEMBER_JOINED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { grantType: "renewal" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to renew membership." };
}

/**
 * Check whether the authenticated caller currently has active group membership.
 *
 * Auth requirement: anonymous callers are treated as non-members.
 * Rate limiting: no limiter; this is a read-only membership probe.
 * Error handling pattern: invalid input or auth absence resolve to `{ isMember: false }`.
 *
 * @param {string} groupId - UUID of the target group.
 * @returns {Promise<MembershipCheckResult>} Membership state and details when active.
 * @throws {never} This function returns non-member states instead of throwing for expected failures.
 *
 * @example
 * const membership = await checkGroupMembership(groupId);
 * if (membership.isMember) console.log(membership.role);
 */
export async function checkGroupMembership(
  groupId: string
): Promise<MembershipCheckResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { isMember: false };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { isMember: false };
  }

  const membership = await findActiveMembership(actorId, groupId);
  if (!membership) {
    return { isMember: false };
  }

  return {
    isMember: true,
    membershipId: membership.id,
    role: membership.role ?? "member",
    expiresAt: membership.expiresAt?.toISOString(),
  };
}

export async function fetchGroupJoinRuntime(
  groupId: string
): Promise<JoinRuntimeResult> {
  const membership = await checkGroupMembership(groupId);
  if (membership.isMember) {
    return { joined: true };
  }

  const actorId = await requireActorId();
  if (!actorId || !groupId || !UUID_RE.test(groupId)) {
    return { joined: false };
  }

  const [request] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.objectId, groupId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'interactionType' = 'membership_request'`,
        sql`COALESCE(${ledger.metadata}->>'reviewStatus', 'pending') = 'pending'`
      )
    )
    .limit(1);

  return {
    joined: false,
    pendingRequestId: request?.id,
  };
}

export async function requestGroupMembership(
  groupId: string,
  options?: {
    answers?: { questionId: string; answer: string }[];
    password?: string;
    inviteToken?: string;
  }
): Promise<GroupAccessResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "requestGroupMembership",
      actorId,
      targetAgentId: groupId,
      payload: { options },
    },
    async () => applyMembershipRequestForActor(actorId, groupId, options)
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as GroupAccessResult;
    if (data.success && data.status === "joined") {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_MEMBER_JOINED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { grantType: "membership_request" },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to request membership." };
}

/**
 * Approval-aware membership-request core, decoupled from session auth so it can
 * be invoked by both the session-based `requestGroupMembership` action above and
 * the federation mutations route (which resolves its actor from a signed peer
 * assertion, not a NextAuth session, and therefore cannot use `requireActorId`).
 * Honors the group's joinSettings: when approval is required it inserts an
 * inactive pending request row (invisible to every membership predicate);
 * otherwise it inserts an active membership grant. Invite/password are
 * re-validated here regardless of caller, closing the federation back-door that
 * previously let remote joins bypass the approval queue via toggleJoinGroup.
 */
export async function applyMembershipRequestForActor(
  actorId: string,
  groupId: string,
  options?: {
    answers?: { questionId: string; answer: string }[];
    password?: string;
    inviteToken?: string;
  }
): Promise<GroupAccessResult> {
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const [group] = await db
    .select({
      id: agents.id,
      metadata: agents.metadata,
      groupPasswordHash: agents.groupPasswordHash,
    })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const existingMembership = await findActiveMembership(actorId, groupId);
  if (existingMembership) {
    return {
      success: true,
      status: "joined" as const,
      membershipId: existingMembership.id,
      expiresAt: existingMembership.expiresAt?.toISOString(),
    };
  }

  const metadata =
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
  const rawJoin = metadata.joinSettings as Partial<GroupJoinSettings> | undefined;
  const joinSettings: GroupJoinSettings = {
    joinType: Object.values(JoinType).includes(rawJoin?.joinType as JoinType)
      ? (rawJoin?.joinType as JoinType)
      : JoinType.Public,
    questions: Array.isArray(rawJoin?.questions) ? (rawJoin.questions as GroupJoinSettings["questions"]) : [],
    approvalRequired: Boolean(rawJoin?.approvalRequired),
    passwordRequired: Boolean(rawJoin?.passwordRequired),
    inviteLink: typeof rawJoin?.inviteLink === "string" ? rawJoin.inviteLink : undefined,
    applicationInstructions:
      typeof rawJoin?.applicationInstructions === "string" ? rawJoin.applicationInstructions : undefined,
    visibility: rawJoin?.visibility === "hidden" ? "hidden" : "public",
    requireActiveSubscription: Boolean(rawJoin?.requireActiveSubscription),
  };

  if (
    (joinSettings.joinType === JoinType.InviteOnly || joinSettings.joinType === JoinType.InviteAndApply) &&
    !isInviteSatisfied(joinSettings.inviteLink, options?.inviteToken)
  ) {
    return { success: false, error: "This group requires a valid invite link." };
  }

  if ((joinSettings.passwordRequired || Boolean(group.groupPasswordHash)) && group.groupPasswordHash) {
    if (!options?.password) {
      return { success: false, error: "Group password is required." };
    }

    const valid = await verify(options.password, group.groupPasswordHash);
    if (!valid) {
      return { success: false, error: "Invalid group password." };
    }
  }

  // Subscription-gated groups (B4): joining requires an active/trialing paid
  // membership subscription. Subscribing itself grants membership via
  // grantGroupMembership (which bypasses this path), so this gate only blocks
  // the plain join/apply route. Admins are exempt so they can always manage.
  if (joinSettings.requireActiveSubscription) {
    const { getActiveGroupSubscriptionPlanId } = await import("@/lib/group-subscriptions");
    const activePlanId = await getActiveGroupSubscriptionPlanId(actorId, groupId);
    if (!activePlanId) {
      const admin = await isGroupAdmin(actorId, groupId);
      if (!admin) {
        return {
          success: false,
          error: "This group requires an active membership subscription. Please subscribe to join.",
        };
      }
    }
  }

  const requiresApproval =
    joinSettings.joinType === JoinType.ApprovalRequired ||
    joinSettings.joinType === JoinType.InviteAndApply ||
    Boolean(joinSettings.approvalRequired);

  if (!requiresApproval) {
    const [entry] = await db
      .insert(ledger)
      .values({
        verb: "join",
        subjectId: actorId,
        objectId: groupId,
        objectType: "agent",
        role: "member",
        isActive: true,
        metadata: {
          interactionType: "membership",
          targetId: groupId,
          targetType: "group",
          grantType: group.groupPasswordHash ? "password_join" : "self_join",
          grantedAt: new Date().toISOString(),
        },
      } as NewLedgerEntry)
      .returning({ id: ledger.id });

    return { success: true, status: "joined" as const, membershipId: entry.id };
  }

  const [existingRequest] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.objectId, groupId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'interactionType' = 'membership_request'`,
        sql`COALESCE(${ledger.metadata}->>'reviewStatus', 'pending') = 'pending'`
      )
    )
    .limit(1);

  if (existingRequest) {
    return { success: true, status: "requested" as const, requestId: existingRequest.id };
  }

  const answers = Array.isArray(options?.answers)
    ? options!.answers
        .filter((answer) => typeof answer.questionId === "string" && answer.questionId.trim().length > 0)
        .map((answer) => ({
          questionId: answer.questionId.trim(),
          answer: typeof answer.answer === "string" ? answer.answer.trim().slice(0, 2000) : "",
        }))
    : [];

  const [request] = await db
    .insert(ledger)
    .values({
      verb: "join",
      subjectId: actorId,
      objectId: groupId,
      objectType: "agent",
      // NOT a membership grant: pending applications must stay invisible to
      // every membership predicate (findActiveMembership, isGroupMember,
      // member counts), which match any active join/belong row. The request
      // lifecycle is tracked via metadata.reviewStatus instead.
      isActive: false,
      visibility: "private",
      metadata: {
        interactionType: "membership_request",
        targetId: groupId,
        targetType: "group",
        reviewStatus: "pending",
        answers,
        requestedAt: new Date().toISOString(),
      },
    } as NewLedgerEntry)
    .returning({ id: ledger.id });

  return { success: true, status: "requested" as const, requestId: request.id } as GroupAccessResult;
}

export async function fetchGroupJoinRequests(
  groupId: string
): Promise<JoinRequestListResult> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const isAdmin = await isGroupAdmin(actorId, groupId);
  if (!isAdmin) {
    return { success: false, error: "Only group admins can view join requests." };
  }

  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);
  const groupMeta =
    group?.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
  const rawJoinSettings = groupMeta.joinSettings as Partial<GroupJoinSettings> | undefined;
  const questions: GroupJoinSettings["questions"] = Array.isArray(rawJoinSettings?.questions)
    ? (rawJoinSettings!.questions as GroupJoinSettings["questions"])
    : [];

  const rows = await db
    .select({
      id: ledger.id,
      userId: ledger.subjectId,
      metadata: ledger.metadata,
      createdAt: ledger.timestamp,
      userName: agents.name,
      username: agents.xHandle,
      avatar: agents.image,
    })
    .from(ledger)
    .innerJoin(agents, eq(ledger.subjectId, agents.id))
    .where(
      and(
        eq(ledger.objectId, groupId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'interactionType' = 'membership_request'`
      )
    );

  const requests: JoinRequestRecord[] = rows.map((row) => {
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const reviewStatus = String(metadata.reviewStatus ?? "pending");
    return {
      id: row.id,
      userId: row.userId,
      groupId,
      status:
        reviewStatus === "approved" || reviewStatus === "rejected"
          ? reviewStatus
          : "pending",
      createdAt: row.createdAt.toISOString(),
      answers: Array.isArray(metadata.answers)
        ? (metadata.answers as JoinRequest["answers"])
        : [],
      adminNotes: typeof metadata.adminNotes === "string" ? metadata.adminNotes : undefined,
      reviewedBy: typeof metadata.reviewedBy === "string" ? metadata.reviewedBy : undefined,
      reviewedAt: typeof metadata.reviewedAt === "string" ? metadata.reviewedAt : undefined,
      userName: row.userName,
      username: row.username ?? undefined,
      avatar: row.avatar ?? undefined,
    };
  });

  return { success: true, requests, questions };
}

export async function reviewGroupJoinRequest(
  groupId: string,
  requestId: string,
  decision: "approved" | "rejected",
  adminNotes?: string
): Promise<{ success: boolean; error?: string }> {
  const actorId = await requireActorId();
  if (!actorId) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId) || !requestId || !UUID_RE.test(requestId)) {
    return { success: false, error: "Invalid request identifier." };
  }

  const facadeResult = await updateFacade.execute(
    {
      type: "reviewGroupJoinRequest",
      actorId,
      targetAgentId: groupId,
      payload: { requestId, decision, adminNotes },
    },
    async () => {
  const isAdmin = await isGroupAdmin(actorId, groupId);
  if (!isAdmin) {
    return { success: false, error: "Only group admins can review join requests." };
  }

  const [request] = await db
    .select({
      id: ledger.id,
      userId: ledger.subjectId,
      metadata: ledger.metadata,
      objectId: ledger.objectId,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.id, requestId),
        eq(ledger.objectId, groupId),
        eq(ledger.verb, "join"),
        sql`${ledger.metadata}->>'interactionType' = 'membership_request'`
      )
    )
    .limit(1);

  if (!request) {
    return { success: false, error: "Join request not found." };
  }

  const metadata =
    request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : {};
  const reviewedMetadata = {
    ...metadata,
    reviewStatus: decision,
    adminNotes: typeof adminNotes === "string" && adminNotes.trim().length > 0 ? adminNotes.trim().slice(0, 2000) : undefined,
    reviewedBy: actorId,
    reviewedAt: new Date().toISOString(),
  };

  await db
    .update(ledger)
    .set({
      isActive: false,
      expiresAt: new Date(),
      metadata: reviewedMetadata,
    })
    .where(eq(ledger.id, requestId));

  if (decision === "approved") {
    const existingMembership = await findActiveMembership(request.userId, groupId);
    if (!existingMembership) {
      await db.insert(ledger).values({
        verb: "join",
        subjectId: request.userId,
        objectId: groupId,
        objectType: "agent",
        role: "member",
        isActive: true,
        metadata: {
          interactionType: "membership",
          targetId: groupId,
          targetType: "group",
          grantType: "admin_approved_request",
          requestId,
          grantedAt: new Date().toISOString(),
          grantedBy: actorId,
        },
      } as NewLedgerEntry);
    }
  }

  return { success: true } as { success: boolean; error?: string };
    }
  );

  if (facadeResult.success && facadeResult.data) {
    const data = facadeResult.data as { success: boolean; error?: string };
    if (data.success && decision === "approved") {
      await emitDomainEvent({
        eventType: EVENT_TYPES.GROUP_MEMBER_JOINED,
        entityType: "agent",
        entityId: groupId,
        actorId,
        payload: { grantType: "admin_approved_request", requestId },
      }).catch(() => {});
    }
    return data;
  }

  return { success: false, error: facadeResult.error ?? "Failed to review join request." };
}

// =============================================================================
// Internal helpers
// =============================================================================

async function findActiveMembership(userId: string, groupId: string) {
  const now = new Date();
  const [membership] = await db
    .select({
      id: ledger.id,
      role: ledger.role,
      expiresAt: ledger.expiresAt,
    })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        // Both legacy `belong` and current `join` verbs count as active membership grants.
        or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > ${now}`)
      )
    )
    .limit(1);

  return membership ?? null;
}

function isInviteSatisfied(inviteLink?: string, inviteToken?: string): boolean {
  if (!inviteLink) return false;
  if (!inviteToken || inviteToken.trim().length === 0) return false;

  const normalizedInput = inviteToken.trim();
  if (normalizedInput === inviteLink) return true;

  try {
    const inviteUrl = new URL(inviteLink);
    const expected =
      inviteUrl.searchParams.get("invite") ??
      inviteUrl.searchParams.get("token") ??
      inviteUrl.pathname.split("/").filter(Boolean).at(-1);
    return expected === normalizedInput;
  } catch {
    return inviteLink === normalizedInput;
  }
}

