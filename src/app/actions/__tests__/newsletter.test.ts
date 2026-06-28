/**
 * Tests for newsletter server actions (Wave 4 WS-B1).
 *
 * Coverage:
 * - createNewsletterDraftAction: auth gate, permission gate (non-admin rejected),
 *   input validation, happy-path draft creation.
 * - updateNewsletterDraftAction: auth gate, not-found, sent-newsletter immutability,
 *   admin gate, happy-path update.
 * - composeNewsletterFromPressAction: auth gate, HTML assembled from items,
 *   empty-group fallback.
 * - sendNewsletterAction: auth gate, not-found, double-send idempotency guard,
 *   admin gate, recipient resolution + mailer call, status update,
 *   emails NEVER leaked to any return value.
 * - listGroupNewslettersAction: auth gate, admin gate, returns drafts + sent.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";

// ---------------------------------------------------------------------------
// Mocks — set up before any module import (vi.mock is hoisted)
// ---------------------------------------------------------------------------

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

vi.mock("@/app/actions/group-admin", () => ({
  isGroupAdmin: vi.fn().mockResolvedValue(false),
}));

/**
 * Mock the mailer so tests never touch real SMTP.
 * The mock captures calls and returns success by default.
 */
vi.mock("@/lib/mailer", () => ({
  sendBulkTransactionalEmail: vi.fn().mockResolvedValue(new Map()),
  sendTransactionalEmail: vi.fn().mockResolvedValue({ success: true, delegated: false }),
  TRANSACTIONAL_EMAIL_KINDS: {
    VERIFICATION: "verification",
    PASSWORD_RESET: "password-reset",
    RECOVERY: "recovery",
    TRANSACTIONAL: "transactional",
  },
}));

/**
 * Mock the press action — only the composeFromPress path needs it; send path
 * uses getGroupMembers directly via lib/queries/agents which goes through the
 * test DB.
 */
vi.mock("@/app/actions/press", async () => {
  const original = await import("@/app/actions/press");
  return {
    ...original,
    fetchGroupPressFeedAction: vi.fn().mockResolvedValue({
      sources: {},
      articles: [
        {
          id: "press-item-1",
          title: "Test Article",
          excerpt: "A test excerpt.",
          url: "https://example.com/article-1",
          publishedAt: "2026-06-01T00:00:00Z",
          source: "substack",
        },
        {
          id: "press-item-2",
          title: "Test Video",
          url: "https://youtube.com/watch?v=abc",
          source: "youtube",
        },
      ],
      media: [],
      sourceErrors: {},
    }),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { sendBulkTransactionalEmail } from "@/lib/mailer";
import {
  createNewsletterDraftAction,
  updateNewsletterDraftAction,
  composeNewsletterFromPressAction,
  sendNewsletterAction,
  listGroupNewslettersAction,
} from "../newsletter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INVALID_UUID = "not-a-uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds a newsletter resource row directly via createTestResource so tests
 * that exercise update/send/list don't depend on createNewsletterDraftAction.
 */
async function seedNewsletterResource(
  db: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
  ownerId: string,
  overrides: {
    status?: "draft" | "sent";
    subject?: string;
    bodyHtml?: string;
  } = {},
) {
  const status = overrides.status ?? "draft";
  const subject = overrides.subject ?? "Test Newsletter Subject";
  const bodyHtml = overrides.bodyHtml ?? "<p>Hello members!</p>";

  return createTestResource(db, ownerId, {
    name: subject,
    type: "post",
    visibility: "members",
    tags: ["newsletter"],
    metadata: {
      entityType: "newsletter",
      subject,
      bodyHtml,
      status,
      sentAt: status === "sent" ? new Date().toISOString() : null,
      recipientCount: status === "sent" ? 5 : null,
      sourcePressItemIds: [],
    },
  });
}

// ===========================================================================
// createNewsletterDraftAction
// ===========================================================================

describe("createNewsletterDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
  });

  it("rejects unauthenticated callers", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await createNewsletterDraftAction({
        groupId: "00000000-0000-4000-8000-000000000001",
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("UNAUTHENTICATED");
    }));

  it("rejects invalid group UUID", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await createNewsletterDraftAction({
        groupId: INVALID_UUID,
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("INVALID_INPUT");
    }));

  it("rejects non-admin callers", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(false);

      const result = await createNewsletterDraftAction({
        groupId: group.id,
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("FORBIDDEN");
    }));

  it("rejects empty subject", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await createNewsletterDraftAction({
        groupId: group.id,
        subject: "   ",
        bodyHtml: "<p>Hi</p>",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("INVALID_INPUT");
    }));

  it("rejects empty body", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await createNewsletterDraftAction({
        groupId: group.id,
        subject: "Hello",
        bodyHtml: "",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("INVALID_INPUT");
    }));

  it("creates a draft newsletter resource when admin", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await createNewsletterDraftAction({
        groupId: group.id,
        subject: "My First Newsletter",
        bodyHtml: "<p>Welcome members!</p>",
        sourcePressItemIds: ["press-item-1"],
      });

      expect(result.success).toBe(true);
      expect(typeof result.newsletterId).toBe("string");
      expect(result.newsletterId!.length).toBeGreaterThan(0);
    }));
});

