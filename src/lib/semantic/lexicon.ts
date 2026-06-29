/**
 * @file Lexicon — the controlled vocabulary for the semantic parser.
 *
 * Maps surface English to the clean AST ontology and, at the storage boundary,
 * the clean ontology to the messy DB enums. Reuses the verb groupings already
 * encoded in `nlp-parser-v2.ts` and the canonical 5 create types + relationship
 * types from `nlp-parser.ts`, so there is one source of truth for the platform's
 * verb/type vocabulary rather than a parallel dictionary.
 *
 * Sections:
 *  1. Verb lexicon (surface verb → verb_type enum, grouped).
 *  2. Determiners + deictic pronouns.
 *  3. Clean ontology head-noun table (English noun → AST kind/subtype).
 *  4. DB-enum mapping (AST kind/subtype → agent_type / EntityType).
 *
 * @dependencies `@/db/schema` (VerbType), `@/lib/nlp-parser` (EntityType,
 *   RelationshipType, RELATIONSHIP_TYPES). No db/IO.
 */

import type { VerbType } from "@/db/schema";
import type { EntityType, RelationshipType } from "@/lib/nlp-parser";
import { RELATIONSHIP_TYPES } from "@/lib/nlp-parser";
import {
  AGENT_KINDS,
  DEICTIC_REFS,
  DETERMINER_KINDS,
  GROUP_SUBTYPES,
  REGION_SUBTYPES,
  RESOURCE_KINDS,
  SEMANTIC_DOMAINS,
  type AgentKind,
  type DeicticRef,
  type DeterminerKind,
  type GroupSubtype,
  type RegionSubtype,
  type ResourceKind,
  type SemanticDomain,
} from "./ast";

// ---------------------------------------------------------------------------
// 1. Verb lexicon
// ---------------------------------------------------------------------------

/**
 * Surface verb (and common synonyms) → canonical db verb_type enum value.
 *
 * The keys mirror the verb groupings in `nlp-parser-v2.ts` (STRUCTURAL/ECONOMIC/
 * WORK/GOVERNANCE/LIFECYCLE/SPATIOTEMPORAL/SOCIAL/PERMISSION) and the CRUD set,
 * expanded with natural synonyms. Every value is a real member of
 * `verbTypeEnum`, enforced by the `VerbType` annotation below.
 */
export const VERB_LEXICON: Record<string, VerbType> = {
  // CRUD
  create: "create",
  make: "create",
  add: "create",
  start: "start",
  launch: "create",
  build: "create",
  establish: "create",
  form: "create",
  organize: "create",
  plan: "create",
  setup: "create",
  "set up": "create",
  hold: "host",
  throw: "host",
  arrange: "schedule",
  open: "create",
  register: "create",
  update: "update",
  edit: "update",
  change: "update",
  delete: "delete",
  remove: "delete",
  transfer: "transfer",
  share: "share",
  view: "view",
  clone: "clone",
  merge: "merge",
  split: "split",
  // Economic
  transact: "transact",
  buy: "buy",
  purchase: "buy",
  sell: "sell",
  trade: "trade",
  gift: "gift",
  give: "give",
  earn: "earn",
  redeem: "redeem",
  fund: "fund",
  pledge: "pledge",
  pay: "transact",
  // Work
  work: "work",
  "clock in": "clock_in",
  "clock out": "clock_out",
  produce: "produce",
  consume: "consume",
  // Governance
  vote: "vote",
  propose: "propose",
  approve: "approve",
  reject: "reject",
  // Structural / Membership
  join: "join",
  manage: "manage",
  own: "own",
  locate: "locate",
  follow: "follow",
  belong: "belong",
  assign: "assign",
  invite: "invite",
  employ: "employ",
  hire: "employ",
  contain: "contain",
  // Lifecycle
  complete: "complete",
  finish: "complete",
  cancel: "cancel",
  archive: "archive",
  publish: "publish",
  // Spatio-temporal
  attend: "attend",
  host: "host",
  schedule: "schedule",
  // Social
  endorse: "endorse",
  mention: "mention",
  comment: "comment",
  react: "react",
  like: "react",
  // (block/mute moderation verbs omitted: not in this instance's verb_type enum)
  // Permissions
  grant: "grant",
  revoke: "revoke",
  rent: "rent",
  use: "use",
  leave: "leave",
  request: "request",
  refund: "refund",
};

