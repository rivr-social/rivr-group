/**
 * Unit tests for the design editor's owner-media collector (WS-B / B3).
 *
 * `collectOwnerMediaImages` is the single server-side source for "the still
 * images that belong to owner agent X" that backs the Polotno editor's "My
 * Photos" panel. It must:
 *   - read the owner's avatar + `metadata.profilePhotos` and prepend the avatar
 *     as the highest-precedence "profile photo",
 *   - read the owner's non-deleted media-bearing Resources,
 *   - reuse the shared gallery collector and return ONLY still images (videos
 *     excluded — the Photos panel places stills on the canvas),
 *   - return `{ key, src, label }` triples, newest-first and de-duplicated.
 *
 * The DB is mocked with a fluent builder whose two awaited chains both end in
 * `.limit()`; each `.limit()` call resolves the next queued result, so this
 * stays pure logic (no Postgres). The real `collectGalleryItems` runs unmocked
 * so ordering/de-dup/kind-inference are exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** FIFO of results returned by successive terminal `.limit()` awaits. */
  limitResults: [] as unknown[],
}));

// Fluent, chainable query-builder stub. Every non-terminal call returns the
// same builder; the terminal `.limit()` resolves the next queued result. The
// builder is itself thenable in case a chain is awaited without `.limit()`.
function makeDb() {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.from = vi.fn(chain);
  builder.where = vi.fn(chain);
  builder.orderBy = vi.fn(chain);
  builder.limit = vi.fn(() => Promise.resolve(mocks.limitResults.shift() ?? []));
  return { db: builder };
}

vi.mock("@/db", () => makeDb());
vi.mock("@/db/schema", () => ({
  agents: { id: "agents.id", image: "agents.image", metadata: "agents.metadata" },
  resources: {
    id: "resources.id",
    name: "resources.name",
    type: "resources.type",
    url: "resources.url",
    contentType: "resources.contentType",
    metadata: "resources.metadata",
    createdAt: "resources.createdAt",
    ownerId: "resources.ownerId",
    deletedAt: "resources.deletedAt",
  },
}));
// drizzle operators are pure marker functions here; their return value is
// never inspected because the where/orderBy chain is stubbed.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  desc: (col: unknown) => ({ desc: col }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: [strings, values] }),
}));

import { collectOwnerMediaImages } from "@/lib/design/owner-media";

/** Queues the owner row then the resources rows for a single call. */
function queue(owner: unknown[], resources: unknown[]) {
  mocks.limitResults = [owner, resources];
}

beforeEach(() => {
  mocks.limitResults = [];
});

describe("collectOwnerMediaImages", () => {
  it("returns an empty list when the owner agent does not exist", async () => {
    queue([], []); // no owner row; resources chain still queued but unused
    const result = await collectOwnerMediaImages("ghost");
    expect(result).toEqual([]);
  });

  it("prepends the avatar as the highest-precedence profile photo", async () => {
    queue(
      [{ image: "https://cdn/avatar.png", metadata: { profilePhotos: ["https://cdn/p1.png"] } }],
      [],
    );
    const result = await collectOwnerMediaImages("agent-1");
    expect(result.map((i) => i.src)).toEqual([
      "https://cdn/avatar.png",
      "https://cdn/p1.png",
    ]);
    expect(result[0].label).toBe("Profile photo");
  });

  it("includes media-bearing resources and excludes videos", async () => {
    queue(
      [{ image: null, metadata: {} }],
      [
        {
          id: "r-img",
          name: "Poster",
          type: "image",
          url: "https://cdn/poster.png",
          contentType: "image/png",
          metadata: {},
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
        {
          id: "r-vid",
          name: "Clip",
          type: "video",
          url: "https://cdn/clip.mp4",
          contentType: "video/mp4",
          metadata: {},
          createdAt: new Date("2026-06-03T00:00:00.000Z"),
        },
      ],
    );
    const result = await collectOwnerMediaImages("agent-1");
    const srcs = result.map((i) => i.src);
    expect(srcs).toContain("https://cdn/poster.png");
    expect(srcs).not.toContain("https://cdn/clip.mp4");
  });

  it("orders newest-first and de-duplicates by src", async () => {
    queue(
      [{ image: null, metadata: {} }],
      [
        {
          id: "r-old",
          name: "Old",
          type: "image",
          url: "https://cdn/old.png",
          contentType: "image/png",
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "r-new",
          name: "New",
          type: "image",
          url: "https://cdn/new.png",
          contentType: "image/png",
          metadata: {},
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        {
          id: "r-dup",
          name: "Dup",
          type: "image",
          url: "https://cdn/new.png", // duplicate src — should be dropped
          contentType: "image/png",
          metadata: {},
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    );
    const result = await collectOwnerMediaImages("agent-1");
    expect(result.map((i) => i.src)).toEqual([
      "https://cdn/new.png",
      "https://cdn/old.png",
    ]);
  });

  it("ignores a non-array profilePhotos metadata value", async () => {
    queue([{ image: null, metadata: { profilePhotos: "not-an-array" } }], []);
    const result = await collectOwnerMediaImages("agent-1");
    expect(result).toEqual([]);
  });

  it("returns only key/src/label triples for each image", async () => {
    queue(
      [{ image: "https://cdn/avatar.png", metadata: {} }],
      [],
    );
    const [item] = await collectOwnerMediaImages("agent-1");
    expect(Object.keys(item).sort()).toEqual(["key", "label", "src"]);
    expect(typeof item.key).toBe("string");
  });
});
