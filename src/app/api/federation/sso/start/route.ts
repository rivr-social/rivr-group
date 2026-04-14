import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveRequestOrigin } from "@/lib/request-origin";
function normalizePath(path: string | null): string {
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
  const config = getInstanceConfig();
  const requestUrl = new URL(request.url);
  const homeBaseUrl = requestUrl.searchParams.get("homeBaseUrl");

  if (!homeBaseUrl) {
    return NextResponse.json({ success: false, error: "homeBaseUrl is required" }, { status: 400 });
  }

  let home: URL;
  try {
    home = new URL(homeBaseUrl);
  } catch {
    return NextResponse.json({ success: false, error: "homeBaseUrl must be a valid URL" }, { status: 400 });
  }

  const returnPath = normalizePath(requestUrl.searchParams.get("returnPath"));
  const consent = requestUrl.searchParams.get("consent");
  const spatialFabricRef = requestUrl.searchParams.get("spatialFabricRef");
  const fields = requestUrl.searchParams.get("fields");
  const groupType = normalizeGroupType(requestUrl.searchParams.get("groupType"));
  const targetBaseUrl = resolveRequestOrigin(request, config.baseUrl);

  const issueUrl = new URL("/api/federation/remote-assertion/issue", home.origin);
  issueUrl.searchParams.set("targetBaseUrl", targetBaseUrl);
  issueUrl.searchParams.set("returnPath", returnPath);
  if (consent) issueUrl.searchParams.set("consent", consent);
  if (spatialFabricRef) issueUrl.searchParams.set("spatialFabricRef", spatialFabricRef);
  if (fields) issueUrl.searchParams.set("fields", fields);
  if (groupType) issueUrl.searchParams.set("groupType", groupType);

  return NextResponse.redirect(issueUrl);
}
