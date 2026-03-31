/**
 * Natural-language parsing module (v2) for entity/relationship extraction.
 *
 * Purpose:
 * - Parses user input into structured intent, entities, relationships, and properties.
 * - Maps natural language type keywords to REA-oriented DB targets (`agents`/`resources`).
 * - Handles hierarchy clauses, relative clauses, conjunctions, location/time extraction,
 *   and existing-entity linking hints.
 *
 * Key exports:
 * - `parseNaturalLanguageV2`
 * - `ParsedIntent`, `V2ParseResult`, `V2ExtractedEntity`, `V2Conditional`
 * - Re-exported parser constants/types from `./nlp-parser`
 *
 * Dependencies:
 * - `chrono-node` for temporal phrase extraction
 * - `./nlp-parser` for shared parser types/constants
 */

import * as chrono from "chrono-node";

// Re-export types and constants from original parser
export { ENTITY_TYPES, RELATIONSHIP_TYPES } from "./nlp-parser";
export type { EntityType, RelationshipType, NLPParseResult, ExtractedEntity, ExtractedRelationship, ExtractedProperty } from "./nlp-parser";

import type {
  EntityType,
  RelationshipType,
  ExtractedEntity,
  ExtractedRelationship,
} from "./nlp-parser";

// ---------------------------------------------------------------------------
// V2-specific types
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  lower: string;
  index: number;
}

/** Entity reference extracted from an "inside" clause or "in the [name] group" pattern */
interface ExistingReference {
  type: string;
  name: string;
  isExisting?: boolean;
}

/** Child entity extracted from a "with" clause or relative clause */
interface ChildEntity {
  type: string;
  name?: string;
  pluralHint?: string;
  /** Original type keyword (e.g., "task", "job") before mapping to DB type */
  originalKeyword?: string;
  /** Relationship verb from a relative clause (e.g., "manages" from "who manages") */
  relationshipVerb?: string;
}

/** Intent structure extracted from the natural language input */
export interface ParsedIntent {
  primaryAction: string;
  primaryEntityType: string;
  entityName: string;
  /** The original type keyword the user typed (e.g., "party", "job") before mapping to DB type */
  originalKeyword?: string;
  existingReferences: ExistingReference[];
  properties: { key: string; value: string }[];
  childEntities: ChildEntity[];
  /** Which database table this entity targets based on REA model */
  targetTable?: "agents" | "resources";
  /** Verb category for non-creation verbs */
  verbCategory?: "creation" | "structural" | "economic" | "work" | "governance" | "lifecycle" | "spatiotemporal" | "social" | "permission";
}

/** Extended entity with V2-specific fields for existing entity linking */
export interface V2ExtractedEntity extends ExtractedEntity {
  /** When true, this entity already exists in the DB and should be linked, not created */
  isExisting?: boolean;
  /** The database ID of the existing entity (set when isExisting is true) */
  existingId?: string;
  /** Hint that the user used "the" (definite article), suggesting they expect this entity to exist */
  isExistingHint?: boolean;
  /** The original keyword the user typed (e.g., "job", "task") before mapping to DB type */
  originalKeyword?: string;
  /** Which database table this entity belongs to based on REA model */
  targetTable?: "agents" | "resources";
}

/** Grammar/determiner conditional extracted from the input */
export interface V2Conditional {
  determiner: string;
  predicate: string;
  source: string;
}

/** Existing entity record passed from the database lookup */
export interface ExistingEntityRecord {
  id: string;
  name: string;
  type: string;
  isExisting: boolean;
}

/** Complete V2 parse result including intent */
export interface V2ParseResult {
  success: boolean;
  input: string;
  entities: V2ExtractedEntity[];
  relationships: ExtractedRelationship[];
  conditionals: V2Conditional[];
  warnings: string[];
  intent: ParsedIntent | null;
}

// ---------------------------------------------------------------------------
// Verb Categories
// ---------------------------------------------------------------------------

/** Verbs related to structural/membership relationships */
const STRUCTURAL_VERBS = new Set([
  "join", "manage", "own", "follow", "locate",
  "belong", "assign", "invite", "employ", "contain",
]);

/** Verbs related to economic transactions */
const ECONOMIC_VERBS = new Set([
  "buy", "sell", "trade", "gift", "pay", "transact",
  "earn", "redeem", "fund", "pledge",
]);

/** Verbs related to work activities */
const WORK_VERBS = new Set(["work", "clock in", "clock out", "produce", "consume"]);

/** Verbs related to governance */
const GOVERNANCE_VERBS = new Set(["vote", "propose", "approve", "reject"]);

/** Verbs related to lifecycle state changes */
const LIFECYCLE_VERBS = new Set(["start", "complete", "cancel", "archive", "publish"]);

/** Verbs related to spatial/temporal associations */
const SPATIOTEMPORAL_VERBS = new Set(["attend", "host", "schedule"]);

/** Verbs related to social interactions */
const SOCIAL_VERBS = new Set(["endorse", "mention", "comment", "react", "share"]);

/** Verbs related to permissions */
const PERMISSION_VERBS = new Set(["grant", "revoke", "rent", "use", "leave", "request"]);

/**
 * Past participles that introduce "by [agent]" clauses.
 * These terminate name extraction in "called/named" patterns and
 * trigger agent reference extraction (e.g., "hosted by Sustainability Collective").
 */
const AGENT_PARTICIPLES = new Set([
  "hosted", "organized", "managed", "led", "run", "created", "owned",
  "sponsored", "founded", "coordinated", "facilitated", "built", "designed",
  "produced", "maintained", "operated",
]);

/**
 * Action verbs that indicate explicit creation intent.
 * Configuration pattern: these values are compared against tokenized input and
 * drive both intent detection and confidence scoring.
 */
const CREATION_VERBS = new Set([
  "start", "create", "launch", "organize", "setup", "set up",
  "make", "build", "establish", "form", "initiate", "begin",
  "plan", "host", "schedule", "open", "add", "register",
  "throw", "run", "hold", "put on", "arrange", "prepare",
]);

/**
 * Multi-word preambles normalized to "create ...".
 * Configuration pattern: longer phrases must appear first to prevent partial
 * matches from consuming shorter prefixes too early.
 */
const CREATION_PHRASES = [
  "i would like to",
  "i'd like to",
  "there should be",
  "there needs to be",
  "there could be",
  "we need to",
  "we should",
  "we want to",
  "i want to",
  "i need to",
  "let's",
  "lets",
];

// ---------------------------------------------------------------------------
// REA Model: Agent & Resource Type Keywords
// ---------------------------------------------------------------------------

/**
 * AGENT_TYPE_KEYWORDS maps natural language words to agent DB types.
 * These keywords indicate entities stored in the "agents" table.
 *
 * Agent types (domain model): person + governance/container entities
 * (regions/basins/locales/groups and group variants).
 */
const AGENT_TYPE_KEYWORDS: Record<string, string> = {
  // Person (agent)
  "person": "person",
  "member": "person",
  "volunteer": "person",
  "coordinator": "person",
  "leader": "person",
  "worker": "person",

  // Bot (agent)
  "bot": "person",
  "assistant": "person",
  "automation": "person",

  // Organization / Org (legacy agent)
  "organization": "organization",
  "org": "organization",
  "company": "organization",
  "nonprofit": "organization",
  "cooperative": "organization",
  "group": "organization",
  "club": "organization",
  "region": "organization",
  "basin": "organization",
  "locale": "organization",
  "chapter": "organization",
  "bioregion": "organization",
  "council": "organization",

  // Domain (agent)
  "domain": "organization",
  "department": "organization",
  "division": "organization",
  "sector": "organization",

  // Ring (agent) — team-like
  "ring": "organization",
  "crew": "organization",
  "team": "organization",
  "squad": "organization",
  "circle": "organization",

  // Family (agent)
  "family": "organization",
  "household": "organization",

  // Guild (agent)
  "guild": "organization",
  "union": "organization",
  "association": "organization",

  // Community (agent)
  "community": "organization",
  "collective": "organization",
  "neighborhood": "organization",
  "village": "organization",
};

/**
 * RESOURCE_TYPE_KEYWORDS maps natural language words to resource DB types.
 * These keywords indicate entities stored in the "resources" table.
 *
 * Resource types (domain model): projects, events, places/venues, skills,
 * and exchangeable/usable resources.
 * Legacy resource types: document, image, video, audio, link, note, file, dataset
 */
