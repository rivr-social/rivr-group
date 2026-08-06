'use server';

/**
 * Server actions for GROUP-owned personas (the unified-agent model).
 *
 * Unlike the user-owned personas in `personas.ts` (parent = the signed-in
 * account), these personas are children of the GROUP agent
 * (`parent_agent_id = groupId`). They are the group's public-facing
 * sub-identities and the carriers of the group's AI assistant flag
 * (`metadata.autobotEnabled`).
 *
 * Authorization: every mutating action is gated by `isGroupAdmin`. Resolution
 * (`findGroupAutobotPersona`) is public — it reads only public persona
 * metadata so the outward-facing chat route can resolve the assistant for
 * anonymous/visitor callers.
 *
 * Key exports:
 * - `createGroupPersona` / `listGroupPersonas` / `updateGroupPersona` /
 *   `deleteGroupPersona` — admin-gated CRUD over group child personas.
 * - `setGroupPersonaAutobotEnabled` — toggle which persona acts as the group's
 *   AI assistant (mutually exclusive: enabling one disables the rest).
 * - `findGroupAutobotPersona` — public resolver with self-fallback to the group
 *   agent (mirrors the person app's `findAutobotEnabledPersona`).
 */

import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq, and, isNull, ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { MAX_PERSONAS_PER_ACCOUNT } from '@/lib/persona';
import { serializeAgent } from '@/lib/graph-serializers';
import type { SerializedAgent } from '@/lib/graph-serializers';
import { getAuthenticatedActorId } from '@/lib/server-auth';
import { emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { buildRevocationPayload } from '@/lib/federation/revocation-contract';
import { isGroupAdmin } from '@/app/actions/group-admin';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum lengths for persona profile fields. */
const MAX_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 40;
const MAX_BIO_LENGTH = 500;

/** SQL predicate matching an autobot-enabled agent regardless of key casing. */
const AUTOBOT_ENABLED_PREDICATE = sql`lower(coalesce(metadata->>'autobotEnabled', metadata->>'autobot_enabled', 'false')) = 'true'`;

export interface GroupPersonaResult {
  success: boolean;
  error?: string;
}

export interface GroupPersonaListResult extends GroupPersonaResult {
  personas?: SerializedAgent[];
}

export interface GroupPersonaCreateResult extends GroupPersonaResult {
  personaId?: string;
}

/**
 * Resolve the authenticated actor or return a structured failure.
 */
async function requireGroupAdmin(
  groupId: string,
): Promise<{ ok: true; actorId: string } | { ok: false; error: string }> {
  const actorId = await getAuthenticatedActorId();
  if (!actorId) return { ok: false, error: 'Authentication required.' };
  if (!groupId || !UUID_RE.test(groupId)) {
    return { ok: false, error: 'Invalid group identifier.' };
  }
  if (!(await isGroupAdmin(actorId, groupId))) {
    return { ok: false, error: 'Only group admins can manage group personas.' };
  }
  return { ok: true, actorId };
}

/**
 * Create a new persona under the GROUP agent.
 *
 * @throws {never} Returns structured errors for expected failures.
 */
export async function createGroupPersona(input: {
  groupId: string;
  name: string;
  username?: string;
  bio?: string;
}): Promise<GroupPersonaCreateResult> {
  const auth = await requireGroupAdmin(input.groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  const name = (input.name ?? '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { success: false, error: 'Name is required and must be under 100 characters.' };
  }

  const username = (input.username ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (username && username.length > MAX_USERNAME_LENGTH) {
    return { success: false, error: 'Username must be under 40 characters.' };
  }

  const bio = (input.bio ?? '').trim();
  if (bio.length > MAX_BIO_LENGTH) {
    return { success: false, error: 'Bio must be under 500 characters.' };
  }

  // Enforce the per-parent persona cap against the GROUP agent.
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.parentAgentId, input.groupId), isNull(agents.deletedAt)));
  const currentCount = Number(countResult?.count ?? 0);
  if (currentCount >= MAX_PERSONAS_PER_ACCOUNT) {
    return {
      success: false,
      error: `This group can have at most ${MAX_PERSONAS_PER_ACCOUNT} personas.`,
    };
  }

  if (username) {
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          sql`(${agents.metadata}->>'username')::text = ${username}`,
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (existing) {
      return { success: false, error: 'That username is already taken.' };
    }
  }

  const metadata: Record<string, unknown> = {
    isPersona: true,
    isGroupPersona: true,
    bio: bio || undefined,
    username: username || undefined,
  };

  const [newAgent] = await db
    .insert(agents)
    .values({
      name,
      type: 'person',
      parentAgentId: input.groupId,
      visibility: 'public',
      metadata,
    })
    .returning({ id: agents.id });

  return { success: true, personaId: newAgent.id };
}

/**
 * List every persona owned by the group. Admin-gated.
 */
export async function listGroupPersonas(
  groupId: string,
): Promise<GroupPersonaListResult> {
  const auth = await requireGroupAdmin(groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.parentAgentId, groupId), isNull(agents.deletedAt)))
    .orderBy(agents.createdAt);

  return { success: true, personas: rows.map((r) => serializeAgent(r)) };
}