/**
 * Verbs (db verb_type values) that express CREATION intent. Used by the parser
 * to classify a statement as a CREATE. Mirrors `CREATION_VERBS` in v2 mapped to
 * canonical verb types.
 */
export const CREATION_VERB_TYPES: ReadonlySet<VerbType> = new Set<VerbType>([
  "create",
  "start",
  "host",
  "schedule",
  "publish",
]);

/** Surface lemmas that signal a query/find intent (no db verb_type of their own). */
export const FIND_LEMMAS: ReadonlySet<string> = new Set([
  "find",
  "show",
  "list",
  "search",
  "get",
  "who",
  "what",
  "which",
  "where",
]);

/** Lemmas that introduce a rule trigger clause. */
export const RULE_TRIGGER_LEMMAS: ReadonlySet<string> = new Set(["when", "whenever"]);

/** Lemmas that introduce a rule action clause. */
export const RULE_ACTION_LEMMAS: ReadonlySet<string> = new Set(["then"]);

/** Lemmas that introduce a rule condition gate. */
export const RULE_CONDITION_LEMMAS: ReadonlySet<string> = new Set(["if"]);

/**
 * Naive English verb stemmer for present/past inflections so conjugated input
 * ("joins"/"joined"/"completes"/"following") resolves to its lexicon base form.
 * Tries the surface form first, then a small ordered set of de-inflections.
 */
export function stemVerb(surface: string): string {
  const w = surface.toLowerCase();
  if (VERB_LEXICON[w]) return w;
  const candidates: string[] = [];
  // -ies → -y (e.g. "applies" → "apply")
  if (w.endsWith("ies")) candidates.push(`${w.slice(0, -3)}y`);
  // -ed → base (created → create, joined → join, planned → plan)
  if (w.endsWith("ed")) {
    candidates.push(w.slice(0, -2)); // joined → join
    candidates.push(w.slice(0, -1)); // created → create
    if (/(.)\1ed$/.test(w)) candidates.push(w.slice(0, -3)); // planned → plan
  }
  // -ing → base (creating → create, planning → plan)
  if (w.endsWith("ing")) {
    candidates.push(w.slice(0, -3)); // following → follow
    candidates.push(`${w.slice(0, -3)}e`); // creating → create
    if (/(.)\1ing$/.test(w)) candidates.push(w.slice(0, -4)); // planning → plan
  }
  // -es → base (completes → complete, finishes → finish)
  if (w.endsWith("es")) {
    candidates.push(w.slice(0, -1)); // completes → complete
    candidates.push(w.slice(0, -2)); // finishes → finish
  }
  // -s → base (joins → join, follows → follow)
  if (w.endsWith("s")) candidates.push(w.slice(0, -1));
  for (const c of candidates) {
    if (VERB_LEXICON[c]) return c;
  }
  return w;
}

/** Look up a surface verb (single or two-word) → db verb_type, else null. */
export function lookupVerbType(lemma: string): VerbType | null {
  const direct = VERB_LEXICON[lemma.toLowerCase()];
  if (direct) return direct;
  return VERB_LEXICON[stemVerb(lemma)] ?? null;
}

// ---------------------------------------------------------------------------
// 2. Determiners + deictic pronouns
// ---------------------------------------------------------------------------

/** Surface determiner word → canonical {@link DeterminerKind}. */
export const DETERMINER_LEXICON: Record<string, DeterminerKind> = {
  the: DETERMINER_KINDS.THE,
  a: DETERMINER_KINDS.A,
  an: DETERMINER_KINDS.A,
  this: DETERMINER_KINDS.THAT,
  that: DETERMINER_KINDS.THAT,
  these: DETERMINER_KINDS.THAT,
  those: DETERMINER_KINDS.THAT,
  my: DETERMINER_KINDS.MY,
  our: DETERMINER_KINDS.OUR,
  any: DETERMINER_KINDS.ANY,
  every: DETERMINER_KINDS.ALL,
  all: DETERMINER_KINDS.ALL,
  each: DETERMINER_KINDS.ALL,
};

/** Surface pronoun → canonical {@link DeicticRef}. */
export const DEICTIC_LEXICON: Record<string, DeicticRef> = {
  i: DEICTIC_REFS.SELF,
  me: DEICTIC_REFS.SELF,
  my: DEICTIC_REFS.SELF,
  myself: DEICTIC_REFS.SELF,
  we: DEICTIC_REFS.GROUP,
  us: DEICTIC_REFS.GROUP,
  our: DEICTIC_REFS.GROUP,
  this: DEICTIC_REFS.THIS,
  that: DEICTIC_REFS.THIS,
  it: DEICTIC_REFS.THIS,
  them: DEICTIC_REFS.THEM,
  those: DEICTIC_REFS.THEM,
  here: DEICTIC_REFS.HERE,
  now: DEICTIC_REFS.NOW,
};