const RESOURCE_TYPE_KEYWORDS: Record<string, string> = {
  // Project (resource)
  "project": "project",
  "initiative": "project",
  "program": "project",
  "campaign": "project",

  // Event (resource)
  "event": "event",
  "conference": "event",
  "meetup": "event",
  "workshop": "event",
  "gathering": "event",
  "party": "event",
  "festival": "event",
  "seminar": "event",
  "hackathon": "event",
  "meeting": "event",
  "class": "event",
  "session": "event",
  "activity": "event",
  "ceremony": "event",
  "rally": "event",
  "concert": "event",
  "celebration": "event",

  // Place / Venue (resource)
  "place": "place",
  "venue": "place",
  "location": "place",
  "space": "place",
  "garden": "place",
  "park": "place",
  "center": "place",
  "lab": "place",
  "hub": "place",
  "studio": "place",
  "office": "place",
  "farm": "place",
  "market": "place",
  "hall": "place",
  "plaza": "place",
  "library": "place",

  // Skills / generic resources (resource)
  "skill": "project",
  "skills": "project",
  "resource": "project",
  "resources": "project",

  // Job (resource)
  "job": "project",
  "position": "project",
  "role": "project",
  "gig": "project",

  // Shift (resource)
  "shift": "project",
  "slot": "project",
  "timeblock": "project",

  // Task (resource)
  "task": "project",
  "todo": "project",
  "assignment": "project",
  "chore": "project",
  "duty": "project",
  "errand": "project",

  // Asset (resource)
  "asset": "project",
  "tool": "project",
  "equipment": "project",
  "supply": "project",
  "material": "project",

  // Voucher (resource)
  "voucher": "project",
  "credit": "project",
  "token": "project",
  "coupon": "project",

  // Currency (resource)
  "currency": "project",
  "coin": "project",
  "money": "project",
  "points": "project",

  // Listing (resource)
  "listing": "project",
  "post": "project",
  "ad": "project",
  "offer": "project",

  // Proposal (resource)
  "proposal": "project",
  "motion": "project",
  "resolution": "project",

  // Badge (resource)
  "badge": "project",
  "achievement": "project",
  "certification": "project",
  "award": "project",

  // Legacy: project-like (resource)
  "goal": "project",
  "milestone": "project",
  "deliverable": "project",
  "effort": "project",
  "venture": "project",
};

/**
 * Merged TYPE_KEYWORDS for backward compatibility.
 * Agent keywords take precedence for overlapping keys.
 */
const TYPE_KEYWORDS: Record<string, string> = {
  ...RESOURCE_TYPE_KEYWORDS,
  ...AGENT_TYPE_KEYWORDS,
};

/**
 * Entity keyword priority (higher means more likely primary type).
 * Configuration pattern: negative priorities intentionally down-rank ambiguous
 * terms that often appear in location phrases.
 */
const TYPE_PRIORITY: Record<string, number> = {
  // Projects & project-like
  "project": 10,
  "initiative": 9,
  "program": 8,
  "job": 8,
  "task": 8,
  "role": 8,
  "goal": 8,
  "assignment": 8,
  "duty": 8,
  "milestone": 8,
  "deliverable": 8,
  "position": 8,
  "gig": 8,
  "shift": 8,
  "slot": 8,
  "timeblock": 8,
  "todo": 8,
  "chore": 8,
  "errand": 8,
  "asset": 8,
  "tool": 8,
  "equipment": 8,
  "supply": 8,
  "material": 8,
  "voucher": 8,
  "credit": 8,
  "token": 8,
  "coupon": 8,
  "currency": 8,
  "coin": 8,
  "money": 8,
  "points": 8,
  "listing": 8,
  "post": 8,
  "ad": 8,
  "offer": 8,
  "proposal": 8,
  "motion": 8,
  "resolution": 8,
  "badge": 8,
  "achievement": 8,
  "certification": 8,
  "award": 8,
  // Events & event-like
  "event": 7,
  "conference": 6,
  "meetup": 6,
  "workshop": 6,
  "hackathon": 6,
  "meeting": 6,
  "class": 6,
  "session": 6,
  "activity": 6,
  "ceremony": 6,
  "rally": 6,
  "concert": 6,
  "celebration": 6,
  // Organizations
  "group": 5,
  "organization": 5,
  "org": 5,
  "team": 5,
  "club": 5,
  "association": 5,
  "cooperative": 5,
  "family": 5,
  "domain": 5,
  "department": 5,
  "division": 5,
  "sector": 5,
  "ring": 5,
  "crew": 5,
  "squad": 5,
  "circle": 5,
  "household": 5,
  "guild": 5,
  "union": 5,
  "community": 5,
  "collective": 5,
  "neighborhood": -1,
  "village": -1,
  // Places
  "place": 4,
  "venue": 4,
  "garden": 4,
  "park": 4,
  "center": 4,
  "lab": 4,
  "hub": 4,
  "studio": 4,
  "office": 4,
  "farm": 4,
  "market": 4,
  "hall": 4,
  "plaza": 4,
  "library": 4,
  // Person
  "person": 3,
  "member": 3,
  "volunteer": 3,
  "coordinator": 3,
  "leader": 3,
  "worker": 3,
  "bot": 3,
  "assistant": 3,
  "automation": 3,
};

/**
 * Prepositions/articles/filler words ignored during entity-name extraction.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "in", "at", "for", "with", "on", "to", "from", "by", "new"
]);

/**
 * Plural-to-singular normalization for keyword lookups.
 * Configuration pattern: keep this aligned with TYPE keyword dictionaries so
 * plural mentions resolve to the same underlying DB type.
 */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  "events": "event",
  "projects": "project",
  "workshops": "workshop",
  "conferences": "conference",
  "meetups": "meetup",
  "gatherings": "gathering",
  "parties": "party",
  "festivals": "festival",
  "seminars": "seminar",
  "hackathons": "hackathon",
  "organizations": "organization",
  "groups": "group",
  "places": "place",
  "venues": "venue",
  "regions": "region",
  "basins": "basin",
  "locales": "locale",
  "chapters": "chapter",
  "councils": "council",
  "jobs": "job",
  "tasks": "task",
  "roles": "role",
  "goals": "goal",
  "assignments": "assignment",
  "duties": "duty",
  "milestones": "milestone",
  "deliverables": "deliverable",
  "meetings": "meeting",
  "classes": "class",
  "sessions": "session",
  "activities": "activity",
  "ceremonies": "ceremony",
  "rallies": "rally",
  "concerts": "concert",
  "celebrations": "celebration",
  "teams": "team",
  "clubs": "club",
  "members": "member",
  "volunteers": "volunteer",
  // New REA agent plurals
  "bots": "bot",
  "assistants": "assistant",
  "domains": "domain",
  "departments": "department",
  "divisions": "division",
  "sectors": "sector",
  "rings": "ring",
  "crews": "crew",
  "squads": "squad",
  "circles": "circle",
  "families": "family",
  "households": "household",
  "guilds": "guild",
  "unions": "union",
  "associations": "association",
  "communities": "community",
  "collectives": "collective",
  "neighborhoods": "neighborhood",
  "villages": "village",
  "workers": "worker",
  "coordinators": "coordinator",
  "leaders": "leader",
  // New REA resource plurals
  "shifts": "shift",
  "slots": "slot",
  "positions": "position",
  "gigs": "gig",
  "todos": "todo",
  "chores": "chore",
  "errands": "errand",
  "assets": "asset",
  "tools": "tool",
  "supplies": "supply",
  "skills": "skill",
  "resources": "resource",
  "materials": "material",
  "vouchers": "voucher",
  "credits": "credit",
  "tokens": "token",
  "coupons": "coupon",
  "currencies": "currency",
  "coins": "coin",
  "listings": "listing",
  "posts": "post",
  "ads": "ad",
  "offers": "offer",
  "proposals": "proposal",
  "motions": "motion",
  "resolutions": "resolution",
  "badges": "badge",
  "achievements": "achievement",
  "certifications": "certification",
  "awards": "award",
  "initiatives": "initiative",
  "programs": "program",
  "campaigns": "campaign",
};

// ---------------------------------------------------------------------------
// Helper: Determine target table from keyword
// ---------------------------------------------------------------------------

/**
 * Determine which database table a keyword maps to based on the REA model.
 * Returns "agents" for agent-type keywords, "resources" for resource-type keywords.
 */
function getTargetTable(keyword: string): "agents" | "resources" | undefined {
  const lower = keyword.toLowerCase();
  // Check singular form first
  const singular = PLURAL_TO_SINGULAR[lower] || lower;
  if (singular in RESOURCE_TYPE_KEYWORDS) return "resources";
  if (singular in AGENT_TYPE_KEYWORDS) return "agents";
  return undefined;
}

/**
 * Classify a verb into a category.
 */
