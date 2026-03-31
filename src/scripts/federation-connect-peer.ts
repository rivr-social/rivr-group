import { readEnvFallback } from "./mapbox-env";

type ConnectPayload = {
  peerSlug: string;
  peerDisplayName: string;
  peerRole: "group" | "locale" | "basin" | "global";
  peerBaseUrl: string;
  peerPublicKey: string;
};

function required(name: string): string {
  const value = readEnvFallback(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const localBaseUrl = required("FEDERATION_LOCAL_BASE_URL");
  const localAdminKey = required("FEDERATION_LOCAL_ADMIN_KEY");

  const payload: ConnectPayload = {
    peerSlug: required("FEDERATION_REMOTE_PEER_SLUG"),
    peerDisplayName: required("FEDERATION_REMOTE_PEER_DISPLAY_NAME"),
    peerRole: (readEnvFallback("FEDERATION_REMOTE_PEER_ROLE") || "global") as ConnectPayload["peerRole"],
    peerBaseUrl: required("FEDERATION_REMOTE_BASE_URL"),
    peerPublicKey: required("FEDERATION_REMOTE_PEER_PUBLIC_KEY"),
  };

  const response = await fetch(`${localBaseUrl.replace(/\/$/, "")}/api/federation/peers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-node-admin-key": localAdminKey,
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Connect failed (${response.status}): ${JSON.stringify(json)}`);
  }

  console.log(JSON.stringify(json, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
