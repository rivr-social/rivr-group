import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, ledger, nodes } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  createRemoteViewerToken,
  REMOTE_VIEWER_COOKIE_NAME,
  REMOTE_VIEWER_TTL_MS,
  type FederatedAssertionPersonaContext,
} from "@/lib/federation-remote-session";
import { resolveRequestOrigin } from "@/lib/request-origin";

const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;
const MAX_ASSERTION_FUTURE_MS = 60 * 1000;

type AssertionType = "session" | "token" | "signed";

type FederatedActorContext = {
  actorId: string;
  homeBaseUrl: string;
  assertionType: AssertionType;
  assertion: string;
  issuedAt: string;
  expiresAt: string;
  manifestUrl?: string;
};

type RemoteAuthResult = {
  success: boolean;
  viewerState: "anonymous" | "remotely_authenticated";
  sessionToken?: string;
  actorId?: string;
  homeBaseUrl?: string;
  displayName?: string;
  persona?: FederatedAssertionPersonaContext;
  error?: string;
  errorCode?: string;
  bootstrap?: {
    applied: boolean;
    groupType?: "organization" | "family" | "ring";
    primaryAgentId?: string;
  };
};

type VerificationResult = {
  valid: boolean;
  displayName?: string;
  manifestUrl?: string;
  persona?: FederatedAssertionPersonaContext;
  error?: string;
};

function normalizeRedirectPath(path: string | null): string {
  if (!path) return "/";
  if (!path.startsWith("/")) return "/";
  if (path.startsWith("//")) return "/";
  return path;
}

function normalizeGroupType(value: string | null): "organization" | "family" | "ring" | null {
  if (!value) return null;
  const type = value.trim().toLowerCase();
  if (type === "org") return "organization";
  if (type === "organization" || type === "family" || type === "ring") return type;
  return null;
}

function mapGroupTypeToAgentType(groupType: "organization" | "family" | "ring"): "organization" | "family" | "ring" {
  if (groupType === "family") return "family";
  if (groupType === "ring") return "ring";
  return "organization";
}

function inferBootstrapGroupType(primary: {
  type?: string | null;
  metadata?: Record<string, unknown> | null;
} | null | undefined): "organization" | "family" | "ring" {
  if (!primary) return "organization";
  const metadata = (primary.metadata ?? {}) as Record<string, unknown>;
  const metadataGroupType =
    typeof metadata.groupType === "string" ? normalizeGroupType(metadata.groupType) : null;
  if (metadataGroupType) return metadataGroupType;

  const agentType = typeof primary.type === "string" ? normalizeGroupType(primary.type) : null;
  if (agentType) return agentType;

  return "organization";
}

function validateActorContext(ctx: Partial<FederatedActorContext>): string | null {
  if (!ctx.actorId || typeof ctx.actorId !== "string") return "actorId is required";
  if (!ctx.homeBaseUrl || typeof ctx.homeBaseUrl !== "string") return "homeBaseUrl is required";
  try {
    const url = new URL(ctx.homeBaseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "homeBaseUrl must be http/https";
  } catch {
    return "homeBaseUrl must be a valid URL";
  }
  if (!ctx.assertionType || !["session", "token", "signed"].includes(ctx.assertionType)) {
    return "assertionType must be one of: session, token, signed";
  }
  if (!ctx.assertion || typeof ctx.assertion !== "string") return "assertion is required";
  if (!ctx.issuedAt || typeof ctx.issuedAt !== "string") return "issuedAt is required";
  if (!ctx.expiresAt || typeof ctx.expiresAt !== "string") return "expiresAt is required";
  return null;
}

function validateAssertionTiming(ctx: FederatedActorContext): string | null {
  const now = Date.now();
  const issuedAt = new Date(ctx.issuedAt).getTime();
  const expiresAt = new Date(ctx.expiresAt).getTime();
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return "issuedAt and expiresAt must be valid ISO timestamps";
  }
  if (issuedAt > now + MAX_ASSERTION_FUTURE_MS) return "Assertion issuedAt is in the future";
  if (now - issuedAt > MAX_ASSERTION_AGE_MS) return "Assertion too old";
  if (expiresAt <= now) return "Assertion expired";
  return null;
}