function classifyVerb(verb: string): "creation" | "structural" | "economic" | "work" | "governance" | "lifecycle" | "spatiotemporal" | "social" | "permission" | undefined {
  if (CREATION_VERBS.has(verb)) return "creation";
  if (STRUCTURAL_VERBS.has(verb)) return "structural";
  if (ECONOMIC_VERBS.has(verb)) return "economic";
  if (WORK_VERBS.has(verb)) return "work";
  if (GOVERNANCE_VERBS.has(verb)) return "governance";
  if (LIFECYCLE_VERBS.has(verb)) return "lifecycle";
  if (SPATIOTEMPORAL_VERBS.has(verb)) return "spatiotemporal";
  if (SOCIAL_VERBS.has(verb)) return "social";
  if (PERMISSION_VERBS.has(verb)) return "permission";
  return undefined;
}

/**
 * Main parsing function - improved version
 *
 * Supports multi-sentence input: each sentence is parsed separately and merged.
 * Supports creation phrases like "there should be", "I want to", etc.
 *
 * @param input - Natural-language user input to parse.
 * @param existingEntities - Optional normalized-name map used to mark entity references as existing.
 * @returns Structured parse result containing entities, relationships, conditionals, warnings, and intent.
 * @throws {Error} Does not intentionally throw; may propagate unexpected runtime errors from regex/date parsing.
 * @example
 * ```ts
 * const result = parseNaturalLanguageV2(
 *   "Set up a farmers market event inside the Riverside Collective group",
 *   existingEntityMap
 * );
 * if (result.success) console.log(result.entities[0].name);
 * ```
 */
export function parseNaturalLanguageV2(
  input: string,
  existingEntities: Map<string, ExistingEntityRecord> = new Map()
): V2ParseResult {
  if (!input || typeof input !== "string" || !input.trim()) {
    return {
      success: false,
      input: input ?? "",
      entities: [],
      relationships: [],
      conditionals: [],
      warnings: ["Input text is empty or invalid"],
      intent: null
    };
  }

  const normalized = input.trim().replace(/\s+/g, " ");

  // Split into sentences for multi-sentence support
  const sentences = splitSentences(normalized);

  if (sentences.length <= 1) {
    return parseSingleSentence(normalized, existingEntities);
  }

  // Multi-sentence mode treats the first sentence as the canonical root entity
  // and attaches later sentences as children to preserve deterministic ordering.
  const primaryResult = parseSingleSentence(sentences[0], existingEntities);

  for (let i = 1; i < sentences.length; i++) {
    const secondaryResult = parseSingleSentence(sentences[i], existingEntities);
    if (secondaryResult.success) {
      mergeSecondaryResult(primaryResult, secondaryResult);
    }
  }

  return primaryResult;
}

/**
 * Split input into sentences at sentence-ending punctuation.
 * Keeps punctuation with its sentence.
 */
function splitSentences(text: string): string[] {
  // Split at sentence boundaries: period, exclamation, question mark followed by space
  const sentences = text.split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return sentences.length > 0 ? sentences : [text];
}

/**
 * Merge entities from a secondary sentence into the primary result.
 * Secondary entities become children of the primary entity.
 */
function mergeSecondaryResult(primary: V2ParseResult, secondary: V2ParseResult): void {
  const primaryEntityCount = primary.entities.length;

  // Add all secondary entities
  for (const entity of secondary.entities) {
    primary.entities.push(entity);
  }

  // The first secondary entity is a child of the primary entity (index 0)
  if (secondary.entities.length > 0) {
    primary.relationships.push({
      type: "part_of",
      fromEntityIndex: primaryEntityCount, // first secondary entity
      toEntityIndex: 0, // primary entity
      source: "multi-sentence"
    });
  }

  // Remap secondary relationships with offset indices
  for (const rel of secondary.relationships) {
    primary.relationships.push({
      type: rel.type,
      fromEntityIndex: rel.fromEntityIndex + primaryEntityCount,
      toEntityIndex: rel.toEntityIndex + primaryEntityCount,
      source: rel.source
    });
  }

  // Merge warnings and conditionals
  primary.warnings.push(...secondary.warnings);
  primary.conditionals.push(...secondary.conditionals);
}

/**
 * Strip leading creation phrases ("there should be", "I want to", etc.)
 * and normalize for parsing. Returns the cleaned text with "create" prepended
 * if a phrase was found (so verb detection works on the entity description).
 */
function stripCreationPhrase(text: string): string {
  const lower = text.toLowerCase();
  for (const phrase of CREATION_PHRASES) {
    if (lower.startsWith(phrase)) {
      const remainder = text.slice(phrase.length).trim();
      if (remainder) {
        // Prepend "create" so the parser treats this as a creation command
        return `create ${remainder}`;
      }
    }
  }
  return text;
}

/**
 * Parse a single sentence into entities, relationships, and metadata.
 */
function parseSingleSentence(
  input: string,
  existingEntities: Map<string, ExistingEntityRecord>
): V2ParseResult {
  // Strip creation phrases ("there should be" → "create ...")
  const normalized = stripCreationPhrase(input.trim().replace(/\s+/g, " "));
  const tokens = tokenize(normalized);

  // Step 1: Detect primary action and entity type
  const intent = detectIntent(tokens, normalized);

  // Step 2: Build entity scaffold with existing entities
  const entities = buildEntityScaffold(intent, existingEntities);

  // Step 3: Extract relationships
  const relationships = buildRelationships(entities, intent);

  // Step 4: Extract grammar/conditionals
  const conditionals = extractGrammar(normalized, tokens);

  const warnings: string[] = [];
  if (!detectCreationVerb(tokens)) {
    warnings.push("No creation verb detected. Interpreting as entity description.");
  }

  return {
    success: entities.length > 0,
    input: normalized,
    entities,
    relationships,
    conditionals,
    warnings,
    intent
  };
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const words = text.trim().split(/\s+/);

  words.forEach((word, index) => {
    const cleaned = word.replace(/[.,!?;:]+$/, "");
    tokens.push({
      text: word,
      lower: cleaned.toLowerCase(),
      index
    });
  });

  return tokens;
}

function detectCreationVerb(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (CREATION_VERBS.has(token.lower)) return true;
  }
  // Check two-word verbs like "set up"
  for (let i = 0; i < tokens.length - 1; i++) {
    const twoWord = `${tokens[i].lower} ${tokens[i + 1].lower}`;
    if (CREATION_VERBS.has(twoWord)) return true;
  }
  return false;
}

/**
 * Detect user intent: what are they trying to create?
 *
 * Parsing strategy:
 * 1. Detect creation verb (including two-word verbs like "set up")
 * 2. Split input at hierarchy boundaries ("inside", "as part of") to identify primary entity vs parent chain
 * 3. Extract the primary entity from text BEFORE the first hierarchy delimiter
 * 4. Extract parent entities from hierarchy clauses, tracking determiner (a/an vs the)
 * 5. Extract "called/named" patterns, "in the [name] group" patterns, and "with" clauses
 * 5d. Extract relative clauses (who/that/which patterns)
 * 6. Extract location and temporal properties
 * 7. Extract property clauses (worth, for, about)
 * 8. Handle conjunction support (and/comma-separated entity lists)
 */
