"use server";

/**
 * Profile settings server actions for authenticated account updates and email-verification workflows.
 *
 * Purpose:
 * - Validate and normalize profile fields before persistence.
 * - Apply per-user settings rate limiting to protect update endpoints.
 * - Trigger security-sensitive email change side effects (verification + old-email notification).
 *
 * Key exports:
 * - `updateProfileAction`
 * - `UpdateProfileInput` (input contract)
 *
 * Core dependencies:
 * - Authentication (`@/auth`)
 * - Database writes and token/email logs (`@/db`, `@/db/schema`)
 * - Rate limiting (`@/lib/rate-limit`)
 * - Email delivery/templates (`@/lib/email`, `@/lib/email-templates`)
 *
 * Security and error-handling patterns:
 * - Only authenticated users can mutate profile data.
 * - Input is validated with bounded lengths and format checks before DB writes.
 * - Email changes invalidate verification state and issue a new verification token.
 * - Failures are converted into user-safe errors (including duplicate-email mapping).
 */
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, emailLog, emailVerificationTokens } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { randomBytes } from "crypto";
import { sendEmail } from "@/lib/email";
import { systemNotificationEmail, verificationEmail } from "@/lib/email-templates";
import { embedAgent, scheduleEmbedding } from "@/lib/ai";
import { syncProfileToMatrix } from "@/lib/matrix-sync";
import { normalizeAssetUrl } from "@/lib/asset-url";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { hashToken } from "@/lib/token-hash";

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;
const MAX_USERNAME_LENGTH = 50;
const MAX_BIO_LENGTH = 500;
const MAX_PHONE_LENGTH = 50;
const TOKEN_BYTES = 32;
const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_TOKEN_TYPE = "email_verification";

export type UpdateProfileInput = {
  name: string;
  username: string;
  email: string;
  bio: string;
  tagline?: string;
  phone: string;
  skills?: string[];
  geneKeys?: string;
  humanDesign?: string;
  westernAstrology?: string;
  vedicAstrology?: string;
  ocean?: string;
  myersBriggs?: string;
  enneagram?: string;
  homeLocale?: string;
  murmurationsPublishing?: boolean;
  socialLinks?: Record<string, string>;
  profilePhotos?: string[];
  privacySettings?: Record<string, unknown>;
  notificationSettings?: {
    pushNotifications: boolean;
    emailNotifications: boolean;
    eventReminders: boolean;
    newMessages: boolean;
  };
};

type UpdateProfileResult = {
  success: boolean;
  error?: string;
};

/**
 * Updates the authenticated user's profile and handles email-change verification side effects.
 *
 * @param {UpdateProfileInput} input - Raw profile values from the settings form.
 * @returns {Promise<UpdateProfileResult>} Success result or user-facing error.
 * @throws {Error} Can throw if unexpected persistence or email provider failures escape guarded handling.
 * @example
 * ```ts
 * await updateProfileAction({
 *   name: "Ada Lovelace",
 *   username: "ada",
 *   email: "ada@example.com",
 *   bio: "Mathematician",
 *   phone: "+1-555-0100",
 * });
 * ```
 */
