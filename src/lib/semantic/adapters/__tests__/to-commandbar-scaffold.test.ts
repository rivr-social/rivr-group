/**
 * @file to-commandbar-scaffold.test.ts — SemanticProgram → CommandBar scaffold.
 *
 * Verifies the adapter maps a CREATE program into the V2ParseResult-compatible
 * scaffold shape the EntityScaffoldPreview consumes, and returns a
 * `success: false` scaffold (the fallback-shape contract) for FIND/RULE inputs
 * and for un-creatable inputs. End-to-end over the real parser. No DB.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser";
import { makeContext, type ParseContext } from "../../context";
import {
  toCommandBarScaffold,
  COMMANDBAR_SCAFFOLD_WARNINGS,
} from "../to-commandbar-scaffold";

const ctx = (o: Partial<ParseContext> = {}): ParseContext =>
  makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp-camalot",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [],
    ...o,
  });

describe("adapter — to-commandbar-scaffold", () => {
  it("maps a project create into a successful scaffold with one entity", () => {
    const input = "create a project called River Cleanup";
    const scaffold = toCommandBarScaffold(parse(input, ctx()), "loc-boulder");

    expect(scaffold.success).toBe(true);
    expect(scaffold.input).toBe(input);
    expect(scaffold.entities).toHaveLength(1);
    expect(scaffold.entities[0].type).toBe("project");
    expect(scaffold.entities[0].name).toBe("River Cleanup");
    expect(scaffold.entities[0].tempId).toBe("e0");
    expect(scaffold.entities[0].confidence).toBeGreaterThan(0);
    expect(scaffold.intent).toBeNull();
  });

  it("emits a relationship with index pairs for nested creates", () => {
    const input = "create an event called Kickoff for the River Cleanup project";
    const scaffold = toCommandBarScaffold(parse(input, ctx()));

    expect(scaffold.success).toBe(true);
    expect(scaffold.entities.length).toBeGreaterThanOrEqual(2);
    expect(scaffold.relationships.length).toBeGreaterThanOrEqual(1);
    const rel = scaffold.relationships[0];
    expect(typeof rel.fromEntityIndex).toBe("number");
    expect(typeof rel.toEntityIndex).toBe("number");
    expect(rel.fromEntityIndex).toBeGreaterThanOrEqual(0);
    expect(rel.toEntityIndex).toBeGreaterThanOrEqual(0);
  });

  it("clamps a community create to organization type", () => {
    const input = "create a community called Boulder Mutual Aid";
    const scaffold = toCommandBarScaffold(parse(input, ctx()));
    expect(scaffold.success).toBe(true);
    expect(scaffold.entities[0].type).toBe("organization");
  });

  it("returns a failed scaffold (fallback contract) for a FIND input", () => {
    const input = "find all events";
    const scaffold = toCommandBarScaffold(parse(input, ctx()));

    expect(scaffold.success).toBe(false);
    expect(scaffold.entities).toHaveLength(0);
    expect(scaffold.relationships).toHaveLength(0);
    expect(scaffold.conditionals).toHaveLength(0);
    expect(scaffold.warnings).toContain(
      COMMANDBAR_SCAFFOLD_WARNINGS.NOT_A_CREATE,
    );
    expect(scaffold.intent).toBeNull();
  });

  it("returns a failed scaffold for a RULE input", () => {
    const input = "when anyone joins my group then give them a welcome badge";
    const scaffold = toCommandBarScaffold(parse(input, ctx()));
    expect(scaffold.success).toBe(false);
    expect(scaffold.entities).toHaveLength(0);
  });

  it("returns a failed scaffold (not a throw) when a create has no name", () => {
    // A backend-only region create compiles to a CreatePayloadCompileError,
    // which the adapter converts to a failed scaffold so the caller falls back.
    const input = "create a basin called South Platte";
    const scaffold = toCommandBarScaffold(parse(input, ctx()));
    expect(scaffold.success).toBe(false);
    expect(scaffold.warnings.length).toBeGreaterThan(0);
  });

  it("preserves the V2ParseResult-compatible shape on the failure path", () => {
    const scaffold = toCommandBarScaffold(parse("find all events", ctx()));
    // Structural contract the CommandBar + EntityScaffoldPreview rely on.
    expect(scaffold).toHaveProperty("success");
    expect(scaffold).toHaveProperty("input");
    expect(scaffold).toHaveProperty("entities");
    expect(scaffold).toHaveProperty("relationships");
    expect(scaffold).toHaveProperty("conditionals");
    expect(scaffold).toHaveProperty("warnings");
    expect(scaffold).toHaveProperty("intent");
  });
});
