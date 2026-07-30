// src/lib/auth/write-actor-policy.ts
//
// PURE write-principal policy for audit finding S-1 — no session, cookie or db
// access, so it is unit-testable on its own and safe to import from anywhere.
// The IO side (who is calling, what standing they hold, what the instance's
// visitor policy says) lives in `./write-actor`.

import {
  visitorCan,
  type VisitorCapability,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";

/** Machine-readable refusal codes returned to callers as `error.code`. */
export const WRITE_ACTOR_DENIAL_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  VISITOR_ACCESS_DISABLED: "VISITOR_ACCESS_DISABLED",
  VISITOR_CAPABILITY_DENIED: "VISITOR_CAPABILITY_DENIED",
} as const;

export type WriteActorDenialCode =
  (typeof WRITE_ACTOR_DENIAL_CODES)[keyof typeof WRITE_ACTOR_DENIAL_CODES];

/** How the principal proved who they are. */
export type WriteActorAuthType = "local" | "federated";

export interface WriteActorPrincipal {
  /** Always THIS instance's local agent id. */
  actorId: string;
  authType: WriteActorAuthType;
}

/** Local standing of a federated principal on this instance. */
export interface FederatedStanding {
  /** The principal IS this instance's primary agent. */
  isPrimaryAgent: boolean;
  /** The principal holds an active membership/admin edge on a relevant group. */
  isLocalMember: boolean;
}

export type WriteActorDecision =
  | { allowed: true; actorId: string; authType: WriteActorAuthType }
  | { allowed: false; code: WriteActorDenialCode; message: string };

/** Refusal copy. `actionLabel` reads as a verb phrase, e.g. "post a comment". */
export function writeActorDenialMessage(
  code: WriteActorDenialCode,
  actionLabel: string,
): string {
  switch (code) {
    case WRITE_ACTOR_DENIAL_CODES.UNAUTHENTICATED:
      return `You must be logged in to ${actionLabel}.`;
    case WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED:
      return `This community has turned off access for visitors from other instances, so you cannot ${actionLabel} here.`;
    case WRITE_ACTOR_DENIAL_CODES.VISITOR_CAPABILITY_DENIED:
      return `This community does not let visitors from other instances ${actionLabel}. Join the group to take part.`;
  }
}

/**
 * Pure decision: may this principal perform a capability-gated write?
 *
 * Kept free of IO so the policy is unit-testable on its own. Callers supply the
 * already-resolved principal, standing and visitor scope.
 */
export function decideWriteActor(input: {
  principal: WriteActorPrincipal | null;
  /** Verb phrase used in refusal copy. */
  actionLabel: string;
  /** Visitor capability this write consumes. */
  capability: VisitorCapability;
  /** Local standing — only meaningful for a federated principal. */
  standing: FederatedStanding | null;
  /** Resolved instance visitor policy — only read for a standing-less visitor. */
  visitorScope: VisitorScope | null;
}): WriteActorDecision {
  const { principal, actionLabel, capability, standing, visitorScope } = input;

  if (!principal) {
    return {
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.UNAUTHENTICATED,
      message: writeActorDenialMessage(
        WRITE_ACTOR_DENIAL_CODES.UNAUTHENTICATED,
        actionLabel,
      ),
    };
  }

  if (principal.authType === "local") {
    return { allowed: true, actorId: principal.actorId, authType: "local" };
  }

  // Federated principals with real local standing are members, not visitors.
  if (standing?.isPrimaryAgent || standing?.isLocalMember) {
    return { allowed: true, actorId: principal.actorId, authType: "federated" };
  }

  if (!visitorScope || !visitorScope.enabled) {
    return {
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED,
      message: writeActorDenialMessage(
        WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED,
        actionLabel,
      ),
    };
  }

  if (!visitorCan(visitorScope, capability)) {
    return {
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.VISITOR_CAPABILITY_DENIED,
      message: writeActorDenialMessage(
        WRITE_ACTOR_DENIAL_CODES.VISITOR_CAPABILITY_DENIED,
        actionLabel,
      ),
    };
  }

  return { allowed: true, actorId: principal.actorId, authType: "federated" };
}

