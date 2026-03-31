"use server";

/**
 * @file Server action module for creating entities from confirmed NLP scaffolding.
 * @description Exports `createEntitiesFromScaffold`, which validates user-authenticated
 * payloads, enforces per-user rate limits, creates or links entities transactionally,
 * records creation/relationship ledger history, and revalidates affected app paths.
 * @dependencies `@/auth`, `@/db`, `@/db/schema`, `@/lib/engine`, `@/lib/permissions`,
 * `@/lib/rate-limit`, `@/lib/nlp-parser`, `next/cache`, `drizzle-orm`
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { Verb } from "@/lib/engine";
import { canView } from "@/lib/permissions";
import { rateLimit } from "@/lib/rate-limit";
import { embedAgent, embedResource, scheduleEmbedding } from "@/lib/ai";
import type {
  AgentType,
  NewAgent,
  NewLedgerEntry,
  NewResource,
  ResourceType,
} from "@/db/schema";
import type {
  EntityType,
  ExtractedProperty,
  RelationshipType,
} from "@/lib/nlp-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entity shape coming from the client after user editing */
export interface ConfirmedEntity {
  tempId: string;
  type: EntityType;
  name: string;
  properties: ExtractedProperty[];
  targetTable?: "agents" | "resources";
  /** When true, this entity already exists in the DB and should be linked, not created */
  isExisting?: boolean;
  /** The database ID of the existing entity (set when isExisting is true) */
  existingId?: string;
}

/** Relationship shape coming from the client */
export interface ConfirmedRelationship {
  type: RelationshipType;
  fromTempId: string;
  toTempId: string;
}

/** Full payload sent from the confirmation UI */
export interface CreateEntitiesPayload {
  entities: ConfirmedEntity[];
  relationships: ConfirmedRelationship[];
  originalInput: string;
  /** The locale ID the user had selected when creating these entities */
  localeId?: string;
}

/** Result returned from the server action */
export interface CreateEntitiesResult {
  success: boolean;
  message: string;
  createdIds: { tempId: string; dbId: string; name: string; type: string }[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  CREATION_FAILED: "CREATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

// Rate limit constants
const ENTITY_CREATION_RATE_LIMIT = 50;
const ENTITY_CREATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Relationship types that imply a parent-child hierarchy.
 * For these types, the "from" entity is the child and the "to" entity
 * is the parent. We store this in the parentId column for efficient
 * hierarchy queries via getAgentChildren().
 */
const HIERARCHICAL_RELATIONSHIP_TYPES: ReadonlySet<RelationshipType> = new Set([
  "part_of",
  "located_in",
  "hosted_by",
  "organized_by",
]);

const AGENT_ENTITY_TYPES = new Set<EntityType>(["person", "organization"]);

function resolveTargetTable(entity: ConfirmedEntity): "agents" | "resources" {
  if (entity.targetTable === "agents" || entity.targetTable === "resources") {
    return entity.targetTable;
  }
  return AGENT_ENTITY_TYPES.has(entity.type) ? "agents" : "resources";
}

function resourceTypeForEntity(entity: ConfirmedEntity): ResourceType {
  if (entity.type === "project") return "project";
  if (entity.type === "event") return "event";
  if (entity.type === "place") return "place";
  return "resource";
}

// ---------------------------------------------------------------------------
// Server Action
// ---------------------------------------------------------------------------

/**
 * Create entities in the database from the confirmed NLP scaffold.
 *
 * This action is only invoked after the user reviews and confirms
 * the entity scaffold in the preview component.
 *
 * Auth requirement: caller must be authenticated.
 * Rate limiting: enforced per authenticated user (`entity-creation:${userId}`).
 * Error handling pattern: validation/auth/rate-limit failures are returned as structured results;
 * transaction-time exceptions are caught and mapped to `CREATION_FAILED`.
 *
 * @param {CreateEntitiesPayload} payload - Confirmed entity scaffold and relationships.
 * @returns {Promise<CreateEntitiesResult>} Created/linked entity mapping plus summary message.
 * @throws {never} This function catches runtime failures and returns typed error codes instead.
 *
 * @example
 * const result = await createEntitiesFromScaffold({
 *   entities: [{ tempId: "e1", type: "project", name: "River Cleanup", properties: [] }],
 *   relationships: [],
 *   originalInput: "create a project called River Cleanup",
 * });
 * if (!result.success) console.error(result.errors);
 */
export async function createEntitiesFromScaffold(
  payload: CreateEntitiesPayload
): Promise<CreateEntitiesResult> {
  // Authenticate
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "You must be logged in to create entities",
      createdIds: [],
      errors: [ERROR_CODES.UNAUTHENTICATED],
    };
  }

