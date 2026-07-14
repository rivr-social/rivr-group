"use server";

/**
 * Newsletter compose + delivery actions (Wave 4 WS-B1).
 *
 * Newsletters are GROUP-scoped: a group/org admin composes a newsletter
 * from their press feed or a free-form body, then sends it to all active
 * person members with a usable email address who have NOT turned off email
 * notifications in their settings (the same `isEmailEnabled` opt-out gate group
 * broadcasts respect — see `@/lib/email-preferences`). Each outbound message
 * carries an unsubscribe/preferences footer pointing at the member's own
 * notification settings.
 *
 * Security model (verified-principal rule):
 * - All actions require an authenticated session.
 * - Create/update/send/list are further gated by group admin/manage access.
 * - Recipient email addresses are resolved server-side ONLY and are never
 *   returned to any client-facing payload.
 * - `sendNewsletterAction` is idempotent against already-sent newsletters.
 *
 * Storage model: newsletters are stored as `post` Resources in the existing
 * resources table. No DB migration is needed. The `metadata.entityType`
 * field carries `"newsletter"` to distinguish them from ordinary posts.
 * The group is the owner (`ownerId = groupId`). Visibility is `"members"` —
 * only active members can view a newsletter resource, matching the send scope.
 *
 * Email delivery uses `sendBulkTransactionalEmail` from `@/lib/mailer` with
 * kind `"transactional"` (the appropriate catch-all for member communications
 * that are not federated-auth flows). The SMTP backend is opaque to this
 * module — it will be Gmail today and might be Postal tomorrow.
 *
 * Key exports:
 * - {@link createNewsletterDraftAction}
 * - {@link updateNewsletterDraftAction}
 * - {@link composeNewsletterFromPressAction}
 * - {@link sendNewsletterAction}
 * - {@link listGroupNewslettersAction}
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { and, eq, sql, desc, isNull } from "drizzle-orm";

import {
  sendBulkTransactionalEmail,
  TRANSACTIONAL_EMAIL_KINDS,
} from "@/lib/mailer";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { fetchGroupPressFeedAction, type PressFeedItem } from "@/app/actions/press";
import { createResourceWithLedger } from "@/app/actions/resource-creation/helpers";
import { getGroupMembers } from "@/lib/queries/agents";
import { isEmailEnabled } from "@/lib/email-preferences";
import { getInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Resource type used to persist newsletter records — reuses the existing post bucket. */
const NEWSLETTER_RESOURCE_TYPE = "post" as const;

/** Value stored in `metadata.entityType` to identify newsletter resources. */
const NEWSLETTER_ENTITY_TYPE = "newsletter" as const;

/** Email kind — transactional covers member communications that aren't auth flows. */
const NEWSLETTER_EMAIL_KIND = TRANSACTIONAL_EMAIL_KINDS.TRANSACTIONAL;

/** Newsletter draft status. */
const NEWSLETTER_STATUS_DRAFT = "draft" as const;

/** Newsletter sent status. */
const NEWSLETTER_STATUS_SENT = "sent" as const;

/** Visibility for newsletter resources — visible to members, not the public. */
const NEWSLETTER_VISIBILITY = "members" as const;

/** UUID validation pattern (RFC 4122). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Path (relative to the instance base URL) to the settings page where a member
 * turns email notifications off. This app's settings live at `/settings`; the
 * Notifications tab is selected via the `?tab=notifications` query param.
 */
const SETTINGS_NOTIFICATIONS_PATH = "/settings?tab=notifications" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata shape stored in the newsletter resource row.
 * Fields mirror what `createEventResource` does with event metadata — rich
 * jsonb that carries all domain state without touching the schema.
 */
export interface NewsletterMetadata {
  entityType: "newsletter";
  subject: string;
  bodyHtml: string;
  status: "draft" | "sent";
  sentAt: string | null;
  recipientCount: number | null;
  sourcePressItemIds: string[];
}

/**
 * Client-safe newsletter summary returned to admin UIs.
 * Does NOT include recipient emails.
 */
