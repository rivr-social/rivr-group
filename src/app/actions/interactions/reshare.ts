"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupOutboundConnectors, ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { hasGroupWriteAccess } from "@/app/actions/resource-creation/helpers";
import { resolveActiveResourcePointerForResource } from "@/lib/federation/manifest-references";
import {
  buildResharePayload,
  connectorCanDeliver,
  isReshareableResourceType,
  reshareDeliveryMode,
  reshareIdempotencyKey,
  type ReshareDeliveryResult,
  type ReshareSource,
  type ResharePayload,
} from "@/lib/reshare";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/**
 * Builds the LOCAL public URL of a resource on this instance. Used only as the
 * backlink fallback for resources that are homed here; federated mirrors resolve
 * their ORIGINAL canonical URL from the manifest instead (see the action).
 */
function localResourceUrl(resourceType: string, resourceId: string): string {
  const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  const path =
    resourceType === "post"
      ? `/posts/${resourceId}`
      : resourceType === "event"
        ? `/events/${resourceId}`
        : `/marketplace/${resourceId}`;
  return `${base}${path}`;
}

/**
 * Prepares a reshare for one platform WITHOUT any silent network dispatch.
 *
 *  - `share-intent` / `copy-link` platforms are user-completed: we return the
 *    pre-built composer URL (from the payload) and never push.
 *  - `api` platforms are pushed only when the connector carries credentials.
 *    The adapter network call is credential-gated; until platform OAuth/webhook
 *    delivery is wired it reports `delivered: false` with an explicit reason
 *    rather than claiming success. NOTHING auto-fires — the user invoked this.
 */
async function prepareReshare(
  payload: ResharePayload,
  credentials: Record<string, unknown>,
): Promise<ReshareDeliveryResult> {
  if (payload.deliveryMode !== "api") {
    // User completes the share via the platform composer; no server dispatch.
    return {
      platform: payload.platform,
      deliveryMode: payload.deliveryMode,
      delivered: false,
      reason: "user-completed share (open the share link to post)",
      shareIntentUrl: payload.shareIntentUrl,
    };
  }

  if (!connectorCanDeliver(payload.platform, credentials)) {
    return {
      platform: payload.platform,
      deliveryMode: payload.deliveryMode,
      delivered: false,
      reason: "adapter not configured (missing platform credentials)",
    };
  }
  // Per-platform API/webhook delivery is credential-gated and lives behind the
  // connector lane. The push boundary reports not-yet-delivered until platform
  // webhook/OAuth delivery is wired; the lane, payload, backlink, and
  // attribution are complete and route to the adapter here.
  return {
    platform: payload.platform,
    deliveryMode: payload.deliveryMode,
    delivered: false,
    reason: "delivery adapter pending platform wiring",
  };
}

/**
 * USER-INITIATED reshare of a group's resource (offering/post/event) to its
 * active, enabled outbound connectors (EPIC J9).
 *
 * This is NOT automatic: it runs only when a person explicitly invokes it (no
 * cron, no create-hook auto-dispatch). For each connector a platform-appropriate
 * payload is built that ALWAYS carries a clickable backlink to the ORIGINAL
 * content's canonical RIVR URL (the source instance's URL for federated
 * mirrors, the local URL for locally-homed content). API platforms are pushed
 * only when credentials exist; consumer platforms return a user-completed
 * share-intent URL and are never silently dispatched. A `share` ledger edge is
 * recorded per platform with the stable idempotency key so the same content is
 * never reshared twice to the same platform.
 *
 * Authorization: the caller must hold group-write access on the resource owner.
 *
 * @param input.resourceId UUID of the resource to reshare.
 * @returns ActionResult; the message summarizes per-platform outcomes.
 */