/**
 * Update a group persona's profile fields. Admin-gated; the persona must be a
 * direct child of the group.
 */
export async function updateGroupPersona(input: {
  groupId: string;
  personaId: string;
  name?: string;
  username?: string;
  bio?: string;
  image?: string;
}): Promise<GroupPersonaResult> {
  const auth = await requireGroupAdmin(input.groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  if (!input.personaId || !UUID_RE.test(input.personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  const [persona] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.personaId),
        eq(agents.parentAgentId, input.groupId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by this group.' };
  }

  const updates: Record<string, unknown> = {};
  const metadataUpdates: Record<string, unknown> = {
    ...((persona.metadata ?? {}) as Record<string, unknown>),
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      return { success: false, error: 'Name is required and must be under 100 characters.' };
    }
    updates.name = name;
  }

  if (input.username !== undefined) {
    const username = input.username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (username.length > MAX_USERNAME_LENGTH) {
      return { success: false, error: 'Username must be under 40 characters.' };
    }
    if (username) {
      const [existing] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            sql`(${agents.metadata}->>'username')::text = ${username}`,
            ne(agents.id, input.personaId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);
      if (existing) {
        return { success: false, error: 'That username is already taken.' };
      }
    }
    metadataUpdates.username = username || undefined;
  }

  if (input.bio !== undefined) {
    const bio = input.bio.trim();
    if (bio.length > MAX_BIO_LENGTH) {
      return { success: false, error: 'Bio must be under 500 characters.' };
    }
    metadataUpdates.bio = bio || undefined;
  }

  if (input.image !== undefined) {
    updates.image = input.image || null;
  }

  updates.metadata = metadataUpdates;
  updates.updatedAt = new Date();

  await db
    .update(agents)
    .set(updates as Partial<typeof agents.$inferInsert>)
    .where(eq(agents.id, input.personaId));

  return { success: true };
}

/**
 * Soft-delete a group persona. Admin-gated; persona must belong to the group.
 */
export async function deleteGroupPersona(input: {
  groupId: string;
  personaId: string;
}): Promise<GroupPersonaResult> {
  const auth = await requireGroupAdmin(input.groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  if (!input.personaId || !UUID_RE.test(input.personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  const [persona] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.personaId),
        eq(agents.parentAgentId, input.groupId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by this group.' };
  }

  await db
    .update(agents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, input.personaId));

  // Retract the group persona from peers holding its projection
  // (revocation-contract 2026-08-05).
  emitDomainEvent({
    eventType: EVENT_TYPES.AGENT_DELETED,
    entityType: 'agent',
    entityId: input.personaId,
    actorId: auth.actorId,
    payload: buildRevocationPayload({
      id: input.personaId,
      entityType: 'agent',
    }) as unknown as Record<string, unknown>,
  }).catch(() => {});

  return { success: true };
}

/**
 * Designate which persona acts as the group's AI assistant. Enabling one
 * persona disables `autobotEnabled` on all the group's other personas, so at
 * most one persona is ever the active assistant.
 *
 * Pass `personaId = null` to clear the persona assistant (the group agent's
 * own self-fallback then governs whether public chat is available).
 */
export async function setGroupPersonaAutobotEnabled(input: {
  groupId: string;
  personaId: string | null;
}): Promise<GroupPersonaResult> {
  const auth = await requireGroupAdmin(input.groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  // Disable the flag across every persona first (single source of truth).
  const personas = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.parentAgentId, input.groupId), isNull(agents.deletedAt)));

  for (const persona of personas) {
    const meta = { ...((persona.metadata ?? {}) as Record<string, unknown>) };
    const shouldEnable = input.personaId !== null && persona.id === input.personaId;
    if (Boolean(meta.autobotEnabled) === shouldEnable) continue;
    meta.autobotEnabled = shouldEnable;
    await db
      .update(agents)
      .set({ metadata: meta, updatedAt: new Date() })
      .where(eq(agents.id, persona.id));
  }

  if (input.personaId !== null) {
    const target = personas.find((p) => p.id === input.personaId);
    if (!target) {
      return { success: false, error: 'Persona not found or not owned by this group.' };
    }
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Public resolver (no auth required)
// ---------------------------------------------------------------------------

/**
 * Resolve the group's autobot-enabled persona, falling back to the group agent
 * itself when no child persona carries the flag (mirrors the person app's
 * `findAutobotEnabledPersona`). Reads only public metadata; no auth required.
 *
 * @returns The resolved persona/group agent, or `null` when neither is enabled.
 */
export async function findGroupAutobotPersona(
  groupId: string,
): Promise<SerializedAgent | null> {
  if (!groupId || !UUID_RE.test(groupId)) return null;

  const [persona] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, groupId),
        isNull(agents.deletedAt),
        AUTOBOT_ENABLED_PREDICATE,
      ),
    )
    .limit(1);

  if (persona) return serializeAgent(persona);

  const [self] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, groupId),
        isNull(agents.deletedAt),
        AUTOBOT_ENABLED_PREDICATE,
      ),
    )
    .limit(1);

  return self ? serializeAgent(self) : null;
}
