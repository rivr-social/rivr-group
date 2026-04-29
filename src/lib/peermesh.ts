import { assertSafeOutboundUrl } from "@/lib/safe-outbound-url";

const ALLOWED_PEERMESH_HOSTS = new Set(["spatial.peermesh.org", "peermesh.org"]);
const UNIVERSAL_MANIFEST_CONTEXT =
  "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld";

export interface PeermeshIdentity {
  handle: string | null;
  did: string | null;
  publicKey: string | null;
  manifestId: string | null;
  manifestUrl: string | null;
}

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifestUrl(value: string): URL {
  try {
    return assertSafeOutboundUrl(value, {
      protocols: ["https:"],
      allowedHostnames: [...ALLOWED_PEERMESH_HOSTS],
      allowedHostnameSuffixes: ["peermesh.org"],
    });
  } catch {
    throw new Error("Enter a valid PeerMesh manifest URL or pasted export JSON.");
  }
}

function extractManifestPayload(data: unknown): JsonRecord {
  if (!isObject(data)) {
    throw new Error("PeerMesh export must be a JSON object.");
  }

  if (isObject(data.manifest)) {
    return data.manifest;
  }

  return data;
}

function findValueDeep<T extends string = string>(
  value: unknown,
  predicate: (candidate: string, path: string[]) => boolean,
  path: string[] = [],
): T | null {
  if (typeof value === "string") {
    return predicate(value, path) ? (value as T) : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findValueDeep<T>(value[index], predicate, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const found = findValueDeep<T>(nested, predicate, [...path, key]);
      if (found) return found;
    }
  }

  return null;
}

function extractHandle(source: JsonRecord, manifest: JsonRecord): string | null {
  const directCandidates = [
    source.handle,
    source.username,
    manifest.handle,
    manifest.username,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return (
    findValueDeep(source, (candidate, path) => {
      const leaf = path[path.length - 1]?.toLowerCase() ?? "";
      return (leaf === "handle" || leaf === "username") && candidate.trim().length > 0;
    }) ??
    findValueDeep(manifest, (candidate, path) => {
      const leaf = path[path.length - 1]?.toLowerCase() ?? "";
      return (leaf === "handle" || leaf === "username") && candidate.trim().length > 0;
    })
  );
}

function extractDid(source: JsonRecord, manifest: JsonRecord): string | null {
  const subject = manifest.subject;
  if (typeof subject === "string" && subject.startsWith("did:")) {
    return subject;
  }
  return (
    findValueDeep(source, (candidate) => candidate.startsWith("did:")) ??
    findValueDeep(manifest, (candidate) => candidate.startsWith("did:"))
  );
}

function extractPublicKey(source: JsonRecord, manifest: JsonRecord): string | null {
  return (
    findValueDeep(source, (candidate, path) => {
      const leaf = path[path.length - 1]?.toLowerCase() ?? "";
      return leaf.includes("publickey") || leaf === "public_key";
    }) ??
    findValueDeep(manifest, (candidate, path) => {
      const leaf = path[path.length - 1]?.toLowerCase() ?? "";
      return leaf.includes("publickey") || leaf === "public_key";
    })
  );
}

function extractManifestId(manifest: JsonRecord): string | null {
  const manifestId = manifest["@id"];
  if (typeof manifestId !== "string") return null;
  return manifestId.startsWith("urn:uuid:") ? manifestId.slice("urn:uuid:".length) : manifestId;
}

function validateManifestShape(manifest: JsonRecord) {
  const context = manifest["@context"];
  const type = manifest["@type"];
  const manifestVersion = manifest.manifestVersion;

  if (typeof context !== "string" || context !== UNIVERSAL_MANIFEST_CONTEXT) {
    throw new Error("PeerMesh export must include a Universal Manifest v0.1 context.");
  }

  const includesManifestType =
    typeof type === "string"
      ? type.includes("Manifest")
      : Array.isArray(type) && type.some((entry) => typeof entry === "string" && entry.includes("Manifest"));

  if (!includesManifestType) {
    throw new Error("PeerMesh export is missing a valid manifest type.");
  }

  if (manifestVersion !== "0.1") {
    throw new Error("PeerMesh export must use Universal Manifest version 0.1.");
  }
}

async function fetchManifestFromUrl(url: URL): Promise<JsonRecord> {
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json, application/ld+json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Unable to fetch the PeerMesh manifest from that URL.");
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const manifest = extractManifestPayload(payload);
  validateManifestShape(manifest);
  return manifest;
}

export async function parsePeermeshIdentityInput(raw: string): Promise<PeermeshIdentity> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Paste a PeerMesh export JSON blob or manifest URL.");
  }

  let source: JsonRecord;
  let manifest: JsonRecord;
  let manifestUrl: string | null = null;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("PeerMesh export JSON could not be parsed.");
    }
    source = isObject(parsed) ? parsed : {};
    manifest = extractManifestPayload(source);
    validateManifestShape(manifest);

    const embeddedUrl =
      typeof source.manifestUrl === "string"
        ? source.manifestUrl
        : typeof manifest.pointers === "object"
          ? null
          : null;
    if (embeddedUrl) {
      manifestUrl = parseManifestUrl(embeddedUrl).toString();
    }
  } else {
    const url = parseManifestUrl(trimmed);
    source = { manifestUrl: url.toString() };
    manifest = await fetchManifestFromUrl(url);
    manifestUrl = url.toString();
  }

  const handle = extractHandle(source, manifest);
  const did = extractDid(source, manifest);
  const publicKey = extractPublicKey(source, manifest);
  const manifestId = extractManifestId(manifest);

  if (!handle && !did) {
    throw new Error("PeerMesh export must include at least a handle or DID.");
  }

  return {
    handle,
    did,
    publicKey,
    manifestId,
    manifestUrl,
  };
}
