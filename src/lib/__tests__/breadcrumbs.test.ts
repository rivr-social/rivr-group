/**
 * Unit tests for the pure breadcrumb-chain helpers (`@/lib/breadcrumbs`) — the
 * containment-chain builder + middle-collapse logic behind the reusable
 * hierarchical breadcrumb (group → subgroup → project → job). No React/DB.
 *
 * Run with `pnpm test:unit`.
 */
import { describe, it, expect } from "vitest";
import {
  buildContainmentChain,
  collapseBreadcrumbs,
  DEFAULT_MAX_VISIBLE,
  type BreadcrumbNode,
} from "@/lib/breadcrumbs";

describe("buildContainmentChain", () => {
  it("appends the current page (link-less) after the ancestors, root-first", () => {
    const chain = buildContainmentChain(
      [
        { id: "g", label: "Spirit", href: "/groups/g" },
        { id: "s", label: "Kitchen", href: "/groups/s" },
      ],
      { id: "p", label: "Harvest Dinner", href: "/projects/p" },
    );
    expect(chain).toEqual([
      { id: "g", label: "Spirit", href: "/groups/g" },
      { id: "s", label: "Kitchen", href: "/groups/s" },
      { id: "p", label: "Harvest Dinner" },
    ]);
  });

  it("current page never carries an href even if one is passed", () => {
    const chain = buildContainmentChain([], { id: "p", label: "Solo", href: "/x" });
    expect(chain).toEqual([{ id: "p", label: "Solo" }]);
  });

  it("drops empty/whitespace labels", () => {
    const chain = buildContainmentChain(
      [
        { id: "a", label: "  ", href: "/a" },
        { id: "b", label: "Real", href: "/b" },
      ],
      { id: "c", label: "Here" },
    );
    expect(chain.map((n) => n.label)).toEqual(["Real", "Here"]);
  });

  it("collapses a duplicate id between the last ancestor and the current page", () => {
    const chain = buildContainmentChain(
      [{ id: "same", label: "Dup", href: "/same" }],
      { id: "same", label: "Dup" },
    );
    expect(chain).toEqual([{ id: "same", label: "Dup", href: "/same" }]);
  });
});

describe("collapseBreadcrumbs", () => {
  const nodes = (n: number): BreadcrumbNode[] =>
    Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `L${i}` }));

  it("passes short chains through unchanged", () => {
    const slots = collapseBreadcrumbs(nodes(3), DEFAULT_MAX_VISIBLE);
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.kind === "crumb")).toBe(true);
  });

  it("passes a chain exactly at the limit through unchanged", () => {
    const slots = collapseBreadcrumbs(nodes(4), 4);
    expect(slots).toHaveLength(4);
    expect(slots.every((s) => s.kind === "crumb")).toBe(true);
  });

  it("collapses the middle of a long chain, keeping head + trailing crumbs", () => {
    const slots = collapseBreadcrumbs(nodes(6), 4);
    // head, ellipsis, then last 2 crumbs
    expect(slots.map((s) => s.kind)).toEqual(["crumb", "ellipsis", "crumb", "crumb"]);
    expect(slots[0]).toEqual({ kind: "crumb", node: { id: "n0", label: "L0" } });
    const ellipsis = slots[1];
    if (ellipsis.kind !== "ellipsis") throw new Error("expected ellipsis");
    expect(ellipsis.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    // last two crumbs are the innermost nodes (current page always last)
    expect(slots[3]).toEqual({ kind: "crumb", node: { id: "n5", label: "L5" } });
  });

  it("always keeps the current (last) page visible", () => {
    const slots = collapseBreadcrumbs(nodes(10), 4);
    const last = slots[slots.length - 1];
    expect(last).toEqual({ kind: "crumb", node: { id: "n9", label: "L9" } });
  });

  it("clamps maxVisible below 2 and still keeps head, ellipsis, and current", () => {
    const slots = collapseBreadcrumbs(nodes(5), 1);
    // limit clamped to 2 → head + ellipsis + current (tailCount floored to 1)
    expect(slots.map((s) => s.kind)).toEqual(["crumb", "ellipsis", "crumb"]);
    expect(slots[0]).toEqual({ kind: "crumb", node: { id: "n0", label: "L0" } });
    expect(slots[2]).toEqual({ kind: "crumb", node: { id: "n4", label: "L4" } });
  });
});