export interface NewsletterSummary {
  id: string;
  groupId: string;
  subject: string;
  bodyHtml: string;
  status: "draft" | "sent";
  sentAt: string | null;
  recipientCount: number | null;
  sourcePressItemIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Generic action result shape consistent with other server actions in this repo.
 */
export interface NewsletterActionResult {
  success: boolean;
  message: string;
  newsletterId?: string;
  error?: string;
}

/**
 * Result returned by `composeNewsletterFromPressAction`.
 */
export interface ComposeFromPressResult {
  success: boolean;
  subject: string;
  bodyHtml: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validates that `id` is a well-formed UUID. Returns the trimmed value or null.
 */
function validateUuid(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Extracts and validates `NewsletterMetadata` from an unknown resource row.
 * Returns null when the row is not a newsletter resource.
 */
function parseNewsletterMetadata(
  raw: unknown,
): NewsletterMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;
  if (meta.entityType !== NEWSLETTER_ENTITY_TYPE) return null;

  return {
    entityType: NEWSLETTER_ENTITY_TYPE,
    subject: typeof meta.subject === "string" ? meta.subject : "",
    bodyHtml: typeof meta.bodyHtml === "string" ? meta.bodyHtml : "",
    status:
      meta.status === NEWSLETTER_STATUS_SENT
        ? NEWSLETTER_STATUS_SENT
        : NEWSLETTER_STATUS_DRAFT,
    sentAt: typeof meta.sentAt === "string" ? meta.sentAt : null,
    recipientCount:
      typeof meta.recipientCount === "number" ? meta.recipientCount : null,
    sourcePressItemIds: Array.isArray(meta.sourcePressItemIds)
      ? (meta.sourcePressItemIds as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
  };
}

/**
 * Maps a raw resources row + parsed metadata to the client-safe `NewsletterSummary`.
 */
function toNewsletterSummary(
  row: {
    id: string;
    ownerId: string;
    name: string;
    metadata: unknown;
    createdAt: Date | null;
    updatedAt: Date | null;
  },
  meta: NewsletterMetadata,
): NewsletterSummary {
  return {
    id: row.id,
    groupId: row.ownerId,
    subject: meta.subject,
    bodyHtml: meta.bodyHtml,
    status: meta.status,
    sentAt: meta.sentAt,
    recipientCount: meta.recipientCount,
    sourcePressItemIds: meta.sourcePressItemIds,
    createdAt: row.createdAt?.toISOString() ?? new Date(0).toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? new Date(0).toISOString(),
  };
}

/**
 * Builds a plain-text fallback from an HTML newsletter body.
 * Used as the text part for email clients that prefer it.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolves the settings-notifications URL for this instance from the instance
 * config base URL. Non-tracking: a plain link to the member's own notification
 * settings, no per-user token — the opt-out is the member's GLOBAL preference,
 * which is the correct unsubscribe mechanism for member-scoped mail.
 */
function resolveNotificationSettingsUrl(): string {
  const baseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");
  return `${baseUrl}${SETTINGS_NOTIFICATIONS_PATH}`;
}

/**
 * Builds the HTML unsubscribe/preferences footer appended to the OUTBOUND email
 * body only (the stored newsletter resource is never mutated). Values are
 * HTML-escaped so the footer stays valid regardless of the settings URL.
 */
function buildUnsubscribeFooterHtml(settingsUrl: string): string {
  const href = escapeHtml(settingsUrl);
  return `
<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0 16px;" />
<p style="font-size: 12px; color: #9ca3af; margin: 0;">
  You're receiving this because you're a member of this group. To stop receiving
  email updates, turn off email notifications in your
  <a href="${href}" style="color: #6b7280;">RIVR notification settings</a>.
</p>`.trim();
}

/**
 * Plain-text counterpart to {@link buildUnsubscribeFooterHtml} for the text part.
 */
function buildUnsubscribeFooterText(settingsUrl: string): string {
  return [
    "",
    "—",
    "You're receiving this because you're a member of this group.",
    `To stop receiving email updates, turn off email notifications in your RIVR notification settings: ${settingsUrl}`,
  ].join("\n");
}

/**
 * Resolves member emails for a group entirely on the server. Returns a list
 * of `{ email, agentId }` pairs where email is non-null and non-empty AND the
 * member has NOT turned off email notifications in their settings.
 *
 * The opt-out gate reuses {@link isEmailEnabled} (the same predicate group
 * broadcasts use), so a member's global email-notification preference set in
 * `/settings` → Notifications governs newsletter delivery too. Members who
 * disabled email notifications are excluded from the recipient set.
 *
 * Emails are NEVER returned to client callers — only consumed within server actions.
 */
async function resolveGroupMemberEmails(
  groupId: string,
): Promise<Array<{ email: string; agentId: string }>> {
  const members = await getGroupMembers(groupId);

  return members
    .filter(
      (member): member is typeof member & { email: string } =>
        member.type === "person" &&
        typeof member.email === "string" &&
        member.email.trim().length > 0 &&
        isEmailEnabled(member.metadata),
    )
    .map((member) => ({ email: member.email.trim(), agentId: member.id }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Creates a draft newsletter Resource owned by the given group.
 *
 * Permission gate: caller must be a group admin or manager.
 * The newsletter is stored as a `post` resource with
 * `metadata.entityType = "newsletter"` and `metadata.status = "draft"`.
 * Visibility is `"members"` so only group members see it in resource queries.
 *
 * @param params.groupId - UUID of the owning group.
 * @param params.subject - Newsletter subject line (also used as the resource name).
 * @param params.bodyHtml - HTML body of the newsletter.
 * @param params.sourcePressItemIds - Optional IDs of press items that were pulled in.
 * @returns Result carrying the new resource ID on success.
 */
export async function createNewsletterDraftAction(params: {
  groupId: string;
  subject: string;
  bodyHtml: string;
  sourcePressItemIds?: string[];
}): Promise<NewsletterActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      message: "Authentication required.",
      error: "UNAUTHENTICATED",
    };
  }

  const groupId = validateUuid(params.groupId);
  if (!groupId) {
    return {
      success: false,
      message: "Invalid group ID.",
      error: "INVALID_INPUT",
    };
  }

  if (!params.subject?.trim()) {
    return {
      success: false,
      message: "A subject line is required.",
      error: "INVALID_INPUT",
    };
  }

  if (!params.bodyHtml?.trim()) {
    return {
      success: false,
      message: "A newsletter body is required.",
      error: "INVALID_INPUT",
    };
  }

  const admin = await isGroupAdmin(userId, groupId);
  if (!admin) {
    return {
      success: false,
      message: "Only group admins can create newsletters.",
      error: "FORBIDDEN",
    };
  }

  const metadata: NewsletterMetadata = {
    entityType: NEWSLETTER_ENTITY_TYPE,
    subject: params.subject.trim(),
    bodyHtml: params.bodyHtml,
    status: NEWSLETTER_STATUS_DRAFT,
    sentAt: null,
    recipientCount: null,
    sourcePressItemIds: params.sourcePressItemIds ?? [],
  };

  const result = await createResourceWithLedger({
    ownerId: groupId,
    name: params.subject.trim(),
    type: NEWSLETTER_RESOURCE_TYPE,
    description: `Newsletter: ${params.subject.trim()}`,
    content: params.bodyHtml,
    visibility: NEWSLETTER_VISIBILITY,
    tags: ["newsletter"],
    metadata: metadata as unknown as Record<string, unknown>,
  });

  if (!result.success || !result.resourceId) {
    return {
      success: false,
      message: result.message ?? "Failed to create newsletter draft.",
      error: result.error?.code ?? "SERVER_ERROR",
    };
  }

  revalidatePath(`/groups/${groupId}`);

  return {
    success: true,
    message: "Newsletter draft created.",
    newsletterId: result.resourceId,
  };
}

/**
 * Updates an existing draft newsletter. Only drafts may be updated —
 * sent newsletters are immutable.
 *
 * Permission gate: caller must be a group admin on the owning group.
 *
 * @param params.newsletterId - UUID of the newsletter resource to update.
 * @param params.subject - New subject line (optional, existing value is preserved when omitted).
 * @param params.bodyHtml - New HTML body (optional).
 * @returns Standard action result.
 */
export async function updateNewsletterDraftAction(params: {
  newsletterId: string;
  subject?: string;
  bodyHtml?: string;
}): Promise<NewsletterActionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      message: "Authentication required.",
      error: "UNAUTHENTICATED",
    };
  }

