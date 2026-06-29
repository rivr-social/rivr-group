/**
 * @file typecheck.ts — verb/role compatibility + backend-only rejection + bindings.
 *
 * The typechecker is the gate between a parsed AST and the compilers. It:
 *   1. REJECTS backend-only creates (region / locale / commons / basin) — these
 *      are administrative `placeType` metadata, never user-creatable (plan §4).
 *   2. Validates verb/role compatibility (a create entity must map to one of the
 *      5 valid create types; a rule trigger must have a real verb_type; etc.).
 *   3. Resolves variable BINDINGS ($actor/$task/$group/$recipient/$triggerObject)
 *      for rule actions, using the parsed determiners + the {@link ParseContext}.
 *
 * It does NOT touch the db and does NOT check permissions — permissions live in
 * the compiler/executor path, after resolution (plan §8). Typecheck is a pure,
 * structural + ontological validation pass.
 *
 * @dependencies ./ast, ./lexicon, ./context. No db/IO.
 */

import {
  BINDINGS,
  DETERMINER_KINDS,
  STATEMENT_KINDS,
  SEMANTIC_DOMAINS,
  type Action,
  type Binding,
  type CreateStatement,
  type FindStatement,
  type RuleStatement,
  type Slot,
  type Statement,
} from "./ast";
import { toEntityType } from "./lexicon";
import { bindDeictic, type ParseContext } from "./context";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** Specific typecheck error codes (no generic catch-all). */
export const TYPECHECK_ERROR_CODES = {
  BACKEND_ONLY_CREATE: "BACKEND_ONLY_CREATE",
  UNMAPPABLE_CREATE_TYPE: "UNMAPPABLE_CREATE_TYPE",
  MISSING_ENTITY_NAME: "MISSING_ENTITY_NAME",
  INVALID_TRIGGER_VERB: "INVALID_TRIGGER_VERB",
  INVALID_ACTION_VERB: "INVALID_ACTION_VERB",
  EMPTY_RULE_ACTIONS: "EMPTY_RULE_ACTIONS",
  UNBOUND_DEICTIC: "UNBOUND_DEICTIC",
} as const;

export type TypecheckErrorCode =
  (typeof TYPECHECK_ERROR_CODES)[keyof typeof TYPECHECK_ERROR_CODES];

export interface TypecheckError {
  code: TypecheckErrorCode;
  message: string;
  /** The slot/source phrase that triggered the error, when applicable. */
  source?: string;
}

/** A resolved variable binding for a rule action slot. */
export interface BoundVariable {
  /** The slot role this binding applies to (e.g. "target", "object"). */
  role: string;
  binding: Binding;
  /** Resolved id from context, when the binding could be grounded. */
  resolvedId?: string;
}

