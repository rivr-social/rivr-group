/**
 * @file to-contract-rule.ts — RuleStatement → CreateContractRuleInput.
 *
 * Compiles a typechecked {@link RuleStatement} into the existing
 * {@link CreateContractRuleInput} contract consumed by `createContractRule`.
 *
 * Key impedance match (plan §3.1): the contract store does NOT use `$bindings`
 * — it stores DETERMINERS (`any/my/the/that/a/all`) plus optional ids. This
 * compiler therefore lowers the AST's variable bindings + slots back into
 * determiner+id pairs:
 *   - a deictic `self`/`group` subject → determiner `my` with the grounded id
 *   - an `any` determiner (from "anyone"/"a member") → determiner `any`, no id
 *   - a `that`/trigger-object reference in an action → determiner `that`, no id
 *   - a resolved named slot → determiner `the` + its id
 *
 * Pure transform: no db, no permission checks. The contract engine re-checks
 * permissions at fire time (plan §8). Callers MUST `typecheck` first.
 *
 * @dependencies ./..ast, `@/app/actions/contracts` (types),
 *   `@/db/schema` (ContractAction). No db/IO.
 */

import {
  DETERMINER_KINDS,
  type Action,
  type Condition,
  type RuleStatement,
  type Slot,
} from "../ast";
import type { CreateContractRuleInput } from "@/app/actions/contracts";
import type { ContractAction } from "@/db/schema";

/** Specific compile error codes. */
export const CONTRACT_COMPILE_ERROR_CODES = {
  NO_TRIGGER_VERB: "NO_TRIGGER_VERB",
  NO_ACTIONS: "NO_ACTIONS",
  NO_ACTION_VERB: "NO_ACTION_VERB",
} as const;

export type ContractCompileErrorCode =
  (typeof CONTRACT_COMPILE_ERROR_CODES)[keyof typeof CONTRACT_COMPILE_ERROR_CODES];

export class ContractRuleCompileError extends Error {
  readonly code: ContractCompileErrorCode;
  constructor(code: ContractCompileErrorCode, message: string) {
    super(message);
    this.name = "ContractRuleCompileError";
    this.code = code;
  }
}

/** Resolved ids per slot, keyed by the slot's source phrase, from the resolver. */
export type SlotIdMap = ReadonlyMap<string, string>;

/**
 * Lower a slot to a contract determiner + (optional) id. Resolution ids, when
 * available, are supplied via `ids` keyed by the slot's source phrase.
 */
function lowerSlot(
  slot: Slot | undefined,
  ids: SlotIdMap,
): { determiner: string | null; id: string | null } {
  if (!slot) return { determiner: null, id: null };

  // Deictic subject/object → determiner "my" + grounded id (self/group).
  if (slot.deictic === "self" || slot.deictic === "group") {
    return { determiner: DETERMINER_KINDS.MY, id: ids.get(slot.source) ?? null };
  }
  // "this"/"them" → reference the trigger object via determiner "that".
  if (slot.deictic === "this" || slot.deictic === "them") {
    return { determiner: DETERMINER_KINDS.THAT, id: null };
  }

  // Explicit determiner present.
  if (slot.determiner) {
    const isWildcard =
      slot.determiner === DETERMINER_KINDS.ANY ||
      slot.determiner === DETERMINER_KINDS.ALL;
    const resolvedId = isWildcard ? null : ids.get(slot.source) ?? null;
    return { determiner: slot.determiner, id: resolvedId };
  }

  // Named slot with a resolved id → "the" + id.
  const id = ids.get(slot.source) ?? null;
  if (id) return { determiner: DETERMINER_KINDS.THE, id };

  // Bare named slot, unresolved → "the" + null (executor resolves at fire time).
  if (slot.name) return { determiner: DETERMINER_KINDS.THE, id: null };

  return { determiner: null, id: null };
}

/** Lower a rule {@link Condition} (trigger or IF) into determiner+id+verb slots. */
function lowerCondition(condition: Condition, ids: SlotIdMap) {
  const subject = lowerSlot(condition.subject, ids);
  const object = lowerSlot(condition.object, ids);
  return {
    subjectDeterminer: subject.determiner,
    subjectId: subject.id,
    verb: condition.verb.verbType,
    objectDeterminer: object.determiner,
    objectId: object.id,
  };
}

/** Lower an AST {@link Action} into a {@link ContractAction}. */
function lowerAction(action: Action, ids: SlotIdMap): ContractAction {
  if (!action.verb.verbType) {
    throw new ContractRuleCompileError(
      CONTRACT_COMPILE_ERROR_CODES.NO_ACTION_VERB,
      `Action verb "${action.verb.lemma}" is not a known ledger verb.`,
    );
  }
  const object = lowerSlot(action.object, ids);
  const target = lowerSlot(action.target, ids);
  return {
    verb: action.verb.verbType,
    ...(object.determiner ? { objectDeterminer: object.determiner } : {}),
    ...(object.id ? { objectId: object.id } : {}),
    ...(target.determiner ? { targetDeterminer: target.determiner } : {}),
    ...(target.id ? { targetId: target.id } : {}),
    ...(action.delta !== undefined ? { delta: action.delta } : {}),
  };
}

/**
 * Compile a {@link RuleStatement} into a {@link CreateContractRuleInput}.
 *
 * @param statement A typechecked rule statement.
 * @param opts Rule name, optional scope id, optional maxFires, and a map of
 *   slot-source → resolved id (from the resolver) for binding lowering.
 * @throws {ContractRuleCompileError} on missing trigger/action verbs.
 */
export function compileToContractRule(
  statement: RuleStatement,
  opts: {
    name: string;
    scopeId?: string | null;
    maxFires?: number | null;
    ids?: SlotIdMap;
  },
): CreateContractRuleInput {
  const ids: SlotIdMap = opts.ids ?? new Map();

  if (!statement.trigger.verb.verbType) {
    throw new ContractRuleCompileError(
      CONTRACT_COMPILE_ERROR_CODES.NO_TRIGGER_VERB,
      `Trigger verb "${statement.trigger.verb.lemma}" is not a known ledger verb.`,
    );
  }
  if (statement.actions.length === 0) {
    throw new ContractRuleCompileError(
      CONTRACT_COMPILE_ERROR_CODES.NO_ACTIONS,
      "A rule must have at least one THEN action.",
    );
  }

  const trigger = lowerCondition(statement.trigger, ids);
  const actions = statement.actions.map((a) => lowerAction(a, ids));
  const condition = statement.condition
    ? lowerCondition(statement.condition, ids)
    : null;

  return {
    name: opts.name,
    scopeId: opts.scopeId ?? null,

    triggerSubjectDeterminer: trigger.subjectDeterminer,
    triggerSubjectId: trigger.subjectId,
    triggerVerb: trigger.verb,
    triggerObjectDeterminer: trigger.objectDeterminer,
    triggerObjectId: trigger.objectId,

    actions,

    conditionSubjectDeterminer: condition?.subjectDeterminer ?? null,
    conditionSubjectId: condition?.subjectId ?? null,
    conditionVerb: condition?.verb ?? null,
    conditionObjectDeterminer: condition?.objectDeterminer ?? null,
    conditionObjectId: condition?.objectId ?? null,

    maxFires: opts.maxFires ?? null,
  };
}
