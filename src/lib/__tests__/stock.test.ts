/**
 * @fileoverview Unit tests for the pure Stock helpers (Inventory projection,
 * Needs parsing, and "Post as request" text formatting).
 */
import { describe, expect, it } from "vitest";
import {
  MIN_STOCK_NEED_QUANTITY,
  NON_STOCK_RESOURCE_KINDS,
  STOCK_INVENTORY_TYPES,
  buildNeedRequestText,
  extractStockNeeds,
  isStockInventoryResource,
  isStockInventoryType,
  normalizeStockNeedQuantity,
  parseStockNeed,
  toStockInventory,
  toStockInventoryItem,
  composeNeedLists,
  extractStockNeedLists,
  GENERAL_NEEDS_LIST_ID,
} from "@/lib/stock";

describe("isStockInventoryType", () => {
  it("accepts the tangible stock types", () => {
    for (const type of STOCK_INVENTORY_TYPES) {
      expect(isStockInventoryType(type)).toBe(true);
    }
  });

  it("rejects non-stock and empty types", () => {
    expect(isStockInventoryType("post")).toBe(false);
    expect(isStockInventoryType("event")).toBe(false);
    expect(isStockInventoryType("job")).toBe(false);
    expect(isStockInventoryType(null)).toBe(false);
    expect(isStockInventoryType(undefined)).toBe(false);
  });
});

describe("normalizeStockNeedQuantity", () => {
  it("defaults absent/invalid values to the minimum", () => {
    expect(normalizeStockNeedQuantity(undefined)).toBe(MIN_STOCK_NEED_QUANTITY);
    expect(normalizeStockNeedQuantity("not-a-number")).toBe(MIN_STOCK_NEED_QUANTITY);
    expect(normalizeStockNeedQuantity(0)).toBe(MIN_STOCK_NEED_QUANTITY);
    expect(normalizeStockNeedQuantity(-4)).toBe(MIN_STOCK_NEED_QUANTITY);
  });

  it("truncates positive numbers and parses numeric strings", () => {
    expect(normalizeStockNeedQuantity(3.9)).toBe(3);
    expect(normalizeStockNeedQuantity("12")).toBe(12);
  });
});

describe("parseStockNeed", () => {
  it("returns null when id or name is missing", () => {
    expect(parseStockNeed({ name: "Tents" })).toBeNull();
    expect(parseStockNeed({ id: "n1" })).toBeNull();
    expect(parseStockNeed(null)).toBeNull();
  });

  it("parses a full need and normalizes quantity + flags", () => {
    expect(
      parseStockNeed({
        id: "n1",
        name: "  Tents  ",
        quantity: "5",
        note: "waterproof",
        fulfilled: true,
        requested: true,
        requestedPostId: "post-1",
      }),
    ).toEqual({
      id: "n1",
      name: "Tents",
      quantity: 5,
      note: "waterproof",
      fulfilled: true,
      requested: true,
      requestedPostId: "post-1",
    });
  });

  it("omits optional flags when absent", () => {
    expect(parseStockNeed({ id: "n2", name: "Water" })).toEqual({
      id: "n2",
      name: "Water",
      quantity: MIN_STOCK_NEED_QUANTITY,
      note: "",
      fulfilled: false,
    });
  });
});

describe("extractStockNeeds", () => {
  it("returns an empty array for missing/invalid metadata", () => {
    expect(extractStockNeeds(null)).toEqual([]);
    expect(extractStockNeeds({})).toEqual([]);
    expect(extractStockNeeds({ stockNeeds: "nope" })).toEqual([]);
  });

  it("drops malformed entries and keeps valid ones", () => {
    const needs = extractStockNeeds({
      stockNeeds: [
        { id: "a", name: "Rope", quantity: 2 },
        { name: "no id" },
        { id: "b", name: "Nails", quantity: 100, fulfilled: true },
      ],
    });
    expect(needs).toHaveLength(2);
    expect(needs[0]).toMatchObject({ id: "a", name: "Rope", quantity: 2 });
    expect(needs[1]).toMatchObject({ id: "b", name: "Nails", fulfilled: true });
  });
});

describe("toStockInventoryItem", () => {
  it("resolves image from imageUrl, then images[0], then image", () => {
    expect(toStockInventoryItem({ id: "1", name: "A", type: "asset", metadata: { imageUrl: "u1" } }).imageUrl).toBe("u1");
    expect(toStockInventoryItem({ id: "2", name: "B", type: "asset", metadata: { images: ["u2"] } }).imageUrl).toBe("u2");
    expect(toStockInventoryItem({ id: "3", name: "C", type: "asset", metadata: { image: "u3" } }).imageUrl).toBe("u3");
    expect(toStockInventoryItem({ id: "4", name: "D", type: "asset", metadata: {} }).imageUrl).toBeNull();
  });

  it("reads quantity from metadata.quantity then stockQuantity", () => {
    expect(toStockInventoryItem({ id: "1", name: "A", type: "resource", metadata: { quantity: 7 } }).quantity).toBe(7);
    expect(toStockInventoryItem({ id: "2", name: "B", type: "resource", metadata: { stockQuantity: 3 } }).quantity).toBe(3);
    expect(toStockInventoryItem({ id: "3", name: "C", type: "resource", metadata: {} }).quantity).toBeNull();
  });

  it("only links to marketplace when listingType is present", () => {
    expect(toStockInventoryItem({ id: "x", name: "A", type: "resource", metadata: { listingType: "product" } }).href).toBe("/marketplace/x");
    expect(toStockInventoryItem({ id: "y", name: "B", type: "resource", metadata: {} }).href).toBeNull();
  });
});

