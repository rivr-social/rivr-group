import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance, resolveLocalActorId } from "@/lib/federation/resolution";
import {
  authorizeFederationRequest,
  bindAuthorizedFederationActor,
} from "@/lib/federation-auth";
import { runWithFederationExecutionContext } from "@/lib/federation/execution-context";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation/domain-events";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  validateFederatedAssertion,
  validateRemoteViewerToken,
  type FederatedAssertionPersonaContext,
} from "@/lib/federation-remote-session";
import type {
  FederatedActorContext,
  FederatedInteractionAction,
  FederatedInteractionResult,
} from "@/lib/federation/cross-instance-types";
import type { RoutingProvenance } from "@/lib/federation/write-router";
import { toggleFollowAgent, toggleJoinGroup } from "@/app/actions/interactions/social";
import { applyMembershipRequestForActor } from "@/app/actions/group-access";
import { isGroupMember } from "@/lib/permissions";
import { createEventResource } from "@/app/actions/resource-creation/events";
import { createOfferingResource } from "@/app/actions/resource-creation/offerings";
import { createPostResource } from "@/app/actions/resource-creation/posts";
import { updateResource, deleteResource } from "@/app/actions/resource-creation/lifecycle";
import type { UpdateResourceInput } from "@/app/actions/resource-creation/types";
import {
  createBookingAction,
  bookAssetAction,
  applyToJob,
} from "@/app/actions/interactions";
import { purchaseWithWalletAction } from "@/app/actions/wallet";
import * as kg from "@/lib/kg/autobot-kg-client";
import { authorizeKgScope } from "@/lib/federation/kg-scope-authz";
import {
  AUTHORITY_GUARD_REASONS,
  checkAuthorityForActor,
  checkAuthorityForSession,
} from "@/lib/federation/authority-guard";
import {
  resolveVisitorScope,
  requiredVisitorCapability,
  visitorCan,
} from "@/lib/federation/visitor-scope";

const KNOWN_MUTATION_TYPES = [
  "createGroupResource",
  "updateGroupResource",
  "deleteGroupResource",
  "updateResource",
  "deleteResource",
  "createPostResource",
  "createEventResource",
  "toggleFollowAgent",
  "toggleJoinGroup",
  "createOffering",
  "createOfferingResource",
  "updateAgent",
  "createComment",
  "toggleReaction",
  "projectResourceBundle",
  "applyMembershipProjection",
  // Buyer-rail owner-routed actions (open-issues P0). Dispatched to this
  // instance's local action logic under a federation execution context when it
  // is the resource's home.
  "createBookingAction",
  "bookAssetAction",
  "applyToJob",
  "purchaseWithWalletAction",
] as const;

const INTERACTION_HANDLERS: Record<
  FederatedInteractionAction,
  (actorId: string, targetAgentId: string, payload?: Record<string, unknown>) => Promise<FederatedInteractionResult>
> = {
  connect: handleConnectAction,
  follow: handleConnectAction,
  react: createStubHandler("react"),
  rsvp: createStubHandler("rsvp"),
  thanks: createStubHandler("thanks"),
  message_thread_start: createStubHandler("message_thread_start"),
  membership_request: handleMembershipRequestAction,
  kg_push_doc: handleKgPushDoc,
  kg_query: handleKgQuery,
};

type MutationRequestBody = {
  type?: string;
  actorId?: string;
  targetAgentId?: string;
  payload?: unknown;
  action?: FederatedInteractionAction;
  actor?: FederatedActorContext;
  targetInstanceNodeId?: string;
  idempotencyKey?: string;
  routedFrom?: RoutingProvenance;
  /**
   * Home-signed actor identity voucher (buyer rail, open-issues P0). Additive;
   * old senders omit it. When the peer→actor binding does not yet exist, the
   * receiver verifies this against the authenticated peer's registered key and
   * materializes + binds the actor before dispatch. See
   * `@/lib/federation/owner-routed-actor`.
   */
  actorAssertion?: unknown;
};

