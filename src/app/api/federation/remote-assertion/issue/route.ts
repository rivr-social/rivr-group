import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { createFederatedAssertion } from "@/lib/federation-remote-session";

function normalizeRemotePath(path: string | null): string {
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

export async function GET(request: Request) {
  const session = await auth();
  const config = getInstanceConfig();
  const requestUrl = new URL(request.url);

  if (!session?.user?.id) {
    const callbackUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, config.baseUrl).toString();
    const callback = encodeURIComponent(callbackUrl);
    return NextResponse.redirect(new URL(`/auth/login?callbackUrl=${callback}`, config.baseUrl));
  }

  const targetBaseUrl = requestUrl.searchParams.get("targetBaseUrl");
  if (!targetBaseUrl) {
    return NextResponse.json(
      { success: false, error: "targetBaseUrl is required" },
      { status: 400 },
    );
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetBaseUrl);
  } catch {
    return NextResponse.json(
      { success: false, error: "targetBaseUrl must be a valid URL" },
      { status: 400 },
    );
  }

  const returnPath = normalizeRemotePath(requestUrl.searchParams.get("returnPath"));
  const spatialFabricRef = requestUrl.searchParams.get("spatialFabricRef");
  const consent = requestUrl.searchParams.get("consent");
  const fieldsParam = requestUrl.searchParams.get("fields");
  const requestedDataFields = fieldsParam
    ? fieldsParam
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field.length > 0)
    : undefined;

  const actor = await db.query.agents.findFirst({
    where: and(eq(agents.id, session.user.id), isNull(agents.deletedAt)),
    columns: {
      id: true,
      name: true,
      peermeshManifestUrl: true,
    },
  });
  if (!actor) {
    return NextResponse.json({ success: false, error: "Actor not found" }, { status: 404 });
  }

  const { token, payload } = createFederatedAssertion({
    actorId: actor.id,
    homeBaseUrl: config.baseUrl.replace(/\/+$/, ""),
    audienceBaseUrl: parsedTarget.origin,
    manifestUrl: actor.peermeshManifestUrl ?? undefined,
    displayName: actor.name ?? undefined,
    consentScopes: consent ? [consent] : undefined,
    spatialFabricRefs: spatialFabricRef ? [spatialFabricRef] : undefined,
    dataFields: requestedDataFields,
    capabilityScopes: ["federation.login", "federation.mutate", "federation.docs.read"],
  });

  const redirectUrl = new URL("/api/federation/remote-auth", parsedTarget.origin);
  redirectUrl.searchParams.set("actorId", actor.id);
  redirectUrl.searchParams.set("homeBaseUrl", config.baseUrl.replace(/\/+$/, ""));
  redirectUrl.searchParams.set("assertionType", "signed");
  redirectUrl.searchParams.set("assertion", token);
  redirectUrl.searchParams.set("issuedAt", payload.issuedAt);
  redirectUrl.searchParams.set("expiresAt", payload.expiresAt);
  redirectUrl.searchParams.set("redirect", returnPath);
  const groupType = normalizeGroupType(requestUrl.searchParams.get("groupType"));
  if (groupType) {
    redirectUrl.searchParams.set("groupType", groupType);
  }
  if (payload.manifestUrl) {
    redirectUrl.searchParams.set("manifestUrl", payload.manifestUrl);
  }

  return NextResponse.redirect(redirectUrl);
}