export async function reshareToConnectedPlatformsAction(input: {
  resourceId: string;
}): Promise<ActionResult & { results?: ReshareDeliveryResult[] }> {
  const userId = await getCurrentUserId();
  if (!userId) return { success: false, message: "You must be logged in to reshare." };
  if (!isUuid(input.resourceId)) return { success: false, message: "Invalid resource id." };

  const check = await rateLimit(
    `social:${userId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs,
  );
  if (!check.success) return { success: false, message: "Rate limit exceeded. Please try again later." };

  const [resource] = await db
    .select({
      id: resources.id,
      type: resources.type,
      name: resources.name,
      description: resources.description,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(and(eq(resources.id, input.resourceId), sql`${resources.deletedAt} IS NULL`))
    .limit(1);
  if (!resource) return { success: false, message: "Resource not found." };

  if (!isReshareableResourceType(resource.type)) {
    return { success: false, message: `Resources of type "${resource.type}" cannot be reshared.` };
  }

  const canWrite = await hasGroupWriteAccess(userId, resource.ownerId);
  if (!canWrite) {
    return { success: false, message: "You do not have permission to reshare this group's content." };
  }

  const connectors = await db
    .select({
      platform: groupOutboundConnectors.platform,
      credentials: groupOutboundConnectors.credentials,
      config: groupOutboundConnectors.config,
    })
    .from(groupOutboundConnectors)
    .where(
      and(
        eq(groupOutboundConnectors.groupId, resource.ownerId),
        eq(groupOutboundConnectors.isActive, true),
      ),
    );

  const enabled = connectors.filter((c) => c.config?.enabled === true);
  if (enabled.length === 0) {
    return { success: false, message: "No enabled outbound connectors for this group." };
  }

  // The MANDATORY backlink: for a federated mirror, resolve the ORIGINAL
  // content's canonical URL from the manifest; otherwise use the local URL.
  const resourceMeta = (resource.metadata ?? {}) as Record<string, unknown>;
  const sovereignPointer = await resolveActiveResourcePointerForResource(
    resource.id,
    resourceMeta,
  ).catch(() => null);
  const backlinkUrl =
    sovereignPointer?.canonicalUrl ?? localResourceUrl(resource.type, resource.id);

  const source: ReshareSource = {
    resourceId: resource.id,
    resourceType: resource.type as ReshareSource["resourceType"],
    title: resource.name,
    description: resource.description,
    url: backlinkUrl,
  };

  const results: ReshareDeliveryResult[] = [];
  for (const connector of enabled) {
    const platform = connector.platform as ResharePayload["platform"];
    const key = reshareIdempotencyKey(resource.ownerId, platform, resource.id);

    // Idempotency: skip platforms this content was already reshared to.
    const existing = (await db.execute(sql`
      SELECT 1 FROM ledger
      WHERE verb = 'share'
        AND is_active = true
        AND metadata->>'idempotencyKey' = ${key}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    if (existing.length > 0) {
      results.push({
        platform,
        deliveryMode: reshareDeliveryMode(platform),
        delivered: false,
        reason: "already reshared",
      });
      continue;
    }

    const payload = buildResharePayload(resource.ownerId, platform, source);
    const delivery = await prepareReshare(payload, connector.credentials ?? {});
    results.push(delivery);

    await db.insert(ledger).values({
      verb: "share",
      subjectId: userId,
      objectId: resource.id,
      objectType: "resource",
      resourceId: resource.id,
      isActive: true,
      metadata: {
        interactionType: "reshare",
        platform,
        deliveryMode: delivery.deliveryMode,
        groupId: resource.ownerId,
        idempotencyKey: key,
        // Persist the backlink so the recorded reshare always references the
        // original content's canonical URL.
        backlinkUrl,
        delivered: delivery.delivered,
        deliveryReason: delivery.reason ?? null,
        externalRef: delivery.externalRef ?? null,
        shareIntentUrl: delivery.shareIntentUrl ?? null,
      },
    } as NewLedgerEntry);
  }

  revalidatePath(`/groups/${resource.ownerId}`);

  const deliveredCount = results.filter((r) => r.delivered).length;
  const userCompletedCount = results.filter(
    (r) => r.deliveryMode !== "api" && r.reason !== "already reshared",
  ).length;
  const recorded = results.length;
  const message =
    deliveredCount > 0
      ? `Reshared to ${deliveredCount} platform${deliveredCount === 1 ? "" : "s"}.`
      : userCompletedCount > 0
        ? `Prepared ${userCompletedCount} share link${userCompletedCount === 1 ? "" : "s"} to complete, and recorded ${recorded} reshare${recorded === 1 ? "" : "s"}.`
        : `Reshare recorded for ${recorded} connector${recorded === 1 ? "" : "s"} (delivery pending platform wiring).`;
  return { success: true, message, results };
}