export async function updateProfileAction(
  input: UpdateProfileInput
): Promise<UpdateProfileResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "You must be logged in to update your profile." };
  }

  // Settings writes are rate-limited per user to reduce abuse and accidental rapid retries.
  const check = await rateLimit(`settings:${session.user.id}`, RATE_LIMITS.SETTINGS.limit, RATE_LIMITS.SETTINGS.windowMs);
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  // Normalize user input before validation/persistence to keep data consistent.
  const name = input.name?.trim() ?? "";
  const username = input.username?.trim() ?? "";
  const email = input.email?.trim().toLowerCase() ?? "";
  const bio = input.bio?.trim() ?? "";
  const phone = input.phone?.trim() ?? "";

  if (!name) {
    return { success: false, error: "Name is required." };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { success: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  if (!username) {
    return { success: false, error: "Username is required." };
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return { success: false, error: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.` };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return {
      success: false,
      error: "Username may only contain letters, numbers, periods, underscores, and hyphens.",
    };
  }

  if (!email) {
    return { success: false, error: "Email is required." };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return { success: false, error: "Email is too long." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }

  if (bio.length > MAX_BIO_LENGTH) {
    return { success: false, error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.` };
  }

  if (phone.length > MAX_PHONE_LENGTH) {
    return { success: false, error: `Phone must be ${MAX_PHONE_LENGTH} characters or fewer.` };
  }

  try {
    const [current] = await db
      .select({ metadata: agents.metadata, email: agents.email, name: agents.name, emailVerified: agents.emailVerified })
      .from(agents)
      .where(eq(agents.id, session.user.id))
      .limit(1);

    if (!current) {
      return { success: false, error: "User not found." };
    }

    // Preserve unknown metadata keys while updating profile-owned metadata fields.
    const existingMetadata =
      current.metadata && typeof current.metadata === "object"
        ? (current.metadata as Record<string, unknown>)
        : {};

    const nextMetadata: Record<string, unknown> = {
      ...existingMetadata,
      username,
      phone,
      bio,
      tagline: input.tagline?.trim() || (existingMetadata.tagline as string | undefined) || "",
      skills: input.skills ?? (existingMetadata.skills as string[] | undefined) ?? [],
      geneKeys: input.geneKeys !== undefined ? input.geneKeys.trim() : (existingMetadata.geneKeys as string | undefined) || "",
      humanDesign: input.humanDesign !== undefined ? input.humanDesign.trim() : (existingMetadata.humanDesign as string | undefined) || "",
      westernAstrology: input.westernAstrology !== undefined ? input.westernAstrology.trim() : (existingMetadata.westernAstrology as string | undefined) || "",
      vedicAstrology: input.vedicAstrology !== undefined ? input.vedicAstrology.trim() : (existingMetadata.vedicAstrology as string | undefined) || "",
      ocean: input.ocean !== undefined ? input.ocean.trim() : (existingMetadata.ocean as string | undefined) || "",
      myersBriggs: input.myersBriggs !== undefined ? input.myersBriggs.trim() : (existingMetadata.myersBriggs as string | undefined) || "",
      enneagram: input.enneagram !== undefined ? input.enneagram.trim() : (existingMetadata.enneagram as string | undefined) || "",
      homeLocale: input.homeLocale?.trim() || existingMetadata.homeLocale || undefined,
      murmurationsPublishing: input.murmurationsPublishing === true,
      privacySettings: input.privacySettings
        ? { ...(existingMetadata.privacySettings && typeof existingMetadata.privacySettings === "object" ? existingMetadata.privacySettings as Record<string, unknown> : {}), ...input.privacySettings }
        : (existingMetadata.privacySettings as Record<string, unknown> | undefined) ?? {
          profileVisibility: "public",
          friendRequests: "everyone",
          locationSharing: "events",
        },
      notificationSettings: input.notificationSettings ?? (existingMetadata.notificationSettings as Record<string, unknown> | undefined) ?? {
        pushNotifications: false,
        emailNotifications: true,
        eventReminders: true,
        newMessages: true,
      },
      socialLinks: input.socialLinks ?? (existingMetadata.socialLinks as Record<string, string> | undefined) ?? {},
      profilePhotos: Array.isArray(input.profilePhotos)
        ? input.profilePhotos.filter((value): value is string => typeof value === "string" && value.length > 0)
        : Array.isArray(existingMetadata.profilePhotos)
          ? (existingMetadata.profilePhotos as string[]).filter((value): value is string => typeof value === "string" && value.length > 0)
          : [],
    };

    const previousEmail = typeof current.email === "string" ? current.email : "";
    const emailChanged = previousEmail !== email;

    // Derive dedicated social link column values from the socialLinks map.
    const socialLinks = (nextMetadata.socialLinks ?? {}) as Record<string, string>;
    const socialWebsite = socialLinks.website || null;
    const socialXHandle = socialLinks.x || null;
    const socialInstagram = socialLinks.instagram || null;
    const socialLinkedin = socialLinks.linkedin || null;
    const socialTelegram = socialLinks.telegram || null;
    const socialSignal = socialLinks.signal || null;
    const socialPhone = socialLinks.phone || null;

    // Email changes clear verification state; unchanged email keeps prior verification value.
    // Dual-write: metadata.socialLinks AND dedicated columns are updated together.
    await db.execute(sql`
      UPDATE agents
      SET
        name = ${name},
        email = ${email},
        email_verified = ${emailChanged ? null : current.emailVerified},
        description = ${bio || null},
        metadata = ${JSON.stringify(nextMetadata)}::jsonb,
        website = ${socialWebsite},
        x_handle = ${socialXHandle},
        instagram = ${socialInstagram},
        linkedin = ${socialLinkedin},
        telegram = ${socialTelegram},
        signal_handle = ${socialSignal},
        phone_number = ${socialPhone},
        updated_at = NOW()
      WHERE id = ${session.user.id}
    `);

    if (emailChanged) {
      // Cryptographically strong token reduces predictability of verification URLs.
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS);

      await db.insert(emailVerificationTokens).values({
        agentId: session.user.id,
        token: hashToken(token),
        tokenType: VERIFICATION_TOKEN_TYPE,
        expiresAt,
      });

      const verificationTemplate = verificationEmail(name, token);
      const verifyResult = await sendEmail({
        to: email,
        subject: verificationTemplate.subject,
        html: verificationTemplate.html,
        text: verificationTemplate.text,
      });

      await db.insert(emailLog).values({
        recipientEmail: email,
        recipientAgentId: session.user.id,
        subject: verificationTemplate.subject,
        emailType: "verification",
        status: verifyResult.success ? "sent" : "failed",
        messageId: verifyResult.messageId,
        error: verifyResult.error,
      });

      if (previousEmail) {
        // Security notice to prior email helps detect unauthorized account takeover.
        const changeNotice = systemNotificationEmail(
          current.name ?? name,
          "Your email address was changed",
          `Your account email was updated to ${email}. If this was not you, reset your password immediately.`
        );
        const notifyOldResult = await sendEmail({
          to: previousEmail,
          subject: changeNotice.subject,
          html: changeNotice.html,
          text: changeNotice.text,
        });
        await db.insert(emailLog).values({
          recipientEmail: previousEmail,
          recipientAgentId: session.user.id,
          subject: changeNotice.subject,
          emailType: "security_notice",
          status: notifyOldResult.success ? "sent" : "failed",
          messageId: notifyOldResult.messageId,
          error: notifyOldResult.error,
        });
      }
    }

    revalidatePath("/settings");
    revalidatePath("/");
    revalidatePath("/profile");
    revalidatePath(`/profile/${username}`);

    // Re-embed when name or bio changes so semantic search stays current.
    scheduleEmbedding(() => embedAgent(session.user!.id!, name, bio || undefined));

    // Sync display name to Matrix profile (fire-and-forget)
    if (name !== current.name) {
      void syncProfileToMatrix(session.user.id, { displayName: name });
    }

    if (input.murmurationsPublishing === true) {
      void syncMurmurationsProfilesForActor(session.user.id).catch((err) => {
        console.error("[murmurations] Failed to sync profile settings change:", err);
      });
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // DB-specific uniqueness errors are mapped to a deterministic UX message.
    if (message.includes("agents_email_idx") || message.includes("duplicate key")) {
      return { success: false, error: "That email is already in use." };
    }

    return { success: false, error: "Unable to update your profile right now." };
  }
}

/**
 * Updates the authenticated user's avatar or cover image.
 *
 * @param field - Which image to update: "avatar" or "coverImage".
 * @param url - The uploaded image URL to persist.
 */
export async function updateProfileImageAction(
  field: "avatar" | "coverImage",
  url: string
): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "You must be logged in." };
  }

  const check = await rateLimit(`settings:${session.user.id}`, RATE_LIMITS.SETTINGS.limit, RATE_LIMITS.SETTINGS.windowMs);
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  try {
    const normalizedUrl = normalizeAssetUrl(url);

    if (field === "avatar") {
      await db.execute(sql`
        UPDATE agents SET image = ${normalizedUrl}, updated_at = NOW()
        WHERE id = ${session.user.id}
      `);
      void syncProfileToMatrix(session.user.id, { avatarUrl: normalizedUrl });
    } else {
      const [current] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, session.user.id))
        .limit(1);

      const existingMetadata =
        current?.metadata && typeof current.metadata === "object"
          ? (current.metadata as Record<string, unknown>)
          : {};

      const nextMetadata = { ...existingMetadata, coverImage: normalizedUrl };

      await db.execute(sql`
        UPDATE agents SET metadata = ${JSON.stringify(nextMetadata)}::jsonb, updated_at = NOW()
        WHERE id = ${session.user.id}
      `);
    }

    revalidatePath("/profile");
    revalidatePath("/settings");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to update image." };
  }
}

