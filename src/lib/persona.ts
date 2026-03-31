/**
 * Persona session helpers.
 *
 * Manages the "active persona" cookie and provides `getOperatingAgentId()`
 * which resolves the current acting identity — either the active persona
 * or the authenticated user's own agent ID.
 *
 * Wallet operations should always resolve to the parent agent ID via
 * `getWalletOwnerId()`.
 */
import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';

/** Cookie name for tracking the active persona. */
const PERSONA_COOKIE = 'rivr-active-persona';

/** Max personas per account. */
export const MAX_PERSONAS_PER_ACCOUNT = 10;

/**
 * UUID format check used for persona IDs.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the authenticated user's agent ID from the NextAuth session.
 * Returns null if not authenticated.
 */
export async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/**
 * Reads the active persona ID from the cookie store.
 * Returns null if no persona is active or if the cookie is not set.
 */
export async function getActivePersonaId(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PERSONA_COOKIE)?.value;
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

/**
 * Sets the active persona cookie. Pass null to clear (revert to main account).
 */
export async function setActivePersonaCookie(personaId: string | null): Promise<void> {
  const cookieStore = await cookies();
  if (!personaId) {
    cookieStore.delete(PERSONA_COOKIE);
  } else {
    cookieStore.set(PERSONA_COOKIE, personaId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7 days, matching JWT session
    });
  }
}

/**
 * Returns the agent ID to use for content creation and social actions.
 * If a persona is active (and valid/owned), returns the persona ID.
 * Otherwise returns the authenticated user's own agent ID.
 */
export async function getOperatingAgentId(): Promise<string | null> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return null;

  const personaId = await getActivePersonaId();
  if (!personaId) return userId;

  // Validate the persona belongs to this user and is not deleted
  const [persona] = await db
    .select({ id: agents.id, parentAgentId: agents.parentAgentId })
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
    // Invalid persona cookie — clear it and fall back to main user
    await setActivePersonaCookie(null);
    return userId;
  }

  return personaId;
}

/**
 * Returns the agent ID that should own wallet operations.
 * If the operating agent is a persona, resolves to the parent account.
 * This ensures personas share the parent's wallet.
 */
export async function getWalletOwnerId(): Promise<string | null> {
  const userId = await getAuthenticatedUserId();
  if (!userId) return null;
  // Wallet always belongs to the root/parent account, not the persona
  return userId;
}

/**
 * Checks whether a given agent ID is a persona of the specified parent.
 */
export async function isPersonaOf(
  agentId: string,
  parentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.parentAgentId, parentId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Checks whether a given agent is a persona (has a parent_agent_id set).
 */
export async function isPersona(agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ parentAgentId: agents.parentAgentId })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return !!row?.parentAgentId;
}
