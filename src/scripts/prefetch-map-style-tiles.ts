import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readMapboxRuntimeConfig } from "./mapbox-env";

const { styleOwner: STYLE_OWNER, styleId: STYLE_ID, mapboxToken: MAPBOX_TOKEN } = readMapboxRuntimeConfig();
const MAP_DATA_ROOT = process.env.MAP_DATA_ROOT || path.join(process.cwd(), "data", "map");
const CACHE_ROOT = path.join(MAP_DATA_ROOT, "tiles", STYLE_OWNER, STYLE_ID);

type TileCoord = { z: number; x: number; y: number };
type BBox = { west: number; south: number; east: number; north: number; zMin: number; zMax: number; label: string };

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat: number, z: number): number {
  const latRad = deg2rad(lat);
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

function buildTilesForBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  zMin: number,
  zMax: number
): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let z = zMin; z <= zMax; z += 1) {
    const minX = lonToTileX(west, z);
    const maxX = lonToTileX(east, z);
    const minY = latToTileY(north, z);
    const maxY = latToTileY(south, z);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchAndWriteTile(tile: TileCoord): Promise<"hit" | "miss" | `fail:${string}`> {
  const outPath = path.join(CACHE_ROOT, String(tile.z), String(tile.x), `${tile.y}.png`);
  if (await fileExists(outPath)) return "hit";

  const url = `https://api.mapbox.com/styles/v1/${STYLE_OWNER}/${STYLE_ID}/tiles/256/${tile.z}/${tile.x}/${tile.y}?access_token=${MAPBOX_TOKEN}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "image/png,image/*;q=0.9,*/*;q=0.1" },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const snippet = body.replace(/\s+/g, " ").slice(0, 140);
      return `fail:http${response.status}:${snippet}`;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, bytes);
    return "miss";
  } catch {
    return "fail:network";
  }
}

async function run(): Promise<void> {
  if (!MAPBOX_TOKEN || MAPBOX_TOKEN.includes("placeholder")) {
    throw new Error("MAPBOX_TOKEN is required for one-time prefetch.");
  }

  const mode = (process.env.PREFETCH_MODE ?? "global").toLowerCase();
  const concurrency = Math.max(1, Number(process.env.PREFETCH_CONCURRENCY ?? "16"));
  const targets: BBox[] = [];

  if (mode === "single") {
    targets.push({
      west: Number(process.env.PREFETCH_WEST ?? "-105.42"),
      south: Number(process.env.PREFETCH_SOUTH ?? "39.92"),
      east: Number(process.env.PREFETCH_EAST ?? "-105.12"),
      north: Number(process.env.PREFETCH_NORTH ?? "40.13"),
      zMin: Number(process.env.PREFETCH_ZMIN ?? "6"),
      zMax: Number(process.env.PREFETCH_ZMAX ?? "13"),
      label: "single-bbox",
    });
  } else {
    // Global baseline so the full map always has real tiles.
    targets.push({
      west: -180,
      south: -85,
      east: 180,
      north: 85,
      zMin: Number(process.env.PREFETCH_GLOBAL_ZMIN ?? "0"),
      zMax: Number(process.env.PREFETCH_GLOBAL_ZMAX ?? "6"),
      label: "global-baseline",
    });

    // Higher detail around known active locales.
    const hotspots: Array<[string, number, number, number, number, number, number]> = [
      ["boulder", -105.42, 39.92, -105.12, 40.13, 7, 13],
      ["denver", -105.18, 39.62, -104.57, 39.95, 7, 12],
      ["sf-bay", -123.10, 37.20, -121.70, 38.20, 7, 12],
      ["la", -118.95, 33.55, -117.60, 34.45, 7, 12],
      ["nyc", -74.35, 40.45, -73.60, 40.98, 7, 12],
      ["chicago", -88.10, 41.55, -87.30, 42.10, 7, 12],
      ["seattle", -122.60, 47.35, -122.05, 47.80, 7, 12],
      ["austin", -98.15, 30.05, -97.45, 30.60, 7, 12],
      ["boston", -71.35, 42.15, -70.85, 42.55, 7, 12],
      ["portland", -123.15, 45.35, -122.30, 45.75, 7, 12],
    ];
    for (const [label, west, south, east, north, zMin, zMax] of hotspots) {
      targets.push({ label, west, south, east, north, zMin, zMax });
    }
  }

  const tileMap = new Map<string, TileCoord>();
  for (const target of targets) {
    const tiles = buildTilesForBbox(target.west, target.south, target.east, target.north, target.zMin, target.zMax);
    for (const tile of tiles) {
      tileMap.set(`${tile.z}/${tile.x}/${tile.y}`, tile);
    }
  }
  const tiles = Array.from(tileMap.values());
  console.log(`Prefetch mode=${mode}. targets=${targets.length}. unique tiles=${tiles.length}. cache=${CACHE_ROOT}`);

  let hits = 0;
  let misses = 0;
  let fails = 0;
  const failReasons = new Map<string, number>();
  let idx = 0;

  const workers = Array.from({ length: concurrency }).map(async () => {
    while (idx < tiles.length) {
      const current = tiles[idx];
      idx += 1;
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchAndWriteTile(current);
      if (result === "hit") hits += 1;
      if (result === "miss") misses += 1;
      if (result.startsWith("fail:")) {
        fails += 1;
        const key = result.slice("fail:".length);
        failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
      }
    }
  });
  await Promise.all(workers);

  console.log(`Done. cache hits=${hits}, downloaded=${misses}, failed=${fails}`);
  if (failReasons.size > 0) {
    const top = Array.from(failReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [reason, count] of top) {
      console.log(`  fail ${count}x: ${reason}`);
    }
  }
}

run().catch((error) => {
  console.error("Tile prefetch failed:", error);
  process.exit(1);
});
