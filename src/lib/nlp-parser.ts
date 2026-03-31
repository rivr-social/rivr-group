/**
 * Enhanced NLP Parser for Entity Scaffolding
 *
 * Parses natural language input to extract entity types, properties,
 * relationships, and conditionals using determiners and grammar analysis.
 *
 * Leverages the engine.ts Verb/Sentence grammar and maps to db/schema.ts
 * agent types (person, organization, project, event, place).
 *
 * Key exports:
 * - `parseNaturalLanguage`
 * - `ENTITY_TYPES`, `RELATIONSHIP_TYPES`
 * - `entityTypeToAgentType`
 * - `ENTITY_TYPE_LABELS`, `RELATIONSHIP_TYPE_LABELS`
 *
 * Dependencies:
 * - `@/db/schema` type mapping (`AgentType`).
 */

import type { AgentType } from "@/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported entity types aligned with schema agentTypeEnum */
export const ENTITY_TYPES = {
  PROJECT: "project",
  EVENT: "event",
  PLACE: "place",
  PERSON: "person",
  ORGANIZATION: "organization",
} as const;

/** Union of supported parser entity values. */
export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES];

/** Relationship kinds we extract from natural language */
export const RELATIONSHIP_TYPES = {
  HOSTED_BY: "hosted_by",
  LOCATED_IN: "located_in",
  ORGANIZED_BY: "organized_by",
  PART_OF: "part_of",
  CREATED_BY: "created_by",
  ATTENDED_BY: "attended_by",
} as const;

/** Union of supported relationship values extracted by the parser. */
export type RelationshipType =
  (typeof RELATIONSHIP_TYPES)[keyof typeof RELATIONSHIP_TYPES];

/** Determiner categories used in grammar analysis */
const DETERMINERS = {
  DEFINITE: ["the"],
  INDEFINITE: ["a", "an"],
  DEMONSTRATIVE: ["this", "that", "these", "those"],
  POSSESSIVE: ["my", "your", "our", "their", "his", "her", "its"],
  QUANTITATIVE: ["some", "any", "every", "each", "all", "many", "few"],
} as const;

/** Flat set for fast lookup */
const ALL_DETERMINERS: Set<string> = new Set(
  Object.values(DETERMINERS).flat()
);

/** Prepositions that signal relationships or properties */
const RELATIONSHIP_PREPOSITIONS: Record<string, RelationshipType> = {
  by: RELATIONSHIP_TYPES.ORGANIZED_BY,
  from: RELATIONSHIP_TYPES.PART_OF,
  with: RELATIONSHIP_TYPES.PART_OF,
  at: RELATIONSHIP_TYPES.LOCATED_IN,
  in: RELATIONSHIP_TYPES.LOCATED_IN,
  near: RELATIONSHIP_TYPES.LOCATED_IN,
  for: RELATIONSHIP_TYPES.ATTENDED_BY,
};

