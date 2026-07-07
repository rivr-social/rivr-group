/**
 * Characterization tests for the graph adapters — the highest-fan-in untested
 * hub flagged by the UA-graph analysis (complex, fan-in ~14, no test edge).
 *
 * These pin CURRENT behavior so refactors of the adapter layer are safe, with
 * emphasis on the regression class we have already been bitten by: issue #6,
 * where agentToEvent read only `metadata.startDate` while the create flow
 * writes `metadata.date`/`metadata.time`, collapsing every event to its
 * creation time.
 */
import { describe, expect, it } from "vitest";
import {
  agentToEvent,
  agentToGroup,
  agentToUser,
  resourceToMarketplaceListing,
  resourceToPost,
} from "@/lib/graph-adapters";
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";

const BASE_AGENT: SerializedAgent = {
  id: "2be278d2-d3ba-42cd-9c74-2739cc524667",
  name: "Test Agent",
  type: "person",
  description: "",
  email: null,
  image: null,
  metadata: {},
  parentId: null,
  pathIds: [],
  depth: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const BASE_RESOURCE: SerializedResource = {
  id: "5f0d16aa-71f3-4761-a1c7-a4b1a3a3a001",
  name: "Test Resource",
  type: "post",
  description: "Body text",
  content: "Body text",
  url: null,
  ownerId: "owner-1",
  isPublic: true,
  metadata: {},
  tags: [],
  createdAt: "2024-02-01T00:00:00.000Z",
  updatedAt: "2024-02-01T00:00:00.000Z",
};

describe("agentToEvent — issue #6 date composition", () => {
  it("composes the start datetime from metadata.date + metadata.time (the create-flow shape)", () => {
    const event = agentToEvent({
      ...BASE_AGENT,
      type: "event",
      metadata: { date: "2026-08-01", time: "18:30" },
    });
    expect(event.timeframe.start).toBe("2026-08-01T18:30");
    // No end date/time → end mirrors start, not createdAt.
    expect(event.timeframe.end).toBe("2026-08-01T18:30");
  });

  it("uses a date-only start when no time is stored", () => {
    const event = agentToEvent({
      ...BASE_AGENT,
      type: "event",
      metadata: { date: "2026-08-01" },
    });
    expect(event.timeframe.start).toBe("2026-08-01");
  });

  it("falls back to an explicit ISO startDate for legacy records", () => {
    const event = agentToEvent({
      ...BASE_AGENT,
      type: "event",
      metadata: { startDate: "2026-09-15T10:00:00.000Z" },
    });
    expect(event.timeframe.start).toBe("2026-09-15T10:00:00.000Z");
  });

  it("falls back to createdAt only when no date fields exist at all", () => {
    const event = agentToEvent({ ...BASE_AGENT, type: "event", metadata: {} });
    expect(event.timeframe.start).toBe(BASE_AGENT.createdAt);
  });

  it("composes the end datetime from endDate + endTime", () => {
    const event = agentToEvent({
      ...BASE_AGENT,
      type: "event",
      metadata: { date: "2026-08-01", time: "18:30", endDate: "2026-08-01", endTime: "21:00" },
    });
    expect(event.timeframe.end).toBe("2026-08-01T21:00");
  });

  it("normalizes a string location into { name, address }", () => {
    const event = agentToEvent({
      ...BASE_AGENT,
      type: "event",
      metadata: { location: "Boulder, CO" },
    });
    expect(event.location).toEqual({ name: "Boulder, CO", address: "Boulder, CO" });
  });
});

describe("resourceToPost", () => {
  it("maps content, tags, and defaults without an author record", () => {
    const post = resourceToPost({
      ...BASE_RESOURCE,
      metadata: { authorName: "Ada Lovelace", likes: 3, postType: "offer" },
      tags: ["mutual-aid"],
    });
    expect(post.content).toBe("Body text");
    expect(post.author.name).toBe("Ada Lovelace");
    expect(post.author.username).toBe("ada-lovelace");
    expect(post.likes).toBe(3);
    expect(post.postType).toBe("offer");
    expect(post.tags).toEqual(["mutual-aid"]);
    expect(post.createdAt).toBe(BASE_RESOURCE.createdAt);
  });

  it("derives basePrice from totalPriceCents when basePrice is absent", () => {
    const post = resourceToPost({
      ...BASE_RESOURCE,
      metadata: { totalPriceCents: 2500 },
    });
    expect(post.basePrice).toBe(25);
  });

  it("prefers an explicit numeric basePrice over totalPriceCents", () => {
    const post = resourceToPost({
      ...BASE_RESOURCE,
      metadata: { basePrice: 10, totalPriceCents: 2500 },
    });
    expect(post.basePrice).toBe(10);
  });

  it("uses the provided author agent when present", () => {
    const author: SerializedAgent = { ...BASE_AGENT, name: "Real Author" };
    const post = resourceToPost(BASE_RESOURCE, author);
    expect(post.author.id).toBe(BASE_AGENT.id);
    expect(post.author.name).toBe("Real Author");
  });
});

describe("agentToGroup", () => {
  it("maps an organization agent with member/admin metadata", () => {
    const group = agentToGroup({
      ...BASE_AGENT,
      type: "organization",
      name: "Spirit of the Front Range",
      metadata: { creatorId: "creator-1", adminIds: ["creator-1"], memberCount: 12 },
    });
    expect(group.id).toBe(BASE_AGENT.id);
    expect(group.name).toBe("Spirit of the Front Range");
  });
});

describe("agentToUser", () => {
  it("derives a username and avatar fallback", () => {
    const user = agentToUser({ ...BASE_AGENT, name: "Bob Builder" });
    expect(user.id).toBe(BASE_AGENT.id);
    expect(user.name).toBe("Bob Builder");
    expect(typeof user.username).toBe("string");
    expect(user.username.length).toBeGreaterThan(0);
  });
});

describe("resourceToMarketplaceListing", () => {
  it("maps a listing resource with price metadata", () => {
    const listing = resourceToMarketplaceListing({
      ...BASE_RESOURCE,
      type: "listing",
      name: "Handmade Chair",
      metadata: { listingType: "product", basePrice: 120, status: "active" },
    });
    expect(listing.id).toBe(BASE_RESOURCE.id);
    expect(listing.title ?? listing.name).toBeTruthy();
  });
});
