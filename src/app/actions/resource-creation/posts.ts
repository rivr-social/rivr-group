"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewLedgerEntry,
  type NewResource,
  type VisibilityLevel,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getActiveSubscription, hasEntitlement } from "@/lib/billing";
import { embedResource, scheduleEmbedding } from "@/lib/ai";
import { getAgent } from "@/lib/queries/agents";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";
import { getHostedNodeForOwner, queueEntityExportEvents } from "@/lib/federation";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
  createResourceWithLedger,
} from "./helpers";
import type { ActionResult } from "./types";
import { createEventResource } from "./events";
import { createDocumentResourceAction, updateResource } from "./lifecycle";

const MAX_POST_CONTENT_LENGTH = 50000;

async function maybeCreateLinkedMeetingBundle(params: {
  actorId: string;
  postId: string;
  title: string;
  content: string;
  groupId?: string;
  liveLocation?: { lat: number; lng: number } | null;
  localeId?: string | null;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
}): Promise<Pick<ActionResult, "linkedEventId" | "linkedDocumentId" | "message"> | null> {
  if (!params.groupId) return null;

  const meetingTitle = params.title.trim() ? `Meeting: ${params.title.trim()}` : "Live Invite Meeting";
  const start = new Date();
  const meetingLocation = params.liveLocation
    ? `Live location shared (${params.liveLocation.lat.toFixed(5)}, ${params.liveLocation.lng.toFixed(5)})`
    : "Live location shared";

  const eventResult = await createEventResource({
    title: meetingTitle,
    description: params.content.trim(),
    date: start.toISOString().slice(0, 10),
    time: start.toISOString(),
    location: meetingLocation,
    eventType: "in-person",
    ownerId: params.groupId,
    groupId: params.groupId,
    localeId: params.localeId ?? null,
    scopedLocaleIds: params.scopedLocaleIds,
    scopedGroupIds: Array.from(new Set([params.groupId, ...(params.scopedGroupIds ?? [])])),
    scopedUserIds: params.scopedUserIds,
    isGlobal: params.isGlobal,
  });

  if (!eventResult.success || !eventResult.resourceId) {
    return {
      message: "Post created, but linked meeting creation failed.",
    };
  }

  const transcriptResult = await createDocumentResourceAction({
    groupId: params.groupId,
    title: `${meetingTitle} Transcript`,
    description: `Collaborative transcript for ${meetingTitle}.`,
    content: `# ${meetingTitle} Transcript\n\nCollaborative transcript for this meeting.\n`,
    category: "meeting-transcript",
    tags: ["meeting", "transcript", eventResult.resourceId],
    showOnAbout: false,
  });

  const transcriptDocumentId = transcriptResult.success ? transcriptResult.resourceId ?? undefined : undefined;

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  await updateResource({
    resourceId: params.postId,
    metadataPatch: {
      eventId: eventResult.resourceId,
      linkedEventId: eventResult.resourceId,
      transcriptDocumentId: transcriptDocumentId ?? null,
      liveInviteMeetingCreatedAt: start.toISOString(),
    },
  });

  await updateResource({
    resourceId: eventResult.resourceId,
    metadataPatch: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      location: params.liveLocation
        ? {
            name: "Live location shared",
            address: meetingLocation,
            coordinates: params.liveLocation,
          }
        : meetingLocation,
      linkedPostId: params.postId,
      transcriptDocumentId: transcriptDocumentId ?? null,
      transcriptionEnabled: Boolean(transcriptDocumentId),
      meetingKind: "live-invite",
    },
  });

  if (transcriptDocumentId) {
    await updateResource({
      resourceId: transcriptDocumentId,
      metadataPatch: {
        resourceSubtype: "event-transcript",
        eventId: eventResult.resourceId,
        linkedPostId: params.postId,
        transcriptUpdatedAt: start.toISOString(),
      },
    });
  }

  return {
    linkedEventId: eventResult.resourceId,
    linkedDocumentId: transcriptDocumentId,
    message: transcriptDocumentId
      ? "Post created successfully with a linked meeting and transcript."
      : "Post created successfully with a linked meeting.",
  };
}