/** Keywords that signal specific entity types */
const ENTITY_KEYWORDS: Record<string, EntityType> = {
  // Project signals
  project: ENTITY_TYPES.PROJECT,
  initiative: ENTITY_TYPES.PROJECT,
  campaign: ENTITY_TYPES.PROJECT,
  program: ENTITY_TYPES.PROJECT,
  venture: ENTITY_TYPES.PROJECT,
  effort: ENTITY_TYPES.PROJECT,

  // Event signals
  event: ENTITY_TYPES.EVENT,
  meetup: ENTITY_TYPES.EVENT,
  meeting: ENTITY_TYPES.EVENT,
  workshop: ENTITY_TYPES.EVENT,
  gathering: ENTITY_TYPES.EVENT,
  conference: ENTITY_TYPES.EVENT,
  party: ENTITY_TYPES.EVENT,
  festival: ENTITY_TYPES.EVENT,
  concert: ENTITY_TYPES.EVENT,
  class: ENTITY_TYPES.EVENT,
  session: ENTITY_TYPES.EVENT,
  seminar: ENTITY_TYPES.EVENT,
  celebration: ENTITY_TYPES.EVENT,
  ceremony: ENTITY_TYPES.EVENT,
  rally: ENTITY_TYPES.EVENT,
  hackathon: ENTITY_TYPES.EVENT,

  // Place signals
  place: ENTITY_TYPES.PLACE,
  location: ENTITY_TYPES.PLACE,
  venue: ENTITY_TYPES.PLACE,
  garden: ENTITY_TYPES.PLACE,
  park: ENTITY_TYPES.PLACE,
  center: ENTITY_TYPES.PLACE,
  hub: ENTITY_TYPES.PLACE,
  studio: ENTITY_TYPES.PLACE,
  office: ENTITY_TYPES.PLACE,
  farm: ENTITY_TYPES.PLACE,
  market: ENTITY_TYPES.PLACE,
  space: ENTITY_TYPES.PLACE,
  hall: ENTITY_TYPES.PLACE,
  plaza: ENTITY_TYPES.PLACE,
  library: ENTITY_TYPES.PLACE,

  // Person signals
  person: ENTITY_TYPES.PERSON,
  member: ENTITY_TYPES.PERSON,
  volunteer: ENTITY_TYPES.PERSON,
  organizer: ENTITY_TYPES.PERSON,
  coordinator: ENTITY_TYPES.PERSON,
  leader: ENTITY_TYPES.PERSON,
  host: ENTITY_TYPES.PERSON,

  // Organization signals
  organization: ENTITY_TYPES.ORGANIZATION,
  org: ENTITY_TYPES.ORGANIZATION,
  group: ENTITY_TYPES.ORGANIZATION,
  team: ENTITY_TYPES.ORGANIZATION,
  club: ENTITY_TYPES.ORGANIZATION,
  collective: ENTITY_TYPES.ORGANIZATION,
  association: ENTITY_TYPES.ORGANIZATION,
  community: ENTITY_TYPES.ORGANIZATION,
  cooperative: ENTITY_TYPES.ORGANIZATION,
  company: ENTITY_TYPES.ORGANIZATION,
  nonprofit: ENTITY_TYPES.ORGANIZATION,
  ring: ENTITY_TYPES.ORGANIZATION,
  family: ENTITY_TYPES.ORGANIZATION,
};

/** Action verbs that signal entity creation intent */
const CREATION_VERBS = new Set([
  "create",
  "start",
  "build",
  "make",
  "set up",
  "setup",
  "launch",
  "organize",
  "plan",
  "host",
  "schedule",
  "establish",
  "found",
  "form",
  "open",
  "begin",
  "initiate",
  "add",
  "register",
]);

/** Temporal markers for date extraction */
const TEMPORAL_MARKERS: Record<string, () => Date> = {
  today: () => new Date(),
  tomorrow: () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  },
  "next week": () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d;
  },
  "next month": () => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d;
  },
};

/** Day-of-week offsets for "next Saturday" style phrases */
const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A property extracted from the input text */
export interface ExtractedProperty {
  key: string;
  value: string;
  /** The source phrase in the original input */
  source: string;
}

/** A relationship between two extracted entities */
export interface ExtractedRelationship {
  type: RelationshipType;
  /** Index of the source entity in the entities array */
  fromEntityIndex: number;
  /** Index of the target entity in the entities array */
  toEntityIndex: number;
  /** The source phrase in the original input */
  source: string;
}

/** A conditional / determiner linked to a predicate */
export interface ExtractedConditional {
  determiner: string;
  category: string;
  predicate: string;
  /** The source phrase in the original input */
  source: string;
}

/** A single extracted entity ready for scaffolding */
export interface ExtractedEntity {
  /** Temporary client-side id for preview */
  tempId: string;
  type: EntityType;
  name: string;
  properties: ExtractedProperty[];
  /** The keyword / phrase that signaled this entity */
  sourcePhrase: string;
  /** Confidence score 0-1 */
  confidence: number;
}

