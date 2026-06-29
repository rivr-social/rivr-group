/**
 * @file Semantic AST — versioned intermediate representation for RIVR meaning objects.
 *
 * The semantic parser turns plain English into a {@link SemanticProgram}: a small,
 * clean, versioned tree of {@link Statement}s. The AST is deliberately decoupled
 * from the messy database enums — it speaks in the *canonical* RIVR ontology
 * (see {@link AgentKind} / {@link GroupSubtype} / {@link RegionSubtype}). The
 * compilers (`compiler/*`) map this clean tree onto the existing persistence
 * payloads at the storage boundary.
 *
 * Design invariants (from the v1 plan §2):
 * - The parser emits UNRESOLVED {@link Slot}s; entity resolution is a separate
 *   pass (`resolver.ts`). The AST never carries a db id from the parser.
 * - Ambiguity is normal: a parse yields RANKED candidate {@link Interpretation}s
 *   with confidence, never a single forced parse.
 * - Pronouns/deixis are represented as {@link Slot}s with a {@link DeicticRef},
 *   bound later against a `ParseContext`.
 * - Rules carry variable {@link Binding}s (`$actor`, `$task`, …), not raw ids.
 *
 * @dependencies none (pure types + small constructors; no db, no IO)
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** Schema version of the AST shape itself. Bump on breaking AST changes. */
export const SEMANTIC_SCHEMA_VERSION = "semantic-v1" as const;

/** Version of the parser implementation that produced an AST. */
export const SEMANTIC_PARSER_VERSION = "rivr-semantic-0.1" as const;

export type SemanticSchemaVersion = typeof SEMANTIC_SCHEMA_VERSION;
export type SemanticParserVersion = typeof SEMANTIC_PARSER_VERSION;

// ---------------------------------------------------------------------------
// Canonical ontology (clean — superseding the messy DB enum)
// ---------------------------------------------------------------------------

/** Top-level domain of a referenced thing. */
export const SEMANTIC_DOMAINS = {
  AGENT: "agent",
  RESOURCE: "resource",
} as const;
export type SemanticDomain =
  (typeof SEMANTIC_DOMAINS)[keyof typeof SEMANTIC_DOMAINS];

/** Canonical agent kinds in the clean ontology. */
export const AGENT_KINDS = {
  PERSON: "person",
  GROUP: "group",
  BOT: "bot",
  SYSTEM: "system",
} as const;
export type AgentKind = (typeof AGENT_KINDS)[keyof typeof AGENT_KINDS];

/** User-creatable group subtypes (compile to real agent_type enum values). */
export const GROUP_SUBTYPES = {
  ORGANIZATION: "organization",
  FAMILY: "family",
  COMMUNITY: "community",
  RING: "ring",
} as const;
export type GroupSubtype =
  (typeof GROUP_SUBTYPES)[keyof typeof GROUP_SUBTYPES];

/**
 * Region subtypes. BACKEND-ONLY — these are `placeType` administrative metadata
 * on `place` agents, never user-creatable. The typechecker REJECTS any create
 * whose group subtype is `region` or carries one of these.
 */
export const REGION_SUBTYPES = {
  REGION: "region",
  LOCALE: "locale",
  COMMONS: "commons",
  BASIN: "basin",
} as const;
export type RegionSubtype =
  (typeof REGION_SUBTYPES)[keyof typeof REGION_SUBTYPES];

/** Canonical resource kinds the parser distinguishes structurally. */
export const RESOURCE_KINDS = {
  PROJECT: "project",
  EVENT: "event",
  PLACE: "place",
  POST: "post",
  LISTING: "listing",
  TASK: "task",
  GENERIC: "resource",
} as const;
export type ResourceKind =
  (typeof RESOURCE_KINDS)[keyof typeof RESOURCE_KINDS];

// ---------------------------------------------------------------------------
// Slots, determiners, deixis
// ---------------------------------------------------------------------------

/** Grammatical determiner attached to a slot (drives contract-rule scoping). */
export const DETERMINER_KINDS = {
  ANY: "any",
  THE: "the",
  THAT: "that",
  MY: "my",
  OUR: "our",
  A: "a",
  ALL: "all",
} as const;
export type DeterminerKind =
  (typeof DETERMINER_KINDS)[keyof typeof DETERMINER_KINDS];

/**
 * Deictic / pronoun reference. The parser cannot resolve these alone — they are
 * bound against a `ParseContext` (typecheck/resolver). Encodes "I/me/my",
 * "we/our", "this/that/them", "here", "now".
 */
export const DEICTIC_REFS = {
  SELF: "self", // I / me / my
  GROUP: "group", // we / our / us
  THIS: "this", // this / that / it (most-recent entity)
  THEM: "them", // them / those (most-recent plural / set)
  HERE: "here", // here (current locale)
  NOW: "now", // now (current time)
} as const;
export type DeicticRef = (typeof DEICTIC_REFS)[keyof typeof DEICTIC_REFS];

/** Variable bindings used by contract rules (resolved at compile/fire time). */
export const BINDINGS = {
  ACTOR: "$actor",
  TASK: "$task",
  GROUP: "$group",
  RECIPIENT: "$recipient",
  TRIGGER_OBJECT: "$triggerObject",
} as const;
export type Binding = (typeof BINDINGS)[keyof typeof BINDINGS];

/**
 * An UNRESOLVED reference to a thing in the graph. Produced by the parser,
 * consumed by the resolver. Exactly one of {name, deictic, binding, literalNew}
 * is the primary signal, with optional supporting fields.
 */
