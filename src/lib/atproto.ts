const ATPROTO_CREATE_SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession";
const ATPROTO_HANDLE_PATTERN = /^(?=.{3,253}$)(?!-)(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

export interface AtprotoIdentity {
  handle: string;
  did: string;
}

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function validateAtprotoHandle(handle: string): string {
  const normalized = normalizeHandle(handle);
  if (!ATPROTO_HANDLE_PATTERN.test(normalized)) {
    throw new Error("Enter a valid Bluesky handle.");
  }
  return normalized;
}

export async function verifyAtprotoCredentials(input: {
  handle: string;
  appPassword: string;
}): Promise<AtprotoIdentity> {
  const handle = validateAtprotoHandle(input.handle);
  const appPassword = input.appPassword.trim();

  if (appPassword.length < 8) {
    throw new Error("Enter a valid Bluesky app password.");
  }

  const response = await fetch(ATPROTO_CREATE_SESSION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      identifier: handle,
      password: appPassword,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | { handle?: string; did?: string; message?: string; error?: string }
    | null;

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      "Bluesky rejected those credentials. Use an app password, not your main account password.";
    throw new Error(message);
  }

  const resolvedHandle = typeof payload?.handle === "string" ? validateAtprotoHandle(payload.handle) : handle;
  const did = typeof payload?.did === "string" ? payload.did.trim() : "";
  if (!did.startsWith("did:")) {
    throw new Error("Bluesky did not return a valid DID.");
  }

  return { handle: resolvedHandle, did };
}