function detectIntent(tokens: Token[], original: string): ParsedIntent {
  const intent: ParsedIntent = {
    primaryAction: "create",
    primaryEntityType: "project",
    entityName: "",
    existingReferences: [],
    properties: [],
    childEntities: []
  };

  // --- Step 1: Find creation verb (including two-word verbs) ---
  // Strategy: find ALL candidate verbs, then pick the earliest valid one.
  // Guard: skip verbs preceded by "called" or "named" (e.g., "called set up" is a name, not a verb).
  let verbEndIndex = -1;
  let bestVerbStart = Infinity;

  // Check two-word verbs
  for (let i = 0; i < tokens.length - 1; i++) {
    // Guard: skip if preceded by "called" or "named"
    if (i > 0 && (tokens[i - 1].lower === "called" || tokens[i - 1].lower === "named")) continue;
    // Guard: skip if preceded by a type keyword (e.g., "a task set up chairs" — "set up" is part of the name)
    if (i > 0 && TYPE_KEYWORDS[tokens[i - 1].lower]) continue;

    const twoWord = `${tokens[i].lower} ${tokens[i + 1].lower}`;
    if (CREATION_VERBS.has(twoWord) && i < bestVerbStart) {
      intent.primaryAction = twoWord;
      verbEndIndex = i + 2;
      bestVerbStart = i;
      break; // Two-word verbs: take the first valid one (leftmost)
    }
  }

  // Check single-word verbs — only use if earlier than the two-word match
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && (tokens[i - 1].lower === "called" || tokens[i - 1].lower === "named")) continue;
    if (i > 0 && TYPE_KEYWORDS[tokens[i - 1].lower]) continue;

    if (CREATION_VERBS.has(tokens[i].lower) && i < bestVerbStart) {
      intent.primaryAction = tokens[i].lower;
      verbEndIndex = i + 1;
      bestVerbStart = i;
      break; // Take the first valid one (leftmost)
    }
  }

  // Classify the verb
  const verbCategory = classifyVerb(intent.primaryAction);
  if (verbCategory) {
    intent.verbCategory = verbCategory;
  }

  // Track token ranges consumed by specific patterns
  const consumedRanges: { start: number; end: number }[] = [];

  // --- Step 2: Split at hierarchy delimiters ("inside", "as part of") ---
  // The primary entity is described in the text BEFORE the first delimiter.
  // Each hierarchy clause describes a parent entity in the hierarchy.
  const hierarchySegments = splitAtHierarchy(original);
  const primarySegment = hierarchySegments[0]; // text before any delimiter
  const parentSegments = hierarchySegments.slice(1); // hierarchy clauses

  // --- Step 3: Extract primary entity from the primary segment ---
  // e.g., "set up a farmers market event" → type=event, name="Farmers Market"
  extractPrimaryEntity(primarySegment, tokens, intent, verbEndIndex);

  // Set targetTable based on primary entity type keyword
  const primaryKeyword = intent.originalKeyword || intent.primaryEntityType;
  const primaryTargetTable = getTargetTable(primaryKeyword);
  if (primaryTargetTable) {
    intent.targetTable = primaryTargetTable;
  }

  // --- Step 4: Extract parent entities from "inside" clauses ---
  // e.g., "a farms project" → type=project, name="Farms", isExisting=false
  // e.g., "the food hub co-op group" → type=organization, name="Food Hub Co-Op", isExisting=true
  for (const segment of parentSegments) {
    const parentEntity = parseInsideClause(segment);
    if (parentEntity) {
      intent.existingReferences.push(parentEntity);
    }

    // Check for "in the [name] group/org" sub-pattern within compound hierarchy clauses
    // e.g., "a project called Party Time in the Boulder Solar Collective group"
    // Uses GREEDY .+ so it matches the LAST type keyword (e.g., "group" not "collective")
    const subGroupMatch = segment.text.match(
      /\bin\s+the\s+(.+\s+(?:group|org|organization|community|collective|team))\b/i
    );
    if (subGroupMatch) {
      const subGroupName = capitalizeWords(subGroupMatch[1].trim());
      const alreadyCaptured = intent.existingReferences.some(
        ref => ref.name.toLowerCase() === subGroupName.toLowerCase()
      );
      if (!alreadyCaptured) {
        intent.existingReferences.push({
          type: "organization",
          name: subGroupName,
          isExisting: true // "the" = existing
        });
      }
    }

    // Mark the entire hierarchy clause as consumed (uses actual delimiter)
    const delimiter = segment.delimiter || "inside";
    const searchStr = delimiter + " " + segment.text;
    const matchStart = original.toLowerCase().indexOf(searchStr.toLowerCase());
    if (matchStart >= 0) {
      consumedRanges.push({
        start: matchStart,
        end: matchStart + searchStr.length
      });
    }
  }

  // --- Step 5a: Explicit "called/named" patterns ---
  // Name capture stops at: prepositions, conjunctions, agent participles ("hosted", "organized", etc.)
  // Supports optional quotes: called "Regen Summit 2026" or called Regen
  const calledPattern = /(?:called|named)\s+(?:["']([^"']+)["']|([a-zA-Z][\w]*(?:\s+[a-zA-Z][\w]*)*?))(?=\s+(?:in|at|on|for|by|with|from|and|or|but|inside|hosted|organized|managed|led|run|created|owned|sponsored|founded|coordinated|facilitated|built|designed|produced|maintained|operated)\b|[.,!?;:]|$)/gi;
  let calledMatch;
  const explicitNames: { type: string; name: string; matchStart: number; matchEnd: number }[] = [];

  while ((calledMatch = calledPattern.exec(original)) !== null) {
    const fullMatch = calledMatch[0];
    // Group 1 = quoted name, Group 2 = unquoted name
    const name = (calledMatch[1] || calledMatch[2]).trim();
    const matchStart = calledMatch.index;
    const matchEnd = matchStart + fullMatch.length;

    // Skip if this match falls within an already-consumed range (e.g., hierarchy clause)
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (alreadyConsumed) continue;

    // Find the entity type by looking backward from "called/named"
    const beforeCalled = original.substring(0, matchStart).toLowerCase();
    let entityType = "event";
    let lastFoundType = "";
    let lastFoundIndex = -1;

    for (const [keyword, type] of Object.entries(TYPE_KEYWORDS)) {
      const idx = beforeCalled.lastIndexOf(keyword);
      if (idx > lastFoundIndex) {
        lastFoundIndex = idx;
        lastFoundType = type;
      }
    }
    if (lastFoundType) {
      entityType = lastFoundType;
    }

    explicitNames.push({
      type: entityType,
      name: capitalizeWords(name),
      matchStart,
      matchEnd
    });
    consumedRanges.push({ start: matchStart, end: matchEnd });
  }

  // --- Step 5b: "in the [name] group/org/community" (non-inside variant) ---
  // Only match standalone "in the" NOT "inside the"
  // Uses GREEDY .+ to match the LAST type keyword (avoids matching "collective" in "Boulder Solar Collective group")
  const inGroupPattern = /(?<!\w)in\s+the\s+(.+\s+(?:group|org|organization|community|collective|team))\b/i;
  const inGroupMatch = original.match(inGroupPattern);

  if (inGroupMatch) {
    const fullPhrase = inGroupMatch[1].trim();
    // Extract the type keyword from the end
    const typeKeywordMatch = fullPhrase.match(/\s+(group|org|organization|community|collective|team)$/i);
    // The name portion is everything before the type keyword
    const groupName = typeKeywordMatch
      ? fullPhrase.slice(0, typeKeywordMatch.index).trim()
      : fullPhrase;
    const nameWords = groupName.toLowerCase().split(/\s+/);
    const containsEntityKeyword = nameWords.some(w =>
      TYPE_KEYWORDS[w] && TYPE_PRIORITY[w] !== undefined && TYPE_PRIORITY[w] >= 7
    );

    if (!containsEntityKeyword && groupName.length > 0) {
      // Check if this wasn't already captured by the "inside" pattern
      // Use the full phrase (name + type keyword) as the display name
      const displayName = capitalizeWords(fullPhrase);
      const alreadyCaptured = intent.existingReferences.some(ref =>
        ref.name.toLowerCase() === displayName.toLowerCase()
      );
      if (!alreadyCaptured) {
        intent.existingReferences.push({
          type: "organization",
          name: displayName,
          isExisting: true // "the" indicates existing
        });

        const matchStart = original.indexOf(inGroupMatch[0]);
        consumedRanges.push({
          start: matchStart,
          end: matchStart + inGroupMatch[0].length
        });
      }
    }
  }

  // --- Step 5c: "with [child entities]" ---
  const withPattern = /\bwith\s+(.+?)(?=\s+in\s+the\s+|\s+inside\s+|\s+from\s+|\s+by\s+|\s+(?:next|today|tomorrow|this|last|on|at|about|worth|starting|ending|every)\s+|[.,!?;:]|$)/gi;
  let withMatch;

  while ((withMatch = withPattern.exec(original)) !== null) {
    const withClause = withMatch[1].trim();
    const withStart = withMatch.index;
    const withEnd = withStart + withMatch[0].length;

    const alreadyConsumed = consumedRanges.some(r =>
      withStart >= r.start && withStart < r.end
    );
    if (alreadyConsumed) continue;

    // Check for "called/named" sub-pattern
    const withCalledMatch = withClause.match(
      /(?:(?:a|an|the)\s+)?(\w+)\s+(?:called|named)\s+(.+)/i
    );

    if (withCalledMatch) {
      const typeWord = withCalledMatch[1].toLowerCase();
      const resolvedWord = PLURAL_TO_SINGULAR[typeWord] || typeWord;
      const entityType = TYPE_KEYWORDS[resolvedWord] || TYPE_KEYWORDS[typeWord] || "event";
      const name = withCalledMatch[2].trim().replace(/\s+(in|at|on|for|by|with|from|and|or|but)\s+.*$/i, "");

      // Preserve original keyword if it differs from DB type
      const DB_TYPES = new Set(["project", "event", "place", "person", "organization"]);
      const originalKeyword = !DB_TYPES.has(resolvedWord) ? resolvedWord : undefined;

      intent.childEntities.push({
        type: entityType,
        name: capitalizeWords(name),
        originalKeyword
      });
      consumedRanges.push({ start: withStart, end: withEnd });
      continue;
    }

    // Check for plural entity references
    const withWords = withClause.split(/\s+/);
    const firstWord = withWords[0].toLowerCase();
    const entityWord = (firstWord === "a" || firstWord === "an") && withWords.length > 1
      ? withWords[1].toLowerCase()
      : firstWord;

    const singularForm = PLURAL_TO_SINGULAR[entityWord];
    const directType = TYPE_KEYWORDS[entityWord];

    if (singularForm || directType) {
      const childType = singularForm ? TYPE_KEYWORDS[singularForm] || "event" : directType!;
      const isPlural = !!singularForm;

      const temporalFilterWords = new Set([
        "sunday", "sundays", "monday", "mondays", "tuesday", "tuesdays",
        "wednesday", "wednesdays", "thursday", "thursdays", "friday", "fridays",
        "saturday", "saturdays", "today", "tomorrow", "daily", "weekly", "monthly"
      ]);
      const startIdx = entityWord === firstWord ? 1 : 2;
      const remainingWords = withWords.slice(startIdx).filter(w => {
        const lower = w.toLowerCase();
        return !STOP_WORDS.has(lower) && !temporalFilterWords.has(lower);
      });

      // Preserve original keyword if it differs from DB type
      const DB_TYPES_W = new Set(["project", "event", "place", "person", "organization"]);
      const resolvedEntityWord = singularForm || entityWord;
      const childOriginalKeyword = !DB_TYPES_W.has(resolvedEntityWord) ? resolvedEntityWord : undefined;

      intent.childEntities.push({
        type: childType,
        name: remainingWords.length > 0 ? capitalizeWords(remainingWords.join(" ")) : undefined,
        pluralHint: isPlural ? entityWord : undefined,
        originalKeyword: childOriginalKeyword
      });
      consumedRanges.push({ start: withStart, end: withEnd });
    }
  }

  // --- Step 5d: Relative clause support (who/that/which patterns) ---
  // Detect "who/that/which [verb] [object]" patterns after the primary entity
  extractRelativeClauses(original, intent, consumedRanges);

  // --- Step 5e: "[participle] by [agent]" patterns ---
  // e.g., "hosted by sustainability collective" → agent reference
  extractAgentByClauses(original, intent, consumedRanges);

  // Apply explicit "called/named" names
  if (explicitNames.length > 0) {
    const firstExplicit = explicitNames[0];

    if (firstExplicit.type === intent.primaryEntityType || !intent.entityName) {
      intent.entityName = firstExplicit.name;

      explicitNames.slice(1).forEach(({ type, name }) => {
        const alreadyAdded = intent.childEntities.some(c =>
          c.name?.toLowerCase() === name.toLowerCase()
        );
        if (!alreadyAdded) {
          intent.childEntities.push({ type, name });
        }
      });
    } else {
      explicitNames.forEach(({ type, name }) => {
        const alreadyAdded = intent.childEntities.some(c =>
          c.name?.toLowerCase() === name.toLowerCase()
        );
        if (!alreadyAdded) {
          intent.childEntities.push({ type, name });
        }
      });
    }
  }

  // --- Step 6: Extract location ---
  extractLocationProperty(original, intent);

  // --- Step 7: Extract temporal info ---
  extractTemporalProperty(original, intent);

  // --- Step 8: Extract property clauses (worth, for, about) ---
  extractPropertyClauses(original, intent, consumedRanges);

  // --- Step 9: Handle conjunction support (and/comma-separated entity lists) ---
  extractConjunctionEntities(original, intent, consumedRanges);

  return intent;
}

