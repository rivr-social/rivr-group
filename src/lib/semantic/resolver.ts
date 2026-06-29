/**
 * @file resolver.ts — slot → { candidates[], resolvedId? }. SEPARATE from parsing.
 *
 * Entity resolution is a distinct pass from parsing (plan §2). The parser emits
 * UNRESOLVED {@link Slot}s; the resolver maps each named/deictic slot to db
 * candidates and, when unambiguous, a resolved id. The candidate source is the
 * existing permission-aware composer reads — `fetchAgentsForComposer` /
 * `fetchResourcesForComposer` — so resolution inherits the platform's visibility
 * filtering (the resolver never widens what the user can see).
 *
 * Deictic slots (self/group/here/now/this/them) are grounded against the
 * {@link ParseContext}, never against the db.
 *
 * @dependencies ./ast, ./context, `@/app/actions/graph/composer`. The composer
 *   functions are the ONLY db touchpoint and are mocked in unit tests.
 */

import {
  SEMANTIC_DOMAINS,
  type Slot,
  type Statement,
  type CreateStatement,
  type FindStatement,
  type RuleStatement,
  STATEMENT_KINDS,
} from "./ast";
import { bindDeictic, type ParseContext } from "./context";
import {
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "@/app/actions/graph/composer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single resolution candidate for a slot. */
export interface ResolutionCandidate {
  id: string;
  name: string;
  /** db type string (agent_type or resource_type). */
  type: string;
  /** Match score in [0,1] — exact name match ranks highest. */
  score: number;
}

/** Resolution outcome for one slot. */
export interface ResolvedSlot {
  /** The original slot. */
  slot: Slot;
  /** Ranked candidate matches (may be empty). */
  candidates: ResolutionCandidate[];
  /** Set when resolution is unambiguous (single strong candidate or deixis). */
  resolvedId?: string;
  /** Set for deictic slots grounded to a literal (e.g. now → ISO timestamp). */
  resolvedValue?: string;
  /** True when the slot could not be resolved (no candidates / unbound deixis). */
  unresolved: boolean;
  /** Specific reason when unresolved. */
  reason?: string;
}

export interface ResolutionResult {
  slots: ResolvedSlot[];
}

/** The candidate-source functions, injectable for testing. */
export interface ResolverSources {
  fetchAgents: typeof fetchAgentsForComposer;
  fetchResources: typeof fetchResourcesForComposer;
}

const DEFAULT_SOURCES: ResolverSources = {
  fetchAgents: fetchAgentsForComposer,
  fetchResources: fetchResourcesForComposer,
};

/** Reasons a slot could not be resolved (specific, not generic). */
export const RESOLUTION_REASONS = {
  NO_NAME_OR_DEIXIS: "slot has no name or deictic reference to resolve",
  NO_CANDIDATES: "no visible candidates matched the name",
  UNBOUND_DEICTIC: "deictic reference could not be grounded in context",
  LITERAL_NEW: "slot describes a new entity to create, not an existing one",
} as const;

const EXACT_MATCH_SCORE = 1;
const PREFIX_MATCH_SCORE = 0.8;
const SUBSTRING_MATCH_SCORE = 0.6;
const UNAMBIGUOUS_SCORE_THRESHOLD = 0.99;

// ---------------------------------------------------------------------------
// Slot resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single slot against context + candidate sources. Pure aside from
 * the injected composer reads. Order: literal-new → deictic → named lookup.
 */
export async function resolveSlot(
  slot: Slot,
  context: ParseContext,
  sources: ResolverSources = DEFAULT_SOURCES,
): Promise<ResolvedSlot> {
  // New entities are not resolved against existing rows.
  if (slot.literalNew) {
    return {
      slot,
      candidates: [],
      unresolved: true,
      reason: RESOLUTION_REASONS.LITERAL_NEW,
    };
  }

  // Deictic grounding (never touches db).
  if (slot.deictic) {
    const binding = bindDeictic(slot.deictic, context);
    if (binding.unbound) {
      return {
        slot,
        candidates: [],
        unresolved: true,
        reason: binding.reason ?? RESOLUTION_REASONS.UNBOUND_DEICTIC,
      };
    }
    return {
      slot,
      candidates: [],
      ...(binding.resolvedId ? { resolvedId: binding.resolvedId } : {}),
      ...(binding.resolvedValue ? { resolvedValue: binding.resolvedValue } : {}),
      unresolved: false,
    };
  }

  // Named lookup against the permission-aware candidate source.
  if (!slot.name || !slot.name.trim()) {
    return {
      slot,
      candidates: [],
      unresolved: true,
      reason: RESOLUTION_REASONS.NO_NAME_OR_DEIXIS,
    };
  }

  const candidates = await fetchCandidates(slot, context, sources);
  if (candidates.length === 0) {
    return {
      slot,
      candidates: [],
      unresolved: true,
      reason: RESOLUTION_REASONS.NO_CANDIDATES,
    };
  }

  const top = candidates[0];
  const unambiguous =
    top.score >= UNAMBIGUOUS_SCORE_THRESHOLD &&
    (candidates.length === 1 || candidates[1].score < top.score);

  return {
    slot,
    candidates,
    ...(unambiguous ? { resolvedId: top.id } : {}),
    unresolved: !unambiguous,
    ...(unambiguous ? {} : { reason: RESOLUTION_REASONS.NO_CANDIDATES }),
  };
}

/** Query + score candidates for a named slot from the appropriate source. */
async function fetchCandidates(
  slot: Slot,
  _context: ParseContext,
  sources: ResolverSources,
): Promise<ResolutionCandidate[]> {
  const needle = slot.name!.trim().toLowerCase();

  if (slot.domain === SEMANTIC_DOMAINS.AGENT) {
    const agents = await sources.fetchAgents();
    return scoreCandidates(
      agents.map((a) => ({ id: a.id, name: a.name, type: a.type })),
      needle,
    );
  }

  // Default to resource candidates (composer uses `title`).
  const resources = await sources.fetchResources({ limit: 200 });
  return scoreCandidates(
    resources.map((r) => ({ id: r.id, name: r.title, type: r.type })),
    needle,
  );
}

/** Score a name against candidates: exact > prefix > substring; drop misses. */
function scoreCandidates(
  rows: Array<{ id: string; name: string; type: string }>,
  needle: string,
): ResolutionCandidate[] {
  const scored: ResolutionCandidate[] = [];
  for (const row of rows) {
    const hay = row.name.toLowerCase();
    let score = 0;
    if (hay === needle) score = EXACT_MATCH_SCORE;
    else if (hay.startsWith(needle)) score = PREFIX_MATCH_SCORE;
    else if (hay.includes(needle)) score = SUBSTRING_MATCH_SCORE;
    if (score > 0) scored.push({ id: row.id, name: row.name, type: row.type, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Statement resolution
// ---------------------------------------------------------------------------

/** Collect every resolvable slot from a statement (skips literal-new creates). */
function collectSlots(statement: Statement): Slot[] {
  switch (statement.kind) {
    case STATEMENT_KINDS.CREATE: {
      const s = statement as CreateStatement;
      // Only linked/existing entities (literalNew=false) are resolved.
      return s.entities.filter((e) => e.literalNew === false);
    }
    case STATEMENT_KINDS.FIND: {
      const s = statement as FindStatement;
      return s.filters;
    }
    case STATEMENT_KINDS.RULE: {
      const s = statement as RuleStatement;
      const slots: Slot[] = [s.trigger.subject];
      if (s.trigger.object) slots.push(s.trigger.object);
      for (const a of s.actions) {
        if (a.target) slots.push(a.target);
        if (a.object) slots.push(a.object);
      }
      if (s.condition) {
        slots.push(s.condition.subject);
        if (s.condition.object) slots.push(s.condition.object);
      }
      return slots;
    }
    default:
      return [];
  }
}

/**
 * Resolve all resolvable slots in a statement. Permission-aware via the
 * composer candidate source. Returns one {@link ResolvedSlot} per slot.
 */
export async function resolveStatement(
  statement: Statement,
  context: ParseContext,
  sources: ResolverSources = DEFAULT_SOURCES,
): Promise<ResolutionResult> {
  const slots = collectSlots(statement);
  const resolved = await Promise.all(
    slots.map((slot) => resolveSlot(slot, context, sources)),
  );
  return { slots: resolved };
}
