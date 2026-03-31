/**
 * Contract Rule Engine — evaluates saved WHEN/THEN/IF rules against ledger entries.
 *
 * Purpose:
 * - After each ledger write, check all enabled contract rules for matching triggers.
 * - If a rule's trigger pattern matches and any optional condition passes, execute
 *   all chained actions sequentially via `processSentence`.
 * - Determiners (any, my, the, that) control how slots resolve at runtime.
 * - Manages fire counts and auto-disables rules that reach their maxFires limit.
 *
 * Loop prevention:
 * - Every rule-triggered ledger entry includes `triggeredByRule: ruleId` in metadata.
 * - Chain depth is tracked via `_ruleChainDepth` to prevent infinite recursion.
 *
 * Dependencies:
 * - `db` and `contractRules`/`ledger` from schema for rule queries and updates.
 * - `processSentence` from `./engine` for executing rule actions.
 */

import { db } from '@/db';
import { contractRules, ledger } from '@/db/schema';
import type { ContractAction } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import type { ProcessingResult, Verb } from './engine';
import { SCHEMA_VERB_TO_ENGINE } from './verb-map';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum recursion depth to prevent infinite rule chains. */
const MAX_RULE_CHAIN_DEPTH = 5;

/**
 * Maps present-tense verb_type values (from schema/composer) to past-tense engine Verb values.
 * Delegates to the canonical SCHEMA_VERB_TO_ENGINE from verb-map.ts.
 */
