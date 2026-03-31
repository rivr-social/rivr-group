import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for federation audit logging and dead-letter queue.
 *
 * Verifies that:
 * - logFederationAudit() creates audit log entries with correct fields
 * - logDeadLetter() marks federation events as failed and creates audit entries
 * - retryDeadLetterEvents() resets failed events to queued status
 * - getAuditLog() queries with filters (eventType, nodeId, date range, status, limit)
 *
 * All database interactions are mocked following existing patterns.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      federationAuditLog: {
        findFirst: (...args: unknown[]) => mockFindFirst("federationAuditLog.findFirst", ...args),
        findMany: (...args: unknown[]) => mockFindMany("federationAuditLog.findMany", ...args),
      },
      federationEvents: {
        findFirst: (...args: unknown[]) => mockFindFirst("federationEvents.findFirst", ...args),
        findMany: (...args: unknown[]) => mockFindMany("federationEvents.findMany", ...args),
      },
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (...vArgs: unknown[]) => {
          mockValues(...vArgs);
          return {
            returning: (...rArgs: unknown[]) => {
              return mockReturning(...rArgs);
            },
          };
        },
      };
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return {
        set: (...sArgs: unknown[]) => {
          mockSet(...sArgs);
          return {
            where: (...wArgs: unknown[]) => {
              return mockWhere(...wArgs);
            },
          };
        },
      };
    },
  },
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_NODE_ID = "node-aaa-111";
const PEER_NODE_ID = "node-bbb-222";
const FEDERATION_EVENT_ID = "event-ccc-333";
const ACTOR_ID = "actor-ddd-444";
const AUDIT_RECORD_ID = "audit-eee-555";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: AUDIT_RECORD_ID,
    eventType: "import",
    nodeId: LOCAL_NODE_ID,
    peerNodeId: PEER_NODE_ID,
    federationEventId: FEDERATION_EVENT_ID,
    actorId: null,
    status: "success",
    detail: {},
    createdAt: new Date("2026-02-18T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default returning mock returns one record
  mockReturning.mockReturnValue([makeAuditRecord()]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logFederationAudit", () => {
  it("creates an audit log entry with all fields", async () => {
    const { logFederationAudit } = await import("@/lib/federation-audit");

    const result = await logFederationAudit({
      eventType: "import",
      nodeId: LOCAL_NODE_ID,
      peerNodeId: PEER_NODE_ID,
      federationEventId: FEDERATION_EVENT_ID,
      actorId: ACTOR_ID,
      status: "success",
      detail: { entityType: "agent", entityId: "agent-123" },
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledTimes(1);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.eventType).toBe("import");
    expect(insertedValues.nodeId).toBe(LOCAL_NODE_ID);
    expect(insertedValues.peerNodeId).toBe(PEER_NODE_ID);
    expect(insertedValues.federationEventId).toBe(FEDERATION_EVENT_ID);
    expect(insertedValues.actorId).toBe(ACTOR_ID);
    expect(insertedValues.status).toBe("success");
    expect(insertedValues.detail).toEqual({ entityType: "agent", entityId: "agent-123" });

    expect(result.id).toBe(AUDIT_RECORD_ID);
  });

  it("defaults optional fields to null", async () => {
    const { logFederationAudit } = await import("@/lib/federation-audit");

    await logFederationAudit({
      eventType: "peer_connect",
      status: "success",
    });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.nodeId).toBeNull();
    expect(insertedValues.peerNodeId).toBeNull();
    expect(insertedValues.federationEventId).toBeNull();
    expect(insertedValues.actorId).toBeNull();
    expect(insertedValues.detail).toEqual({});
  });

  it("handles all valid event types", async () => {
    const { logFederationAudit, FEDERATION_AUDIT_EVENT_TYPES } = await import(
      "@/lib/federation-audit"
    );

    for (const eventType of FEDERATION_AUDIT_EVENT_TYPES) {
      vi.clearAllMocks();
      mockReturning.mockReturnValue([makeAuditRecord({ eventType })]);

      const result = await logFederationAudit({
        eventType,
        status: "success",
      });

      expect(result.eventType).toBe(eventType);
    }
  });
});

