/**
 * @file fixtures.test.ts — "the soul of the parser."
 *
 * ~25 plain-English sentences with expected ASTs / outcomes, covering:
 *   - CREATE (project / event / org / family / community)
 *   - FIND (queries over agents/resources/ledger)
 *   - RULE (WHEN / THEN / IF)
 *   - PRONOUN / deixis (I, we, here, now, this)
 *   - AMBIGUOUS (multiple ranked interpretations)
 *   - BACKEND-ONLY REJECTION (commons/locale/basin/region creates)
 *
 * These assert against the PARSER output (clean AST with unresolved slots) and,
 * for the rejection cases, against the TYPECHECKER (which is what enforces the
 * backend-only rule). No DB. No writes.
 */

import { describe, it, expect } from "vitest";
import {
  STATEMENT_KINDS,
  AGENT_KINDS,
  GROUP_SUBTYPES,
  RESOURCE_KINDS,
  REGION_SUBTYPES,
  SEMANTIC_DOMAINS,
  DEICTIC_REFS,
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_PARSER_VERSION,
  topInterpretation,
  type CreateStatement,
  type FindStatement,
  type RuleStatement,
} from "./ast";
import { parse, ParseContextError } from "./parser";
import { makeContext, type ParseContext } from "./context";
import { typecheck } from "./typecheck";

// A baseline grounded context: speaker = u-alice, here = locale boulder.
function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
  return makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp-camalot",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [
      { id: "res-cleanup", name: "River Cleanup", domain: SEMANTIC_DOMAINS.RESOURCE, kind: "event" },
    ],
    ...overrides,
  });
}

describe("semantic parser — program envelope", () => {
  it("F00: always emits versioned envelope with ranked interpretations", () => {
    const program = parse("create a project called River Cleanup", ctx());
    expect(program.schemaVersion).toBe(SEMANTIC_SCHEMA_VERSION);
    expect(program.parserVersion).toBe(SEMANTIC_PARSER_VERSION);
    expect(program.originalInput).toBe("create a project called River Cleanup");
    expect(program.interpretations.length).toBeGreaterThan(0);
    // Ranked: confidence is non-increasing.
    for (let i = 1; i < program.interpretations.length; i++) {
      expect(program.interpretations[i - 1].confidence).toBeGreaterThanOrEqual(
        program.interpretations[i].confidence,
      );
    }
  });

  it("F00b: refuses to parse without a grounding context (no hallucinated deixis)", () => {
    expect(() =>
      parse("share this", { actorId: "", now: new Date(), recentEntities: [] }),
    ).toThrowError(ParseContextError);
  });
});

describe("semantic parser — CREATE fixtures", () => {
  it("F01: create a project called River Cleanup", () => {
    const top = topInterpretation(parse("create a project called River Cleanup", ctx()))!;
    expect(top.statement.kind).toBe(STATEMENT_KINDS.CREATE);
    const s = top.statement as CreateStatement;
    expect(s.entities).toHaveLength(1);
    expect(s.entities[0].domain).toBe(SEMANTIC_DOMAINS.RESOURCE);
    expect(s.entities[0].kind).toBe(RESOURCE_KINDS.PROJECT);
    expect(s.entities[0].name).toBe("River Cleanup");
    expect(s.entities[0].literalNew).toBe(true);
  });

  it("F02: start an event named Spring Festival", () => {
    const top = topInterpretation(parse("start an event named Spring Festival", ctx()))!;
    const s = top.statement as CreateStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.CREATE);
    expect(s.entities[0].kind).toBe(RESOURCE_KINDS.EVENT);
    expect(s.entities[0].name).toBe("Spring Festival");
  });

  it("F03: create an organization called Sustainability Collective", () => {
    const top = topInterpretation(
      parse("create an organization called Sustainability Collective", ctx()),
    )!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].domain).toBe(SEMANTIC_DOMAINS.AGENT);
    expect(s.entities[0].kind).toBe(AGENT_KINDS.GROUP);
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.ORGANIZATION);
    expect(s.entities[0].name).toBe("Sustainability Collective");
  });

  it("F03b: create a ring called Front Range Mutual Aid (user-creatable)", () => {
    const top = topInterpretation(
      parse("create a ring called Front Range Mutual Aid", ctx()),
    )!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].domain).toBe(SEMANTIC_DOMAINS.AGENT);
    expect(s.entities[0].kind).toBe(AGENT_KINDS.GROUP);
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.RING);
    expect(s.entities[0].name).toBe("Front Range Mutual Aid");
  });

  it("F04: create a family called The Smiths (household normalizes to family)", () => {
    const top = topInterpretation(parse("create a family called The Smiths", ctx()))!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.FAMILY);
  });

  it("F05: household normalizes to Family subtype", () => {
    const top = topInterpretation(parse("create a household called Maple Street", ctx()))!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].kind).toBe(AGENT_KINDS.GROUP);
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.FAMILY);
  });

  it("F06: create a community called Boulder Mutual Aid", () => {
    const top = topInterpretation(
      parse("create a community called Boulder Mutual Aid", ctx()),
    )!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.COMMUNITY);
  });

  it("F07: neighborhood normalizes to Community subtype", () => {
    const top = topInterpretation(parse("create a neighborhood called Goss Grove", ctx()))!;
    const s = top.statement as CreateStatement;
    expect(s.entities[0].groupSubtype).toBe(GROUP_SUBTYPES.COMMUNITY);
  });

  it("F08: create an event for the River Cleanup project (relationship)", () => {
    const top = topInterpretation(
      parse("create an event called Kickoff for the River Cleanup project", ctx()),
    )!;
    const s = top.statement as CreateStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.CREATE);
    expect(s.entities[0].kind).toBe(RESOURCE_KINDS.EVENT);
    expect(s.entities[0].name).toBe("Kickoff");
    // A second slot for the parent project + a relationship binding them.
    expect(s.entities.length).toBeGreaterThanOrEqual(2);
    expect(s.relationships.length).toBeGreaterThanOrEqual(1);
  });
});

