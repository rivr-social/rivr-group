/**
 * Unit tests for the pure faceted-tag doc model (`parachute-doc.ts`).
 *
 * Covers tag normalization, vault-path → facet derivation, and the virtual
 * filesystem builder (folder nesting, multi-hierarchy overlay, the Untagged
 * bucket, and subtree docCount).
 */
import { describe, expect, it } from "vitest";
import {
  buildFacetedTree,
  facetedTagsFromVaultPath,
  flattenFacetedTags,
  normalizeFacetedTags,
  parseFacetedTagsFromMetadata,
  UNTAGGED_FACET_LABEL,
  type FacetFolderNode,
  type FacetedDoc,
  type FacetTreeNode,
} from "@/lib/parachute-doc";

function folder(nodes: FacetTreeNode[], name: string): FacetFolderNode {
  const match = nodes.find((n): n is FacetFolderNode => n.type === "facet" && n.name === name);
  if (!match) throw new Error(`No facet folder named "${name}" in [${nodes.map((n) => n.name).join(", ")}]`);
  return match;
}

describe("normalizeFacetedTags", () => {
  it("splits materialized string paths, trims, dedupes, and sorts", () => {
    const result = normalizeFacetedTags(["work/projects", "work/projects", " status / draft "]);
    expect(result).toEqual([
      ["status", "draft"],
      ["work", "projects"],
    ]);
  });

  it("accepts string[][] and drops empty segments/paths", () => {
    expect(normalizeFacetedTags([["a", "", "b"], [""], []])).toEqual([["a", "b"]]);
  });

  it("promotes a single materialized string to one tag-path", () => {
    expect(normalizeFacetedTags("x/y/z")).toEqual([["x", "y", "z"]]);
  });

  it("folds segments to lower-case so UI-typed tags match vault-imported ones (Parachute parity)", () => {
    // Parachute lower-cases every tag on import; `Work/Projects` typed in the
    // RIVR UI must collapse to the same facet as an imported `work/projects`,
    // never splitting the tag tree into two nodes.
    expect(normalizeFacetedTags(["Work/Projects", "work/projects"])).toEqual([
      ["work", "projects"],
    ]);
    expect(normalizeFacetedTags([["Status", "Draft"]])).toEqual([["status", "draft"]]);
  });

  it("maps a slash-path string to lower-case facet arrays and a flat mirror (persistence mapping)", () => {
    // slash-path input -> facetedTags arrays -> flat tags[] mirror.
    const facets = normalizeFacetedTags(["Work/Projects/RIVR", "status/draft"]);
    expect(facets).toEqual([
      ["status", "draft"],
      ["work", "projects", "rivr"],
    ]);
    expect(flattenFacetedTags(facets)).toEqual([
      "draft",
      "projects",
      "rivr",
      "status",
      "status/draft",
      "work",
      "work/projects/rivr",
    ]);
  });
});

describe("flattenFacetedTags", () => {
  it("emits every materialized path AND every bare segment, deduped and sorted", () => {
    expect(flattenFacetedTags([["work", "projects"]])).toEqual([
      "projects",
      "work",
      "work/projects",
    ]);
  });
});

describe("facetedTagsFromVaultPath", () => {
  it("uses the containing folders as the hierarchy and drops the filename", () => {
    expect(facetedTagsFromVaultPath("work/projects/rivr/spec.md")).toEqual([
      ["work", "projects", "rivr"],
    ]);
  });

  it("returns no facets for a file at the vault root", () => {
    expect(facetedTagsFromVaultPath("spec.md")).toEqual([]);
  });
});

describe("parseFacetedTagsFromMetadata", () => {
  it("reads facetedTags from metadata when present", () => {
    expect(
      parseFacetedTagsFromMetadata({ facetedTags: [["a", "b"]] }, ["ignored"]),
    ).toEqual([["a", "b"]]);
  });

  it("falls back to depth-1 facets from flat tags when metadata carries none", () => {
    expect(parseFacetedTagsFromMetadata({}, ["planning", "ops"])).toEqual([
      ["ops"],
      ["planning"],
    ]);
  });
});

describe("buildFacetedTree", () => {
  it("nests folders, files a doc under every hierarchy, and counts distinct docs", () => {
    const docs: FacetedDoc[] = [
      { id: "d1", name: "Spec", tags: [["work", "projects"], ["status", "draft"]] },
      { id: "d2", name: "Notes", tags: [["work", "projects"]] },
    ];

    const tree = buildFacetedTree(docs);
    const names = tree.filter((n) => n.type === "facet").map((n) => n.name).sort();
    expect(names).toEqual(["status", "work"]);

    // d1 appears under BOTH top-level hierarchies (overlay, not duplication).
    const status = folder(tree, "status");
    expect(status.docCount).toBe(1);

    const work = folder(tree, "work");
    // work subtree holds d1 + d2 (distinct).
    expect(work.docCount).toBe(2);
    const projects = folder(work.children, "projects");
    const leafDocIds = projects.children
      .filter((c) => c.type === "doc")
      .map((c) => (c.type === "doc" ? c.docId : ""))
      .sort();
    expect(leafDocIds).toEqual(["d1", "d2"]);
  });

  it("collects untagged docs under a single Untagged folder", () => {
    const tree = buildFacetedTree([{ id: "d3", name: "Loose", tags: [] }]);
    const untagged = folder(tree, UNTAGGED_FACET_LABEL);
    expect(untagged.docCount).toBe(1);
    expect(untagged.children).toHaveLength(1);
  });
});