export interface TypecheckResult {
  ok: boolean;
  errors: TypecheckError[];
  /** Variable bindings resolved for rule statements. */
  bindings: BoundVariable[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Typecheck a single {@link Statement} against the clean ontology + context.
 * Pure: never touches the db, never checks permissions.
 */
export function typecheck(
  statement: Statement,
  context: ParseContext,
): TypecheckResult {
  switch (statement.kind) {
    case STATEMENT_KINDS.CREATE:
      return checkCreate(statement);
    case STATEMENT_KINDS.FIND:
      return checkFind(statement, context);
    case STATEMENT_KINDS.RULE:
      return checkRule(statement, context);
    default:
      return { ok: true, errors: [], bindings: [] };
  }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

function checkCreate(statement: CreateStatement): TypecheckResult {
  const errors: TypecheckError[] = [];

  for (const entity of statement.entities) {
    // Only the literal-new entities are user creates; linked existing entities
    // (literalNew=false) are references and skip the create-type checks.
    if (entity.literalNew === false) continue;

    // 1. Backend-only rejection — the hard gate.
    if (entity.regionSubtype) {
      errors.push({
        code: TYPECHECK_ERROR_CODES.BACKEND_ONLY_CREATE,
        message: `"${entity.regionSubtype}" is a backend-only administrative entity (placeType metadata) and cannot be created by users. Region/Locale/Commons/Basin are not user-creatable.`,
        source: entity.source,
      });
      continue;
    }

    // 2. Must have a name to create.
    if (!entity.name || !entity.name.trim()) {
      errors.push({
        code: TYPECHECK_ERROR_CODES.MISSING_ENTITY_NAME,
        message: `Create entity from "${entity.source}" has no name.`,
        source: entity.source,
      });
      continue;
    }

    // 3. Must map to one of the 5 valid create types.
    const entityType = toEntityType(
      entity.domain ?? SEMANTIC_DOMAINS.RESOURCE,
      entity.kind,
      entity.groupSubtype,
    );
    if (!entityType) {
      errors.push({
        code: TYPECHECK_ERROR_CODES.UNMAPPABLE_CREATE_TYPE,
        message: `"${entity.kind ?? "unknown"}" does not map to a user-creatable type (project/event/place/person/organization).`,
        source: entity.source,
      });
    }
  }

  return { ok: errors.length === 0, errors, bindings: [] };
}

// ---------------------------------------------------------------------------
// FIND
// ---------------------------------------------------------------------------

function checkFind(
  statement: FindStatement,
  context: ParseContext,
): TypecheckResult {
  const errors: TypecheckError[] = [];

  // Deictic filters must be bindable against context (else the query would
  // silently widen). We surface unbound deixis as a typecheck error.
  for (const filter of statement.filters) {
    if (filter.deictic) {
      const binding = bindDeictic(filter.deictic, context);
      if (binding.unbound) {
        errors.push({
          code: TYPECHECK_ERROR_CODES.UNBOUND_DEICTIC,
          message: `Cannot ground "${filter.source}": ${binding.reason}.`,
          source: filter.source,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, bindings: [] };
}

// ---------------------------------------------------------------------------
// RULE
// ---------------------------------------------------------------------------

function checkRule(
  statement: RuleStatement,
  context: ParseContext,
): TypecheckResult {
  const errors: TypecheckError[] = [];
  const bindings: BoundVariable[] = [];

  // Trigger verb must be a real ledger verb_type.
  if (!statement.trigger.verb.verbType) {
    errors.push({
      code: TYPECHECK_ERROR_CODES.INVALID_TRIGGER_VERB,
      message: `Trigger verb "${statement.trigger.verb.lemma}" is not a known ledger verb.`,
    });
  }

  if (statement.actions.length === 0) {
    errors.push({
      code: TYPECHECK_ERROR_CODES.EMPTY_RULE_ACTIONS,
      message: "A rule must have at least one THEN action.",
    });
  }

  for (const action of statement.actions) {
    if (!action.verb.verbType) {
      errors.push({
        code: TYPECHECK_ERROR_CODES.INVALID_ACTION_VERB,
        message: `Action verb "${action.verb.lemma}" is not a known ledger verb.`,
      });
    }
    bindings.push(...bindAction(action, statement, context));
  }

  return { ok: errors.length === 0, errors, bindings };
}

/**
 * Resolve variable bindings for a rule action's slots. A determiner of "that"
 * on a target/object binds to the trigger's subject/object ($triggerObject);
 * a deictic "self" binds to $actor; a "them"/recipient binds to $recipient; an
 * object that is a task binds to $task; the trigger subject's group binds to
 * $group.
 */
function bindAction(
  action: Action,
  rule: RuleStatement,
  context: ParseContext,
): BoundVariable[] {
  const out: BoundVariable[] = [];

  // Target slot bindings ("give them …", "grant that …").
  if (action.target) {
    const b = bindSlotToVariable(action.target, context, BINDINGS.RECIPIENT);
    if (b) out.push({ role: "target", binding: b.binding, resolvedId: b.resolvedId });
  }

  // Object slot bindings.
  if (action.object) {
    if (action.object.kind === "task") {
      out.push({ role: "object", binding: BINDINGS.TASK });
    } else if (action.object.determiner === DETERMINER_KINDS.THAT) {
      out.push({ role: "object", binding: BINDINGS.TRIGGER_OBJECT });
    }
  }

  // The trigger subject implies $actor (who did the triggering action).
  if (rule.trigger.subject.deictic) {
    const binding = bindDeictic(rule.trigger.subject.deictic, context);
    out.push({
      role: "triggerSubject",
      binding: BINDINGS.ACTOR,
      ...(binding.resolvedId ? { resolvedId: binding.resolvedId } : {}),
    });
  }

  return out;
}

function bindSlotToVariable(
  slot: Slot,
  context: ParseContext,
  defaultBinding: Binding,
): { binding: Binding; resolvedId?: string } | null {
  if (slot.deictic) {
    const b = bindDeictic(slot.deictic, context);
    if (slot.deictic === "self") {
      return { binding: BINDINGS.ACTOR, ...(b.resolvedId ? { resolvedId: b.resolvedId } : {}) };
    }
    if (slot.deictic === "group") {
      return { binding: BINDINGS.GROUP, ...(b.resolvedId ? { resolvedId: b.resolvedId } : {}) };
    }
    // them / those → recipient ($triggerObject's actor).
    return { binding: defaultBinding };
  }
  if (slot.determiner === DETERMINER_KINDS.THAT) {
    return { binding: BINDINGS.TRIGGER_OBJECT };
  }
  return { binding: defaultBinding };
}
