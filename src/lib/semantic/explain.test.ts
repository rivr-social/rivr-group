/**
 * @file explain.test.ts — human-readable rendering of interpretations.
 */

import { describe, it, expect } from "vitest";
import { parse } from "./parser";
import { makeContext } from "./context";
import { topInterpretation } from "./ast";
import { explainStatement, explainInterpretation } from "./explain";

const ctx = () =>
  makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [],
  });

describe("explain", () => {
  it("renders a create statement", () => {
    const top = topInterpretation(parse("create a project called River Cleanup", ctx()))!;
    const text = explainStatement(top.statement);
    expect(text).toContain("Create");
    expect(text).toContain("River Cleanup");
  });

  it("flags a backend-only create as not allowed", () => {
    const top = topInterpretation(parse("create a basin called South Platte", ctx()))!;
    const text = explainStatement(top.statement);
    expect(text).toContain("NOT ALLOWED");
    expect(text).toContain("backend-only");
  });

  it("renders a find statement with filters", () => {
    const top = topInterpretation(parse("show me the projects I created", ctx()))!;
    const text = explainStatement(top.statement);
    expect(text).toContain("Find");
    expect(text).toContain("you");
  });

  it("renders a rule with when/then", () => {
    const top = topInterpretation(
      parse("when anyone joins my group then give them a welcome badge", ctx()),
    )!;
    const text = explainStatement(top.statement);
    expect(text).toContain("When");
    expect(text).toContain("then");
  });

  it("includes a confidence percentage on interpretations", () => {
    const top = topInterpretation(parse("create a project called X", ctx()))!;
    const text = explainInterpretation(top);
    expect(text).toMatch(/\d+% confident/);
  });
});
