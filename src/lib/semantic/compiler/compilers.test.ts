/**
 * @file compilers.test.ts — AST → existing payload contracts.
 *
 * Verifies the three compilers produce the shapes the existing server actions
 * accept, parsing real sentences end-to-end (parse → typecheck → compile). No DB.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { makeContext, type ParseContext } from "../context";
import {
  topInterpretation,
  type CreateStatement,
  type FindStatement,
  type RuleStatement,
} from "../ast";
import {
  compileToCreatePayload,
  CreatePayloadCompileError,
  CREATE_COMPILE_ERROR_CODES,
} from "./to-create-payload";
import { compileToLedgerFilter } from "./to-ledger-filter";
import { compileToContractRule } from "./to-contract-rule";

const ctx = (o: Partial<ParseContext> = {}): ParseContext =>
  makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp-camalot",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [],
    ...o,
  });

describe("compiler — to-create-payload", () => {
  it("compiles a project create to CreateEntitiesPayload", () => {
    const input = "create a project called River Cleanup";
    const top = topInterpretation(parse(input, ctx()))!;
    const payload = compileToCreatePayload(top.statement as CreateStatement, input, "loc-boulder");
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0].type).toBe("project");
    expect(payload.entities[0].name).toBe("River Cleanup");
    expect(payload.localeId).toBe("loc-boulder");
    expect(payload.originalInput).toBe(input);
  });

  it("clamps a group subtype (community) to organization create type", () => {
    const input = "create a community called Boulder Mutual Aid";
    const top = topInterpretation(parse(input, ctx()))!;
    const payload = compileToCreatePayload(top.statement as CreateStatement, input);
    expect(payload.entities[0].type).toBe("organization");
  });

  it("emits the parent link + relationship for 'event for the X project'", () => {
    const input = "create an event called Kickoff for the River Cleanup project";
    const top = topInterpretation(parse(input, ctx()))!;
    const payload = compileToCreatePayload(top.statement as CreateStatement, input);
    expect(payload.entities.length).toBeGreaterThanOrEqual(2);
    expect(payload.relationships.length).toBeGreaterThanOrEqual(1);
    // The linked parent is marked existing.
    expect(payload.entities.some((e) => e.isExisting)).toBe(true);
  });

  it("throws BACKEND_ONLY when a region subtype slips through to the compiler", () => {
    const input = "create a basin called South Platte";
    const top = topInterpretation(parse(input, ctx()))!;
    expect(() =>
      compileToCreatePayload(top.statement as CreateStatement, input),
    ).toThrowError(CreatePayloadCompileError);
    try {
      compileToCreatePayload(top.statement as CreateStatement, input);
    } catch (e) {
      expect((e as CreatePayloadCompileError).code).toBe(
        CREATE_COMPILE_ERROR_CODES.BACKEND_ONLY,
      );
    }
  });
});

describe("compiler — to-ledger-filter", () => {
  it("compiles 'find all events' to a resource filter narrowed by type", () => {
    const input = "find all events";
    const top = topInterpretation(parse(input, ctx()))!;
    const filter = compileToLedgerFilter(top.statement as FindStatement, ctx(), input);
    expect(filter.domain).toBe("resource");
    expect(filter.dbType).toBe("event");
  });

  it("grounds 'projects I created' to a ledger filter with verb + subjectId", () => {
    const input = "show me the projects I created";
    const top = topInterpretation(parse(input, ctx()))!;
    const filter = compileToLedgerFilter(top.statement as FindStatement, ctx(), input);
    expect(filter.domain).toBe("ledger");
    expect(filter.verb).toBe("create");
    expect(filter.subjectId).toBe("u-alice");
    expect(filter.dbType).toBe("project");
  });

  it("grounds 'here' to localeId", () => {
    const input = "who joined the community here";
    const top = topInterpretation(parse(input, ctx()))!;
    const filter = compileToLedgerFilter(top.statement as FindStatement, ctx(), input);
    expect(filter.localeId).toBe("loc-boulder");
    expect(filter.verb).toBe("join");
  });
});

describe("compiler — to-contract-rule", () => {
  it("compiles a WHEN/THEN rule into CreateContractRuleInput with determiners", () => {
    const input = "when anyone joins my group then give them a welcome badge";
    const top = topInterpretation(parse(input, ctx()))!;
    const rule = compileToContractRule(top.statement as RuleStatement, {
      name: "Welcome badge",
    });
    expect(rule.name).toBe("Welcome badge");
    expect(rule.triggerVerb).toBe("join");
    expect(rule.triggerSubjectDeterminer).toBe("any");
    expect(rule.triggerSubjectId).toBeNull();
    expect(rule.actions.length).toBeGreaterThanOrEqual(1);
    expect(rule.actions[0].verb).toBe("give");
  });

  it("carries the numeric delta into the action", () => {
    const input = "when a member completes a task then give them 5 thanks";
    const top = topInterpretation(parse(input, ctx()))!;
    const rule = compileToContractRule(top.statement as RuleStatement, { name: "Thanks" });
    expect(rule.triggerVerb).toBe("complete");
    expect(rule.actions[0].delta).toBe(5);
  });

  it("emits a condition block for an IF gate", () => {
    const input =
      "when a member joins my group then grant access if they belong to the community";
    const top = topInterpretation(parse(input, ctx()))!;
    const rule = compileToContractRule(top.statement as RuleStatement, { name: "Gate" });
    expect(rule.conditionVerb).toBe("belong");
  });

  it("maps a self-deictic subject to determiner 'my' with grounded id", () => {
    const input = "whenever someone follows me then give them thanks";
    const top = topInterpretation(parse(input, ctx()))!;
    const ids = new Map<string, string>([["me", "u-alice"]]);
    const rule = compileToContractRule(top.statement as RuleStatement, {
      name: "Follow thanks",
      ids,
    });
    expect(rule.triggerVerb).toBe("follow");
    // The trigger object "me" lowers to determiner "my" + the grounded id.
    expect(rule.triggerObjectDeterminer).toBe("my");
    expect(rule.triggerObjectId).toBe("u-alice");
  });
});