// ===========================================================================
// updateNewsletterDraftAction
// ===========================================================================

describe("updateNewsletterDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
  });

  it("rejects unauthenticated callers", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await updateNewsletterDraftAction({
        newsletterId: "00000000-0000-4000-8000-000000000001",
        subject: "Updated",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("UNAUTHENTICATED");
    }));

  it("returns NOT_FOUND for a non-existent newsletter", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await updateNewsletterDraftAction({
        newsletterId: "00000000-0000-4000-8000-000000000001",
        subject: "Updated",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("NOT_FOUND");
    }));

  it("refuses to update a sent newsletter", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id, { status: "sent" });

      const result = await updateNewsletterDraftAction({
        newsletterId: nl.id,
        subject: "Try to change",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("FORBIDDEN");
    }));

  it("rejects non-admin caller", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      // isGroupAdmin returns false (default in this describe)

      const nl = await seedNewsletterResource(db, group.id);
      const result = await updateNewsletterDraftAction({
        newsletterId: nl.id,
        subject: "Sneaky update",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("FORBIDDEN");
    }));

  it("updates subject and body for an admin", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id);
      const result = await updateNewsletterDraftAction({
        newsletterId: nl.id,
        subject: "Updated Subject",
        bodyHtml: "<p>Updated body</p>",
      });
      expect(result.success).toBe(true);
      expect(result.newsletterId).toBe(nl.id);
    }));
});

// ===========================================================================
// composeNewsletterFromPressAction
// ===========================================================================

describe("composeNewsletterFromPressAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated callers", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await composeNewsletterFromPressAction({
        groupId: "00000000-0000-4000-8000-000000000001",
        pressItemIds: [],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Authentication/i);
    }));

  it("assembles HTML containing press item titles and links", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db, { name: "My Org" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await composeNewsletterFromPressAction({
        groupId: group.id,
        pressItemIds: ["press-item-1"],
      });

      expect(result.success).toBe(true);
      expect(result.bodyHtml).toContain("Test Article");
      expect(result.bodyHtml).toContain("https://example.com/article-1");
      expect(result.subject).toMatch(/My Org/);
    }));

  it("returns all items when no pressItemIds are specified", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db, { name: "Org2" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await composeNewsletterFromPressAction({
        groupId: group.id,
        pressItemIds: [],
      });

      expect(result.success).toBe(true);
      // Both mock press items should appear (article + video).
      expect(result.bodyHtml).toContain("Test Article");
      expect(result.bodyHtml).toContain("Test Video");
    }));

  it("returns a fallback when no items match the filter", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db, { name: "Empty Org" });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await composeNewsletterFromPressAction({
        groupId: group.id,
        pressItemIds: ["nonexistent-item-id"],
      });

      expect(result.success).toBe(true);
      expect(result.bodyHtml).toContain("Nothing to share");
    }));
});

// ===========================================================================
// sendNewsletterAction
// ===========================================================================

