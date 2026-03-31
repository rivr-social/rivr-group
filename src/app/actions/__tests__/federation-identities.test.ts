import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { agents } from "@/db/schema";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

const MOCK_FEDERATION_STATUS = {
  peermesh: { linked: false, handle: null, did: null },
  atproto: { linked: false, handle: null, did: null },
};

vi.mock("@/lib/federation-identities", () => ({
  buildFederationIdentityStatus: vi.fn().mockResolvedValue({
    peermesh: { linked: false, handle: null, did: null },
    atproto: { linked: false, handle: null, did: null },
  }),
}));

vi.mock("@/lib/peermesh", () => ({
  parsePeermeshIdentityInput: vi.fn().mockResolvedValue({
    handle: "alice@peermesh.social",
    did: "did:peer:12345",
    publicKey: "pk_test_abc",
    manifestId: "manifest-123",
    manifestUrl: "https://peermesh.social/manifest/123",
  }),
}));

vi.mock("@/lib/atproto", () => ({
  verifyAtprotoCredentials: vi.fn().mockResolvedValue({
    handle: "alice.bsky.social",
    did: "did:plc:abc123",
  }),
}));

// Import AFTER all mocks
import { auth } from "@/auth";
import { buildFederationIdentityStatus } from "@/lib/federation-identities";
import { parsePeermeshIdentityInput } from "@/lib/peermesh";
import { verifyAtprotoCredentials } from "@/lib/atproto";
import {
  getFederationIdentityStatusAction,
  linkPeermeshIdentityAction,
  unlinkPeermeshIdentityAction,
  linkAtprotoIdentityAction,
  unlinkAtprotoIdentityAction,
} from "../federation-identities";

// =============================================================================
// Tests
// =============================================================================

describe("federation-identities actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildFederationIdentityStatus).mockResolvedValue(MOCK_FEDERATION_STATUS);
  });

  // ===========================================================================
  // getFederationIdentityStatusAction
  // ===========================================================================

  describe("getFederationIdentityStatusAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await getFederationIdentityStatusAction();
        expect(result.success).toBe(false);
        expect(result.error).toContain("signed in");
      }));

    it("returns federation status for authenticated user", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await getFederationIdentityStatusAction();
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(vi.mocked(buildFederationIdentityStatus)).toHaveBeenCalledWith(user.id);
      }));
  });

  // ===========================================================================
  // linkPeermeshIdentityAction
  // ===========================================================================

  describe("linkPeermeshIdentityAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await linkPeermeshIdentityAction({ manifestInput: "test" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("signed in");
      }));

    it("links peermesh identity and updates agent record", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await linkPeermeshIdentityAction({
          manifestInput: "https://peermesh.social/manifest/123",
        });

        expect(result.success).toBe(true);
        expect(vi.mocked(parsePeermeshIdentityInput)).toHaveBeenCalledWith(
          "https://peermesh.social/manifest/123"
        );

        // Verify agent was updated in DB
        const [updated] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));
        expect(updated.peermeshHandle).toBe("alice@peermesh.social");
        expect(updated.peermeshDid).toBe("did:peer:12345");
        expect(updated.peermeshLinkedAt).toBeDefined();
      }));

    it("returns error when peermesh parsing fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(parsePeermeshIdentityInput).mockRejectedValueOnce(
          new Error("Invalid manifest URL")
        );

        const result = await linkPeermeshIdentityAction({ manifestInput: "bad-url" });
        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid manifest URL");
      }));
  });

  // ===========================================================================
  // unlinkPeermeshIdentityAction
  // ===========================================================================

  describe("unlinkPeermeshIdentityAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await unlinkPeermeshIdentityAction();
        expect(result.success).toBe(false);
      }));

    it("clears peermesh fields from agent record", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // First link, then unlink
        await linkPeermeshIdentityAction({ manifestInput: "test" });
        const result = await unlinkPeermeshIdentityAction();

        expect(result.success).toBe(true);

        const [updated] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));
        expect(updated.peermeshHandle).toBeNull();
        expect(updated.peermeshDid).toBeNull();
        expect(updated.peermeshLinkedAt).toBeNull();
      }));
  });

  // ===========================================================================
  // linkAtprotoIdentityAction
  // ===========================================================================

  describe("linkAtprotoIdentityAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await linkAtprotoIdentityAction({
          handle: "alice.bsky.social",
          appPassword: "test-pass",
        });
        expect(result.success).toBe(false);
      }));

    it("links atproto identity and updates agent record", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await linkAtprotoIdentityAction({
          handle: "alice.bsky.social",
          appPassword: "test-pass",
        });

        expect(result.success).toBe(true);
        expect(vi.mocked(verifyAtprotoCredentials)).toHaveBeenCalledWith({
          handle: "alice.bsky.social",
          appPassword: "test-pass",
        });

        const [updated] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));
        expect(updated.atprotoHandle).toBe("alice.bsky.social");
        expect(updated.atprotoDid).toBe("did:plc:abc123");
        expect(updated.atprotoLinkedAt).toBeDefined();
      }));

    it("returns error when atproto verification fails", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(verifyAtprotoCredentials).mockRejectedValueOnce(
          new Error("Invalid credentials")
        );

        const result = await linkAtprotoIdentityAction({
          handle: "alice.bsky.social",
          appPassword: "wrong-pass",
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid credentials");
      }));
  });

  // ===========================================================================
  // unlinkAtprotoIdentityAction
  // ===========================================================================

  describe("unlinkAtprotoIdentityAction", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await unlinkAtprotoIdentityAction();
        expect(result.success).toBe(false);
      }));

    it("clears atproto fields from agent record", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        // First link, then unlink
        await linkAtprotoIdentityAction({
          handle: "alice.bsky.social",
          appPassword: "test-pass",
        });
        const result = await unlinkAtprotoIdentityAction();

        expect(result.success).toBe(true);

        const [updated] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, user.id));
        expect(updated.atprotoHandle).toBeNull();
        expect(updated.atprotoDid).toBeNull();
        expect(updated.atprotoLinkedAt).toBeNull();
      }));
  });
});
