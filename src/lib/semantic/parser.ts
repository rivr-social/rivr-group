/**
 * @file parser.ts — text → SemanticProgram (UNRESOLVED slots, ranked readings).
 *
 * A small Controlled-Natural-Language parser. It does NOT resolve entities to db
 * ids (that is `resolver.ts`), does NOT check permissions (that is the compiler/
 * executor), and NEVER executes a write. It produces a versioned
 * {@link SemanticProgram} with one or more ranked {@link Interpretation}s.
 *
 * Strategy (intent-slot filling over a tokenized utterance):
 *   1. Tokenize + normalize creation phrases ("I'd like to" → "create").
 *   2. Detect intent: RULE (when/then) > FIND (find/show/list/who) > CREATE
 *      (creation verb or bare head-noun create) — but emit alternates with
 *      lower confidence when the signal is weak (ambiguity is normal).
 *   3. Fill slots from determiners + head nouns + names + deictic pronouns.
 *
 * @dependencies ./ast, ./lexicon, ./context. No db/IO.
 */

import {
  makeProgram,
  STATEMENT_KINDS,
  SLOT_ROLES,
  SEMANTIC_DOMAINS,
  type Action,
  type Condition,
  type CreateRelationship,
  type CreateStatement,
  type FindStatement,
  type Interpretation,
  type RuleStatement,
  type SemanticDomain,
  type SemanticProgram,
  type SemanticVerb,
  type Slot,
  type SlotProperty,
  type Statement,
} from "./ast";
import {
  CREATION_VERB_TYPES,
  DEICTIC_LEXICON,
  FIND_LEMMAS,
  RELATIONSHIP_LEXICON,
  RULE_ACTION_LEMMAS,
  RULE_CONDITION_LEMMAS,
  RULE_TRIGGER_LEMMAS,
  STOP_WORDS,
  lookupDeictic,
  lookupDeterminer,
  lookupOntologyNoun,
  lookupVerbType,
  type OntologyEntry,
} from "./lexicon";
import type { ParseContext } from "./context";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when {@link parse} is called without a usable grounding context. */
export class ParseContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseContextError";
  }
}

// ---------------------------------------------------------------------------
// Confidence constants
// ---------------------------------------------------------------------------

const CONFIDENCE = {
  STRONG: 0.9,
  GOOD: 0.75,
  MEDIUM: 0.55,
  WEAK: 0.35,
} as const;

/** Multi-word creation preambles normalized to "create". */
const CREATION_PHRASES: readonly string[] = [
  "i would like to",
  "i'd like to",
  "there should be",
  "there needs to be",
  "we need to",
  "we should",
  "we want to",
  "i want to",
  "i need to",
  "let's",
  "lets",
];

/** Words that introduce a name phrase ("called/named/titled X"). */
const NAME_INTRODUCERS: ReadonlySet<string> = new Set([
  "called",
  "named",
  "titled",
]);

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

interface Token {
  /** Original-case token. */
  raw: string;
  /** Lowercased token. */
  lower: string;
  /** Index in the token array. */
  index: number;
}

function tokenize(input: string): Token[] {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw, index) => ({ raw, lower: raw.toLowerCase().replace(/[.,!?;]+$/, ""), index }));
}

