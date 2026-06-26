import { describe, expect, it } from "vitest";

import {
  SYNCABLE_CONNECTOR_PROVIDERS,
  blocksToMarkdown,
  extractTitle,
  runConnectorSync,
  type NotionBlock,
  type NotionSearchPage,
} from "@/lib/connectors/notion-sync";

/**
 * Unit tests for the Notion connector's pure rendering helpers and the sync
 * dispatcher. The DB/fetch-bound `syncNotionConnector` is exercised end-to-end
 * by the connectors route integration; the LWW/echo logic it relies on is
 * covered in source-block.test.ts.
 */
describe("notion-sync renderers", () => {
  it("extracts a page title from its title-typed property", () => {
    const page: NotionSearchPage = {
      object: "page",
      id: "p1",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Quarterly " }, { plain_text: "Plan" }] },
        Status: { type: "select", select: { name: "Done" } },
      },
    };
    expect(extractTitle(page)).toBe("Quarterly Plan");
  });

  it("falls back to a default title when no title property is present", () => {
    const page: NotionSearchPage = { object: "page", id: "p2", properties: {} };
    expect(extractTitle(page)).toBe("Untitled Notion Page");
  });

  it("renders common block types to Markdown", () => {
    const blocks: NotionBlock[] = [
      { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Body text." }] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Point" }] } },
      { type: "to_do", to_do: { rich_text: [{ plain_text: "Task" }], checked: true } },
      { type: "divider", divider: {} },
    ];
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("# Title");
    expect(md).toContain("Body text.");
    expect(md).toContain("- Point");
    expect(md).toContain("- [x] Task");
    expect(md).toContain("---");
  });

  it("skips unknown/typeless blocks rather than fabricating content", () => {
    const blocks: NotionBlock[] = [
      { type: "unsupported_widget", unsupported_widget: {} },
      {},
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "kept" }] } },
    ];
    expect(blocksToMarkdown(blocks)).toBe("kept");
  });

  it("renders an empty string for no blocks", () => {
    expect(blocksToMarkdown([])).toBe("");
  });
});

describe("runConnectorSync dispatch", () => {
  it("lists notion as a syncable provider", () => {
    expect(SYNCABLE_CONNECTOR_PROVIDERS).toContain("notion");
  });

  it("throws an honest not-supported error for unsupported providers", async () => {
    await expect(runConnectorSync("agent-1", "gmail")).rejects.toThrow(/not supported/i);
  });
});
