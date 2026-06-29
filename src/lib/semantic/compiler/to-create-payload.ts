/**
 * @file to-create-payload.ts — CreateStatement → CreateEntitiesPayload.
 *
 * Compiles a typechecked {@link CreateStatement} into the existing
 * {@link CreateEntitiesPayload} contract consumed by `createEntitiesFromScaffold`.
 * Clamps to the 5 valid create types (project/event/place/person/organization)
 * via the lexicon's DB-enum mapping, and maps create relationships to the legacy
 * {@link RelationshipType} set.
 *
 * This is a PURE transform — it does NOT execute the create, does NOT check
 * permissions, and does NOT touch the db. The server action it produces input
 * for is where auth/rate-limit/permission live (plan §8). Callers MUST run
 * `typecheck` first (backend-only region creates are rejected there).
 *
 * @dependencies ./..ast, ./..lexicon, `@/app/actions/create-entities` (types),
 *   `@/lib/nlp-parser` (RelationshipType). No db/IO.
 */

import {
  SEMANTIC_DOMAINS,
  type CreateStatement,
  type Slot,
} from "../ast";
import { toEntityType } from "../lexicon";
import type {
  ConfirmedEntity,
  ConfirmedRelationship,
  CreateEntitiesPayload,
} from "@/app/actions/create-entities";
import type { ExtractedProperty, RelationshipType } from "@/lib/nlp-parser";

/** Specific compile error codes. */
export const CREATE_COMPILE_ERROR_CODES = {
  NO_ENTITIES: "NO_ENTITIES",
  UNMAPPABLE_TYPE: "UNMAPPABLE_TYPE",
  MISSING_NAME: "MISSING_NAME",
  BACKEND_ONLY: "BACKEND_ONLY",
} as const;

export type CreateCompileErrorCode =
  (typeof CREATE_COMPILE_ERROR_CODES)[keyof typeof CREATE_COMPILE_ERROR_CODES];

export class CreatePayloadCompileError extends Error {
  readonly code: CreateCompileErrorCode;
  readonly source?: string;
  constructor(code: CreateCompileErrorCode, message: string, source?: string) {
    super(message);
    this.name = "CreatePayloadCompileError";
    this.code = code;
    this.source = source;
  }
}

/** The relationship types the create payload accepts (legacy set). */
const VALID_RELATIONSHIP_TYPES: ReadonlySet<RelationshipType> = new Set<RelationshipType>([
  "part_of",
  "located_in",
  "hosted_by",
  "organized_by",
  "created_by",
  "attended_by",
]);

/** Convert a slot's parsed properties to the ExtractedProperty[] shape. */
function toExtractedProperties(slot: Slot): ExtractedProperty[] {
  return (slot.properties ?? []).map((p) => ({
    key: p.key,
    value: p.value,
    source: p.source,
  }));
}

/**
 * Compile a {@link CreateStatement} into a {@link CreateEntitiesPayload}.
 *
 * @param statement A typechecked create statement (region subtypes already
 *   rejected upstream — this re-asserts the gate defensively).
 * @param originalInput The verbatim user input, threaded for the ledger audit.
 * @param localeId Optional locale the speaker had selected.
 * @throws {CreatePayloadCompileError} on empty / unmappable / backend-only input.
 */
export function compileToCreatePayload(
  statement: CreateStatement,
  originalInput: string,
  localeId?: string,
): CreateEntitiesPayload {
  if (statement.entities.length === 0) {
    throw new CreatePayloadCompileError(
      CREATE_COMPILE_ERROR_CODES.NO_ENTITIES,
      "Create statement has no entities to compile.",
    );
  }

  const entities: ConfirmedEntity[] = [];
  const tempIds: string[] = [];

  statement.entities.forEach((slot, index) => {
    const tempId = `e${index}`;
    tempIds.push(tempId);

    // Existing linked entity (literalNew === false) — pass through as a link.
    if (slot.literalNew === false) {
      const entityType = toEntityType(
        slot.domain ?? SEMANTIC_DOMAINS.RESOURCE,
        slot.kind,
        slot.groupSubtype,
      );
      entities.push({
        tempId,
        type: entityType ?? "project",
        name: slot.name ?? slot.source,
        properties: toExtractedProperties(slot),
        isExisting: true,
      });
      return;
    }

    // New entity — defensive backend-only re-check.
    if (slot.regionSubtype) {
      throw new CreatePayloadCompileError(
        CREATE_COMPILE_ERROR_CODES.BACKEND_ONLY,
        `"${slot.regionSubtype}" is backend-only and cannot be created by users.`,
        slot.source,
      );
    }

    if (!slot.name || !slot.name.trim()) {
      throw new CreatePayloadCompileError(
        CREATE_COMPILE_ERROR_CODES.MISSING_NAME,
        `Create entity from "${slot.source}" has no name.`,
        slot.source,
      );
    }

    const entityType = toEntityType(
      slot.domain ?? SEMANTIC_DOMAINS.RESOURCE,
      slot.kind,
      slot.groupSubtype,
    );
    if (!entityType) {
      throw new CreatePayloadCompileError(
        CREATE_COMPILE_ERROR_CODES.UNMAPPABLE_TYPE,
        `"${slot.kind ?? "unknown"}" does not map to a valid create type.`,
        slot.source,
      );
    }

    entities.push({
      tempId,
      type: entityType,
      name: slot.name.trim(),
      properties: toExtractedProperties(slot),
    });
  });

  // Map relationships, clamping to the accepted legacy relationship vocabulary.
  const relationships: ConfirmedRelationship[] = [];
  for (const rel of statement.relationships) {
    if (!VALID_RELATIONSHIP_TYPES.has(rel.type as RelationshipType)) continue;
    const fromTempId = tempIds[rel.fromIndex];
    const toTempId = tempIds[rel.toIndex];
    if (!fromTempId || !toTempId) continue;
    relationships.push({
      type: rel.type as RelationshipType,
      fromTempId,
      toTempId,
    });
  }

  return {
    entities,
    relationships,
    originalInput,
    ...(localeId ? { localeId } : {}),
  };
}