/** Normalize multi-word creation preambles to a single "create" token. */
function normalizeCreationPhrases(input: string): string {
  let out = input;
  for (const phrase of CREATION_PHRASES) {
    const re = new RegExp(`^\\s*${phrase.replace(/'/g, "['’]?")}\\s+`, "i");
    if (re.test(out)) {
      out = out.replace(re, "create ");
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verb + slot helpers
// ---------------------------------------------------------------------------

/** Try to read a verb (single then two-word) at position i. Returns lemma+span. */
function readVerb(tokens: Token[], i: number): { verb: SemanticVerb; nextIndex: number } | null {
  if (i >= tokens.length) return null;
  const two = i + 1 < tokens.length ? `${tokens[i].lower} ${tokens[i + 1].lower}` : null;
  if (two) {
    const vt = lookupVerbType(two);
    if (vt) return { verb: { lemma: two, verbType: vt }, nextIndex: i + 2 };
  }
  const vt = lookupVerbType(tokens[i].lower);
  if (vt) return { verb: { lemma: tokens[i].lower, verbType: vt }, nextIndex: i + 1 };
  return null;
}

/**
 * Read a noun-phrase slot starting at index `i`: optional determiner, optional
 * deictic pronoun, an ontology head noun, and a following "called/named X" name.
 * Returns the slot and the index just past it.
 */
function readSlot(
  tokens: Token[],
  i: number,
  role: Slot["role"],
): { slot: Slot; nextIndex: number } | null {
  let cursor = i;
  const determiner = lookupDeterminer(tokens[cursor]?.lower ?? "");
  const sourceStart = cursor;

  if (determiner !== undefined) cursor++;

  // Deictic pronoun as the whole slot (e.g. "me", "them", "here").
  const deictic = lookupDeictic(tokens[cursor]?.lower ?? "");
  if (deictic !== undefined && !lookupOntologyNoun(tokens[cursor]?.lower ?? "")) {
    const slot: Slot = {
      role,
      deictic,
      determiner,
      source: tokens.slice(sourceStart, cursor + 1).map((t) => t.raw).join(" "),
    };
    return { slot, nextIndex: cursor + 1 };
  }

  // Head noun via ontology lookup.
  let ontology: OntologyEntry | undefined;
  let headIndex = -1;
  for (let j = cursor; j < tokens.length; j++) {
    if (NAME_INTRODUCERS.has(tokens[j].lower)) break;
    const entry = lookupOntologyNoun(tokens[j].lower);
    if (entry) {
      ontology = entry;
      headIndex = j;
      break;
    }
    // Stop scanning at the next determiner/verb (new phrase boundary).
    if (lookupDeterminer(tokens[j].lower) || lookupVerbType(tokens[j].lower)) break;
  }

  if (!ontology || headIndex < 0) {
    // No head noun → if there was a determiner alone, return a bare slot.
    if (determiner !== undefined) {
      return {
        slot: { role, determiner, source: tokens[sourceStart].raw },
        nextIndex: cursor,
      };
    }
    return null;
  }

  cursor = headIndex + 1;

  // Optional "called/named/titled <Name...>" — capture proper-noun name.
  let name: string | undefined;
  let nameEnd = cursor;
  if (NAME_INTRODUCERS.has(tokens[cursor]?.lower ?? "")) {
    const nameTokens: string[] = [];
    let k = cursor + 1;
    for (; k < tokens.length; k++) {
      const lw = tokens[k].lower;
      // Stop at relationship prepositions / new verbs / name introducers.
      if (RELATIONSHIP_LEXICON[lw] || lookupVerbType(lw) || NAME_INTRODUCERS.has(lw)) {
        // "for the X project" introduces a relationship — stop the name here.
        break;
      }
      nameTokens.push(tokens[k].raw);
    }
    if (nameTokens.length > 0) {
      name = nameTokens.join(" ");
      nameEnd = k;
    }
  } else {
    // Inline proper-noun name immediately after the head noun (e.g.
    // "the River Cleanup project" handled by relationship path) — capture a
    // trailing capitalized run as a name when present.
    const nameTokens: string[] = [];
    let k = cursor;
    for (; k < tokens.length; k++) {
      const t = tokens[k];
      if (STOP_WORDS.has(t.lower) || lookupVerbType(t.lower) || lookupDeterminer(t.lower)) break;
      if (RELATIONSHIP_LEXICON[t.lower]) break;
      // Deictic pronouns ("I", "we", "this") are never part of a proper-noun
      // name — they belong to a following clause (e.g. "the projects I created").
      if (lookupDeictic(t.lower) !== undefined) break;
      // Only absorb capitalized tokens as a proper-noun name.
      if (/^[A-Z]/.test(t.raw)) nameTokens.push(t.raw);
      else break;
    }
    if (nameTokens.length > 0) {
      name = nameTokens.join(" ");
      nameEnd = k;
    }
  }

  const slot: Slot = {
    role,
    domain: ontology.domain,
    kind: ontology.kind,
    ...(ontology.groupSubtype ? { groupSubtype: ontology.groupSubtype } : {}),
    ...(ontology.regionSubtype ? { regionSubtype: ontology.regionSubtype } : {}),
    ...(determiner !== undefined ? { determiner } : {}),
    ...(name ? { name } : {}),
    source: tokens.slice(sourceStart, nameEnd).map((t) => t.raw).join(" "),
  };
  return { slot, nextIndex: nameEnd };
}

/** Collect deictic property slots ("here", "now") trailing in a token range. */
function collectDeicticProperties(tokens: Token[], from: number): SlotProperty[] {
  const props: SlotProperty[] = [];
  for (let i = from; i < tokens.length; i++) {
    const d = lookupDeictic(tokens[i].lower);
    if (d === DEICTIC_LEXICON.here) {
      props.push({ key: "locale", value: "$here", source: tokens[i].raw });
    } else if (d === DEICTIC_LEXICON.now) {
      props.push({ key: "when", value: "$now", source: tokens[i].raw });
    }
  }
  return props;
}

/** Find an explicit numeric delta in a token range ("5 thanks" → 5). */
function findDelta(tokens: Token[]): number | undefined {
  for (const t of tokens) {
    const n = Number(t.lower);
    if (Number.isFinite(n) && t.lower !== "") return n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Intent: RULE
// ---------------------------------------------------------------------------

function parseRule(tokens: Token[]): Interpretation | null {
  // Locate when/then/if boundaries.
  let whenIdx = -1;
  let thenIdx = -1;
  let ifIdx = -1;
  for (const t of tokens) {
    if (whenIdx < 0 && RULE_TRIGGER_LEMMAS.has(t.lower)) whenIdx = t.index;
    else if (thenIdx < 0 && RULE_ACTION_LEMMAS.has(t.lower)) thenIdx = t.index;
    else if (ifIdx < 0 && RULE_CONDITION_LEMMAS.has(t.lower)) ifIdx = t.index;
  }
  if (whenIdx < 0 || thenIdx < 0) return null;

  const triggerTokens = reindex(tokens.slice(whenIdx + 1, thenIdx));
  const actionEnd = ifIdx > thenIdx ? ifIdx : tokens.length;
  const actionTokens = reindex(tokens.slice(thenIdx + 1, actionEnd));
  const condTokens = ifIdx > thenIdx ? reindex(tokens.slice(ifIdx + 1)) : [];

  const trigger = parseClause(triggerTokens, SLOT_ROLES.TRIGGER_SUBJECT, SLOT_ROLES.TRIGGER_OBJECT);
  if (!trigger) return null;

  const actions = parseActions(actionTokens);
  if (actions.length === 0) return null;

  const condition =
    condTokens.length > 0
      ? parseClause(condTokens, SLOT_ROLES.CONDITION_SUBJECT, SLOT_ROLES.CONDITION_OBJECT) ?? undefined
      : undefined;

  const statement: RuleStatement = {
    kind: STATEMENT_KINDS.RULE,
    trigger,
    actions,
    ...(condition ? { condition } : {}),
  };
  return {
    statement,
    confidence: CONFIDENCE.STRONG,
    rationale: "explicit WHEN…THEN rule grammar",
  };
}

/** Parse "[det] [subject] [verb] [det] [object]" into a Condition. */
function parseClause(
  tokens: Token[],
  subjRole: Slot["role"],
  objRole: Slot["role"],
): Condition | null {
  // Subject slot (allow bare pronoun like "someone"/"anyone" via determiner-less).
  const subject = readSubjectLike(tokens, 0, subjRole);
  let i = subject.nextIndex;

  const v = readVerb(tokens, i);
  if (!v) return null;
  i = v.nextIndex;

  const objRead = i < tokens.length ? readSlot(tokens, i, objRole) : null;
  const object = objRead?.slot;

  return { subject: subject.slot, verb: v.verb, ...(object ? { object } : {}) };
}

/** Read a subject that may be a determiner+noun, a deictic, or "anyone/someone". */
function readSubjectLike(
  tokens: Token[],
  i: number,
  role: Slot["role"],
): { slot: Slot; nextIndex: number } {
  const word = tokens[i]?.lower ?? "";
  // Indefinite pronouns map to an "any" subject.
  if (word === "anyone" || word === "someone" || word === "everyone" || word === "somebody") {
    return {
      slot: { role, determiner: "any", source: tokens[i].raw },
      nextIndex: i + 1,
    };
  }
  const read = readSlot(tokens, i, role);
  if (read) return read;
  // Fall back: deictic or a single token as a named subject.
  const deictic = lookupDeictic(word);
  if (deictic !== undefined) {
    return { slot: { role, deictic, source: tokens[i].raw }, nextIndex: i + 1 };
  }
  return {
    slot: { role, name: tokens[i]?.raw, source: tokens[i]?.raw ?? "" },
    nextIndex: i + 1,
  };
}

/** Parse a THEN action chain ("give them 5 thanks", optionally "and …"). */
function parseActions(tokens: Token[]): Action[] {
  const actions: Action[] = [];
  // Split on "and" for multi-action chains.
  const segments = splitOn(tokens, "and");
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const v = readVerb(seg, 0);
    if (!v) continue;
    let i = v.nextIndex;

    // Optional recipient/target ("them", "the member").
    let target: Slot | undefined;
    const targetRead = i < seg.length ? readSlot(seg, i, SLOT_ROLES.TARGET) : null;
    if (targetRead && (targetRead.slot.deictic || targetRead.slot.kind)) {
      target = targetRead.slot;
      i = targetRead.nextIndex;
    }

    // Optional object ("a welcome badge", "5 thanks").
    let object: Slot | undefined;
    const objectRead = i < seg.length ? readSlot(seg, i, SLOT_ROLES.OBJECT) : null;
    if (objectRead) {
      object = objectRead.slot;
      i = objectRead.nextIndex;
    }

    const delta = findDelta(seg);

    actions.push({
      verb: v.verb,
      ...(object ? { object } : {}),
      ...(target ? { target } : {}),
      ...(delta !== undefined ? { delta } : {}),
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Intent: FIND
// ---------------------------------------------------------------------------

function parseFind(tokens: Token[]): Interpretation | null {
  // A find lemma anywhere near the front, OR an interrogative ("who/what").
  const head = tokens[0]?.lower ?? "";
  const isFind = FIND_LEMMAS.has(head);
  if (!isFind) return null;

  // Strip the leading find lemma + an optional "me".
  let i = 1;
  if (tokens[i]?.lower === "me") i++;

  const filters: Slot[] = [];
  let domain: SemanticDomain = SEMANTIC_DOMAINS.RESOURCE;
  let kind_: Slot["kind"] | undefined;
  let verb: SemanticVerb | undefined;

  // Optional determiner + head noun = the target kind ("all events", "the projects").
  const targetRead = i < tokens.length ? readSlot(tokens, i, SLOT_ROLES.FILTER) : null;
  if (targetRead && targetRead.slot.domain) {
    domain = targetRead.slot.domain;
    kind_ = targetRead.slot.kind;
    i = targetRead.nextIndex;
  }

  // Interrogative subject ("who joined …") implies an agent-domain find with a verb.
  if (head === "who") domain = SEMANTIC_DOMAINS.AGENT;

  // Remaining tokens: look for a deictic subject + verb filter ("I created",
  // "we own", "here", "joined … here").
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const deictic = lookupDeictic(t.lower);
    if (deictic !== undefined) {
      filters.push({ role: SLOT_ROLES.FILTER, deictic, source: t.raw });
      continue;
    }
    const v = readVerb(tokens, i);
    if (v) {
      verb = v.verb;
      i = v.nextIndex - 1;
      continue;
    }
  }

  const statement: FindStatement = {
    kind: STATEMENT_KINDS.FIND,
    domain,
    ...(kind_ ? { kind_ } : {}),
    ...(verb ? { verb } : {}),
    filters,
  };
  return {
    statement,
    confidence: CONFIDENCE.GOOD,
    rationale: `query intent (lead lemma "${head}")`,
  };
}

// ---------------------------------------------------------------------------
// Intent: CREATE
// ---------------------------------------------------------------------------

function parseCreate(tokens: Token[]): Interpretation | null {
  // Find a creation verb.
  const v = readVerb(tokens, 0);
  const isCreationLead =
    v && v.verb.verbType !== null && CREATION_VERB_TYPES.has(v.verb.verbType as never);
  let i = isCreationLead ? v!.nextIndex : 0;

  // Primary entity slot.
  const primaryRead = readSlot(tokens, i, SLOT_ROLES.OBJECT);
  if (!primaryRead) return null;
  const primary: Slot = { ...primaryRead.slot, literalNew: true };
  i = primaryRead.nextIndex;

  const entities: Slot[] = [primary];
  const relationships: CreateRelationship[] = [];

  // Optional relationship phrase: "for the River Cleanup project", "in Boulder".
  while (i < tokens.length) {
    const lw = tokens[i].lower;
    const relType = RELATIONSHIP_LEXICON[lw] ?? RELATIONSHIP_LEXICON[`${lw} ${tokens[i + 1]?.lower ?? ""}`];
    if (relType) {
      const relStart = i;
      // Advance past the relationship preposition (1 or 2 words).
      const twoWord = RELATIONSHIP_LEXICON[`${lw} ${tokens[i + 1]?.lower ?? ""}`];
      i += twoWord ? 2 : 1;
      const parentRead = readSlot(tokens, i, SLOT_ROLES.OBJECT);
      if (parentRead) {
        const parent: Slot = { ...parentRead.slot, literalNew: false };
        entities.push(parent);
        relationships.push({
          type: relType,
          fromIndex: 0,
          toIndex: entities.length - 1,
          source: tokens.slice(relStart, parentRead.nextIndex).map((t) => t.raw).join(" "),
        });
        i = parentRead.nextIndex;
        continue;
      }
    }
    i++;
  }

  // Attach trailing deictic properties (here/now) to the primary entity.
  const deicticProps = collectDeicticProperties(tokens, primaryRead.nextIndex);
  if (deicticProps.length > 0) {
    primary.properties = [...(primary.properties ?? []), ...deicticProps];
  }

  const confidence = isCreationLead ? CONFIDENCE.STRONG : CONFIDENCE.MEDIUM;
  const statement: CreateStatement = {
    kind: STATEMENT_KINDS.CREATE,
    entities,
    relationships,
  };
  return {
    statement,
    confidence,
    rationale: isCreationLead
      ? "explicit creation verb + head noun"
      : "head-noun create (no explicit verb)",
  };
}

// ---------------------------------------------------------------------------
// Bare deictic reference fallback ("share this")
// ---------------------------------------------------------------------------

function parseBareReference(tokens: Token[]): Interpretation | null {
  const v = readVerb(tokens, 0);
  if (!v) return null;
  const objRead = readSlot(tokens, v.nextIndex, SLOT_ROLES.FILTER);
  const hasDeicticObject = objRead?.slot.deictic !== undefined;
  if (!hasDeicticObject) return null;

  const statement: FindStatement = {
    kind: STATEMENT_KINDS.FIND,
    domain: SEMANTIC_DOMAINS.RESOURCE,
    verb: v.verb,
    filters: [objRead!.slot],
  };
  return {
    statement,
    confidence: CONFIDENCE.WEAK,
    rationale: "bare verb over a deictic reference",
  };
}

// ---------------------------------------------------------------------------
// Token-range utilities
// ---------------------------------------------------------------------------

function reindex(slice: Token[]): Token[] {
  return slice.map((t, index) => ({ ...t, index }));
}

function splitOn(tokens: Token[], word: string): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.lower === word) {
      segments.push(reindex(current));
      current = [];
    } else {
      current.push(t);
    }
  }
  segments.push(reindex(current));
  return segments;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse natural-language `input` into a versioned {@link SemanticProgram} with
 * ranked candidate interpretations (UNRESOLVED slots). The {@link ParseContext}
 * is required so deictic slots carry the grounding metadata the resolver/
 * typechecker need — the parser itself never invents identity.
 *
 * @param input The raw utterance.
 * @param context Grounding context (speaker, locale, clock, group, recents).
 * @returns A ranked {@link SemanticProgram}. Always non-empty: when nothing
 *   parses, a single WEAK "unparsed find" interpretation is returned so callers
 *   have a uniform shape to render an error/clarification from.
 */
export function parse(input: string, context: ParseContext): SemanticProgram {
  // Grounding context is REQUIRED: deictic slots produced below are bound later
  // against this context. Refusing to parse without a verified speaker keeps the
  // parser from emitting pronoun slots that can never be grounded (plan §2/§8).
  if (!context || !context.actorId) {
    throw new ParseContextError(
      "parse() requires a ParseContext with a verified actorId so deictic references can be grounded.",
    );
  }

  const normalized = normalizeCreationPhrases(input);
  const tokens = tokenize(normalized);

  const interpretations: Interpretation[] = [];

  const rule = parseRule(tokens);
  if (rule) interpretations.push(rule);

  const find = parseFind(tokens);
  if (find) interpretations.push(find);

  const create = parseCreate(tokens);
  if (create) interpretations.push(create);

  if (interpretations.length === 0) {
    const bare = parseBareReference(tokens);
    if (bare) interpretations.push(bare);
  }

  // Ambiguity surface: when a CREATE has a place/group-colloquial head noun
  // ("hub", "garden"), emit a lower-confidence alternate create reading so the
  // caller sees the ambiguity rather than a single forced parse.
  const topCreate = interpretations.find(
    (i) => i.statement.kind === STATEMENT_KINDS.CREATE,
  );
  if (topCreate) {
    const stmt = topCreate.statement as CreateStatement;
    const head = stmt.entities[0];
    if (head?.kind === "place" || head?.kind === "task") {
      interpretations.push({
        statement: topCreate.statement,
        confidence: Math.max(CONFIDENCE.WEAK, topCreate.confidence - 0.25),
        rationale: "alternate reading: ambiguous head noun",
      });
    }
  }

  if (interpretations.length === 0) {
    const fallback: Statement = {
      kind: STATEMENT_KINDS.FIND,
      domain: SEMANTIC_DOMAINS.RESOURCE,
      filters: [],
    };
    interpretations.push({
      statement: fallback,
      confidence: CONFIDENCE.WEAK,
      rationale: "no grammar matched; empty query fallback",
    });
  }

  return makeProgram(input, interpretations);
}
