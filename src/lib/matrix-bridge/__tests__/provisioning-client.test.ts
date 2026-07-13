import { describe, it, expect, vi } from "vitest";
import {
  listLoginFlows,
  startLogin,
  submitLoginStep,
  BridgeProvisioningError,
  type LoginStep,
} from "../provisioning-client";
import {
  getBridgeForProvider,
  listDeployedBridgeProviders,
  isBridgeProvider,
} from "../bridge-registry";

const CFG = { baseUrl: "https://bridge.example.test/" };
const TOKEN = "syt_matrix_token";
const MXID = "@alice:example.test";
const AUTH = { token: TOKEN, userId: MXID };

/** Builds a fetch stub that returns JSON with a chosen status, capturing calls. */
function jsonFetch(status: number, payload: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("provisioning client — requests", () => {
  it("lists login flows with a Bearer token against the normalized base URL", async () => {
    const fetchImpl = jsonFetch(200, { flows: [{ id: "qr", name: "QR" }] });
    const flows = await listLoginFlows(CFG, AUTH, fetchImpl as unknown as typeof fetch);
    expect(flows).toEqual([{ id: "qr", name: "QR" }]);
    const [url, init] = fetchImpl.mock.calls[0];
    // Trailing slash on baseUrl is normalized (no double slash).
    expect(url).toBe("https://bridge.example.test/_matrix/provision/v3/login/flows?user_id=%40alice%3Aexample.test");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("starts a login flow and returns the first step", async () => {
    const step: LoginStep = {
      type: "display_and_wait",
      login_id: "login-1",
      step_id: "qr-step",
      display_and_wait: { type: "qr", data: "sgnl://link?uuid=abc" },
    };
    const fetchImpl = jsonFetch(200, step);
    const result = await startLogin(CFG, AUTH, "qr-flow", fetchImpl as unknown as typeof fetch);
    expect(result.type).toBe("display_and_wait");
    expect(result.display_and_wait?.data).toContain("sgnl://");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://bridge.example.test/_matrix/provision/v3/login/start/qr-flow?user_id=%40alice%3Aexample.test",
    );
  });

  it("submits a step with inputs to the step endpoint and returns the next step", async () => {
    const next: LoginStep = { type: "complete", login_id: "login-1", step_id: "done", complete: { user_login_id: "s1", user_login_name: "+15551234567" } };
    const fetchImpl = jsonFetch(200, next);
    const result = await submitLoginStep(
      CFG,
      AUTH,
      { loginId: "login-1", stepId: "phone", stepType: "user_input", inputs: { phone_number: "+15551234567" } },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.type).toBe("complete");
    expect(result.complete?.user_login_name).toBe("+15551234567");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://bridge.example.test/_matrix/provision/v3/login/step/login-1/phone/user_input?user_id=%40alice%3Aexample.test",
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ phone_number: "+15551234567" });
  });

  it("re-polls a display_and_wait step with an empty body", async () => {
    const done: LoginStep = { type: "complete", login_id: "login-1", step_id: "done", complete: { user_login_id: "s1", user_login_name: "Alice" } };
    const fetchImpl = jsonFetch(200, done);
    await submitLoginStep(
      CFG,
      AUTH,
      { loginId: "login-1", stepId: "qr-step", stepType: "display_and_wait" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({});
  });

  it("throws a typed error carrying the bridge's message + status on failure", async () => {
    const fetchImpl = jsonFetch(403, { error: "user not whitelisted" });
    await expect(
      startLogin(CFG, AUTH, "qr", fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ name: "BridgeProvisioningError", status: 403, message: "user not whitelisted" });
  });

  it("surfaces a generic message when the error body has no error field", async () => {
    const fetchImpl = jsonFetch(500, "upstream boom");
    const error = await startLogin(CFG, AUTH, "qr", fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(error).toBeInstanceOf(BridgeProvisioningError);
    expect((error as BridgeProvisioningError).status).toBe(500);
  });
});

describe("bridge registry", () => {
  it("recognizes only messenger providers as bridge providers", () => {
    expect(isBridgeProvider("signal")).toBe(true);
    expect(isBridgeProvider("whatsapp")).toBe(true);
    expect(isBridgeProvider("notion")).toBe(false);
    expect(isBridgeProvider("google_calendar")).toBe(false);
  });

  it("resolves a bridge only when its URL env is set", () => {
    expect(getBridgeForProvider("signal", {})).toBeNull();
    const resolved = getBridgeForProvider("signal", { MAUTRIX_SIGNAL_URL: "https://signal.bridge.test" });
    expect(resolved?.config.baseUrl).toBe("https://signal.bridge.test");
    expect(resolved?.loginKind).toBe("qr");
  });

  it("lists exactly the deployed bridge providers", () => {
    const env = { MAUTRIX_SIGNAL_URL: "https://s", MAUTRIX_TELEGRAM_URL: "  " };
    // whitespace-only env is treated as not deployed
    expect(listDeployedBridgeProviders(env)).toEqual(["signal"]);
    expect(listDeployedBridgeProviders({})).toEqual([]);
  });
});
