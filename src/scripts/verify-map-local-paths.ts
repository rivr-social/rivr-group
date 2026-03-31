import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { readEnvFallback } from "./mapbox-env";

type Check = { name: string; ok: boolean; detail: string };

function localStyleOwner(): string {
  return readEnvFallback("MAPBOX_STYLE_OWNER") || readEnvFallback("NEXT_PUBLIC_MAPBOX_STYLE_OWNER") || "camalot999";
}

function localStyleId(): string {
  return readEnvFallback("MAPBOX_STYLE_ID") || readEnvFallback("NEXT_PUBLIC_MAPBOX_STYLE_ID") || "clvfmv3sf00ek01rdfvfhc2gd";
}

function mapDataRoot(): string {
  return readEnvFallback("MAP_DATA_ROOT") || path.join(process.cwd(), "data", "map");
}

function isLocalUrl(raw: string): boolean {
  if (!raw) return false;
  if (raw.startsWith("/")) return true;
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAnyPng(root: string, depth = 5): Promise<boolean> {
  if (depth < 0) return false;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".png")) return true;
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      if (await findAnyPng(nextPath, depth - 1)) return true;
    }
  }
  return false;
}

async function probe(url: string): Promise<string> {
  if (!url) return "not configured";
  if (!isLocalUrl(url)) return `non-local URL (${url})`;
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    return `${response.status} ${response.statusText}`;
  } catch (error) {
    return `unreachable (${String(error)})`;
  }
}

async function run(): Promise<void> {
  const owner = localStyleOwner();
  const styleId = localStyleId();
  const root = mapDataRoot();

  const styleFile = path.join(root, "style", owner, styleId, "style.json");
  const tilesetsFile = path.join(root, "style", owner, styleId, "tilesets.json");
  const tilesRoot = path.join(root, "tiles", owner, styleId);

  const streetsUrl = readEnvFallback("NEXT_PUBLIC_LOCAL_STREETS_TILES_URL") || readEnvFallback("NEXT_PUBLIC_STREETS_TILES_URL") || "/api/map-style-tiles/{z}/{x}/{y}";
  const boundariesUrl = readEnvFallback("NEXT_PUBLIC_LOCAL_BASEMAP_URL") || "/api/map-style-tiles/{z}/{x}/{y}";
  const terrainUrl = readEnvFallback("NEXT_PUBLIC_LOCAL_TERRAIN_URL") || readEnvFallback("NEXT_PUBLIC_CESIUM_TERRAIN_URL");
  const buildingsUrl = readEnvFallback("NEXT_PUBLIC_LOCAL_BUILDINGS_3DTILES_URL") || readEnvFallback("NEXT_PUBLIC_CESIUM_BUILDINGS_URL");

  const checks: Check[] = [];

  checks.push({ name: "style cache", ok: await exists(styleFile), detail: styleFile });
  checks.push({ name: "tilesets cache", ok: await exists(tilesetsFile), detail: tilesetsFile });
  checks.push({ name: "raster tile cache", ok: await findAnyPng(tilesRoot), detail: tilesRoot });

  checks.push({ name: "streets URL local", ok: isLocalUrl(streetsUrl), detail: streetsUrl });
  checks.push({ name: "boundaries URL local", ok: isLocalUrl(boundariesUrl), detail: boundariesUrl });
  checks.push({ name: "terrain URL local", ok: !!terrainUrl && isLocalUrl(terrainUrl), detail: terrainUrl || "not configured" });
  checks.push({ name: "buildings URL local", ok: !!buildingsUrl && isLocalUrl(buildingsUrl), detail: buildingsUrl || "not configured" });

  checks.push({
    name: "runtime mapbox token disabled",
    ok: !readEnvFallback("MAPBOX_TOKEN") && !readEnvFallback("NEXT_PUBLIC_MAPBOX_TOKEN"),
    detail: "MAPBOX_TOKEN and NEXT_PUBLIC_MAPBOX_TOKEN should be empty for runtime",
  });

  const terrainProbe = await probe(terrainUrl);
  const buildingsProbe = await probe(buildingsUrl);

  for (const check of checks) {
    const status = check.ok ? "PASS" : "FAIL";
    console.log(`${status} | ${check.name} | ${check.detail}`);
  }

  console.log(`INFO | terrain probe | ${terrainProbe}`);
  console.log(`INFO | buildings probe | ${buildingsProbe}`);

  const failed = checks.filter((check) => !check.ok).length;
  if (failed > 0) {
    console.error(`\nLocal map verification failed: ${failed} checks failed.`);
    process.exit(1);
  }

  console.log("\nLocal map verification passed.");
}

run().catch((error) => {
  console.error("verify-map-local-paths failed:", error);
  process.exit(1);
});
