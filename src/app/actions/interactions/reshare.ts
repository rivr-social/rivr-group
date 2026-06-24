"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupOutboundConnectors, ledger, resources } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { hasGroupWriteAccess } from "@/app/actions/resource-creation/helpers";
import {
  buildResharePayload,
  connectorCanDeliver,
  isReshareableResourceType,
  reshareIdempotencyKey,
  type ReshareDeliveryResult,
  type ReshareSource,
  type ResharePayload,
} from "@/lib/reshare";
import { getCurrentUserId } from "./helpers";
import type { ActionResult } from "./types";
import { isUuid } from "./types";

/** Builds the canonical public URL of a resource on this instance. */
function resourceCanonicalUrl(resourceType: string, resourceId: string): string {
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
 * Delivers a reshare payload through a platform adapter when the connector
 * carries the credentials its platform needs. When it does not, the reshare is
 * recorded (attribution + idempotency) but reported as not delivered — the
 * outbound network adapters are credential-gated, so this is the documented
 * stub boundary rather than a silent failure.
 */
async function dispatchReshare(
  payload: ResharePayload,
  credentials: Record<string, unknown>,
): Promise<ReshareDeliveryResult> {
  if (!connectorCanDeliver(payload.platform, credentials)) {
    return {
      platform: payload.platform,
      delivered: false,
      reason: "adapter not configured (missing platform credentials)",
    };
  }
  // Per-platform delivery adapters are credential-gated and live behind the
  // connector lane. The dispatch boundary is intentionally a no-op stub until
  // platform OAuth/webhook credentials are wired; the lane, payload, and
  // attribution are complete and will route to the adapter here.
  return {
    platform: payload.platform,
    delivered: false,
    reason: "delivery adapter pending platform wiring",
  };
}

/**
 * Reshares a group's resource (offering/post/event) outbound to all of its
 * active, enabled outbound connectors (EPIC J9).
 *
 * For each connector a platform-appropriate payload is built and dispatched; a
 * `share` ledger edge is recorded per platform carrying the stable idempotency
 * key, so a piece of content is never reshared twice to the same platform.
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

  const source: ReshareSource = {
    resourceId: resource.id,
    resourceType: resource.type as ReshareSource["resourceType"],
    title: resource.name,
    description: resource.description,
    url: resourceCanonicalUrl(resource.type, resource.id),
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
      results.push({ platform, delivered: false, reason: "already reshared" });
      continue;
    }

    const payload = buildResharePayload(resource.ownerId, platform, source);
    const delivery = await dispatchReshare(payload, connector.credentials ?? {});
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
        groupId: resource.ownerId,
        idempotencyKey: key,
        delivered: delivery.delivered,
        deliveryReason: delivery.reason ?? null,
        externalRef: delivery.externalRef ?? null,
      },
    } as NewLedgerEntry);
  }

  revalidatePath(`/groups/${resource.ownerId}`);

  const deliveredCount = results.filter((r) => r.delivered).length;
  const recorded = results.length;
  return {
    success: true,
    message:
      deliveredCount > 0
        ? `Reshared to ${deliveredCount} platform${deliveredCount === 1 ? "" : "s"}.`
        : `Reshare recorded for ${recorded} connector${recorded === 1 ? "" : "s"} (delivery pending platform wiring).`,
    results,
  };
}
