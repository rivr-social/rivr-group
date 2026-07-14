/**
 * Tests for the newsletter email-notification opt-out gate (backlog D25).
 *
 * `sendNewsletterAction` must exclude members who turned OFF email
 * notifications in their settings (`metadata.notificationSettings.emailNotifications
 * = false` or top-level `metadata.emailNotifications = false`), reusing the
 * shared `isEmailEnabled` predicate. Coverage:
 * - A group with one opted-in and one opted-out person member sends ONLY to the
 *   opted-in member; `recipientCount` reflects the single eligible recipient
 *   and the opted-out address never reaches the mailer.
 * - When every member has opted out the send returns the clean NO_RECIPIENTS
 *   error and the mailer is never called.
 * - The opted-in default (unset preference) is still included.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestGroup, createTestResource } from "@/test/fixtures";
import { mockAuthSession } from "@/test/auth-helpers";

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
 * Mock the mailer so no real SMTP is touched; capture the recipient list the
 * send path passes so the opt-out filtering can be asserted directly.
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

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { sendBulkTransactionalEmail } from "@/lib/mailer";
import { sendNewsletterAction } from "../newsletter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds a draft newsletter resource owned by `ownerId`, mirroring the storage
 * shape (`post` resource + `metadata.entityType = "newsletter"`).
 */
async function seedDraftNewsletter(
  db: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
  ownerId: string,
) {
  return createTestResource(db, ownerId, {
    name: "Opt-out Newsletter",
    type: "post",
    visibility: "members",
    tags: ["newsletter"],
    metadata: {
      entityType: "newsletter",
      subject: "Opt-out Newsletter",
      bodyHtml: "<p>Hello eligible members!</p>",
      status: "draft",
      sentAt: null,
      recipientCount: null,
      sourcePressItemIds: [],
    },
  });
}

/** Reads the recipient-email array captured by the mailer mock's first call. */
function capturedRecipientEmails(): string[] {
  const call = vi.mocked(sendBulkTransactionalEmail).mock.calls[0];
  expect(call).toBeDefined();
  return call![0];
}

// ===========================================================================
// sendNewsletterAction — email-notification opt-out gate
// ===========================================================================

describe("sendNewsletterAction — email opt-out gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGroupAdmin).mockResolvedValue(false);
    vi.mocked(sendBulkTransactionalEmail).mockResolvedValue(new Map());
  });

  it("excludes members who disabled email notifications from the recipient set", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db);
      const group = await createTestGroup(db);

      // Opted-IN member: nested preference explicitly true.
      const optedIn = await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "opted-in@example.com",
        metadata: { notificationSettings: { emailNotifications: true } },
      });

      // Opted-OUT member: nested preference explicitly false.
      const optedOut = await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "opted-out@example.com",
        metadata: { notificationSettings: { emailNotifications: false } },
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedDraftNewsletter(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(true);
      // Only the opted-in member counts.
      expect(result.recipientCount).toBe(1);

      // The mailer received exactly the opted-in address, never the opt-out one.
      expect(sendBulkTransactionalEmail).toHaveBeenCalledOnce();
      const emails = capturedRecipientEmails();
      expect(emails).toEqual(["opted-in@example.com"]);
      expect(emails).not.toContain("opted-out@example.com");

      // Sanity: the two members are distinct rows.
      expect(optedIn.id).not.toBe(optedOut.id);
    }));

  it("appends the unsubscribe/preferences footer to the outbound email only", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db);
      const group = await createTestGroup(db);
      await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "member@example.com",
        metadata: {},
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedDraftNewsletter(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(true);
      const params = vi.mocked(sendBulkTransactionalEmail).mock.calls[0]![1];
      // Footer present in BOTH parts, linking to the notifications settings.
      expect(params.html).toContain("notification settings");
      expect(params.html).toContain("/settings?tab=notifications");
      expect(params.text).toContain("/settings?tab=notifications");
      // Original authored body still present, unmodified.
      expect(params.html).toContain("Hello eligible members!");
    }));

  it("includes members whose preference is unset (default opted-in)", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db);
      const group = await createTestGroup(db);
      await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "default@example.com",
        metadata: {}, // no preference set → enabled by default
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedDraftNewsletter(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(true);
      expect(result.recipientCount).toBe(1);
      expect(capturedRecipientEmails()).toEqual(["default@example.com"]);
    }));

  it("returns NO_RECIPIENTS when every member opted out", () =>
    withTestTransaction(async (db) => {
      const admin = await createTestAgent(db);
      const group = await createTestGroup(db);
      await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "off-1@example.com",
        metadata: { emailNotifications: false },
      });
      await createTestAgent(db, {
        parentId: group.id,
        type: "person",
        email: "off-2@example.com",
        metadata: { notificationSettings: { emailNotifications: false } },
      });

      vi.mocked(auth).mockResolvedValue(mockAuthSession(admin.id));
      vi.mocked(isGroupAdmin).mockResolvedValue(true);

      const nl = await seedDraftNewsletter(db, group.id);
      const result = await sendNewsletterAction({ newsletterId: nl.id });

      expect(result.success).toBe(false);
      expect(result.error).toBe("NO_RECIPIENTS");
      expect(sendBulkTransactionalEmail).not.toHaveBeenCalled();
    }));
});