/**
 * Split input at "inside" keyword boundaries.
 * Returns an array of segments with their text and the determiner used.
 *
 * For "set up a farmers market event inside a farms project inside the food hub co-op group":
 * Returns:
 *   [0] { text: "set up a farmers market event", determiner: null }
 *   [1] { text: "a farms project", determiner: "a" }
 *   [2] { text: "the food hub co-op group", determiner: "the" }
 */
interface InsideSegment {
  text: string;
  determiner: string | null;
  /** The hierarchy delimiter that preceded this segment ("inside", "as part of", etc.) */
  delimiter?: string;
}

/**
 * Split input at hierarchy keyword boundaries: "inside", "as part of".
 * Returns an array of segments with their text, determiner, and delimiter.
 *
 * For "throw a party as part of a project called Party Time in the Boulder Solar Collective group":
 * Returns:
 *   [0] { text: "throw a party", determiner: null }
 *   [1] { text: "a project called Party Time in the Boulder Solar Collective group", determiner: "a", delimiter: "as part of" }
 */
function splitAtHierarchy(original: string): InsideSegment[] {
  const segments: InsideSegment[] = [];

  // Match hierarchy delimiters: "inside" or "as part of"
  const hierarchyPattern = /\b(?:as\s+part\s+of|inside)\b/gi;
  const matches: { index: number; length: number; text: string }[] = [];
  let m;
  while ((m = hierarchyPattern.exec(original)) !== null) {
    matches.push({ index: m.index, length: m[0].length, text: m[0].toLowerCase().replace(/\s+/g, " ") });
  }

  if (matches.length === 0) {
    // No hierarchy delimiter — entire input is the primary segment
    return [{ text: original, determiner: null }];
  }

  // First part is the primary entity segment (before the first delimiter)
  const primaryText = original.substring(0, matches[0].index).trim();
  segments.push({ text: primaryText || "", determiner: null });

  // Each delimiter introduces a parent segment
  for (let i = 0; i < matches.length; i++) {
    const delimEnd = matches[i].index + matches[i].length;
    const nextStart = i + 1 < matches.length ? matches[i + 1].index : original.length;
    const segText = original.substring(delimEnd, nextStart).trim();

    if (!segText) continue;

    const determinerMatch = segText.match(/^(a|an|the)\s+(.+)/i);
    segments.push({
      text: segText,
      determiner: determinerMatch ? determinerMatch[1].toLowerCase() : null,
      delimiter: matches[i].text
    });
  }

  return segments;
}

/**
 * Extract the primary entity type and name from the text before "inside".
 * e.g., "set up a farmers market event" → type=event, name="Farmers Market"
 */
