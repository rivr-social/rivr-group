/**
 * Relationship-based authorization and policy-management module.
 *
 * Purpose:
 * - Evaluates whether an actor can perform a verb on agent/resource targets.
 * - Supports direct grants, implied verbs, visibility, group membership, hierarchy,
 *   and ABAC policy conditions.
 * - Provides helper APIs for grant/revoke flows and permission-policy CRUD.
 *
 * Key exports:
 * - `check`, `listObjects`, `canView`, `canManage`, `canUse`
 * - `grantPermission`, `revokePermission`, `checkGroupAccess`
 * - `canViewPredicate`, `createPermissionPolicy`, `deletePermissionPolicy`
 * - `getPoliciesForTarget`, `attachPolicyToPredicate`
 * - `PermissionError`, `CheckResult`, `PermissionPolicyMetadata`
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for data access and typed records
 * - `drizzle-orm` query helpers (`eq`, `and`, `or`, `sql`, `isNull`, `inArray`)
 */

import { db } from "@/db";
import { agents, resources, ledger } from "@/db/schema";
import type { VerbType, VisibilityLevel, Resource, NewResource } from "@/db/schema";
import { eq, and, or, sql, isNull, inArray } from "drizzle-orm";

// =============================================================================
// Error types
// =============================================================================

/**
 * Domain-specific authorization error used for policy/role validation failures.
 */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

// =============================================================================
// ABAC Permission Policy Types
// =============================================================================

/**
 * An attribute condition that must be met for a policy to grant access.
 *
 * Operators:
 * - "equals":   actor's attribute value === condition value
 * - "contains": actor's attribute (array) contains the condition value
 * - "in":       actor's attribute value is in the condition value (array)
 * - "exists":   actor has the attribute key (value is ignored)
 */
export interface AttributeCondition {
  key: string;
  operator: "equals" | "contains" | "in" | "exists";
  value: string | string[];
}

/**
 * Structured metadata stored inside a resource of type `permission_policy`.
 *
 * A permission policy is a first-class object linked to the target it protects.
 * It specifies ABAC conditions: users whose attributes satisfy all/any conditions
 * are granted the listed actions on the linked target.
 */
export interface PermissionPolicyMetadata {
  /** The object this policy protects */
  targetId: string;
  /** Whether the target is an agent, resource, or ledger entry */
  targetType: "agent" | "resource" | "ledger";
  /** Actions this policy permits when conditions are met */
  allowedActions: VerbType[];
  /** Attribute conditions the actor must satisfy */
  conditions: AttributeCondition[];
  /** How to combine conditions: AND = all must match, OR = any must match */
  logicalOperator: "AND" | "OR";
  /** Optional: restrict policy to actors in this locale */
  localeScope?: string;
  /** Human-readable label for the policy */
  label?: string;
}

// =============================================================================
// Permission Schema — verb composition rules
// =============================================================================

/**
 * Verb implication graph used for transitive permission checks.
 * Configuration pattern: keys are stronger verbs, values are implied verbs.
 * `check()` and `listObjects()` both rely on this mapping for inheritance.
 */
const VERB_IMPLICATIONS: Partial<Record<VerbType, VerbType[]>> = {
  own: ["manage", "view", "update", "delete", "grant", "assign", "use", "rent", "share"],
  manage: ["view", "update", "delete", "grant", "assign", "use", "rent", "share"],
  grant: ["view"],
  share: ["view"],
};

/**
 * Membership role-to-verb matrix for grants delegated through groups.
 * Configuration pattern: when a user is group-member, they can only consume
 * group grants for verbs included in their role entry here.
 */
const ROLE_PERMISSIONS: Record<string, VerbType[]> = {
  admin: ["manage", "view", "update", "delete", "grant", "assign", "use", "rent", "share"],
  moderator: ["view", "update", "assign", "use", "rent"],
  member: ["view", "use", "rent"],
  viewer: ["view"],
};


/**
 * Verbs treated as read-only for visibility evaluation.
 * Configuration pattern: only verbs in this set can be granted by visibility
 * levels (`public`, `locale`, `members`) without explicit grant edges.
 */
const READ_VERBS = new Set<VerbType>(["view"]);

// =============================================================================
// Core check() function
// =============================================================================

export interface CheckResult {
  allowed: boolean;
  reason: string;
  /** The path through the graph that proved access (for audit/debug) */
  via?: string;
}

/**
 * Evaluates whether an actor can perform a verb on a target object.
 *
 * Evaluation order (short-circuits on first match):
 * 1. Owner/self check
 * 2. Direct grant edge
 * 3. Implied permission from stronger verbs
 * 4. Visibility-based read access
 * 5. Group membership grants
 * 6. Member visibility and hierarchy inheritance
 * 7. ABAC permission policies
 *
 * @param actorId - The requesting actor ID.
 * @param verb - Requested action verb to authorize.
 * @param targetId - Target object ID.
 * @param targetType - Target table family (`agent` or `resource`).
 * @returns Authorization decision with reason and optional proof path.
 * @throws {PermissionError} When a membership role in data is unknown and cannot be mapped.
 * @example
 * ```ts
 * const result = await check(userId, "view", resourceId, "resource");
 * if (!result.allowed) throw new Error(result.reason);
 * ```
 */
