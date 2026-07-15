/**
 * Unit tests for the builder-assistant workspace jail + tool dispatch.
 * Hermetic: publish is an injected stub; no DB/model imports.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  makeBuilderToolset,
  validateSitePath,
} from "@/lib/builder/assistant-tools";

const BASE = { "index.html": "<html></html>", "style.css": "body{}" };
const noopPublish = async () => ({ versionNumber: 1 });

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

describe("validateSitePath", () => {
  it("accepts normal workspace paths", () => {
    expect(validateSitePath("index.html")).toBeNull();
    expect(validateSitePath("assets/site.css")).toBeNull();
    expect(validateSitePath("data/feed.json")).toBeNull();
  });

  it("rejects traversal, absolute, dotfile, and backslash paths", () => {
    expect(validateSitePath("../secret.html")).not.toBeNull();
    expect(validateSitePath("a/../b.html")).not.toBeNull();
    expect(validateSitePath("/etc/passwd.txt")).not.toBeNull();
    expect(validateSitePath(".env.txt")).not.toBeNull();
    expect(validateSitePath("a\\b.html")).not.toBeNull();
  });

  it("rejects disallowed extensions and non-strings", () => {
    expect(validateSitePath("evil.sh")).not.toBeNull();
    expect(validateSitePath("no-extension")).not.toBeNull();
    expect(validateSitePath(42)).not.toBeNull();
    expect(validateSitePath("")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

describe("makeBuilderToolset", () => {
  it("lists, reads, writes, and deletes without mutating the input map", async () => {
    const toolset = makeBuilderToolset(BASE, noopPublish);

    const listing = (await toolset.executeTool("list_files", {})) as Array<{ path: string }>;
    expect(listing.map((f) => f.path)).toEqual(["index.html", "style.css"]);

    expect(await toolset.executeTool("read_file", { path: "style.css" })).toBe("body{}");

    await toolset.executeTool("write_file", { path: "about.html", content: "<h1>hi</h1>" });
    await toolset.executeTool("delete_file", { path: "style.css" });

    expect(toolset.getFiles()).toEqual({
      "index.html": "<html></html>",
      "about.html": "<h1>hi</h1>",
    });
    expect(toolset.getChangedPaths()).toEqual(["about.html", "style.css"]);
    // The caller's map is untouched.
    expect(BASE["style.css"]).toBe("body{}");
  });

  it("returns tool-level errors instead of throwing on bad input", async () => {
    const toolset = makeBuilderToolset(BASE, noopPublish);
    expect(await toolset.executeTool("read_file", { path: "../x.html" })).toHaveProperty("error");
    expect(await toolset.executeTool("read_file", { path: "missing.html" })).toHaveProperty("error");
    expect(await toolset.executeTool("write_file", { path: "a.html", content: 5 })).toHaveProperty(
      "error",
    );
    expect(await toolset.executeTool("nonsense", {})).toHaveProperty("error");
  });

  it("protects index.html and enforces size/count caps", async () => {
    const toolset = makeBuilderToolset(BASE, noopPublish);
    expect(await toolset.executeTool("delete_file", { path: "index.html" })).toHaveProperty(
      "error",
    );
    expect(
      await toolset.executeTool("write_file", {
        path: "big.txt",
        content: "x".repeat(MAX_FILE_BYTES + 1),
      }),
    ).toHaveProperty("error");

    const crowded: Record<string, string> = {};
    for (let i = 0; i < MAX_WORKSPACE_FILES; i += 1) crowded[`f${i}.txt`] = "x";
    const full = makeBuilderToolset(crowded, noopPublish);
    expect(
      await full.executeTool("write_file", { path: "one-more.txt", content: "x" }),
    ).toHaveProperty("error");
    // Overwriting an EXISTING file is still allowed at the cap.
    expect(await full.executeTool("write_file", { path: "f0.txt", content: "y" })).toMatchObject({
      ok: true,
    });
  });

  it("publishes the working copy through the injected callback exactly once asked", async () => {
    const publish = vi.fn(async () => ({ versionNumber: 7 }));
    const toolset = makeBuilderToolset(BASE, publish);
    expect(toolset.wasPublished()).toBe(false);

    await toolset.executeTool("write_file", { path: "index.html", content: "<h1>v2</h1>" });
    const result = await toolset.executeTool("publish_site", {});
    expect(result).toMatchObject({ ok: true, versionNumber: 7 });
    expect(publish).toHaveBeenCalledWith({ "index.html": "<h1>v2</h1>", "style.css": "body{}" });
    expect(toolset.wasPublished()).toBe(true);
  });

  it("propagates publish failures as thrown errors (the route reports them)", async () => {
    const toolset = makeBuilderToolset(BASE, async () => {
      throw new Error("db down");
    });
    await expect(toolset.executeTool("publish_site", {})).rejects.toThrow("db down");
    expect(toolset.wasPublished()).toBe(false);
  });
});