function extractPrimaryEntity(
  segment: InsideSegment,
  allTokens: Token[],
  intent: ParsedIntent,
  verbEndIndex: number
): void {
  const text = segment.text;
  const segTokens = tokenize(text);

  // Find the entity type keyword in this segment (highest priority wins).
  // Deprioritize keywords after a preposition (in, at, near, from, for, by)
  // since they describe context, not the primary entity.
  // Stop entirely at relative pronouns (who, that, which) — those introduce
  // subordinate clauses handled by extractRelativeClauses.
  const PREPOSITIONS = new Set(["in", "at", "near", "from", "for", "by"]);
  const RELATIVE_PRONOUNS = new Set(["who", "that", "which"]);
  let bestType: { type: string; keyword: string; index: number; priority: number } | null = null;
  let seenPreposition = false;

  for (const token of segTokens) {
    // Stop at relative pronouns — everything after belongs to a relative clause
    if (RELATIVE_PRONOUNS.has(token.lower)) break;

    if (PREPOSITIONS.has(token.lower)) {
      seenPreposition = true;
      continue;
    }
    if (!TYPE_KEYWORDS[token.lower]) continue;
    const type = TYPE_KEYWORDS[token.lower];
    let priority = TYPE_PRIORITY[token.lower] || 0;

    // Keywords after a preposition are context (e.g., "in the riverside community")
    // not the primary entity type
    if (seenPreposition) {
      priority -= 20;
    }

    if (!bestType || priority > bestType.priority) {
      bestType = { type, keyword: token.lower, index: token.index, priority };
    }
  }

  // If the only type keyword found was deprioritized (in a prepositional phrase),
  // treat it as if no keyword was found — let the default inference handle it.
  if (bestType && bestType.priority < 0) {
    bestType = null;
  }

  if (bestType) {
    intent.primaryEntityType = bestType.type;

    // Preserve original keyword if it differs from the DB type
    // e.g., "party" → type="event", originalKeyword="party"
    // e.g., "job" → type="project", originalKeyword="job"
    const DB_TYPES = new Set(["project", "event", "place", "person", "organization"]);
    if (!DB_TYPES.has(bestType.keyword)) {
      intent.originalKeyword = bestType.keyword;
    }

    // Set targetTable based on the keyword
    const targetTable = getTargetTable(bestType.keyword);
    if (targetTable) {
      intent.targetTable = targetTable;
    }

    // Extract name: words between verb/determiner and the type keyword
    const nameTokens: string[] = [];
    for (let i = 0; i < bestType.index; i++) {
      const token = segTokens[i];

      // Skip creation verbs and determiners
      if (CREATION_VERBS.has(token.lower)) continue;
      // Check two-word verbs
      if (i + 1 < segTokens.length) {
        const twoWord = `${token.lower} ${segTokens[i + 1].lower}`;
        if (CREATION_VERBS.has(twoWord)) {
          i++; // skip the next token too
          continue;
        }
      }
      if (STOP_WORDS.has(token.lower)) {
        continue;
      }

      nameTokens.push(capitalize(token.text.replace(/[.,!?;:]+$/, "")));
    }

    intent.entityName = nameTokens.join(" ").trim();

    // If no descriptive name, check after the keyword
    if (!intent.entityName) {
      const afterNameTokens: string[] = [];
      for (let i = bestType.index + 1; i < segTokens.length; i++) {
        const token = segTokens[i];
        if (STOP_WORDS.has(token.lower) || CREATION_VERBS.has(token.lower)) break;
        if (TYPE_KEYWORDS[token.lower]) break;
        if (token.lower === "called" || token.lower === "named") break;
        if (RELATIVE_PRONOUNS.has(token.lower)) break;
        afterNameTokens.push(capitalize(token.text.replace(/[.,!?;:]+$/, "")));
      }

      if (afterNameTokens.length > 0) {
        intent.entityName = afterNameTokens.join(" ").trim();
      } else {
        intent.entityName = capitalize(bestType.keyword);
      }
    }
  } else {
    // No entity type keyword found in primary segment -- infer from context
    intent.primaryEntityType = "project"; // default
    intent.targetTable = "resources"; // projects are resources

    // Extract name from words between verb and end of segment
    const nameTokens: string[] = [];
    let pastVerb = verbEndIndex === -1; // if no verb, start collecting immediately

    for (const token of segTokens) {
      if (!pastVerb) {
        if (CREATION_VERBS.has(token.lower)) {
          pastVerb = true;
          continue;
        }
        // Check two-word verbs
        const nextIdx = token.index + 1;
        if (nextIdx < segTokens.length) {
          const twoWord = `${token.lower} ${segTokens[nextIdx].lower}`;
          if (CREATION_VERBS.has(twoWord)) {
            continue; // skip both words
          }
        }
        continue;
      }

      // Skip leading determiners
      if (nameTokens.length === 0 && (token.lower === "a" || token.lower === "an" || token.lower === "the")) {
        continue;
      }

      if (STOP_WORDS.has(token.lower)) break;
      if (token.lower === "called" || token.lower === "named") break;
      if (RELATIVE_PRONOUNS.has(token.lower)) break;
      nameTokens.push(capitalize(token.text.replace(/[.,!?;:]+$/, "")));
    }

    intent.entityName = nameTokens.join(" ").trim();
  }
}

/**
 * Parse a hierarchy clause to extract parent entities.
 * Handles simple and compound clauses:
 *
 * Simple: "a farms project" → [{ type: "project", name: "Farms", isExisting: false }]
 * Simple: "the food hub co-op group" → [{ type: "organization", name: "Food Hub Co-Op", isExisting: true }]
 * Compound: "a project called Party Time in the Boulder Solar Collective group"
 *   → [{ type: "project", name: "Party Time", isExisting: false },
 *      { type: "organization", name: "Boulder Solar Collective Group", isExisting: true }]
 */
function parseInsideClause(segment: InsideSegment): ExistingReference | null {
  const text = segment.text;
  const determiner = segment.determiner;

  // Determine if this is an existing entity reference based on determiner
  // "the" (definite) = existing entity, "a/an" (indefinite) = new entity
  const isExisting = determiner === "the";

  // Strip the determiner from the beginning
  const withoutDeterminer = text.replace(/^(a|an|the)\s+/i, "").trim();
  // Also strip trailing punctuation
  const cleaned = withoutDeterminer.replace(/[.,!?;:]+$/, "").trim();

  if (!cleaned) return null;

  // Check for "called/named" pattern within the clause
  // e.g., "project called Party Time in the Boulder Solar Collective group"
  // Also supports quoted names: project called "Party Time"
  const calledMatch = cleaned.match(
    /^(\w+)\s+(?:called|named)\s+(?:["']([^"']+)["']|(.+?))(?:\s+in\s+the\s+(.+?\s+(?:group|org|organization|community|collective|team))\b)?$/i
  );

  if (calledMatch) {
    const typeWord = calledMatch[1].toLowerCase();
    const entityType = TYPE_KEYWORDS[typeWord] || "project";
    // Group 2 = quoted name, Group 3 = unquoted name
    const name = (calledMatch[2] || calledMatch[3]).trim().replace(/[.,!?;:]+$/, "");

    // Return the named entity
    return {
      type: entityType,
      name: capitalizeWords(name),
      isExisting
    };
  }

  // Simple clause: find type keyword and extract name
  const words = cleaned.split(/\s+/);

  // Find entity type keyword (check from end of array backwards)
  let entityType = "organization"; // default for hierarchy references
  let entityName = "";
  let typeIndex = -1;

  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i].toLowerCase();
    if (TYPE_KEYWORDS[word]) {
      entityType = TYPE_KEYWORDS[word];
      typeIndex = i;
      break;
    }
  }

  // Name is everything before the type keyword
  if (typeIndex > 0) {
    entityName = capitalizeWords(words.slice(0, typeIndex).join(" "));
  } else if (typeIndex === 0 && words.length > 1) {
    entityName = capitalizeWords(words.slice(1).join(" "));
  } else {
    // No type keyword found, use whole clause as name
    entityName = capitalizeWords(cleaned);
  }

  if (!entityName) return null;

  return { type: entityType, name: entityName, isExisting };
}

/**
 * Extract relative clauses: "who/that/which [verb] [object]" patterns.
 * These indicate relationships between the primary entity and referenced objects.
 */
function extractRelativeClauses(
  original: string,
  intent: ParsedIntent,
  consumedRanges: { start: number; end: number }[]
): void {
  // Match "who/that/which [verb] [object]" after entity mentions
  const relClausePattern = /\b(?:who|that|which)\s+(\w+)(?:s|es)?\s+(?:(?:a|an|the)\s+)?(.+?)(?=\s+(?:in|at|on|for|by|with|from|and|or|but|inside|who|that|which)\b|[.,!?;:]|$)/gi;
  let relMatch;

  while ((relMatch = relClausePattern.exec(original)) !== null) {
    const matchStart = relMatch.index;
    const matchEnd = matchStart + relMatch[0].length;

    // Skip if already consumed
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (alreadyConsumed) continue;

    const verb = relMatch[1].toLowerCase();
    const objectPhrase = relMatch[2].trim();

    // Skip if the verb is a known creation verb (those are handled elsewhere)
    if (CREATION_VERBS.has(verb)) continue;

    // Try to find an entity type in the object phrase
    const objectTokens = objectPhrase.split(/\s+/);
    let objectType = "project"; // default
    let objectName = objectPhrase;

    for (const word of objectTokens) {
      const lower = word.toLowerCase();
      const singular = PLURAL_TO_SINGULAR[lower] || lower;
      if (TYPE_KEYWORDS[singular]) {
        objectType = TYPE_KEYWORDS[singular];
        // Name is everything except the type keyword
        objectName = objectTokens
          .filter(w => w.toLowerCase() !== lower)
          .join(" ");
        break;
      }
    }

    // If name is empty (object phrase was just the type keyword), use the keyword as name
    const finalName = objectName.trim() || capitalize(objectType);
    intent.childEntities.push({
      type: objectType,
      name: capitalizeWords(finalName),
      relationshipVerb: verb
    });
    consumedRanges.push({ start: matchStart, end: matchEnd });
  }
}

/**
 * Extract "[participle] by [agent]" patterns.
 * e.g., "hosted by sustainability collective" → existingReference { type: "organization", name: "Sustainability Collective" }
 * e.g., "organized by Alice" → existingReference { type: "person", name: "Alice" }
 */
