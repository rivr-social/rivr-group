/**
 * Owner settings page for federated-visitor access policy.
 *
 * Lives at `/settings/visitor-access`. Only the instance OWNER can reach it —
 * the page checks ownership server-side and redirects non-owners back to the
 * main settings page (it is also barred at the middleware for non-owner
 * federated visitors).
 *
 * Renders a client form that calls:
 *   GET  /api/admin/visitor-access  — initial load
 *   POST /api/admin/visitor-access  — save
 *
 * Also surfaces the most recent federated-visitor landings (referral path,
 * home instance, granted scope) so the owner can see who has been browsing.
 */

import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import {
  agents,
  federatedVisitLog,
  federatedVisitorSettings,
} from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  BASELINE_VISITOR_CAPABILITY,
  DEFAULT_VISITOR_TTL_MINUTES,
  VISITOR_CAPABILITIES,
  sanitizeCapabilities,
} from "@/lib/federation/visitor-scope";
import {
  VisitorAccessForm,
  type VisitorAccessInitial,
  type VisitorVisitRow,
} from "./visitor-access-form";

/** How many recent landings to surface on the page. */
const RECENT_VISIT_LIMIT = 25;

export default async function VisitorAccessSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  const { instanceId, instanceType, instanceSlug, primaryAgentId } =
    getInstanceConfig();

  // Owner gate. When a primary agent is configured (the normal sovereign case)
  // only that agent may administer visitor access; otherwise fall back to a
  // platform-admin check.
  let isOwner = primaryAgentId !== null && session.user.id === primaryAgentId;
  if (!isOwner) {
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, session.user.id))
      .limit(1);
    const metadata =
      agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
        ? (agent.metadata as Record<string, unknown>)
        : {};
    isOwner = metadata.siteRole === "admin";
  }
  if (!isOwner) {
    redirect("/settings");
  }

  const [row] = await db
    .select()
    .from(federatedVisitorSettings)
    .where(eq(federatedVisitorSettings.instanceId, instanceId))
    .limit(1);

  const extras = row ? sanitizeCapabilities(row.allowedCapabilities) : [];

  const recent = await db
    .select({
      id: federatedVisitLog.id,
      visitorActorId: federatedVisitLog.visitorActorId,
      isOwner: federatedVisitLog.isOwner,
      homeBaseUrl: federatedVisitLog.homeBaseUrl,
      globalIssuerBaseUrl: federatedVisitLog.globalIssuerBaseUrl,
      landingPath: federatedVisitLog.landingPath,
      referrer: federatedVisitLog.referrer,
      visitorName: federatedVisitLog.visitorName,
      grantedScope: federatedVisitLog.grantedScope,
      createdAt: federatedVisitLog.createdAt,
    })
    .from(federatedVisitLog)
    .where(eq(federatedVisitLog.instanceId, instanceId))
    .orderBy(desc(federatedVisitLog.createdAt))
    .limit(RECENT_VISIT_LIMIT);

  const recentVisits: VisitorVisitRow[] = recent.map((v) => ({
    id: v.id,
    visitorActorId: v.visitorActorId,
    isOwner: v.isOwner,
    homeBaseUrl: v.homeBaseUrl,
    globalIssuerBaseUrl: v.globalIssuerBaseUrl,
    landingPath: v.landingPath,
    referrer: v.referrer,
    visitorName: v.visitorName,
    grantedScope: Array.isArray(v.grantedScope) ? v.grantedScope : [],
    createdAt:
      v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt),
  }));

  const initial: VisitorAccessInitial = {
    instanceType,
    instanceSlug,
    baselineCapability: BASELINE_VISITOR_CAPABILITY,
    allCapabilities: [...VISITOR_CAPABILITIES],
    config: {
      enabled: row ? row.enabled : true,
      allowedCapabilities: extras,
      sessionTtlMinutes: row?.sessionTtlMinutes ?? DEFAULT_VISITOR_TTL_MINUTES,
      recordVisits: row ? row.recordVisits : true,
    },
    recentVisits,
  };

  return <VisitorAccessForm initial={initial} />;
}