export async function check(
  actorId: string,
  verb: VerbType,
  targetId: string,
  targetType: "agent" | "resource"
): Promise<CheckResult> {
  const now = new Date();

  // Fetch the target object
  const target = targetType === "resource"
    ? await fetchResource(targetId)
    : await fetchAgent(targetId);

  if (!target) {
    return { allowed: false, reason: "target_not_found" };
  }

  // Cache locale overlap to avoid redundant DB queries within a single check() call.
  // checkLocaleOverlap may be called at step 4 (visibility) and step 5 (locale-scoped grants).
  let _localeOverlapCached: string | null | undefined;
  async function getLocaleOverlap(): Promise<string | null> {
    if (_localeOverlapCached === undefined) {
      _localeOverlapCached = await checkLocaleOverlap(actorId, target!, targetType);
    }
    return _localeOverlapCached;
  }

  // 1. Owner check
  if (targetType === "resource" && "ownerId" in target && target.ownerId === actorId) {
    return { allowed: true, reason: "owner", via: "direct_ownership" };
  }
  if (targetType === "agent" && target.id === actorId) {
    return { allowed: true, reason: "self", via: "self_access" };
  }

  // 2. Direct grant — active ledger entry with this verb on this target
  const directGrant = await findActiveEdge(actorId, verb, targetId, now);
  if (directGrant) {
    return { allowed: true, reason: "direct_grant", via: `ledger:${directGrant.id}` };
  }

  // 3. Verb implication — check if actor has a higher-level verb
  for (const [higherVerb, implied] of Object.entries(VERB_IMPLICATIONS)) {
    if (implied.includes(verb)) {
      const higherGrant = await findActiveEdge(actorId, higherVerb as VerbType, targetId, now);
      if (higherGrant) {
        return {
          allowed: true,
          reason: "implied_permission",
          via: `${higherVerb}→${verb} via ledger:${higherGrant.id}`,
        };
      }
    }
  }

  const targetMeta = (target as { metadata?: Record<string, unknown> }).metadata;
  const scopedUserIds = Array.isArray(targetMeta?.scopedUserIds) ? targetMeta.scopedUserIds as string[] : [];
  if (READ_VERBS.has(verb) && scopedUserIds.includes(actorId)) {
    return { allowed: true, reason: "scoped_user_visibility", via: `scoped_user:${actorId}` };
  }

  const scopedGroupIds = Array.isArray(targetMeta?.scopedGroupIds) ? targetMeta.scopedGroupIds as string[] : [];
  if (READ_VERBS.has(verb) && scopedGroupIds.length > 0) {
    for (const scopedGroupId of scopedGroupIds) {
      const membership = await findActiveMembership(actorId, scopedGroupId, now);
      if (membership) {
        return {
          allowed: true,
          reason: "scoped_group_visibility",
          via: `scoped_group:${scopedGroupId}`,
        };
      }
    }
  }

  // 4. Visibility check
  const visibility = (target as { visibility?: VisibilityLevel }).visibility || "private";

  if (visibility === "public" && READ_VERBS.has(verb)) {
    return { allowed: true, reason: "public_visibility", via: "visibility=public" };
  }

  if (visibility === "locale" && READ_VERBS.has(verb)) {
    // Check for strict locale scoping via scopedLocaleIds in metadata
    const scopedLocaleIds = Array.isArray(targetMeta?.scopedLocaleIds) ? targetMeta.scopedLocaleIds as string[] : [];

    if (scopedLocaleIds.length > 0 || scopedGroupIds.length > 0 || scopedUserIds.length > 0) {
      // Explicit scope fields are strict. If one was defined and no match occurred above,
      // do not fall through to broader locale/public checks.
      if (scopedLocaleIds.length === 0) {
        return { allowed: false, reason: "scoped_visibility_mismatch" };
      }
    }

    if (scopedLocaleIds.length > 0) {
      // Strict scoping: actor's pathIds must overlap with the explicit scopedLocaleIds
      const actor = await fetchAgent(actorId);
      if (actor) {
        const actorPaths = new Set(actor.pathIds ?? []);
        const matchedLocale = scopedLocaleIds.find(id => actorPaths.has(id));
        if (matchedLocale) {
          return { allowed: true, reason: "scoped_locale_visibility", via: `scoped_locale:${matchedLocale}` };
        }
      }
      // Strict scoping is set but no match — do NOT fall through to general locale overlap
    } else {
      // No explicit scoping — use existing general locale overlap check
      const localeMatch = await getLocaleOverlap();
      if (localeMatch) {
        return { allowed: true, reason: "locale_visibility", via: `shared_locale:${localeMatch}` };
      }
    }
  }

  // 5. Group membership grant
  // Find groups that have a grant on this target
  const groupGrants = await findGroupGrantsOnTarget(targetId, verb, now);
  for (const grant of groupGrants) {
    // Check if actor is a member of this group
    const membership = await findActiveMembership(actorId, grant.subjectId, now);
    if (membership) {
      // Check role-based permissions if the grant has a scope
      const grantScope = (grant.metadata as Record<string, unknown>)?.scope as string | undefined;
      if (grantScope === "locale") {
        // Scoped grant: actor must also share locale with the target
        const localeMatch = await getLocaleOverlap();
        if (!localeMatch) continue;
      }

      // Check if membership role allows this verb
      const memberRole = membership.role || "member";
      const rolePerms = ROLE_PERMISSIONS[memberRole];
      if (!rolePerms) {
        throw new PermissionError(`Unknown role: "${memberRole}"`);
      }
      if (rolePerms.includes(verb)) {
        return {
          allowed: true,
          reason: "group_membership_grant",
          via: `member(${membership.role})→group:${grant.subjectId}→grant:${grant.id}`,
        };
      }
    }
  }

  // 6. Visibility=members check for group-owned resources
  if (visibility === "members" && READ_VERBS.has(verb)) {
    const memberAccess = await checkMemberVisibility(actorId, target, targetType, now);
    if (memberAccess) {
      return { allowed: true, reason: "member_visibility", via: memberAccess };
    }
  }

  // 7. Hidden visibility: non-discoverable unless allowed by earlier ownership/grant checks.
  if (visibility === "hidden") {
    return { allowed: false, reason: "hidden_visibility" };
  }

  // 8. Hierarchy inheritance — actor manages a parent of the target's owner
  const hierarchyAccess = await checkHierarchyInheritance(actorId, target, targetType, verb, now);
  if (hierarchyAccess) {
    return { allowed: true, reason: "hierarchy_inheritance", via: hierarchyAccess };
  }

  // 9. ABAC policy evaluation — check permission policy objects linked to this target
  const policyAccess = await evaluateAbacPolicies(actorId, targetId, targetType, verb);
  if (policyAccess) {
    return { allowed: true, reason: "abac_policy", via: policyAccess };
  }

  return { allowed: false, reason: "no_permission" };
}

// =============================================================================
// Convenience wrappers
// =============================================================================

