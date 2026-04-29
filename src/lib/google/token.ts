/**
 * Google OAuth token helper for per-group Workspace connections.
 *
 * Purpose:
 * - Loads the current `groupConnections` row for a (group, google_workspace)
 *   pair, refreshes the access token when it is expired or about to expire,
 *   and persists the refreshed value back to the row.
 *
 * Key exports:
 * - {@link getFreshGoogleAccessToken} — the only public entrypoint.
 * - {@link GoogleAccessToken} — typed result describing the live token.
 *
 * Dependencies:
 * - `@/db` for Drizzle access.
 * - `@/db/schema` for `groupConnections`.
 * - `./constants` for the provider id and refresh URL.
 *
 * Security notes:
 * - Throws stable {@link GoogleTokenError}s with named codes; never leaks
 *   provider response bodies past the first 300 chars to keep logs tidy.
 * - The refreshed token is written back to the same row; callers that
 *   already have a stale token in memory should request a fresh one
 *   before each send rather than caching across long-lived intervals.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { groupConnections } from '@/db/schema';
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_WORKSPACE_PROVIDER,
} from './constants';

/** Margin (ms) used to treat tokens as "about to expire" and refresh proactively. */
const REFRESH_LEAD_TIME_MS = 60_000;

/** Stable error codes for token-flow failures so callers can branch on them. */
export const GOOGLE_TOKEN_ERROR_CODES = {
  NOT_LINKED: 'google_not_linked',
  EXPIRED_NO_REFRESH: 'google_expired_no_refresh',
  NOT_CONFIGURED: 'google_oauth_not_configured',
  REFRESH_FAILED: 'google_refresh_failed',
  REFRESH_NO_TOKEN: 'google_refresh_no_token',
} as const;

export type GoogleTokenErrorCode =
  (typeof GOOGLE_TOKEN_ERROR_CODES)[keyof typeof GOOGLE_TOKEN_ERROR_CODES];

/** Typed error carrying a stable code so call sites can branch deterministically. */
export class GoogleTokenError extends Error {
  public readonly code: GoogleTokenErrorCode;

  constructor(code: GoogleTokenErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GoogleTokenError';
  }
}

/** Live access token + metadata returned by {@link getFreshGoogleAccessToken}. */
export interface GoogleAccessToken {
  /** PK of the underlying `groupConnections` row. */
  connectionId: string;
  /** Group whose connection this access token belongs to. */
  groupId: string;
  /** Live, non-expired access token. */
  accessToken: string;
  /** Refresh token if one is on file. */
  refreshToken: string | null;
  /** Absolute UTC time when the access token expires. */
  expiresAt: Date | null;
  /** Linked Workspace account email — useful for XOAUTH2 user binding. */
  accountEmail: string;
}

/**
 * Resolve a fresh, usable Google access token for a group.
 *
 * Refreshes via the OAuth refresh-token endpoint if the stored token is
 * already expired or expires within {@link REFRESH_LEAD_TIME_MS}.
 *
 * @param groupId Group whose Workspace connection to resolve.
 * @returns Live access token + metadata.
 * @throws {GoogleTokenError} when not linked, missing config, or refresh fails.
 */
export async function getFreshGoogleAccessToken(
  groupId: string,
): Promise<GoogleAccessToken> {
  const [connection] = await db
    .select({
      id: groupConnections.id,
      groupId: groupConnections.groupId,
      accessToken: groupConnections.accessToken,
      refreshToken: groupConnections.refreshToken,
      expiresAt: groupConnections.expiresAt,
      accountEmail: groupConnections.accountEmail,
    })
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  if (!connection) {
    throw new GoogleTokenError(
      GOOGLE_TOKEN_ERROR_CODES.NOT_LINKED,
      `No Google Workspace connection linked for group ${groupId}.`,
    );
  }

  const expiresAt = connection.expiresAt ?? null;
  const expiresSoon =
    expiresAt !== null && expiresAt.getTime() <= Date.now() + REFRESH_LEAD_TIME_MS;

  if (!expiresSoon) {
    return {
      connectionId: connection.id,
      groupId: connection.groupId,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt,
      accountEmail: connection.accountEmail,
    };
  }

  if (!connection.refreshToken) {
    throw new GoogleTokenError(
      GOOGLE_TOKEN_ERROR_CODES.EXPIRED_NO_REFRESH,
      'Google access expired and no refresh token is on file. Reconnect Google Workspace.',
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GoogleTokenError(
      GOOGLE_TOKEN_ERROR_CODES.NOT_CONFIGURED,
      'Google OAuth is not configured on this instance (missing GOOGLE_CLIENT_ID/SECRET).',
    );
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new GoogleTokenError(
      GOOGLE_TOKEN_ERROR_CODES.REFRESH_FAILED,
      `Failed to refresh Google token: ${errorText.slice(0, 300)}`,
    );
  }

  const refreshed = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!refreshed.access_token) {
    throw new GoogleTokenError(
      GOOGLE_TOKEN_ERROR_CODES.REFRESH_NO_TOKEN,
      'Google token refresh did not return an access token.',
    );
  }

  const nextExpiresAt =
    typeof refreshed.expires_in === 'number'
      ? new Date(Date.now() + refreshed.expires_in * 1000)
      : null;

  await db
    .update(groupConnections)
    .set({
      accessToken: refreshed.access_token,
      expiresAt: nextExpiresAt,
      refreshToken: refreshed.refresh_token ?? connection.refreshToken,
      updatedAt: new Date(),
    })
    .where(eq(groupConnections.id, connection.id));

  return {
    connectionId: connection.id,
    groupId: connection.groupId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? connection.refreshToken,
    expiresAt: nextExpiresAt,
    accountEmail: connection.accountEmail,
  };
}
