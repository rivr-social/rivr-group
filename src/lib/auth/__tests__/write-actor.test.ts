// src/lib/auth/__tests__/write-actor.test.ts
//
// Unit coverage for the PURE write-principal decision (audit finding S-1).
// The IO layer (session/cookie resolution, standing lookup, scope read) is
// covered by the actions' own db-backed suites; this pins the policy itself.

import { describe, expect, it } from "vitest";

import {
  WRITE_ACTOR_DENIAL_CODES,
  decideWriteActor,
  writeActorDenialMessage,
  type FederatedStanding,
  type WriteActorPrincipal,
} from "@/lib/auth/write-actor-policy";
import {
  BASELINE_VISITOR_CAPABILITY,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";

const LOCAL_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const FEDERATED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_LABEL = "post a comment";

const localPrincipal: WriteActorPrincipal = {
  actorId: LOCAL_ACTOR_ID,
  authType: "local",
};
const federatedPrincipal: WriteActorPrincipal = {
  actorId: FEDERATED_ACTOR_ID,
  authType: "federated",
};

const NO_STANDING: FederatedStanding = {
  isPrimaryAgent: false,
  isLocalMember: false,
};
const MEMBER_STANDING: FederatedStanding = {
  isPrimaryAgent: false,
  isLocalMember: true,
};
const PRIMARY_STANDING: FederatedStanding = {
  isPrimaryAgent: true,
  isLocalMember: true,
};

function scope(extras: VisitorScope["capabilities"], enabled = true): VisitorScope {
  return {
    enabled,
    capabilities: [BASELINE_VISITOR_CAPABILITY, ...extras],
    ttlMinutes: 30,
    recordVisits: true,
  };
}

describe("decideWriteActor", () => {
  it("refuses an anonymous caller with the honest UNAUTHENTICATED message", () => {
    const decision = decideWriteActor({
      principal: null,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: null,
      visitorScope: null,
    });

    expect(decision).toEqual({
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.UNAUTHENTICATED,
      message: `You must be logged in to ${ACTION_LABEL}.`,
    });
  });

  it("allows a local session without consulting the visitor policy", () => {
    const decision = decideWriteActor({
      principal: localPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      // A local session never resolves standing or scope — both are null here
      // exactly as resolveWriteActor passes them.
      standing: null,
      visitorScope: null,
    });

    expect(decision).toEqual({
      allowed: true,
      actorId: LOCAL_ACTOR_ID,
      authType: "local",
    });
  });

  it("allows a federated MEMBER even when the visitor scope grants nothing", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: MEMBER_STANDING,
      visitorScope: scope([]),
    });

    expect(decision).toEqual({
      allowed: true,
      actorId: FEDERATED_ACTOR_ID,
      authType: "federated",
    });
  });

  it("allows the instance primary agent arriving federated", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "rsvp",
      standing: PRIMARY_STANDING,
      visitorScope: null,
    });

    expect(decision.allowed).toBe(true);
  });

  it("allows a standing-less visitor when the policy grants the capability", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: NO_STANDING,
      visitorScope: scope(["comment"]),
    });

    expect(decision).toEqual({
      allowed: true,
      actorId: FEDERATED_ACTOR_ID,
      authType: "federated",
    });
  });

  it("refuses a standing-less visitor for a capability the policy withholds", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: NO_STANDING,
      visitorScope: scope(["react"]),
    });

    expect(decision).toEqual({
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.VISITOR_CAPABILITY_DENIED,
      message: writeActorDenialMessage(
        WRITE_ACTOR_DENIAL_CODES.VISITOR_CAPABILITY_DENIED,
        ACTION_LABEL,
      ),
    });
  });

  it("refuses a standing-less visitor when visitor access is turned off", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "react",
      standing: NO_STANDING,
      // Capability present but the policy is disabled — disabled wins.
      visitorScope: scope(["react"], false),
    });

    expect(decision).toEqual({
      allowed: false,
      code: WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED,
      message: writeActorDenialMessage(
        WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED,
        ACTION_LABEL,
      ),
    });
  });

  it("refuses a standing-less visitor when the scope could not be resolved", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "react",
      standing: NO_STANDING,
      visitorScope: null,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe(
        WRITE_ACTOR_DENIAL_CODES.VISITOR_ACCESS_DISABLED,
      );
    }
  });

  it("never grants the baseline read capability as a write", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: NO_STANDING,
      // Default policy: read only.
      visitorScope: scope([]),
    });

    expect(decision.allowed).toBe(false);
  });

  it("carries the resolved LOCAL actor id, never the caller's home id", () => {
    const decision = decideWriteActor({
      principal: federatedPrincipal,
      actionLabel: ACTION_LABEL,
      capability: "comment",
      standing: MEMBER_STANDING,
      visitorScope: null,
    });

    expect(decision.allowed && decision.actorId).toBe(FEDERATED_ACTOR_ID);
  });
});

describe("writeActorDenialMessage", () => {
  it("names the attempted action in every refusal", () => {
    for (const code of Object.values(WRITE_ACTOR_DENIAL_CODES)) {
      expect(writeActorDenialMessage(code, "RSVP to events")).toContain(
        "RSVP to events",
      );
    }
  });
});