export async function createPostResource(input: {
  title?: string;
  content: string;
  postType?: string;
  isLiveInvitation?: boolean;
  liveLocation?: { lat: number; lng: number } | null;
  linkedOfferingId?: string | null;
  totalPriceCents?: number;
  offeringType?: string;
  eventId?: string;
  groupId?: string;
  imageUrl?: string | null;
  localeId?: string | null;
  gratitudeRecipientId?: string | null;
  gratitudeRecipientName?: string | null;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
  federate?: boolean;
}): Promise<ActionResult> {
  if (!input.content || !input.content.trim()) {
    return {
      success: false,
      message: "Post content is required",
      error: {
        code: "INVALID_INPUT",
      },
    };
  }

  if (input.content.length > MAX_POST_CONTENT_LENGTH) {
    return {
      success: false,
      message: `Content exceeds maximum length of ${MAX_POST_CONTENT_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create content",
      error: {
        code: "UNAUTHENTICATED",
      },
    };
  }

  if (input.groupId) {
    // Posting into a group requires explicit write access to prevent unauthorized publishing.
    const allowed = await hasGroupWriteAccess(userId, input.groupId);
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to post in this group.",
        error: { code: "FORBIDDEN" },
      };
    }
  }

  const fallbackTitle = input.content.trim().slice(0, 80);
  const scopedLocaleIds = Array.from(
    new Set(
      [
        ...(Array.isArray(input.scopedLocaleIds) ? input.scopedLocaleIds : []),
        ...(input.localeId && input.localeId !== "all" ? [input.localeId] : []),
      ].filter((id) => id && id !== "all"),
    ),
  );
  const scopedGroupIds = Array.isArray(input.scopedGroupIds) ? input.scopedGroupIds : [];
  const scopedUserIds = Array.isArray(input.scopedUserIds) ? input.scopedUserIds : [];
  const chapterTags = scopedLocaleIds;
  const groupTags = Array.from(new Set([...(input.groupId ? [input.groupId] : []), ...scopedGroupIds]));
  const scopeTags = Array.from(new Set([...chapterTags, ...groupTags, ...scopedUserIds]));
  const hasScopedLocales = scopedLocaleIds.length > 0;
  const hasScopedGroups = scopedGroupIds.length > 0;
  const hasScopedUsers = scopedUserIds.length > 0;
  const wantsGlobal = input.isGlobal !== false;
  let visibility: VisibilityLevel = "public";
  if (hasScopedGroups || hasScopedUsers) {
    visibility = "private";
  } else if (hasScopedLocales || !wantsGlobal) {
    visibility = "locale";
  }

  // Compute live invitation expiry (1 hour from now) when location is provided.
  const isLive = (input.isLiveInvitation ?? false) && input.liveLocation != null;
  const liveExpiresAt = isLive
    ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    : null;

  // Embed author identity in metadata so post cards render correctly without a separate fetch.
  const authorAgent = await getAgent(userId);

  // Scope tags encode chapter/group visibility hints used by feed and discovery queries.
  const targetAgentId = input.groupId || userId;
  const facadeResult = await updateFacade.execute(
    {
      type: "createPostResource",
      actorId: userId,
      targetAgentId,
      payload: input,
    },
    async () => {
      return createResourceWithLedger({
        name: input.title?.trim() || fallbackTitle,
        type: "post",
        content: input.content,
        visibility,
        tags: scopeTags,
        ...(isLive && input.liveLocation ? { location: input.liveLocation } : {}),
        metadata: {
          entityType: "post",
          postType: input.postType ?? "social",
          isLiveInvitation: isLive,
          liveExpiresAt,
          linkedOfferingId: input.linkedOfferingId ?? null,
          totalPriceCents: input.totalPriceCents ?? null,
          offeringType: input.offeringType ?? null,
          eventId: input.eventId ?? null,
          groupId: input.groupId ?? null,
          gratitudeRecipientId: input.gratitudeRecipientId ?? null,
          gratitudeRecipientName: input.gratitudeRecipientName ?? null,
          imageUrl: input.imageUrl ?? null,
          images: input.imageUrl ? [input.imageUrl] : [],
          chapterTags,
          groupTags,
          scopedLocaleIds,
          scopedGroupIds,
          scopedUserIds,
          isGlobal: wantsGlobal,
          authorName: authorAgent?.name ?? null,
          authorImage: authorAgent?.image ?? null,
          ...(input.eftValues ? { eftValues: input.eftValues } : {}),
          ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
          ...(input.auditValues ? { auditValues: input.auditValues } : {}),
        },
        federate: input.federate === true,
      });
    },
  );

  if (!facadeResult.success) {
    return {
      success: false,
      message: facadeResult.error ?? "Failed to create post",
      error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const actionResult = facadeResult.data as ActionResult;

  if (actionResult?.success && actionResult.resourceId) {
    const linkedBundle =
      isLive && input.groupId && !input.eventId
        ? await maybeCreateLinkedMeetingBundle({
            actorId: userId,
            postId: actionResult.resourceId,
            title: input.title?.trim() || fallbackTitle,
            content: input.content,
            groupId: input.groupId,
            liveLocation: input.liveLocation,
            localeId: input.localeId ?? null,
            scopedLocaleIds,
            scopedGroupIds,
            scopedUserIds,
            isGlobal: wantsGlobal,
          })
        : null;

    emitDomainEvent({
      eventType: EVENT_TYPES.POST_CREATED,
      entityType: "resource",
      entityId: actionResult.resourceId,
      actorId: userId,
      payload: { postType: input.postType ?? "social", groupId: input.groupId ?? null },
    }).catch(() => {});

    if (linkedBundle) {
      return {
        ...actionResult,
        linkedEventId: linkedBundle.linkedEventId,
        linkedDocumentId: linkedBundle.linkedDocumentId,
        message: linkedBundle.message,
      };
    }
  }

  return actionResult;
}

export async function createPostCommerceResource(input: {
  title?: string;
  content: string;
  postType?: string;
  isLiveInvitation?: boolean;
  liveLocation?: { lat: number; lng: number } | null;
  linkedOfferingId?: string | null;
  createOffering?: {
    title: string;
    description?: string;
    imageUrl?: string;
    offeringType: string;
    basePriceCents?: number;
    currency?: string;
    acceptedCurrencies?: string[];
    quantityAvailable?: number;
    tags?: string[];
    items?: Array<{
      resourceId: string;
      term: string;
      priceCents?: number;
    }>;
    voucherValues?: {
      timeHours: number;
      timeMinutes: number;
      skillValue: number;
      difficultyValue: number;
      resourceCostDollars: number;
      thanksValue?: number;
    };
    hourlyRate?: number;
    estimatedDuration?: { min?: number; max?: number };
    availability?: string;
    bookingDates?: Array<{ date: string; timeSlots: string[] }>;
    category?: string;
    condition?: string;
    bountyReward?: number;
    bountyCriteria?: string;
    bountyDeadline?: string;
    ticketEventName?: string;
    ticketDate?: string;
    ticketVenue?: string;
    ticketQuantity?: number;
    ticketPrice?: number;
    tripOrigin?: string;
    tripDestination?: string;
    tripDate?: string;
    tripCapacity?: number;
    skillArea?: string;
    skillProficiency?: string;
    skillRate?: number;
    resourceCategory?: string;
    resourceAvailability?: string;
    resourceCondition?: string;
    resourcePrice?: number;
    dataFormat?: string;
    dataSize?: string;
    dataPrice?: number;
  } | null;
  dealCode?: string | null;
  dealPriceCents?: number | null;
  dealDurationHours?: number | null;
  eventId?: string;
  groupId?: string;
  imageUrl?: string | null;
  localeId?: string | null;
  gratitudeRecipientId?: string | null;
  gratitudeRecipientName?: string | null;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
  federate?: boolean;
}): Promise<ActionResult> {
  if (!input.content || !input.content.trim()) {
    return {
      success: false,
      message: "Post content is required",
      error: { code: "INVALID_INPUT" },
    };
  }

  if (input.content.length > MAX_POST_CONTENT_LENGTH) {
    return {
      success: false,
      message: `Content exceeds maximum length of ${MAX_POST_CONTENT_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return {
      success: false,
      message: "You must be logged in to create content",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  if (input.groupId) {
    const allowed = await hasGroupWriteAccess(userId, input.groupId);
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to post in this group.",
        error: { code: "FORBIDDEN" },
      };
    }
  }

  const check = await rateLimit(`resources:${userId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  const creatingOffering = !!input.createOffering;
  const linkingOffering = typeof input.linkedOfferingId === "string" && input.linkedOfferingId.length > 0;
  if (creatingOffering && linkingOffering) {
    return {
      success: false,
      message: "Choose either a new offering or an existing offering, not both.",
      error: { code: "INVALID_INPUT" },
    };
  }

  let linkedOfferingId = input.linkedOfferingId ?? null;
  let linkedOfferingMeta: Record<string, unknown> | null = null;
  const validatedOfferingItems: Array<{
    resourceId: string;
    resourceType: string;
    term: string;
    priceCents: number;
  }> = [];

  if (linkedOfferingId) {
    const [offering] = await db
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        type: resources.type,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(and(eq(resources.id, linkedOfferingId), sql`${resources.deletedAt} IS NULL`))
      .limit(1);

    if (!offering || offering.type !== "listing") {
      return {
        success: false,
        message: "Linked offering not found.",
        error: { code: "INVALID_INPUT" },
      };
    }

    if (offering.ownerId !== userId) {
      return {
        success: false,
        message: "You can only attach offerings you own.",
        error: { code: "FORBIDDEN" },
      };
    }

    linkedOfferingMeta = (offering.metadata ?? {}) as Record<string, unknown>;
  }

  if (input.createOffering) {
    const offering = input.createOffering;
    if (!offering.title.trim()) {
      return {
        success: false,
        message: "Offering title is required.",
        error: { code: "INVALID_INPUT" },
      };
    }

    if (!offering.offeringType.trim()) {
      return {
        success: false,
        message: "Offering type is required.",
        error: { code: "INVALID_INPUT" },
      };
    }

    if (
      offering.quantityAvailable !== undefined &&
      (!Number.isInteger(offering.quantityAvailable) || offering.quantityAvailable <= 0)
    ) {
      return {
        success: false,
        message: "Quantity available must be a positive whole number.",
        error: { code: "INVALID_INPUT" },
      };
    }

    if (offering.items && offering.items.length > 0) {
      const resourceIds = offering.items.map((item) => item.resourceId);
      const ownedResources = await db
        .select({
          id: resources.id,
          type: resources.type,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(
          and(
            eq(resources.ownerId, userId),
            inArray(resources.id, resourceIds),
            sql`${resources.deletedAt} IS NULL`
          )
        );

      const ownedMap = new Map(
        ownedResources.map((resource) => [
          resource.id,
          { type: resource.type, metadata: (resource.metadata ?? {}) as Record<string, unknown> },
        ])
      );

      for (const item of offering.items) {
        const owned = ownedMap.get(item.resourceId);
        if (!owned) {
          return {
            success: false,
            message: `Resource ${item.resourceId} not found or not owned by you`,
            error: { code: "FORBIDDEN", details: `resourceId: ${item.resourceId}` },
          };
        }

        const { getAllowedTerms } = await import("./types");
        const allowedTerms = getAllowedTerms(owned.type, owned.metadata);
        if (!allowedTerms.includes(item.term)) {
          return {
            success: false,
            message: `Term "${item.term}" is not allowed for resource type "${owned.type}"`,
            error: {
              code: "INVALID_INPUT",
              details: `Allowed terms for ${owned.type}: ${allowedTerms.join(", ")}`,
            },
          };
        }

        const needsPrice = ["sale", "rent", "borrow"].includes(item.term);
        const priceCents = item.priceCents ?? 0;
        if (needsPrice && priceCents <= 0) {
          return {
            success: false,
            message: `Price is required for term "${item.term}"`,
            error: { code: "INVALID_INPUT", details: `resourceId: ${item.resourceId}` },
          };
        }

        validatedOfferingItems.push({
          resourceId: item.resourceId,
          resourceType: owned.type,
          term: item.term,
          priceCents,
        });
      }
    }
  }

  const authorAgent = await getAgent(userId);
  const fallbackTitle = input.content.trim().slice(0, 80);
  const postTitle = input.title?.trim() || fallbackTitle;
  const scopedLocaleIds = Array.from(
    new Set(
      [
        ...(Array.isArray(input.scopedLocaleIds) ? input.scopedLocaleIds : []),
        ...(input.localeId && input.localeId !== "all" ? [input.localeId] : []),
      ].filter((id) => id && id !== "all"),
    ),
  );
  const scopedGroupIds = Array.isArray(input.scopedGroupIds) ? input.scopedGroupIds : [];
  const scopedUserIds = Array.isArray(input.scopedUserIds) ? input.scopedUserIds : [];
  const chapterTags = scopedLocaleIds;
  const groupTags = Array.from(new Set([...(input.groupId ? [input.groupId] : []), ...scopedGroupIds]));
  const scopeTags = Array.from(new Set([...chapterTags, ...groupTags, ...scopedUserIds]));
  const hasScopedLocales = scopedLocaleIds.length > 0;
  const hasScopedGroups = scopedGroupIds.length > 0;
  const hasScopedUsers = scopedUserIds.length > 0;
  const wantsGlobal = input.isGlobal !== false;
  let visibility: VisibilityLevel = "public";
  if (hasScopedGroups || hasScopedUsers) {
    visibility = "private";
  } else if (hasScopedLocales || !wantsGlobal) {
    visibility = "locale";
  }
  const isLive = (input.isLiveInvitation ?? false) && input.liveLocation != null;
  const liveExpiresAt = isLive
    ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    : null;

  const dealCode = input.dealCode?.trim() || null;
  const dealPriceCents =
    typeof input.dealPriceCents === "number" && input.dealPriceCents > 0
      ? input.dealPriceCents
      : null;
  const dealDurationHours =
    typeof input.dealDurationHours === "number" && input.dealDurationHours > 0
      ? input.dealDurationHours
      : 24;
  const federationNode =
    input.federate === true ? await getHostedNodeForOwner(userId) : null;
  if (input.federate === true && !federationNode) {
    return {
      success: false,
      message: "Federation is not enabled for this account.",
      error: {
        code: "FORBIDDEN",
        details: "Only hosted-node owners can federate content from this deployment.",
      },
    };
  }

  // Paid inline offerings require "seller" tier (or higher).
  if (input.createOffering) {
    const inlineOfferingPriceCents = validatedOfferingItems.length > 0
      ? validatedOfferingItems.reduce((sum, item) => sum + (item.priceCents ?? 0), 0)
      : (input.createOffering.basePriceCents ?? 0);
    if (inlineOfferingPriceCents > 0) {
      const canSell = await hasEntitlement(userId, "seller");
      if (!canSell) {
        return {
          success: false,
          message: "Selling paid offerings requires a Seller membership or higher.",
          error: {
            code: "SUBSCRIPTION_REQUIRED",
            details: "Subscribe to Seller (or higher) to sell offerings.",
            requiredTier: "seller",
          },
        };
      }
    }
  }

  const commerceTargetAgentId = input.groupId || userId;
  const commerceFacadeResult = await updateFacade.execute(
    {
      type: "createPostCommerceResource",
      actorId: userId,
      targetAgentId: commerceTargetAgentId,
      payload: input,
    },
    async () => {
  try {
    const { deriveOfferingListingType } = await import("./types");
    const result = await db.transaction(async (tx) => {
      let createdOfferingId: string | null = linkedOfferingId;
      let createdOfferingMeta = linkedOfferingMeta;

      if (input.createOffering) {
        const offering = input.createOffering;
        const derivedListingType = validatedOfferingItems.length > 0
          ? deriveOfferingListingType(validatedOfferingItems)
          : offering.offeringType;
        const totalPriceCents = validatedOfferingItems.length > 0
          ? validatedOfferingItems.reduce((sum, item) => sum + item.priceCents, 0)
          : (offering.basePriceCents ?? 0);
        const offeringMetadata: Record<string, unknown> = {
          entityType: "offering",
          resourceKind: "offering",
          listingType: derivedListingType,
          offeringType: offering.offeringType,
          ...(offering.imageUrl ? { imageUrl: offering.imageUrl, images: [offering.imageUrl] } : {}),
          totalPriceCents,
          ...(offering.basePriceCents !== undefined ? { basePrice: offering.basePriceCents } : {}),
          ...(totalPriceCents > 0 ? { price: `$${(totalPriceCents / 100).toFixed(2)}` } : {}),
          currency: offering.currency ?? "USD",
          ...(offering.acceptedCurrencies?.length
            ? { acceptedCurrencies: Array.from(new Set(offering.acceptedCurrencies)) }
            : {}),
          ...(typeof offering.quantityAvailable === "number"
            ? {
                quantityAvailable: offering.quantityAvailable,
                quantitySold: 0,
                quantityRemaining: offering.quantityAvailable,
              }
            : {}),
          items: validatedOfferingItems.map((item) => ({
            resourceId: item.resourceId,
            term: item.term,
            priceCents: item.priceCents,
          })),
          scopedLocaleIds,
          scopedGroupIds,
          scopedUserIds,
          isGlobal: wantsGlobal,
          ...(offering.tags?.length ? { tags: offering.tags } : {}),
          ...(offering.voucherValues ? { voucherValues: offering.voucherValues } : {}),
          ...(offering.hourlyRate !== undefined ? { hourlyRate: offering.hourlyRate } : {}),
          ...(offering.estimatedDuration ? { estimatedDuration: offering.estimatedDuration } : {}),
          ...(offering.availability ? { availability: offering.availability } : {}),
          ...(offering.bookingDates?.length ? { bookingDates: offering.bookingDates } : {}),
          ...(offering.category ? { category: offering.category } : {}),
          ...(offering.condition ? { condition: offering.condition } : {}),
          ...(offering.bountyReward !== undefined ? { bountyReward: offering.bountyReward } : {}),
          ...(offering.bountyCriteria ? { bountyCriteria: offering.bountyCriteria } : {}),
          ...(offering.bountyDeadline ? { bountyDeadline: offering.bountyDeadline } : {}),
          ...(offering.ticketEventName ? { ticketEventName: offering.ticketEventName } : {}),
          ...(offering.ticketDate ? { ticketDate: offering.ticketDate } : {}),
          ...(offering.ticketVenue ? { ticketVenue: offering.ticketVenue } : {}),
          ...(offering.ticketQuantity !== undefined ? { ticketQuantity: offering.ticketQuantity } : {}),
          ...(offering.ticketPrice !== undefined ? { ticketPrice: offering.ticketPrice } : {}),
          ...(offering.tripOrigin ? { tripOrigin: offering.tripOrigin } : {}),
          ...(offering.tripDestination ? { tripDestination: offering.tripDestination } : {}),
          ...(offering.tripDate ? { tripDate: offering.tripDate } : {}),
          ...(offering.tripCapacity !== undefined ? { tripCapacity: offering.tripCapacity } : {}),
          ...(offering.skillArea ? { skillArea: offering.skillArea } : {}),
          ...(offering.skillProficiency ? { skillProficiency: offering.skillProficiency } : {}),
          ...(offering.skillRate !== undefined ? { skillRate: offering.skillRate } : {}),
          ...(offering.resourceCategory ? { resourceCategory: offering.resourceCategory } : {}),
          ...(offering.resourceAvailability ? { resourceAvailability: offering.resourceAvailability } : {}),
          ...(offering.resourceCondition ? { resourceCondition: offering.resourceCondition } : {}),
          ...(offering.resourcePrice !== undefined ? { resourcePrice: offering.resourcePrice } : {}),
          ...(offering.dataFormat ? { dataFormat: offering.dataFormat } : {}),
          ...(offering.dataSize ? { dataSize: offering.dataSize } : {}),
          ...(offering.dataPrice !== undefined ? { dataPrice: offering.dataPrice } : {}),
        };

        const [createdOffering] = await tx
          .insert(resources)
          .values({
            name: offering.title.trim(),
            type: "listing",
            description: offering.description?.trim() || null,
            content: offering.description?.trim() || null,
            ownerId: userId,
            visibility,
            tags: Array.from(new Set([...scopeTags, ...(offering.tags ?? [])])),
            metadata: offeringMetadata,
          } as NewResource)
          .returning({ id: resources.id });

        await tx.insert(ledger).values({
          verb: "create",
          subjectId: userId,
          objectId: createdOffering.id,
          objectType: "resource",
          resourceId: createdOffering.id,
          metadata: {
            resourceType: "listing",
            source: "create-post-commerce",
            ...offeringMetadata,
          },
        } as NewLedgerEntry);

        createdOfferingId = createdOffering.id;
        createdOfferingMeta = offeringMetadata;
      }

      const [createdPost] = await tx
        .insert(resources)
        .values({
          name: postTitle,
          type: "post",
          description: input.content.trim(),
          content: input.content,
          ownerId: userId,
          visibility,
          tags: scopeTags,
          metadata: {
            entityType: "post",
            postType: input.postType ?? "social",
            isLiveInvitation: isLive,
            liveExpiresAt,
            linkedOfferingId: createdOfferingId,
            totalPriceCents:
              dealPriceCents ??
              (typeof createdOfferingMeta?.totalPriceCents === "number"
                ? createdOfferingMeta.totalPriceCents
                : null),
            basePrice:
              dealPriceCents != null
                ? dealPriceCents / 100
                : typeof createdOfferingMeta?.totalPriceCents === "number"
                  ? createdOfferingMeta.totalPriceCents / 100
                  : null,
            offeringType:
              (createdOfferingMeta?.offeringType as string | undefined) ??
              (createdOfferingMeta?.listingType as string | undefined) ??
              null,
            dealCode,
            dealPriceCents,
            dealDurationHours: createdOfferingId && dealPriceCents ? dealDurationHours : null,
            dealExpiresAt:
              createdOfferingId && dealPriceCents
                ? new Date(Date.now() + dealDurationHours * 60 * 60 * 1000).toISOString()
                : null,
            eventId: input.eventId ?? null,
            groupId: input.groupId ?? null,
            gratitudeRecipientId: input.gratitudeRecipientId ?? null,
            gratitudeRecipientName: input.gratitudeRecipientName ?? null,
            imageUrl: input.imageUrl ?? null,
            images: input.imageUrl ? [input.imageUrl] : [],
            chapterTags,
            groupTags,
            scopedLocaleIds,
            scopedGroupIds,
            scopedUserIds,
            isGlobal: wantsGlobal,
            authorName: authorAgent?.name ?? null,
            authorImage: authorAgent?.image ?? null,
            ...(input.eftValues ? { eftValues: input.eftValues } : {}),
            ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
            ...(input.auditValues ? { auditValues: input.auditValues } : {}),
          },
          ...(isLive && input.liveLocation
            ? {
                location: {
                  type: "Point" as const,
                  coordinates: [input.liveLocation.lng, input.liveLocation.lat],
                },
              }
            : {}),
        } as NewResource)
        .returning({ id: resources.id });

      await tx.insert(ledger).values({
        verb: "create",
        subjectId: userId,
        objectId: createdPost.id,
        objectType: "resource",
        resourceId: createdPost.id,
        metadata: {
          resourceType: "post",
          source: "create-post-commerce",
          linkedOfferingId: createdOfferingId,
        },
      } as NewLedgerEntry);

      return {
        postId: createdPost.id,
        offeringId: createdOfferingId,
      };
    });

    revalidatePath("/");
    revalidatePath("/create");
    revalidatePath("/marketplace");
    revalidatePath("/profile");
    revalidatePath("/posts");

    scheduleEmbedding(() => embedResource(result.postId, postTitle, input.content));
    if (result.offeringId && input.createOffering) {
      scheduleEmbedding(() =>
        embedResource(
          result.offeringId!,
          input.createOffering!.title,
          input.createOffering!.description,
        ),
      );
    }
    void syncMurmurationsProfilesForActor(userId).catch((error) => {
      console.error("[murmurations] createPostCommerceResource sync failed:", error);
    });
    if (federationNode) {
      const resourceIds = [result.postId];
      if (result.offeringId) {
        resourceIds.push(result.offeringId);
      }
      void queueEntityExportEvents({
        originNodeId: federationNode.id,
        resourceIds,
      }).catch((error) => {
        console.error("[federation] createPostCommerceResource queue failed:", error);
      });
    }

    return {
      success: true,
      message: "Post created successfully",
      resourceId: result.postId,
    } as ActionResult;
  } catch (error) {
    console.error("[createPostCommerceResource] unexpected error:", error);
    return {
      success: false,
      message: "An unexpected error occurred. Please try again.",
      error: { code: "SERVER_ERROR" },
    } as ActionResult;
  }
    },
  );

  if (!commerceFacadeResult.success) {
    return {
      success: false,
      message: commerceFacadeResult.error ?? "Failed to create commerce post",
      error: { code: commerceFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const commerceActionResult = commerceFacadeResult.data as ActionResult;

  if (commerceActionResult?.success && commerceActionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.POST_CREATED,
      entityType: "resource",
      entityId: commerceActionResult.resourceId,
      actorId: userId,
      payload: { postType: input.postType ?? "social", commerce: true, groupId: input.groupId ?? null },
    }).catch(() => {});
  }

  return commerceActionResult;
}
