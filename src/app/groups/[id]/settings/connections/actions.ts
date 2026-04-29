"use server";

/**
 * Server actions for the per-group Connections settings page.
 *
 * Each action re-verifies that the caller is an admin/moderator of the
 * target group. The OAuth callback is the only path that creates a
 * `groupConnections` row; these actions only update or delete the row.
 *
 * Key exports:
 * - {@link updateGroupGoogleConnectionConfigAction}
 * - {@link disconnectGroupGoogleAction}
 *
 * Dependencies:
 * - `@/auth` for session resolution.
 * - `@/db` and the `groupConnections` table for persistence.
 * - `@/app/actions/group-admin` for the canonical `isGroupAdmin` helper.
 */

import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { groupConnections } from "@/db/schema";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { GOOGLE_WORKSPACE_PROVIDER } from "@/lib/google/constants";
import type { GroupGoogleConnectionSummary } from "./connections-form";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable error codes returned to the client form.
 *
 * Not exported: a `"use server"` module is restricted to async-function
 * exports only. Keep this constant module-private and surface the string
 * value via the `ConnectionActionResult.error` envelope.
 */
const CONNECTION_ACTION_ERRORS = {
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  INVALID_GROUP: "invalid_group",
  NOT_LINKED: "not_linked",
  INVALID_CONFIG: "invalid_config",
  PERSIST_FAILED: "persist_failed",
} as const;

type ConnectionActionErrorCode =
  (typeof CONNECTION_ACTION_ERRORS)[keyof typeof CONNECTION_ACTION_ERRORS];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result envelope shared by all connection-mutation actions. */
export interface ConnectionActionResult {
  success: boolean;
  error?: ConnectionActionErrorCode;
  message?: string;
}

/** Patch shape accepted by {@link updateGroupGoogleConnectionConfigAction}. */
export interface GoogleConnectionConfigPatch {
  smtpEnabled?: boolean;
  calendarSyncEnabled?: boolean;
  fromAddress?: string | null;
  calendarId?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function authorize(
  groupId: string,
): Promise<{ ok: true; userId: string } | { ok: false; error: ConnectionActionErrorCode }> {
  if (!groupId || !UUID_RE.test(groupId)) {
    return { ok: false, error: CONNECTION_ACTION_ERRORS.INVALID_GROUP };
  }

  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: CONNECTION_ACTION_ERRORS.UNAUTHENTICATED };
  }

  const isAdmin = await isGroupAdmin(session.user.id, groupId);
  if (!isAdmin) {
    return { ok: false, error: CONNECTION_ACTION_ERRORS.FORBIDDEN };
  }

  return { ok: true, userId: session.user.id };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Apply a partial config update to the group's Google connection.
 *
 * Only `smtpEnabled`, `calendarSyncEnabled`, `fromAddress`, and
 * `calendarId` are accepted. Tokens, account email, and audit fields are
 * not mutable from the UI.
 *
 * @param groupId Group whose connection to update.
 * @param patch  Partial config; undefined keys are left unchanged.
 * @returns success/failure envelope with a stable error code on failure.
 */
export async function updateGroupGoogleConnectionConfigAction(
  groupId: string,
  patch: GoogleConnectionConfigPatch,
): Promise<ConnectionActionResult> {
  const authResult = await authorize(groupId);
  if (!authResult.ok) return { success: false, error: authResult.error };

  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return { success: false, error: CONNECTION_ACTION_ERRORS.INVALID_CONFIG };
  }

  const [existing] = await db
    .select({
      id: groupConnections.id,
      config: groupConnections.config,
    })
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  if (!existing) {
    return { success: false, error: CONNECTION_ACTION_ERRORS.NOT_LINKED };
  }

  const current = existing.config ?? {
    smtpEnabled: false,
    calendarSyncEnabled: false,
  };

  const nextConfig: NonNullable<typeof existing.config> = {
    smtpEnabled:
      typeof patch.smtpEnabled === "boolean"
        ? patch.smtpEnabled
        : current.smtpEnabled,
    calendarSyncEnabled:
      typeof patch.calendarSyncEnabled === "boolean"
        ? patch.calendarSyncEnabled
        : current.calendarSyncEnabled,
    fromAddress:
      patch.fromAddress === undefined
        ? current.fromAddress
        : patch.fromAddress === null
          ? undefined
          : patch.fromAddress.trim() || undefined,
    calendarId:
      patch.calendarId === undefined
        ? current.calendarId
        : patch.calendarId === null
          ? undefined
          : patch.calendarId.trim() || undefined,
  };

  try {
    await db
      .update(groupConnections)
      .set({ config: nextConfig, updatedAt: new Date() })
      .where(eq(groupConnections.id, existing.id));
  } catch (error) {
    console.error(
      `[group-connections] failed to persist config for group ${groupId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { success: false, error: CONNECTION_ACTION_ERRORS.PERSIST_FAILED };
  }

  return { success: true };
}

/** Result envelope for {@link fetchGroupGoogleConnectionAction}. */
export interface FetchGroupGoogleConnectionResult {
  success: boolean;
  error?: ConnectionActionErrorCode;
  connection: GroupGoogleConnectionSummary | null;
}

/**
 * Read the group's Google Workspace connection summary for client-side
 * rendering (e.g. inside the Connections tab on the settings page).
 *
 * Returns `connection: null` when the caller is admin but no row exists yet
 * (so the form can render the "Connect Google Workspace" CTA). Returns
 * `success: false` with a stable error code on auth/admin failure.
 *
 * Tokens, refresh tokens, and HMAC nonces are intentionally omitted — only
 * the fields the form actually renders are returned.
 *
 * @param groupId Group whose connection to read.
 */
export async function fetchGroupGoogleConnectionAction(
  groupId: string,
): Promise<FetchGroupGoogleConnectionResult> {
  const authResult = await authorize(groupId);
  if (!authResult.ok) {
    return { success: false, error: authResult.error, connection: null };
  }

  const [row] = await db
    .select({
      accountEmail: groupConnections.accountEmail,
      scope: groupConnections.scope,
      expiresAt: groupConnections.expiresAt,
      config: groupConnections.config,
    })
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  if (!row) {
    return { success: true, connection: null };
  }

  const config = row.config ?? {
    smtpEnabled: false,
    calendarSyncEnabled: false,
  };

  return {
    success: true,
    connection: {
      accountEmail: row.accountEmail,
      scope: row.scope ?? null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      config: {
        smtpEnabled: Boolean(config.smtpEnabled),
        calendarSyncEnabled: Boolean(config.calendarSyncEnabled),
        fromAddress: config.fromAddress,
        calendarId: config.calendarId,
      },
    },
  };
}

/**
 * Disconnect (delete) the group's Google Workspace connection.
 *
 * Hard-deletes the row so a re-link forces a fresh consent + refresh
 * token. PR2 may upgrade this to a soft-disable if richer audit is
 * required.
 *
 * @param groupId Group whose connection to drop.
 */
export async function disconnectGroupGoogleAction(
  groupId: string,
): Promise<ConnectionActionResult> {
  const authResult = await authorize(groupId);
  if (!authResult.ok) return { success: false, error: authResult.error };

  try {
    await db
      .delete(groupConnections)
      .where(
        and(
          eq(groupConnections.groupId, groupId),
          eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
        ),
      );
  } catch (error) {
    console.error(
      `[group-connections] failed to delete connection for group ${groupId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { success: false, error: CONNECTION_ACTION_ERRORS.PERSIST_FAILED };
  }

  return { success: true };
}