export async function POST(request: Request) {
  const config = getInstanceConfig();

  try {
    const cookieToken = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
      ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);
    const remoteViewerToken = request.headers.get("X-Remote-Viewer-Token") || cookieToken || null;
    const remoteViewerSession = remoteViewerToken
      ? validateRemoteViewerToken(remoteViewerToken, config.instanceId)
      : null;

    const authorization = remoteViewerSession
      ? {
          authorized: true,
          actorId: remoteViewerSession.actorId,
        }
      : await authorizeFederationRequest(request);
    if (!authorization.authorized) {
      return NextResponse.json(
        {
          success: false,
          error: authorization.reason ?? "Authentication required",
        },
        { status: 401 },
      );
    }

    // Peer-side authority enforcement on sensitive mutations.
    // If the caller is acting via a remote viewer session, verify its asserted
    // home has not been revoked or superseded. `sensitive: true` bypasses the
    // TTL cache so a freshly-imported authority event takes immediate effect.
    if (remoteViewerSession) {
      const authorityCheck = await checkAuthorityForSession(
        remoteViewerSession.actorId,
        remoteViewerSession.homeBaseUrl,
        { sensitive: true },
      );
      if (!authorityCheck.allowed) {
        return NextResponse.json(
          {
            success: false,
            error:
              authorityCheck.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
                ? "Asserted home has been superseded by a successor authority claim"
                : "Asserted home has been revoked",
            errorCode:
              authorityCheck.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
                ? "HOME_AUTHORITY_SUPERSEDED"
                : "HOME_AUTHORITY_REVOKED",
            ...(authorityCheck.newHomeBaseUrl
              ? { newHomeBaseUrl: authorityCheck.newHomeBaseUrl }
              : {}),
          },
          { status: 403 },
        );
      }
    }

    // ── Visitor capability gate ────────────────────────────────────────────
    // Cookie-visitors are non-owner actors who hold only a rivr_remote_viewer
    // cookie (no peer-auth header). Owner and peer-authenticated requests
    // bypass this gate entirely.
    const isCookieVisitor =
      !!remoteViewerSession &&
      (!config.primaryAgentId ||
        remoteViewerSession.actorId !== config.primaryAgentId);
    if (isCookieVisitor) {
      // We need to peek at the action/type before full body parse — read and
      // re-attach by cloning. For the gate we only need action/type keys.
      let peekBody: MutationRequestBody = {};
      try {
        peekBody = (await request.clone().json()) as MutationRequestBody;
      } catch {
        // Malformed body — let the later parse surface the error.
      }
      const required = requiredVisitorCapability(
        peekBody.action ?? peekBody.type,
      );
      const visitorScope = await resolveVisitorScope();
      if (required === null || !visitorCan(visitorScope, required)) {
        return NextResponse.json(
          {
            success: false,
            accepted: false,
            error: `Visitor scope does not grant '${required ?? peekBody.action ?? peekBody.type}' on this instance.`,
            errorCode: "VISITOR_CAPABILITY_DENIED",
          },
          { status: 403 },
        );
      }
    }

    const remoteInstanceId = request.headers.get("X-Instance-Id");
    const remoteInstanceSlug = request.headers.get("X-Instance-Slug");

    if (!remoteInstanceId || !remoteInstanceSlug) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required headers: X-Instance-Id, X-Instance-Slug",
        },
        { status: 400 },
      );
    }

    const body = (await request.json()) as MutationRequestBody;
    const routedFrom = body.routedFrom ?? null;
    if (routedFrom) {
      const provenanceError = validateRoutingProvenance(routedFrom, remoteInstanceId);
      if (provenanceError) {
        return NextResponse.json({ success: false, error: provenanceError }, { status: 400 });
      }
    }

    if (body.action && body.actor) {
      return handleFederatedInteraction(
        body,
        config,
        remoteInstanceSlug,
        remoteInstanceId,
        request.headers.get("X-Remote-Viewer-Token"),
        routedFrom,
      );
    }

    // Bind the request to a verified, pre-mapped actor. For peer-secret auth
    // this resolves the body-supplied id to THIS instance's local agent id via
    // a pre-existing federation_entity_map row (handling both id directions) and
    // REJECTS when no binding exists — the shared secret never authorizes acting
    // as an arbitrary actor (F1). Downstream authority checks
    // (e.g. hasGroupWriteAccess for post-as-group) then run against the
    // receiver-local id.
    let actorBinding = await bindAuthorizedFederationActor(authorization, body.actorId);

    // Buyer-rail fallback (open-issues P0): a first-time cross-instance actor
    // (e.g. a dev/global user booking a group-homed offering) has no
    // pre-existing federation_entity_map row, so the strict F1 bind above
    // (correctly) rejects. If the forward carried a home-signed actorAssertion,
    // verify it against the AUTHENTICATED peer's registered Ed25519 key, burn
    // its nonce (single-use), and materialize + bind the actor via the
    // projection rail — THEN re-bind. Nothing here grants authority; identity is
    // vouched-for by the actor's home, and downstream authority still runs
    // against this instance's graph. Absent/invalid assertion → strict 403 as
    // before (no new failure mode, no receiver-side blind minting).
    if (
      (!actorBinding.authorized || !actorBinding.actorId) &&
      authorization.peerNodeId &&
      body.actorAssertion &&
      body.actorId
    ) {
      const { resolveOwnerRoutedActor } = await import(
        "@/lib/federation/owner-routed-actor"
      );
      const materialized = await resolveOwnerRoutedActor({
        peerNodeId: authorization.peerNodeId,
        audienceBaseUrl: config.baseUrl,
        requestedActorId: body.actorId,
        assertion: body.actorAssertion,
      });
      if (materialized.ok) {
        actorBinding = await bindAuthorizedFederationActor(authorization, body.actorId);
      } else {
        console.warn(
          `[federation/mutations] owner-routed actor assertion rejected: ${materialized.reason}`,
        );
      }
    }

    if (!actorBinding.authorized || !actorBinding.actorId) {
      return NextResponse.json(
        { success: false, error: actorBinding.reason ?? "Actor authorization failed" },
        { status: 403 },
      );
    }

    const effectiveActorId = actorBinding.actorId;

    // Unconditional peer-side authority enforcement (matches locale/region).
    // The session guard above only fires when a remote-viewer session asserts a
    // home; a peer-secret-bound mutation carries no homeBaseUrl and would
    // otherwise skip revocation entirely. checkAuthorityForActor looks up the
    // latest authority.revoke / successor.claim for the CLAIMED federated actor
    // id (the id space the authority-event cache is keyed by — the raw
    // body.actorId, NOT the entity-mapped local id) and rejects a
    // revoked/superseded home before dispatch. Fails open on a DB read error; a
    // no-revoke actor passes through untouched. body.actorId is guaranteed
    // present here — bindAuthorizedFederationActor above already rejected it
    // otherwise.
    const claimedActorId = body.actorId ?? effectiveActorId;
    const actorAuthority = await checkAuthorityForActor(claimedActorId);
    if (!actorAuthority.allowed) {
      return NextResponse.json(
        {
          success: false,
          error:
            actorAuthority.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
              ? "Actor home has been superseded by a successor authority claim"
              : "Actor home has been revoked",
          errorCode:
            actorAuthority.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
              ? "HOME_AUTHORITY_SUPERSEDED"
              : "HOME_AUTHORITY_REVOKED",
          ...(actorAuthority.newHomeBaseUrl
            ? { newHomeBaseUrl: actorAuthority.newHomeBaseUrl }
            : {}),
        },
        { status: 403 },
      );
    }

    return handleLegacyMutation(
      body,
      effectiveActorId,
      config,
      remoteInstanceSlug,
      remoteInstanceId,
      routedFrom,
    );
  } catch (error) {
    console.error("[federation/mutations] Error processing mutation:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to process mutation",
      },
      { status: 500 },
    );
  }
}

