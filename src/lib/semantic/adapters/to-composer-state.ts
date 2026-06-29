/**
 * @file to-composer-state.ts — SemanticProgram → conditional-composer state.
 *
 * The conditional composer (`src/components/query-composer.tsx`) builds its
 * WHEN/THEN/IF rows from a `{ when, thenActions, ifCondition, hasIf }` object
 * (historically produced by `parseNlpToComposer` over a `V2ParseResult`). This
 * adapter maps the NEW semantic parser's {@link SemanticProgram} (its top
 * interpretation) into that SAME shape so the composer's downstream code path —
 * `setWhenCondition` / `setThenActions` / `setIfCondition` / `setShowIf` — works
 * UNCHANGED behind the semantic-parser-v1 flag.
 *
 * Statement → composer mapping:
 *  - RULE  → WHEN (trigger) + THEN (actions) + optional IF (condition).
 *  - FIND  → a single WHEN filter row (subject/verb/object/locale), no actions.
 *  - CREATE→ a single THEN "create" action naming the primary entity.
 *
 * Reuses the contract-rule + ledger-filter compilers so determiner/id lowering
 * lives in ONE place. Pure transform — no db, no IO, no `any`.
 *
 * @dependencies ../ast, ../context, ../compiler/to-contract-rule,
 *   ../compiler/to-ledger-filter, @/components/query-composer (state types).
 *   No db/IO.
 */

import {
  AGENT_KINDS,
  SEMANTIC_DOMAINS,
  STATEMENT_KINDS,
  topInterpretation,
  type CreateStatement,
  type FindStatement,
  type RuleStatement,
  type SemanticProgram,
  type Slot,
} from "../ast";
import type { ParseContext } from "../context";
import {
  compileToContractRule,
  ContractRuleCompileError,
} from "../compiler/to-contract-rule";
import {
  compileToLedgerFilter,
  LedgerFilterCompileError,
} from "../compiler/to-ledger-filter";
import type {
  QueryCondition,
  ThenAction,
} from "@/components/query-composer";

/** The exact state slice the composer's `handleNlpParse` applies. */
export interface ComposerState {
  when: QueryCondition;
  thenActions: ThenAction[];
  ifCondition: QueryCondition;
  hasIf: boolean;
}

/** Default rule name used when compiling a rule purely for its structure. */
const SEMANTIC_RULE_PROBE_NAME = "semantic-probe" as const;

/** The db verb the composer uses for a scaffold-create action. */
const CREATE_VERB = "create" as const;

/** An empty composer state (used as the seed and the no-op fallback). */
function emptyState(): ComposerState {
  return { when: {}, thenActions: [], ifCondition: {}, hasIf: false };
}

/**
 * Display label for a trigger/condition OBJECT slot, so the composer renders
 * "joins my group" rather than the hardcoded "joins my resource". The
 * contract-rule lowering flattens slots to determiner+id (dropping domain/kind),
 * so we read the kind straight off the ORIGINAL slot here. Returns null for a
 * plain resource object (the renderer's default label is "resource"). This is a
 * DISPLAY hint only — the saved/executing agreement uses determiner+id, never
 * this label.
 */
function objectTypeLabel(slot: Slot | undefined): string | null {
  if (!slot || slot.domain !== SEMANTIC_DOMAINS.AGENT) return null;
  if (slot.kind === AGENT_KINDS.GROUP) return "group";
  if (slot.kind === AGENT_KINDS.PERSON) return "person";
  return "agent";
}

/**
 * Best display noun for a THEN-action object, so "give them a welcome badge"
 * renders "a badge" instead of "a ?". Uses a resolved/quoted name when present,
 * else the head noun of the source phrase (last word, skipping bare
 * determiners/pronouns). The contract-action lowering drops slot name/kind, so
 * we read the original slot here.
 */
const BARE_TOKEN = /^(a|an|the|this|that|these|those|them|it|they|him|her|my|our|your|any|all|each|every|some)$/i;
function actionObjectName(slot: Slot | undefined): string | null {
  if (!slot) return null;
  if (slot.name && slot.name.trim()) return slot.name.trim();
  const src = slot.source?.trim();
  if (!src) return null;
  const head = src.split(/\s+/).filter(Boolean).pop();
  if (!head || BARE_TOKEN.test(head)) return null;
  return head;
}

/** Map a lowered contract-condition's determiner/id/verb onto a WHEN/IF row. */
function conditionToQueryCondition(
  subjectDeterminer: string | null | undefined,
  subjectId: string | null | undefined,
  verb: string | null | undefined,
  objectDeterminer: string | null | undefined,
  objectId: string | null | undefined,
  objectTypeHint?: string | null,
): QueryCondition {
  const condition: QueryCondition = {};
  if (subjectDeterminer) condition.agentDeterminer = subjectDeterminer;
  if (subjectId) condition.agentId = subjectId;
  if (verb) condition.verb = verb;
  if (objectDeterminer) condition.resourceDeterminer = objectDeterminer;
  if (objectId) condition.resourceId = objectId;
  // Carry the object's kind label ("group"/"person") so the composer renders
  // the real noun instead of a hardcoded "resource". Display-only.
  if (objectTypeHint) condition.resourceType = objectTypeHint;
  return condition;
}

