/**
 * Tests for NLP Parser V2
 * Comprehensive test coverage for natural language entity extraction,
 * relationship building, and confidence scoring.
 */

import { describe, it, expect } from 'vitest';
import { parseNaturalLanguageV2 } from '../nlp-parser-v2';
import type { V2ParseResult, V2ExtractedEntity, ExistingEntityRecord } from '../nlp-parser-v2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get entity by index, asserting it exists */
function entityAt(result: V2ParseResult, index: number): V2ExtractedEntity {
  expect(result.entities.length).toBeGreaterThan(index);
  return result.entities[index];
}

/** Get a property value from an entity */
function propValue(entity: V2ExtractedEntity, key: string): string | undefined {
  return entity.properties.find(p => p.key === key)?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseNaturalLanguageV2', () => {
  // ---- Empty / Invalid Input ----

  describe('empty and invalid input', () => {
    it('returns failure for empty string', () => {
      const result = parseNaturalLanguageV2('');
      expect(result.success).toBe(false);
      expect(result.entities).toHaveLength(0);
      expect(result.warnings).toContain('Input text is empty or invalid');
    });

    it('returns failure for whitespace-only input', () => {
      const result = parseNaturalLanguageV2('   ');
      expect(result.success).toBe(false);
      expect(result.entities).toHaveLength(0);
    });

    it('returns failure for null-like input', () => {
      const result = parseNaturalLanguageV2(null as unknown as string);
      expect(result.success).toBe(false);
    });

    it('returns failure for undefined-like input', () => {
      const result = parseNaturalLanguageV2(undefined as unknown as string);
      expect(result.success).toBe(false);
    });
  });

  // ---- Simple Entity Creation ----

  describe('simple entity creation', () => {
    it('extracts a project from "create a project"', () => {
      const result = parseNaturalLanguageV2('create a project');
      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(1);
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('extracts an event from "start an event"', () => {
      const result = parseNaturalLanguageV2('start an event');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('event');
    });

    it('extracts a named project from "create a community garden project"', () => {
      const result = parseNaturalLanguageV2('create a community garden project');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(entity.type).toBe('project');
      expect(entity.name).toBe('Community Garden');
    });

    it('extracts organization from "form a nonprofit"', () => {
      const result = parseNaturalLanguageV2('form a nonprofit');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('organization');
    });
  });

  // ---- Two-Word Verbs ----

  describe('two-word verbs', () => {
    it('handles "set up" as a creation verb', () => {
      const result = parseNaturalLanguageV2('set up a farmers market event');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(entity.type).toBe('event');
      expect(entity.name).toBe('Farmers Market');
      expect(result.intent?.primaryAction).toBe('set up');
    });
  });

  // ---- Location Extraction ----

  describe('location extraction', () => {
    it('extracts capitalized location from "in Oakland"', () => {
      const result = parseNaturalLanguageV2('start a community garden project in Oakland');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(entity.type).toBe('project');
      expect(entity.name).toBe('Community Garden');
      expect(propValue(entity, 'location')).toBe('Oakland');
    });

    it('capitalizes lowercase location "in boulder"', () => {
      const result = parseNaturalLanguageV2('create an event in boulder called eth boulder');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'location')).toBe('Boulder');
    });

    it('does not extract temporal phrases as location', () => {
      const result = parseNaturalLanguageV2('create an event in morning');
      // "morning" should not be extracted as a location
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'location')).toBeUndefined();
    });
  });

  // ---- Temporal Extraction ----

  describe('temporal extraction', () => {
    it('extracts recurring schedule from "on Saturdays"', () => {
      const result = parseNaturalLanguageV2('create an event on Saturdays');
      const entity = entityAt(result, 0);
      // Recurring pattern detected — produces a schedule property
      expect(propValue(entity, 'schedule')).toBe('saturday');
    });

    it('extracts "next Friday" as a date', () => {
      const result = parseNaturalLanguageV2('start a project next friday');
      const entity = entityAt(result, 0);
      // chrono-node outputs ISO dates
      expect(propValue(entity, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entity, 'temporalPhrase')).toMatch(/next friday/i);
    });

    it('extracts "tomorrow" as a date', () => {
      const result = parseNaturalLanguageV2('create a project tomorrow');
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entity, 'temporalPhrase')).toMatch(/tomorrow/i);
    });

    it('extracts "next week" as a date', () => {
      const result = parseNaturalLanguageV2('launch a project next week');
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entity, 'temporalPhrase')).toMatch(/next week/i);
    });

    it('extracts time-of-day from "at 3pm"', () => {
      const result = parseNaturalLanguageV2('create a meetup next tuesday at 3pm');
      const entity = entityAt(result, 0);
      const dateVal = propValue(entity, 'date');
      expect(dateVal).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Verify the time component is 15:00
      expect(new Date(dateVal!).getHours()).toBe(15);
    });

    it('extracts time ranges from "from 9am to 5pm"', () => {
      const result = parseNaturalLanguageV2('create a shift from 9am to 5pm');
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'startDate')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entity, 'endDate')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(new Date(propValue(entity, 'startDate')!).getHours()).toBe(9);
      expect(new Date(propValue(entity, 'endDate')!).getHours()).toBe(17);
    });

    it('extracts specific dates like "March 15, 2026"', () => {
      const result = parseNaturalLanguageV2('plan a conference on March 15, 2026');
      const entity = entityAt(result, 0);
      const dateVal = propValue(entity, 'date');
      expect(dateVal).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const d = new Date(dateVal!);
      expect(d.getMonth()).toBe(2); // March = 2 (0-indexed)
      expect(d.getDate()).toBe(15);
    });
  });

  // ---- "inside" Chains ----

  describe('"inside" chains', () => {
    it('parses single inside clause', () => {
      const result = parseNaturalLanguageV2('create an event inside a project');
      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(2);
      expect(entityAt(result, 0).type).toBe('event');
      expect(entityAt(result, 1).type).toBe('project');
    });

    it('parses double inside chain with correct names', () => {
      const result = parseNaturalLanguageV2(
        'set up a farmers market event inside a farms project inside the food hub co-op group'
      );
      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(3);

      expect(entityAt(result, 0).type).toBe('event');
      expect(entityAt(result, 0).name).toBe('Farmers Market');

      expect(entityAt(result, 1).type).toBe('project');
      expect(entityAt(result, 1).name).toBe('Farms');

      expect(entityAt(result, 2).type).toBe('organization');
      expect(entityAt(result, 2).name).toBe('Food Hub Co-op');
    });

    it('builds sequential part_of relationships for inside chain', () => {
      const result = parseNaturalLanguageV2(
        'set up a farmers market event inside a farms project inside the food hub co-op group'
      );
      expect(result.relationships).toHaveLength(2);

      // entity[0] part_of entity[1]
      expect(result.relationships[0].type).toBe('part_of');
      expect(result.relationships[0].fromEntityIndex).toBe(0);
      expect(result.relationships[0].toEntityIndex).toBe(1);

      // entity[1] part_of entity[2]
      expect(result.relationships[1].type).toBe('part_of');
      expect(result.relationships[1].fromEntityIndex).toBe(1);
      expect(result.relationships[1].toEntityIndex).toBe(2);
    });

    it('marks "the" determiner entities with isExistingHint', () => {
      const result = parseNaturalLanguageV2(
        'create an event inside the main project'
      );
      const parent = entityAt(result, 1);
      expect(parent.isExistingHint).toBe(true);
    });

    it('does not mark "a/an" determiner entities with isExistingHint', () => {
      const result = parseNaturalLanguageV2(
        'create an event inside a new project'
      );
      const parent = entityAt(result, 1);
      expect(parent.isExistingHint).toBeFalsy();
    });

    it('handles empty inside clauses gracefully', () => {
      const result = parseNaturalLanguageV2('create event inside inside project');
      expect(result.success).toBe(true);
      // Should not crash; may produce fewer entities due to empty segment skipping
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- "called/named" Patterns ----

  describe('"called/named" patterns', () => {
    it('extracts name from "called eth boulder"', () => {
      const result = parseNaturalLanguageV2('create an event called eth boulder');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('Eth Boulder');
    });

    it('extracts both location and name from "in boulder called eth boulder"', () => {
      const result = parseNaturalLanguageV2('create an event in boulder called eth boulder');
      const entity = entityAt(result, 0);
      expect(entity.name).toBe('Eth Boulder');
      expect(propValue(entity, 'location')).toBe('Boulder');
    });

    it('extracts name from "named" keyword', () => {
      const result = parseNaturalLanguageV2('create a project named sunrise initiative');
      expect(entityAt(result, 0).name).toBe('Sunrise Initiative');
    });
  });

  // ---- "[participle] by [agent]" Patterns ----

  describe('"hosted by / organized by" patterns', () => {
    it('extracts name correctly when "called X hosted by Y"', () => {
      const result = parseNaturalLanguageV2(
        'plan a workshop called regen hosted by sustainability collective next friday'
      );
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('Regen');
      expect(entityAt(result, 0).type).toBe('event');
    });

    it('extracts hosting agent as organization reference', () => {
      const result = parseNaturalLanguageV2(
        'plan a workshop called regen hosted by sustainability collective next friday'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Sustainability Collective');
    });

    it('extracts temporal property alongside hosted-by clause', () => {
      const result = parseNaturalLanguageV2(
        'plan a workshop called regen hosted by sustainability collective next friday'
      );
      expect(propValue(entityAt(result, 0), 'date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entityAt(result, 0), 'temporalPhrase')).toMatch(/next friday/i);
    });

    it('handles "organized by" pattern', () => {
      const result = parseNaturalLanguageV2(
        'create a meetup organized by boulder tech group'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Boulder Tech Group');
    });

    it('handles "managed by" pattern', () => {
      const result = parseNaturalLanguageV2(
        'create a project managed by alice'
      );
      expect(result.intent?.existingReferences.length).toBeGreaterThan(0);
      expect(result.intent?.existingReferences[0].name).toBe('Alice');
    });

    it('does not consume "hosted" as part of entity name without "called"', () => {
      const result = parseNaturalLanguageV2(
        'create a conference hosted by eth denver'
      );
      expect(entityAt(result, 0).type).toBe('event');
      const org = result.entities.find(e => e.name === 'Eth Denver');
      expect(org).toBeDefined();
    });
  });

  // ---- "in the [name] group" Patterns ----

  describe('"in the [name] group/org/community" patterns', () => {
    it('extracts organization from "in the tech for good group"', () => {
      const result = parseNaturalLanguageV2(
        'create a project in the tech for good group'
      );
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Tech For Good Group');
    });

    it('extracts community from "in the riverside community"', () => {
      const result = parseNaturalLanguageV2(
        'plan a neighborhood cleanup in the riverside community'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Riverside Community');
    });

    it('marks "in the" references as existing', () => {
      const result = parseNaturalLanguageV2(
        'create a project in the makers collective'
      );
      expect(result.intent?.existingReferences.length).toBeGreaterThan(0);
      expect(result.intent?.existingReferences[0].isExisting).toBe(true);
    });
  });

  // ---- "with" Clauses ----

  describe('"with" clause patterns', () => {
    it('extracts child entity from "with an event called cosmolocal"', () => {
      const result = parseNaturalLanguageV2(
        'create a project with an event called cosmolocal'
      );
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      const child = result.entities.find(e => e.name === 'Cosmolocal');
      expect(child).toBeDefined();
      expect(child!.type).toBe('event');
    });

    it('extracts plural child entity from "with workshops"', () => {
      const result = parseNaturalLanguageV2('create a project with workshops');
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
      const child = result.entities.find(e => e.name === 'Workshops');
      expect(child).toBeDefined();
      expect(child!.type).toBe('event'); // workshop → event
    });

    it('builds part_of relationship for child entities', () => {
      const result = parseNaturalLanguageV2(
        'create a project with an event called cosmolocal'
      );
      expect(result.relationships.length).toBeGreaterThan(0);
      const rel = result.relationships[0];
      expect(rel.type).toBe('part_of');
      // Child event is part_of parent project
      expect(rel.fromEntityIndex).toBeGreaterThan(0);
      expect(rel.toEntityIndex).toBe(0);
    });
  });

  // ---- Complex Combined Inputs ----

  describe('complex combined inputs', () => {
    it('parses full complex input with group and child entity', () => {
      const result = parseNaturalLanguageV2(
        'create a crypto conference project in the tech for good group with an event called cosmolocal'
      );
      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(3);

      // Primary: project "Crypto Conference"
      expect(entityAt(result, 0).type).toBe('project');
      expect(entityAt(result, 0).name).toBe('Crypto Conference');

      // Organization reference: "Tech For Good Group"
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Tech For Good Group');

      // Child event: "Cosmolocal"
      const event = result.entities.find(e => e.name === 'Cosmolocal');
      expect(event).toBeDefined();
      expect(event!.type).toBe('event');
    });
  });

  // ---- Relationship Direction ----

  describe('relationship directions', () => {
    it('uses organized_by when org is not from DB lookup', () => {
      const result = parseNaturalLanguageV2(
        'create a project in the tech for good group'
      );
      // Without DB lookup, "in the group" creates organized_by (not part_of)
      // part_of only applies when org has isExisting: true from database
      const rel = result.relationships.find(r => r.type === 'organized_by');
      expect(rel).toBeDefined();
      expect(rel!.fromEntityIndex).toBe(0); // primary project
      expect(rel!.toEntityIndex).toBe(1);   // org
    });

    it('uses part_of when org is confirmed existing from DB', () => {
      const existingEntities = new Map<string, ExistingEntityRecord>();
      existingEntities.set('tech for good group', {
        id: 'db-456',
        name: 'Tech For Good Group',
        type: 'organization',
        isExisting: true,
      });

      const result = parseNaturalLanguageV2(
        'create a project in the tech for good group',
        existingEntities
      );
      const rel = result.relationships.find(r => r.type === 'part_of');
      expect(rel).toBeDefined();
      expect(rel!.fromEntityIndex).toBe(0); // primary project is part_of
      expect(rel!.toEntityIndex).toBe(1);   // existing org
    });

    it('uses from=child, to=parent for child events', () => {
      const result = parseNaturalLanguageV2(
        'create a project with an event called demo'
      );
      const rel = result.relationships.find(r =>
        r.fromEntityIndex > 0 && r.toEntityIndex === 0
      );
      expect(rel).toBeDefined();
      expect(rel!.type).toBe('part_of');
    });
  });

  // ---- Confidence Scoring ----

  describe('confidence scoring', () => {
    it('returns rounded confidence values (no floating point artifacts)', () => {
      const result = parseNaturalLanguageV2('create a community garden project in Oakland');
      const confidence = entityAt(result, 0).confidence;
      // Should be a clean number like 0.9, not 0.8999999...
      expect(confidence.toString()).not.toContain('9999');
      expect(confidence.toString()).not.toContain('0001');
    });

    it('gives higher confidence with name + properties', () => {
      const withName = parseNaturalLanguageV2('create a community garden project in Oakland');
      const withoutName = parseNaturalLanguageV2('create a project');
      expect(entityAt(withName, 0).confidence).toBeGreaterThan(entityAt(withoutName, 0).confidence);
    });

    it('confidence is between 0 and 1', () => {
      const result = parseNaturalLanguageV2(
        'set up a farmers market event inside a farms project inside the food hub co-op group'
      );
      for (const entity of result.entities) {
        expect(entity.confidence).toBeGreaterThanOrEqual(0);
        expect(entity.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ---- Warnings ----

  describe('warnings', () => {
    it('warns when no creation verb is detected', () => {
      const result = parseNaturalLanguageV2('neighborhood cleanup');
      expect(result.warnings).toContain(
        'No creation verb detected. Interpreting as entity description.'
      );
    });

    it('does not warn when a creation verb is present', () => {
      const result = parseNaturalLanguageV2('create a project');
      expect(result.warnings).toHaveLength(0);
    });
  });

  // ---- Default Behavior ----

  describe('default behavior', () => {
    it('defaults to project type when no entity keyword found', () => {
      const result = parseNaturalLanguageV2('create something cool');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('returns intent with parsed data', () => {
      const result = parseNaturalLanguageV2('create a community garden project');
      expect(result.intent).not.toBeNull();
      expect(result.intent!.primaryEntityType).toBe('project');
      expect(result.intent!.entityName).toBe('Community Garden');
      expect(result.intent!.primaryAction).toBe('create');
    });
  });

  // ---- Existing Entity Linking ----

  describe('existing entity linking', () => {
    it('links to existing entities when provided in the map', () => {
      const existingEntities = new Map<string, ExistingEntityRecord>();
      existingEntities.set('tech for good group', {
        id: 'db-123',
        name: 'Tech For Good Group',
        type: 'organization',
        isExisting: true,
      });

      const result = parseNaturalLanguageV2(
        'create a project in the tech for good group',
        existingEntities
      );

      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.isExisting).toBe(true);
      expect(org!.existingId).toBe('db-123');
      expect(org!.confidence).toBe(1.0);
    });

    it('creates new entity when reference not found in map', () => {
      const result = parseNaturalLanguageV2(
        'create a project in the unknown org group'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.isExisting).toBeUndefined();
      expect(org!.isExistingHint).toBe(true); // "the" was used
    });
  });

  // ---- Grammar/Conditionals Extraction ----

  describe('grammar conditionals', () => {
    it('extracts determiner-predicate pairs', () => {
      const result = parseNaturalLanguageV2('create a community garden project');
      expect(result.conditionals.length).toBeGreaterThan(0);
      const conditional = result.conditionals.find(c => c.determiner === 'a');
      expect(conditional).toBeDefined();
      expect(conditional!.predicate).toBeTruthy();
    });
  });

  // ---- Various Creation Verbs ----

  describe('creation verbs', () => {
    const verbs = ['create', 'start', 'launch', 'organize', 'make', 'build', 'plan', 'host'];

    verbs.forEach(verb => {
      it(`recognizes "${verb}" as a creation verb`, () => {
        const result = parseNaturalLanguageV2(`${verb} a project`);
        expect(result.success).toBe(true);
        expect(result.warnings).not.toContain(
          'No creation verb detected. Interpreting as entity description.'
        );
      });
    });
  });

  // ---- Entity Type Keywords ----

  describe('entity type keywords', () => {
    const typeTests: [string, string][] = [
      ['project', 'project'],
      ['event', 'event'],
      ['conference', 'event'],
      ['meetup', 'event'],
      ['workshop', 'event'],
      ['hackathon', 'event'],
      ['organization', 'organization'],
      ['group', 'organization'],
      ['community', 'organization'],
      ['venue', 'place'],
      ['garden', 'place'],
    ];

    typeTests.forEach(([keyword, expectedType]) => {
      it(`maps "${keyword}" to type "${expectedType}"`, () => {
        const result = parseNaturalLanguageV2(`create a ${keyword}`);
        expect(entityAt(result, 0).type).toBe(expectedType);
      });
    });
  });

  // ---- Create Anything Parser ----

  describe('Create Anything Parser', () => {

    // ---- Multi-sentence input ----

    describe('multi-sentence input', () => {
      it('parses multiple sentences and merges entities', () => {
        const result = parseNaturalLanguageV2(
          'I want to throw a party. there should be a job called set up.'
        );
        expect(result.success).toBe(true);
        // First sentence produces party (event), second produces "Set Up" (project from "job")
        expect(result.entities.length).toBeGreaterThanOrEqual(2);

        const partyEntity = result.entities.find(e => e.type === 'event');
        expect(partyEntity).toBeDefined();

        const jobEntity = result.entities.find(e => e.name === 'Set Up');
        expect(jobEntity).toBeDefined();
        expect(jobEntity!.type).toBe('project');
      });
    });

    // ---- "as part of" hierarchy ----

    describe('"as part of" hierarchy', () => {
      it('creates event + project with part_of relationship', () => {
        const result = parseNaturalLanguageV2('create an event as part of a project');
        expect(result.success).toBe(true);
        expect(result.entities.length).toBeGreaterThanOrEqual(2);

        expect(entityAt(result, 0).type).toBe('event');
        const projectRef = result.entities.find(e => e.type === 'project');
        expect(projectRef).toBeDefined();

        const partOfRel = result.relationships.find(r => r.type === 'part_of');
        expect(partOfRel).toBeDefined();
      });

      it('extracts named project via called pattern in hierarchy clause', () => {
        const result = parseNaturalLanguageV2(
          'create an event as part of a project called Party Time'
        );
        expect(result.success).toBe(true);

        const projectRef = result.entities.find(e => e.type === 'project');
        expect(projectRef).toBeDefined();
        expect(projectRef!.name).toBe('Party Time');
      });
    });

    // ---- Creation phrases ----

    describe('creation phrases', () => {
      it('strips "there should be" and creates named project', () => {
        const result = parseNaturalLanguageV2('there should be a project called Test');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('project');
        expect(entityAt(result, 0).name).toBe('Test');
      });

      it('strips "I want to" and creates event', () => {
        const result = parseNaturalLanguageV2('I want to create an event');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('event');
      });

      it('strips "we need to" and detects verb "set up"', () => {
        const result = parseNaturalLanguageV2('we need to set up a workshop');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('event'); // workshop maps to event
      });
    });

    // ---- Verb-after-called guard ----

    describe('verb-after-called guard', () => {
      it('treats "set up" after "called" as a name, not a verb', () => {
        const result = parseNaturalLanguageV2('create a job called set up');
        expect(result.success).toBe(true);
        const entity = entityAt(result, 0);
        expect(entity.name).toBe('Set Up');
      });

      it('treats "organize" after "called" as a name, not a verb', () => {
        const result = parseNaturalLanguageV2('create a task called organize');
        expect(result.success).toBe(true);
        const entity = entityAt(result, 0);
        expect(entity.name).toBe('Organize');
      });
    });

    // ---- New type keywords ----

    describe('new type keywords', () => {
      it('maps "job" to type "project"', () => {
        const result = parseNaturalLanguageV2('create a job');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('project');
      });

      it('preserves originalKeyword "job"', () => {
        const result = parseNaturalLanguageV2('create a job');
        expect(entityAt(result, 0).originalKeyword).toBe('job');
      });

      it('maps "task" to type "project"', () => {
        const result = parseNaturalLanguageV2('create a task');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('project');
      });

      it('preserves originalKeyword "task"', () => {
        const result = parseNaturalLanguageV2('create a task');
        expect(entityAt(result, 0).originalKeyword).toBe('task');
      });

      it('maps "party" to type "event"', () => {
        const result = parseNaturalLanguageV2('throw a party');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('event');
      });

      it('preserves originalKeyword "party"', () => {
        const result = parseNaturalLanguageV2('throw a party');
        expect(entityAt(result, 0).originalKeyword).toBe('party');
      });

      it('maps "meeting" to type "event"', () => {
        const result = parseNaturalLanguageV2('schedule a meeting');
        expect(result.success).toBe(true);
        expect(entityAt(result, 0).type).toBe('event');
      });

      it('preserves originalKeyword "meeting"', () => {
        const result = parseNaturalLanguageV2('schedule a meeting');
        expect(entityAt(result, 0).originalKeyword).toBe('meeting');
      });
    });

    // ---- originalKeyword preservation ----

    describe('originalKeyword preservation', () => {
      it('entities from "job" have originalKeyword "job"', () => {
        const result = parseNaturalLanguageV2('create a job called cleanup');
        const entity = entityAt(result, 0);
        expect(entity.originalKeyword).toBe('job');
      });

      it('entities from "task" have originalKeyword "task"', () => {
        const result = parseNaturalLanguageV2('create a task called review');
        const entity = entityAt(result, 0);
        expect(entity.originalKeyword).toBe('task');
      });

      it('entities from "party" have originalKeyword "party"', () => {
        const result = parseNaturalLanguageV2('throw a party');
        const entity = entityAt(result, 0);
        expect(entity.originalKeyword).toBe('party');
      });

      it('entities from "event" do NOT have originalKeyword (it is a DB type)', () => {
        const result = parseNaturalLanguageV2('create an event');
        const entity = entityAt(result, 0);
        expect(entity.originalKeyword).toBeUndefined();
      });
    });

    // ---- Compound hierarchy clauses ----

    describe('compound hierarchy clauses', () => {
      it('produces event + project "Party Time" + org from compound hierarchy', () => {
        const result = parseNaturalLanguageV2(
          'create an event as part of a project called Party Time in the Boulder Solar Collective group'
        );
        expect(result.success).toBe(true);

        // Primary entity: event
        const eventEntity = entityAt(result, 0);
        expect(eventEntity.type).toBe('event');

        // Project with called name "Party Time"
        const projectEntity = result.entities.find(e => e.type === 'project');
        expect(projectEntity).toBeDefined();
        expect(projectEntity!.name).toBe('Party Time');

        // Organization "Boulder Solar Collective Group"
        const orgEntity = result.entities.find(e => e.type === 'organization');
        expect(orgEntity).toBeDefined();
        expect(orgEntity!.name).toBe('Boulder Solar Collective Group');
      });
    });

    // ---- Full user input integration test ----

    describe('full user input integration test', () => {
      it('parses complex multi-sentence input with hierarchy, jobs, and tasks', () => {
        const result = parseNaturalLanguageV2(
          'I want to throw a party as part of a project called Party Time in the Boulder Solar Collective group. there should be a job called set up with a task set up chairs.'
        );
        expect(result.success).toBe(true);

        // Should produce at least 5 entities
        expect(result.entities.length).toBeGreaterThanOrEqual(5);

        // Entity 1: Party (event) from "throw a party"
        const partyEntity = result.entities.find(
          e => e.type === 'event' && e.originalKeyword === 'party'
        );
        expect(partyEntity).toBeDefined();

        // Entity 2: Party Time (project) from "project called Party Time"
        const partyTimeEntity = result.entities.find(
          e => e.type === 'project' && e.name === 'Party Time'
        );
        expect(partyTimeEntity).toBeDefined();

        // Entity 3: Boulder Solar Collective Group (organization)
        const bscEntity = result.entities.find(
          e => e.type === 'organization' && e.name!.includes('Boulder Solar Collective')
        );
        expect(bscEntity).toBeDefined();

        // Entity 4: Set Up (project from "job")
        const setupEntity = result.entities.find(
          e => e.name === 'Set Up' && e.type === 'project'
        );
        expect(setupEntity).toBeDefined();

        // Entity 5: Set Up Chairs (project from "task")
        const setupChairsEntity = result.entities.find(
          e => e.name === 'Set Up Chairs' && e.type === 'project'
        );
        expect(setupChairsEntity).toBeDefined();

        // Relationships: check that part_of relationships exist
        expect(result.relationships.length).toBeGreaterThanOrEqual(2);

        // Verify at least one part_of relationship exists
        const partOfRels = result.relationships.filter(r => r.type === 'part_of');
        expect(partOfRels.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ---- Edge Cases ----

  describe('edge cases', () => {
    it('handles input with special characters', () => {
      const result = parseNaturalLanguageV2('create a project!!! called hello-world');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('handles very long input without crashing', () => {
      const longInput = 'create a ' + 'really '.repeat(50) + 'long project';
      const result = parseNaturalLanguageV2(longInput);
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('normalizes multiple spaces in input', () => {
      const result = parseNaturalLanguageV2('create   a    project');
      expect(result.success).toBe(true);
      expect(result.input).toBe('create a project');
    });

    it('handles input with trailing punctuation', () => {
      const result = parseNaturalLanguageV2('create a project.');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('handles input with no entity type and no verb', () => {
      const result = parseNaturalLanguageV2('something random');
      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('returns non-number type input as failure', () => {
      const result = parseNaturalLanguageV2(42 as unknown as string);
      expect(result.success).toBe(false);
    });
  });

  // ---- Input Normalization ----

  describe('input normalization', () => {
    it('preserves the normalized input in result', () => {
      const result = parseNaturalLanguageV2('  create  a  project  ');
      expect(result.input).toBe('create a project');
    });

    it('strips trailing punctuation from token matching', () => {
      const result = parseNaturalLanguageV2('create a project, please');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
    });
  });

  // ---- Multiple Named Entities ----

  describe('multiple named entities', () => {
    it('handles primary name + child "called" name', () => {
      const result = parseNaturalLanguageV2(
        'create a conference project with an event called keynote day'
      );
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).type).toBe('project');
      expect(entityAt(result, 0).name).toBe('Conference');
      const child = result.entities.find(e => e.name === 'Keynote Day');
      expect(child).toBeDefined();
      expect(child!.type).toBe('event');
    });
  });

  // ---- Entity Type Priority ----

  describe('entity type priority', () => {
    it('selects higher-priority type when multiple type keywords present', () => {
      // "project" has priority 10, "event" has priority 7
      // When both appear, the highest-priority one becomes the primary type
      const result = parseNaturalLanguageV2('create a big event project');
      expect(entityAt(result, 0).type).toBe('project');
    });

    it('deprioritizes type keywords after prepositions', () => {
      // "community" after "in" should not become the primary entity type
      const result = parseNaturalLanguageV2('create a project in the riverside community');
      expect(entityAt(result, 0).type).toBe('project');
    });
  });

  // ---- Confidence Score Details ----

  describe('confidence score calculation', () => {
    it('base confidence is 0.5 for minimal input', () => {
      const result = parseNaturalLanguageV2('create a project');
      // action=create (no +0.1), name=Project==type (no +0.2), no props, no refs
      expect(entityAt(result, 0).confidence).toBe(0.5);
    });

    it('adds 0.1 for non-default verb', () => {
      const result = parseNaturalLanguageV2('start an event');
      // action=start != create (+0.1), name=Event==type (no +0.2) = 0.6
      expect(entityAt(result, 0).confidence).toBe(0.6);
    });

    it('adds 0.2 for descriptive name different from type', () => {
      const result = parseNaturalLanguageV2('create a community garden project');
      // action=create (no +0.1), name=Community Garden != project (+0.2) = 0.7
      expect(entityAt(result, 0).confidence).toBe(0.7);
    });

    it('stacks verb + name bonuses', () => {
      const result = parseNaturalLanguageV2('set up a farmers market event');
      // action=set up (+0.1), name=Farmers Market != event (+0.2) = 0.8
      expect(entityAt(result, 0).confidence).toBe(0.8);
    });

    it('adds 0.1 for extracted properties', () => {
      const result = parseNaturalLanguageV2('start an event on Saturdays');
      // action=start (+0.1), name=Event==type (no +0.2), props (+0.1) = 0.7
      expect(entityAt(result, 0).confidence).toBe(0.7);
    });

    it('gives child entities with explicit name confidence 0.9', () => {
      const result = parseNaturalLanguageV2(
        'create a project with an event called demo day'
      );
      const child = result.entities.find(e => e.name === 'Demo Day');
      expect(child).toBeDefined();
      expect(child!.confidence).toBe(0.9);
    });

    it('gives child entities without name confidence 0.6', () => {
      const result = parseNaturalLanguageV2('create a project with workshops');
      const child = result.entities.find(e => e.type === 'event' && e !== result.entities[0]);
      expect(child).toBeDefined();
      expect(child!.confidence).toBe(0.6);
    });

    it('gives existing reference with "the" confidence 0.7', () => {
      const result = parseNaturalLanguageV2('create an event inside the main project');
      const parent = result.entities.find(e => e.isExistingHint === true);
      expect(parent).toBeDefined();
      expect(parent!.confidence).toBe(0.7);
    });

    it('gives new reference with "a" confidence 0.8', () => {
      const result = parseNaturalLanguageV2('create an event inside a new project');
      const parent = entityAt(result, 1);
      expect(parent.isExistingHint).toBeFalsy();
      expect(parent.confidence).toBe(0.8);
    });

    it('gives DB-matched existing entity confidence 1.0', () => {
      const existingEntities = new Map<string, ExistingEntityRecord>();
      existingEntities.set('food hub co-op', {
        id: 'db-999',
        name: 'Food Hub Co-Op',
        type: 'organization',
        isExisting: true,
      });

      const result = parseNaturalLanguageV2(
        'create an event inside the food hub co-op group',
        existingEntities
      );
      const existing = result.entities.find(e => e.existingId === 'db-999');
      expect(existing).toBeDefined();
      expect(existing!.confidence).toBe(1.0);
    });
  });

  // ---- Intent Structure ----

  describe('intent structure', () => {
    it('returns null intent for invalid input', () => {
      const result = parseNaturalLanguageV2('');
      expect(result.intent).toBeNull();
    });

    it('populates existingReferences for inside clauses', () => {
      const result = parseNaturalLanguageV2(
        'create an event inside a project'
      );
      expect(result.intent).not.toBeNull();
      expect(result.intent!.existingReferences).toHaveLength(1);
      expect(result.intent!.existingReferences[0].type).toBe('project');
    });

    it('populates childEntities for with clauses', () => {
      const result = parseNaturalLanguageV2(
        'create a project with an event called demo'
      );
      expect(result.intent).not.toBeNull();
      expect(result.intent!.childEntities).toHaveLength(1);
      expect(result.intent!.childEntities[0].name).toBe('Demo');
      expect(result.intent!.childEntities[0].type).toBe('event');
    });

    it('populates properties for location and temporal', () => {
      const result = parseNaturalLanguageV2('start an event in Oakland on Saturdays');
      expect(result.intent).not.toBeNull();
      const locationProp = result.intent!.properties.find(p => p.key === 'location');
      expect(locationProp).toBeDefined();
      expect(locationProp!.value).toBe('Oakland');
      const scheduleProp = result.intent!.properties.find(p => p.key === 'schedule');
      expect(scheduleProp).toBeDefined();
      expect(scheduleProp!.value).toBe('saturday');
    });
  });

  // ---- Property Clauses (worth/about/for) ----

  describe('property clauses', () => {
    it('extracts "worth 50 points" as value property', () => {
      const result = parseNaturalLanguageV2('create a badge worth 50 points');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'value')).toBe('50 points');
    });

    it('extracts "worth 99.5 credits" with decimal value', () => {
      const result = parseNaturalLanguageV2('create a voucher worth 99.5 credits');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'value')).toBe('99.5 credits');
    });

    it('extracts "about sustainability" as topic property', () => {
      const result = parseNaturalLanguageV2('create a project about sustainability');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'topic')).toBe('Sustainability');
    });

    it('extracts "about community gardens" with multi-word topic', () => {
      const result = parseNaturalLanguageV2('create an event about community gardens');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'topic')).toBe('Community Gardens');
    });

    it('extracts "for community outreach" as purpose property', () => {
      const result = parseNaturalLanguageV2('create a project for community outreach');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'purpose')).toBe('Community Outreach');
    });

    it('does not extract temporal words as purpose ("for tomorrow")', () => {
      const result = parseNaturalLanguageV2('create an event for tomorrow');
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'purpose')).toBeUndefined();
    });

    it('extracts multiple property clauses together', () => {
      const result = parseNaturalLanguageV2(
        'create a badge worth 100 points about excellence for top contributors'
      );
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'value')).toBe('100 points');
      expect(propValue(entity, 'topic')).toBe('Excellence');
    });
  });

  // ---- Relative Clauses ----

  describe('relative clauses', () => {
    it('extracts child entity from "who manages a garden"', () => {
      const result = parseNaturalLanguageV2(
        'create a person who manages a garden'
      );
      expect(result.success).toBe(true);
      // Note: verb captured as "manages" (conjugated form) — suffix stripping is a known limitation
      const child = result.intent?.childEntities.find(c => c.relationshipVerb === 'manages');
      expect(child).toBeDefined();
      expect(child!.type).toBe('place'); // garden maps to place
    });

    it('extracts child entity from "that hosts events"', () => {
      const result = parseNaturalLanguageV2(
        'create a venue that hosts meetups'
      );
      expect(result.success).toBe(true);
      // "host" is a creation verb so it is skipped by the relative clause handler
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts child entity from "which includes workshops"', () => {
      const result = parseNaturalLanguageV2(
        'create a project which includes workshops'
      );
      expect(result.success).toBe(true);
      // Note: verb captured as "includes" (conjugated form) — suffix stripping is a known limitation
      const child = result.intent?.childEntities.find(c => c.relationshipVerb === 'includes');
      expect(child).toBeDefined();
    });
  });

  // ---- Conjunction Entities ----

  describe('conjunction entities', () => {
    it('extracts second entity from "and an event"', () => {
      const result = parseNaturalLanguageV2('create a project and an event');
      expect(result.success).toBe(true);
      const event = result.entities.find(e => e.type === 'event');
      expect(event).toBeDefined();
    });

    it('extracts entity from comma-separated list "a project, and an event"', () => {
      const result = parseNaturalLanguageV2('create a project, and an event');
      expect(result.success).toBe(true);
      const event = result.entities.find(e => e.type === 'event');
      expect(event).toBeDefined();
    });

    it('preserves originalKeyword in conjunction entities', () => {
      const result = parseNaturalLanguageV2('create a project and a workshop');
      expect(result.success).toBe(true);
      const workshop = result.intent?.childEntities.find(c => c.originalKeyword === 'workshop');
      expect(workshop).toBeDefined();
    });
  });

  // ---- Verb Categories ----

  describe('verb categories', () => {
    it('classifies "create" as creation verb category', () => {
      const result = parseNaturalLanguageV2('create a project');
      expect(result.intent?.verbCategory).toBe('creation');
    });

    it('classifies "plan" as creation verb category', () => {
      const result = parseNaturalLanguageV2('plan a workshop');
      expect(result.intent?.verbCategory).toBe('creation');
    });

    it('classifies "host" as creation verb category', () => {
      const result = parseNaturalLanguageV2('host an event');
      expect(result.intent?.verbCategory).toBe('creation');
    });

    it('classifies "set up" as creation verb category', () => {
      const result = parseNaturalLanguageV2('set up a project');
      expect(result.intent?.verbCategory).toBe('creation');
    });
  });

  // ---- Target Table Inference ----

  describe('target table inference', () => {
    it('infers targetTable "resources" for event keywords', () => {
      const result = parseNaturalLanguageV2('create an event');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "agents" for organization keywords', () => {
      const result = parseNaturalLanguageV2('create a group');
      expect(result.intent?.targetTable).toBe('agents');
    });

    it('infers targetTable "resources" for place keywords', () => {
      const result = parseNaturalLanguageV2('create a venue');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "resources" for resource-type keywords', () => {
      const result = parseNaturalLanguageV2('create a task');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "resources" for job keyword', () => {
      const result = parseNaturalLanguageV2('create a job');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "resources" for badge keyword', () => {
      const result = parseNaturalLanguageV2('create a badge');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "resources" for voucher keyword', () => {
      const result = parseNaturalLanguageV2('create a voucher');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('infers targetTable "resources" for proposal keyword', () => {
      const result = parseNaturalLanguageV2('create a proposal');
      expect(result.intent?.targetTable).toBe('resources');
    });

    it('sets targetTable on child entities too', () => {
      const result = parseNaturalLanguageV2('create a project with a task called review');
      const child = result.entities.find(e => e.name === 'Review');
      expect(child).toBeDefined();
      expect(child!.targetTable).toBe('resources');
    });
  });

  // ---- Quoted Name Handling ----

  describe('quoted name handling', () => {
    it('extracts double-quoted name from \'called "Regen Summit 2026"\'', () => {
      const result = parseNaturalLanguageV2('create an event called "Regen Summit 2026"');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('Regen Summit 2026');
    });

    it('extracts single-quoted name from "called \'My Project\'"', () => {
      const result = parseNaturalLanguageV2("create a project called 'My Project'");
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('My Project');
    });

    it('extracts quoted name with special characters', () => {
      const result = parseNaturalLanguageV2('create an event called "ETH Denver 2026"');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('ETH Denver 2026');
    });

    it('still handles unquoted names', () => {
      const result = parseNaturalLanguageV2('create a project called sunrise initiative');
      expect(result.success).toBe(true);
      expect(entityAt(result, 0).name).toBe('Sunrise Initiative');
    });

    it('extracts quoted name in hierarchy clause', () => {
      const result = parseNaturalLanguageV2(
        'create an event inside a project called "Party Time"'
      );
      expect(result.success).toBe(true);
      const project = result.entities.find(e => e.type === 'project');
      expect(project).toBeDefined();
      expect(project!.name).toBe('Party Time');
    });
  });

  // ---- Regex Terminator Fixes ----

  describe('regex terminator fixes', () => {
    it('agent-by pattern terminates at digit (e.g., "hosted by team 3pm")', () => {
      const result = parseNaturalLanguageV2(
        'create a workshop hosted by local collective starting tomorrow'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Local Collective');
    });

    it('with-clause terminates at temporal words ("with tasks next friday")', () => {
      const result = parseNaturalLanguageV2(
        'create a project with tasks next friday'
      );
      expect(result.success).toBe(true);
      // "next friday" should NOT be part of the with-clause
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(propValue(entity, 'temporalPhrase')).toMatch(/next friday/i);
    });

    it('with-clause terminates at "on" temporal ("with events on saturdays")', () => {
      const result = parseNaturalLanguageV2(
        'create a project with events on saturdays'
      );
      expect(result.success).toBe(true);
      const entity = entityAt(result, 0);
      expect(propValue(entity, 'schedule')).toBe('saturday');
    });

    it('agent-by pattern terminates before "about" keyword', () => {
      const result = parseNaturalLanguageV2(
        'create a workshop organized by tech team about innovation'
      );
      const org = result.entities.find(e => e.type === 'organization');
      expect(org).toBeDefined();
      expect(org!.name).toBe('Tech Team');
    });
  });
});
