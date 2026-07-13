/**
 * mautrix bridgev2 provisioning API client.
 *
 * Modern mautrix bridges (signal, whatsapp, telegram, slack, …) share ONE
 * uniform login provisioning API, driven by the logged-in Matrix user's
 * access token. The bridge validates that token against its homeserver, so
 * the RIVR app never touches the messenger password/session — the user proves
 * identity to the upstream network directly (QR scan / phone code).
 *
 * Endpoints (base = the bridge's public provisioning URL):
 *   GET  {base}/_matrix/provision/v3/login/flows
 *   POST {base}/_matrix/provision/v3/login/start/{flowID}
 *   POST {base}/_matrix/provision/v3/login/step/{loginID}/{stepID}/{stepType}
 *
 * Every response is a {@link LoginStep} discriminated union on `type`. The
 * caller drives the flow until it reaches `complete` (or `cancel`s).
 *
 * `fetchImpl` is injectable so the client is unit-testable without a live
 * bridge.
 */

/** A selectable login flow advertised by a bridge. */
export interface LoginFlow {
  id: string;
  name: string;
  description?: string;
}

/** Field descriptor for a `user_input` step (phone number, code, …). */
export interface LoginInputField {
  /** Field key echoed back in the submit body. */
  id: string;
  /** Human label. */
  name: string;
  /** Input hint: `phone_number` | `2fa_code` | `email` | `password` | `token` | … */
  type: string;
  description?: string;
  pattern?: string;
}

/** `display_and_wait` payload — something to show while the bridge waits. */
export interface LoginDisplayData {
  /** `qr` (scan a QR built from `data`), `code` (type this code elsewhere), `emoji`, `nothing`. */
  type: string;
  /** The QR URI / pairing code / emoji to render. */
  data?: string;
  /** Optional pre-rendered image (mxc:// or http) the bridge already made. */
  image_url?: string;
}

export type LoginStepType = "display_and_wait" | "user_input" | "cookies" | "complete";

/**
 * One step in a bridge login flow. The active `type` field selects which of
 * the optional payloads is present.
 */
export interface LoginStep {
  type: LoginStepType;
  /** Opaque login-process id; thread it back into every subsequent submit. */
  login_id: string;
  /** Id of THIS step; thread it back when submitting this step's result. */
  step_id: string;
  /** Human instructions to display for this step. */
  instructions?: string;
  display_and_wait?: LoginDisplayData;
  user_input?: { fields: LoginInputField[] };
  cookies?: Record<string, unknown>;
  complete?: { user_login_id: string; user_login_name: string };
}

export interface BridgeProvisioningConfig {
  /** Public base URL of the bridge's provisioning API (no trailing slash). */
  baseUrl: string;
}

type FetchImpl = typeof fetch;

const PROVISION_BASE = "/_matrix/provision/v3";

export class BridgeProvisioningError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BridgeProvisioningError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function request<T>(
  cfg: BridgeProvisioningConfig,
  matrixToken: string,
  path: string,
  init: { method: string; body?: unknown },
  fetchImpl: FetchImpl,
): Promise<T> {
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${PROVISION_BASE}${path}`;
  const response = await fetchImpl(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${matrixToken}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as Record<string, unknown>).error)
        : `Bridge provisioning request failed (${response.status})`;
    throw new BridgeProvisioningError(message, response.status, parsed);
  }

  return parsed as T;
}

/** Lists the login flows a bridge supports for the given Matrix user. */
export async function listLoginFlows(
  cfg: BridgeProvisioningConfig,
  matrixToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginFlow[]> {
  const result = await request<{ flows?: LoginFlow[] }>(
    cfg,
    matrixToken,
    "/login/flows",
    { method: "GET" },
    fetchImpl,
  );
  return result.flows ?? [];
}

/** Starts a login flow, returning the first step. */
export async function startLogin(
  cfg: BridgeProvisioningConfig,
  matrixToken: string,
  flowId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginStep> {
  return request<LoginStep>(
    cfg,
    matrixToken,
    `/login/start/${encodeURIComponent(flowId)}`,
    { method: "POST" },
    fetchImpl,
  );
}

/**
 * Submits the result of a step (or re-polls a `display_and_wait` step with an
 * empty body) and returns the next step. For `display_and_wait`, call this
 * with no `inputs` to long-poll until the external login completes.
 */
export async function submitLoginStep(
  cfg: BridgeProvisioningConfig,
  matrixToken: string,
  params: { loginId: string; stepId: string; stepType: LoginStepType; inputs?: Record<string, string> },
  fetchImpl: FetchImpl = fetch,
): Promise<LoginStep> {
  const { loginId, stepId, stepType, inputs } = params;
  return request<LoginStep>(
    cfg,
    matrixToken,
    `/login/step/${encodeURIComponent(loginId)}/${encodeURIComponent(stepId)}/${encodeURIComponent(stepType)}`,
    { method: "POST", body: inputs ?? {} },
    fetchImpl,
  );
}