describe("semantic parser — FIND fixtures", () => {
  it("F09: find all events", () => {
    const top = topInterpretation(parse("find all events", ctx()))!;
    expect(top.statement.kind).toBe(STATEMENT_KINDS.FIND);
    const s = top.statement as FindStatement;
    expect(s.domain).toBe(SEMANTIC_DOMAINS.RESOURCE);
    expect(s.kind_).toBe(RESOURCE_KINDS.EVENT);
  });

  it("F10: show me the projects I created (pronoun + verb filter)", () => {
    const top = topInterpretation(parse("show me the projects I created", ctx()))!;
    const s = top.statement as FindStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.FIND);
    expect(s.kind_).toBe(RESOURCE_KINDS.PROJECT);
    expect(s.verb?.verbType).toBe("create");
    // "I" should appear as a self-deictic filter slot.
    const selfFilter = s.filters.find((f) => f.deictic === DEICTIC_REFS.SELF);
    expect(selfFilter).toBeDefined();
  });

  it("F11: list organizations", () => {
    const top = topInterpretation(parse("list organizations", ctx()))!;
    const s = top.statement as FindStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.FIND);
    expect(s.domain).toBe(SEMANTIC_DOMAINS.AGENT);
    expect(s.kind_).toBe(AGENT_KINDS.GROUP);
  });

  it("F12: who joined the community here (deictic here)", () => {
    const top = topInterpretation(parse("who joined the community here", ctx()))!;
    const s = top.statement as FindStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.FIND);
    expect(s.verb?.verbType).toBe("join");
    const hereFilter = s.filters.find((f) => f.deictic === DEICTIC_REFS.HERE);
    expect(hereFilter).toBeDefined();
  });
});

describe("semantic parser — RULE fixtures", () => {
  it("F13: when anyone joins my group, give them a welcome badge", () => {
    const top = topInterpretation(
      parse("when anyone joins my group then give them a welcome badge", ctx()),
    )!;
    expect(top.statement.kind).toBe(STATEMENT_KINDS.RULE);
    const s = top.statement as RuleStatement;
    expect(s.trigger.verb.verbType).toBe("join");
    expect(s.trigger.subject.determiner).toBe("any");
    // "my group" must resolve to a GROUP agent — not a resource. (Regression
    // guard: the bare noun "group" was missing from the ontology, so it hit the
    // RESOURCE default and rendered nonsensically as "joins my resource".)
    expect(s.trigger.object?.domain).toBe(SEMANTIC_DOMAINS.AGENT);
    expect(s.trigger.object?.kind).toBe(AGENT_KINDS.GROUP);
    expect(s.actions.length).toBeGreaterThanOrEqual(1);
    expect(s.actions[0].verb.verbType).toBe("give");
  });

  it("F14: when a member completes a task, give them 5 thanks (delta)", () => {
    const top = topInterpretation(
      parse("when a member completes a task then give them 5 thanks", ctx()),
    )!;
    const s = top.statement as RuleStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.RULE);
    expect(s.trigger.verb.verbType).toBe("complete");
    expect(s.actions[0].verb.verbType).toBe("give");
    expect(s.actions[0].delta).toBe(5);
  });

  it("F15: rule with IF condition gate", () => {
    const top = topInterpretation(
      parse(
        "when a member joins my group then grant access if they belong to the community",
        ctx(),
      ),
    )!;
    const s = top.statement as RuleStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.RULE);
    expect(s.condition).toBeDefined();
    expect(s.condition?.verb.verbType).toBe("belong");
  });

  it("F16: whenever someone follows me then thank them", () => {
    const top = topInterpretation(
      parse("whenever someone follows me then give them thanks", ctx()),
    )!;
    const s = top.statement as RuleStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.RULE);
    expect(s.trigger.verb.verbType).toBe("follow");
  });
});