/** Look up a determiner word, else undefined. */
export function lookupDeterminer(word: string): DeterminerKind | undefined {
  return DETERMINER_LEXICON[word.toLowerCase()];
}

/** Look up a deictic pronoun, else undefined. */
export function lookupDeictic(word: string): DeicticRef | undefined {
  return DEICTIC_LEXICON[word.toLowerCase()];
}

// ---------------------------------------------------------------------------
// 3. Clean ontology head-noun table
// ---------------------------------------------------------------------------

/**
 * Resolution of a head noun into the clean ontology. Exactly one of
 * groupSubtype / regionSubtype / resourceKind / personKind is set besides
 * `domain` + `kind`.
 */
export interface OntologyEntry {
  domain: SemanticDomain;
  kind: AgentKind | ResourceKind;
  groupSubtype?: GroupSubtype;
  /** Present ⇒ backend-only; typecheck rejects creates. */
  regionSubtype?: RegionSubtype;
}

/**
 * English head noun (singular) → clean ontology entry. Household normalizes to
 * Family, bioregion to Region, neighborhood/village to Community — matching the
 * v1 plan §4 "never emit non-canonical" rule (the messy DB synonyms collapse
 * here, not downstream).
 */
export const ONTOLOGY_NOUNS: Record<string, OntologyEntry> = {
  // Person
  person: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },
  member: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },
  volunteer: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },
  coordinator: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },
  leader: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },
  worker: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.PERSON },

  // Bot
  bot: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.BOT },
  assistant: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.BOT },
  automation: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.BOT },

  // Group (generic) — the bare head noun resolves to a group AGENT, not a
  // resource. Without this, "joins my group" defaulted to the RESOURCE domain
  // (parser default) and rendered nonsensically as "joins my resource". No
  // groupSubtype: a generic group folds to organization only at the CREATE
  // boundary; as a rule/reference object it stays a group agent.
  group: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.GROUP },
  groups: { domain: SEMANTIC_DOMAINS.AGENT, kind: AGENT_KINDS.GROUP },

  // Group → Organization (user-creatable)
  organization: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  org: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  company: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  nonprofit: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  cooperative: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  coop: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  team: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },
  club: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.ORGANIZATION,
  },

  // Group → Family (user-creatable; "household" normalizes to Family)
  family: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.FAMILY,
  },
  household: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.FAMILY,
  },

  // Group → Community (user-creatable; neighborhood/village normalize here)
  community: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.COMMUNITY,
  },
  collective: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.COMMUNITY,
  },
  neighborhood: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.COMMUNITY,
  },
  village: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.COMMUNITY,
  },

  // Group → Ring (user-creatable; a ring is a coordination circle of agents)
  ring: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.RING,
  },
  circle: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    groupSubtype: GROUP_SUBTYPES.RING,
  },

  // Group → Region subtypes (BACKEND-ONLY — flagged for typecheck rejection)
  region: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.REGION,
  },
  bioregion: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.REGION,
  },
  locale: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.LOCALE,
  },
  chapter: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.LOCALE,
  },
  commons: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.COMMONS,
  },
  council: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.COMMONS,
  },
  basin: {
    domain: SEMANTIC_DOMAINS.AGENT,
    kind: AGENT_KINDS.GROUP,
    regionSubtype: REGION_SUBTYPES.BASIN,
  },

  // Resources — project-like
  project: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PROJECT },
  initiative: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PROJECT },
  program: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PROJECT },
  campaign: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PROJECT },

  // Resources — task-like
  task: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },
  todo: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },
  job: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },
  gig: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },
  chore: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },
  assignment: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.TASK },

  // Resources — event-like
  event: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  meetup: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  workshop: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  conference: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  gathering: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  party: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  festival: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  meeting: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  class: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },
  cleanup: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.EVENT },

  // Resources — place-like
  place: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  venue: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  garden: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  park: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  center: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  hub: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  studio: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },
  farm: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.PLACE },

  // Resources — post / listing
  post: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.POST },
  announcement: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.POST },
  listing: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.LISTING },
  offer: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.LISTING },
  offering: { domain: SEMANTIC_DOMAINS.RESOURCE, kind: RESOURCE_KINDS.LISTING },
};