  const newsletterId = validateUuid(params.newsletterId);
  if (!newsletterId) {
    return {
      success: false,
      message: "Invalid newsletter ID.",
      error: "INVALID_INPUT",
    };
  }

  // Load the existing newsletter resource.
  const [existing] = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, newsletterId),
        eq(resources.type, NEWSLETTER_RESOURCE_TYPE),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!existing) {
    return {
      success: false,
      message: "Newsletter not found.",
      error: "NOT_FOUND",
    };
  }

  const existingMeta = parseNewsletterMetadata(existing.metadata);
  if (!existingMeta) {
    return {
      success: false,
      message: "Resource is not a newsletter.",
      error: "INVALID_INPUT",
    };
  }

  if (existingMeta.status === NEWSLETTER_STATUS_SENT) {
    return {
      success: false,
      message: "Sent newsletters cannot be edited.",
      error: "FORBIDDEN",
    };
  }

  // Admin gate — checked against the owning group.
  const admin = await isGroupAdmin(userId, existing.ownerId);
  if (!admin) {
    return {
      success: false,
      message: "Only group admins can update newsletters.",
      error: "FORBIDDEN",
    };
  }

  const nextSubject =
    params.subject !== undefined ? params.subject.trim() : existingMeta.subject;
  const nextBodyHtml =
    params.bodyHtml !== undefined ? params.bodyHtml : existingMeta.bodyHtml;

  if (!nextSubject) {
    return {
      success: false,
      message: "Subject line cannot be empty.",
      error: "INVALID_INPUT",
    };
  }

  const nextMeta: NewsletterMetadata = {
    ...existingMeta,
    subject: nextSubject,
    bodyHtml: nextBodyHtml,
  };

  await db
    .update(resources)
    .set({
      name: nextSubject,
      content: nextBodyHtml,
      metadata: nextMeta as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, newsletterId));

  revalidatePath(`/groups/${existing.ownerId}`);

  return {
    success: true,
    message: "Newsletter draft updated.",
    newsletterId,
  };
}

