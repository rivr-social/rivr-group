/**
 * @file explain.ts — human-readable rendering of a chosen interpretation.
 *
 * Turns a {@link Statement} / {@link Interpretation} back into a short English
 * gloss so a confirmation UI can show the user what the system understood before
 * it executes anything (plan §8: validate → typecheck → confirm). Pure string
 * formatting — no db, no IO.
 *
 * @dependencies ./ast. No db/IO.
 */

import {
  STATEMENT_KINDS,
  type Action,
  type Condition,
  type CreateStatement,
  type FindStatement,
  type Interpretation,
  type RuleStatement,
  type Slot,
  type Statement,
} from "./ast";

/** Render a slot to a short noun phrase. */
function explainSlot(slot: Slot): string {
  if (slot.deictic) {
    const map: Record<string, string> = {
      self: "you",
      group: "your group",
      this: "this",
      them: "them",
      here: "here",
      now: "now",
    };
    return map[slot.deictic] ?? slot.deictic;
  }
  const determiner = slot.determiner ? `${slot.determiner} ` : "";
  const kind = slot.groupSubtype ?? slot.regionSubtype ?? slot.kind ?? "thing";
  const name = slot.name ? ` "${slot.name}"` : "";
  return `${determiner}${kind}${name}`.trim();
}

function explainCondition(condition: Condition): string {
  const subject = explainSlot(condition.subject);
  const verb = condition.verb.lemma;
  const object = condition.object ? ` ${explainSlot(condition.object)}` : "";
  return `${subject} ${verb}${object}`.trim();
}

function explainAction(action: Action): string {
  const verb = action.verb.lemma;
  const target = action.target ? ` ${explainSlot(action.target)}` : "";
  const delta = action.delta !== undefined ? ` ${action.delta}` : "";
  const object = action.object ? ` ${explainSlot(action.object)}` : "";
  return `${verb}${target}${delta}${object}`.trim();
}

function explainCreate(statement: CreateStatement): string {
  const primary = statement.entities[0];
  const head = explainSlot(primary);
  if (primary.regionSubtype) {
    return `Create ${head} — NOT ALLOWED (${primary.regionSubtype} is backend-only).`;
  }
  const rels = statement.relationships
    .map((r) => {
      const parent = statement.entities[r.toIndex];
      return parent ? ` (${r.type.replace(/_/g, " ")} ${explainSlot(parent)})` : "";
    })
    .join("");
  return `Create ${head}${rels}.`;
}

function explainFind(statement: FindStatement): string {
  const what = statement.kind_ ? `${statement.kind_}s` : `${statement.domain}s`;
  const verb = statement.verb ? ` with ${statement.verb.lemma} activity` : "";
  const filters = statement.filters
    .map((f) => explainSlot(f))
    .filter(Boolean)
    .join(", ");
  const filterText = filters ? ` filtered by ${filters}` : "";
  return `Find ${what}${verb}${filterText}.`;
}

function explainRule(statement: RuleStatement): string {
  const when = explainCondition(statement.trigger);
  const then = statement.actions.map(explainAction).join(", and ");
  const iff = statement.condition
    ? ` (only if ${explainCondition(statement.condition)})`
    : "";
  const name = statement.name ? `"${statement.name}": ` : "";
  return `${name}When ${when}, then ${then}${iff}.`;
}

/** Render a single statement to an English gloss. */
export function explainStatement(statement: Statement): string {
  switch (statement.kind) {
    case STATEMENT_KINDS.CREATE:
      return explainCreate(statement);
    case STATEMENT_KINDS.FIND:
      return explainFind(statement);
    case STATEMENT_KINDS.RULE:
      return explainRule(statement);
    default:
      return "Unrecognized statement.";
  }
}

/** Render an interpretation with its confidence (as a percentage). */
export function explainInterpretation(interpretation: Interpretation): string {
  const pct = Math.round(interpretation.confidence * 100);
  return `${explainStatement(interpretation.statement)} [${pct}% confident: ${interpretation.rationale}]`;
}
