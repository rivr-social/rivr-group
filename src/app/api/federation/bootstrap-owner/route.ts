import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { REMOTE_VIEWER_COOKIE_NAME, validateRemoteViewerToken } from "@/lib/federation-remote-session";

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

export async function POST(request: Request) {
  const config = getInstanceConfig();
  const cookieToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
    ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);

  if (!cookieToken) {
    return NextResponse.json({ success: false, error: "No remote session cookie" }, { status: 401 });
  }

  const session = validateRemoteViewerToken(cookieToken, config.instanceId);
  if (!session) {
    return NextResponse.json({ success: false, error: "Invalid remote session cookie" }, { status: 401 });
  }

  if (!config.primaryAgentId) {
    return NextResponse.json(
      { success: false, error: "This group instance has no PRIMARY_AGENT_ID configured" },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => ({} as Record<string, unknown>))) as {
    groupType?: string;
  };
  const groupType = normalizeGroupType(typeof body.groupType === "string" ? body.groupType : null);
  if (!groupType) {
    return NextResponse.json(
      { success: false, error: "groupType is required (organization | family | ring)" },
      { status: 400 },
    );
  }

  const primary = await db.query.agents.findFirst({
    where: and(eq(agents.id, config.primaryAgentId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      metadata: true,
    },
  });
  if (!primary) {
    return NextResponse.json({ success: false, error: "Primary group agent not found" }, { status: 404 });
  }

  const metadata = (primary.metadata ?? {}) as Record<string, unknown>;
  const existingAdminIds = Array.isArray(metadata.adminIds)
    ? metadata.adminIds.filter((value): value is string => typeof value === "string")
    : [];
  const adminIds = Array.from(new Set([...existingAdminIds, session.actorId]));
  const now = new Date();

  await db
    .update(agents)
    .set({
      type: mapGroupTypeToAgentType(groupType),
      metadata: {
        ...metadata,
        groupType,
        adminIds,
        sourceOwner: {
          actorId: session.actorId,
          homeBaseUrl: session.homeBaseUrl,
          linkedAt: now.toISOString(),
        },
      },
      updatedAt: now,
    })
    .where(eq(agents.id, primary.id));

  return NextResponse.json({
    success: true,
    groupType,
    primaryAgentId: primary.id,
    sourceOwner: {
      actorId: session.actorId,
      homeBaseUrl: session.homeBaseUrl,
    },
  });
}