/**
 * Convenience wrapper for `check(..., "view", ...)`.
 *
 * @param actorId - Requesting actor ID.
 * @param targetId - Target object ID.
 * @param targetType - Target family (`agent` or `resource`).
 * @returns Permission decision for view access.
 * @throws {PermissionError} Propagates from `check` when role configuration is invalid.
 * @example
 * ```ts
 * const canSee = await canView(actorId, targetId, "resource");
 * ```
 */
export async function canView(actorId: string, targetId: string, targetType: "agent" | "resource") {
  return check(actorId, "view", targetId, targetType);
}

/**
 * Convenience wrapper for `check(..., "manage", ...)`.
 *
 * @param actorId - Requesting actor ID.
 * @param targetId - Target object ID.
 * @param targetType - Target family (`agent` or `resource`).
 * @returns Permission decision for manage access.
 * @throws {PermissionError} Propagates from `check` when role configuration is invalid.
 * @example
 * ```ts
 * const canAdminister = await canManage(actorId, targetId, "agent");
 * ```
 */
export async function canManage(actorId: string, targetId: string, targetType: "agent" | "resource") {
  return check(actorId, "manage", targetId, targetType);
}

/**
 * Convenience wrapper for `check(..., "use", ..., "resource")`.
 *
 * @param actorId - Requesting actor ID.
 * @param resourceId - Resource ID being used/rented.
 * @returns Permission decision for use access.
 * @throws {PermissionError} Propagates from `check` when role configuration is invalid.
 * @example
 * ```ts
 * const canConsume = await canUse(actorId, resourceId);
 * ```
 */
export async function canUse(actorId: string, resourceId: string) {
  return check(actorId, "use", resourceId, "resource");
}

/**
 * Check if an actor has an active, non-expired membership in a group.
 * Looks for active 'belong' or 'join' ledger entries with a valid expiration.
 *
 * @param actorId - Actor whose membership is being checked.
 * @param groupId - Group/organization ID to test membership against.
 * @param now - Evaluation timestamp used for expiry checks.
 * @returns Membership status plus role/edge metadata when active.
 * @throws {Error} Propagates database query errors.
 * @example
 * ```ts
 * const membership = await isGroupMember(userId, groupId);
 * if (membership.isMember) console.log(membership.role);
 * ```
 */
export async function isGroupMember(
  actorId: string,
  groupId: string,
  now: Date = new Date()
): Promise<{ isMember: boolean; role?: string; membershipId?: string; expiresAt?: Date | null }> {
  const membership = await findActiveMembership(actorId, groupId, now);
  if (!membership) {
    return { isMember: false };
  }
  return {
    isMember: true,
    role: membership.role ?? "member",
    membershipId: membership.id,
    expiresAt: membership.expiresAt,
  };
}

// =============================================================================
// listObjects — reverse query: "What can user X do with permission Y?"
// =============================================================================

/**
 * List all objects a user can access with a given verb.
 * Answers: "What can user X do with permission Y?"
 *
 * Evaluation sources (combined and deduplicated):
 * 1. Direct grants — active ledger entries where subject=actor, verb matches
 * 2. Verb implication — actor has a higher-level verb (own → manage → view)
 * 3. Owned resources — if targetType="resource", resources where ownerId=actor
 * 4. Group membership grants — groups actor belongs to that have grants on targets
 * 5. Visibility — public targets for view verb, locale-matching for locale visibility
 *
 * @param actorId - Actor whose reachable objects are requested.
 * @param verb - Verb that must be authorized on each returned object.
 * @param targetType - Object family to return IDs for.
 * @param options - Pagination options (`limit`, `offset`).
 * @returns Deduplicated object IDs slice for the requested page.
 * @throws {PermissionError} When an unknown membership role is encountered.
 * @example
 * ```ts
 * const viewableResources = await listObjects(userId, "view", "resource", { limit: 50 });
 * ```
 */
