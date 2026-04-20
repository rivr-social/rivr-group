/**
 * Tests for per-kind routing in `src/lib/mailer.ts` (ticket #106).
 *
 * Complements `mailer.test.ts` by specifically pinning down the
 * contract introduced in #106:
 *
 *   - Federated-auth kinds (verification, password-reset, recovery)
 *     on a peer ALWAYS go through the global relay, even when the
 *     peer has its own SMTP configured and enabled.
 *   - Transactional kind on a peer with peer SMTP configured goes
 *     through the peer's own transport (not the relay, not local).
 *   - Transactional kind on a peer with NO peer SMTP configured
 *     falls through to the global relay.
 *   - Global instance ignores peer SMTP entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the unit under test.
// ---------------------------------------------------------------------------

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    })),
  },
}));

const mockSendEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockSendEmailViaGlobal = vi.fn();
vi.mock("@/lib/federation/email-relay", () => {
  class EmailRelayError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(message: string, code: string, status?: number) {
      super(message);
      this.name = "EmailRelayError";
      this.code = code;
      this.status = status;
    }
  }
  const EMAIL_RELAY_KINDS = {
    VERIFICATION: "verification",
    PASSWORD_RESET: "password-reset",
    RECOVERY: "recovery",
    TRANSACTIONAL: "transactional",
  } as const;
  return {
    EmailRelayError,
    EMAIL_RELAY_KINDS,
    EMAIL_RELAY_KIND_SET: new Set(Object.values(EMAIL_RELAY_KINDS)),
    sendEmailViaGlobal: (...args: unknown[]) => mockSendEmailViaGlobal(...args),
  };
});

const mockGetPeerSmtpConfig = vi.fn();
vi.mock("@/lib/federation/peer-smtp", () => ({
  getPeerSmtpConfig: (...args: unknown[]) => mockGetPeerSmtpConfig(...args),
  resetPeerSmtpConfigCache: vi.fn(),
}));

const mockSendViaPeerSmtp = vi.fn();
vi.mock("@/lib/federation/peer-smtp-transport", () => ({
  sendViaPeerSmtp: (...args: unknown[]) => mockSendViaPeerSmtp(...args),
  resetPeerSmtpTransportCache: vi.fn(),
  verifyPeerSmtpConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  FEDERATED_AUTH_EMAIL_KINDS,
  isFederatedAuthEmailKind,
  sendTransactionalEmail,
} from "@/lib/mailer";
import { EMAIL_RELAY_KINDS } from "@/lib/federation/email-relay";
import { resetInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

const PEER_INSTANCE_ID = "77777777-7777-4777-8777-777777777777";
const PEER_BASE_URL = "https://spirit-of-the-front-range.rivr.social";
const GLOBAL_URL = "https://a.rivr.social";

const BASE = {
  to: "alice@example.com",
  subject: "s",
  html: "<p>h</p>",
  text: "h",
} as const;

const MOCK_PEER_SMTP = {
  id: "11111111-2222-4222-8222-222222222222",
  instanceId: PEER_INSTANCE_ID,
  enabled: true,
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  username: "peer@example.com",
  fromAddress: "peer@example.com",
  password: "resolved-secret",
  passwordSecretRef: "PEER_SMTP_PASSWORD",
  lastTestAt: null,
  lastTestStatus: null,
  lastTestError: null,
};

function makePeerEnv(): void {
  process.env.INSTANCE_TYPE = "person";
  process.env.INSTANCE_ID = PEER_INSTANCE_ID;
  process.env.NEXT_PUBLIC_BASE_URL = PEER_BASE_URL;
  process.env.GLOBAL_IDENTITY_AUTHORITY_URL = GLOBAL_URL;
  resetInstanceConfig();
}

function makeGlobalEnv(): void {
  process.env.INSTANCE_TYPE = "global";
  resetInstanceConfig();
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.INSTANCE_TYPE;
  delete process.env.INSTANCE_ID;
  delete process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
  resetInstanceConfig();
  mockSendEmail.mockReset();
  mockSendEmailViaGlobal.mockReset();
  mockGetPeerSmtpConfig.mockReset();
  mockSendViaPeerSmtp.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetInstanceConfig();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

describe("FEDERATED_AUTH_EMAIL_KINDS", () => {
  it("includes verification, password-reset, and recovery", () => {
    expect(FEDERATED_AUTH_EMAIL_KINDS).toContain(
      EMAIL_RELAY_KINDS.VERIFICATION,
    );
    expect(FEDERATED_AUTH_EMAIL_KINDS).toContain(
      EMAIL_RELAY_KINDS.PASSWORD_RESET,
    );
    expect(FEDERATED_AUTH_EMAIL_KINDS).toContain(EMAIL_RELAY_KINDS.RECOVERY);
  });

  it("does NOT include generic transactional", () => {
    expect(FEDERATED_AUTH_EMAIL_KINDS).not.toContain(
      EMAIL_RELAY_KINDS.TRANSACTIONAL,
    );
  });

  it("isFederatedAuthEmailKind returns true for each auth kind", () => {
    for (const k of FEDERATED_AUTH_EMAIL_KINDS) {
      expect(isFederatedAuthEmailKind(k)).toBe(true);
    }
  });

  it("isFederatedAuthEmailKind returns false for transactional", () => {
    expect(isFederatedAuthEmailKind("transactional")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Peer + federated-auth kind → global relay (never peer SMTP)
// ---------------------------------------------------------------------------

describe("peer + federated-auth kind", () => {
  beforeEach(() => {
    makePeerEnv();
    // Simulate a configured + enabled peer SMTP to prove it is IGNORED.
    mockGetPeerSmtpConfig.mockResolvedValue(MOCK_PEER_SMTP);
    mockSendEmailViaGlobal.mockResolvedValue({
      ok: true,
      messageId: "<relay-ok>",
      emailLogId: "log-1",
    });
  });

  it("verification kind routes to global relay even when peer SMTP is enabled", async () => {
    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.VERIFICATION,
    });
    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    expect(mockSendViaPeerSmtp).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(result.delegated).toBe(true);
    expect(result.success).toBe(true);
    // Peer SMTP config shouldn't even be consulted on auth-kind path.
    expect(mockGetPeerSmtpConfig).not.toHaveBeenCalled();
  });

  it("password-reset kind routes to global relay regardless of peer SMTP", async () => {
    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.PASSWORD_RESET,
    });
    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    expect(mockSendViaPeerSmtp).not.toHaveBeenCalled();
    expect(result.delegated).toBe(true);
    expect(result.success).toBe(true);
  });

  it("recovery kind routes to global relay regardless of peer SMTP", async () => {
    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.RECOVERY,
    });
    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    expect(mockSendViaPeerSmtp).not.toHaveBeenCalled();
    expect(result.delegated).toBe(true);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Peer + transactional kind → peer SMTP when configured, else relay
// ---------------------------------------------------------------------------

describe("peer + transactional kind", () => {
  beforeEach(() => {
    makePeerEnv();
  });

  it("uses peer SMTP transport when peer config is enabled", async () => {
    mockGetPeerSmtpConfig.mockResolvedValue(MOCK_PEER_SMTP);
    mockSendViaPeerSmtp.mockResolvedValue({
      success: true,
      messageId: "<peer-smtp-ok>",
    });

    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
    });

    expect(mockSendViaPeerSmtp).toHaveBeenCalledOnce();
    expect(mockSendViaPeerSmtp).toHaveBeenCalledWith(
      MOCK_PEER_SMTP,
      expect.objectContaining({
        to: BASE.to,
        subject: BASE.subject,
      }),
    );
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      messageId: "<peer-smtp-ok>",
      error: undefined,
      delegated: false,
    });
  });

  it("falls through to global relay when peer SMTP is not configured (null)", async () => {
    mockGetPeerSmtpConfig.mockResolvedValue(null);
    mockSendEmailViaGlobal.mockResolvedValue({
      ok: true,
      messageId: "<fallback-relay>",
      emailLogId: "log",
    });

    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
    });

    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    expect(mockSendViaPeerSmtp).not.toHaveBeenCalled();
    expect(result.delegated).toBe(true);
    expect(result.success).toBe(true);
  });

  it("surfaces peer SMTP transport failures without throwing", async () => {
    mockGetPeerSmtpConfig.mockResolvedValue(MOCK_PEER_SMTP);
    mockSendViaPeerSmtp.mockResolvedValue({
      success: false,
      error: "EAUTH: auth failed",
    });

    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("EAUTH");
    expect(result.delegated).toBe(false);
  });

  it("falls through to global relay when peer SMTP load throws", async () => {
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetPeerSmtpConfig.mockRejectedValue(new Error("db not ready"));
    mockSendEmailViaGlobal.mockResolvedValue({
      ok: true,
      messageId: "<fallback-on-throw>",
      emailLogId: "log",
    });

    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
    });

    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    expect(result.delegated).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Global instance → always local, peer SMTP never consulted
// ---------------------------------------------------------------------------

describe("global instance ignores peer SMTP", () => {
  beforeEach(() => {
    makeGlobalEnv();
    mockSendEmail.mockResolvedValue({
      success: true,
      messageId: "<global-local>",
    });
  });

  it("transactional kind uses local sendEmail", async () => {
    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
    });
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockGetPeerSmtpConfig).not.toHaveBeenCalled();
    expect(mockSendViaPeerSmtp).not.toHaveBeenCalled();
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    expect(result.delegated).toBe(false);
  });

  it("verification kind uses local sendEmail", async () => {
    const result = await sendTransactionalEmail({
      ...BASE,
      kind: EMAIL_RELAY_KINDS.VERIFICATION,
    });
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(result.delegated).toBe(false);
  });
});
