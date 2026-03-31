/**
 * Canonical verb mapping between engine Verb enum (past tense) and schema
 * verb_type enum (present tense).
 *
 * This is the single source of truth. All verb translation in engine.ts and
 * contract-engine.ts must go through these exports.
 */

import type { Verb } from './engine';
import type { VerbType } from '../db/schema';

// ─── Forward map: engine Verb (past) → schema verb string (present) ─────────

/**
 * Maps every engine Verb value to its schema verb_type counterpart.
 *
 * Collision notes (intentional many-to-one mappings):
 *  - VALIDATED → 'approve'  AND  APPROVED → 'approve'
 *    Both engine verbs collapse to 'approve' in the schema because the
 *    verb_type enum has no separate 'validate' value. When reading ledger
 *    rows back, use metadata.engineVerb to distinguish the two.
 *  - ALLOCATED → 'assign'  AND  ASSIGNED → 'assign'
 *    Same rationale — schema has one 'assign' verb for both concepts.
 *  - REVOKED → 'delete'
 *    The schema reuses 'delete' for revocation actions.
 */
const VERB_MAP_ENTRIES: readonly [string, string][] = [
  // Core / CRUD
  ['created', 'create'],
  ['completed', 'complete'],
  ['validated', 'approve'],   // collision: also mapped by APPROVED (see below)
  ['transferred', 'transfer'],
  ['endorsed', 'endorse'],
  ['revoked', 'delete'],      // schema reuses 'delete' for revocations
  ['requested', 'request'],
  ['allocated', 'assign'],    // collision: also mapped by ASSIGNED (see below)
  // Membership / Structural
  ['joined', 'join'],
  ['belonged', 'belong'],
  ['assigned', 'assign'],     // collision: also mapped by ALLOCATED (see above)
  ['invited', 'invite'],
  ['employed', 'employ'],
  ['contained', 'contain'],
  ['managed', 'manage'],
  ['owned', 'own'],
  ['followed', 'follow'],
  ['located', 'locate'],
  // Economic
  ['bought', 'buy'],
  ['sold', 'sell'],
  ['traded', 'trade'],
  ['gifted', 'gift'],
  ['earned', 'earn'],
  ['redeemed', 'redeem'],
  ['funded', 'fund'],
  ['pledged', 'pledge'],
  ['transacted', 'transact'],
  // Work
  ['worked', 'work'],
  ['clocked_in', 'clock_in'],
  ['clocked_out', 'clock_out'],
  ['produced', 'produce'],
  ['consumed', 'consume'],
  // Governance
  ['voted', 'vote'],
  ['proposed', 'propose'],
  ['approved', 'approve'],    // collision: also mapped by VALIDATED (see above)
  ['rejected', 'reject'],
  // Lifecycle
  ['started', 'start'],
  ['cancelled', 'cancel'],
  ['archived', 'archive'],
  ['published', 'publish'],
  // Spatial / Temporal
  ['attended', 'attend'],
  ['hosted', 'host'],
  ['scheduled', 'schedule'],
  // Social
  ['shared', 'share'],
  ['mentioned', 'mention'],
  ['commented', 'comment'],
  ['reacted', 'react'],
] as const;

/**
 * Forward map: engine Verb (past tense) → schema verb_type (present tense).
 * Keyed by the string value of the Verb enum.
 */
export const ENGINE_VERB_TO_SCHEMA: Readonly<Record<string, VerbType>> =
  Object.fromEntries(VERB_MAP_ENTRIES) as Record<string, VerbType>;

/**
 * Reverse map: schema verb_type (present tense) → engine Verb (past tense).
 *
 * Because the forward map is many-to-one (e.g. VALIDATED and APPROVED both
 * map to 'approve'), the reverse picks the LAST entry for each schema verb.
 * Specifically:
 *  - 'approve' → APPROVED  (not VALIDATED)
 *  - 'assign'  → ASSIGNED  (not ALLOCATED)
 *
 * The contract-engine also includes 'give' → GIFTED as a UI alias.
 */
export const SCHEMA_VERB_TO_ENGINE: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [engine, schema] of VERB_MAP_ENTRIES) {
    map[schema] = engine;
  }
  // UI alias: 'give' is a synonym for 'gift' in the schema enum
  map['give'] = 'gifted';
  return map;
})();

// ─── Helper functions ────────────────────────────────────────────────────────

/**
 * Convert an engine Verb (past tense) to its schema verb_type string.
 * Returns the verb unchanged (as a string) if no mapping exists.
 */
export function engineVerbToSchema(verb: Verb): VerbType {
  const mapped = ENGINE_VERB_TO_SCHEMA[verb as string];
  if (!mapped) {
    throw new Error(`Unmapped engine verb has no schema equivalent: ${verb}`);
  }
  return mapped;
}

/**
 * Convert a schema verb_type string (present tense) to an engine Verb.
 * Returns the verb unchanged if no mapping exists.
 *
 * Note: 'approve' resolves to APPROVED (not VALIDATED), and 'assign'
 * resolves to ASSIGNED (not ALLOCATED). Use metadata.engineVerb on ledger
 * rows when the distinction matters.
 */
export function schemaVerbToEngine(verb: string): Verb {
  const mapped = SCHEMA_VERB_TO_ENGINE[verb];
  if (!mapped) {
    throw new Error(`Unmapped schema verb has no engine equivalent: ${verb}`);
  }
  return mapped as Verb;
}