/** Map a RULE interpretation into WHEN/THEN/IF composer rows. */
function ruleToComposerState(statement: RuleStatement): ComposerState {
  // Compile to the contract-rule shape so trigger/action/condition determiners
  // + verbs are lowered consistently with how the composer saves rules.
  const rule = compileToContractRule(statement, { name: SEMANTIC_RULE_PROBE_NAME });

  const when = conditionToQueryCondition(
    rule.triggerSubjectDeterminer,
    rule.triggerSubjectId,
    rule.triggerVerb,
    rule.triggerObjectDeterminer,
    rule.triggerObjectId,
    objectTypeLabel(statement.trigger.object),
  );

  const thenActions: ThenAction[] = rule.actions.map((action, index) => {
    const then: ThenAction = { verb: action.verb };
    if (action.objectDeterminer) then.objectDeterminer = action.objectDeterminer;
    if (action.objectId) then.objectId = action.objectId;
    if (action.targetDeterminer) then.targetDeterminer = action.targetDeterminer;
    if (action.targetId) then.targetId = action.targetId;
    if (typeof action.delta === "number") then.delta = action.delta;
    // Carry the object's display noun + kind off the original slot so the
    // action renders "give a badge", not "give a ?". (The contract-action
    // lowering keeps only determiner+id.)
    const objSlot = statement.actions[index]?.object;
    const objName = actionObjectName(objSlot);
    if (objName) then.objectName = objName;
    const objType = objectTypeLabel(objSlot);
    if (objType) then.objectType = objType;
    return then;
  });

  const hasIf = rule.conditionVerb !== null;
  const ifCondition = hasIf
    ? conditionToQueryCondition(
        rule.conditionSubjectDeterminer,
        rule.conditionSubjectId,
        rule.conditionVerb,
        rule.conditionObjectDeterminer,
        rule.conditionObjectId,
        objectTypeLabel(statement.condition?.object),
      )
    : {};

  return {
    when,
    thenActions: thenActions.length > 0 ? thenActions : [{}],
    ifCondition,
    hasIf,
  };
}

/** Map a FIND interpretation into a single WHEN filter row. */
function findToComposerState(
  statement: FindStatement,
  context: ParseContext,
  originalInput: string,
): ComposerState {
  const filter = compileToLedgerFilter(statement, context, originalInput);
  const when: QueryCondition = {};
  if (filter.subjectId) when.agentId = filter.subjectId;
  if (filter.verb) when.verb = filter.verb;
  if (filter.objectId) when.resourceId = filter.objectId;

  return { when, thenActions: [{}], ifCondition: {}, hasIf: false };
}

/** Map a CREATE interpretation into a single THEN "create" action. */
function createToComposerState(statement: CreateStatement): ComposerState {
  const primary = statement.entities[0];
  const action: ThenAction = { verb: CREATE_VERB };
  if (primary) {
    if (primary.name) action.objectName = primary.name.trim();
    if (primary.kind) action.objectType = primary.kind;
    if (primary.determiner) action.objectDeterminer = primary.determiner;
  }
  return { when: {}, thenActions: [action], ifCondition: {}, hasIf: false };
}

/**
 * Map a {@link SemanticProgram} into conditional-composer state.
 *
 * @param program A parsed semantic program (its top interpretation is used).
 * @param context Grounding context (required for FIND deictic filters).
 * @returns The composer state, or an empty state when there is no usable
 *   interpretation OR a compiler rejects the statement (the caller treats an
 *   all-empty result as "no usable interpretation" and falls back to v2).
 */
export function toComposerState(
  program: SemanticProgram,
  context: ParseContext,
): ComposerState {
  const top = topInterpretation(program);
  if (!top) return emptyState();

  try {
    switch (top.statement.kind) {
      case STATEMENT_KINDS.RULE:
        return ruleToComposerState(top.statement as RuleStatement);
      case STATEMENT_KINDS.FIND:
        return findToComposerState(
          top.statement as FindStatement,
          context,
          program.originalInput,
        );
      case STATEMENT_KINDS.CREATE:
        return createToComposerState(top.statement as CreateStatement);
      default:
        return emptyState();
    }
  } catch (error) {
    // A compiler rejection (unbound deictic, no trigger/action verb) means the
    // statement is not expressible as composer state → empty so the caller can
    // fall back to the legacy parser.
    if (
      error instanceof ContractRuleCompileError ||
      error instanceof LedgerFilterCompileError
    ) {
      return emptyState();
    }
    throw error;
  }
}

/**
 * Whether a composer state carries no usable signal (all rows empty). The
 * caller uses this to decide whether to fall back to `parseNaturalLanguageV2`.
 */
export function isEmptyComposerState(state: ComposerState): boolean {
  const whenEmpty = Object.keys(state.when).length === 0;
  const ifEmpty = Object.keys(state.ifCondition).length === 0;
  const actionsEmpty = state.thenActions.every(
    (a) => Object.keys(a).length === 0,
  );
  return whenEmpty && ifEmpty && actionsEmpty;
}