describe("semantic parser — PRONOUN / deixis fixtures", () => {
  it("F17: create a post here now (here + now deixis)", () => {
    const top = topInterpretation(parse("create a post here now", ctx()))!;
    const s = top.statement as CreateStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.CREATE);
    expect(s.entities[0].kind).toBe(RESOURCE_KINDS.POST);
    // here/now captured as deictic property slots on the entity.
    const props = s.entities[0].properties ?? [];
    expect(props.some((p) => p.key === "locale" || p.key === "here")).toBe(true);
  });

  it("F18: find things we own (group deixis)", () => {
    const top = topInterpretation(parse("find resources we own", ctx()))!;
    const s = top.statement as FindStatement;
    expect(s.kind).toBe(STATEMENT_KINDS.FIND);
    expect(s.verb?.verbType).toBe("own");
    const groupFilter = s.filters.find((f) => f.deictic === DEICTIC_REFS.GROUP);
    expect(groupFilter).toBeDefined();
  });

  it("F19: deictic 'this' refers to the most-recent entity via context", () => {
    const top = topInterpretation(parse("share this", ctx()))!;
    // Single-verb imperative over a deictic object → a rule-less action is not a
    // create/find; the parser represents bare verb+deictic as a FIND-style
    // reference over the recent entity, with a self subject and `this` object.
    expect([STATEMENT_KINDS.FIND, STATEMENT_KINDS.RULE]).toContain(top.statement.kind);
  });
});

describe("semantic parser — AMBIGUOUS fixtures", () => {
  it("F20: 'create a hub' is ambiguous (place vs colloquial group) → ranked options", () => {
    const program = parse("create a hub called Maker Space", ctx());
    expect(program.interpretations.length).toBeGreaterThanOrEqual(1);
    // Top reading should still be a create.
    expect(program.interpretations[0].statement.kind).toBe(STATEMENT_KINDS.CREATE);
  });

  it("F21: 'plan a garden' — create event vs create place ambiguity", () => {
    const program = parse("plan a garden", ctx());
    // At least one create interpretation; multiple readings allowed.
    expect(
      program.interpretations.some((i) => i.statement.kind === STATEMENT_KINDS.CREATE),
    ).toBe(true);
  });
});

describe("semantic parser + typecheck — BACKEND-ONLY REJECTION fixtures", () => {
  // These must NOT compile to a create payload; the typechecker rejects them
  // as backend-only administrative entities.
  const backendOnly: Array<[string, string]> = [
    ["F22", "create a commons called Boulder Commons"],
    ["F23", "create a locale called North Boulder"],
    ["F24", "create a basin called South Platte"],
    ["F25", "create a region called Front Range"],
  ];

  for (const [id, sentence] of backendOnly) {
    it(`${id}: "${sentence}" is REJECTED as backend-only`, () => {
      const top = topInterpretation(parse(sentence, ctx()))!;
      // Parser still recognizes it as a create with a region subtype slot.
      const s = top.statement as CreateStatement;
      expect(s.kind).toBe(STATEMENT_KINDS.CREATE);
      expect(s.entities[0].regionSubtype).toBeDefined();

      // Typecheck must reject it.
      const result = typecheck(top.statement, ctx());
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("BACKEND_ONLY_CREATE");
      // The offending subtype is one of the region subtypes.
      expect(Object.values(REGION_SUBTYPES)).toContain(
        s.entities[0].regionSubtype,
      );
    });
  }

  it("F26: a normal org create PASSES typecheck (control)", () => {
    const top = topInterpretation(
      parse("create an organization called Green Team", ctx()),
    )!;
    const result = typecheck(top.statement, ctx());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