async function handleFederatedInteraction(
  body: MutationRequestBody,
  config: ReturnType<typeof getInstanceConfig>,
  remoteSlug: string,
  remoteId: string,
  remoteViewerToken?: string | null,
  routedFrom?: RoutingProvenance | null,
): Promise<NextResponse> {
  const { action, actor, targetAgentId, payload, idempotencyKey } = body;

  if (!action || !actor || !targetAgentId) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: action, actor, targetAgentId" },
      { status: 400 },
    );
  }

  if (!actor.actorId || !actor.homeBaseUrl || !actor.assertion) {
    return NextResponse.json(
      { success: false, error: "Actor context must include actorId, homeBaseUrl, and assertion" },
      { status: 400 },
    );
  }
  const assertionCheck = validateFederatedAssertion({
    token: actor.assertion,
    actorId: actor.actorId,
    homeBaseUrl: actor.homeBaseUrl,
    audienceBaseUrl: config.baseUrl,
    issuedAt: actor.issuedAt,
    expiresAt: actor.expiresAt,
  });
  if (!assertionCheck.valid) {
    return NextResponse.json(
      { success: false, error: `Invalid actor assertion: ${assertionCheck.error}` },
      { status: 401 },
    );
  }

  // Peer-side authority enforcement (sensitive path): any federated interaction
  // that asserts a home must be re-checked against the latest authority event
  // cache. Reject if the home is revoked or has been superseded.
  const actorAuthorityCheck = await checkAuthorityForSession(
    actor.actorId,
    actor.homeBaseUrl,
    { sensitive: true },
  );
  if (!actorAuthorityCheck.allowed) {
    return NextResponse.json(
      {
        success: false,
        error:
          actorAuthorityCheck.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
            ? "Asserted home has been superseded by a successor authority claim"
            : "Asserted home has been revoked",
        errorCode:
          actorAuthorityCheck.reason === AUTHORITY_GUARD_REASONS.SUPERSEDED_BY_SUCCESSOR
            ? "HOME_AUTHORITY_SUPERSEDED"
            : "HOME_AUTHORITY_REVOKED",
        ...(actorAuthorityCheck.newHomeBaseUrl
          ? { newHomeBaseUrl: actorAuthorityCheck.newHomeBaseUrl }
          : {}),
      },
      { status: 403 },
    );
  }

  if (remoteViewerToken) {
    const remoteViewerSession = validateRemoteViewerToken(remoteViewerToken, config.instanceId);
    if (!remoteViewerSession) {
      return NextResponse.json({ success: false, error: "Invalid remote viewer session" }, { status: 401 });
    }

    if (
      remoteViewerSession.actorId !== actor.actorId ||
      remoteViewerSession.homeBaseUrl !== actor.homeBaseUrl
    ) {
      return NextResponse.json(
        { success: false, error: "Remote viewer token does not match actor context" },
        { status: 401 },
      );
    }
  }

  const homeInstance = await resolveHomeInstance(targetAgentId);
  if (!homeInstance.isLocal) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent ${targetAgentId} is not local to this instance. Home: ${homeInstance.slug} (${homeInstance.nodeId})`,
      },
      { status: 421 },
    );
  }

  const handler = INTERACTION_HANDLERS[action];
  if (!handler) {
    return NextResponse.json(
      { success: false, error: `Unsupported interaction action: ${action}` },
      { status: 400 },
    );
  }

  console.log(`[federation/mutations] Federated interaction from ${remoteSlug} (${remoteId}):`, {
    action,
    actorId: actor.actorId,
    targetAgentId,
    idempotencyKey,
    routedFrom: routedFrom ? routedFrom.originInstanceSlug : null,
  });

  const result = await runWithFederationExecutionContext(
    actor.actorId,
    () => handler(actor.actorId, targetAgentId, (payload ?? {}) as Record<string, unknown>),
  );

  return NextResponse.json({
    ...result,
    instanceId: config.instanceId,
    action,
    ...(routedFrom
      ? {
          routedFrom: {
            originInstanceSlug: routedFrom.originInstanceSlug,
            originInstanceId: routedFrom.originInstanceId,
          },
        }
      : {}),
  });
}

async function handleConnectAction(
  actorId: string,
  targetAgentId: string,
): Promise<FederatedInteractionResult> {
  try {
    const result = await toggleFollowAgent(targetAgentId);
    const isConnect =
      result.message?.includes("now following") || result.message?.includes("connected") || false;

    await emitDomainEvent({
      eventType: isConnect ? EVENT_TYPES.FOLLOW_CREATED : EVENT_TYPES.FOLLOW_REMOVED,
      entityId: targetAgentId,
      entityType: "agent",
      actorId,
      payload: {
        action: "connect",
        targetAgentId,
        actorId,
        result,
      },
    });

    return {
      success: result.success,
      action: "connect",
      data: {
        message: result.message,
        isNowConnected: isConnect,
      },
      federationEventEmitted: true,
    };
  } catch (error) {
    return {
      success: false,
      action: "connect",
      error: error instanceof Error ? error.message : "Connect action failed",
      errorCode: "CONNECT_FAILED",
    };
  }
}

/**
 * Extracts the approval-relevant join options (answers / password / invite
 * token) from a federated membership_request payload, mirroring the shape the
 * front-end `requestGroupMembership` action accepts.
 */
function parseMembershipRequestOptions(
  payload?: Record<string, unknown>,
): { answers?: { questionId: string; answer: string }[]; password?: string; inviteToken?: string } {
  const rawAnswers = Array.isArray(payload?.answers) ? (payload!.answers as unknown[]) : [];
  const answers = rawAnswers
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const questionId = typeof record.questionId === "string" ? record.questionId : null;
      if (!questionId) return null;
      return {
        questionId,
        answer: typeof record.answer === "string" ? record.answer : "",
      };
    })
    .filter((entry): entry is { questionId: string; answer: string } => entry !== null);

  return {
    answers: answers.length > 0 ? answers : undefined,
    password: typeof payload?.password === "string" ? payload.password : undefined,
    inviteToken: typeof payload?.inviteToken === "string" ? payload.inviteToken : undefined,
  };
}

async function handleMembershipRequestAction(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const interactionType =
      typeof payload?.type === "string" && payload.type === "ring" ? "ring" : "group";

    // Rings have no joinSettings/approval queue; preserve the direct toggle.
    if (interactionType === "ring") {
      const result = await toggleJoinGroup(targetAgentId, "ring");
      return {
        success: result.success,
        action: "membership_request",
        data: {
          message: result.message,
          active: result.active ?? false,
          interactionType,
        },
        federationEventEmitted: Boolean(result.success),
      };
    }

    // Groups honor joinSettings: approval-required groups get a pending request
    // (no membership granted) instead of an instant join. This closes the
    // federation back-door where toggleJoinGroup bypassed the approval queue.
    const options = parseMembershipRequestOptions(payload);
    const result = await applyMembershipRequestForActor(actorId, targetAgentId, options);
    const joined = result.success && result.status === "joined";

    return {
      success: result.success,
      action: "membership_request",
      data: {
        message: result.success
          ? result.status === "requested"
            ? "Membership request submitted for approval."
            : "Joined group."
          : result.error,
        status: result.status,
        active: joined,
        requestId: result.requestId,
        membershipId: result.membershipId,
        interactionType,
      },
      // Only an actual membership change is a federation-visible event; a pending
      // request projects nothing to the home instance.
      federationEventEmitted: joined,
    };
  } catch (error) {
    return {
      success: false,
      action: "membership_request",
      error: error instanceof Error ? error.message : "Membership request failed",
      errorCode: "MEMBERSHIP_REQUEST_FAILED",
    };
  }
}

async function handleKgPushDoc(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const title = typeof payload?.title === "string" ? payload.title : "Federated Doc";
    const content = typeof payload?.content === "string" ? payload.content : "";
    const docType = typeof payload?.doc_type === "string" ? payload.doc_type : "document";
    const scopeType = typeof payload?.scope_type === "string" ? payload.scope_type : "group";
    const scopeId = typeof payload?.scope_id === "string" ? payload.scope_id : targetAgentId;

    // GRP-SEC-001 — verified-principal scope authorization. The caller-supplied
    // scope_id is NOT trusted: the verified actor must be entitled to write to
    // this scope, or it could push docs into any group's KG.
    const scopeAuth = await authorizeKgScope(actorId, scopeType, scopeId, "write");
    if (!scopeAuth.ok) {
      return {
        success: false,
        action: "kg_push_doc",
        error: scopeAuth.reason ?? "Not authorized for this KG scope",
        errorCode: "KG_SCOPE_FORBIDDEN",
      };
    }

    if (!content) {
      return {
        success: false,
        action: "kg_push_doc",
        error: "No content provided for KG ingestion",
        errorCode: "MISSING_CONTENT",
      };
    }

    const doc = await kg.createDoc({
      title,
      doc_type: docType,
      scope_type: scopeType,
      scope_id: scopeId,
      source_uri: `rivr://federation/${actorId}/doc`,
    });

    const result = await kg.ingestDoc(doc.id, content, undefined, title);

    await emitDomainEvent({
      eventType: "kg.doc_pushed",
      entityId: String(doc.id),
      entityType: "kg_doc",
      actorId,
      payload: {
        action: "kg_push_doc",
        docId: doc.id,
        title,
        scopeType,
        scopeId,
        triplesExtracted: result.regexTriplesExtracted + result.llmChunksQueued,
      },
    });

    return {
      success: true,
      action: "kg_push_doc",
      data: {
        docId: doc.id,
        title,
        ingestResult: result,
      },
      federationEventEmitted: true,
    };
  } catch (error) {
    return {
      success: false,
      action: "kg_push_doc",
      error: error instanceof Error ? error.message : "KG push doc failed",
      errorCode: "KG_PUSH_FAILED",
    };
  }
}

