'use server';

/**
 * Server actions for persona management.
 *
 * Personas are child agents linked to a parent account via `parent_agent_id`.
 * They share the parent's wallet but own their own content, profile, and social graph.
 *
 * Key exports:
 * - `createPersona` - Creates a new persona agent under the current user
 * - `listMyPersonas` - Returns all personas owned by the current user
 * - `updatePersona` - Updates a persona's profile fields
 * - `deletePersona` - Soft-deletes a persona
 * - `switchActivePersona` - Sets the active persona cookie
 * - `getActivePersonaInfo` - Returns info about the currently active persona
 */

import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  getActivePersonaId,
  setActivePersonaCookie,
  MAX_PERSONAS_PER_ACCOUNT,
} from '@/lib/persona';
import { serializeAgent } from '@/lib/graph-serializers';
import type { SerializedAgent } from '@/lib/graph-serializers';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum lengths for persona profile fields. */
const MAX_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 40;
const MAX_BIO_LENGTH = 500;

/**
 * Gets the authenticated user ID or throws.
 */
async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Unauthorized');
  return userId;
}

/**
 * Creates a new persona agent under the current user's account.
 *
 * The persona is a regular agent row with:
 * - `parent_agent_id` set to the current user
 * - `type` = 'person'
 * - `metadata.isPersona` = true
 * - No email or password (personas cannot log in independently)
 */
export async function createPersona(input: {
  name: string;
  username?: string;
  bio?: string;
}): Promise<{ success: boolean; personaId?: string; error?: string }> {
  const userId = await requireUserId();

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

  // Check persona limit
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    );
  const currentCount = Number(countResult?.count ?? 0);
  if (currentCount >= MAX_PERSONAS_PER_ACCOUNT) {
    return {
      success: false,
      error: `You can have at most ${MAX_PERSONAS_PER_ACCOUNT} personas.`,
    };
  }

  // Check username uniqueness if provided
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
    bio: bio || undefined,
    username: username || undefined,
  };

  const [newAgent] = await db
    .insert(agents)
    .values({
      name,
      type: 'person',
      parentAgentId: userId,
      visibility: 'public',
      metadata,
    })
    .returning({ id: agents.id });

  return { success: true, personaId: newAgent.id };
}

/**
 * Lists all personas belonging to the current user.
 */
export async function listMyPersonas(): Promise<{
  success: boolean;
  personas?: SerializedAgent[];
  activePersonaId?: string | null;
  error?: string;
}> {
  const userId = await requireUserId();

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(agents.createdAt);

  const activeId = await getActivePersonaId();

  return {
    success: true,
    personas: rows.map((r) => serializeAgent(r)),
    activePersonaId: activeId,
  };
}

/**
 * Updates a persona's profile fields.
 * Only the parent account can update its personas.
 */
export async function updatePersona(input: {
  personaId: string;
  name?: string;
  username?: string;
  bio?: string;
  image?: string;
}): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (!input.personaId || !UUID_RE.test(input.personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.personaId),
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by you.' };
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
    // Check uniqueness (excluding self)
    if (username) {
      const [existing] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            sql`(${agents.metadata}->>'username')::text = ${username}`,
            sql`${agents.id} != ${input.personaId}`,
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
 * Soft-deletes a persona. Must be owned by the current user.
 * If the deleted persona was active, clears the persona cookie.
 */
export async function deletePersona(
  personaId: string,
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (!personaId || !UUID_RE.test(personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, personaId),
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  await db
    .update(agents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, personaId));

  // Clear active persona if it was the deleted one
  const activeId = await getActivePersonaId();
  if (activeId === personaId) {
    await setActivePersonaCookie(null);
  }

  return { success: true };
}

/**
 * Switches the active persona. Pass null to revert to the main account.
 */
export async function switchActivePersona(
  personaId: string | null,
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (personaId === null) {
    await setActivePersonaCookie(null);
    return { success: true };
  }

  if (!UUID_RE.test(personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, personaId),
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  await setActivePersonaCookie(personaId);
  return { success: true };
}

/**
 * Returns info about the currently active persona (or null if operating as self).
 */
export async function getActivePersonaInfo(): Promise<{
  active: boolean;
  persona?: SerializedAgent;
}> {
  const activeId = await getActivePersonaId();
  if (!activeId) return { active: false };

  const [persona] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, activeId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona || !persona.parentAgentId) {
    return { active: false };
  }

  return {
    active: true,
    persona: serializeAgent(persona),
  };
}
