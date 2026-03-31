import { readEnvFallback } from "./mapbox-env";

function required(name: string): string {
  const value = readEnvFallback(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function main() {
  const localBaseUrl = required("FEDERATION_LOCAL_BASE_URL").replace(/\/$/, "");
  const localAdminKey = required("FEDERATION_LOCAL_ADMIN_KEY");
  const remoteBaseUrl = required("FEDERATION_REMOTE_BASE_URL").replace(/\/$/, "");
  const remoteAdminKey = required("FEDERATION_REMOTE_ADMIN_KEY");
  const remotePeerSlug = required("FEDERATION_REMOTE_PEER_SLUG");

  const visibilities = parseList(readEnvFallback("FEDERATION_SYNC_VISIBILITIES") || "public,locale,members");
  const scopeIds = parseList(readEnvFallback("FEDERATION_SYNC_SCOPE_IDS"));
  const limit = Number.parseInt(readEnvFallback("FEDERATION_SYNC_LIMIT") || "300", 10);

  const exportResponse = await fetch(`${remoteBaseUrl}/api/federation/events/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-node-admin-key": remoteAdminKey,
    },
    body: JSON.stringify({ visibilities, scopeIds, limit }),
  });

  const exportJson = await exportResponse.json();
  if (!exportResponse.ok) {
    throw new Error(`Remote export failed (${exportResponse.status}): ${JSON.stringify(exportJson)}`);
  }

  const events = Array.isArray(exportJson.events) ? exportJson.events : [];
  const importResponse = await fetch(`${localBaseUrl}/api/federation/events/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-node-admin-key": localAdminKey,
    },
    body: JSON.stringify({
      fromPeerSlug: remotePeerSlug,
      events,
    }),
  });

  const importJson = await importResponse.json();
  if (!importResponse.ok) {
    throw new Error(`Local import failed (${importResponse.status}): ${JSON.stringify(importJson)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        exported: events.length,
        import: importJson,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