/**
 * Assembles default newsletter HTML from a selection of press feed items.
 *
 * This is a pure composition helper — it does NOT persist anything. The
 * resulting HTML is returned to the caller (e.g. the editor UI) so the admin
 * can review and refine before saving or sending.
 *
 * @param params.groupId - Group whose press feed is fetched.
 * @param params.pressItemIds - IDs of press items to include. When empty all
 *   items from the feed are included (up to 8).
 * @returns Assembled subject + HTML for the editor to load.
 */
export async function composeNewsletterFromPressAction(params: {
  groupId: string;
  pressItemIds: string[];
}): Promise<ComposeFromPressResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      subject: "",
      bodyHtml: "",
      error: "Authentication required.",
    };
  }

  const groupId = validateUuid(params.groupId);
  if (!groupId) {
    return {
      success: false,
      subject: "",
      bodyHtml: "",
      error: "Invalid group ID.",
    };
  }

  // Fetch the group name for a default subject.
  const [groupRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  const groupName = groupRow?.name ?? "Your Group";
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const feed = await fetchGroupPressFeedAction(groupId);
  const allItems: PressFeedItem[] = [...feed.articles, ...feed.media];

  // If pressItemIds were supplied, filter to just those; otherwise include all.
  const selectedItems =
    params.pressItemIds.length > 0
      ? allItems.filter((item) => params.pressItemIds.includes(item.id))
      : allItems;

  const subject = `${groupName} Newsletter — ${today}`;

  if (selectedItems.length === 0) {
    const bodyHtml = `
<h1>${groupName} Newsletter</h1>
<p>${today}</p>
<p>Nothing to share this week — check back soon!</p>
`.trim();
    return { success: true, subject, bodyHtml };
  }

  const itemsHtml = selectedItems
    .map(
      (item) => `
<div style="margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid #e5e7eb;">
  <h2 style="margin: 0 0 8px; font-size: 18px;">
    <a href="${escapeHtml(item.url)}" style="color: #1d4ed8; text-decoration: none;">${escapeHtml(item.title)}</a>
  </h2>
  ${item.excerpt ? `<p style="margin: 0 0 8px; color: #374151;">${escapeHtml(item.excerpt)}</p>` : ""}
  <p style="margin: 0; font-size: 13px; color: #6b7280;">
    ${escapeHtml(item.source.charAt(0).toUpperCase() + item.source.slice(1))}
    ${item.publishedAt ? ` &mdash; ${escapeHtml(new Date(item.publishedAt).toLocaleDateString())}` : ""}
  </p>
  <a href="${escapeHtml(item.url)}" style="display:inline-block; margin-top: 8px; color: #2563eb;">Read more &rarr;</a>
</div>`.trim(),
    )
    .join("\n");

  const bodyHtml = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <h1 style="font-size: 24px; margin-bottom: 4px;">${escapeHtml(groupName)} Newsletter</h1>
  <p style="color: #6b7280; margin-top: 0;">${escapeHtml(today)}</p>
  <hr style="border: none; border-top: 2px solid #e5e7eb; margin: 24px 0;" />
  ${itemsHtml}
  <p style="font-size: 12px; color: #9ca3af; margin-top: 32px;">
    You're receiving this because you're a member of ${escapeHtml(groupName)}.
  </p>
</div>`.trim();

  return {
    success: true,
    subject,
    bodyHtml,
  };
}

/**
 * Sends a newsletter to all active group members with a usable email address
 * who have email notifications enabled (members who opted out in their settings
 * are excluded). Each outbound email gets an unsubscribe/preferences footer;
 * the stored newsletter body is NOT mutated.
 *
 * Permission gate: caller must be a group admin.
 * Idempotency: refuses to re-send a newsletter that has already been sent.
 * Security: recipient emails are resolved server-side only and are NEVER
 *   included in the return value or any client-facing payload.
 *
 * After a successful send the resource is updated:
 * - `metadata.status` → `"sent"`
 * - `metadata.sentAt` → ISO timestamp of the send
 * - `metadata.recipientCount` → number of recipients addressed
 *
 * Partial delivery failures (individual recipient SMTP errors) do NOT abort
 * the send or roll back the status — the mailer already swallows individual
 * transport errors. The send is considered successful when the bulk call
 * completes without throwing.
 *
 * @param params.newsletterId - UUID of the newsletter resource to send.
 * @returns Result with delivery metadata (no emails exposed).
 */
export async function sendNewsletterAction(params: {
  newsletterId: string;
}): Promise<NewsletterActionResult & { recipientCount?: number }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      message: "Authentication required.",
      error: "UNAUTHENTICATED",
    };
  }

  const newsletterId = validateUuid(params.newsletterId);
  if (!newsletterId) {
    return {
      success: false,
      message: "Invalid newsletter ID.",
      error: "INVALID_INPUT",
    };
  }

  // Load the newsletter.
  const [existing] = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, newsletterId),
        eq(resources.type, NEWSLETTER_RESOURCE_TYPE),
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!existing) {
    return {
      success: false,
      message: "Newsletter not found.",
      error: "NOT_FOUND",
    };
  }

  const meta = parseNewsletterMetadata(existing.metadata);
  if (!meta) {
    return {
      success: false,
      message: "Resource is not a newsletter.",
      error: "INVALID_INPUT",
    };
  }

  // Idempotency guard — refuse double-send.
  if (meta.status === NEWSLETTER_STATUS_SENT) {
    return {
      success: false,
      message: "This newsletter has already been sent.",
      error: "ALREADY_SENT",
    };
  }

  if (!meta.subject?.trim() || !meta.bodyHtml?.trim()) {
    return {
      success: false,
      message: "Newsletter must have a subject and body before sending.",
      error: "INVALID_INPUT",
    };
  }

  // Admin gate — checked against the owning group.
  const admin = await isGroupAdmin(userId, existing.ownerId);
  if (!admin) {
    return {
      success: false,
      message: "Only group admins can send newsletters.",
      error: "FORBIDDEN",
    };
  }

  // Resolve recipients server-side — emails stay on the server.
  const recipients = await resolveGroupMemberEmails(existing.ownerId);

  if (recipients.length === 0) {
    return {
      success: false,
      message: "No members with email addresses found for this group.",
      error: "NO_RECIPIENTS",
    };
  }

  const recipientEmails = recipients.map((r) => r.email);
  const agentIdMap = new Map(recipients.map((r) => [r.email, r.agentId]));

  // Build email-to-agentId lookup for relay audit provenance.
  const agentIdFor = (email: string): string | undefined =>
    agentIdMap.get(email);

  // Append the unsubscribe/preferences footer to the OUTBOUND content only —
  // the stored newsletter resource keeps its authored body untouched.
  const settingsUrl = resolveNotificationSettingsUrl();
  const outboundHtml = `${meta.bodyHtml}\n${buildUnsubscribeFooterHtml(settingsUrl)}`;
  const outboundText = `${htmlToPlainText(meta.bodyHtml)}\n${buildUnsubscribeFooterText(settingsUrl)}`;

  // Bulk send — individual failures are swallowed by the mailer.
  await sendBulkTransactionalEmail(recipientEmails, {
    kind: NEWSLETTER_EMAIL_KIND,
    subject: meta.subject,
    html: outboundHtml,
    text: outboundText,
    agentIdFor,
    meta: {
      newsletterId,
      groupId: existing.ownerId,
      sentByUserId: userId,
    },
  });

  // Mark as sent.
  const sentAt = new Date().toISOString();
  const nextMeta: NewsletterMetadata = {
    ...meta,
    status: NEWSLETTER_STATUS_SENT,
    sentAt,
    recipientCount: recipients.length,
  };

  await db
    .update(resources)
    .set({
      metadata: nextMeta as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, newsletterId));

  revalidatePath(`/groups/${existing.ownerId}`);

  return {
    success: true,
    message: `Newsletter sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`,
    newsletterId,
    recipientCount: recipients.length,
  };
}

/**
 * Lists all newsletters (drafts + sent) for a group, newest first.
 *
 * Permission gate: caller must be a group admin. Regular members see the
 * newsletter as a post resource via their normal feed — this admin-facing
 * action returns the full list including unsent drafts.
 *
 * @param groupId - UUID of the group.
 * @returns Array of `NewsletterSummary` sorted by creation date descending.
 */
export async function listGroupNewslettersAction(
  groupId: string,
): Promise<{ success: boolean; newsletters: NewsletterSummary[]; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      newsletters: [],
      error: "Authentication required.",
    };
  }

  const resolvedGroupId = validateUuid(groupId);
  if (!resolvedGroupId) {
    return {
      success: false,
      newsletters: [],
      error: "Invalid group ID.",
    };
  }

  const admin = await isGroupAdmin(userId, resolvedGroupId);
  if (!admin) {
    return {
      success: false,
      newsletters: [],
      error: "Only group admins can view the newsletter list.",
    };
  }

  const rows = await db
    .select({
      id: resources.id,
      ownerId: resources.ownerId,
      name: resources.name,
      metadata: resources.metadata,
      createdAt: resources.createdAt,
      updatedAt: resources.updatedAt,
    })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, resolvedGroupId),
        eq(resources.type, NEWSLETTER_RESOURCE_TYPE),
        sql`${resources.metadata}->>'entityType' = ${NEWSLETTER_ENTITY_TYPE}`,
        sql`${resources.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(resources.createdAt));

  const newsletters: NewsletterSummary[] = rows
    .map((row) => {
      const meta = parseNewsletterMetadata(row.metadata);
      if (!meta) return null;
      return toNewsletterSummary(row, meta);
    })
    .filter((n): n is NewsletterSummary => n !== null);

  return { success: true, newsletters };
}

// ---------------------------------------------------------------------------
// Internal utility — not exported
// ---------------------------------------------------------------------------

/**
 * Minimal HTML entity escaping for values interpolated into composed HTML.
 * Only covers the characters that matter in attribute values and text nodes.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
