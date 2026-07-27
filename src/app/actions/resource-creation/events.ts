"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  ledger,
  resources,
  type NewLedgerEntry,
  type VisibilityLevel,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasCapability } from "@/lib/entitlements-server";

import {
  resolveAuthenticatedUserId,
  canPostToGroup,
  createResourceWithLedger,
} from "./helpers";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";
import { syncResourceToGoogle } from "@/lib/google/calendar-sync";
import type { ActionResult, EventTicketInput, NormalizedEventTicket } from "./types";
import { normalizeEventTickets } from "./types";

const MAX_EVENT_DESCRIPTION_LENGTH = 50000;

export async function syncEventTicketOfferings(params: {
  eventId: string;
  ownerId: string;
  eventName: string;
  eventDescription: string;
  visibility: VisibilityLevel;
  tags: string[];
  scopedLocaleIds?: string[];
  scopedRegionIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  ticketTypes: NormalizedEventTicket[];
}): Promise<void> {
  const syncTargetAgentId = params.ownerId;
  const facadeResult = await updateFacade.execute(
    {
      type: "syncEventTicketOfferings",
      actorId: params.ownerId,
      targetAgentId: syncTargetAgentId,
      payload: params,
    },
    async () => {
  const existingOfferings = await db
    .select({
      id: resources.id,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        sql`${resources.deletedAt} IS NULL`,
        eq(resources.type, "listing"),
        sql`metadata->>'eventId' = ${params.eventId}`,
        sql`lower(coalesce(metadata->>'productKind', '')) = 'ticket'`
      )
    );

  const existingByTierId = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  for (const offering of existingOfferings) {
    const metadata = (offering.metadata ?? {}) as Record<string, unknown>;
    const tierId = typeof metadata.ticketTierId === "string" && metadata.ticketTierId.length > 0
      ? metadata.ticketTierId
      : "general-admission";
    existingByTierId.set(tierId, { id: offering.id, metadata });
  }

  const keepTierIds = new Set(params.ticketTypes.map((ticket) => ticket.id));
  for (const ticket of params.ticketTypes) {
    const existing = existingByTierId.get(ticket.id);
    const formattedPrice = ticket.priceCents > 0
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(ticket.priceCents / 100)
      : "Free";
    const metadata = {
      entityType: "offering",
      resourceKind: "offering",
      listingType: "product",
      offeringType: "ticket",
      productKind: "ticket",
      eventId: params.eventId,
      eventName: params.eventName,
      ticketTierId: ticket.id,
      ticketQuantity: ticket.quantity,
      ticketPrice: ticket.priceCents / 100,
      ticketPriceCents: ticket.priceCents,
      totalPriceCents: ticket.priceCents,
      price: formattedPrice,
      items: [{ resourceId: params.eventId, term: ticket.term, priceCents: ticket.priceCents }],
      targetAgentTypes: ["person"],
      scopedLocaleIds: params.scopedLocaleIds ?? [],
      scopedRegionIds: params.scopedRegionIds ?? [],
      scopedGroupIds: params.scopedGroupIds ?? [],
      scopedUserIds: params.scopedUserIds ?? [],
      status: "active",
    } satisfies Record<string, unknown>;

    if (existing) {
      await db
        .update(resources)
        .set({
          ownerId: params.ownerId,
          name: `${params.eventName} — ${ticket.name}`,
          description: `${ticket.name} for ${params.eventName}. ${ticket.description || params.eventDescription}`.trim(),
          content: params.eventDescription || null,
          visibility: params.visibility,
          tags: params.tags,
          metadata: {
            ...existing.metadata,
            ...metadata,
          },
        })
        .where(eq(resources.id, existing.id));
      continue;
    }

    await createResourceWithLedger({
      ownerId: params.ownerId,
      name: `${params.eventName} — ${ticket.name}`,
      type: "listing",
      description: `${ticket.name} for ${params.eventName}. ${ticket.description || params.eventDescription}`.trim(),
      content: params.eventDescription,
      visibility: params.visibility,
      tags: params.tags,
      metadata,
    });
  }

  for (const offering of existingOfferings) {
    const metadata = (offering.metadata ?? {}) as Record<string, unknown>;
    const tierId = typeof metadata.ticketTierId === "string" && metadata.ticketTierId.length > 0
      ? metadata.ticketTierId
      : "general-admission";
    if (keepTierIds.has(tierId)) continue;
    await db
      .update(resources)
      .set({
        visibility: "private",
        metadata: {
          ...metadata,
          status: "archived",
          archivedAt: new Date().toISOString(),
        },
      })
      .where(eq(resources.id, offering.id));
  }
    },
  );

  if (!facadeResult.success) {
    throw new Error(facadeResult.error ?? "syncEventTicketOfferings facade failed");
  }
}