function extractAgentByClauses(
  original: string,
  intent: ParsedIntent,
  consumedRanges: { start: number; end: number }[]
): void {
  // Build alternation from AGENT_PARTICIPLES
  const participles = Array.from(AGENT_PARTICIPLES).join("|");
  const pattern = new RegExp(
    `\\b(?:${participles})\\s+by\\s+([a-zA-Z][a-zA-Z\\s]*?)(?=\\s+(?:in|at|on|for|with|from|and|or|but|inside|next|today|tomorrow|this|last|starting|ending|every|about|worth)\\b|\\s+\\d|[.,!?;:]|$)`,
    "gi"
  );

  let match;
  while ((match = pattern.exec(original)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Skip if already consumed
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (alreadyConsumed) continue;

    const agentName = match[1].trim();
    if (!agentName) continue;

    // Check if the agent name contains a type keyword to determine entity type
    const agentWords = agentName.toLowerCase().split(/\s+/);
    let agentType = "organization"; // default for "hosted by" agents
    for (const word of agentWords) {
      const singular = PLURAL_TO_SINGULAR[word] || word;
      if (singular in AGENT_TYPE_KEYWORDS) {
        agentType = AGENT_TYPE_KEYWORDS[singular];
        break;
      }
    }

    // Check if already captured as a reference
    const alreadyCaptured = intent.existingReferences.some(ref =>
      ref.name.toLowerCase() === capitalizeWords(agentName).toLowerCase()
    );
    if (!alreadyCaptured) {
      intent.existingReferences.push({
        type: agentType,
        name: capitalizeWords(agentName),
        isExisting: true // assume the hosting agent exists
      });
    }

    consumedRanges.push({ start: matchStart, end: matchEnd });
  }
}

/**
 * Extract property clauses from natural language:
 * - "worth [number] [unit]" → { key: "value", value: "50 points" }
 * - "for [purpose]" → { key: "purpose", value: "..." }
 * - "about [topic]" → { key: "topic", value: "..." }
 */
function extractPropertyClauses(
  original: string,
  intent: ParsedIntent,
  consumedRanges: { start: number; end: number }[]
): void {
  // "worth [number] [unit]"
  const worthPattern = /\bworth\s+(\d+(?:\.\d+)?)\s+(\w+)/i;
  const worthMatch = original.match(worthPattern);
  if (worthMatch) {
    const matchStart = original.indexOf(worthMatch[0]);
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (!alreadyConsumed) {
      intent.properties.push({
        key: "value",
        value: `${worthMatch[1]} ${worthMatch[2]}`
      });
      consumedRanges.push({
        start: matchStart,
        end: matchStart + worthMatch[0].length
      });
    }
  }

  // "about [topic]" — terminated by prepositions, conjunctions, or punctuation
  const aboutPattern = /\babout\s+([a-zA-Z][a-zA-Z\s]*?)(?=\s+(?:in|at|on|for|by|with|from|and|or|but|inside|worth)\b|[.,!?;:]|$)/i;
  const aboutMatch = original.match(aboutPattern);
  if (aboutMatch) {
    const matchStart = original.indexOf(aboutMatch[0]);
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (!alreadyConsumed) {
      const topic = aboutMatch[1].trim();
      if (topic.length > 0) {
        intent.properties.push({
          key: "topic",
          value: capitalizeWords(topic)
        });
        consumedRanges.push({
          start: matchStart,
          end: matchStart + aboutMatch[0].length
        });
      }
    }
  }

  // "for [purpose]" — only match after the primary entity type, avoiding "for" as a preposition
  // e.g., "create a project for community outreach"
  // Skip if already captured as location or temporal
  const forPurposePattern = /\bfor\s+([a-zA-Z][a-zA-Z\s]*?)(?=\s+(?:in|at|on|by|with|from|and|or|but|inside|worth|about)\b|[.,!?;:]|$)/i;
  const forMatch = original.match(forPurposePattern);
  if (forMatch) {
    const matchStart = original.indexOf(forMatch[0]);
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (!alreadyConsumed) {
      const purpose = forMatch[1].trim();
      // Avoid treating temporal words as purposes
      const temporalWords = new Set([
        "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday",
        "friday", "saturday", "sunday", "next"
      ]);
      const firstWord = purpose.split(/\s+/)[0].toLowerCase();
      if (purpose.length > 0 && !temporalWords.has(firstWord)) {
        intent.properties.push({
          key: "purpose",
          value: capitalizeWords(purpose)
        });
        consumedRanges.push({
          start: matchStart,
          end: matchStart + forMatch[0].length
        });
      }
    }
  }
}

/**
 * Handle "and" / comma-separated entity lists in creation context.
 * e.g., "create a project and an event" → two entities
 * e.g., "create a ring, a family, and a guild" → three entities
 *
 * Only activates when the pattern follows a creation verb + type keyword,
 * detecting subsequent "and [type]" or ", [type]" patterns.
 */
function extractConjunctionEntities(
  original: string,
  intent: ParsedIntent,
  consumedRanges: { start: number; end: number }[]
): void {
  // Match "and a/an [type]" or ", a/an [type]" patterns after the primary entity
  // This is conservative: only triggers when a clear determiner + type keyword follows "and"/","
  const conjPattern = /(?:,\s*(?:and\s+)?|(?:\band\s+))(?:a|an)\s+(\w+)/gi;
  let conjMatch;

  while ((conjMatch = conjPattern.exec(original)) !== null) {
    const matchStart = conjMatch.index;
    const matchEnd = matchStart + conjMatch[0].length;

    // Skip if already consumed
    const alreadyConsumed = consumedRanges.some(r =>
      matchStart >= r.start && matchStart < r.end
    );
    if (alreadyConsumed) continue;

    const typeWord = conjMatch[1].toLowerCase();
    const singularForm = PLURAL_TO_SINGULAR[typeWord] || typeWord;
    const resolvedType = TYPE_KEYWORDS[singularForm];

    if (resolvedType) {
      // Check if this entity type was already added as the primary or as a child
      const alreadyAdded = intent.childEntities.some(c =>
        c.type === resolvedType && !c.name
      );
      if (!alreadyAdded && resolvedType !== intent.primaryEntityType) {
        // Preserve original keyword if it differs from DB type
        const DB_TYPES = new Set(["project", "event", "place", "person", "organization"]);
        const originalKeyword = !DB_TYPES.has(singularForm) ? singularForm : undefined;

        intent.childEntities.push({
          type: resolvedType,
          name: capitalize(singularForm),
          originalKeyword
        });
        consumedRanges.push({ start: matchStart, end: matchEnd });
      }
    }
  }
}

/**
 * Extract location from phrases like "in Oakland", "at the innovation lab"
 * Skips "in the [name] group" patterns already consumed
 */
function extractLocationProperty(original: string, intent: ParsedIntent): void {
  // Match "in [Location]" or "at [Location]"
  // Accepts both capitalized and lowercase (e.g., "in boulder", "at the innovation lab")
  // Terminated by prepositions, entity keywords, or punctuation
  const locationPattern = /\b(?:in|at)\s+(?:the\s+)?([a-zA-Z][a-zA-Z\s]*?)(?=\s+(?:for|on|by|with|from|group|org|organization|called|named|and|or|but)|[.,!?;:]|$)/;
  const locationMatch = original.match(locationPattern);

  if (locationMatch) {
    // Group 1 matches the location name (with or without "the")
    const locationValue = locationMatch[1].trim();

    // Don't match if this is part of "in the [name] group" pattern
    const isGroupRef = intent.existingReferences.some(ref =>
      locationValue.toLowerCase().includes(ref.name.toLowerCase()) ||
      ref.name.toLowerCase().includes(locationValue.toLowerCase())
    );

    // Don't match temporal phrases
    const temporalWords = ["morning", "afternoon", "evening", "night", "january", "february",
      "march", "april", "may", "june", "july", "august", "september", "october",
      "november", "december"];
    const isTemporalPhrase = temporalWords.some(tw =>
      locationValue.toLowerCase().startsWith(tw)
    );

    if (!isGroupRef && !isTemporalPhrase && locationValue.length > 1) {
      intent.properties.push({
        key: "location",
        value: capitalizeWords(locationValue)
      });
    }
  }
}

/**
 * Extract temporal information from phrases like "on Saturdays", "next Friday", "tomorrow"
 */
function extractTemporalProperty(original: string, intent: ParsedIntent): void {
  const lower = original.toLowerCase();

  // Check for recurring patterns first (e.g., "every Monday", "on Saturdays")
  // chrono-node may not handle plural day names like "Saturdays"
  const recurringMatch = lower.match(/\b(?:every|on)\s+(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/);
  if (recurringMatch) {
    intent.properties.push({
      key: "schedule",
      value: recurringMatch[1].replace(/s$/, "") // normalize "saturdays" → "saturday"
    });
  }

  // Use chrono-node for rich temporal parsing (specific dates, times, ranges)
  const results = chrono.parse(original, new Date(), { forwardDate: true });

  for (const result of results) {
    const { start, end, text } = result;

    // Skip if chrono matched the same day we already captured as recurring
    // (e.g., "on Saturdays" → chrono may parse as "next Saturday")
    if (recurringMatch && text.toLowerCase().includes(recurringMatch[1].replace(/s$/, ""))) {
      continue;
    }

    if (end) {
      // Time range: "from 9am to 5pm", "March 15-17"
      intent.properties.push({
        key: "startDate",
        value: start.date().toISOString()
      });
      intent.properties.push({
        key: "endDate",
        value: end.date().toISOString()
      });
    } else {
      // Single date/time
      intent.properties.push({
        key: "date",
        value: start.date().toISOString()
      });
    }

    // Preserve the original temporal phrase for display
    intent.properties.push({
      key: "temporalPhrase",
      value: text
    });
  }
}

/**
 * Build entity scaffold from intent
 */
function buildEntityScaffold(
  intent: ParsedIntent,
  existingEntities: Map<string, ExistingEntityRecord>
): V2ExtractedEntity[] {
  const entities: V2ExtractedEntity[] = [];
  let entityCounter = 0;

  const makeId = () => `temp-entity-${++entityCounter}-${Date.now()}`;

  // Calculate confidence for primary entity based on extraction quality
  const primaryConfidence = calculateConfidence(intent);

  // Primary entity
  const primaryEntity: V2ExtractedEntity = {
    tempId: makeId(),
    type: intent.primaryEntityType as EntityType,
    name: intent.entityName,
    originalKeyword: intent.originalKeyword,
    targetTable: intent.targetTable,
    properties: [
      { key: "name", value: intent.entityName, source: "primary" },
      ...intent.properties.map(p => ({ ...p, source: "extracted" }))
    ],
    sourcePhrase: intent.entityName,
    confidence: primaryConfidence
  };

  entities.push(primaryEntity);

  // Existing entity references (these should be linked, not created)
  intent.existingReferences.forEach(ref => {
    const existing = existingEntities.get(ref.name.toLowerCase());

    if (existing?.isExisting) {
      // Link to existing entity - mark as existing so it won't be created
      entities.push({
        tempId: makeId(),
        type: ref.type as EntityType,
        name: existing.name,
        existingId: existing.id,
        isExisting: true,
        targetTable: getTargetTable(ref.type),
        properties: [
          { key: "name", value: existing.name, source: "database" },
          { key: "note", value: "This entity already exists - will be linked", source: "system" }
        ],
        sourcePhrase: ref.name,
        confidence: 1.0
      });
    } else {
      // Entity reference not found in DB — create as new.
      // If the original determiner was "the" (isExisting hint), flag it so
      // the UI can show a "not found" warning and the user can verify.
      entities.push({
        tempId: makeId(),
        type: ref.type as EntityType,
        name: ref.name,
        isExistingHint: ref.isExisting || false,
        targetTable: getTargetTable(ref.type),
        properties: [
          { key: "name", value: ref.name, source: "inferred" }
        ],
        sourcePhrase: ref.name,
        confidence: ref.isExisting ? 0.7 : 0.8
      });
    }
  });

  // Child entities with explicit names (e.g., "event called cosmolocal")
  intent.childEntities.forEach(child => {
    // Use the explicit name if provided, otherwise prefer the plural form
    // (e.g., "Workshops" instead of generic "Event") for better readability
    const childName = child.name || (child.pluralHint ? capitalize(child.pluralHint) : capitalize(child.type));

    // Determine targetTable for child entity
    const childKeyword = child.originalKeyword || child.type;
    const childTargetTable = getTargetTable(childKeyword);

    entities.push({
      tempId: makeId(),
      type: child.type as EntityType,
      name: childName,
      originalKeyword: child.originalKeyword,
      targetTable: childTargetTable,
      properties: [
        { key: "name", value: childName, source: child.name ? "explicit" : "inferred" },
        ...(child.pluralHint ? [{ key: "pluralHint", value: child.pluralHint, source: "grammar" }] : [])
      ],
      sourcePhrase: childName,
      confidence: child.name ? 0.9 : 0.6
    });
  });

  return entities;
}

/**
 * Calculate confidence score for the primary entity based on extraction quality
 */
function calculateConfidence(intent: ParsedIntent): number {
  let confidence = 0.5; // base

  // Has a creation verb?
  if (intent.primaryAction !== "create") {
    // Explicit verb found (defaulting to "create" when not found is handled elsewhere)
    confidence += 0.1;
  }

  // Has a descriptive name (not just the keyword)?
  if (intent.entityName && intent.entityName.toLowerCase() !== intent.primaryEntityType) {
    confidence += 0.2;
  }

  // Has properties extracted?
  if (intent.properties.length > 0) {
    confidence += 0.1;
  }

  // Has child entities or references?
  if (intent.childEntities.length > 0 || intent.existingReferences.length > 0) {
    confidence += 0.1;
  }

  confidence = Math.min(confidence, 1.0);
  return Math.round(confidence * 100) / 100;
}

/**
 * Build relationships between entities
 *
 * Relationship direction convention:
 * - part_of:      from=child,   to=parent   (child is part of parent)
 * - organized_by: from=entity,  to=organizer (entity is organized by org)
 * - located_in:   from=entity,  to=place     (entity is located in place)
 */
function buildRelationships(entities: V2ExtractedEntity[], intent: ParsedIntent): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];

  if (entities.length < 2) return relationships;

  const primaryType = entities[0].type;

  // Check if we have a sequential "inside" chain (multiple existingReferences from "inside" pattern)
  // If so, build sequential part_of relationships: entity[0] -> entity[1] -> entity[2]
  const hasInsideChain = intent.existingReferences.length >= 2 &&
                          entities.length === 1 + intent.existingReferences.length;

  if (hasInsideChain) {
    // Build sequential chain: each entity is part_of the next
    for (let i = 0; i < entities.length - 1; i++) {
      relationships.push({
        type: "part_of",
        fromEntityIndex: i,
        toEntityIndex: i + 1,
        source: "inferred"
      });
    }
    return relationships;
  }

  // Standard relationship building (all secondary entities relate to primary)
  for (let i = 1; i < entities.length; i++) {
    const entity = entities[i];

    let relType: RelationshipType = "part_of";
    let fromIndex = i;
    let toIndex = 0;

    // Determine relationship type and direction based on entity types
    if (entity.type === "organization") {
      if (entity.isExisting) {
        // Primary entity is part_of the existing organization
        // from=primary (child), to=org (parent)
        relType = "part_of";
        fromIndex = 0;
        toIndex = i;
      } else {
        // Organization organizes the primary entity
        // from=primary (the thing being organized), to=org (the organizer)
        relType = "organized_by";
        fromIndex = 0;
        toIndex = i;
      }
    } else if (entity.type === "place") {
      // Primary entity is located_in the place
      // from=primary, to=place
      relType = "located_in";
      fromIndex = 0;
      toIndex = i;
    } else if (entity.type === "event" && (primaryType === "project" || primaryType === "organization")) {
      // Child event is part_of the parent project/organization
      // from=child event, to=parent project
      relType = "part_of";
      fromIndex = i;
      toIndex = 0;
    } else if (entity.type === "project" && primaryType === "organization") {
      // Child project is part_of the parent organization
      // from=child project, to=parent org
      relType = "part_of";
      fromIndex = i;
      toIndex = 0;
    } else {
      // Default: secondary entity is part_of primary
      relType = "part_of";
      fromIndex = i;
      toIndex = 0;
    }

    relationships.push({
      type: relType,
      fromEntityIndex: fromIndex,
      toEntityIndex: toIndex,
      source: "inferred"
    });
  }

  return relationships;
}

/**
 * Extract grammar/determiners
 */
function extractGrammar(original: string, tokens: Token[]): V2Conditional[] {
  const conditionals: V2Conditional[] = [];

  const determiners = new Set(["a", "an", "the", "this", "that", "some", "several", "many"]);

  tokens.forEach((token, index) => {
    if (!determiners.has(token.lower)) return;

    // Find the noun/entity phrase it modifies (up to next preposition or determiner)
    const predicateTokens: string[] = [];
    for (let j = index + 1; j < tokens.length && j <= index + 4; j++) {
      if (determiners.has(tokens[j].lower) || STOP_WORDS.has(tokens[j].lower)) break;
      predicateTokens.push(tokens[j].text);
    }

    if (predicateTokens.length > 0) {
      const predicate = predicateTokens.join(" ");
      conditionals.push({
        determiner: token.lower,
        predicate,
        source: `${token.text} ${predicate}`
      });
    }
  });

  return conditionals;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function capitalizeWords(str: string): string {
  if (!str) return str;
  return str.split(/\s+/).map(capitalize).join(" ");
}