export async function listObjects(
  actorId: string,
  verb: VerbType,
  targetType: "agent" | "resource",
  options: { limit?: number; offset?: number } = {}
): Promise<string[]> {
  const { limit = 100, offset = 0 } = options;
  const now = new Date();
  const objectIds = new Set<string>();

  // 1. Direct grants — active ledger entries granting this verb directly to the actor
  const directGrants = await db.select({ objectId: ledger.objectId })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.verb, verb),
        eq(ledger.isActive, true),
        or(
          isNull(ledger.expiresAt),
          sql`${ledger.expiresAt} > ${now}`
        )
      )
    );

  for (const grant of directGrants) {
    if (grant.objectId) objectIds.add(grant.objectId);
  }

  // 2. Verb implication — check for higher-level verbs that imply this one
  const impliedByVerbs: VerbType[] = [];
  for (const [higherVerb, implied] of Object.entries(VERB_IMPLICATIONS)) {
    if (implied.includes(verb)) {
      impliedByVerbs.push(higherVerb as VerbType);
    }
  }

  if (impliedByVerbs.length > 0) {
    const impliedGrants = await db.select({ objectId: ledger.objectId })
      .from(ledger)
      .where(
        and(
          eq(ledger.subjectId, actorId),
          inArray(ledger.verb, impliedByVerbs),
          eq(ledger.isActive, true),
          or(
            isNull(ledger.expiresAt),
            sql`${ledger.expiresAt} > ${now}`
          )
        )
      );

    for (const grant of impliedGrants) {
      if (grant.objectId) objectIds.add(grant.objectId);
    }
  }

  // 3. Owned resources — if targetType="resource", add all resources owned by actor
  if (targetType === "resource") {
    const ownedResources = await db.select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, actorId),
          isNull(resources.deletedAt)
        )
      );

    for (const res of ownedResources) {
      objectIds.add(res.id);
    }
  }

  // Self-access for agents
  if (targetType === "agent") {
    objectIds.add(actorId);
  }

  // 4. Group membership grants — find groups actor belongs to, then find grants from those groups
  const memberships = await db.select({ objectId: ledger.objectId })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.isActive, true),
        or(
          eq(ledger.verb, "belong"),
          eq(ledger.verb, "join")
        ),
        or(
          isNull(ledger.expiresAt),
          sql`${ledger.expiresAt} > ${now}`
        )
      )
    );

  const groupIds = memberships
    .map((m) => m.objectId)
    .filter((id): id is string => id !== null);

  if (groupIds.length > 0) {
    // Find what each group has granted access to
    for (const groupId of groupIds) {
      // Get the membership role to determine what verbs the actor can use
      const [membership] = await db.select({ role: ledger.role })
        .from(ledger)
        .where(
          and(
            eq(ledger.subjectId, actorId),
            eq(ledger.objectId, groupId),
            eq(ledger.isActive, true),
            or(
              eq(ledger.verb, "belong"),
              eq(ledger.verb, "join")
            ),
            or(
              isNull(ledger.expiresAt),
              sql`${ledger.expiresAt} > ${now}`
            )
          )
        )
        .limit(1);

      const memberRole = membership?.role || "member";
      const rolePerms = ROLE_PERMISSIONS[memberRole];
      if (!rolePerms) {
        throw new PermissionError(`Unknown role: "${memberRole}"`);
      }
      if (!rolePerms.includes(verb)) continue;

      // Find grants from this group.
      // Security note: the action verb is read from metadata->>'action', so callers
      // only receive objects for the exact requested verb.
      const groupGrants = await db.select({ objectId: ledger.objectId })
        .from(ledger)
        .where(
          and(
            eq(ledger.verb, "grant"),
            eq(ledger.subjectId, groupId),
            eq(ledger.isActive, true),
            sql`${ledger.metadata}->>'action' = ${verb}`,
            or(
              isNull(ledger.expiresAt),
              sql`${ledger.expiresAt} > ${now}`
            )
          )
        );

      for (const grant of groupGrants) {
        if (grant.objectId) objectIds.add(grant.objectId);
      }

      // For resources owned by this group, the member gets access based on role
      if (targetType === "resource") {
        const groupResources = await db.select({ id: resources.id })
          .from(resources)
          .where(
            and(
              eq(resources.ownerId, groupId),
              isNull(resources.deletedAt)
            )
          );

        for (const res of groupResources) {
          objectIds.add(res.id);
        }
      }
    }
  }

  // 5. Visibility — public targets for view verb
  if (READ_VERBS.has(verb)) {
    const LIST_OBJECTS_VISIBILITY_LIMIT = 500;

    if (targetType === "resource") {
      const publicResources = await db.select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.visibility, "public"),
            isNull(resources.deletedAt)
          )
        )
        .limit(LIST_OBJECTS_VISIBILITY_LIMIT);

      for (const res of publicResources) {
        objectIds.add(res.id);
      }

      // Locale-matching visibility
      const actor = await fetchAgent(actorId);
      if (actor?.pathIds && actor.pathIds.length > 0) {
        const localeResources = await db.select({
          id: resources.id,
          ownerId: resources.ownerId,
        })
          .from(resources)
          .where(
            and(
              eq(resources.visibility, "locale"),
              isNull(resources.deletedAt)
            )
          )
          .limit(LIST_OBJECTS_VISIBILITY_LIMIT);

        const actorPathSet = new Set(actor.pathIds);
        for (const res of localeResources) {
          const owner = await fetchAgent(res.ownerId);
          if (owner?.pathIds) {
            for (const pathId of owner.pathIds) {
              if (actorPathSet.has(pathId)) {
                objectIds.add(res.id);
                break;
              }
            }
          }
        }
      }
    }

    if (targetType === "agent") {
      const publicAgents = await db.select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.visibility, "public"),
            isNull(agents.deletedAt)
          )
        )
        .limit(LIST_OBJECTS_VISIBILITY_LIMIT);

      for (const agent of publicAgents) {
        objectIds.add(agent.id);
      }

      // Locale-matching for agents
      const actor = await fetchAgent(actorId);
      if (actor?.pathIds && actor.pathIds.length > 0) {
        const localeAgents = await db.select({
          id: agents.id,
          pathIds: agents.pathIds,
        })
          .from(agents)
          .where(
            and(
              eq(agents.visibility, "locale"),
              isNull(agents.deletedAt)
            )
          )
          .limit(LIST_OBJECTS_VISIBILITY_LIMIT);

        const actorPathSet = new Set(actor.pathIds);
        for (const a of localeAgents) {
          if (a.pathIds) {
            for (const pathId of a.pathIds) {
              if (actorPathSet.has(pathId)) {
                objectIds.add(a.id);
                break;
              }
            }
          }
        }
      }
    }
  }

  const allIds = Array.from(objectIds);
  return allIds.slice(offset, offset + limit);
}

// =============================================================================
// Permission mutation helpers
// =============================================================================

/**
 * Grant a permission: create a ledger entry recording that subject can perform
 * an action on target. Optionally scoped to locale.
 *
 * @param params - Grant request payload.
 * @param params.grantorId - Actor issuing the grant.
 * @param params.subjectId - Recipient subject ID.
 * @param params.verb - Granted action.
 * @param params.targetId - Protected object ID.
 * @param params.targetType - Protected object type.
 * @param params.role - Optional role annotation for membership workflows.
 * @param params.scope - Optional visibility scope for this grant.
 * @param params.expiresAt - Optional grant expiry.
 * @returns Created ledger grant entry ID.
 * @throws {Error} When the grantor lacks `grant` permission or DB operations fail.
 * @example
 * ```ts
 * const grantId = await grantPermission({
 *   grantorId: adminId,
 *   subjectId: memberId,
 *   verb: "view",
 *   targetId: resourceId,
 *   targetType: "resource",
 * });
 * ```
 */
export async function grantPermission(params: {
  grantorId: string;
  subjectId: string;
  verb: VerbType;
  targetId: string;
  targetType: "agent" | "resource";
  role?: string;
  scope?: "locale" | "global";
  expiresAt?: Date;
}): Promise<string> {
  // Verify grantor has grant permission on the target
  const grantorCheck = await check(params.grantorId, "grant", params.targetId, params.targetType);
  if (!grantorCheck.allowed) {
    throw new Error(`Grantor does not have grant permission: ${grantorCheck.reason}`);
  }

  const [entry] = await db.insert(ledger).values({
    verb: "grant",
    subjectId: params.subjectId,
    objectId: params.targetId,
    objectType: params.targetType,
    role: params.role,
    expiresAt: params.expiresAt,
    isActive: true,
    metadata: {
      // Store the effective permission verb in metadata.action so one canonical
      // ledger verb (`grant`) can represent all delegated actions.
      action: params.verb,
      scope: params.scope || "global",
      grantedBy: params.grantorId,
    },
  } as typeof ledger.$inferInsert).returning({ id: ledger.id });

  return entry.id;
}