export async function createEventResource(input: {
  title: string;
  description: string;
  date: string;
  time: string;
  /** Optional event END date/time — gives the event a real date-time range. */
  endDate?: string | null;
  endTime?: string | null;
  location: string;
  /**
   * Structured venue address for in-person events. Admissions tax sources to
   * the VENUE, so paid tickets for an in-person event require this (mediated
   * checkout refuses without it — see lib/stripe-tax MEDIATED_TICKET_VENUE_
   * REQUIRED_MESSAGE).
   */
  venueAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  } | null;
  eventType: "in-person" | "online";
  /**
   * Host a Virtual Meeting on this instance: the event page opens a LiveKit
   * room during the event window; the session is recorded per participant
   * and a speaker-identified transcript lands on the event.
   */
  virtualMeeting?: boolean;
  price?: number | null;
  imageUrl?: string;
  ownerId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
  venueId?: string | null;
  venueStartTime?: string | null;
  venueEndTime?: string | null;
  localeId?: string | null;
  regionId?: string | null;
  scopedLocaleIds?: string[];
  scopedRegionIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
  ticketTypes?: EventTicketInput[];
}): Promise<ActionResult> {
  // Location is OPTIONAL, matching the create form's intent (the location
  // section is collapsed by default and treated as optional). Requiring it
  // server-side blocked basic + virtual/online events with an opaque "all
  // required fields" message for an invisible field. Require only the surfaced
  // fields and name the specific missing one(s).
  const missingFields = [
    !input.title?.trim() && "Title",
    !input.description?.trim() && "Description",
    !input.date && "Date",
    !input.time && "Time",
  ].filter((f): f is string => Boolean(f));
  if (missingFields.length > 0) {
    return {
      success: false,
      message:
        missingFields.length === 1
          ? `${missingFields[0]} is required to create an event.`
          : `These fields are required to create an event: ${missingFields.join(", ")}.`,
      error: {
        code: "INVALID_INPUT",
      },
    };
  }

  if (input.description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description exceeds maximum length of ${MAX_EVENT_DESCRIPTION_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const resolvedUserId = await resolveAuthenticatedUserId();
  if (!resolvedUserId) {
    return {
      success: false,
      message: "You must be logged in to create events",
      error: {
        code: "UNAUTHENTICATED",
      },
    };
  }

  if (input.groupId) {
    // Group-linked events must be created by a member with group write capability.
    const allowed = await canPostToGroup(resolvedUserId, input.groupId, "create");
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to create events for this group.",
        error: { code: "FORBIDDEN" },
      };
    }
  }

  const ownerId = input.ownerId ?? input.groupId ?? resolvedUserId;
  if (ownerId !== resolvedUserId) {
    const allowed = await canPostToGroup(resolvedUserId, ownerId, "create");
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to post this event as that group.",
        error: { code: "FORBIDDEN" },
      };
    };
  }

  const normalizedTickets = normalizeEventTickets({ ticketTypes: input.ticketTypes, price: input.price });
  const isPaidTicketedEvent = normalizedTickets.some((ticket) => ticket.priceCents > 0);
  if (isPaidTicketedEvent) {
    // Paid ticketing requires the sell_tickets capability (Host / Provider /
    // Organization / Steward / Worker — NOT Seller).
    const canSellTickets = await hasCapability(resolvedUserId, "sell_tickets");
    if (!canSellTickets) {
      return {
        success: false,
        message: "Paid ticketed events require a Host, Provider, or Organization membership.",
        error: {
          code: "SUBSCRIPTION_REQUIRED",
          details: "Subscribe to Host, Provider, or Organization to sell event tickets.",
          requiredTier: "host",
        },
      };
    }
  }

  // Determine visibility from scoping selections.
  // Regions are place-typed agents (metadata.placeType region/basin), scoped the
  // same way locales are — folded into the place-scope (chapterTags) set and the
  // place-scoped "locale" visibility level — but tracked distinctly in metadata.
  const hasScopedLocales = Array.isArray(input.scopedLocaleIds) && input.scopedLocaleIds.length > 0;
  const hasScopedRegions = Array.isArray(input.scopedRegionIds) && input.scopedRegionIds.length > 0;
  const hasScopedGroups = Array.isArray(input.scopedGroupIds) && input.scopedGroupIds.length > 0;
  const hasScopedUsers = Array.isArray(input.scopedUserIds) && input.scopedUserIds.length > 0;
  const hasAnyScoping = hasScopedLocales || hasScopedRegions || hasScopedGroups || hasScopedUsers;

  // isGlobal defaults to true — events are globally discoverable unless the user opts out.
  const isGlobal = input.isGlobal !== false;
  let eventVisibility: VisibilityLevel = "public";
  if (!isGlobal) {
    // User explicitly opted out of global visibility.
    eventVisibility = hasScopedGroups || hasScopedUsers ? "private" : hasScopedLocales || hasScopedRegions ? "locale" : "members";
  } else if (hasAnyScoping) {
    // Globally visible but also tagged for locale/group discovery.
    eventVisibility = "public";
  }

  const scopedRegionIds = Array.from(
    new Set(
      [
        ...(Array.isArray(input.scopedRegionIds) ? input.scopedRegionIds : []),
        ...(input.regionId && input.regionId !== "all" ? [input.regionId] : []),
      ].filter((id) => id && id !== "all"),
    ),
  );
  const derivedLocaleId =
    (Array.isArray(input.scopedLocaleIds) && input.scopedLocaleIds.length > 0
      ? input.scopedLocaleIds[0]
      : input.localeId && input.localeId !== "all"
        ? input.localeId
        : null);
  const baseChapterTags = derivedLocaleId ? [derivedLocaleId] : [];
  const allScopeTags = Array.from(new Set([
    ...baseChapterTags,
    ...(input.scopedLocaleIds ?? []),
    ...scopedRegionIds,
    ...(input.scopedGroupIds ?? []),
    ...(input.scopedUserIds ?? []),
  ]));

  const eventTargetAgentId = ownerId;
  const facadeResult = await updateFacade.execute(
    {
      type: "createEventResource",
      actorId: resolvedUserId,
      targetAgentId: eventTargetAgentId,
      payload: input,
    },
    async () => {
      const result = await createResourceWithLedger({
        ownerId,
        name: input.title,
        type: "event",
        description: input.description,
        content: input.description,
        visibility: eventVisibility,
        tags: allScopeTags,
        metadata: {
          entityType: "event",
          resourceKind: "event",
          date: input.date,
          time: input.time,
          endDate: input.endDate ?? null,
          endTime: input.endTime ?? null,
          location: input.location,
          venueAddress:
            input.venueAddress && input.venueAddress.line1?.trim()
              ? {
                  line1: input.venueAddress.line1.trim(),
                  ...(input.venueAddress.line2?.trim()
                    ? { line2: input.venueAddress.line2.trim() }
                    : {}),
                  city: input.venueAddress.city?.trim() ?? "",
                  state: input.venueAddress.state?.trim().toUpperCase() ?? "",
                  postalCode: input.venueAddress.postalCode?.trim() ?? "",
                  country: input.venueAddress.country?.trim().toUpperCase() || "US",
                }
              : null,
          imageUrl: input.imageUrl ?? null,
          images: input.imageUrl ? [input.imageUrl] : [],
          chapterTags: Array.from(new Set([...baseChapterTags, ...(input.scopedLocaleIds ?? []), ...scopedRegionIds])),
          eventType: input.eventType,
          price: normalizedTickets[0]?.priceCents ? normalizedTickets[0].priceCents / 100 : input.price ?? null,
          groupId: input.groupId ?? (ownerId !== resolvedUserId ? ownerId : null),
          projectId: input.projectId ?? null,
          venueId: input.venueId ?? null,
          venueStartTime: input.venueStartTime ?? null,
          venueEndTime: input.venueEndTime ?? null,
          localeId: derivedLocaleId,
          regionId: scopedRegionIds[0] ?? (input.regionId && input.regionId !== "all" ? input.regionId : null),
          ticketTypes: normalizedTickets.map((ticket) => ({
            id: ticket.id,
            name: ticket.name,
            description: ticket.description,
            quantity: ticket.quantity,
            priceCents: ticket.priceCents,
          })),
          isGlobal,
          scopedLocaleIds: input.scopedLocaleIds ?? [],
          scopedRegionIds,
          scopedGroupIds: input.scopedGroupIds ?? [],
          scopedUserIds: input.scopedUserIds ?? [],
          ...(input.eftValues ? { eftValues: input.eftValues } : {}),
          ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
          ...(input.auditValues ? { auditValues: input.auditValues } : {}),
          ...(input.virtualMeeting
            ? { meetingKind: "virtual-meeting", transcriptionEnabled: true }
            : {}),
        },
      });

      if (!result.success || !result.resourceId) return result;

      try {
        await syncEventTicketOfferings({
          eventId: result.resourceId,
          ownerId,
          eventName: input.title,
          eventDescription: input.description,
          visibility: eventVisibility,
          tags: allScopeTags,
          scopedLocaleIds: input.scopedLocaleIds,
          scopedRegionIds,
          scopedGroupIds: input.scopedGroupIds,
          scopedUserIds: input.scopedUserIds,
          ticketTypes: normalizedTickets,
        });
      } catch (error) {
        console.error("[createEventResource] companion offering creation failed:", error);
      }

      // Best-effort outbound sync to Google Calendar when the owning group
      // has an active Workspace connection with calendarSyncEnabled. Failures
      // are logged but never propagated — calendar sync must not block event
      // creation. Inbound polling is handled by the dedicated cron route.
      const groupIdForSync =
        input.groupId ?? (ownerId !== resolvedUserId ? ownerId : null);
      if (groupIdForSync && result.resourceId) {
        try {
          const outcome = await syncResourceToGoogle(result.resourceId, groupIdForSync);
          if (!outcome.ok) {
            console.error(
              `[createEventResource] google calendar sync (${outcome.code}) for ${result.resourceId}: ${outcome.message ?? ""}`,
            );
          }
        } catch (error) {
          console.error("[createEventResource] google calendar sync threw:", error);
        }
      }

      // Create ledger grants for scoped groups and users
      if (hasAnyScoping && result.resourceId) {
        const grantEntries: Array<{ subjectId: string }> = [
          ...(input.scopedGroupIds ?? []).map(id => ({ subjectId: id })),
          ...(input.scopedUserIds ?? []).map(id => ({ subjectId: id })),
        ];

        if (grantEntries.length > 0) {
          try {
            await db.insert(ledger).values(
              grantEntries.map(entry => ({
                verb: "grant" as const,
                subjectId: entry.subjectId,
                objectId: result.resourceId!,
                objectType: "resource" as const,
                resourceId: result.resourceId!,
                isActive: true,
                metadata: { action: "view", source: "visibility-scope" },
              } as NewLedgerEntry))
            );
          } catch (error) {
            console.error("[createEventResource] grant creation failed:", error);
          }
        }
      }

      return result;
    },
  );

  if (!facadeResult.success) {
    return {
      success: false,
      message: facadeResult.error ?? "Failed to create event",
      error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const actionResult = facadeResult.data as ActionResult;

  if (actionResult?.success && actionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.EVENT_CREATED,
      entityType: "resource",
      entityId: actionResult.resourceId,
      actorId: resolvedUserId,
      payload: { eventType: input.eventType, groupId: input.groupId ?? null, ownerId },
    }).catch(() => {});
  }

  return actionResult;
}
