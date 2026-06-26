import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/connectors/gmail-save", () => ({
  resolveGmailToken: vi.fn(async () => "gmail-access-token"),
}));

import {
  buildRawMessage,
  runConnectorSendEmail,
  sendGmailMessage,
} from "@/lib/connectors/gmail-send";

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("buildRawMessage", () => {
  it("assembles a text/plain RFC822 message with To/Subject headers", () => {
    const raw = buildRawMessage({ to: "alice@example.com", subject: "Hi", body: "Hello there" });
    const mime = decodeRaw(raw);
    expect(mime).toContain("To: alice@example.com");
    expect(mime).toContain("Subject: Hi");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime.endsWith("Hello there")).toBe(true);
  });

  it("uses text/html when html flag is set", () => {
    const raw = buildRawMessage({ to: "a@b.co", subject: "S", body: "<b>x</b>", html: true });
    expect(decodeRaw(raw)).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it("rejects recipients containing header-injection newlines", () => {
    expect(() =>
      buildRawMessage({ to: "a@b.co\r\nBcc: evil@x.co", subject: "S", body: "x" }),
    ).toThrow(/recipient/i);
  });

  it("rejects malformed email addresses", () => {
    expect(() => buildRawMessage({ to: "not-an-email", subject: "S", body: "x" })).toThrow(/valid email/i);
  });

  it("strips CR/LF from the subject to prevent header smuggling", () => {
    const raw = buildRawMessage({ to: "a@b.co", subject: "Line1\r\nInjected: header", body: "x" });
    const mime = decodeRaw(raw);
    expect(mime).toContain("Subject: Line1 Injected: header");
    expect(mime).not.toContain("\r\nInjected: header");
  });
});

describe("sendGmailMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the raw message and returns the sent id/thread", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "msg-1", threadId: "thr-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendGmailMessage("agent-1", {
      to: "alice@example.com",
      subject: "Hello",
      body: "Body text",
    });

    expect(result).toMatchObject({
      provider: "gmail",
      messageId: "msg-1",
      threadId: "thr-1",
      to: "alice@example.com",
      subject: "Hello",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/messages/send");
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(typeof sentBody.raw).toBe("string");
    expect(decodeRaw(sentBody.raw)).toContain("To: alice@example.com");
  });

  it("surfaces an honest reconnect error on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(
      sendGmailMessage("agent-1", { to: "a@b.co", subject: "S", body: "x" }),
    ).rejects.toThrow(/reconnect/i);
  });

  it("surfaces a provider error with status on non-OK responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    await expect(
      sendGmailMessage("agent-1", { to: "a@b.co", subject: "S", body: "x" }),
    ).rejects.toThrow(/Gmail API error \(500\)/);
  });
});

describe("runConnectorSendEmail", () => {
  it("rejects providers that do not support email send", async () => {
    await expect(
      runConnectorSendEmail("agent-1", "notion", { to: "a@b.co", subject: "S", body: "x" }),
    ).rejects.toThrow(/not supported/i);
  });
});