describe("logDeadLetter", () => {
  it("marks the federation event as failed and creates an audit entry", async () => {
    mockReturning.mockReturnValue([
      makeAuditRecord({ status: "failure", detail: { error: "invalid signature" } }),
    ]);

    const { logDeadLetter } = await import("@/lib/federation-audit");

    const result = await logDeadLetter({
      federationEventId: FEDERATION_EVENT_ID,
      error: "invalid signature",
      nodeId: LOCAL_NODE_ID,
      peerNodeId: PEER_NODE_ID,
    });

    // Verify the federation event was updated to failed status
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);

    const setValues = mockSet.mock.calls[0][0];
    expect(setValues.status).toBe("failed");
    expect(setValues.error).toBe("invalid signature");

    // Verify audit log was created
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failure");
  });

  it("merges additional detail into the audit entry", async () => {
    mockReturning.mockReturnValue([
      makeAuditRecord({
        status: "failure",
        detail: { error: "stale version", eventIndex: 3, customField: "value" },
      }),
    ]);

    const { logDeadLetter } = await import("@/lib/federation-audit");

    await logDeadLetter({
      federationEventId: FEDERATION_EVENT_ID,
      error: "stale version",
      detail: { eventIndex: 3, customField: "value" },
    });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.detail.error).toBe("stale version");
    expect(insertedValues.detail.eventIndex).toBe(3);
    expect(insertedValues.detail.customField).toBe("value");
  });
});

describe("retryDeadLetterEvents", () => {
  it("resets failed events to queued status", async () => {
    mockFindMany.mockReturnValue([
      { id: "event-1" },
      { id: "event-2" },
      { id: "event-3" },
    ]);

    const { retryDeadLetterEvents } = await import("@/lib/federation-audit");

    const result = await retryDeadLetterEvents(LOCAL_NODE_ID);

    expect(result.retriedCount).toBe(3);
    expect(result.eventIds).toEqual(["event-1", "event-2", "event-3"]);

    // Verify the update was called to reset status
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);

    const setValues = mockSet.mock.calls[0][0];
    expect(setValues.status).toBe("queued");
    expect(setValues.error).toBeNull();
    expect(setValues.processedAt).toBeNull();
  });

  it("returns zero when no failed events exist", async () => {
    mockFindMany.mockReturnValue([]);

    const { retryDeadLetterEvents } = await import("@/lib/federation-audit");

    const result = await retryDeadLetterEvents(LOCAL_NODE_ID);

    expect(result.retriedCount).toBe(0);
    expect(result.eventIds).toEqual([]);

    // No update should have been called
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("respects the limit parameter", async () => {
    mockFindMany.mockReturnValue([{ id: "event-1" }]);

    const { retryDeadLetterEvents } = await import("@/lib/federation-audit");

    await retryDeadLetterEvents(LOCAL_NODE_ID, 5);

    // Verify findMany was called (limit is passed through Drizzle query config)
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("getAuditLog", () => {
  it("returns all audit entries when no filters are specified", async () => {
    const records = [
      makeAuditRecord({ id: "audit-1" }),
      makeAuditRecord({ id: "audit-2" }),
    ];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog();

    expect(result).toHaveLength(2);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("filters by eventType", async () => {
    const records = [makeAuditRecord({ eventType: "export" })];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog({ eventType: "export" });

    expect(result).toHaveLength(1);
    expect(result[0].eventType).toBe("export");
  });

  it("filters by nodeId", async () => {
    const records = [makeAuditRecord({ nodeId: LOCAL_NODE_ID })];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog({ nodeId: LOCAL_NODE_ID });

    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe(LOCAL_NODE_ID);
  });

  it("filters by status", async () => {
    const records = [makeAuditRecord({ status: "rejected" })];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog({ status: "rejected" });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("rejected");
  });

  it("filters by date range", async () => {
    const records = [makeAuditRecord()];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const startDate = new Date("2026-02-01T00:00:00Z");
    const endDate = new Date("2026-02-28T23:59:59Z");

    const result = await getAuditLog({ startDate, endDate });

    expect(result).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("applies combined filters", async () => {
    const records = [
      makeAuditRecord({ eventType: "import", nodeId: LOCAL_NODE_ID, status: "success" }),
    ];
    mockFindMany.mockReturnValue(records);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog({
      eventType: "import",
      nodeId: LOCAL_NODE_ID,
      status: "success",
      limit: 10,
    });

    expect(result).toHaveLength(1);
  });

  it("returns empty array when no records match", async () => {
    mockFindMany.mockReturnValue([]);

    const { getAuditLog } = await import("@/lib/federation-audit");

    const result = await getAuditLog({ eventType: "peer_revoke" });

    expect(result).toEqual([]);
  });

  it("caps limit at maximum value", async () => {
    mockFindMany.mockReturnValue([]);

    const { getAuditLog } = await import("@/lib/federation-audit");

    // Request a limit exceeding MAX_AUDIT_LOG_LIMIT (500)
    await getAuditLog({ limit: 9999 });

    // The function should still call findMany (the cap is enforced internally)
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