async function verifyActorAssertionWithHome(
  ctx: FederatedActorContext,
  targetBaseUrl: string,
): Promise<VerificationResult> {
  const homeBaseUrl = ctx.homeBaseUrl.replace(/\/+$/, "");
  const verifyUrl = `${homeBaseUrl}/api/federation/remote-assertion/verify`;

  try {
    const response = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        actorId: ctx.actorId,
        homeBaseUrl: ctx.homeBaseUrl,
        targetBaseUrl,
        assertion: ctx.assertion,
        issuedAt: ctx.issuedAt,
        expiresAt: ctx.expiresAt,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok || data.valid !== true) {
      return {
        valid: false,
        error:
          typeof data.error === "string"
            ? data.error
            : `Home verification failed (${response.status})`,
      };
    }

    // Extract persona context if present in the verification response
    let persona: FederatedAssertionPersonaContext | undefined;
    if (
      data.persona &&
      typeof data.persona === "object" &&
      typeof (data.persona as Record<string, unknown>).personaId === "string" &&
      typeof (data.persona as Record<string, unknown>).parentAgentId === "string"
    ) {
      const p = data.persona as Record<string, unknown>;
      persona = {
        personaId: p.personaId as string,
        parentAgentId: p.parentAgentId as string,
        ...(typeof p.personaDisplayName === "string"
          ? { personaDisplayName: p.personaDisplayName }
          : {}),
      };
    }

    return {
      valid: true,
      displayName: typeof data.displayName === "string" ? data.displayName : undefined,
      manifestUrl: typeof data.manifestUrl === "string" ? data.manifestUrl : undefined,
      persona,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? `Home instance unreachable: ${error.message}` : "Home instance unreachable",
    };
  }
}

async function bootstrapPrimaryGroup(params: {
  actorId: string;
  homeBaseUrl: string;
  displayName?: string;
  manifestUrl?: string;
  requestedGroupType: "organization" | "family" | "ring";
}): Promise<{ applied: boolean; primaryAgentId?: string; groupType?: "organization" | "family" | "ring" }> {
  const config = getInstanceConfig();
  if (!config.primaryAgentId) {
    return { applied: false };
  }

  const primary = await db.query.agents.findFirst({
    where: and(eq(agents.id, config.primaryAgentId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      metadata: true,
    },
  });
  if (!primary) {
    return { applied: false };
  }

  const now = new Date();
  const metadata = (primary.metadata ?? {}) as Record<string, unknown>;
  const existingSourceOwner =
    metadata.sourceOwner && typeof metadata.sourceOwner === "object"
      ? (metadata.sourceOwner as Record<string, unknown>)
      : null;

  if (
    existingSourceOwner &&
    typeof existingSourceOwner.actorId === "string" &&
    existingSourceOwner.actorId.length > 0 &&
    existingSourceOwner.actorId !== params.actorId
  ) {
    return { applied: false, primaryAgentId: primary.id };
  }

  const existingActor = await db.query.agents.findFirst({
    where: and(eq(agents.id, params.actorId), isNull(agents.deletedAt)),
    columns: { id: true, metadata: true },
  });

  if (!existingActor) {
    await db.insert(agents).values({
      id: params.actorId,
      name: params.displayName?.trim() || "Federated user",
      type: "person",
      visibility: "public",
      peermeshManifestUrl: params.manifestUrl ?? null,
      peermeshLinkedAt: now,
      metadata: {
        federatedHomeBaseUrl: params.homeBaseUrl,
        federatedOwner: true,
        sourceType: "federated_home_instance",
      },
      updatedAt: now,
    });
  } else {
    const actorMetadata =
      existingActor.metadata && typeof existingActor.metadata === "object"
        ? (existingActor.metadata as Record<string, unknown>)
        : {};
    await db
      .update(agents)
      .set({
        name: params.displayName?.trim() || undefined,
        peermeshManifestUrl: params.manifestUrl ?? null,
        peermeshLinkedAt: now,
        metadata: {
          ...actorMetadata,
          federatedHomeBaseUrl: params.homeBaseUrl,
          federatedOwner: true,
          sourceType: "federated_home_instance",
        },
        updatedAt: now,
      })
      .where(eq(agents.id, params.actorId));
  }

  const existingMembership = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, params.actorId),
      eq(ledger.objectId, primary.id),
      eq(ledger.verb, "join"),
      eq(ledger.isActive, true),
    ),
    columns: { id: true },
  });

  if (!existingMembership) {
    await db.insert(ledger).values({
      verb: "join",
      subjectId: params.actorId,
      objectId: primary.id,
      objectType: "agent",
      role: "admin",
      isActive: true,
      visibility: "public",
      timestamp: now,
      metadata: {
        grantType: "federated_bootstrap",
        sourceOwner: true,
        homeBaseUrl: params.homeBaseUrl,
      },
    });
  }

  const existingAdminIds = Array.isArray(metadata.adminIds)
    ? metadata.adminIds.filter((value): value is string => typeof value === "string")
    : [];
  const adminIds = Array.from(new Set([...existingAdminIds, params.actorId]));
  const nextCreatorId =
    typeof metadata.creatorId === "string" && metadata.creatorId.length > 0
      ? metadata.creatorId
      : params.actorId;

  await db
    .update(agents)
    .set({
      type: mapGroupTypeToAgentType(params.requestedGroupType),
      metadata: {
        ...metadata,
        groupType: params.requestedGroupType,
        creatorId: nextCreatorId,
        adminIds,
        sourceOwner: {
          actorId: params.actorId,
          homeBaseUrl: params.homeBaseUrl,
          linkedAt: now.toISOString(),
        },
      },
      updatedAt: now,
    })
    .where(eq(agents.id, primary.id));

  await db
    .update(nodes)
    .set({
      ownerAgentId: params.actorId,
      primaryAgentId: primary.id,
      updatedAt: now,
    })
    .where(eq(nodes.id, config.instanceId));

  return {
    applied: true,
    primaryAgentId: primary.id,
    groupType: params.requestedGroupType,
  };
}

