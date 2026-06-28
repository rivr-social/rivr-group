/**
 * Unit tests for the pure static-site model + generator (WS-B / B4).
 *
 * These pin: theme/section resolution, REA resource grouping by type, ordering
 * + capping, HTML escaping (XSS-safety of owner/resource fields), the
 * fleet-portable SiteFiles output shape (index.html + style.css), and the
 * invalid-owner error path.
 */
import { describe, it, expect } from "vitest";

import {
  buildSiteFiles,
  escapeHtml,
  fileCount,
  INDEX_FILE,
  resolveSectionIds,
  resolveSiteModel,
  resolveThemePreset,
  SITE_SECTION_IDS,
  STYLE_FILE,
  type SiteOwner,
  type SiteResource,
} from "../site-model";

const OWNER: SiteOwner = {
  id: "agent-1",
  name: "Ada Lovelace",
  type: "person",
  description: "First programmer",
  image: "https://cdn.example/ada.jpg",
  metadata: { bio: "Mathematician" },
};

function resource(partial: Partial<SiteResource>): SiteResource {
  return {
    id: partial.id ?? "r1",
    name: partial.name ?? "Item",
    type: partial.type ?? "post",
    description: partial.description ?? null,
    content: partial.content ?? null,
    url: partial.url ?? null,
    createdAt: partial.createdAt ?? null,
  };
}

describe("resolveThemePreset", () => {
  it("returns a known preset unchanged", () => {
    expect(resolveThemePreset("red-gold")).toBe("red-gold");
  });
  it("falls back to default for unknown/undefined", () => {
    expect(resolveThemePreset("nope")).toBe("default");
    expect(resolveThemePreset(undefined)).toBe("default");
  });
});

describe("resolveSectionIds", () => {
  it("returns all sections in default order when none requested", () => {
    expect(resolveSectionIds(undefined)).toEqual([...SITE_SECTION_IDS]);
    expect(resolveSectionIds([])).toEqual([...SITE_SECTION_IDS]);
  });
  it("preserves caller order, dedupes, and drops unknown ids", () => {
    // @ts-expect-error testing unknown id is filtered
    expect(resolveSectionIds(["posts", "posts", "bogus", "hero"])).toEqual(["posts", "hero"]);
  });
});

describe("resolveSiteModel", () => {
  it("groups resources into sections by type", () => {
    const model = resolveSiteModel(OWNER, [
      resource({ id: "p1", type: "post", name: "Hello" }),
      resource({ id: "e1", type: "event", name: "Launch" }),
      resource({ id: "o1", type: "listing", name: "For sale" }),
    ]);
    const byId = Object.fromEntries(model.sections.map((s) => [s.id, s]));
    expect(byId.posts.items.map((i) => i.id)).toEqual(["p1"]);
    expect(byId.events.items.map((i) => i.id)).toEqual(["e1"]);
    expect(byId.offerings.items.map((i) => i.id)).toEqual(["o1"]);
  });

  it("sorts items newest-first by createdAt", () => {
    const model = resolveSiteModel(OWNER, [
      resource({ id: "old", type: "post", createdAt: "2020-01-01T00:00:00Z" }),
      resource({ id: "new", type: "post", createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    const posts = model.sections.find((s) => s.id === "posts")!;
    expect(posts.items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("matches resource types case-insensitively", () => {
    const model = resolveSiteModel(OWNER, [resource({ id: "p", type: "POST" })]);
    expect(model.sections.find((s) => s.id === "posts")!.items).toHaveLength(1);
  });

  it("throws when owner has no id", () => {
    expect(() => resolveSiteModel({ id: "", name: "x", type: "person" }, [])).toThrow(/owner with an id/);
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });
  it("renders null/undefined as empty", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("buildSiteFiles", () => {
  it("produces the fleet-portable index.html + style.css", () => {
    const files = buildSiteFiles(OWNER, [resource({ name: "Post A", type: "post" })]);
    expect(Object.keys(files).sort()).toEqual([INDEX_FILE, STYLE_FILE]);
    expect(fileCount(files)).toBe(2);
    expect(files[INDEX_FILE]).toContain("<!DOCTYPE html>");
    expect(files[INDEX_FILE]).toContain("Ada Lovelace");
    expect(files[INDEX_FILE]).toContain("Post A");
    expect(files[STYLE_FILE]).toContain(":root");
  });

  it("escapes XSS in owner and resource fields", () => {
    const files = buildSiteFiles(
      { id: "a", name: "<b>x</b>", type: "person", description: "<img onerror=1>" },
      [resource({ name: "<script>evil</script>", type: "post" })],
    );
    expect(files[INDEX_FILE]).not.toContain("<script>evil</script>");
    expect(files[INDEX_FILE]).toContain("&lt;script&gt;evil&lt;/script&gt;");
    expect(files[INDEX_FILE]).not.toContain("<b>x</b>");
  });

  it("applies the requested theme tokens to the stylesheet", () => {
    const files = buildSiteFiles(OWNER, [], { theme: "red-gold" });
    expect(files[STYLE_FILE]).toContain("#c1121f"); // red-gold primary
  });

  it("only renders requested sections", () => {
    const files = buildSiteFiles(OWNER, [resource({ type: "event", name: "E1" })], {
      sections: ["events"],
    });
    expect(files[INDEX_FILE]).toContain("E1");
    expect(files[INDEX_FILE]).not.toContain('id="posts"');
  });

  it("renders an empty-state for sections with no resources", () => {
    const files = buildSiteFiles(OWNER, [], { sections: ["posts"] });
    expect(files[INDEX_FILE]).toContain("Nothing here yet.");
  });
});
