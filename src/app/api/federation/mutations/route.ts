import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { runWithFederationExecutionContext } from "@/lib/federation/execution-context";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation/domain-events";
import {
  REMOTE_VIEWER_COOKIE_NAME,
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
import * as kg from "@/lib/kg/autobot-kg-client";

const KNOWN_MUTATION_TYPES = [
  "createGroupResource",
  "updateGroupResource",
  "deleteGroupResource",
  "createPostResource",
  "createEventResource",
  "toggleFollowAgent",
  "toggleJoinGroup",
  "createOffering",
  "updateAgent",
  "createComment",
  "toggleReaction",
  "projectResourceBundle",
  "applyMembershipProjection",
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

    return handleLegacyMutation(body, config, remoteInstanceSlug, remoteInstanceId, routedFrom);
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

async function handleMembershipRequestAction(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const interactionType =
      typeof payload?.type === "string" && payload.type === "ring" ? "ring" : "group";
    const result = await toggleJoinGroup(targetAgentId, interactionType);

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
  config: ReturnType<typeof getInstanceConfig>,
  remoteSlug: string,
  remoteId: string,
  routedFrom?: RoutingProvenance | null,
): Promise<NextResponse> {
  const { type, actorId, targetAgentId, payload } = body;

  if (!type || !actorId || !targetAgentId) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: type, actorId, targetAgentId" },
      { status: 400 },
    );
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

  console.log(`[federation/mutations] Legacy mutation from ${remoteSlug} (${remoteId}):`, {
    type,
    actorId,
    targetAgentId,
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload as object) : [],
    routedFrom: routedFrom ? routedFrom.originInstanceSlug : null,
  });

  const isKnownType = (KNOWN_MUTATION_TYPES as readonly string[]).includes(type);

  if (type === "toggleFollowAgent") {
    const result = await runWithFederationExecutionContext(actorId, () => toggleFollowAgent(targetAgentId));
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
    const result = await runWithFederationExecutionContext(actorId, () =>
      toggleJoinGroup(targetAgentId, interactionType),
    );

    if (result.success) {
      await mirrorMembershipProjectionToHomeInstance(actorId, targetAgentId, result.active === true).catch(
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

  return NextResponse.json({
    success: true,
    phase: "forwarding-stub",
    instanceId: config.instanceId,
    accepted: true,
    knownType: isKnownType,
    message: isKnownType
      ? `Mutation type '${type}' recognized. Dispatch pending full implementation.`
      : `Mutation type '${type}' not in known dispatch map. Logged for review.`,
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
