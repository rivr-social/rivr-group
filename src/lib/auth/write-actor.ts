// src/lib/auth/write-actor.ts
//
// Write-principal resolution for IN-BROWSER server actions (S-1).
//
// A sovereign group instance has two ways to be signed in:
//   1. a local NextAuth session (`auth()`), and
//   2. a federated SSO identity riding the signed `rivr_remote_viewer` cookie
//      (global-credential login → /api/federation/sso/land).
//
// Read surfaces already honor both (`getSession`, `getAuthenticatedActorId`),
// but several write actions resolved the actor with a session-ONLY helper, so a
// federated identity got the full write UI and every write refused with
// "You must be logged in to …" (audit finding S-1).
//
// This module is the single write-side resolver:
//   - it accepts EITHER auth source and always returns THIS instance's local
//     agent id (a remote-viewer cookie carries the actor's HOME id verbatim, so
//     it is normalized through `resolveLocalActorId`);
//   - it applies the owner-authored federated-visitor policy
//     (`/settings/visitor-access`, `visitor-scope.ts`) to federated principals
//     who hold no local standing here — the same capability menu
//     (read/react/comment/rsvp/message) the peer mutations route enforces;
//   - it NEVER replaces downstream authorization. Membership/capability gates
//     (`canPostToGroup`, `hasGroupManageAccess`, resource ownership) still run
//     against the resolved local actor.
//
// Standing beats scope: a federated principal who is the instance's primary
// agent, or who holds a real active membership/admin edge on this instance, is a
// MEMBER acting from a remote home — not a drive-by visitor — so the visitor
// scope does not constrain them. Their writes are gated by the group's own
// membership/capability checks exactly as a local member's are.

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { ledger } from "@/db/schema";
import { getSession } from "@/lib/auth/get-session";
import { getExecutionContext } from "@/lib/federation/execution-context";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveLocalActorId } from "@/lib/federation/resolution";
import {
  resolveVisitorScope,
  type VisitorCapability,
} from "@/lib/federation/visitor-scope";
import {
  decideWriteActor,
  type FederatedStanding,
  type WriteActorDecision,
  type WriteActorPrincipal,
} from "@/lib/auth/write-actor-policy";
import { getOperatingAgentId } from "@/lib/persona";
import { getAuthenticatedActor } from "@/lib/server-auth";

export {
  WRITE_ACTOR_DENIAL_CODES,
  decideWriteActor,
  writeActorDenialMessage,
} from "@/lib/auth/write-actor-policy";
export type {
  FederatedStanding,
  WriteActorAuthType,
  WriteActorDecision,
  WriteActorDenialCode,
  WriteActorPrincipal,
} from "@/lib/auth/write-actor-policy";

/** Ledger verbs that constitute a real membership/authority edge on a group. */
const MEMBERSHIP_VERBS = ["own", "manage", "join", "belong"] as const;

/** Agent/group ids are uuids; anything else must never reach a `uuid` column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the write principal from the request, accepting either auth source.
 *
 * Order:
 * 1. Federation/MCP execution context — already authorized and normalized by
 *    `bindAuthorizedFederationActor` before dispatch.
 * 2. Unified session (`getSession`) — NextAuth first, then the modern
 *    remote-viewer cookie.
 * 3. `getAuthenticatedActor` — the dual-format cookie validator, which also
 *    reads the legacy packed remote-viewer token `getSession` cannot decode.
 */
export async function resolveWriteActorPrincipal(
  preferActivePersona = false,
): Promise<WriteActorPrincipal | null> {
  const executionContext = getExecutionContext();
  if (executionContext?.actorId) {
    return { actorId: executionContext.actorId, authType: "local" };
  }

  const session = await getSession();
  if (session?.user?.id) {
    if (session.user.authMethod === "federated") {
      return {
        actorId: await resolveLocalActorId(session.user.id),
        authType: "federated",
      };
    }
    const personaId = preferActivePersona ? await getOperatingAgentId() : null;
    return { actorId: personaId ?? session.user.id, authType: "local" };
  }

  const actor = await getAuthenticatedActor();
  if (!actor) return null;

  if (actor.authType === "remote") {
    return {
      actorId: await resolveLocalActorId(actor.actorId),
      authType: "federated",
    };
  }

  const personaId = preferActivePersona ? await getOperatingAgentId() : null;
  return { actorId: personaId ?? actor.actorId, authType: "local" };
}

/**
 * Does this actor hold real standing on this instance? An active
 * membership/authority edge on the primary agent (or on any of the supplied
 * candidate groups — typically the owner of the resource being written to), or
 * admin authority authored in group metadata rather than the ledger.
 */
export async function resolveFederatedStanding(
  actorId: string,
  candidateAgentIds: string[] = [],
): Promise<FederatedStanding> {
  const { primaryAgentId } = getInstanceConfig();
  if (primaryAgentId && actorId === primaryAgentId) {
    return { isPrimaryAgent: true, isLocalMember: true };
  }

  const groupIds = Array.from(
    new Set(
      [primaryAgentId, ...candidateAgentIds].filter(
        (id): id is string => typeof id === "string" && UUID_RE.test(id),
      ),
    ),
  );
  if (groupIds.length === 0 || !UUID_RE.test(actorId)) {
    return { isPrimaryAgent: false, isLocalMember: false };
  }

  const membershipRows = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, actorId),
        inArray(ledger.objectId, groupIds),
        inArray(ledger.verb, [...MEMBERSHIP_VERBS]),
        eq(ledger.isActive, true),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > NOW()`),
      ),
    )
    .limit(1);

  if (membershipRows.length > 0) {
    return { isPrimaryAgent: false, isLocalMember: true };
  }

  // Admins authored in group metadata (creatorId / adminIds) have no ledger
  // edge. Lazy import: group-admin is a "use server" action module that reaches
  // back into lib, so a static import here would close an import cycle.
  const { isGroupAdmin } = await import("@/app/actions/group-admin");
  for (const groupId of groupIds) {
    if (await isGroupAdmin(actorId, groupId)) {
      return { isPrimaryAgent: false, isLocalMember: true };
    }
  }

  return { isPrimaryAgent: false, isLocalMember: false };
}

export interface ResolveWriteActorOptions {
  /** Visitor capability this write consumes (react / comment / rsvp / message). */
  capability: VisitorCapability;
  /** Verb phrase for refusal copy, e.g. "post a comment". */
  actionLabel: string;
  /**
   * Group-like agents whose membership grants standing beyond the visitor
   * scope — normally the owner of the resource being written to.
   */
  standingAgentIds?: string[];
  /** Attribute local-session writes to the caller's active persona. */
  preferActivePersona?: boolean;
}

/**
 * Resolve + authorize the actor for a capability-gated social write.
 *
 * The returned `actorId` is always a local agent id; downstream authorization
 * must still run against it.
 */
export async function resolveWriteActor(
  options: ResolveWriteActorOptions,
): Promise<WriteActorDecision> {
  const principal = await resolveWriteActorPrincipal(
    options.preferActivePersona === true,
  );

  if (!principal || principal.authType === "local") {
    return decideWriteActor({
      principal,
      actionLabel: options.actionLabel,
      capability: options.capability,
      standing: null,
      visitorScope: null,
    });
  }

  const standing = await resolveFederatedStanding(
    principal.actorId,
    options.standingAgentIds ?? [],
  );
  const visitorScope =
    standing.isPrimaryAgent || standing.isLocalMember
      ? null
      : await resolveVisitorScope();

  return decideWriteActor({
    principal,
    actionLabel: options.actionLabel,
    capability: options.capability,
    standing,
    visitorScope,
  });
}