async function mirrorBootstrapMembershipToHome(params: {
  actorId: string;
  homeBaseUrl: string;
  primaryAgentId: string;
}): Promise<void> {
  const group = await db.query.agents.findFirst({
    where: and(eq(agents.id, params.primaryAgentId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      name: true,
      type: true,
      description: true,
      metadata: true,
    },
  });
  if (!group) return;

  const config = getInstanceConfig();
  const groupMetadata =
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};

  const response = await fetch(`${params.homeBaseUrl}/api/federation/mutations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instance-Id": config.instanceId,
      "X-Instance-Slug": config.instanceSlug,
      ...(process.env.NODE_ADMIN_KEY?.trim()
        ? { "X-Node-Admin-Key": process.env.NODE_ADMIN_KEY.trim() }
        : {}),
    },
    body: JSON.stringify({
      type: "applyMembershipProjection",
      actorId: params.actorId,
      targetAgentId: params.actorId,
      payload: {
        joined: true,
        role: "admin",
        group: {
          id: group.id,
          name: group.name,
          type: group.type,
          description: group.description,
          metadata: groupMetadata,
          homeBaseUrl: config.baseUrl,
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
    throw new Error(`Failed to mirror bootstrap membership (${response.status}): ${message}`);
  }
}

function buildError(error: string, code: string, status = 401) {
  return NextResponse.json(
    {
      success: false,
      viewerState: "anonymous",
      error,
      errorCode: code,
    } satisfies RemoteAuthResult,
    { status },
  );
}

async function authenticateActor(
  actorContext: Partial<FederatedActorContext>,
  targetBaseUrl: string,
  requestedGroupType?: "organization" | "family" | "ring" | null,
): Promise<
  | { ok: true; result: RemoteAuthResult; token: string }
  | { ok: false; response: NextResponse }
> {
  const validationError = validateActorContext(actorContext);
  if (validationError) {
    return {
      ok: false,
      response: buildError(validationError, "INVALID_ACTOR_CONTEXT", 400),
    };
  }

  const context = actorContext as FederatedActorContext;
  const timingError = validateAssertionTiming(context);
  if (timingError) {
    return {
      ok: false,
      response: buildError(timingError, "ASSERTION_TIMING_ERROR", 401),
    };
  }

  const verification = await verifyActorAssertionWithHome(context, targetBaseUrl);
  if (!verification.valid) {
    return {
      ok: false,
      response: buildError(
        verification.error || "Actor assertion verification failed",
        "ASSERTION_VERIFICATION_FAILED",
        401,
      ),
    };
  }

  const config = getInstanceConfig();
  const sessionToken = createRemoteViewerToken({
    actorId: context.actorId,
    homeBaseUrl: context.homeBaseUrl,
    localInstanceId: config.instanceId,
    persona: verification.persona,
  });

  const primary = config.primaryAgentId
    ? await db.query.agents.findFirst({
        where: and(eq(agents.id, config.primaryAgentId), isNull(agents.deletedAt)),
        columns: {
          id: true,
          type: true,
          metadata: true,
        },
      })
    : null;
  const primaryMetadata =
    primary?.metadata && typeof primary.metadata === "object"
      ? (primary.metadata as Record<string, unknown>)
      : {};
  const existingSourceOwner =
    primaryMetadata.sourceOwner && typeof primaryMetadata.sourceOwner === "object"
      ? (primaryMetadata.sourceOwner as Record<string, unknown>)
      : null;
  const shouldAutoBootstrap =
    config.instanceType === "group" &&
    !!config.primaryAgentId &&
    (!existingSourceOwner || typeof existingSourceOwner.actorId !== "string" || existingSourceOwner.actorId.length === 0);
  const effectiveGroupType = requestedGroupType ?? (shouldAutoBootstrap ? inferBootstrapGroupType(primary) : null);

  let bootstrap: RemoteAuthResult["bootstrap"] | undefined;
  if (effectiveGroupType) {
    const result = await bootstrapPrimaryGroup({
      actorId: context.actorId,
      homeBaseUrl: context.homeBaseUrl,
      displayName: verification.displayName,
      manifestUrl: verification.manifestUrl,
      requestedGroupType: effectiveGroupType,
    });
    bootstrap = {
      applied: result.applied,
      groupType: result.groupType,
      primaryAgentId: result.primaryAgentId,
    };
    if (result.applied && result.primaryAgentId) {
      await mirrorBootstrapMembershipToHome({
        actorId: context.actorId,
        homeBaseUrl: context.homeBaseUrl,
        primaryAgentId: result.primaryAgentId,
      }).catch((error) => {
        console.error("[federation/remote-auth] Failed to mirror bootstrap membership:", error);
      });
    }
  }

  return {
    ok: true,
    token: sessionToken,
    result: {
      success: true,
      viewerState: "remotely_authenticated",
      sessionToken,
      actorId: context.actorId,
      homeBaseUrl: context.homeBaseUrl,
      displayName: verification.displayName,
      persona: verification.persona,
      bootstrap,
    },
  };
}

function attachRemoteViewerCookie(response: NextResponse, requestUrl: URL, token: string): void {
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: requestUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(REMOTE_VIEWER_TTL_MS / 1000),
  });
}

export async function POST(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const config = getInstanceConfig();
    const publicOrigin = resolveRequestOrigin(request, config.baseUrl);
    const body = (await request.json()) as Partial<FederatedActorContext> & {
      groupType?: string;
    };
    const requestedGroupType = normalizeGroupType(body.groupType ?? null);
    const auth = await authenticateActor(
      body,
      publicOrigin,
      requestedGroupType,
    );
    if (!auth.ok) return auth.response;

    const response = NextResponse.json(auth.result);
    attachRemoteViewerCookie(response, requestUrl, auth.token);
    return response;
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : "Failed to process remote authentication",
      "INTERNAL_ERROR",
      500,
    );
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const config = getInstanceConfig();
  const publicOrigin = resolveRequestOrigin(request, config.baseUrl);
  const requestedGroupType = normalizeGroupType(requestUrl.searchParams.get("groupType"));
  const actorContext: Partial<FederatedActorContext> = {
    actorId: requestUrl.searchParams.get("actorId") ?? undefined,
    homeBaseUrl: requestUrl.searchParams.get("homeBaseUrl") ?? undefined,
    assertionType: (requestUrl.searchParams.get("assertionType") as AssertionType | null) ?? undefined,
    assertion: requestUrl.searchParams.get("assertion") ?? undefined,
    issuedAt: requestUrl.searchParams.get("issuedAt") ?? undefined,
    expiresAt: requestUrl.searchParams.get("expiresAt") ?? undefined,
    manifestUrl: requestUrl.searchParams.get("manifestUrl") ?? undefined,
  };

  const auth = await authenticateActor(
    actorContext,
    publicOrigin,
    requestedGroupType,
  );
  if (!auth.ok) return auth.response;

  const redirectPath = normalizeRedirectPath(requestUrl.searchParams.get("redirect"));
  const response = NextResponse.redirect(new URL(redirectPath, publicOrigin));
  attachRemoteViewerCookie(response, requestUrl, auth.token);
  return response;
}
