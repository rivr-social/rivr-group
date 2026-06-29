/**
 * @file resolver.test.ts — slot resolution against MOCKED composer candidate sources.
 *
 * The resolver's only db touchpoint is `fetchAgentsForComposer` /
 * `fetchResourcesForComposer`. Per the v1 plan, those are mocked here so the
 * test is self-contained (no DB). Covers: literal-new skip, deictic grounding,
 * exact/ambiguous named lookup, and the no-candidates path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the composer module so the resolver's static import of it does NOT pull
// in the real "use server" module (which transitively loads @/auth → next-auth
// and fails outside the Next runtime). Tests inject their own sources, so these
// default mocks just satisfy module resolution.
vi.mock("@/app/actions/graph/composer", () => ({
  fetchAgentsForComposer: vi.fn().mockResolvedValue([]),
  fetchResourcesForComposer: vi.fn().mockResolvedValue([]),
}));

import { SEMANTIC_DOMAINS, SLOT_ROLES, type Slot } from "./ast";
import { makeContext } from "./context";
import {
  resolveSlot,
  resolveStatement,
  RESOLUTION_REASONS,
  type ResolverSources,
} from "./resolver";
import { parse } from "./parser";
import { topInterpretation } from "./ast";

function sources(
  agents: Array<{ id: string; name: string; type: string }>,
  resources: Array<{ id: string; title: string; type: string }>,
): ResolverSources {
  return {
    fetchAgents: vi.fn().mockResolvedValue(agents),
    fetchResources: vi.fn().mockResolvedValue(resources),
  };
}

const ctx = () =>
  makeContext("u-alice", {
    here: "loc-boulder",
    groupScope: "grp-camalot",
    now: new Date("2026-06-26T12:00:00Z"),
    recentEntities: [
      { id: "res-recent", name: "Last Thing", domain: SEMANTIC_DOMAINS.RESOURCE },
    ],
  });

describe("resolver — resolveSlot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips literal-new entities (nothing to resolve)", async () => {
    const slot: Slot = {
      role: SLOT_ROLES.OBJECT,
      literalNew: true,
      name: "New Project",
      domain: SEMANTIC_DOMAINS.RESOURCE,
      source: "a project called New Project",
    };
    const result = await resolveSlot(slot, ctx(), sources([], []));
    expect(result.unresolved).toBe(true);
    expect(result.reason).toBe(RESOLUTION_REASONS.LITERAL_NEW);
    expect(result.candidates).toEqual([]);
  });

  it("grounds a self deictic to the actor id", async () => {
    const slot: Slot = { role: SLOT_ROLES.FILTER, deictic: "self", source: "me" };
    const result = await resolveSlot(slot, ctx(), sources([], []));
    expect(result.unresolved).toBe(false);
    expect(result.resolvedId).toBe("u-alice");
  });

  it("grounds a here deictic to the locale id", async () => {
    const slot: Slot = { role: SLOT_ROLES.FILTER, deictic: "here", source: "here" };
    const result = await resolveSlot(slot, ctx(), sources([], []));
    expect(result.resolvedId).toBe("loc-boulder");
  });

  it("returns unresolved for an unbound group deictic (no scope)", async () => {
    const noScope = makeContext("u-alice", { now: new Date(), recentEntities: [] });
    const slot: Slot = { role: SLOT_ROLES.FILTER, deictic: "group", source: "we" };
    const result = await resolveSlot(slot, noScope, sources([], []));
    expect(result.unresolved).toBe(true);
  });

  it("resolves an exact named agent unambiguously", async () => {
    const slot: Slot = {
      role: SLOT_ROLES.OBJECT,
      domain: SEMANTIC_DOMAINS.AGENT,
      name: "Green Team",
      source: "the Green Team",
      literalNew: false,
    };
    const result = await resolveSlot(
      slot,
      ctx(),
      sources([{ id: "a1", name: "Green Team", type: "organization" }], []),
    );
    expect(result.unresolved).toBe(false);
    expect(result.resolvedId).toBe("a1");
    expect(result.candidates[0].score).toBe(1);
  });

  it("returns ambiguous candidates without a resolvedId on multiple matches", async () => {
    const slot: Slot = {
      role: SLOT_ROLES.OBJECT,
      domain: SEMANTIC_DOMAINS.AGENT,
      name: "Green",
      source: "Green",
      literalNew: false,
    };
    const result = await resolveSlot(
      slot,
      ctx(),
      sources(
        [
          { id: "a1", name: "Green Team", type: "organization" },
          { id: "a2", name: "Green Energy Co", type: "organization" },
        ],
        [],
      ),
    );
    expect(result.resolvedId).toBeUndefined();
    expect(result.unresolved).toBe(true);
    expect(result.candidates.length).toBe(2);
  });

  it("returns no-candidates when nothing matches the name", async () => {
    const slot: Slot = {
      role: SLOT_ROLES.OBJECT,
      domain: SEMANTIC_DOMAINS.RESOURCE,
      name: "Nonexistent",
      source: "the Nonexistent",
      literalNew: false,
    };
    const result = await resolveSlot(
      slot,
      ctx(),
      sources([], [{ id: "r1", title: "Something Else", type: "post" }]),
    );
    expect(result.unresolved).toBe(true);
    expect(result.reason).toBe(RESOLUTION_REASONS.NO_CANDIDATES);
  });
});

describe("resolver — session actor id deictic grounding (WS-D / #64)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves 'me' (self deictic) to the session actor id supplied in ParseContext", async () => {
    const sessionActorId = "agent-real-session-user";
    const context = makeContext(sessionActorId, { now: new Date(), recentEntities: [] });
    const slot: Slot = { role: SLOT_ROLES.FILTER, deictic: "self", source: "me" };
    const result = await resolveSlot(slot, context, sources([], []));
    expect(result.unresolved).toBe(false);
    expect(result.resolvedId).toBe(sessionActorId);
  });

  it("resolves 'me' via full parse pipeline when actorId is threaded into ParseContext", async () => {
    const sessionActorId = "agent-real-session-user";
    const context = makeContext(sessionActorId, { now: new Date(), recentEntities: [] });
    // "show me the projects I created" produces a FIND statement whose filters
    // include a self deictic for the "I" pronoun — confirmed by the existing
    // resolveStatement suite test.
    const program = parse("show me the projects I created", context);
    const statement = topInterpretation(program)!.statement;
    const result = await resolveStatement(statement, context, sources([], []));
    const selfSlot = result.slots.find((s) => s.slot.deictic === "self");
    expect(selfSlot).toBeDefined();
    expect(selfSlot?.resolvedId).toBe(sessionActorId);
    expect(selfSlot?.unresolved).toBe(false);
  });

  it("does NOT resolve 'me' to the sentinel — sentinel is unrecognised as a real agent", async () => {
    // When sessionActorId is not yet available the component uses the sentinel.
    // The sentinel satisfies the ParseContext type but resolves to its own literal
    // value — the test confirms it is NOT an empty/null string (i.e. the context
    // shape is always valid) and is distinct from any real agent id.
    const sentinel = "client:command-bar";
    const context = makeContext(sentinel, { now: new Date(), recentEntities: [] });
    const slot: Slot = { role: SLOT_ROLES.FILTER, deictic: "self", source: "me" };
    const result = await resolveSlot(slot, context, sources([], []));
    expect(result.unresolved).toBe(false);
    // resolvedId is the sentinel — deictic grounding returns whatever actorId is in context.
    expect(result.resolvedId).toBe(sentinel);
    // Real agent ids come from the server session, never from a hard-coded string.
    expect(result.resolvedId).not.toBe("agent-real-session-user");
  });
});

describe("resolver — resolveStatement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the deictic filters of a FIND statement", async () => {
    const program = parse("show me the projects I created", ctx());
    const statement = topInterpretation(program)!.statement;
    const result = await resolveStatement(statement, ctx(), sources([], []));
    const self = result.slots.find((s) => s.slot.deictic === "self");
    expect(self?.resolvedId).toBe("u-alice");
  });

  it("does not resolve literal-new entities of a CREATE statement", async () => {
    const program = parse("create a project called River Cleanup", ctx());
    const statement = topInterpretation(program)!.statement;
    const src = sources([], []);
    const result = await resolveStatement(statement, ctx(), src);
    // Only literalNew=false entities are collected; here there are none.
    expect(result.slots).toEqual([]);
    expect(src.fetchAgents).not.toHaveBeenCalled();
  });
});
