"use server"

import { auth } from "@/auth"
import { db } from "@/db"
import { agents, ledger, resources } from "@/db/schema"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { isGroupAdmin } from "@/app/actions/group-admin"

type ManagedGroup = {
  id: string
  name: string
  description: string | null
  groupType: string | null
}

const MANAGEABLE_EVENT_OWNER_AGENT_TYPES = [
  "organization",
  "place",
  "ring",
  "family",
  "guild",
  "community",
  "domain",
  "org",
] as const

export type EventTicketOfferingSummary = {
  id: string
  name: string
  description: string
  priceCents: number
  quantity: number | null
  tierId: string
}

async function resolveAuthenticatedUserId(): Promise<string | null> {
  const session = await auth()
  let resolvedUserId = session?.user?.id ?? null

  if (!resolvedUserId && session?.user?.email) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, session.user.email))
      .limit(1)
    resolvedUserId = agent?.id ?? null
  }

  return resolvedUserId
}

export async function fetchManagedGroupsAction(): Promise<ManagedGroup[]> {
  const userId = await resolveAuthenticatedUserId()
  if (!userId) return []

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      type: agents.type,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(and(inArray(agents.type, [...MANAGEABLE_EVENT_OWNER_AGENT_TYPES]), isNull(agents.deletedAt)))
    .orderBy(agents.name)

  const manageable = await Promise.all(
    rows.map(async (group): Promise<ManagedGroup | null> => {
      const metadata = (group.metadata ?? {}) as Record<string, unknown>
      const creatorId = typeof metadata.creatorId === "string" ? metadata.creatorId : null
      const adminIds = Array.isArray(metadata.adminIds) ? metadata.adminIds : []
      if (creatorId === userId || adminIds.includes(userId)) {
        return {
          id: group.id,
          name: group.name,
          description: group.description,
          groupType:
            typeof metadata.groupType === "string"
              ? metadata.groupType
              : typeof metadata.placeType === "string"
                ? metadata.placeType
                : group.type ?? null,
        }
      }

      if (await isGroupAdmin(userId, group.id)) {
        return {
          id: group.id,
          name: group.name,
          description: group.description,
          groupType:
            typeof metadata.groupType === "string"
              ? metadata.groupType
              : typeof metadata.placeType === "string"
                ? metadata.placeType
                : group.type ?? null,
        }
      }

      const [grant] = await db.execute(sql`
        SELECT id
        FROM ledger
        WHERE subject_id = ${userId}::uuid
          AND object_id = ${group.id}::uuid
          AND is_active = true
          AND verb IN ('own', 'manage', 'join', 'belong')
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `) as Array<Record<string, unknown>>

      if (!grant) return null
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        groupType:
          typeof metadata.groupType === "string"
            ? metadata.groupType
            : typeof metadata.placeType === "string"
              ? metadata.placeType
              : group.type ?? null,
      }
    })
  )

  return manageable.filter((group): group is ManagedGroup => Boolean(group))
}

export async function fetchEventTicketOfferingsAction(eventId: string): Promise<EventTicketOfferingSummary[]> {
  const session = await auth();
  if (!session?.user?.id) return [];
  if (!eventId) return []

  const rows = await db
    .select({
      id: resources.id,
      name: resources.name,
      description: resources.description,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        isNull(resources.deletedAt),
        eq(resources.type, "listing"),
        sql`metadata->>'eventId' = ${eventId}`,
        sql`lower(coalesce(metadata->>'productKind', '')) = 'ticket'`,
        sql`coalesce(metadata->>'status', 'active') != 'archived'`
      )
    )
    .orderBy(resources.createdAt)

  return rows.map((row, index) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const priceCents =
      typeof metadata.totalPriceCents === "number"
        ? metadata.totalPriceCents
        : typeof metadata.ticketPriceCents === "number"
          ? metadata.ticketPriceCents
          : typeof metadata.ticketPrice === "number"
            ? Math.round(metadata.ticketPrice * 100)
            : 0

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      priceCents,
      quantity: typeof metadata.ticketQuantity === "number" ? metadata.ticketQuantity : null,
      tierId:
        typeof metadata.ticketTierId === "string" && metadata.ticketTierId.length > 0
          ? metadata.ticketTierId
          : `ticket-${index + 1}`,
    }
  })
}
