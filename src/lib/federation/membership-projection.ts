/**
 * Membership projection to a member's HOME instance.
 *
 * When a membership is created or activated on THIS instance for an agent
 * whose home is elsewhere (e.g. Cameron, homed on his person instance,
 * granted RIVR-org membership on global), the member's home never learns
 * about it — their home Groups tab silently omits the group. Every
 * sovereign receiver has carried an `applyMembershipProjection` handler
 * since the membership-invites wave, but NOTHING ever emitted it (found
 * live 2026-07-22: Cameron's RIVR membership existed only on global).
 *
 * This module is that missing emitter. Fire-and-forget by design: the
 * membership write itself must never fail because the member's home is
 * unreachable — the backfill script (src/scripts/backfill-membership-
 * projections.ts) reconciles missed projections.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { routeWrite } from "@/lib/federation/write-router";

export interface MembershipProjectionResult {
  projected: boolean;
  reason?: string;
}

/**
 * Project an active membership to the member's home instance. No-op when
 * the member is homed locally. Never throws.
 */
export async function projectMembershipToMemberHome(
  memberId: string,
  groupId: string,
  role: string = "member",
): Promise<MembershipProjectionResult> {
  try {
    const home = await resolveHomeInstance(memberId);
    if (home.isLocal) return { projected: false, reason: "member is local" };

    const [group] = await db
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        description: agents.description,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.id, groupId))
      .limit(1);
    if (!group?.name) return { projected: false, reason: "group not found" };

    const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
    const groupMeta = (group.metadata ?? {}) as Record<string, unknown>;

    const result = await routeWrite(
      {
        type: "applyMembershipProjection",
        actorId: memberId,
        targetAgentId: memberId, // routes to the MEMBER's home instance
        payload: {
          joined: true,
          role,
          group: {
            id: group.id,
            name: group.name,
            type: group.type,
            description: group.description ?? undefined,
            homeBaseUrl:
              typeof groupMeta.federatedHomeBaseUrl === "string"
                ? groupMeta.federatedHomeBaseUrl
                : baseUrl,
            metadata: {
              // The projection is a pointer, not a mirror: carry only the
              // display surface the home Groups tab needs.
              ...(typeof groupMeta.image === "string" ? { image: groupMeta.image } : {}),
              canonicalUrl: `${baseUrl}/groups/${group.id}`,
            },
          },
        },
        idempotencyKey: `membership-projection:${groupId}:${memberId}`,
      },
      // Local executor is unreachable: home.isLocal already returned above.
      async () => ({ projected: false }),
    );

    if (!result.success) {
      console.warn(
        `[membership-projection] forward failed for member ${memberId} group ${groupId}: ${result.error}`,
      );
      return { projected: false, reason: result.error };
    }
    return { projected: true };
  } catch (error) {
    console.warn(
      `[membership-projection] error for member ${memberId} group ${groupId}:`,
      error instanceof Error ? error.message : error,
    );
    return { projected: false, reason: "unexpected error" };
  }
}
