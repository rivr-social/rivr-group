"use server"

/**
 * Server actions for guest agent lifecycle.
 *
 * Guest agents are lightweight person records created without a password or
 * email verification. They exist to associate Stripe purchases with an
 * identity that can later be "upgraded" to a full account via signup merge
 * (see `signupAction` in `auth.ts`).
 *
 * Key exports:
 * - `createGuestAgentAction(name, email, stripeCustomerId?)` — creates or returns existing agent
 * - `findGuestByEmailAction(email)` — looks up a guest agent by email
 *
 * Primary dependencies:
 * - `@/db` + `@/db/schema` for agent persistence
 * - `@/lib/rate-limit` for abuse protection
 */

import { db } from "@/db"
import { agents, type NewAgent } from "@/db/schema"
import { eq } from "drizzle-orm"
import { headers } from "next/headers"
import { rateLimit } from "@/lib/rate-limit"
import { getClientIp } from "@/lib/client-ip"

// Rate limit constants — relaxed in development for E2E testing
const isDev = process.env.NODE_ENV !== "production"
const GUEST_CREATE_RATE_LIMIT = isDev ? 50 : 10
const GUEST_CREATE_WINDOW_MS = isDev ? 60 * 1000 : 60 * 60 * 1000 // 1min dev, 1hr prod

const MAX_NAME_LENGTH = 100
const MAX_EMAIL_LENGTH = 255

type GuestCreateResult = {
  success: boolean
  agentId?: string
  error?: string
}

/**
 * Creates a guest agent (no password, no email verification) for purchase tracking.
 *
 * If an agent with the given email already exists (whether guest or real),
 * returns the existing agent ID instead of creating a duplicate.
 *
 * @param name - Display name for the guest.
 * @param email - Email address (used as unique key).
 * @param stripeCustomerId - Optional Stripe customer ID to store in metadata.
 * @returns Object with success flag and agentId or error message.
 */
export async function createGuestAgentAction(
  name: string,
  email: string,
  stripeCustomerId?: string
): Promise<GuestCreateResult> {
  const headersList = await headers()
  const clientIp = getClientIp(headersList)

  const limiter = await rateLimit(
    `guest_create:${clientIp}`,
    GUEST_CREATE_RATE_LIMIT,
    GUEST_CREATE_WINDOW_MS
  )
  if (!limiter.success) {
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000)
    return {
      success: false,
      error: `Too many requests. Please try again in ${retryAfterSec} seconds.`,
    }
  }

  if (!name || name.trim().length === 0) {
    return { success: false, error: "Name is required." }
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { success: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` }
  }

  if (!email || email.trim().length === 0) {
    return { success: false, error: "Email is required." }
  }

  if (email.length > MAX_EMAIL_LENGTH) {
    return { success: false, error: "Email is too long." }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const normalizedEmail = email.toLowerCase().trim()
  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, error: "Please enter a valid email address." }
  }

  try {
    // Check for existing agent with this email (guest or real)
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, normalizedEmail))
      .limit(1)

    if (existing) {
      return { success: true, agentId: existing.id }
    }

    // Build metadata for the guest agent
    const metadata: Record<string, unknown> = { noSignin: true }
    if (stripeCustomerId) {
      metadata.stripeCustomerId = stripeCustomerId
    }

    const [newAgent] = await db
      .insert(agents)
      .values({
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: null,
        emailVerified: null,
        type: "person",
        metadata,
      } as NewAgent)
      .returning({ id: agents.id })

    return { success: true, agentId: newAgent.id }
  } catch (error) {
    console.error("[guest] Failed to create guest agent:", error)
    return { success: false, error: "Failed to create guest account. Please try again." }
  }
}

/**
 * Finds an existing guest agent by email address.
 *
 * A "guest" is identified by having `metadata.noSignin === true`.
 *
 * @param email - Email address to search for.
 * @returns The agent record if found and is a guest, or null.
 */
export async function findGuestByEmailAction(
  email: string
): Promise<{ id: string; name: string; email: string | null; metadata: Record<string, unknown> } | null> {
  if (!email || email.trim().length === 0) {
    return null
  }

  const normalizedEmail = email.toLowerCase().trim()

  try {
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        email: agents.email,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.email, normalizedEmail))
      .limit(1)

    if (!agent) return null

    // Only return if this is actually a guest agent
    const meta = agent.metadata as Record<string, unknown> | null
    if (!meta?.noSignin) return null

    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      metadata: meta,
    }
  } catch (error) {
    console.error("[guest] Failed to find guest by email:", error)
    return null
  }
}