/**
 * Resolve a head noun (case-insensitive, naive singularization) to its
 * ontology entry, else undefined.
 */
export function lookupOntologyNoun(noun: string): OntologyEntry | undefined {
  const lower = noun.toLowerCase();
  if (ONTOLOGY_NOUNS[lower]) return ONTOLOGY_NOUNS[lower];
  // Naive depluralization: "events" → "event", "communities" → "community".
  if (lower.endsWith("ies")) {
    const singular = `${lower.slice(0, -3)}y`;
    if (ONTOLOGY_NOUNS[singular]) return ONTOLOGY_NOUNS[singular];
  }
  if (lower.endsWith("es")) {
    const singular = lower.slice(0, -2);
    if (ONTOLOGY_NOUNS[singular]) return ONTOLOGY_NOUNS[singular];
  }
  if (lower.endsWith("s")) {
    const singular = lower.slice(0, -1);
    if (ONTOLOGY_NOUNS[singular]) return ONTOLOGY_NOUNS[singular];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 4. DB-enum mapping (clean ontology → persistence enums)
// ---------------------------------------------------------------------------

/**
 * Clean group subtype → real `agent_type` enum string. (There is no `group`
 * agent type in the DB; these are the concrete storage values.)
 */
export const GROUP_SUBTYPE_TO_AGENT_TYPE: Record<GroupSubtype, "organization" | "community" | "family" | "ring"> = {
  [GROUP_SUBTYPES.ORGANIZATION]: "organization",
  [GROUP_SUBTYPES.COMMUNITY]: "community",
  [GROUP_SUBTYPES.FAMILY]: "family",
  [GROUP_SUBTYPES.RING]: "ring",
};

/**
 * Map a clean ontology slot kind/subtype to the `EntityType` accepted by
 * `createEntitiesFromScaffold` (the 5 valid create types). Returns null when the
 * kind has no legal user-create mapping (e.g. bot/system, region subtypes, or a
 * resource kind that isn't one of project/event/place).
 *
 * NOTE: region subtypes are intentionally NOT handled here — they are rejected
 * upstream at typecheck. This function is the storage-boundary clamp.
 */
export function toEntityType(
  domain: SemanticDomain,
  kind: AgentKind | ResourceKind | undefined,
  groupSubtype?: GroupSubtype,
): EntityType | null {
  if (domain === SEMANTIC_DOMAINS.AGENT) {
    if (kind === AGENT_KINDS.PERSON) return "person";
    if (kind === AGENT_KINDS.GROUP) {
      // Ring is a distinct user-creatable agent type (agent_type 'ring').
      // Family/Community still fold into organization at the create boundary
      // (the 5-type create surface has no distinct family/community create yet).
      if (groupSubtype === GROUP_SUBTYPES.RING) return "ring";
      return "organization";
    }
    // bot/system are not user-creatable through the scaffold surface.
    return null;
  }
  // Resource domain — clamp to the 3 resource create types.
  if (kind === RESOURCE_KINDS.PROJECT || kind === RESOURCE_KINDS.TASK) return "project";
  if (kind === RESOURCE_KINDS.EVENT) return "event";
  if (kind === RESOURCE_KINDS.PLACE) return "place";
  // post/listing/generic resources are not part of the 5-type scaffold create.
  return null;
}

/** Canonical relationship-type vocabulary reused from the legacy parser. */
export const RELATIONSHIP_LEXICON: Record<string, RelationshipType> = {
  "part of": RELATIONSHIP_TYPES.PART_OF,
  in: RELATIONSHIP_TYPES.LOCATED_IN,
  at: RELATIONSHIP_TYPES.LOCATED_IN,
  near: RELATIONSHIP_TYPES.LOCATED_IN,
  "hosted by": RELATIONSHIP_TYPES.HOSTED_BY,
  "organized by": RELATIONSHIP_TYPES.ORGANIZED_BY,
  by: RELATIONSHIP_TYPES.ORGANIZED_BY,
  for: RELATIONSHIP_TYPES.PART_OF,
};

/** Filler/stop words ignored during name extraction (mirrors v2 STOP_WORDS). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "in",
  "at",
  "for",
  "with",
  "on",
  "to",
  "from",
  "by",
  "new",
  "called",
  "named",
  "titled",
]);