/**
 * Revoke a permission: set is_active=false on matching grant entries
 * and create a revoke audit entry.
 *
 * @param params - Revoke request payload.
 * @param params.revokerId - Actor issuing the revoke action.
 * @param params.subjectId - Subject losing the grant.
 * @param params.verb - Action being revoked.
 * @param params.targetId - Target object ID.
 * @param params.targetType - Target object type.
 * @returns Resolves when revocation and audit insertion complete.
 * @throws {Error} When the revoker lacks `grant` permission or DB operations fail.
 * @example
 * ```ts
 * await revokePermission({
 *   revokerId: adminId,
 *   subjectId: memberId,
 *   verb: "view",
 *   targetId: resourceId,
 *   targetType: "resource",
 * });
 * ```
 */
export async function revokePermission(params: {
  revokerId: string;
  subjectId: string;
  verb: VerbType;
  targetId: string;
  targetType: "agent" | "resource";
}): Promise<void> {
  // Verify revoker has grant permission
  const revokerCheck = await check(params.revokerId, "grant", params.targetId, params.targetType);
  if (!revokerCheck.allowed) {
    throw new Error(`Revoker does not have grant permission: ${revokerCheck.reason}`);
  }

  // Deactivate matching grant entries (scoped to the specific action to avoid revoking unrelated grants)
  await db.update(ledger)
    .set({ isActive: false } as Partial<typeof ledger.$inferSelect>)
    .where(
      and(
        eq(ledger.verb, "grant"),
        eq(ledger.subjectId, params.subjectId),
        eq(ledger.objectId, params.targetId),
        eq(ledger.isActive, true),
        sql`${ledger.metadata}->>'action' = ${params.verb}`
      )
    );

  // Create audit entry
  await db.insert(ledger).values({
    verb: "revoke",
    subjectId: params.revokerId,
    objectId: params.targetId,
    objectType: params.targetType,
    isActive: true,
    metadata: {
      revokedFrom: params.subjectId,
      action: params.verb,
    },
  } as typeof ledger.$inferInsert);
}

/**
 * Check if a group is password-protected and whether the actor has authenticated.
 *
 * @param actorId - Actor requesting access.
 * @param groupId - Group being accessed.
 * @param now - Evaluation timestamp used for membership expiry checks.
 * @returns Whether the group requires a password and whether actor currently has access.
 * @throws {Error} Propagates database errors.
 * @example
 * ```ts
 * const access = await checkGroupAccess(actorId, groupId);
 * if (access.requiresPassword && !access.hasAccess) {
 *   // prompt for password flow
 * }
 * ```
 */
export async function checkGroupAccess(
  actorId: string,
  groupId: string,
  now: Date = new Date()
): Promise<{ requiresPassword: boolean; hasAccess: boolean }> {
  const group = await fetchAgent(groupId);
  if (!group) return { requiresPassword: false, hasAccess: false };

  if (!group.groupPasswordHash) {
    return { requiresPassword: false, hasAccess: true };
  }

  // Check if actor has an active membership (password was verified)
  const membership = await findActiveMembership(actorId, groupId, now);
  return {
    requiresPassword: true,
    hasAccess: !!membership,
  };
}

// =============================================================================
// Internal query helpers
// =============================================================================

async function fetchAgent(id: string) {
  const [agent] = await db.select().from(agents).where(
    and(eq(agents.id, id), isNull(agents.deletedAt))
  ).limit(1);
  return agent || null;
}

async function fetchResource(id: string) {
  const [resource] = await db.select().from(resources).where(
    and(eq(resources.id, id), isNull(resources.deletedAt))
  ).limit(1);
  return resource || null;
}

/** Find an active ledger edge between subject and object with the given verb.
 *  Also matches grant-style entries (verb="grant") where metadata.action equals the requested verb,
 *  since grantPermission() stores grants with verb="grant" and the actual permission in metadata.action. */
async function findActiveEdge(
  subjectId: string,
  verb: VerbType,
  objectId: string,
  now: Date
) {
  const [edge] = await db.select()
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, subjectId),
        or(
          eq(ledger.verb, verb),
          and(
            eq(ledger.verb, "grant"),
            sql`${ledger.metadata}->>'action' = ${verb}`
          )
        ),
        eq(ledger.objectId, objectId),
        eq(ledger.isActive, true),
        or(
          isNull(ledger.expiresAt),
          sql`${ledger.expiresAt} > ${now}`
        )
      )
    )
    .limit(1);
  return edge || null;
}

/** Find active membership (belong/join) edge */
async function findActiveMembership(actorId: string, groupId: string, now: Date) {
  const [membership] = await db.select()
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(
          eq(ledger.verb, "belong"),
          eq(ledger.verb, "join")
        ),
        or(
          isNull(ledger.expiresAt),
          sql`${ledger.expiresAt} > ${now}`
        )
      )
    )
    .limit(1);
  return membership || null;
}

/** Find groups that have active grants on a target for a given verb */
async function findGroupGrantsOnTarget(targetId: string, verb: VerbType, now: Date) {
  const grants = await db.select()
    .from(ledger)
    .where(
      and(
        eq(ledger.verb, "grant"),
        eq(ledger.objectId, targetId),
        eq(ledger.isActive, true),
        sql`${ledger.metadata}->>'action' = ${verb}`,
        or(
          isNull(ledger.expiresAt),
          sql`${ledger.expiresAt} > ${now}`
        )
      )
    );
  return grants;
}