describe("sendNewsletterAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
    vi.mocked(sendBulkTransactionalEmail).mockResolvedValue(new Map());
  });

  it("rejects unauthenticated callers", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await sendNewsletterAction({
        newsletterId: "00000000-0000-4000-8000-000000000001",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("UNAUTHENTICATED");
    }));

  it("returns NOT_FOUND for a non-existent newsletter", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await sendNewsletterAction({
        newsletterId: "00000000-0000-4000-8000-000000000001",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("NOT_FOUND");
    }));

  it("refuses to double-send an already-sent newsletter", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id, { status: "sent" });
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(false);
      expect(result.error).toBe("ALREADY_SENT");
      // Mailer must never have been called.
      expect(sendBulkTransactionalEmail).not.toHaveBeenCalled();
    }));

  it("rejects non-admin callers", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      // isGroupAdmin defaults to false in this describe's beforeEach.

      const nl = await seedNewsletterResource(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(false);
      expect(result.error).toBe("FORBIDDEN");
      expect(sendBulkTransactionalEmail).not.toHaveBeenCalled();
    }));

  it("returns NO_RECIPIENTS when the group has no members with emails", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      // Group created without any members.
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(false);
      expect(result.error).toBe("NO_RECIPIENTS");
      expect(sendBulkTransactionalEmail).not.toHaveBeenCalled();
    }));

  it("calls the bulk mailer and marks the newsletter sent", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      // Add a member with an email as a child agent.
      await createTestAgent(db, {
        parentId: group.id,
        email: "member@example.com",
        type: "person",
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id, {
        subject: "Important Update",
        bodyHtml: "<p>Hi members!</p>",
      });

      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(true);
      expect(result.recipientCount).toBe(1);

      // Mailer was called once with the correct kind + subject.
      expect(sendBulkTransactionalEmail).toHaveBeenCalledOnce();
      const [recipientEmails, params] = vi.mocked(sendBulkTransactionalEmail).mock.calls[0]!;
      expect(Array.isArray(recipientEmails)).toBe(true);
      expect(recipientEmails).toHaveLength(1);
      expect(params.subject).toBe("Important Update");
      expect(params.kind).toBe("transactional");
    }));

  it("does NOT expose member emails in the return value", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      await createTestAgent(db, {
        parentId: group.id,
        email: "secret@example.com",
        type: "person",
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedNewsletterResource(db, group.id, {
        subject: "Shhh",
        bodyHtml: "<p>Private</p>",
      });

      const result = await sendNewsletterAction({ newsletterId: nl.id });

      // The result must not leak any email addresses.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("secret@example.com");
      expect(serialized).not.toContain("@example.com");
    }));
});

// ===========================================================================
// listGroupNewslettersAction
// ===========================================================================

describe("listGroupNewslettersAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
  });

  it("rejects unauthenticated callers", () =>
    withTestTransaction(async () => {
      vi.mocked(auth).mockResolvedValue(mockUnauthenticated());
      const result = await listGroupNewslettersAction(
        "00000000-0000-4000-8000-000000000001",
      );
      expect(result.success).toBe(false);
      expect(result.newsletters).toHaveLength(0);
    }));

  it("rejects non-admin callers", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

      const result = await listGroupNewslettersAction(group.id);
      expect(result.success).toBe(false);
      expect(result.newsletters).toHaveLength(0);
    }));

  it("returns an empty list when no newsletters exist", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const result = await listGroupNewslettersAction(group.id);
      expect(result.success).toBe(true);
      expect(result.newsletters).toHaveLength(0);
    }));

  it("returns both drafts and sent newsletters", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      await seedNewsletterResource(db, group.id, { status: "draft", subject: "Draft One" });
      await seedNewsletterResource(db, group.id, { status: "sent", subject: "Sent One" });

      const result = await listGroupNewslettersAction(group.id);
      expect(result.success).toBe(true);
      expect(result.newsletters).toHaveLength(2);

      const subjects = result.newsletters.map((n) => n.subject);
      expect(subjects).toContain("Draft One");
      expect(subjects).toContain("Sent One");
    }));

  it("does not expose recipient emails in the newsletter list", () =>
    withTestTransaction(async (db) => {
      const user = await createTestAgent(db);
      const group = await createTestGroup(db);
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      await createTestAgent(db, {
        parentId: group.id,
        email: "priv@example.com",
        type: "person",
      });
      await seedNewsletterResource(db, group.id, { status: "sent" });

      const result = await listGroupNewslettersAction(group.id);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("priv@example.com");
    }));
});
