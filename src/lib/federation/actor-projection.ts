// src/lib/federation/actor-projection.ts

/**
 * Verified-principal actor projection.
 *
 * Every ledger write (reactions, comments, follows, joins, …) stamps
 * `ledger.subject_id` with the acting actor id, which carries a foreign key to
 * `agents.id`. The sovereign OWNER and locally-registered users always satisfy
 * that FK. A cross-instance visitor does NOT: when a federated SSO viewer whose
 * home is another instance (e.g. a sovereign person on `*.camalot.me`) browses
 * this instance through the remote-viewer cookie, their session id is their HOME
 * agent id, for which no local `agents` row exists. Their first allowed
 * like/comment then fails with `ledger_subject_id_agents_id_fk`, breaking basic
 * social functions for every federated visitor.
 *
 * The fix is the same projection model the federation importer already uses for
 * remote resource owners (`ensureProjectedAgent`): materialize a minimal,
 * private local mirror of the actor before the local write. This is
 * audit-safe — the principal is verified (HMAC-signed remote-viewer cookie or a
 * NextAuth JWT), they can only ever act as themselves, and the mirror is
 * `visibility: "private"` so it never leaks into discovery. The real name and
 * avatar are upgraded in place by the next agent upsert the visitor's home peer
 * federates, and `readFederatedSession` reads the name straight off this row.
 *
 * We deliberately REFUSE to fabricate an agent when no remote home can be
 * established: a missing local row whose home resolves to this instance is a
 * stale/deleted local account, not a federated viewer, and silently minting a
 * ghost agent for it would mask data-integrity problems.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSession } from "@/lib/auth/get-session";

import {
  resolveHomeByBaseUrl,
  resolveHomeInstance,
  type HomeInstanceInfo,
} from "./resolution";

/** Strip a trailing slash so base URLs compare/store consistently. */
function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "");
}

/**
 * Ensure a local `agents` row exists for a verified acting principal so that
 * `ledger.subject_id` foreign keys hold for cross-instance interactions.
 *
 * No-op when a local row already exists. Only ever invoked from the DIRECT
 * (non-forwarded) write path — forwarded federation mutations normalize the
 * actor through `federation_entity_map` in the receiver and must not mint a
 * competing placeholder.
 *
 * @param actorId Verified actor id (session user id), used as the local row id.
 */
export async function ensureLocalActorAgent(actorId: string): Promise<void> {
  if (!actorId) return;

  const existing = await db.query.agents.findFirst({
    where: eq(agents.id, actorId),
    columns: { id: true },
  });
  if (existing) return;

  // Identity hints from the verified session. `homeBaseUrl` is only populated
  // for federated (remote-viewer cookie) sessions; for those we trust the
  // signed home claim directly. Name is absent until the home peer federates
  // the agent upsert, so we start with a labelled placeholder.
  const session = await getSession().catch(() => null);
  const isActorSession = session?.user?.id === actorId;
  const sessionHomeBaseUrl = isActorSession ? session?.user.homeBaseUrl ?? null : null;
  const sessionName = isActorSession ? session?.user.name ?? null : null;

  // Resolve the home instance: prefer the registered node for the session's
  // signed home URL, then fall back to the agent-graph resolver (parent chain /
  // registry). On a sovereign the home is usually NOT a locally-registered
  // node, so the signed `homeBaseUrl` claim is the authoritative signal.
  let home: HomeInstanceInfo | null = null;
  if (sessionHomeBaseUrl) {
    home = await resolveHomeByBaseUrl(sessionHomeBaseUrl).catch(() => null);
  }
  if (!home) {
    home = await resolveHomeInstance(actorId).catch(() => null);
  }

  const remoteHome = home && !home.isLocal ? home : null;
  const resolvedHomeBaseUrl =
    (sessionHomeBaseUrl ? normalizeBaseUrl(sessionHomeBaseUrl) : null) ??
    (remoteHome ? normalizeBaseUrl(remoteHome.baseUrl) : null);

  // Refuse to fabricate identities for stale/deleted local accounts (no
  // resolvable remote home). The original FK error then surfaces instead of a
  // silently-created ghost agent.
  if (!resolvedHomeBaseUrl) return;

  await db
    .insert(agents)
    .values({
      id: actorId,
      name: sessionName ?? `Federated agent${remoteHome ? ` (${remoteHome.slug})` : ""}`,
      // Provisional type: the acting principal's real agent type is unknown at
      // viewer-projection time (we only hold the signed session). The
      // authoritative type is reconciled in place when the visitor's home peer
      // federates their agent upsert — the importer's placeholder-upgrade path
      // (federatedPlaceholder) carries the real `type` — so an org never stays a
      // person. Owner-id convergence (resolveLocalEntityId keys by the external
      // UUID) is what lets that upgrade land on THIS row rather than a duplicate.
      type: "person",
      visibility: "private",
      metadata: {
        federatedPlaceholder: true,
        isProjection: true,
        externalEntityId: actorId,
        homeInstanceUrl: resolvedHomeBaseUrl,
        // Canonical home stamps consumed by resolveHomeInstance's
        // homeBaseUrl/canonicalUrl branch (H1) so this federated-viewer
        // projection routes "My Profile" back to its sovereign home even when no
        // node-id (`sourceNodeId`) signal is available downstream.
        homeBaseUrl: resolvedHomeBaseUrl,
        canonicalUrl: `${resolvedHomeBaseUrl}/profile/${actorId}`,
        ...(remoteHome
          ? {
              sourceNodeId: remoteHome.nodeId,
              sourceNodeSlug: remoteHome.slug,
              homeInstanceSlug: remoteHome.slug,
              homeInstanceNodeId: remoteHome.nodeId,
            }
          : {}),
      },
    })
    .onConflictDoNothing({ target: agents.id });
}
