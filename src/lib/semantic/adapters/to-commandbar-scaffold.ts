/**
 * @file to-commandbar-scaffold.ts — SemanticProgram → CommandBar scaffold shape.
 *
 * The CommandBar's NLP fallback renders an {@link EntityScaffoldPreview} from a
 * `V2ParseResult`-shaped object (`{ entities, relationships, conditionals,
 * warnings, input, success }`). This adapter maps the NEW semantic parser's
 * {@link SemanticProgram} (its top interpretation) into that SAME shape so the
 * existing preview UI works UNCHANGED behind the semantic-parser-v1 flag.
 *
 * Only a CREATE interpretation has entities to scaffold. FIND/RULE
 * interpretations carry no creatable entities, so the adapter returns a
 * `success: false` scaffold with a precise warning; the caller treats that as
 * "no usable interpretation" and falls back to `parseNaturalLanguageV2`.
 *
 * Pure transform — no db, no IO, no `any`. Reuses the create compiler so the
 * type-clamping logic (5 valid create types, region rejection) is not duplicated.
 *
 * @dependencies ../ast, ../context, ../compiler/to-create-payload,
 *   @/lib/nlp-parser-v2 (target shape types), @/lib/nlp-parser (EntityType /
 *   RelationshipType). No db/IO.
 */

import {
  STATEMENT_KINDS,
  topInterpretation,
  type CreateStatement,
  type SemanticProgram,
  type Slot,
} from "../ast";
import { explainInterpretation } from "../explain";
import {
  compileToCreatePayload,
  CreatePayloadCompileError,
} from "../compiler/to-create-payload";
import type {
  V2Conditional,
  V2ExtractedEntity,
  V2ParseResult,
} from "@/lib/nlp-parser-v2";
import type {
  EntityType,
  ExtractedProperty,
  ExtractedRelationship,
} from "@/lib/nlp-parser";

/**
 * The slice of {@link V2ParseResult} the CommandBar scaffold actually consumes.
 * Kept structurally compatible with `V2ParseResult` so it can drop into the
 * existing `parseResult` state and `EntityScaffoldPreview` props verbatim.
 */
export type CommandBarScaffold = Pick<
  V2ParseResult,
  "success" | "input" | "entities" | "relationships" | "conditionals" | "warnings"
> & {
  /** Always null for the semantic path — the legacy `intent` field is unused. */
  intent: null;
};

/** Default per-entity confidence when the interpretation carries none per-slot. */
const SCAFFOLD_FALLBACK_CONFIDENCE = 0.6;

/** Reasons the adapter could not produce a creatable scaffold. */
export const COMMANDBAR_SCAFFOLD_WARNINGS = {
  NO_INTERPRETATION: "No interpretation could be derived from the input.",
  NOT_A_CREATE:
    "The input was understood, but it is not a request to create something.",
} as const;

/** Convert AST slot properties to the scaffold's ExtractedProperty[] shape. */
function toExtractedProperties(slot: Slot): ExtractedProperty[] {
  return (slot.properties ?? []).map((p) => ({
    key: p.key,
    value: p.value,
    source: p.source,
  }));
}

/**
 * Build a failed (non-create) scaffold carrying a precise warning. The caller
 * uses `success === false` as the signal to fall back to the legacy parser.
 */
function failedScaffold(
  program: SemanticProgram,
  warning: string,
): CommandBarScaffold {
  return {
    success: false,
    input: program.originalInput,
    entities: [],
    relationships: [],
    conditionals: [],
    warnings: [warning],
    intent: null,
  };
}

/**
 * Map a {@link SemanticProgram} into the CommandBar scaffold shape.
 *
 * @param program A parsed semantic program (its top interpretation is used).
 * @param localeId Optional locale the speaker had selected (threaded for audit).
 * @returns A `V2ParseResult`-compatible scaffold. `success` is `true` only when
 *   the top interpretation is a CREATE that compiles to at least one entity.
 */
export function toCommandBarScaffold(
  program: SemanticProgram,
  localeId?: string,
): CommandBarScaffold {
  const top = topInterpretation(program);
  if (!top) {
    return failedScaffold(program, COMMANDBAR_SCAFFOLD_WARNINGS.NO_INTERPRETATION);
  }

  if (top.statement.kind !== STATEMENT_KINDS.CREATE) {
    // FIND/RULE: understood, but nothing for the scaffold to create. Surface the
    // gloss as a warning so the fallback toast is informative, then fall back.
    return failedScaffold(program, COMMANDBAR_SCAFFOLD_WARNINGS.NOT_A_CREATE);
  }

  const statement = top.statement as CreateStatement;

  // Reuse the create compiler so type-clamping + region rejection live in ONE
  // place. A compile error (no name, backend-only, unmappable type) means there
  // is no usable create → return a failed scaffold so the caller falls back.
  let payload;
  try {
    payload = compileToCreatePayload(statement, program.originalInput, localeId);
  } catch (error) {
    if (error instanceof CreatePayloadCompileError) {
      return failedScaffold(program, error.message);
    }
    throw error;
  }

  // The compiler returns ConfirmedEntity[] (tempId/type/name/properties). Lift
  // those into the V2ExtractedEntity preview shape, pairing each with its source
  // slot for the original signal phrase + confidence.
  const entities: V2ExtractedEntity[] = payload.entities.map((entity, index) => {
    const slot = statement.entities[index];
    return {
      tempId: entity.tempId,
      type: entity.type as EntityType,
      name: entity.name,
      properties: entity.properties,
      sourcePhrase: slot?.source ?? entity.name,
      confidence: top.confidence || SCAFFOLD_FALLBACK_CONFIDENCE,
      ...(entity.isExisting ? { isExisting: true, isExistingHint: true } : {}),
    };
  });

  if (entities.length === 0) {
    return failedScaffold(program, COMMANDBAR_SCAFFOLD_WARNINGS.NOT_A_CREATE);
  }

  // ConfirmedRelationship uses tempIds; the preview shape uses index pairs.
  const tempIdToIndex = new Map<string, number>(
    entities.map((e, i) => [e.tempId, i]),
  );
  const relationships: ExtractedRelationship[] = [];
  for (const rel of payload.relationships) {
    const fromEntityIndex = tempIdToIndex.get(rel.fromTempId);
    const toEntityIndex = tempIdToIndex.get(rel.toTempId);
    if (fromEntityIndex === undefined || toEntityIndex === undefined) continue;
    const source = statement.relationships.find(
      (r) => `e${r.fromIndex}` === rel.fromTempId && `e${r.toIndex}` === rel.toTempId,
    )?.source;
    relationships.push({
      type: rel.type,
      fromEntityIndex,
      toEntityIndex,
      source: source ?? rel.type,
    });
  }

  // The semantic AST has no free-form conditionals for a CREATE; expose none.
  const conditionals: V2Conditional[] = [];

  return {
    success: true,
    input: program.originalInput,
    entities,
    relationships,
    conditionals,
    // Carry the human-readable gloss as an informational (non-blocking) note.
    warnings: [explainInterpretation(top)],
    intent: null,
  };
}