/** Check if actor and target share a locale via pathIds overlap */
async function checkLocaleOverlap(
  actorId: string,
  target: { id: string; ownerId?: string; parentId?: string | null; pathIds?: string[] | null },
  targetType: "agent" | "resource"
): Promise<string | null> {
  const actor = await fetchAgent(actorId);
  // Missing actor means a stale JWT referencing a deleted/recreated agent.
  // Return null to deny access rather than leaking info as "global".
  if (!actor) return null;

  // Get the relevant pathIds for the target
  let targetPathIds: string[] | null = null;
  if (targetType === "resource" && "ownerId" in target && target.ownerId) {
    const owner = await fetchAgent(target.ownerId);
    targetPathIds = owner?.pathIds || null;
  } else {
    targetPathIds = (target as { pathIds?: string[] | null }).pathIds || null;
  }

  // When either party has no pathIds (null or empty array) they are in
  // "global" scope — treat as a shared locale so locale-visible content
  // remains discoverable.
  if (!actor.pathIds || actor.pathIds.length === 0 || !targetPathIds || targetPathIds.length === 0) {
    return "global";
  }

  // Find overlapping locale IDs
  const actorSet = new Set(actor.pathIds);
  for (const pathId of targetPathIds) {
    if (actorSet.has(pathId)) return pathId;
  }
  return null;
}

// =============================================================================
// ABAC Policy Evaluation
// =============================================================================

/**
 * Evaluate ABAC permission policies linked to a target.
 *
 * Queries all active `permission_policy` resources whose metadata.targetId
 * matches the target. For each policy, evaluates the actor's attributes
 * against the policy conditions.
 *
 * Returns the via string if access is granted, null otherwise.
 */
async function evaluateAbacPolicies(
  actorId: string,
  targetId: string,
  targetType: "agent" | "resource",
  verb: VerbType
): Promise<string | null> {
  // Find all permission_policy resources targeting this object
  const policies = await db.execute(sql`
    SELECT *
    FROM resources
    WHERE deleted_at IS NULL
    AND type = 'permission_policy'
    AND metadata->>'targetId' = ${targetId}
    AND metadata->>'targetType' = ${targetType}
  `);

  if (!policies || (policies as unknown[]).length === 0) return null;

  // Fetch the actor's attributes (from agent metadata and hierarchy)
  const actor = await fetchAgent(actorId);
  if (!actor) return null;

  const actorAttributes = buildActorAttributes(actor);

  for (const row of policies as unknown as Resource[]) {
    const policy = row.metadata as unknown as PermissionPolicyMetadata;
    if (!policy || !policy.allowedActions || !policy.conditions) continue;

    // Check if this policy grants the requested action
    if (!policy.allowedActions.includes(verb)) continue;

    // Check locale scope if specified
    if (policy.localeScope) {
      const actorLocales = actorAttributes.get("chapterTags") || actorAttributes.get("pathIds");
      if (!actorLocales || !actorLocales.includes(policy.localeScope)) continue;
    }

    // Evaluate attribute conditions
    const conditionsMet = evaluateConditions(policy.conditions, policy.logicalOperator, actorAttributes);
    if (conditionsMet) {
      return `policy:${row.id}→${verb} (${policy.label || "abac"})`;
    }
  }

  return null;
}

/**
 * Build an attribute map from an agent's data for ABAC evaluation.
 *
 * Attributes are derived from:
 * - Agent type (e.g., type=person)
 * - Agent pathIds (locale hierarchy membership)
 * - Agent metadata fields (chapterTags, roles, badges, etc.)
 * - Memberships (derived from ledger, if needed in future)
 */
function buildActorAttributes(actor: {
  id: string;
  type: string;
  pathIds?: string[] | null;
  metadata?: Record<string, unknown> | null;
}): Map<string, string | string[]> {
  const attrs = new Map<string, string | string[]>();

  attrs.set("id", actor.id);
  attrs.set("type", actor.type);

  if (actor.pathIds && actor.pathIds.length > 0) {
    attrs.set("pathIds", actor.pathIds);
  }

  if (actor.metadata) {
    for (const [key, value] of Object.entries(actor.metadata)) {
      if (typeof value === "string") {
        attrs.set(key, value);
      } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        attrs.set(key, value as string[]);
      }
    }
  }

  return attrs;
}

/**
 * Evaluate a set of ABAC conditions against an actor's attributes.
 */
function evaluateConditions(
  conditions: AttributeCondition[],
  logicalOperator: "AND" | "OR",
  actorAttributes: Map<string, string | string[]>
): boolean {
  if (conditions.length === 0) return true;

  const results = conditions.map((cond) => evaluateSingleCondition(cond, actorAttributes));

  if (logicalOperator === "AND") {
    return results.every(Boolean);
  }
  return results.some(Boolean);
}

/**
 * Evaluate a single ABAC condition against an actor's attributes.
 */
function evaluateSingleCondition(
  condition: AttributeCondition,
  actorAttributes: Map<string, string | string[]>
): boolean {
  const attrValue = actorAttributes.get(condition.key);

  switch (condition.operator) {
    case "exists":
      return attrValue !== undefined;

    case "equals":
      if (typeof attrValue === "string" && typeof condition.value === "string") {
        return attrValue === condition.value;
      }
      return false;

    case "contains":
      // Actor's attribute is an array and contains the condition value
      if (Array.isArray(attrValue) && typeof condition.value === "string") {
        return attrValue.includes(condition.value);
      }
      return false;

    case "in":
      // Actor's attribute value is in the condition's array
      if (typeof attrValue === "string" && Array.isArray(condition.value)) {
        return condition.value.includes(attrValue);
      }
      return false;

    default:
      return false;
  }
}

// =============================================================================
// Predicate Visibility (Edge Privacy)
// =============================================================================

/**
 * Check whether an actor can view a specific predicate (ledger entry).
 *
 * Predicates have their own visibility level (defaulting to "public")
 * and may optionally link to a permission_policy resource for fine-grained
 * ABAC control over who can see the relationship.
 *
 * Evaluation:
 * 1. If visibility=public → allowed
 * 2. If visibility=locale → actor shares a locale with the predicate's subject
 * 3. If visibility=members → actor is a member of the subject or object group
 * 4. If visibility=private → only the subject or object agent
 * 5. If policyId is set → evaluate the linked permission policy
 *
 * @param actorId - Requesting actor ID.
 * @param predicateId - Ledger predicate ID being viewed.
 * @returns Authorization decision for predicate visibility.
 * @throws {Error} Propagates database errors from underlying lookups.
 * @example
 * ```ts
 * const result = await canViewPredicate(actorId, ledgerEdgeId);
 * ```
 */
