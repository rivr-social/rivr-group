import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveLocalActorId } from "@/lib/federation/resolution";
import { REMOTE_VIEWER_COOKIE_NAME, validateRemoteViewerToken } from "@/lib/federation-remote-session";

export async function GET(request: Request) {
  const cookieToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
    ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);

  if (!cookieToken) {
    return NextResponse.json({ success: false, error: "No remote session cookie" }, { status: 401 });
  }

  const config = getInstanceConfig();
  const session = validateRemoteViewerToken(cookieToken, config.instanceId);
  if (!session) {
    return NextResponse.json({ success: false, error: "Invalid remote session cookie" }, { status: 401 });
  }

  // The cookie carries the actor's HOME id verbatim; their local projection
  // lives under the entity-map-normalized agent id. Without this the lookup
  // misses and every SSO visitor renders as a nameless "Federated user".
  const localActorId = await resolveLocalActorId(session.actorId);
  const actor = await db.query.agents.findFirst({
    where: and(eq(agents.id, localActorId), isNull(agents.deletedAt)),
    columns: {
      name: true,
      image: true,
    },
  });

  return NextResponse.json({
    success: true,
    viewerState: "remotely_authenticated",
    actorId: session.actorId,
    localActorId,
    homeBaseUrl: session.homeBaseUrl,
    displayName: actor?.name ?? session.displayName ?? "Federated user",
    image: actor?.image ?? session.image ?? null,
    persona: session.persona ?? null,
    sessionToken: cookieToken,
  });
}

export async function DELETE(request: Request) {
  const response = NextResponse.json({ success: true, cleared: true });
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, "", {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
