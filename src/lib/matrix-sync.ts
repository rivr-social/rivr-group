"use server";

/**
 * Syncs Rivr agent profile changes to Matrix.
 *
 * Purpose:
 * - Keep Matrix display names and avatars in sync when users update their profiles.
 * - Called from profile update actions (name change, avatar change).
 *
 * Key exports:
 * - `syncProfileToMatrix` — pushes name and/or avatar updates to Matrix for an agent.
 *
 * Dependencies:
 * - `@/lib/matrix-admin` for `updateMatrixProfile`.
 * - `@/db` for reading agent Matrix credentials.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { updateMatrixProfile } from "@/lib/matrix-admin";

/**
 * Syncs an agent's current name and avatar to their Matrix profile.
 *
 * This is a fire-and-forget operation — failures are logged but do not
 * propagate to the caller, ensuring profile updates succeed even when
 * Matrix is unavailable.
 *
 * @param agentId - UUID of the agent whose profile changed
 * @param updates - The specific fields that changed
 */
export async function syncProfileToMatrix(
  agentId: string,
  updates: {
    displayName?: string;
    avatarUrl?: string;
  }
): Promise<void> {
  try {
    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: {
        matrixUserId: true,
      },
    });

    if (!agent?.matrixUserId) return;

    await updateMatrixProfile({
      matrixUserId: agent.matrixUserId,
      displayName: updates.displayName,
      avatarUrl: updates.avatarUrl,
    });
  } catch (err) {
    console.error(
      `[matrix-sync] Failed to sync profile for agent ${agentId}:`,
      err
    );
  }
}