export async function canViewPredicate(
  actorId: string,
  predicateId: string
): Promise<CheckResult> {
  const [predicate] = await db.select()
    .from(ledger)
    .where(eq(ledger.id, predicateId))
    .limit(1);

  if (!predicate) {
    return { allowed: false, reason: "predicate_not_found" };
  }

  const visibility = predicate.visibility || "public";

  // 1. Public predicates are visible to everyone
  if (visibility === "public") {
    return { allowed: true, reason: "public_predicate", via: "visibility=public" };
  }

  // 2. Self-access: subject or object can always see their own edges
  if (predicate.subjectId === actorId || predicate.objectId === actorId) {
    return { allowed: true, reason: "predicate_participant", via: "subject_or_object" };
  }

  // 3. Locale visibility: actor shares a locale with the subject
  if (visibility === "locale") {
    const subject = await fetchAgent(predicate.subjectId);
    const actor = await fetchAgent(actorId);
    if (subject && actor && subject.pathIds && actor.pathIds) {
      const actorPaths = new Set(actor.pathIds);
      for (const pathId of subject.pathIds) {
        if (actorPaths.has(pathId)) {
          return { allowed: true, reason: "locale_predicate", via: `shared_locale:${pathId}` };
        }
      }
    }
  }

  // 4. Members visibility: actor is a member of the subject or object group
  if (visibility === "members") {
    const now = new Date();
    if (predicate.subjectId) {
      const membership = await findActiveMembership(actorId, predicate.subjectId, now);
      if (membership) {
        return { allowed: true, reason: "member_predicate", via: `member→subject:${predicate.subjectId}` };
      }
    }
    if (predicate.objectId) {
      const membership = await findActiveMembership(actorId, predicate.objectId, now);
      if (membership) {
        return { allowed: true, reason: "member_predicate", via: `member→object:${predicate.objectId}` };
      }
    }
  }

  // 5. Private: only participants (handled above at step 2)
  if (visibility === "private") {
    return { allowed: false, reason: "private_predicate" };
  }

  if (visibility === "hidden") {
    return { allowed: false, reason: "hidden_predicate" };
  }

  // 6. Policy-based: evaluate the linked permission policy
  if (predicate.policyId) {
    const policyAccess = await evaluateAbacPolicies(actorId, predicateId, "resource", "view");
    if (policyAccess) {
      return { allowed: true, reason: "policy_predicate", via: policyAccess };
    }
  }

  return { allowed: false, reason: "no_predicate_permission" };
}

// =============================================================================
// Permission Policy CRUD
// =============================================================================

/**
 * Create a permission policy resource linked to a target object.
 *
 * The policy is a resource of type `permission_policy` owned by the target.
 * It defines ABAC conditions: users whose attributes satisfy the conditions
 * are granted the listed actions.
 *
 * @param params - Permission policy definition.
 * @param params.creatorId - Actor creating the policy.
 * @param params.targetId - Protected object ID.
 * @param params.targetType - Protected object kind (`agent`, `resource`, `ledger`).
 * @param params.allowedActions - Verbs this policy grants when conditions pass.
 * @param params.conditions - ABAC conditions to evaluate against actor attributes.
 * @param params.logicalOperator - Condition combiner (`AND` or `OR`).
 * @param params.localeScope - Optional locale constraint.
 * @param params.label - Optional label used for policy naming/audit.
 * @returns ID of the created `permission_policy` resource.
 * @throws {PermissionError} When creator lacks `manage` on non-ledger targets.
 * @throws {Error} Propagates database errors.
 * @example
 * ```ts
 * const policyId = await createPermissionPolicy({
 *   creatorId: adminId,
 *   targetId: resourceId,
 *   targetType: "resource",
 *   allowedActions: ["view"],
 *   conditions: [{ key: "role", operator: "equals", value: "member" }],
 *   logicalOperator: "AND",
 *   label: "Members can view",
 * });
 * ```
 */
export async function createPermissionPolicy(params: {
  creatorId: string;
  targetId: string;
  targetType: "agent" | "resource" | "ledger";
  allowedActions: VerbType[];
  conditions: AttributeCondition[];
  logicalOperator: "AND" | "OR";
  localeScope?: string;
  label?: string;
}): Promise<string> {
  // Verify creator has manage permission on the target (unless it's a ledger entry)
  if (params.targetType !== "ledger") {
    const manageCheck = await check(
      params.creatorId,
      "manage",
      params.targetId,
      params.targetType as "agent" | "resource"
    );
    if (!manageCheck.allowed) {
      throw new PermissionError(
        `Cannot create policy: no manage permission on target (${manageCheck.reason})`
      );
    }
  }

  const policyMetadata: PermissionPolicyMetadata = {
    targetId: params.targetId,
    targetType: params.targetType,
    allowedActions: params.allowedActions,
    conditions: params.conditions,
    logicalOperator: params.logicalOperator,
    localeScope: params.localeScope,
    label: params.label,
  };

  const [policy] = await db
    .insert(resources)
    .values({
      name: params.label || `Policy for ${params.targetId}`,
      type: "permission_policy",
      ownerId: params.creatorId,
      visibility: "private",
      metadata: policyMetadata as unknown as Record<string, unknown>,
    } as NewResource)
    .returning({ id: resources.id });

  // Record the policy creation in the ledger
  await db.insert(ledger).values({
    verb: "create",
    subjectId: params.creatorId,
    objectId: params.targetId,
    objectType: params.targetType === "ledger" ? "resource" : params.targetType,
    resourceId: policy.id,
    isActive: true,
    metadata: {
      policyId: policy.id,
      action: "create_policy",
      allowedActions: params.allowedActions,
    },
  } as typeof ledger.$inferInsert);

  return policy.id;
}

/**
 * Delete (soft-delete) a permission policy.
 * Requires manage permission on the policy's target.
 *
 * @param actorId - Actor requesting deletion.
 * @param policyId - Policy resource ID to soft-delete.
 * @returns Resolves when policy is marked deleted.
 * @throws {PermissionError} When policy is missing or actor lacks required `manage` access.
 * @throws {Error} Propagates database errors.
 * @example
 * ```ts
 * await deletePermissionPolicy(actorId, policyId);
 * ```
 */
