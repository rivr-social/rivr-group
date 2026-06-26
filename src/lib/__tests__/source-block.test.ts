import { describe, expect, it } from "vitest";

import {
  SOURCE_METADATA_KEY,
  buildSourceBlock,
  getSourceBlock,
  hashSourceContent,
  isSourceBlock,
  isTwoWay,
  shouldApplyRemoteUpdate,
  sourceEchoKey,
  touchSync,
  withSourceBlock,
} from "@/lib/resources/source-block";

/**
 * Tests for the provider-mirror `source` block contract (Wave 2 T2.6/T2.7).
 * We pin `now` where ordering matters so timestamp assertions are deterministic.
 */
describe("source-block", () => {
  const fixedNow = new Date("2026-06-26T12:00:00.000Z");

  it("builds a normalized block with one-way/provider_inbound defaults", () => {
    const source = buildSourceBlock({
      provider: "notion",
      externalId: "page-123",
      lane: "parachute-mirror",
      now: fixedNow,
    });
    expect(source.provider).toBe("notion");
    expect(source.externalId).toBe("page-123");
    expect(source.lane).toBe("parachute-mirror");
    expect(source.syncMode).toBe("one-way");
    expect(source.provenance).toBe("provider_inbound");
    expect(source.externalUrl).toBeNull();
    expect(source.externalEtag).toBeNull();
    expect(source.contentHash).toBeNull();
    expect(source.mirroredAt).toBe(fixedNow.toISOString());
    expect(source.syncedAt).toBe(fixedNow.toISOString());
    expect(source.providerMeta).toEqual({});
  });

  it("derives contentHash from content when not given explicitly", () => {
    const source = buildSourceBlock({
      provider: "google_drive",
      externalId: "doc-9",
      lane: "parachute-mirror",
      content: "hello world",
    });
    expect(source.contentHash).toBe(hashSourceContent("hello world"));
    expect(source.contentHash).not.toBeNull();
  });

  it("normalizes externalUpdatedAt (Date or string) to canonical ISO", () => {
    const fromDate = buildSourceBlock({
      provider: "luma",
      externalId: "evt-1",
      lane: "typed",
      externalUpdatedAt: new Date("2026-01-02T03:04:05Z"),
    });
    const fromString = buildSourceBlock({
      provider: "luma",
      externalId: "evt-1",
      lane: "typed",
      externalUpdatedAt: "2026-01-02T03:04:05Z",
    });
    expect(fromDate.externalUpdatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(fromString.externalUpdatedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("round-trips through metadata via withSourceBlock/getSourceBlock", () => {
    const source = buildSourceBlock({ provider: "gmail", externalId: "msg-7", lane: "on-demand" });
    const metadata = withSourceBlock({ existing: true }, source);
    expect(metadata.existing).toBe(true);
    expect(metadata[SOURCE_METADATA_KEY]).toEqual(source);
    expect(getSourceBlock(metadata)).toEqual(source);
  });

  it("getSourceBlock returns null for non-mirror metadata", () => {
    expect(getSourceBlock(null)).toBeNull();
    expect(getSourceBlock(undefined)).toBeNull();
    expect(getSourceBlock({})).toBeNull();
    expect(getSourceBlock({ source: { provider: "x" } })).toBeNull(); // missing externalId
  });

  it("isSourceBlock validates the identifying fields", () => {
    expect(isSourceBlock({ provider: "notion", externalId: "p1" })).toBe(true);
    expect(isSourceBlock({ provider: "notion" })).toBe(false);
    expect(isSourceBlock({ provider: "", externalId: "p1" })).toBe(false);
    expect(isSourceBlock(null)).toBe(false);
    expect(isSourceBlock("nope")).toBe(false);
  });

  it("computes a stable provider:externalId echo key", () => {
    const source = buildSourceBlock({ provider: "notion", externalId: "page-123", lane: "parachute-mirror" });
    expect(sourceEchoKey(source)).toBe("notion:page-123");
  });

  it("reports two-way only for two-way blocks", () => {
    const oneWay = buildSourceBlock({ provider: "gmail", externalId: "m1", lane: "on-demand" });
    const twoWay = buildSourceBlock({ provider: "google_drive", externalId: "d1", lane: "parachute-mirror", syncMode: "two-way" });
    expect(isTwoWay(oneWay)).toBe(false);
    expect(isTwoWay(twoWay)).toBe(true);
  });

  describe("shouldApplyRemoteUpdate", () => {
    it("suppresses an inbound echo of our own outbound write (etag match)", () => {
      const source = buildSourceBlock({
        provider: "google_calendar",
        externalId: "evt-1",
        lane: "typed",
        provenance: "rivr_outbound",
        externalEtag: "etag-abc",
        externalUpdatedAt: "2026-06-26T12:00:00Z",
      });
      expect(
        shouldApplyRemoteUpdate(source, { externalEtag: "etag-abc", externalUpdatedAt: "2026-06-26T13:00:00Z" }),
      ).toBe(false);
    });

    it("suppresses an inbound echo via matching content hash when no etag", () => {
      const source = buildSourceBlock({
        provider: "notion",
        externalId: "page-1",
        lane: "parachute-mirror",
        provenance: "rivr_outbound",
        content: "same body",
        externalUpdatedAt: "2026-06-26T12:00:00Z",
      });
      expect(
        shouldApplyRemoteUpdate(source, { content: "same body", externalUpdatedAt: "2026-06-26T13:00:00Z" }),
      ).toBe(false);
    });

    it("applies a newer provider update (last-write-wins)", () => {
      const source = buildSourceBlock({
        provider: "notion",
        externalId: "page-1",
        lane: "parachute-mirror",
        provenance: "provider_inbound",
        externalUpdatedAt: "2026-06-26T12:00:00Z",
      });
      expect(shouldApplyRemoteUpdate(source, { externalUpdatedAt: "2026-06-26T13:00:00Z" })).toBe(true);
    });

    it("rejects a stale or equal provider update", () => {
      const source = buildSourceBlock({
        provider: "notion",
        externalId: "page-1",
        lane: "parachute-mirror",
        externalUpdatedAt: "2026-06-26T12:00:00Z",
      });
      expect(shouldApplyRemoteUpdate(source, { externalUpdatedAt: "2026-06-26T11:00:00Z" })).toBe(false);
      expect(shouldApplyRemoteUpdate(source, { externalUpdatedAt: "2026-06-26T12:00:00Z" })).toBe(false);
    });

    it("applies when timestamps are missing (provider is authoritative inbound)", () => {
      const source = buildSourceBlock({ provider: "gmail", externalId: "m1", lane: "on-demand" });
      expect(shouldApplyRemoteUpdate(source, {})).toBe(true);
    });
  });

  describe("touchSync", () => {
    it("bumps syncedAt and records new state while preserving mirroredAt and identity", () => {
      const source = buildSourceBlock({
        provider: "google_drive",
        externalId: "doc-1",
        lane: "parachute-mirror",
        syncMode: "two-way",
        now: fixedNow,
      });
      const later = new Date("2026-06-27T09:00:00.000Z");
      const updated = touchSync(source, {
        provenance: "rivr_outbound",
        externalEtag: "etag-2",
        externalUpdatedAt: "2026-06-27T08:59:00Z",
        content: "new body",
        providerMeta: { revision: 5 },
        now: later,
      });
      expect(updated.mirroredAt).toBe(fixedNow.toISOString());
      expect(updated.syncedAt).toBe(later.toISOString());
      expect(updated.provider).toBe("google_drive");
      expect(updated.externalId).toBe("doc-1");
      expect(updated.lane).toBe("parachute-mirror");
      expect(updated.syncMode).toBe("two-way");
      expect(updated.provenance).toBe("rivr_outbound");
      expect(updated.externalEtag).toBe("etag-2");
      expect(updated.externalUpdatedAt).toBe("2026-06-27T08:59:00.000Z");
      expect(updated.contentHash).toBe(hashSourceContent("new body"));
      expect(updated.providerMeta).toEqual({ revision: 5 });
    });

    it("leaves untouched fields unchanged when patch omits them", () => {
      const source = buildSourceBlock({
        provider: "notion",
        externalId: "page-1",
        lane: "parachute-mirror",
        externalEtag: "etag-orig",
        externalUrl: "https://notion.so/page-1",
        content: "body",
      });
      const updated = touchSync(source, { provenance: "provider_inbound" });
      expect(updated.externalEtag).toBe("etag-orig");
      expect(updated.externalUrl).toBe("https://notion.so/page-1");
      expect(updated.contentHash).toBe(source.contentHash);
    });
  });

  it("hashSourceContent returns null for empty/absent content", () => {
    expect(hashSourceContent(null)).toBeNull();
    expect(hashSourceContent(undefined)).toBeNull();
    expect(hashSourceContent("")).toBeNull();
    expect(hashSourceContent("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
