import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readMapboxRuntimeConfig } from "./mapbox-env";

type TileSetCategory = "regions" | "basins" | "watersheds";

interface TileSetEntry {
  id: string;
  categories: TileSetCategory[];
  vectorLayers: string[];
}

function classifyFromNames(names: string[]): TileSetCategory[] {
  const joined = names.join(" ").toLowerCase();
  const categories = new Set<TileSetCategory>();
  if (/(region|eco|ecoreg|state|county|zip|city|admin|divide)/.test(joined)) categories.add("regions");
  if (/(basin|subbasin|huc[_ -]?[2486]|hu[_ -]?[2486])/.test(joined)) categories.add("basins");
  if (/(watershed|wbd|river|stream|hydro|drainage)/.test(joined)) categories.add("watersheds");
  if (categories.size === 0) categories.add("regions");
  return Array.from(categories);
}

function parseTilesetIds(styleJson: string): string[] {
  const parsed = JSON.parse(styleJson) as { sources?: Record<string, { url?: string }> };
  const ids = new Set<string>();
  for (const src of Object.values(parsed.sources ?? {})) {
    const url = src?.url || "";
    if (!url.startsWith("mapbox://")) continue;
    const split = url.replace("mapbox://", "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const id of split) ids.add(id);
  }
  return Array.from(ids);
}

async function run(): Promise<void> {
  const { styleOwner, styleId, mapboxToken } = readMapboxRuntimeConfig();
  if (!mapboxToken || mapboxToken.includes("placeholder")) {
    throw new Error("Missing MAPBOX_TOKEN/NEXT_PUBLIC_MAPBOX_TOKEN in .env");
  }

  const mapDataRoot = process.env.MAP_DATA_ROOT || path.join(process.cwd(), "data", "map");
  const cacheRoot = path.join(mapDataRoot, "style", styleOwner, styleId);
  const styleFile = path.join(cacheRoot, "style.json");
  const tilesetFile = path.join(cacheRoot, "tilesets.json");

  await mkdir(cacheRoot, { recursive: true });

  const styleUrl = `https://api.mapbox.com/styles/v1/${styleOwner}/${styleId}?access_token=${mapboxToken}`;
  const styleResponse = await fetch(styleUrl, { cache: "no-store" });
  if (!styleResponse.ok) {
    throw new Error(`Style fetch failed: ${styleResponse.status}`);
  }
  const styleRaw = await styleResponse.text();
  await writeFile(styleFile, styleRaw, "utf8");
  console.log(`Wrote style cache: ${styleFile}`);

  const tileIds = parseTilesetIds(styleRaw);
  const entries: TileSetEntry[] = [];
  for (const id of tileIds) {
    let vectorLayers: string[] = [];
    try {
      const tileJsonUrl = `https://api.mapbox.com/v4/${id}.json?secure&access_token=${mapboxToken}`;
      const response = await fetch(tileJsonUrl, { cache: "no-store" });
      if (response.ok) {
        const tileJson = (await response.json()) as { vector_layers?: Array<{ id?: string }> };
        vectorLayers = (tileJson.vector_layers ?? []).map((layer) => layer.id || "").filter(Boolean);
      }
    } catch {
      // continue with fallback classification
    }
    entries.push({
      id,
      vectorLayers,
      categories: classifyFromNames(vectorLayers.length > 0 ? vectorLayers : [id]),
    });
  }

  await writeFile(tilesetFile, JSON.stringify({ tilesets: entries }, null, 2), "utf8");
  console.log(`Wrote tileset cache: ${tilesetFile} (${entries.length} entries)`);
}

run().catch((error) => {
  console.error("Mapbox style mirror failed:", error);
  process.exit(1);
});
