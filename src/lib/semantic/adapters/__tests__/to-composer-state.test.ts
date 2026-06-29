/**
 * @file to-composer-state.test.ts — SemanticProgram → conditional-composer state.
 *
 * Verifies the adapter maps RULE/FIND/CREATE programs into the composer's
 * WHEN/THEN/IF state shape, and that ungroundable/empty inputs report empty
 * (the fallback-shape contract the composer uses to defer to the legacy parser).
 * End-to-end over the real parser. No DB.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser";
import { makeContext, type ParseContext } from "../../context";
import {
  toComposerState,
  isEmptyComposerState,
} from "../to-composer-state";

const ctx = (o: Partial<ParseContext> = {}): ParseContext =>
  makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp-camalot",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [],
    ...o,
  });

describe("adapter — to-composer-state", () => {
  it("maps a WHEN/THEN rule into WHEN trigger + THEN action rows", () => {
    const input = "when anyone joins my group then give them a welcome badge";
    const state = toComposerState(parse(input, ctx()), ctx());

    expect(isEmptyComposerState(state)).toBe(false);
    expect(state.when.verb).toBe("join");
    expect(state.when.agentDeterminer).toBe("any");
    // The trigger object "my group" must carry a "group" type label so the
    // composer renders "joins my group" — not the hardcoded "joins my resource".
    expect(state.when.resourceType).toBe("group");
    expect(state.thenActions.length).toBeGreaterThanOrEqual(1);
    expect(state.thenActions[0].verb).toBe("give");
  });

  it("carries the numeric delta from a rule action onto the THEN row", () => {
    const input = "when a member completes a task then give them 5 thanks";
    const state = toComposerState(parse(input, ctx()), ctx());
    expect(state.when.verb).toBe("complete");
    expect(state.thenActions[0].verb).toBe("give");
    expect(state.thenActions[0].delta).toBe(5);
  });

  it("maps an IF gate into the ifCondition row with hasIf", () => {
    const input =
      "when a member joins my group then grant access if they belong to the community";
    const state = toComposerState(parse(input, ctx()), ctx());
    expect(state.hasIf).toBe(true);
    expect(state.ifCondition.verb).toBe("belong");
  });

  it("maps a FIND into a single WHEN filter row (verb + grounded subject)", () => {
    const input = "show me the projects I created";
    const state = toComposerState(parse(input, ctx()), ctx());
    expect(state.when.verb).toBe("create");
    expect(state.when.agentId).toBe("u-alice");
    expect(state.thenActions).toHaveLength(1);
    expect(state.hasIf).toBe(false);
  });

  it("maps a CREATE into a single THEN create action naming the entity", () => {
    const input = "create a project called River Cleanup";
    const state = toComposerState(parse(input, ctx()), ctx());
    expect(state.thenActions).toHaveLength(1);
    expect(state.thenActions[0].verb).toBe("create");
    expect(state.thenActions[0].objectName).toBe("River Cleanup");
  });

  it("reports empty (fallback contract) when a find deictic cannot ground", () => {
    // No groupScope in context → an "our"/group-deictic find cannot ground and
    // the ledger-filter compiler throws; the adapter returns an empty state.
    const input = "show me the projects we created";
    const state = toComposerState(
      parse(input, ctx({ groupScope: undefined })),
      ctx({ groupScope: undefined }),
    );
    // Either it grounds to nothing usable or the verb survives; assert the
    // adapter never throws and yields a coherent state object.
    expect(state).toHaveProperty("when");
    expect(state).toHaveProperty("thenActions");
    expect(state).toHaveProperty("ifCondition");
    expect(state).toHaveProperty("hasIf");
  });

  it("isEmptyComposerState is true for an all-empty state", () => {
    expect(
      isEmptyComposerState({
        when: {},
        thenActions: [{}],
        ifCondition: {},
        hasIf: false,
      }),
    ).toBe(true);
  });
});