/**
 * Updates a group's avatar (agents.image) or cover image (metadata.coverImage).
 * Requires the caller to be an admin of the group.
 */
export async function updateGroupImageAction(
  groupId: string,
  field: "avatar" | "coverImage",
  url: string
): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "You must be logged in." };
  }

  const check = await rateLimit(`group-image:${session.user.id}`, RATE_LIMITS.SETTINGS.limit, RATE_LIMITS.SETTINGS.windowMs);
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  // Verify admin access
  const [group] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), eq(agents.type, "organization")))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const meta = (group.metadata ?? {}) as Record<string, unknown>;
  const isAdmin =
    meta.creatorId === session.user.id ||
    (Array.isArray(meta.adminIds) && (meta.adminIds as unknown[]).includes(session.user.id));

  if (!isAdmin) {
    return { success: false, error: "You do not have permission to edit this group." };
  }

  try {
    const normalizedUrl = normalizeAssetUrl(url);

    if (field === "avatar") {
      await db.execute(sql`
        UPDATE agents SET image = ${normalizedUrl}, updated_at = NOW()
        WHERE id = ${groupId}
      `);
    } else {
      const nextMetadata = { ...meta, coverImage: normalizedUrl };
      await db.execute(sql`
        UPDATE agents SET metadata = ${JSON.stringify(nextMetadata)}::jsonb, updated_at = NOW()
        WHERE id = ${groupId}
      `);
    }

    revalidatePath(`/groups/${groupId}`);
    revalidatePath("/groups");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to update group image." };
  }
}