describe("isStockInventoryResource", () => {
  it("accepts tangible stock resources with no/other resourceKind", () => {
    expect(isStockInventoryResource({ id: "1", name: "Tent", type: "asset", metadata: {} })).toBe(true);
    expect(isStockInventoryResource({ id: "2", name: "Rope", type: "resource", metadata: { resourceKind: "supply" } })).toBe(true);
    expect(isStockInventoryResource({ id: "3", name: "Widget", type: "resource", metadata: { listingType: "product" } })).toBe(true);
  });

  it("rejects non-stock types regardless of resourceKind", () => {
    expect(isStockInventoryResource({ id: "4", name: "Post", type: "post", metadata: {} })).toBe(false);
    expect(isStockInventoryResource({ id: "5", name: "Job", type: "job", metadata: {} })).toBe(false);
  });

  it("excludes non-tangible economic resourceKinds (workperiod, fund)", () => {
    for (const kind of NON_STOCK_RESOURCE_KINDS) {
      expect(
        isStockInventoryResource({ id: `k-${kind}`, name: kind, type: "resource", metadata: { resourceKind: kind } }),
      ).toBe(false);
    }
  });
});

describe("toStockInventory", () => {
  it("keeps only tangible stock types", () => {
    const items = toStockInventory([
      { id: "1", name: "Asset", type: "asset", metadata: {} },
      { id: "2", name: "Resource", type: "resource", metadata: {} },
      { id: "3", name: "Post", type: "post", metadata: {} },
      { id: "4", name: "Event", type: "event", metadata: {} },
    ]);
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("drops work-period timer rows and treasury funds (item 9 regression)", () => {
    const items = toStockInventory([
      { id: "tent", name: "Tent", type: "resource", metadata: { quantity: 2 } },
      { id: "wp", name: "Work period — Setup", type: "resource", metadata: { resourceKind: "workperiod", jobId: "j1", durationMs: 3600000 } },
      { id: "fund", name: "Operations Fund", type: "resource", metadata: { resourceKind: "fund", walletKind: "fund" } },
      { id: "asset", name: "Ladder", type: "asset", metadata: {} },
    ]);
    expect(items.map((i) => i.id)).toEqual(["tent", "asset"]);
  });
});

describe("buildNeedRequestText", () => {
  it("omits the count prefix when quantity is 1", () => {
    expect(buildNeedRequestText({ name: "Water", quantity: 1, note: "" })).toBe("Need: Water");
  });

  it("includes an Nx prefix when quantity exceeds 1", () => {
    expect(buildNeedRequestText({ name: "Tents", quantity: 4, note: "" })).toBe("Need: 4x Tents");
  });

  it("appends the note with an em-dash when present", () => {
    expect(buildNeedRequestText({ name: "Tents", quantity: 4, note: "waterproof" })).toBe("Need: 4x Tents — waterproof");
  });

  it("normalizes an invalid quantity to the minimum (no prefix)", () => {
    expect(buildNeedRequestText({ name: "Rope", quantity: 0, note: "" })).toBe("Need: Rope");
  });
});

describe("need lists (multi-list model)", () => {
  const legacyNeed = { id: "n1", name: "Folding tables", quantity: 2, note: "", fulfilled: false };
  const listNeed = { id: "n2", name: "Lumber", quantity: 10, note: "2x4s", fulfilled: true, inventoryResourceId: "res-9" };

  it("composeNeedLists puts the synthetic General list first (even when empty)", () => {
    const lists = composeNeedLists({});
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: GENERAL_NEEDS_LIST_ID, name: "General", needs: [] });
  });

  it("surfaces legacy flat stockNeeds as the General list and named lists after", () => {
    const lists = composeNeedLists({
      stockNeeds: [legacyNeed],
      stockNeedLists: [{ id: "l1", name: "Fall build", projectId: "p1", needs: [listNeed] }],
    });
    expect(lists).toHaveLength(2);
    expect(lists[0].needs[0].name).toBe("Folding tables");
    expect(lists[1]).toMatchObject({ id: "l1", name: "Fall build", projectId: "p1" });
    expect(lists[1].needs[0].inventoryResourceId).toBe("res-9");
  });

  it("drops malformed lists and needs", () => {
    const lists = extractStockNeedLists({
      stockNeedLists: [
        { id: "", name: "no id", needs: [] },
        { id: "ok", name: "OK", needs: [{ id: "", name: "" }, legacyNeed] },
        "garbage",
      ],
    });
    expect(lists).toHaveLength(1);
    expect(lists[0].needs).toHaveLength(1);
  });
});
