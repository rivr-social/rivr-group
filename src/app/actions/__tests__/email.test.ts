/**
 * Tests for group email broadcast action (src/app/actions/email.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before module imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => mockAuth(),
}));

// DB chain: select().from().innerJoin().where() (no .limit for member queries)
const mockSelectLimit = vi.fn();
const mockSelectWhere = vi.fn(() => ({ limit: mockSelectLimit }));
const mockSelectInnerJoin = vi.fn(() => ({ where: mockSelectWhere }));
const mockSelectFrom = vi.fn(() => ({
  where: mockSelectWhere,
  innerJoin: mockSelectInnerJoin,
}));
const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

// DB chain: insert(table).values(vals)
const mockInsertValues = vi.fn(() => Promise.resolve());
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  agents: {
    id: "agents.id",
    name: "agents.name",
    email: "agents.email",
    deletedAt: "agents.deletedAt",
  },
  ledger: {
    id: "ledger.id",
    subjectId: "ledger.subjectId",
    objectId: "ledger.objectId",
    isActive: "ledger.isActive",
    verb: "ledger.verb",
    role: "ledger.role",
    expiresAt: "ledger.expiresAt",
  },
  emailLog: { id: "emailLog.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  isNull: vi.fn((col: unknown) => ({ op: "isNull", col })),
  sql: Object.assign(vi.fn(), {
    raw: vi.fn(),
  }),
}));

const mockRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  RATE_LIMITS: {
    EMAIL_BROADCAST: { limit: 2, windowMs: 3_600_000 },
  },
}));

const mockSendBulkEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendBulkEmail: (...args: unknown[]) => mockSendBulkEmail(...args),
}));

vi.mock("@/lib/email-templates", () => ({
  groupBroadcastEmail: vi.fn(() => ({
    subject: "[Test Group] Broadcast",
    html: "<p>broadcast</p>",
    text: "broadcast",
  })),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(() =>
    Promise.resolve(
      new Map([
        ["x-forwarded-for", "192.168.1.1"],
        ["user-agent", "TestAgent/1.0"],
      ])
    )
  ),
}));

// Import AFTER all mocks
import { sendGroupBroadcastAction } from "../email";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_UUID = "12345678-1234-1234-8234-123456789abc";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  mockRateLimit.mockResolvedValue({
    success: true,
    remaining: 1,
    resetMs: 3_600_000,
  });

  // Default: select returns empty
  mockSelectLimit.mockResolvedValue([]);
  mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
  mockInsertValues.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendGroupBroadcastAction", () => {
  it("rejects unauthenticated users", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const result = await sendGroupBroadcastAction(VALID_UUID, "Subject", "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Authentication required");
  });

  it("rejects invalid group ID", async () => {
    const result = await sendGroupBroadcastAction("not-a-uuid", "Subject", "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid group identifier");
  });

  it("rejects empty subject", async () => {
    const result = await sendGroupBroadcastAction(VALID_UUID, "", "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Subject is required");
  });

  it("rejects subject that is too long", async () => {
    const longSubject = "x".repeat(201);
    const result = await sendGroupBroadcastAction(VALID_UUID, longSubject, "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("200 characters");
  });

  it("rejects empty body", async () => {
    const result = await sendGroupBroadcastAction(VALID_UUID, "Subject", "");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Message body is required");
  });

  it("rejects body that is too long", async () => {
    const longBody = "x".repeat(10_001);
    const result = await sendGroupBroadcastAction(VALID_UUID, "Subject", longBody);
    expect(result.success).toBe(false);
    expect(result.error).toContain("10000 characters");
  });

  it("returns rate limit error when exceeded", async () => {
    mockRateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetMs: 60_000,
    });
    const result = await sendGroupBroadcastAction(VALID_UUID, "Subject", "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Too many broadcast requests");
  });

  it("rejects non-admin users", async () => {
    // Admin check: select().from().where().limit() returns empty
    mockSelectLimit.mockResolvedValue([]);

    const result = await sendGroupBroadcastAction(VALID_UUID, "Subject", "Body");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Only group admins");
  });
});