async function handleKgQuery(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const scopeType = typeof payload?.scope_type === "string" ? payload.scope_type : "group";
    const scopeId = typeof payload?.scope_id === "string" ? payload.scope_id : targetAgentId;
    const entity = typeof payload?.entity === "string" ? payload.entity : undefined;
    const predicate = typeof payload?.predicate === "string" ? payload.predicate : undefined;
    const maxResults = typeof payload?.max_results === "number" ? payload.max_results : undefined;

    // GRP-SEC-001 — verified-principal scope authorization. Without this, a
    // peer-authenticated actor could exfiltrate any group's KG triples by
    // naming an arbitrary scope_id it has no relationship to.
    const scopeAuth = await authorizeKgScope(actorId, scopeType, scopeId, "read");
    if (!scopeAuth.ok) {
      return {
        success: false,
        action: "kg_query",
        error: scopeAuth.reason ?? "Not authorized for this KG scope",
        errorCode: "KG_SCOPE_FORBIDDEN",
      };
    }

    const result = await kg.queryScope(scopeType, scopeId, {
      entity,
      predicate,
      max_results: maxResults,
    });

    return {
      success: true,
      action: "kg_query",
      data: {
        actorId,
        triples: result.triples,
        count: result.count,
        scope: { type: scopeType, id: scopeId },
      },
    };
  } catch (error) {
    return {
      success: false,
      action: "kg_query",
      error: error instanceof Error ? error.message : "KG query failed",
      errorCode: "KG_QUERY_FAILED",
    };
  }
}

