/**
 * Tests for `src/lib/federation/peer-smtp.ts` (ticket #106).
 *
 * Covers:
 *   - resolvePeerSmtpSecret reads env vars and absolute paths correctly
 *   - getPeerSmtpConfig returns null when no row / disabled / empty secret
 *   - getPeerSmtpConfig resolves config with password filled in when
 *     everything is valid
 *   - the in-memory cache returns without re-hitting the DB for
 *     subsequent calls inside the TTL, and re-reads after the cache
 *     is reset
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `vi.mock` is hoisted to the top of the file, so the mock factory can't
// reference outer const bindings directly. We expose a mutable "controller"
// that tests drive from beforeEach hooks.
const dbMockController: {
  rows: unknown[];
  selectCalls: number;
} = { rows: [], selectCalls: 0 };

vi.mock("@/db", () => {
  return {
    db: {
      select: (...args: unknown[]) => {
        dbMockController.selectCalls += 1;
        void args;
        return {
          from: () => ({
            where: () => ({
              limit: async () => dbMockController.rows,
            }),
          }),
        };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import {
  getPeerSmtpConfig,
  resetPeerSmtpConfigCache,
  resolvePeerSmtpSecret,
} from "@/lib/federation/peer-smtp";
import { resetInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

function makeRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    instanceId: INSTANCE_ID,
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "peer@example.com",
    fromAddress: "peer@example.com",
    passwordSecretRef: "PEER_SMTP_PASSWORD",
    lastTestAt: null,
    lastTestStatus: null,
    lastTestError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.INSTANCE_ID = INSTANCE_ID;
  process.env.INSTANCE_TYPE = "person";
  delete process.env.PEER_SMTP_PASSWORD;
  resetInstanceConfig();
  resetPeerSmtpConfigCache();
  dbMockController.rows = [];
  dbMockController.selectCalls = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetInstanceConfig();
  resetPeerSmtpConfigCache();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolvePeerSmtpSecret
// ---------------------------------------------------------------------------

describe("resolvePeerSmtpSecret", () => {
  it("reads from a process.env var by name", () => {
    process.env.MY_TEST_SECRET = "hunter2";
    expect(resolvePeerSmtpSecret("MY_TEST_SECRET")).toBe("hunter2");
  });

  it("returns empty string for an env var that is unset", () => {
    expect(resolvePeerSmtpSecret("DEFINITELY_NOT_SET_XYZ")).toBe("");
  });

  it("reads from an absolute file path (Docker secret mount style)", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-smtp-test-"));
    const file = join(dir, "password");
    writeFileSync(file, "file-secret-value\n", "utf8");
    try {
      expect(resolvePeerSmtpSecret(file)).toBe("file-secret-value");
    } finally {
      unlinkSync(file);
    }
  });

  it("returns empty string when the referenced file does not exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolvePeerSmtpSecret("/definitely/not/a/real/path/xyz")).toBe("");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns empty string for an empty reference", () => {
    expect(resolvePeerSmtpSecret("")).toBe("");
    expect(resolvePeerSmtpSecret("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getPeerSmtpConfig
// ---------------------------------------------------------------------------

describe("getPeerSmtpConfig", () => {
  it("returns null when no row exists for the instance", async () => {
    dbMockController.rows = [];
    expect(await getPeerSmtpConfig()).toBeNull();
  });

  it("returns null when the row exists but is disabled", async () => {
    process.env.PEER_SMTP_PASSWORD = "p";
    dbMockController.rows = [makeRow({ enabled: false })];
    expect(await getPeerSmtpConfig()).toBeNull();
  });

  it("returns null when the password secret resolves to empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Env var is intentionally not set
    dbMockController.rows = [makeRow()];
    expect(await getPeerSmtpConfig()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("password secret"),
    );
  });

  it("returns a fully resolved config when row is enabled and secret is present", async () => {
    process.env.PEER_SMTP_PASSWORD = "resolved-value";
    dbMockController.rows = [makeRow()];
    const resolved = await getPeerSmtpConfig();
    expect(resolved).not.toBeNull();
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.host).toBe("smtp.example.com");
    expect(resolved?.password).toBe("resolved-value");
    expect(resolved?.passwordSecretRef).toBe("PEER_SMTP_PASSWORD");
  });

  it("caches the resolved config for subsequent calls", async () => {
    process.env.PEER_SMTP_PASSWORD = "p";
    dbMockController.rows = [makeRow()];

    const first = await getPeerSmtpConfig();
    const second = await getPeerSmtpConfig();
    expect(first).toEqual(second);
    expect(dbMockController.selectCalls).toBe(1);
  });

  it("re-reads after resetPeerSmtpConfigCache()", async () => {
    process.env.PEER_SMTP_PASSWORD = "p";
    dbMockController.rows = [makeRow()];

    await getPeerSmtpConfig();
    resetPeerSmtpConfigCache();
    await getPeerSmtpConfig();
    expect(dbMockController.selectCalls).toBe(2);
  });
});