/** Complete parse result returned by parseNaturalLanguage */
export interface NLPParseResult {
  /** Whether parsing succeeded */
  success: boolean;
  /** The original input text */
  input: string;
  /** Extracted entities */
  entities: ExtractedEntity[];
  /** Relationships between entities */
  relationships: ExtractedRelationship[];
  /** Conditionals / determiners linked to predicates */
  conditionals: ExtractedConditional[];
  /** Parsing errors or warnings */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse natural language input into structured entities, properties,
 * relationships, and conditionals.
 *
 * @param input - Natural language text describing one or more entities.
 * @returns Structured parse result containing entities, relationships, and conditionals.
 * @throws {Error} Does not intentionally throw; invalid input is returned as `success: false`.
 * @example
 * const result = parseNaturalLanguage(
 *   "Create a community garden project in Oakland for next Saturday"
 * );
 */
export function parseNaturalLanguage(input: string): NLPParseResult {
  if (!input || typeof input !== "string" || !input.trim()) {
    return {
      success: false,
      input: input ?? "",
      entities: [],
      relationships: [],
      conditionals: [],
      warnings: ["Input text is empty or invalid"],
    };
  }

  const normalized = input.trim().replace(/\s+/g, " ");
  // Tokenization preserves offsets used later for source-phrase extraction.
  const tokens = tokenize(normalized);
  const warnings: string[] = [];

  // Step 1: Detect creation intent
  const hasCreationIntent = detectCreationIntent(tokens);
  if (!hasCreationIntent) {
    warnings.push(
      "No creation verb detected. Interpreting as entity description."
    );
  }

  // Step 2: Extract entities from tokens
  const entities = extractEntities(tokens, normalized);
  if (entities.length === 0) {
    warnings.push(
      "No entity types could be identified from the input. Try including words like 'project', 'event', 'group', etc."
    );
  }

  // Step 3: Extract properties (name, location, date, description)
  enrichEntityProperties(entities, tokens, normalized);

  // Step 4: Extract relationships
  const relationships = extractRelationships(entities, tokens, normalized);

  // Step 5: Extract conditionals / determiners
  const conditionals = extractConditionals(tokens, normalized);

  return {
    success: entities.length > 0,
    input: normalized,
    entities,
    relationships,
    conditionals,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  lower: string;
  index: number;
  /** Position in original string */
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    // Strip trailing punctuation for matching but keep original
    const cleaned = raw.replace(/[.,!?;:]+$/, "");
    tokens.push({
      text: raw,
      lower: cleaned.toLowerCase(),
      index,
      start: match.index,
      end: match.index + raw.length,
    });
    index++;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Creation intent detection
// ---------------------------------------------------------------------------

function detectCreationIntent(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (CREATION_VERBS.has(token.lower)) {
      return true;
    }
  }
  // Check two-word verbs like "set up"
  for (let i = 0; i < tokens.length - 1; i++) {
    const twoWord = `${tokens[i].lower} ${tokens[i + 1].lower}`;
    if (CREATION_VERBS.has(twoWord)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

let entityCounter = 0;

function makeEntityId(): string {
  entityCounter++;
  return `temp-entity-${entityCounter}-${Date.now()}`;
}

function extractEntities(tokens: Token[], original: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const usedIndices = new Set<number>();

  // Pass 1: Multi-word entity type detection
  for (let i = 0; i < tokens.length - 1; i++) {
    const twoWord = `${tokens[i].lower} ${tokens[i + 1].lower}`;
    if (ENTITY_KEYWORDS[twoWord]) {
      const entityType = ENTITY_KEYWORDS[twoWord];
      entities.push({
        tempId: makeEntityId(),
        type: entityType,
        name: "",
        properties: [],
        sourcePhrase: `${tokens[i].text} ${tokens[i + 1].text}`,
        confidence: 0.9,
      });
      usedIndices.add(i);
      usedIndices.add(i + 1);
    }
  }

  // Pass 2: Single-word entity type detection
  for (let i = 0; i < tokens.length; i++) {
    if (usedIndices.has(i)) continue;
    const entityType = ENTITY_KEYWORDS[tokens[i].lower];
    if (entityType) {
      entities.push({
        tempId: makeEntityId(),
        type: entityType,
        name: "",
        properties: [],
        sourcePhrase: tokens[i].text,
        confidence: 0.85,
      });
      usedIndices.add(i);
    }
  }

  // If no entities found, try to infer from context
  if (entities.length === 0) {
    const inferredType = inferEntityTypeFromContext(tokens);
    if (inferredType) {
      entities.push({
        tempId: makeEntityId(),
        type: inferredType,
        name: "",
        properties: [],
        sourcePhrase: original,
        confidence: 0.5,
      });
    }
  }

  return entities;
}

function inferEntityTypeFromContext(tokens: Token[]): EntityType | null {
  // Check for temporal markers -> likely an event
  for (const token of tokens) {
    if (DAY_NAMES[token.lower] !== undefined) {
      return ENTITY_TYPES.EVENT;
    }
    if (TEMPORAL_MARKERS[token.lower]) {
      return ENTITY_TYPES.EVENT;
    }
  }

  // Check for location-style phrases -> likely a place
  const locationPreps = ["at", "in", "near"];
  for (const token of tokens) {
    if (locationPreps.includes(token.lower)) {
      return ENTITY_TYPES.PLACE;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Property enrichment
// ---------------------------------------------------------------------------

function enrichEntityProperties(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): void {
  if (entities.length === 0) return;

  // Extract name: build from tokens between creation verb and entity keyword,
  // or between entity keyword and first preposition
  extractNames(entities, tokens, original);

  // Extract location
  extractLocation(entities, tokens, original);

  // Extract date
  extractDate(entities, tokens, original);

  // Extract description from remaining context
  extractDescription(entities, tokens, original);
}

function extractNames(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): void {
  // Strategy: find a noun phrase near the entity keyword
  // Common pattern: "Create a [adj...] [entity_keyword]" -> name = adj phrase + keyword
  // Or: "Create a [name] [entity_keyword]" -> name is before keyword
  // Or: "[entity_keyword] called [name]" -> name follows "called"/"named"

  for (const entity of entities) {
    // Check for "called X" or "named X" pattern
    const calledMatch = original.match(
      /(?:called|named|titled)\s+["']?([^"',.\n]+?)["']?(?:\s+(?:in|at|on|for|by|with|from)|$)/i
    );
    if (calledMatch) {
      entity.name = calledMatch[1].trim();
      entity.properties.push({
        key: "name",
        value: entity.name,
        source: calledMatch[0].trim(),
      });
      continue;
    }

    // Build name from adjectives/nouns around the entity keyword
    const keywordLower = entity.sourcePhrase.toLowerCase();
    const keywordIndex = tokens.findIndex(
      (t) =>
        t.lower === keywordLower ||
        (tokens[t.index + 1] &&
          `${t.lower} ${tokens[t.index + 1].lower}` === keywordLower)
    );

    if (keywordIndex >= 0) {
      // Collect qualifying words before the keyword (after determiner)
      const nameTokens: string[] = [];
      let startIdx = keywordIndex - 1;

      // Skip backwards past determiners
      while (startIdx >= 0 && ALL_DETERMINERS.has(tokens[startIdx].lower)) {
        startIdx--;
      }

      // Skip backwards past creation verbs
      while (startIdx >= 0 && CREATION_VERBS.has(tokens[startIdx].lower)) {
        startIdx--;
      }

      // Collect descriptive tokens between verb and keyword
      for (let i = startIdx + 1; i < keywordIndex; i++) {
        const t = tokens[i];
        if (
          !ALL_DETERMINERS.has(t.lower) &&
          !CREATION_VERBS.has(t.lower)
        ) {
          nameTokens.push(t.text);
        }
      }

      // Include the keyword itself in the name
      nameTokens.push(entity.sourcePhrase);

      const name = nameTokens.join(" ").trim();
      if (name && name !== entity.sourcePhrase) {
        entity.name = name;
      } else {
        // Fallback: use the keyword as a base, capitalize it
        entity.name = capitalize(entity.sourcePhrase);
      }

      entity.properties.push({
        key: "name",
        value: entity.name,
        source: name,
      });
    } else {
      entity.name = capitalize(entity.sourcePhrase);
      entity.properties.push({
        key: "name",
        value: entity.name,
        source: entity.sourcePhrase,
      });
    }
  }
}

function extractLocation(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): void {
  // Match "in [Location]", "at [Location]", "near [Location]"
  const locationPattern =
    /\b(?:in|at|near)\s+([A-Z][a-zA-Z\s]*?)(?:\s+(?:for|on|by|with|from|next|this|tomorrow|today)|[.,!?]|$)/;
  const locationMatch = original.match(locationPattern);

  if (locationMatch) {
    const locationValue = locationMatch[1].trim();
    // Don't match temporal phrases like "in the morning"
    const temporalWords = [
      "the morning",
      "the afternoon",
      "the evening",
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const isTemporalPhrase = temporalWords.some((tw) =>
      locationValue.toLowerCase().startsWith(tw)
    );

    if (!isTemporalPhrase && locationValue.length > 1) {
      for (const entity of entities) {
        entity.properties.push({
          key: "location",
          value: locationValue,
          source: locationMatch[0].trim(),
        });
      }
    }
  }
}

function extractDate(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): void {
  const lowerOriginal = original.toLowerCase();

  // Check for "next [day]" pattern
  const nextDayMatch = lowerOriginal.match(
    /next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/
  );
  if (nextDayMatch) {
    const targetDay = DAY_NAMES[nextDayMatch[1]];
    const date = getNextDayOfWeek(targetDay);
    const dateStr = date.toISOString().split("T")[0];
    for (const entity of entities) {
      entity.properties.push({
        key: "date",
        value: dateStr,
        source: nextDayMatch[0],
      });
    }
    return;
  }

  // Check for "this [day]" pattern
  const thisDayMatch = lowerOriginal.match(
    /this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/
  );
  if (thisDayMatch) {
    const targetDay = DAY_NAMES[thisDayMatch[1]];
    const date = getThisDayOfWeek(targetDay);
    const dateStr = date.toISOString().split("T")[0];
    for (const entity of entities) {
      entity.properties.push({
        key: "date",
        value: dateStr,
        source: thisDayMatch[0],
      });
    }
    return;
  }

  // Check for named temporal markers
  for (const [marker, dateFn] of Object.entries(TEMPORAL_MARKERS)) {
    if (lowerOriginal.includes(marker)) {
      const dateStr = dateFn().toISOString().split("T")[0];
      for (const entity of entities) {
        entity.properties.push({
          key: "date",
          value: dateStr,
          source: marker,
        });
      }
      return;
    }
  }

  // Check for explicit date patterns (YYYY-MM-DD, MM/DD/YYYY, Month DD)
  const explicitDatePattern =
    /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/;
  const explicitMatch = original.match(explicitDatePattern);
  if (explicitMatch) {
    for (const entity of entities) {
      entity.properties.push({
        key: "date",
        value: explicitMatch[1],
        source: explicitMatch[0],
      });
    }
    return;
  }

  // Check for "Month Day" pattern
  const monthDayPattern =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
  const monthDayMatch = original.match(monthDayPattern);
  if (monthDayMatch) {
    const monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const monthIndex = monthNames.indexOf(monthDayMatch[1].toLowerCase());
    const day = parseInt(monthDayMatch[2], 10);
    const year = new Date().getFullYear();
    const date = new Date(year, monthIndex, day);
    // If the date is in the past, assume next year
    if (date < new Date()) {
      date.setFullYear(year + 1);
    }
    const dateStr = date.toISOString().split("T")[0];
    for (const entity of entities) {
      entity.properties.push({
        key: "date",
        value: dateStr,
        source: monthDayMatch[0],
      });
    }
  }
}

function extractDescription(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): void {
  // Use the full input as a description basis, cleaning out extracted parts
  // For now, use a simplified version of the original input
  for (const entity of entities) {
    const existingKeys = new Set(entity.properties.map((p) => p.key));
    if (!existingKeys.has("description")) {
      // Build description from the original input minus the creation verb
      let desc = original;
      for (const verb of CREATION_VERBS) {
        const verbRegex = new RegExp(`^${verb}\\s+`, "i");
        desc = desc.replace(verbRegex, "");
      }
      // Remove leading determiners
      desc = desc.replace(/^(a|an|the)\s+/i, "").trim();
      if (desc.length > 0) {
        entity.properties.push({
          key: "description",
          value: capitalize(desc),
          source: original,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relationship extraction
// ---------------------------------------------------------------------------

function extractRelationships(
  entities: ExtractedEntity[],
  tokens: Token[],
  original: string
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];

  if (entities.length < 2) {
    // With a single entity, check for implicit location or organizer references
    if (entities.length === 1) {
      const locationProp = entities[0].properties.find(
        (p) => p.key === "location"
      );
      if (locationProp) {
        // Create an implicit place entity for the location
        const placeEntity: ExtractedEntity = {
          tempId: makeEntityId(),
          type: ENTITY_TYPES.PLACE,
          name: locationProp.value,
          properties: [
            {
              key: "name",
              value: locationProp.value,
              source: locationProp.source,
            },
          ],
          sourcePhrase: locationProp.value,
          confidence: 0.7,
        };
        entities.push(placeEntity);

        relationships.push({
          type: RELATIONSHIP_TYPES.LOCATED_IN,
          fromEntityIndex: 0,
          toEntityIndex: entities.length - 1,
          source: locationProp.source,
        });
      }
    }
    return relationships;
  }

  // Build relationships between adjacent entities based on prepositions
  for (let i = 0; i < entities.length - 1; i++) {
    const current = entities[i];
    const next = entities[i + 1];

    // Find the text between the two entity source phrases
    const currentEnd =
      original.toLowerCase().indexOf(current.sourcePhrase.toLowerCase()) +
      current.sourcePhrase.length;
    const nextStart = original
      .toLowerCase()
      .indexOf(next.sourcePhrase.toLowerCase());

    if (currentEnd >= 0 && nextStart > currentEnd) {
      const between = original.substring(currentEnd, nextStart).trim().toLowerCase();

      // Check for prepositions
      for (const [prep, relType] of Object.entries(RELATIONSHIP_PREPOSITIONS)) {
        if (between.includes(prep)) {
          relationships.push({
            type: relType,
            fromEntityIndex: i,
            toEntityIndex: i + 1,
            source: between,
          });
          break;
        }
      }
    }
  }

  // Check for "hosted by" / "organized by" patterns
  const hostedByMatch = original.match(
    /(?:hosted|organized|run|led|managed)\s+by\s+([^.,!?]+)/i
  );
  if (hostedByMatch && entities.length >= 1) {
    const organizerName = hostedByMatch[1].trim();
    // Check if organizer is already an entity
    let organizerIndex = entities.findIndex(
      (e) => e.name.toLowerCase() === organizerName.toLowerCase()
    );
    if (organizerIndex === -1) {
      // Create an implicit organization/person entity
      const organizerEntity: ExtractedEntity = {
        tempId: makeEntityId(),
        type: ENTITY_TYPES.ORGANIZATION,
        name: organizerName,
        properties: [
          { key: "name", value: organizerName, source: hostedByMatch[0] },
        ],
        sourcePhrase: organizerName,
        confidence: 0.7,
      };
      entities.push(organizerEntity);
      organizerIndex = entities.length - 1;
    }

    relationships.push({
      type: RELATIONSHIP_TYPES.ORGANIZED_BY,
      fromEntityIndex: 0,
      toEntityIndex: organizerIndex,
      source: hostedByMatch[0].trim(),
    });
  }

  return relationships;
}

// ---------------------------------------------------------------------------
// Conditional / determiner extraction
// ---------------------------------------------------------------------------

function extractConditionals(
  tokens: Token[],
  original: string
): ExtractedConditional[] {
  const conditionals: ExtractedConditional[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!ALL_DETERMINERS.has(token.lower)) continue;

    // Identify the category
    let category = "unknown";
    for (const [cat, words] of Object.entries(DETERMINERS)) {
      if ((words as readonly string[]).includes(token.lower)) {
        category = cat;
        break;
      }
    }

    // Collect the predicate: tokens following the determiner until a
    // preposition, conjunction, or end of clause
    const predicateTokens: string[] = [];
    const stopWords = new Set([
      "in",
      "at",
      "on",
      "for",
      "by",
      "with",
      "from",
      "and",
      "or",
      "but",
    ]);

    for (let j = i + 1; j < tokens.length; j++) {
      if (stopWords.has(tokens[j].lower)) break;
      if (ALL_DETERMINERS.has(tokens[j].lower)) break;
      predicateTokens.push(tokens[j].text);
    }

    if (predicateTokens.length > 0) {
      const predicate = predicateTokens.join(" ");
      const sourceStart = token.start;
      const lastPredToken = tokens[i + predicateTokens.length];
      const sourceEnd = lastPredToken ? lastPredToken.end : token.end;

      conditionals.push({
        determiner: token.text,
        category,
        predicate,
        source: original.substring(sourceStart, sourceEnd),
      });
    }
  }

  return conditionals;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getNextDayOfWeek(targetDay: number): Date {
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil <= 0) {
    daysUntil += 7;
  }
  const result = new Date(now);
  result.setDate(result.getDate() + daysUntil);
  return result;
}

function getThisDayOfWeek(targetDay: number): Date {
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil < 0) {
    daysUntil += 7;
  }
  const result = new Date(now);
  result.setDate(result.getDate() + daysUntil);
  return result;
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ---------------------------------------------------------------------------
// Helpers for type-safe mapping to schema
// ---------------------------------------------------------------------------

/**
 * Maps parser `EntityType` values to database `AgentType` values.
 *
 * @param type - Parser-level entity type.
 * @returns Equivalent `AgentType` for schema persistence.
 * @throws {Error} Does not intentionally throw for valid `EntityType` inputs.
 * @example
 * const dbType = entityTypeToAgentType(ENTITY_TYPES.EVENT);
 */
export function entityTypeToAgentType(type: EntityType): AgentType {
  return type as AgentType;
}

/** Human-readable label map for presenting entity types in UI text. */
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  [ENTITY_TYPES.PROJECT]: "Project",
  [ENTITY_TYPES.EVENT]: "Event",
  [ENTITY_TYPES.PLACE]: "Place",
  [ENTITY_TYPES.PERSON]: "Person",
  [ENTITY_TYPES.ORGANIZATION]: "Organization",
};

/** Human-readable label map for presenting relationship types in UI text. */
export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  [RELATIONSHIP_TYPES.HOSTED_BY]: "Hosted by",
  [RELATIONSHIP_TYPES.LOCATED_IN]: "Located in",
  [RELATIONSHIP_TYPES.ORGANIZED_BY]: "Organized by",
  [RELATIONSHIP_TYPES.PART_OF]: "Part of",
  [RELATIONSHIP_TYPES.CREATED_BY]: "Created by",
  [RELATIONSHIP_TYPES.ATTENDED_BY]: "Attended by",
};
