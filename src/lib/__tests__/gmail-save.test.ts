import { describe, expect, it } from "vitest";

import {
  ITEM_SAVE_PROVIDERS,
  extractBodyText,
  renderGmailMarkdown,
  runConnectorItemSave,
} from "@/lib/connectors/gmail-save";

/** base64url-encodes a UTF-8 string the way the Gmail API returns body data. */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * Unit tests for the Gmail on-demand save renderers and dispatcher. The
 * DB/fetch-bound `saveGmailMessage` is exercised via the connectors route; its
 * mirror upsert/LWW logic is covered in source-block.test.ts.
 */
describe("gmail-save body extraction", () => {
  it("prefers a text/plain part", () => {
    const body = extractBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Plain body") } },
        { mimeType: "text/html", body: { data: b64url("<p>HTML body</p>") } },
      ],
    });
    expect(body).toBe("Plain body");
  });

  it("falls back to reduced HTML when no plain part exists", () => {
    const body = extractBodyText({
      mimeType: "text/html",
      body: { data: b64url("<p>Line one</p><p>Line two</p>") },
    });
    expect(body).toContain("Line one");
    expect(body).toContain("Line two");
    expect(body).not.toContain("<p>");
  });

  it("returns empty string for an absent payload", () => {
    expect(extractBodyText(undefined)).toBe("");
  });
});

describe("renderGmailMarkdown", () => {
  it("builds a header block + body and extracts the subject", () => {
    const { subject, markdown } = renderGmailMarkdown({
      id: "m1",
      payload: {
        headers: [
          { name: "Subject", value: "Hello there" },
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "bob@example.com" },
          { name: "Date", value: "Mon, 26 Jun 2026 12:00:00 +0000" },
        ],
        mimeType: "text/plain",
        body: { data: b64url("The message body.") },
      },
    });
    expect(subject).toBe("Hello there");
    expect(markdown).toContain("# Hello there");
    expect(markdown).toContain("**From:** alice@example.com");
    expect(markdown).toContain("**To:** bob@example.com");
    expect(markdown).toContain("The message body.");
  });

  it("defaults the subject and uses the snippet when there is no body", () => {
    const { subject, markdown } = renderGmailMarkdown({
      id: "m2",
      snippet: "snippet preview",
      payload: { headers: [] },
    });
    expect(subject).toBe("(no subject)");
    expect(markdown).toContain("snippet preview");
  });
});

describe("runConnectorItemSave dispatch", () => {
  it("lists gmail as an item-save provider", () => {
    expect(ITEM_SAVE_PROVIDERS).toContain("gmail");
  });

  it("throws a not-supported error for other providers", async () => {
    await expect(runConnectorItemSave("agent-1", "notion", "x")).rejects.toThrow(/not supported/i);
  });
});
