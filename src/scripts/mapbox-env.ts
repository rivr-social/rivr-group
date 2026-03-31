import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

export function readEnvFallback(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.trim().length > 0) return fromProcess.trim();

  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  const parsed = parseDotenv(readFileSync(envPath, "utf8"));
  return (parsed[key] ?? "").trim();
}

export function readMapboxRuntimeConfig() {
  const styleOwner =
    readEnvFallback("MAPBOX_STYLE_OWNER") ||
    readEnvFallback("NEXT_PUBLIC_MAPBOX_STYLE_OWNER") ||
    "camalot999";
  const styleId =
    readEnvFallback("MAPBOX_STYLE_ID") ||
    readEnvFallback("NEXT_PUBLIC_MAPBOX_STYLE_ID") ||
    "clvfmv3sf00ek01rdfvfhc2gd";
  const mapboxToken = readEnvFallback("MAPBOX_TOKEN");
  return { styleOwner, styleId, mapboxToken };
}
