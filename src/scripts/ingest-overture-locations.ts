import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { sql } from "drizzle-orm";
import { db } from "@/db";

type NormalizedPlace = {
  id: string;
  sourceId: string;
  source: string;
  name: string;
  displayName: string;
  category: string | null;
  countryCode: string | null;
  adminRegion: string | null;
  locality: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  lat: number;
  lon: number;
  metadata: Record<string, unknown>;
};

const DEFAULT_PLACES_FILE = "data/overture/places.ndjson";
const DEFAULT_ADDRESSES_FILE = "data/overture/addresses.ndjson";

function readArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pickPoint(raw: Record<string, unknown>): { lon: number; lat: number } | null {
  const geometry = raw.geometry as Record<string, unknown> | undefined;
  const geometryCoords = Array.isArray(geometry?.coordinates) ? geometry?.coordinates : undefined;
  if (Array.isArray(geometryCoords) && geometryCoords.length >= 2) {
    const lon = Number(geometryCoords[0]);
    const lat = Number(geometryCoords[1]);
    if (isFiniteNumber(lon) && isFiniteNumber(lat)) return { lon, lat };
  }

  const coords = raw.coordinates as Record<string, unknown> | undefined;
  if (coords) {
    const lon = Number(coords.lon ?? coords.lng ?? coords.longitude);
    const lat = Number(coords.lat ?? coords.latitude);
    if (isFiniteNumber(lon) && isFiniteNumber(lat)) return { lon, lat };
  }

  const lon = Number(raw.lon ?? raw.lng ?? raw.longitude);
  const lat = Number(raw.lat ?? raw.latitude);
  if (isFiniteNumber(lon) && isFiniteNumber(lat)) return { lon, lat };

  return null;
}

function normalizeRecord(rawLine: string, sourceHint: "places" | "addresses"): NormalizedPlace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const properties = (root.properties && typeof root.properties === "object")
    ? (root.properties as Record<string, unknown>)
    : root;

  const point = pickPoint(root) || pickPoint(properties);
  if (!point) return null;

  const names = (properties.names && typeof properties.names === "object")
    ? (properties.names as Record<string, unknown>)
    : {};

  const addresses = Array.isArray(properties.addresses) ? properties.addresses : [];
  const primaryAddress = (addresses[0] && typeof addresses[0] === "object")
    ? (addresses[0] as Record<string, unknown>)
    : {};

  const locality = pickString(
    properties.locality,
    properties.city,
    primaryAddress.locality,
    primaryAddress.city
  );
  const adminRegion = pickString(
    properties.region,
    properties.state,
    properties.admin_region,
    primaryAddress.region,
    primaryAddress.state
  );
  const countryCode = pickString(
    properties.country,
    properties.country_code,
    primaryAddress.country,
    primaryAddress.country_code
  )?.toUpperCase() ?? null;
  const street = pickString(
    properties.street,
    primaryAddress.street
  );
  const houseNumber = pickString(
    properties.housenumber,
    properties.house_number,
    primaryAddress.housenumber,
    primaryAddress.house_number
  );
  const postcode = pickString(
    properties.postcode,
    primaryAddress.postcode
  );

  const category = pickString(
    properties.category,
    properties.class,
    properties.kind,
    properties.type
  );

  const preferredName = pickString(
    names.primary,
    properties.name,
    properties.primary_name,
    sourceHint === "addresses" ? buildAddressLine(street, houseNumber, locality) : null
  );
  if (!preferredName) return null;

  const sourceId = pickString(root.id, properties.id) ??
    createHash("sha256").update(rawLine).digest("hex");
  const source = sourceHint === "addresses" ? "overture-addresses" : "overture-places";
  const displayName = buildDisplayName(preferredName, locality, adminRegion, postcode, countryCode);

  return {
    id: `${source}:${sourceId}`,
    sourceId,
    source,
    name: preferredName,
    displayName,
    category: category ? titleCase(category) : null,
    countryCode,
    adminRegion,
    locality,
    street,
    houseNumber,
    postcode,
    lat: point.lat,
    lon: point.lon,
    metadata: {
      sourceHint,
      names,
      category,
    },
  };
}

function buildAddressLine(street: string | null, houseNumber: string | null, locality: string | null): string | null {
  const line1 = [street, houseNumber].filter(Boolean).join(" ").trim();
  if (line1) return line1;
  return locality;
}

function buildDisplayName(
  name: string,
  locality: string | null,
  adminRegion: string | null,
  postcode: string | null,
  countryCode: string | null
): string {
  const tail = [locality, adminRegion, postcode, countryCode].filter(Boolean).join(", ");
  return tail ? `${name}, ${tail}` : name;
}

async function flushBatch(batch: NormalizedPlace[]): Promise<void> {
  if (batch.length === 0) return;
  const rows = batch.map((item) => sql`(
    ${item.id},
    ${item.sourceId},
    ${item.source},
    ${item.name},
    ${item.displayName},
    ${item.category},
    ${item.countryCode},
    ${item.adminRegion},
    ${item.locality},
    ${item.street},
    ${item.houseNumber},
    ${item.postcode},
    ${item.lat},
    ${item.lon},
    ${item.metadata}
  )`);

  await db.execute(sql`
    INSERT INTO overture_places (
      id,
      source_id,
      source,
      name,
      display_name,
      category,
      country_code,
      admin_region,
      locality,
      street,
      house_number,
      postcode,
      lat,
      lon,
      metadata
    )
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      display_name = EXCLUDED.display_name,
      category = EXCLUDED.category,
      country_code = EXCLUDED.country_code,
      admin_region = EXCLUDED.admin_region,
      locality = EXCLUDED.locality,
      street = EXCLUDED.street,
      house_number = EXCLUDED.house_number,
      postcode = EXCLUDED.postcode,
      lat = EXCLUDED.lat,
      lon = EXCLUDED.lon,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `);
}

async function ingestNdjsonFile(path: string, sourceHint: "places" | "addresses"): Promise<{ read: number; inserted: number }> {
  if (!existsSync(path)) {
    return { read: 0, inserted: 0 };
  }

  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const batch: NormalizedPlace[] = [];
  let read = 0;
  let inserted = 0;

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    read += 1;
    const normalized = normalizeRecord(trimmed, sourceHint);
    if (!normalized) continue;
    batch.push(normalized);
    if (batch.length >= 500) {
      await flushBatch(batch);
      inserted += batch.length;
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    await flushBatch(batch);
    inserted += batch.length;
  }

  return { read, inserted };
}

async function main(): Promise<void> {
  const placesFile = readArgValue("--places") ?? process.env.OVERTURE_PLACES_FILE ?? DEFAULT_PLACES_FILE;
  const addressesFile = readArgValue("--addresses") ?? process.env.OVERTURE_ADDRESSES_FILE ?? DEFAULT_ADDRESSES_FILE;

  console.log(`Ingesting Overture places from: ${placesFile}`);
  console.log(`Ingesting Overture addresses from: ${addressesFile}`);

  const placeResult = await ingestNdjsonFile(placesFile, "places");
  const addressResult = await ingestNdjsonFile(addressesFile, "addresses");

  console.log(
    `Overture ingest complete. Places read=${placeResult.read}, upserted=${placeResult.inserted}; ` +
    `Addresses read=${addressResult.read}, upserted=${addressResult.inserted}`
  );
}

main()
  .catch((error) => {
    console.error("Failed to ingest Overture datasets:", error);
    process.exit(1);
  });