export interface Slot {
  /** Role of this slot inside its statement (subject, object, target, …). */
  role: SlotRole;
  /** Domain hint, when the grammar implies it (e.g. a verb requires an agent). */
  domain?: SemanticDomain;
  /** Canonical kind hint, when a head-noun keyword was present. */
  kind?: AgentKind | ResourceKind;
  /** User-creatable group subtype, when the head noun named one. */
  groupSubtype?: GroupSubtype;
  /** Region subtype, when named. Triggers backend-only rejection at typecheck. */
  regionSubtype?: RegionSubtype;
  /** A proper-noun / quoted name phrase to resolve against candidates. */
  name?: string;
  /** A pronoun/deictic reference to bind against the ParseContext. */
  deictic?: DeicticRef;
  /** A contract-rule variable binding ($actor, $task, …). */
  binding?: Binding;
  /** Grammatical determiner that scoped this slot. */
  determiner?: DeterminerKind;
  /** When true, the slot describes a NEW thing to create, not an existing one. */
  literalNew?: boolean;
  /** Properties parsed from the phrase (key/value), e.g. description, when, where. */
  properties?: SlotProperty[];
  /** The source substring that produced this slot (for explain/debug). */
  source: string;
}

/** Where in a statement a slot sits. */
export const SLOT_ROLES = {
  SUBJECT: "subject",
  OBJECT: "object",
  TARGET: "target",
  TRIGGER_SUBJECT: "triggerSubject",
  TRIGGER_OBJECT: "triggerObject",
  CONDITION_SUBJECT: "conditionSubject",
  CONDITION_OBJECT: "conditionObject",
  FILTER: "filter",
} as const;
export type SlotRole = (typeof SLOT_ROLES)[keyof typeof SLOT_ROLES];

/** A parsed key/value property for a slot. */
export interface SlotProperty {
  key: string;
  value: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** The kind of intent a statement expresses. */
export const STATEMENT_KINDS = {
  CREATE: "create",
  FIND: "find",
  RULE: "rule",
} as const;
export type StatementKind =
  (typeof STATEMENT_KINDS)[keyof typeof STATEMENT_KINDS];

/** A WHEN/IF/THEN condition or trigger clause inside a rule. */
export interface Condition {
  subject: Slot;
  verb: SemanticVerb;
  object?: Slot;
}

/** A single THEN action inside a rule. */
export interface Action {
  verb: SemanticVerb;
  object?: Slot;
  target?: Slot;
  /** Numeric magnitude (e.g. "give 5 thanks" → 5). */
  delta?: number;
}

/** A semantic verb: the clean lexeme plus the DB verb_type it compiles to. */
export interface SemanticVerb {
  /** Canonical lexeme as it appeared (normalized, lowercased). */
  lemma: string;
  /** The db verb_type enum value this maps to (null if not a ledger verb). */
  verbType: string | null;
}

/** CREATE: scaffold one or more new entities + their relationships. */
export interface CreateStatement {
  kind: typeof STATEMENT_KINDS.CREATE;
  /** The primary thing(s) being created (each is a literalNew slot). */
  entities: Slot[];
  /** Hierarchy / association relationships between created/linked slots. */
  relationships: CreateRelationship[];
}

/** Relationship between two slots in a create statement. */
export interface CreateRelationship {
  /** Canonical relationship type (compiles to RelationshipType). */
  type: string;
  /** Index of the child/source slot in `entities`. */
  fromIndex: number;
  /** Index of the parent/target slot in `entities`. */
  toIndex: number;
  source: string;
}

/** FIND: a permission-aware query over agents/resources/ledger. */
export interface FindStatement {
  kind: typeof STATEMENT_KINDS.FIND;
  /** What domain of thing is being queried. */
  domain: SemanticDomain;
  /** Optional kind constraint (e.g. only events). */
  kind_?: AgentKind | ResourceKind;
  /** Verb constraint (e.g. "things I created" → verb=create, subject=$self). */
  verb?: SemanticVerb;
  /** Slot constraints: who/what filters. */
  filters: Slot[];
}

/** RULE: a WHEN [condition] THEN [actions] [IF condition] contract. */
export interface RuleStatement {
  kind: typeof STATEMENT_KINDS.RULE;
  /** WHEN trigger clause. */
  trigger: Condition;
  /** THEN action chain. */
  actions: Action[];
  /** Optional IF condition gate. */
  condition?: Condition;
  /** Optional human-supplied rule name. */
  name?: string;
}

export type Statement = CreateStatement | FindStatement | RuleStatement;

// ---------------------------------------------------------------------------
// Interpretations & Program
// ---------------------------------------------------------------------------

/** One ranked reading of the input. */
export interface Interpretation {
  statement: Statement;
  /** Confidence in [0,1]. */
  confidence: number;
  /** Short reason this interpretation was produced (for explain/debug). */
  rationale: string;
}

/** Top-level parser output: the original text + ranked interpretations. */
export interface SemanticProgram {
  schemaVersion: SemanticSchemaVersion;
  parserVersion: SemanticParserVersion;
  /** The original natural-language input, verbatim. */
  originalInput: string;
  /** Ranked candidate interpretations, highest confidence first. */
  interpretations: Interpretation[];
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Build a versioned, ranked {@link SemanticProgram}. */
export function makeProgram(
  originalInput: string,
  interpretations: Interpretation[],
): SemanticProgram {
  const ranked = [...interpretations].sort(
    (a, b) => b.confidence - a.confidence,
  );
  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    parserVersion: SEMANTIC_PARSER_VERSION,
    originalInput,
    interpretations: ranked,
  };
}

/** Convenience: the highest-confidence interpretation, if any. */
export function topInterpretation(
  program: SemanticProgram,
): Interpretation | undefined {
  return program.interpretations[0];
}
