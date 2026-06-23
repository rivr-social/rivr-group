import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, getConnectorDefinition } from "@/lib/connectors/catalog";

describe("connector catalog", () => {
  it("exposes the complete settings provider set without duplicate ids", () => {
    expect(CONNECTOR_CATALOG.map(({ label }) => label)).toEqual([
      "Google Drive", "Google Calendar", "Gmail", "Notion", "Telegram",
      "WhatsApp", "Signal", "Slack", "Facebook", "Instagram", "Substack", "Luma", "X",
    ]);
    expect(new Set(CONNECTOR_CATALOG.map(({ id }) => id)).size).toBe(CONNECTOR_CATALOG.length);
  });

  it("resolves known providers and rejects unknown providers", () => {
    expect(getConnectorDefinition("google_calendar")?.label).toBe("Google Calendar");
    expect(getConnectorDefinition("unknown")).toBeUndefined();
  });
});
