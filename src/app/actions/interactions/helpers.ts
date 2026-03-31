"use server";

import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { ledger } from "@/db/schema";
import type { NewLedgerEntry } from "@/db/schema";

import type { ActionResult, TargetType } from "./types";
import { isUuid } from "./types";

/**
 * Resolves the authenticated user ID from the active session.
 */
export async function getCurrentUserId() {
  const session = await auth();
  return session?.user?.id ?? null;
}

/**
 * Toggles an interaction edge in the ledger on/off.
 *
 * Behavior:
 * - If an active matching row exists, it is deactivated (`is_active = false`).
 * - Otherwise, a new active row is inserted.
 *
 * Security considerations:
 * - Caller identity is passed in from authenticated actions only.
 * - Target identity is always persisted in metadata even when non-UUID.
 */
export async function toggleLedgerInteraction(
  userId: string,
  verb: "react" | "follow" | "join" | "share" | "view",
  interactionType: string,
  targetId: string,
  targetType: TargetType
): Promise<ActionResult> {
  const existing = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, userId),
      eq(ledger.verb, verb),
      eq(ledger.isActive, true),
      sql`${ledger.metadata}->>'interactionType' = ${interactionType}`,
      sql`${ledger.metadata}->>'targetId' = ${targetId}`
    ),
    columns: { id: true },
  });

  if (existing) {
    // Soft-deactivate to preserve interaction history rather than hard-deleting.
    await db.execute(sql`
      UPDATE ledger
      SET is_active = false, expires_at = NOW()
      WHERE id = ${existing.id}
    `);

    return {
      success: true,
      message: `${interactionType} removed`,
      active: false,
    };
  }

  await db.insert(ledger).values({
    subjectId: userId,
    verb,
    objectId: isUuid(targetId) ? targetId : null,
    objectType: targetType,
    metadata: {
      interactionType,
      targetId,
      targetType,
    },
  } as NewLedgerEntry);

  return {
    success: true,
    message: `${interactionType} added`,
    active: true,
  };
}
