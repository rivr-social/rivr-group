/**
 * @fileoverview Builder custom-domain API — verify and bind a published site's
 * custom domain so host-dispatch serves it (ported from the person app; group
 * adaptation).
 *
 *   GET    /api/builder/domain?target=<agentId>  -> state + app hostname +
 *                                                   required DNS records.
 *   POST   /api/builder/domain    -> discriminated by `action`:
 *            { action: "verify", domain, targetAgentId? }  node:dns check the
 *                                    domain resolves to the app host.
 *            { action: "bind",   domain, targetAgentId? }  persist domain ->
 *                                    publication (host-dispatch serves it).
 *   DELETE /api/builder/domain    -> unbind ({ targetAgentId? } body).
 *
 * Authority: {@link resolveSiteOwnerSubject} — the caller manages their OWN
 * site, or a GROUP site they hold write access on (remote-viewer-aware; the
 * target id only NAMES the owner, it is never trusted). V1 is MANUAL DNS only
 * — no DNS-write connectors on this app (person-only lane).
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import {
  DOMAIN_STATUS_PENDING,
  SiteServiceError,
  bindCustomDomain,
  getSitePublication,
  resolveSiteOwnerSubject,
  setDomainStatus,
  unbindCustomDomain,
} from "@/lib/builder/site-service";
import {
  DomainVerifyError,
  getAppHostname,
  normalizeHost,
  verifyDomainPointsToApp,
} from "@/lib/builder/site-host-resolve";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface DomainBody {
  action?: "verify" | "bind";
  domain?: string;
  targetAgentId?: string;
}

/** Builds the human DNS-record guidance to point `domain` at the app host. */
function requiredDnsRecords(domain: string | null, appHostname: string | null) {
  if (!appHostname) return [];
  const host = normalizeHost(domain) || "your-domain.com";
  return [
    {
      type: "A",
      name: host,
      value: `<same IP as ${appHostname}>`,
      purpose: `Point an A record at the same IP address that ${appHostname} resolves to.`,
    },
    {
      type: "CNAME",
      name: host,
      value: appHostname,
      purpose: `Alternative to the A record: CNAME to ${appHostname} (subdomains only; apex needs an A record or CNAME flattening).`,
    },
  ];
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const target = new URL(request.url).searchParams.get("target") ?? undefined;
  const subject = await resolveSiteOwnerSubject(target);
  if ("error" in subject) return errorResponse(subject.error, subject.status);

  const publication = await getSitePublication(subject.targetAgentId);
  const appHostname = getAppHostname();
  return NextResponse.json(
    {
      publication,
      appHostname,
      dnsRecords: requiredDnsRecords(publication?.customDomain ?? null, appHostname),
    },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: DomainBody;
  try {
    body = (await request.json()) as DomainBody;
  } catch {
    return errorResponse("Invalid JSON body", STATUS_BAD_REQUEST);
  }

  const subject = await resolveSiteOwnerSubject(body.targetAgentId);
  if ("error" in subject) return errorResponse(subject.error, subject.status);

  const domain = normalizeHost(body.domain);
  if (!domain) {
    return errorResponse("A custom domain is required.", STATUS_BAD_REQUEST);
  }

  try {
    // ---- Verify: does the domain resolve to this app host? ----------------
    if (body.action === "verify") {
      const verification = await verifyDomainPointsToApp(domain);
      // Record intent so a later bind knows which domain (status stays pending).
      await setDomainStatus(subject.targetAgentId, DOMAIN_STATUS_PENDING, {
        customDomain: domain,
        domainError: verification.verified ? null : verification.detail,
      });
      return NextResponse.json(
        { verification, appHostname: getAppHostname() },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // ---- Bind: persist the domain so host-dispatch serves it --------------
    if (body.action === "bind") {
      const publication = await bindCustomDomain(subject.targetAgentId, domain);
      return NextResponse.json(
        { publication },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    return errorResponse(`Unknown action "${body.action}".`, STATUS_BAD_REQUEST);
  } catch (error) {
    if (error instanceof SiteServiceError || error instanceof DomainVerifyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
    const message = error instanceof Error ? error.message : "Domain operation failed.";
    console.error("[api/builder/domain] POST failed:", error);
    return errorResponse(message, STATUS_INTERNAL_ERROR);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  let target: string | undefined;
  try {
    const body = (await request.json()) as DomainBody;
    target = body.targetAgentId;
  } catch {
    target = undefined;
  }
  const subject = await resolveSiteOwnerSubject(target);
  if ("error" in subject) return errorResponse(subject.error, subject.status);

  const publication = await unbindCustomDomain(subject.targetAgentId);
  return NextResponse.json(
    { publication },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}
