"use server";

/**
 * @file Group email broadcast server actions.
 * @description Exports `sendGroupBroadcastAction` for admin/moderator broadcasts to group members,
 * including authentication checks, authorization checks, request throttling, recipient resolution,
 * and delivery/audit logging.
 * @dependencies `@/auth`, `@/db`, `@/db/schema`, `@/lib/rate-limit`, `@/lib/email`,
 * `@/lib/email-templates`, `next/headers`, `drizzle-orm`
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger, emailLog } from "@/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendBulkEmail } from "@/lib/email";
import { groupBroadcastEmail } from "@/lib/email-templates";
import { getClientIp } from "@/lib/client-ip";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 10_000;

type BroadcastResult = {
  success: boolean;
  sent?: number;
  failed?: number;
  skipped?: number;
  error?: string;
};

function isEmailEnabled(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return true;
  }

  const record = metadata as Record<string, unknown>;
  const topLevel = record.emailNotifications;
  if (typeof topLevel === "boolean") {
    return topLevel;
  }

  const notificationSettings = record.notificationSettings;
  if (
    notificationSettings &&
    typeof notificationSettings === "object" &&
    !Array.isArray(notificationSettings)
  ) {
    const nested = (notificationSettings as Record<string, unknown>).emailNotifications;
    if (typeof nested === "boolean") {
      return nested;
    }
  }

  return true;
}

async function isGroupAdmin(userId: string, groupId: string): Promise<boolean> {
  const now = new Date();
  const [adminEntry] = await db
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        eq(ledger.subjectId, userId),
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
        or(eq(ledger.role, "admin"), eq(ledger.role, "moderator")),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > ${now}`)
      )
    )
    .limit(1);

  return !!adminEntry;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Send an email broadcast to all active members of a group.
 *
 * Auth requirement: caller must be authenticated and have admin/moderator membership for the group.
 * Rate limiting: enforced per IP + user ID using `RATE_LIMITS.EMAIL_BROADCAST`.
 * Error handling pattern: input/auth/authorization/rate-limit failures are returned as data.
 *
 * @param {string} groupId - UUID of the group whose members should receive the broadcast.
 * @param {string} subject - Email subject line.
 * @param {string} body - Plain message body authored by the sender.
 * @returns {Promise<BroadcastResult>} Count of sent/failed deliveries or an error reason.
 * @throws {never} This function reports expected and unexpected delivery issues in its return value.
 *
 * @example
 * const result = await sendGroupBroadcastAction(groupId, "Schedule Update", "Meeting moved to Friday.");
 * if (result.success) console.log(`${result.sent} delivered`);
 */
export async function sendGroupBroadcastAction(
  groupId: string,
  subject: string,
  body: string
): Promise<BroadcastResult> {
  // Auth check
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  // Validate inputs
  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!subject || subject.trim().length === 0) {
    return { success: false, error: "Subject is required." };
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    return {
      success: false,
      error: `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`,
    };
  }

  if (!body || body.trim().length === 0) {
    return { success: false, error: "Message body is required." };
  }

  if (body.length > MAX_BODY_LENGTH) {
    return {
      success: false,
      error: `Message body must be ${MAX_BODY_LENGTH} characters or fewer.`,
    };
  }

  // Throttle outbound campaigns to limit abuse and accidental rapid resend bursts.
  const headersList = await headers();
  const clientIp = getClientIp(headersList);

  const limiter = await rateLimit(
    `email_broadcast:${clientIp}:${session.user.id}`,
    RATE_LIMITS.EMAIL_BROADCAST.limit,
    RATE_LIMITS.EMAIL_BROADCAST.windowMs
  );

  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return {
      success: false,
      error: `Too many broadcast requests. Please try again in ${retryAfterSec} seconds.`,
    };
  }

  // Enforce server-side role check; client UI role controls are not trusted.
  const admin = await isGroupAdmin(session.user.id, groupId);
  if (!admin) {
    return {
      success: false,
      error: "Only group admins and moderators can send broadcasts.",
    };
  }

  // Get group info
  const [group] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  // Get sender info
  const [sender] = await db
    .select({ id: agents.id, name: agents.name, email: agents.email })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  if (!sender) {
    return { success: false, error: "Sender not found." };
  }

  // Include only currently active memberships and non-deleted agents with usable emails.
  const now = new Date();
  const memberRows = await db
    .select({
      agentId: ledger.subjectId,
      email: agents.email,
      name: agents.name,
      metadata: agents.metadata,
    })
    .from(ledger)
    .innerJoin(agents, eq(ledger.subjectId, agents.id))
    .where(
      and(
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, "belong"), eq(ledger.verb, "join")),
        or(isNull(ledger.expiresAt), sql`${ledger.expiresAt} > ${now}`),
        isNull(agents.deletedAt),
        sql`${agents.email} IS NOT NULL AND ${agents.email} != ''`
      )
    );

  // Deduplicate addresses so members with multiple ledger rows receive one email.
  const uniqueEmails = new Map<string, string>();
  const emailToAgentId = new Map<string, string>();
  for (const row of memberRows) {
    if (!row.email || !isEmailEnabled(row.metadata)) {
      continue;
    }

    if (!uniqueEmails.has(row.email)) {
      uniqueEmails.set(row.email, row.name);
      emailToAgentId.set(row.email, row.agentId);
    }
  }

  const recipients = Array.from(uniqueEmails.keys());

  if (recipients.length === 0) {
    return { success: false, error: "No group members with email addresses found." };
  }

  // Render both HTML and plaintext variants from the shared email template.
  const template = groupBroadcastEmail(
    group.name,
    sender.name,
    subject.trim(),
    body.trim()
  );

  // Execute provider bulk send; per-recipient outcomes are logged below.
  const results = await sendBulkEmail(
    recipients,
    template.subject,
    template.html,
    template.text,
    sender.email ? { replyTo: sender.email } : undefined,
  );

  // Persist delivery/audit logs for traceability and retry diagnostics.
  let sent = 0;
  let failed = 0;
  const skipped = memberRows.length - recipients.length;
  const logValues = [];

  for (const [email, result] of results) {
    if (result.success) {
      sent++;
    } else {
      failed++;
    }

    logValues.push({
      recipientEmail: email,
      recipientAgentId: emailToAgentId.get(email) ?? null,
      subject: template.subject,
      emailType: "group_broadcast" as const,
      status: result.success ? "sent" : "failed",
      messageId: result.messageId,
      error: result.error,
      metadata: { groupId, senderId: session.user.id },
    });
  }

  // Batch insert logs
  if (logValues.length > 0) {
    await db.insert(emailLog).values(logValues);
  }

  return { success: true, sent, failed, skipped };
}