function createStubHandler(
  action: FederatedInteractionAction,
): (actorId: string, targetAgentId: string, payload?: Record<string, unknown>) => Promise<FederatedInteractionResult> {
  return async (actorId, targetAgentId) => {
    console.log(`[federation/mutations] Stub handler for '${action}':`, { actorId, targetAgentId });
    return {
      success: false,
      action,
      error: `Action '${action}' is not yet implemented on this instance. Coming in Phase 2.`,
      errorCode: "ACTION_NOT_IMPLEMENTED",
    };
  };
}

async function handleLegacyMutation(
  body: MutationRequestBody,
  authorizedActorId: string,
  config: ReturnType<typeof getInstanceConfig>,
  remoteSlug: string,
  remoteId: string,
  routedFrom?: RoutingProvenance | null,
): Promise<NextResponse> {
  const { type, actorId, payload } = body;
  let { targetAgentId } = body;

  if (!type || !actorId || !targetAgentId) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: type, actorId, targetAgentId" },
      { status: 400 },
    );
  }

  // Normalize the TARGET through the entity map before the locality gate -
  // identity-normalized agents carry DIFFERENT ids per instance, so the raw
  // forwarded id can be unknown here and would 421 as "not local" even though
  // the target IS this instance's own agent. Read-only; unmapped ids pass
  // through unchanged.
  targetAgentId = await resolveLocalActorId(targetAgentId);

  const homeInstance = await resolveHomeInstance(targetAgentId);
  if (!homeInstance.isLocal) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent ${targetAgentId} is not local to this instance. Home: ${homeInstance.slug} (${homeInstance.nodeId})`,
      },
      { status: 421 },
    );
  }

  console.log(`[federation/mutations] Legacy mutation from ${remoteSlug} (${remoteId}):`, {
      type,
      actorId: authorizedActorId,
      targetAgentId,
      payloadKeys: payload && typeof payload === "object" ? Object.keys(payload as object) : [],
      routedFrom: routedFrom ? routedFrom.originInstanceSlug : null,
  });

  const isKnownType = (KNOWN_MUTATION_TYPES as readonly string[]).includes(type);

  if (type === "toggleFollowAgent") {
    const result = await runWithFederationExecutionContext(authorizedActorId, () => toggleFollowAgent(targetAgentId));
    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
    });
  }

  if (type === "toggleJoinGroup") {
    const interactionType =
      payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).type === "string"
        ? ((payload as Record<string, unknown>).type as "group" | "ring")
        : "group";

    // Groups: route a NON-member's join attempt through the approval-aware path
    // so approval-required groups create a pending request instead of an instant
    // membership. Existing members (leave toggle) and rings keep the direct
    // toggle. This closes the legacy back-door alongside the membership_request
    // interaction handler.
    if (interactionType === "group") {
      const membership = await isGroupMember(authorizedActorId, targetAgentId);
      if (!membership.isMember) {
        const options = parseMembershipRequestOptions(payload as Record<string, unknown> | undefined);
        const requestResult = await applyMembershipRequestForActor(authorizedActorId, targetAgentId, options);
        const joined = requestResult.success && requestResult.status === "joined";
        if (joined) {
          await mirrorMembershipProjectionToHomeInstance(authorizedActorId, targetAgentId, true).catch((error) => {
            console.error("[federation/mutations] Failed to mirror membership projection:", error);
          });
        }
        return NextResponse.json({
          success: requestResult.success,
          data: {
            success: requestResult.success,
            active: joined,
            status: requestResult.status,
            requestId: requestResult.requestId,
            membershipId: requestResult.membershipId,
            message: requestResult.success
              ? requestResult.status === "requested"
                ? "Membership request submitted for approval."
                : "Joined group."
              : requestResult.error,
          },
          knownType: true,
          instanceId: config.instanceId,
        });
      }
    }

    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      toggleJoinGroup(targetAgentId, interactionType),
    );

    if (result.success) {
      await mirrorMembershipProjectionToHomeInstance(authorizedActorId, targetAgentId, result.active === true).catch(
        (error) => {
          console.error("[federation/mutations] Failed to mirror membership projection:", error);
        },
      );
    }

    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
    });
  }

  if (type === "projectResourceBundle") {
    const result = await projectResourceBundle(targetAgentId, payload);
    return NextResponse.json({
      ...result,
      knownType: true,
      instanceId: config.instanceId,
    });
  }

  if (type === "createEventResource") {
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      createEventResource(withTargetOwner(payload, targetAgentId) as Parameters<typeof createEventResource>[0]),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    });
  }

  if (type === "createPostResource") {
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      createPostResource(withTargetOwner(payload, targetAgentId) as Parameters<typeof createPostResource>[0]),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    });
  }

  if (type === "createOffering" || type === "createOfferingResource") {
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      createOfferingResource(withTargetOwner(payload, targetAgentId) as Parameters<typeof createOfferingResource>[0]),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    });
  }

  // Cross-instance resource UPDATE. A peer admin (resolved to the local actor
  // via entity_map) edits a resource homed on this instance. updateResource's
  // own canModifyResource → hasGroupWriteAccess gate authorizes the resolved
  // actor exactly as a local session would, so no extra check is needed here.
  if (type === "updateResource") {
    const input = withTargetOwner(payload, targetAgentId) as unknown as UpdateResourceInput;
    const result = await runWithFederationExecutionContext(authorizedActorId, () => updateResource(input));
    return NextResponse.json(
      {
        success: result.success,
        data: result,
        accepted: result.success,
        knownType: true,
        instanceId: config.instanceId,
        ...(result.success ? {} : { error: result.message, errorCode: result.error?.code }),
        ...(routedFrom
          ? {
              routedFrom: {
                originInstanceSlug: routedFrom.originInstanceSlug,
                originInstanceId: routedFrom.originInstanceId,
              },
            }
          : {}),
      },
      { status: result.success ? 200 : 403 },
    );
  }

  // Cross-instance resource DELETE (soft-delete + delete-ledger row +
  // RESOURCE_DELETED domain event so the deletion federates back out and clears
  // peer projections). Same authorization path as a local delete.
  if (type === "deleteResource") {
    const resourceId =
      payload && typeof payload === "object"
        ? ((payload as Record<string, unknown>).resourceId as string | undefined)
        : undefined;
    if (!resourceId) {
      return NextResponse.json(
        { success: false, accepted: false, knownType: true, instanceId: config.instanceId, error: "resourceId is required" },
        { status: 400 },
      );
    }
    const result = await runWithFederationExecutionContext(authorizedActorId, () => deleteResource(resourceId));
    return NextResponse.json(
      {
        success: result.success,
        data: result,
        accepted: result.success,
        knownType: true,
        instanceId: config.instanceId,
        ...(result.success ? {} : { error: result.message, errorCode: result.error?.code }),
        ...(routedFrom
          ? {
              routedFrom: {
                originInstanceSlug: routedFrom.originInstanceSlug,
                originInstanceId: routedFrom.originInstanceId,
              },
            }
          : {}),
      },
      { status: result.success ? 200 : 403 },
    );
  }

  // ── Buyer-rail owner-routed actions (open-issues P0) ─────────────────────
  // A cross-instance buyer's booking/asset-booking/job-application/wallet
  // purchase is forwarded to the RESOURCE's home (this instance). The actor was
  // resolved above (pre-existing binding OR the verified home-signed assertion),
  // so run the local action under a federation execution context: its own
  // getCurrentUserId*()/getFederationExecutionContext() resolves to the bound
  // federated actor, and the action re-derives all authority + money effects
  // against THIS instance's graph. `targetAgentId` (the resource owner) already
  // passed the locality gate above. The actions carry their own idempotency /
  // rate-limit guards, so no extra check is added here.
  if (type === "createBookingAction") {
    const p = asPayloadObject(payload);
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      createBookingAction({
        offeringId: requireStringField(p.offeringId),
        slotDate: requireStringField(p.slotDate),
        slotTime: requireStringField(p.slotTime),
        notes: optionalStringField(p.notes),
      }),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      accepted: result.success,
      knownType: true,
      instanceId: config.instanceId,
      ...(result.success ? {} : { error: result.message }),
      ...routedFromEcho(routedFrom),
    });
  }

  if (type === "bookAssetAction") {
    const p = asPayloadObject(payload);
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      bookAssetAction({
        assetId: requireStringField(p.assetId),
        startDate: requireStringField(p.startDate),
        endDate: requireStringField(p.endDate),
        purpose: requireStringField(p.purpose),
        notes: optionalStringField(p.notes),
      }),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      accepted: result.success,
      knownType: true,
      instanceId: config.instanceId,
      ...(result.success ? {} : { error: result.message }),
      ...routedFromEcho(routedFrom),
    });
  }

  if (type === "applyToJob") {
    const p = asPayloadObject(payload);
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      applyToJob(requireStringField(p.jobId)),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      accepted: result.success,
      knownType: true,
      instanceId: config.instanceId,
      ...(result.success ? {} : { error: result.message }),
      ...routedFromEcho(routedFrom),
    });
  }

  if (type === "purchaseWithWalletAction") {
    const p = asPayloadObject(payload);
    const subtotalCents = p.subtotalCents;
    if (typeof subtotalCents !== "number" || !Number.isFinite(subtotalCents)) {
      return NextResponse.json(
        {
          success: false,
          accepted: false,
          knownType: true,
          instanceId: config.instanceId,
          error: "purchaseWithWalletAction requires numeric payload.subtotalCents",
        },
        { status: 400 },
      );
    }
    const result = await runWithFederationExecutionContext(authorizedActorId, () =>
      purchaseWithWalletAction(
        requireStringField(p.listingId),
        subtotalCents,
        optionalStringField(p.dealPostId),
        optionalStringField(p.bookingDate),
        optionalStringField(p.bookingSlot),
      ),
    );
    return NextResponse.json({
      success: result.success,
      data: result,
      accepted: result.success,
      knownType: true,
      instanceId: config.instanceId,
      ...(result.success ? {} : { error: result.error }),
      ...routedFromEcho(routedFrom),
    });
  }

  // Honesty contract (rivr-group#9): mutation types without a real dispatch
  // path must NOT claim acceptance. Returning a non-2xx with accepted:false
  // lets the forwarding instance surface a real error to the acting user
  // instead of silently dropping their write.
  return NextResponse.json(
    {
      success: false,
      accepted: false,
      instanceId: config.instanceId,
      knownType: isKnownType,
      errorCode: isKnownType ? "MUTATION_NOT_IMPLEMENTED" : "UNKNOWN_MUTATION_TYPE",
      error: isKnownType
        ? `Mutation type '${type}' is recognized but not yet implemented on this instance.`
        : `Mutation type '${type}' is not in the known dispatch map.`,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    },
    { status: isKnownType ? 501 : 400 },
  );
}

/** Coerce a mutation `payload` into a plain object for field extraction. */
function asPayloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Read a required string field. Returns "" for a missing/non-string value; the
 * called action validates and returns a structured `{ success: false }` error,
 * so we never throw here — the honest failure surfaces to the forwarding peer.
 */
function requireStringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read an optional string field, normalizing missing/non-string to undefined. */
function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Echo routing provenance back to the forwarder when present (audit continuity). */
function routedFromEcho(
  routedFrom: RoutingProvenance | null | undefined,
): Record<string, unknown> {
  return routedFrom
    ? {
        routedFrom: {
          originInstanceSlug: routedFrom.originInstanceSlug,
          originInstanceId: routedFrom.originInstanceId,
        },
      }
    : {};
}

function withTargetOwner(payload: unknown, targetAgentId: string): Record<string, unknown> {
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
  if (typeof base.ownerId !== "string" || base.ownerId.length === 0) {
    base.ownerId = targetAgentId;
  }
  if (typeof base.groupId !== "string" || base.groupId.length === 0) {
    base.groupId = targetAgentId;
  }
  return base;
}

function validateRoutingProvenance(
  provenance: RoutingProvenance,
  requestInstanceId: string,
): string | null {
  if (
    !provenance.originInstanceId ||
    !provenance.originInstanceSlug ||
    !provenance.originBaseUrl ||
    !provenance.originTimestamp
  ) {
    return "routedFrom is missing required fields: originInstanceId, originInstanceSlug, originBaseUrl, originTimestamp";
  }

  if (provenance.originInstanceId !== requestInstanceId) {
    return `routedFrom.originInstanceId (${provenance.originInstanceId}) does not match request X-Instance-Id (${requestInstanceId})`;
  }

  const routingFreshnessWindowMs = 5 * 60 * 1000;
  const originTime = new Date(provenance.originTimestamp).getTime();
  if (!Number.isFinite(originTime)) {
    return "routedFrom.originTimestamp is not a valid ISO 8601 timestamp";
  }
  const age = Date.now() - originTime;
  if (age > routingFreshnessWindowMs) {
    return `routedFrom.originTimestamp is too old (${Math.round(age / 1000)}s). Maximum age is ${routingFreshnessWindowMs / 1000}s.`;
  }
  if (age < -routingFreshnessWindowMs) {
    return "routedFrom.originTimestamp is in the future beyond acceptable clock skew";
  }

  return null;
}

async function mirrorMembershipProjectionToHomeInstance(
  actorId: string,
  groupId: string,
  joined: boolean,
): Promise<void> {
  const actor = await db.query.agents.findFirst({
    where: and(eq(agents.id, actorId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      name: true,
      metadata: true,
    },
  });
  const group = await db.query.agents.findFirst({
    where: and(eq(agents.id, groupId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      name: true,
      type: true,
      description: true,
      metadata: true,
    },
  });

  if (!actor || !group) return;

  const actorMetadata =
    actor.metadata && typeof actor.metadata === "object"
      ? (actor.metadata as Record<string, unknown>)
      : {};
  const groupMetadata =
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
  const homeBaseUrl =
    typeof actorMetadata.federatedHomeBaseUrl === "string"
      ? actorMetadata.federatedHomeBaseUrl
      : null;
  if (!homeBaseUrl) return;

  const response = await fetch(`${homeBaseUrl}/api/federation/mutations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instance-Id": getInstanceConfig().instanceId,
      "X-Instance-Slug": getInstanceConfig().instanceSlug,
      ...(process.env.NODE_ADMIN_KEY?.trim()
        ? { "X-Node-Admin-Key": process.env.NODE_ADMIN_KEY.trim() }
        : {}),
    },
    body: JSON.stringify({
      type: "applyMembershipProjection",
      actorId,
      targetAgentId: actorId,
      payload: {
        joined,
        role: joined ? "member" : "former_member",
        group: {
          id: group.id,
          name: group.name,
          type: group.type,
          description: group.description,
          metadata: groupMetadata,
          homeBaseUrl: getInstanceConfig().baseUrl,
          sourceOwner:
            groupMetadata.sourceOwner && typeof groupMetadata.sourceOwner === "object"
              ? groupMetadata.sourceOwner
              : null,
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Failed to mirror membership projection (${response.status}): ${message}`);
  }
}

async function projectResourceBundle(
  targetGroupId: string,
  payload: unknown,
): Promise<{
  success: boolean;
  data?: {
    groupId: string;
    offeringId: string;
    postId: string | null;
  };
  error?: string;
}> {
  const bundle =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const owner =
    bundle?.owner && typeof bundle.owner === "object"
      ? (bundle.owner as Record<string, unknown>)
      : null;
  const offering =
    bundle?.offering && typeof bundle.offering === "object"
      ? (bundle.offering as Record<string, unknown>)
      : null;
  const post =
    bundle?.post && typeof bundle.post === "object"
      ? (bundle.post as Record<string, unknown>)
      : null;

  const ownerId = typeof owner?.id === "string" ? owner.id : null;
  const ownerName = typeof owner?.name === "string" ? owner.name.trim() : "";
  const offeringId = typeof offering?.id === "string" ? offering.id : null;
  const offeringName = typeof offering?.name === "string" ? offering.name.trim() : "";

  if (!ownerId || !ownerName || !offeringId || !offeringName) {
    return { success: false, error: "Projected resource bundle requires owner and offering identity" };
  }

  const ownerImage = typeof owner?.image === "string" ? owner.image : null;
  const ownerDescription = typeof owner?.description === "string" ? owner.description : null;
  const ownerMetadata =
    owner?.metadata && typeof owner.metadata === "object"
      ? (owner.metadata as Record<string, unknown>)
      : {};
  const sourceBaseUrl =
    typeof owner?.homeBaseUrl === "string"
      ? owner.homeBaseUrl
      : typeof ownerMetadata.federatedHomeBaseUrl === "string"
        ? (ownerMetadata.federatedHomeBaseUrl as string)
        : null;

  await db
    .insert(agents)
    .values({
      id: ownerId,
      name: ownerName,
      type: "person",
      description: ownerDescription,
      image: ownerImage,
      visibility: "public",
      metadata: {
        ...ownerMetadata,
        ...(sourceBaseUrl ? { federatedHomeBaseUrl: sourceBaseUrl } : {}),
        federatedProjection: true,
        sourceType: "federated_owner_projection",
      },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        name: ownerName,
        description: ownerDescription,
        image: ownerImage,
        metadata: {
          ...ownerMetadata,
          ...(sourceBaseUrl ? { federatedHomeBaseUrl: sourceBaseUrl } : {}),
          federatedProjection: true,
          sourceType: "federated_owner_projection",
        },
        updatedAt: new Date(),
      },
    });

  const offeringMetadata =
    offering?.metadata && typeof offering.metadata === "object"
      ? (offering.metadata as Record<string, unknown>)
      : {};
  const offeringDescription =
    typeof offering?.description === "string" ? offering.description : null;

  await db
    .insert(resources)
    .values({
      id: offeringId,
      ownerId: targetGroupId,
      type: "listing",
      name: offeringName,
      description: offeringDescription,
      visibility: "public",
      metadata: {
        ...offeringMetadata,
        projectedOwnerId: ownerId,
        sourceType: "federated_projection",
      },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: resources.id,
      set: {
        ownerId: targetGroupId,
        name: offeringName,
        description: offeringDescription,
        metadata: {
          ...offeringMetadata,
          projectedOwnerId: ownerId,
          sourceType: "federated_projection",
        },
        updatedAt: new Date(),
      },
    });

  let postId: string | null = null;
  if (post) {
    const candidate = typeof post.id === "string" ? post.id : null;
    const postTitle = typeof post.title === "string" ? post.title.trim() : "";
    if (candidate && postTitle) {
      const postMetadata =
        post.metadata && typeof post.metadata === "object"
          ? (post.metadata as Record<string, unknown>)
          : {};
      const postDescription =
        typeof post.content === "string"
          ? post.content
          : typeof post.description === "string"
            ? post.description
            : null;
      postId = candidate;

      await db
        .insert(resources)
        .values({
          id: candidate,
          ownerId: targetGroupId,
          type: "post",
          name: postTitle,
          description: postDescription,
          visibility: "public",
          metadata: {
            ...postMetadata,
            projectedOwnerId: ownerId,
            projectedOfferingId: offeringId,
            sourceType: "federated_projection",
          },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            ownerId: targetGroupId,
            name: postTitle,
            description: postDescription,
            metadata: {
              ...postMetadata,
              projectedOwnerId: ownerId,
              projectedOfferingId: offeringId,
              sourceType: "federated_projection",
            },
            updatedAt: new Date(),
          },
        });
    }
  }

  return {
    success: true,
    data: {
      groupId: targetGroupId,
      offeringId,
      postId,
    },
  };
}
