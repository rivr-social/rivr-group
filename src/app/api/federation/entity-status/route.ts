/**
 * Federation entity-status probe — the ORIGIN half of the reconciliation lane
 * (`src/lib/federation/entity-status-contract.ts`).
 *
 * A peer holding federated projections of THIS instance's content asks, in one
 * batch, whether each entity still exists here. We answer from our own tables
 * and nothing else; `classifyEntityStatus` owns the verdict rules, including
 * the `not_authoritative` refusal that keeps a relayed mirror from retracting a
 * third instance's live content.
 *
 * Auth: peer-authed like every other federation endpoint. Existence of an id is
 * not content, so no per-entity visibility check is applied — no field of the
 * entity is returned beyond its resource kind.
 */

import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";

import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { ensureLocalNode } from "@/lib/federation";
import {
  classifyEntityStatus,
  parseEntityStatusRequest,
  type EntityStatusQuery,
  type EntityStatusResponse,
  type EntityStatusResult,
  type EntityStatusRow,
} from "@/lib/federation/entity-status-contract";
import {
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";

export async function POST(request: Request): Promise<NextResponse<EntityStatusResponse>> {
  const authorization = await authorizeFederationRequest(request);
  if (!authorization.authorized) {
    return NextResponse.json(
      { success: false, error: authorization.reason ?? "Authentication required" },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const parsed = parseEntityStatusRequest(body);
  if (parsed.error) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: STATUS_BAD_REQUEST });
  }

  try {
    const localNode = await ensureLocalNode();
    const results = await resolveEntityStatuses(parsed.entities, localNode.id);
    return NextResponse.json({ success: true, nodeSlug: localNode.slug, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[federation:entity-status] probe failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: STATUS_INTERNAL_ERROR });
  }
}

/**
 * Resolves each queried id against the local tables.
 *
 * Two id-keyed lookups (one per entity class) answer the whole batch — the
 * probe is deliberately cheap enough to run against every projection a peer
 * holds on a routine cadence.
 */
async function resolveEntityStatuses(
  entities: EntityStatusQuery[],
  localNodeId: string,
): Promise<EntityStatusResult[]> {
  const resourceIds = entities.filter((entity) => entity.entityType === "resource").map((entity) => entity.id);
  const agentIds = entities.filter((entity) => entity.entityType === "agent").map((entity) => entity.id);

  const [resourceRows, agentRows] = await Promise.all([
    resourceIds.length > 0
      ? db
          .select({
            id: resources.id,
            type: resources.type,
            deletedAt: resources.deletedAt,
            metadata: resources.metadata,
          })
          .from(resources)
          .where(inArray(resources.id, resourceIds))
      : Promise.resolve([]),
    agentIds.length > 0
      ? db
          .select({
            id: agents.id,
            type: agents.type,
            deletedAt: agents.deletedAt,
            metadata: agents.metadata,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : Promise.resolve([]),
  ]);

  const resourceById = new Map<string, EntityStatusRow>(
    resourceRows.map((row) => [row.id, row as EntityStatusRow]),
  );
  const agentById = new Map<string, EntityStatusRow>(
    agentRows.map((row) => [row.id, row as EntityStatusRow]),
  );

  return entities.map((entity) =>
    classifyEntityStatus(
      entity,
      entity.entityType === "resource" ? resourceById.get(entity.id) : agentById.get(entity.id),
      localNodeId,
    ),
  );
}