const PRESENT_TO_ENGINE_VERB: Record<string, Verb> =
  SCHEMA_VERB_TO_ENGINE as Record<string, Verb>;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RuleEvaluationEntry {
  subjectId: string;
  verb: string;
  objectId: string;
  delta: number;
  metadata: Record<string, unknown>;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Evaluate all enabled contract rules against a newly written ledger entry.
 * This is called fire-and-forget after the ledger transaction commits.
 *
 * @param entry - The ledger entry that was just written (present-tense verb from schema).
 */
export async function evaluateRules(entry: RuleEvaluationEntry): Promise<void> {
  // Prevent deep rule chains
  const chainDepth = typeof entry.metadata._ruleChainDepth === 'number'
    ? entry.metadata._ruleChainDepth
    : 0;
  if (chainDepth >= MAX_RULE_CHAIN_DEPTH) {
    console.warn('[contract-engine] Max rule chain depth reached, skipping evaluation');
    return;
  }

  try {
    const rules = await db
      .select()
      .from(contractRules)
      .where(eq(contractRules.enabled, true));

    for (const rule of rules) {
      try {
        await evaluateSingleRule(rule, entry, chainDepth);
      } catch (err) {
        console.error(`[contract-engine] Rule ${rule.id} (${rule.name}) evaluation error:`, err);
      }
    }
  } catch (err) {
    console.error('[contract-engine] Failed to fetch rules:', err);
  }
}

// ─── Single Rule Evaluation ──────────────────────────────────────────────────

async function evaluateSingleRule(
  rule: typeof contractRules.$inferSelect,
  entry: RuleEvaluationEntry,
  chainDepth: number
): Promise<void> {
  // Loop prevention: skip if this entry was triggered by the same rule
  if (entry.metadata.triggeredByRule === rule.id) {
    return;
  }

  // Check fire limit
  if (rule.maxFires !== null && rule.fireCount >= rule.maxFires) {
    return;
  }

  // ─── Pattern matching: trigger with determiners ───
  if (!matchesTrigger(rule, entry)) {
    return;
  }

  // ─── Optional condition check ───
  if (rule.conditionVerb) {
    const conditionPasses = await checkCondition(rule, entry);
    if (!conditionPasses) {
      return;
    }
  }

  // ─── Execute all chained actions sequentially ───
  const actions = rule.actions ?? [];
  if (actions.length === 0) {
    return;
  }

  let allSucceeded = true;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const success = await executeAction(rule, action, entry, chainDepth, i);
    if (!success) {
      allSucceeded = false;
      console.warn(
        `[contract-engine] Rule "${rule.name}" action ${i + 1}/${actions.length} failed, stopping chain`
      );
      break;
    }
  }

  if (!allSucceeded) return;

  // Atomic CAS guard: only increment if fire_count hasn't changed since we read it.
  // If another concurrent evaluation already fired this rule, 0 rows will be affected
  // and we skip the duplicate fire silently.
  const newFireCount = rule.fireCount + 1;
  const shouldDisable = rule.maxFires !== null && newFireCount >= rule.maxFires;

  const updateResult = await db
    .update(contractRules)
    .set({
      fireCount: newFireCount,
      enabled: shouldDisable ? false : rule.enabled,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(contractRules.id, rule.id),
        eq(contractRules.fireCount, rule.fireCount),
      ),
    )
    .returning({ id: contractRules.id });

  if (updateResult.length === 0) {
    // Another concurrent evaluation already incremented — skip this duplicate fire.
    console.warn(
      `[contract-engine] Rule "${rule.name}" CAS conflict — skipping duplicate fire`,
    );
    return;
  }

  console.log(
    `[contract-engine] Rule "${rule.name}" fired ${actions.length} action(s) ` +
    `(${newFireCount}/${rule.maxFires ?? 'unlimited'})` +
    (shouldDisable ? ' — now disabled (max fires reached)' : '')
  );
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(
  rule: typeof contractRules.$inferSelect,
  action: ContractAction,
  entry: RuleEvaluationEntry,
  chainDepth: number,
  actionIndex: number
): Promise<boolean> {
  const { processSentence } = await import('./engine');
  const engineVerb = PRESENT_TO_ENGINE_VERB[action.verb];
  if (!engineVerb) {
    console.warn(`[contract-engine] Rule ${rule.id}: no engine mapping for verb "${action.verb}"`);
    return false;
  }

  // Resolve target via determiner
  const targetId = resolveAgentSlot(
    action.targetDeterminer,
    action.targetId,
    rule.ownerId,
    entry.subjectId
  );

  // Resolve object via determiner
  const objectId = resolveResourceSlot(
    action.objectDeterminer,
    action.objectId,
    rule.ownerId,
    entry.objectId
  );

  // Subject is always the rule owner
  const result: ProcessingResult = await processSentence({
    subjectId: rule.ownerId,
    verb: engineVerb,
    object: objectId,
    delta: action.delta ?? 0,
    metadata: {
      triggeredByRule: rule.id,
      actionIndex,
      triggerEntry: {
        subjectId: entry.subjectId,
        verb: entry.verb,
        objectId: entry.objectId,
      },
      actionTargetId: targetId,
      _ruleChainDepth: chainDepth + 1,
    },
  });

  return result.success;
}

// ─── Determiner Resolution ───────────────────────────────────────────────────

/**
 * Resolve an agent slot based on its determiner.
 * - "any" = no filter (returns fallback)
 * - "my" = rule owner
 * - "the" / "that" = trigger's subject
 * - null/specific = use the explicit ID, or fallback
 */
function resolveAgentSlot(
  determiner: string | undefined | null,
  explicitId: string | undefined | null,
  ownerId: string,
  triggerSubjectId: string
): string {
  switch (determiner) {
    case 'my':
      return ownerId;
    case 'the':
    case 'that':
      return triggerSubjectId;
    case 'any':
      return explicitId ?? triggerSubjectId;
    default:
      return explicitId ?? triggerSubjectId;
  }
}

/**
 * Resolve a resource/object slot based on its determiner.
 * - "any" / "a" / "all" = use explicit ID or trigger's object
 * - "my" = filter by owner (at this level, just use explicit ID)
 * - "the" / "that" = trigger's object
 * - null/specific = use the explicit ID, or fallback
 */
function resolveResourceSlot(
  determiner: string | undefined | null,
  explicitId: string | undefined | null,
  _ownerId: string,
  triggerObjectId: string
): string {
  switch (determiner) {
    case 'the':
    case 'that':
      return triggerObjectId;
    case 'any':
    case 'a':
    case 'all':
      return explicitId ?? triggerObjectId;
    case 'my':
      return explicitId ?? triggerObjectId;
    default:
      return explicitId ?? triggerObjectId;
  }
}

// ─── Pattern Matching ────────────────────────────────────────────────────────

/**
 * Check if an entry matches a rule's trigger pattern, respecting determiners.
 * Null/any-determiner fields act as wildcards (match anything).
 */
function matchesTrigger(
  rule: typeof contractRules.$inferSelect,
  entry: RuleEvaluationEntry
): boolean {
  // Subject match with determiner awareness
  if (rule.triggerSubjectDeterminer === 'my') {
    // "my" in trigger subject = the trigger actor must be the rule owner
    if (entry.subjectId !== rule.ownerId) return false;
  } else if (rule.triggerSubjectDeterminer !== 'any' && rule.triggerSubjectId) {
    // Specific agent must match
    if (rule.triggerSubjectId !== entry.subjectId) return false;
  }
  // "any" = no filter on subject

  // Verb match
  if (rule.triggerVerb && rule.triggerVerb !== entry.verb) {
    return false;
  }

  // Object match with determiner awareness
  if (rule.triggerObjectDeterminer === 'my') {
    // "my" objects: would need an ownership check in a full implementation.
    // For now, if an explicit objectId is set, match against it.
    if (rule.triggerObjectId && rule.triggerObjectId !== entry.objectId) return false;
  } else if (
    rule.triggerObjectDeterminer !== 'any' &&
    rule.triggerObjectDeterminer !== 'a' &&
    rule.triggerObjectDeterminer !== 'all' &&
    rule.triggerObjectId
  ) {
    if (rule.triggerObjectId !== entry.objectId) return false;
  }

  return true;
}

// ─── Condition Check ─────────────────────────────────────────────────────────

/**
 * Check if a rule's IF condition is satisfied by querying the ledger
 * for the existence of a matching entry, respecting determiners.
 */
async function checkCondition(
  rule: typeof contractRules.$inferSelect,
  entry: RuleEvaluationEntry
): Promise<boolean> {
  if (!rule.conditionVerb) return true;

  const conditions = [eq(ledger.verb, rule.conditionVerb as never)];

  // Resolve condition subject via determiner
  if (rule.conditionSubjectDeterminer === 'my') {
    conditions.push(eq(ledger.subjectId, rule.ownerId));
  } else if (rule.conditionSubjectDeterminer === 'the' || rule.conditionSubjectDeterminer === 'that') {
    conditions.push(eq(ledger.subjectId, entry.subjectId));
  } else if (rule.conditionSubjectId) {
    conditions.push(eq(ledger.subjectId, rule.conditionSubjectId));
  }

  // Resolve condition object via determiner
  if (rule.conditionObjectDeterminer === 'the' || rule.conditionObjectDeterminer === 'that') {
    conditions.push(eq(ledger.objectId, entry.objectId));
  } else if (rule.conditionObjectDeterminer === 'my') {
    // Owner-filtered — use explicit ID if provided
    if (rule.conditionObjectId) {
      conditions.push(eq(ledger.objectId, rule.conditionObjectId));
    }
  } else if (rule.conditionObjectId) {
    conditions.push(eq(ledger.objectId, rule.conditionObjectId));
  }

  const matches = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(and(...conditions))
    .limit(1);

  return matches.length > 0;
}
