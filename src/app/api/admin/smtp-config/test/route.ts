/**
 * Admin API for triggering a test send against the currently saved
 * peer SMTP config (ticket #106).
 *
 * Route:
 *   POST /api/admin/smtp-config/test
 *     { testRecipient?: string }
 *
 * Behavior:
 *   - Resolves the saved config via `getPeerSmtpConfig()` (which also
 *     dereferences the secret). If the config is missing / disabled
 *     / the secret is empty, returns 400 with a human-readable error.
 *   - Runs `verifyPeerSmtpConfig()` to attempt a transporter verify +
 *     optional end-to-end test message.
 *   - Persists the outcome to `peer_smtp_config.last_test_{at,status,error}`
 *     so the settings UI can show "last tested at…" even after a reload.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { peerSmtpConfig } from "@/db/schema";
import {
  STATUS_BAD_REQUEST,
  STATUS_OK,
} from "@/lib/http-status";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  getPeerSmtpConfig,
  resetPeerSmtpConfigCache,
} from "@/lib/federation/peer-smtp";
import { verifyPeerSmtpConfig } from "@/lib/federation/peer-smtp-transport";
import { requireAdminOrRespond } from "../route";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAdminOrRespond();
  if (denied) return denied;

  let body: { testRecipient?: string } = {};
  try {
    // Empty body is fine — falls back to sending to fromAddress.
    const raw = await request.text();
    if (raw.trim().length > 0) {
      body = JSON.parse(raw);
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be valid JSON" },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Invalidate cache so we see any changes from a concurrent upsert.
  resetPeerSmtpConfigCache();
  const resolved = await getPeerSmtpConfig();
  if (!resolved) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Peer SMTP is not configured, not enabled, or password secret is empty",
      },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const recipient =
    typeof body.testRecipient === "string" && body.testRecipient.trim().length > 0
      ? body.testRecipient.trim()
      : resolved.fromAddress;

  const testResult = await verifyPeerSmtpConfig(resolved, recipient);
  const now = new Date();

  try {
    const { instanceId } = getInstanceConfig();
    await db
      .update(peerSmtpConfig)
      .set({
        lastTestAt: now,
        lastTestStatus: testResult.success ? "ok" : "failed",
        lastTestError: testResult.success ? null : testResult.error ?? null,
        updatedAt: now,
      })
      .where(eq(peerSmtpConfig.instanceId, instanceId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[admin/smtp-config/test] failed to persist test outcome: ${message}`,
    );
    // Don't fail the whole request on a logging-side issue.
  }

  // Whether success or failure, the HTTP status is 200 — the admin UI
  // inspects `ok` in the body to decide what message to show. A 5xx
  // here would imply our handler broke, not that the test send failed.
  if (!testResult.success) {
    return NextResponse.json(
      {
        ok: false,
        error: testResult.error ?? "Unknown test error",
        testedAt: now.toISOString(),
      },
      { status: STATUS_OK },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      messageId: testResult.messageId ?? null,
      recipient,
      testedAt: now.toISOString(),
    },
    { status: STATUS_OK },
  );
}