export async function deletePermissionPolicy(
  actorId: string,
  policyId: string
): Promise<void> {
  const [policy] = await db.select()
    .from(resources)
    .where(
      and(
        eq(resources.id, policyId),
        eq(resources.type, "permission_policy"),
        isNull(resources.deletedAt)
      )
    )
    .limit(1);

  if (!policy) {
    throw new PermissionError("Policy not found");
  }

  const metadata = policy.metadata as unknown as PermissionPolicyMetadata;

  // Verify actor can manage the target
  if (metadata.targetType !== "ledger") {
    const manageCheck = await check(
      actorId,
      "manage",
      metadata.targetId,
      metadata.targetType as "agent" | "resource"
    );
    if (!manageCheck.allowed) {
      throw new PermissionError(
        `Cannot delete policy: no manage permission on target (${manageCheck.reason})`
      );
    }
  }

  await db.update(resources)
    .set({ deletedAt: new Date() } as Partial<typeof resources.$inferSelect>)
    .where(eq(resources.id, policyId));
}

/**
 * Get all permission policies for a target object.
 *
 * @param targetId - Target object ID.
 * @param targetType - Target object kind (`agent`, `resource`, `ledger`).
 * @returns Active permission policy resources ordered by newest first.
 * @throws {Error} Propagates database query errors.
 * @example
 * ```ts
 * const policies = await getPoliciesForTarget(resourceId, "resource");
 * ```
 */
export async function getPoliciesForTarget(
  targetId: string,
  targetType: "agent" | "resource" | "ledger"
): Promise<Resource[]> {
  const result = await db.execute(sql`
    SELECT *
    FROM resources
    WHERE deleted_at IS NULL
    AND type = 'permission_policy'
    AND metadata->>'targetId' = ${targetId}
    AND metadata->>'targetType' = ${targetType}
    ORDER BY created_at DESC
  `);

  return result as unknown as Resource[];
}

/**
 * Attach a permission policy to a ledger entry (predicate).
 * This sets the policyId on the ledger entry and adjusts its visibility.
 *
 * @param actorId - Actor requesting policy attachment.
 * @param predicateId - Ledger edge ID to update.
 * @param policyId - Policy resource ID to attach.
 * @param visibility - New predicate visibility level after attachment.
 * @returns Resolves when predicate row is updated.
 * @throws {PermissionError} When predicate is missing or actor lacks manage permissions.
 * @throws {Error} Propagates database update errors.
 * @example
 * ```ts
 * await attachPolicyToPredicate(actorId, predicateId, policyId, "members");
 * ```
 */
export async function attachPolicyToPredicate(
  actorId: string,
  predicateId: string,
  policyId: string,
  visibility: VisibilityLevel = "private"
): Promise<void> {
  // Verify the predicate exists
  const [predicate] = await db.select()
    .from(ledger)
    .where(eq(ledger.id, predicateId))
    .limit(1);

  if (!predicate) {
    throw new PermissionError("Predicate not found");
  }

  // Verify actor is the subject of the predicate or has manage on one of the
  // participants. This avoids arbitrary policy attachment by unrelated actors.
  if (predicate.subjectId !== actorId) {
    const subjectManage = await check(actorId, "manage", predicate.subjectId, "agent");
    const objectManage = predicate.objectId
      ? await check(actorId, "manage", predicate.objectId, "agent")
      : { allowed: false };
    if (!subjectManage.allowed && !objectManage.allowed) {
      throw new PermissionError("Cannot attach policy: no manage permission on predicate participants");
    }
  }

  await db.execute(sql`
    UPDATE ledger
    SET policy_id = ${policyId},
        visibility = ${visibility}
    WHERE id = ${predicateId}
  `);
}

/** Check if actor is a member of the group that owns the target */
async function checkMemberVisibility(
  actorId: string,
  target: { id: string; ownerId?: string; parentId?: string | null },
  targetType: "agent" | "resource",
  now: Date
): Promise<string | null> {
  // For resources, check membership in the owner's group
  if (targetType === "resource" && "ownerId" in target && target.ownerId) {
    const owner = await fetchAgent(target.ownerId);
    if (!owner) return null;

    // Check if actor is a member of the owner (if owner is a group)
    const membership = await findActiveMembership(actorId, target.ownerId, now);
    if (membership) return `member→owner:${target.ownerId}`;

    // Check if actor is a member of the owner's parent group
    if (owner.parentId) {
      const parentMembership = await findActiveMembership(actorId, owner.parentId, now);
      if (parentMembership) return `member→parent:${owner.parentId}`;
    }
  }

  // For agents, check membership in the target's parent
  if (targetType === "agent" && "parentId" in target && target.parentId) {
    const membership = await findActiveMembership(actorId, target.parentId, now);
    if (membership) return `member→parent:${target.parentId}`;
  }

  return null;
}

/** Check if actor has manage permission on any ancestor of the target */
async function checkHierarchyInheritance(
  actorId: string,
  target: { id: string; parentId?: string | null; pathIds?: string[] | null; ownerId?: string },
  targetType: "agent" | "resource",
  verb: VerbType,
  now: Date
): Promise<string | null> {
  // Get the hierarchy path to check
  let pathIds: string[] | null = null;

  if (targetType === "resource" && "ownerId" in target && target.ownerId) {
    const owner = await fetchAgent(target.ownerId);
    pathIds = owner?.pathIds || null;
  } else {
    pathIds = (target as { pathIds?: string[] | null }).pathIds || null;
  }

  if (!pathIds || pathIds.length === 0) return null;

  // Check if actor has manage on any ancestor — manage implies most verbs
  if (!VERB_IMPLICATIONS.manage?.includes(verb)) return null;

  for (const ancestorId of pathIds) {
    const manageEdge = await findActiveEdge(actorId, "manage", ancestorId, now);
    if (manageEdge) {
      return `manage→ancestor:${ancestorId}→${verb}`;
    }
    const ownEdge = await findActiveEdge(actorId, "own", ancestorId, now);
    if (ownEdge) {
      return `own→ancestor:${ancestorId}→${verb}`;
    }
  }

  return null;
}