  const userId = session.user.id;

  // Throttle per-user write volume to protect database and ledger hot paths.
  const limiter = await rateLimit(
    `entity-creation:${userId}`,
    ENTITY_CREATION_RATE_LIMIT,
    ENTITY_CREATION_WINDOW_MS
  );
  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      message: `Too many entity creations. Please try again in ${retryAfterSec} seconds.`,
      createdIds: [],
      errors: [ERROR_CODES.RATE_LIMITED],
    };
  }

  // Validate payload
  if (
    !payload ||
    !Array.isArray(payload.entities) ||
    payload.entities.length === 0
  ) {
    return {
      success: false,
      message: "No entities to create",
      createdIds: [],
      errors: [ERROR_CODES.INVALID_PAYLOAD],
    };
  }

  // Fail fast on shape/type issues so no partial writes are attempted.
  const validTypes: EntityType[] = [
    "project",
    "event",
    "place",
    "person",
    "organization",
  ];
  for (const entity of payload.entities) {
    if (!entity.name || !entity.name.trim()) {
      return {
        success: false,
        message: `Entity "${entity.tempId}" has no name`,
        createdIds: [],
        errors: [ERROR_CODES.INVALID_PAYLOAD],
      };
    }
    if (!validTypes.includes(entity.type)) {
      return {
        success: false,
        message: `Entity "${entity.name}" has invalid type "${entity.type}"`,
        createdIds: [],
        errors: [ERROR_CODES.INVALID_PAYLOAD],
      };
    }
  }

  // Create entities within a transaction
  try {
    const result = await db.transaction(async (tx) => {
      const createdIds: CreateEntitiesResult["createdIds"] = [];
      const tempToDbId = new Map<string, string>();
      const tempToTargetTable = new Map<string, "agents" | "resources">();

      // Step 1: create new entities and map already-existing entities to DB IDs.
      for (const entity of payload.entities) {
        const entityTargetTable = resolveTargetTable(entity);

        // Existing links require view permission to prevent unauthorized graph disclosure/linking.
        if (entity.isExisting && entity.existingId) {
          const viewCheck = await canView(
            userId,
            entity.existingId,
            entityTargetTable === "agents" ? "agent" : "resource"
          );
          if (!viewCheck.allowed) {
            throw new Error(
              `You do not have permission to link to "${entity.name}" (${viewCheck.reason})`
            );
          }

          tempToDbId.set(entity.tempId, entity.existingId);
          tempToTargetTable.set(entity.tempId, entityTargetTable);
          createdIds.push({
            tempId: entity.tempId,
            dbId: entity.existingId,
            name: entity.name,
            type: entity.type,
          });

          // Record the link in the ledger
          await tx.insert(ledger).values({
            subjectId: userId,
            verb: "share",
            objectId: entity.existingId,
            objectType: entityTargetTable === "agents" ? "agent" : "resource",
            metadata: {
              engineVerb: Verb.ENDORSED,
              source: "nlp-scaffold",
              entityType: entity.type,
              entityTargetTable,
              action: "linked-existing",
              originalInput: payload.originalInput,
            },
          } as NewLedgerEntry);

          continue;
        }

        // Convert extracted key/value properties into metadata map for storage.
        const propertiesMap: Record<string, string> = {};
        for (const prop of entity.properties) {
          propertiesMap[prop.key] = prop.value;
        }

        const metadata: Record<string, unknown> = {
          source: "nlp-scaffold",
          originalInput: payload.originalInput,
          properties: propertiesMap,
          createdVia: "natural-language-input",
          ...(payload.localeId && payload.localeId !== "all"
            ? { chapterTags: [payload.localeId] }
            : {}),
        };

        const description =
          propertiesMap.description || propertiesMap.name || entity.name;

        const inserted = entityTargetTable === "agents"
          ? await tx
            .insert(agents)
            .values({
              name: entity.name.trim(),
              type: entity.type as AgentType,
              description,
              metadata,
            } as NewAgent)
            .returning({ id: agents.id, name: agents.name })
          : await tx
            .insert(resources)
            .values({
              name: entity.name.trim(),
              type: resourceTypeForEntity(entity),
              description,
              ownerId: userId,
              metadata: {
                ...metadata,
                resourceKind: entity.type,
              },
            } as NewResource)
            .returning({ id: resources.id, name: resources.name });

        const [created] = inserted;

        tempToDbId.set(entity.tempId, created.id);
        tempToTargetTable.set(entity.tempId, entityTargetTable);
        createdIds.push({
          tempId: entity.tempId,
          dbId: created.id,
          name: created.name,
          type: entity.type,
        });

        // Record the creation in the ledger
        await tx.insert(ledger).values({
          subjectId: userId,
          verb: "create",
          objectId: created.id,
          objectType: entityTargetTable === "agents" ? "agent" : "resource",
          resourceId: entityTargetTable === "resources" ? created.id : null,
          metadata: {
            engineVerb: Verb.CREATED,
            source: "nlp-scaffold",
            entityType: entity.type,
            entityTargetTable,
            originalInput: payload.originalInput,
          },
        } as NewLedgerEntry);
      }

      // Step 2: persist relationships (hierarchy where supported + ledger audit trail).
      if (payload.relationships && payload.relationships.length > 0) {
        for (const rel of payload.relationships) {
          const fromId = tempToDbId.get(rel.fromTempId);
          const toId = tempToDbId.get(rel.toTempId);
          const fromTargetTable = tempToTargetTable.get(rel.fromTempId);
          const toTargetTable = tempToTargetTable.get(rel.toTempId);

          if (!fromId || !toId || !fromTargetTable || !toTargetTable) continue;

          // For hierarchical relationships, set parentId on the child entity.
          // "from" is the child (e.g., event), "to" is the parent (e.g., project).
          if (
            HIERARCHICAL_RELATIONSHIP_TYPES.has(rel.type) &&
            fromTargetTable === "agents" &&
            toTargetTable === "agents"
          ) {
            const childId = fromId;
            const parentDbId = toId;

            // Look up the parent's depth and path to compute the child's hierarchy
            const [parent] = await tx
              .select({ depth: agents.depth, pathIds: agents.pathIds })
              .from(agents)
              .where(eq(agents.id, parentDbId))
              .limit(1);

            const parentDepth = parent?.depth ?? 0;
            const parentPathIds = (parent?.pathIds as string[]) ?? [];
            const childPathIds = [...parentPathIds, parentDbId];
            const childDepth = parentDepth + 1;

            // Build the path_ids array using parameterized values to prevent
            // SQL injection from user-controlled existingId values.
            const pathArray = childPathIds.length > 0
              ? sql`ARRAY[${sql.join(childPathIds.map((id) => sql`${id}::uuid`), sql.raw(","))}]`
              : sql`ARRAY[]::uuid[]`;

            await tx.execute(sql`
              UPDATE agents
              SET parent_id = ${parentDbId},
                  depth = ${childDepth},
                  path_ids = ${pathArray},
                  updated_at = NOW()
              WHERE id = ${childId}
            `);
          }

          // Record every relationship mutation for traceability, even when no hierarchy update occurs.
          await tx.insert(ledger).values({
            subjectId: fromTargetTable === "agents" ? fromId : userId,
            verb: "share",
            objectId: toId,
            objectType: toTargetTable === "agents" ? "agent" : "resource",
            resourceId: toTargetTable === "resources" ? toId : null,
            metadata: {
              engineVerb: Verb.ENDORSED,
              relationshipType: rel.type,
              source: "nlp-scaffold",
              relationshipSubjectType: fromTargetTable === "agents" ? "agent" : "resource",
              relationshipSubjectId: fromId,
            },
          } as NewLedgerEntry);
        }
      }

      return createdIds;
    });

    // Refresh affected routes so newly created/linked entities appear immediately in UI.
    revalidatePath("/");
    revalidatePath("/explore");
    revalidatePath("/create");

    // Fire-and-forget: embed newly created entities for semantic search.
    for (const entry of result) {
      const entity = payload.entities.find((e) => e.tempId === entry.tempId);
      if (!entity || entity.isExisting) continue;

      const targetTable = resolveTargetTable(entity);
      const description =
        entity.properties.find((p) => p.key === "description")?.value ??
        entity.name;

      if (targetTable === "agents") {
        scheduleEmbedding(() => embedAgent(entry.dbId, entry.name, description));
      } else {
        scheduleEmbedding(() => embedResource(entry.dbId, entry.name, description));
      }
    }

    const createdCount = payload.entities.filter((e) => !e.isExisting).length;
    const linkedCount = payload.entities.filter((e) => e.isExisting).length;
    const entityNames = result.map((r) => r.name).join(", ");

    const messageParts: string[] = [];
    if (createdCount > 0) {
      messageParts.push(`Created ${createdCount} entit${createdCount !== 1 ? "ies" : "y"}`);
    }
    if (linkedCount > 0) {
      messageParts.push(`Linked ${linkedCount} existing`);
    }

    return {
      success: true,
      message: `${messageParts.join(", ")}: ${entityNames}`,
      createdIds: result,
      errors: [],
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create entities: ${error instanceof Error ? error.message : String(error)}`,
      createdIds: [],
      errors: [ERROR_CODES.CREATION_FAILED],
    };
  }
}
