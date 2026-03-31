"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  agents,
  ledger,
  resources,
  type NewLedgerEntry,
  type NewResource,
  type ResourceType,
  type VisibilityLevel,
} from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hasEntitlement } from "@/lib/billing";
import { getAgent } from "@/lib/queries/agents";
import { syncMurmurationsProfilesForActor } from "@/lib/murmurations";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
  createResourceWithLedger,
} from "./helpers";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";
import type { ActionResult } from "./types";
import { getAllowedTerms, deriveOfferingListingType } from "./types";

const MAX_OFFERING_DESCRIPTION_LENGTH = 50000;

export async function createOfferingResource(input: {
  title: string;
  description: string;
  imageUrl?: string;
  items?: Array<{
    resourceId: string;
    term: string;
    priceCents?: number;
  }>;
  offeringType?: string;
  basePrice?: number;
  currency?: string;
  acceptedCurrencies?: string[];
  quantityAvailable?: number;
  tags?: string[];
  voucherValues?: {
    timeHours: number;
    timeMinutes: number;
    skillValue: number;
    difficultyValue: number;
    resourceCostDollars: number;
    thanksValue?: number;
  };
  // Service-specific fields
  hourlyRate?: number;
  estimatedDuration?: { min?: number; max?: number };
  availability?: string;
  bookingDates?: Array<{ date: string; timeSlots: string[] }>;
  category?: string;
  // Product-specific fields
  condition?: string;
  // Bounty-specific fields
  bountyReward?: number;
  bountyCriteria?: string;
  bountyDeadline?: string;
  // Ticket-specific fields
  ticketEventName?: string;
  ticketDate?: string;
  ticketVenue?: string;
  ticketQuantity?: number;
  ticketPrice?: number;
  // Trip-specific fields
  tripOrigin?: string;
  tripDestination?: string;
  tripDate?: string;
  tripCapacity?: number;
  // Skill-specific fields
  skillArea?: string;
  skillProficiency?: string;
  skillRate?: number;
  // Resource-specific fields
  resourceCategory?: string;
  resourceAvailability?: string;
  resourceCondition?: string;
  resourcePrice?: number;
  // Data-specific fields
  dataFormat?: string;
  dataSize?: string;
  dataPrice?: number;
  // Deal fields
  hasDeal?: boolean;
  dealPrice?: number; // cents
  dealDurationHours?: number;
  targetAgentTypes: string[];
  ownerId?: string;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  postToFeed?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
}): Promise<ActionResult> {
  if (!input.title?.trim()) {
    return {
      success: false,
      message: "Offering title is required",
      error: { code: "INVALID_INPUT", details: "title is required" },
    };
  }

  if (input.description && input.description.length > MAX_OFFERING_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description exceeds maximum length of ${MAX_OFFERING_DESCRIPTION_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  if ((!input.items || input.items.length === 0) && !input.offeringType) {
    return {
      success: false,
      message: "Provide items or an offering type",
      error: { code: "INVALID_INPUT", details: "items or offeringType required" },
    };
  }

  if (
    input.quantityAvailable !== undefined &&
    (!Number.isInteger(input.quantityAvailable) || input.quantityAvailable <= 0)
  ) {
    return {
      success: false,
      message: "Quantity available must be a positive whole number.",
      error: { code: "INVALID_INPUT", details: "quantityAvailable must be a positive integer" },
    };
  }

  const resolvedUserId = await resolveAuthenticatedUserId();
  if (!resolvedUserId) {
    return {
      success: false,
      message: "You must be logged in to create an offering",
      error: { code: "UNAUTHENTICATED" },
    };
  }

  const check = await rateLimit(
    `resources:${resolvedUserId}`,
    RATE_LIMITS.SOCIAL.limit,
    RATE_LIMITS.SOCIAL.windowMs
  );
  if (!check.success) {
    return {
      success: false,
      message: "Rate limit exceeded. Please try again later.",
      error: { code: "RATE_LIMITED" },
    };
  }

  try {
    const ownerId = input.ownerId ?? resolvedUserId;
    if (ownerId !== resolvedUserId) {
      const allowed = await hasGroupWriteAccess(resolvedUserId, ownerId);
      if (!allowed) {
        return {
          success: false,
          message: "You do not have permission to create offerings for this group.",
          error: { code: "FORBIDDEN" },
        };
      }
    }

    // Validate all resourceIds belong to current user (only when items provided)
    const validatedItems: Array<{
      resourceId: string;
      resourceType: string;
      term: string;
      priceCents: number;
    }> = [];

    if (input.items && input.items.length > 0) {
      const resourceIds = input.items.map((i) => i.resourceId);
      const ownedResources = await db
        .select({
          id: resources.id,
          type: resources.type,
          metadata: resources.metadata,
        })
        .from(resources)
        .where(
          and(
            eq(resources.ownerId, resolvedUserId),
            inArray(resources.id, resourceIds),
            sql`${resources.deletedAt} IS NULL`
          )
        );

      const ownedMap = new Map(
        ownedResources.map((r) => [
          r.id,
          { type: r.type, metadata: (r.metadata ?? {}) as Record<string, unknown> },
        ])
      );

      // Verify ownership + term validity for each item
      for (const item of input.items) {
        const owned = ownedMap.get(item.resourceId);
        if (!owned) {
          return {
            success: false,
            message: `Resource ${item.resourceId} not found or not owned by you`,
            error: { code: "FORBIDDEN", details: `resourceId: ${item.resourceId}` },
          };
        }

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

        validatedItems.push({
          resourceId: item.resourceId,
          resourceType: owned.type,
          term: item.term,
          priceCents,
        });
      }
    }

    // Compute derived offering type (falls back to standalone offeringType)
    const derivedListingType = validatedItems.length > 0
      ? deriveOfferingListingType(validatedItems)
      : (input.offeringType ?? "standalone");
    const totalPriceCents = validatedItems.length > 0
      ? validatedItems.reduce((sum, i) => sum + i.priceCents, 0)
      : (input.basePrice ?? 0);

    // Paid offerings (price > 0) require a "seller" tier (or higher).
    if (totalPriceCents > 0) {
      const canSell = await hasEntitlement(resolvedUserId, "seller");
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

    // Determine visibility from scoping
    const hasScopedLocales =
      Array.isArray(input.scopedLocaleIds) && input.scopedLocaleIds.length > 0;
    const hasScopedGroups =
      Array.isArray(input.scopedGroupIds) && input.scopedGroupIds.length > 0;
    const hasScopedUsers =
      Array.isArray(input.scopedUserIds) && input.scopedUserIds.length > 0;
    const hasAnyScoping = hasScopedLocales || hasScopedGroups || hasScopedUsers;

    let offeringVisibility: VisibilityLevel = "public";
    if (hasAnyScoping) {
      if (hasScopedGroups || hasScopedUsers) {
        offeringVisibility = "private";
      } else {
        offeringVisibility = "locale";
      }
    }

    const allScopeTags = Array.from(
      new Set([
        ...(input.scopedLocaleIds ?? []),
        ...(input.scopedGroupIds ?? []),
        ...(input.scopedUserIds ?? []),
        ...(input.tags ?? []),
      ])
    );
    const groupTags = Array.from(new Set([
      ...(input.scopedGroupIds ?? []),
      ...(ownerId !== resolvedUserId ? [ownerId] : []),
    ]));
    const firstGroupId = groupTags[0] ?? null;

    // Create the offering resource with ledger
    const offeringTargetAgentId = ownerId;
    const facadeResult = await updateFacade.execute(
      {
        type: "createOfferingResource",
        actorId: resolvedUserId,
        targetAgentId: offeringTargetAgentId,
        payload: input,
      },
      async () => {
    const result = await createResourceWithLedger({
      name: input.title.trim(),
      type: "listing",
      ownerId,
      description: input.description?.trim() || undefined,
      content: input.description?.trim() || undefined,
      visibility: offeringVisibility,
      tags: allScopeTags,
      metadata: {
        entityType: "offering",
        resourceKind: "offering",
        listingType: derivedListingType,
        ...(input.imageUrl ? { imageUrl: input.imageUrl, images: [input.imageUrl] } : {}),
        items: validatedItems.map((i) => ({
          resourceId: i.resourceId,
          term: i.term,
          priceCents: i.priceCents,
        })),
        targetAgentTypes: input.targetAgentTypes,
        groupId: firstGroupId,
        groupTags,
        chapterTags: input.scopedLocaleIds ?? [],
        scopedLocaleIds: input.scopedLocaleIds ?? [],
        scopedGroupIds: input.scopedGroupIds ?? [],
        scopedUserIds: input.scopedUserIds ?? [],
        totalPriceCents,
        // Formatted price string for marketplace adapter consumption
        ...(totalPriceCents > 0 ? { price: `$${(totalPriceCents / 100).toFixed(2)}` } : {}),
        ...(input.eftValues ? { eftValues: input.eftValues } : {}),
      ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
      ...(input.auditValues ? { auditValues: input.auditValues } : {}),
        ...(input.offeringType ? { offeringType: input.offeringType } : {}),
        ...(input.basePrice !== undefined ? { basePrice: input.basePrice } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.acceptedCurrencies?.length
          ? { acceptedCurrencies: Array.from(new Set(input.acceptedCurrencies)) }
          : {}),
        ...(typeof input.quantityAvailable === "number"
          ? {
              quantityAvailable: input.quantityAvailable,
              quantitySold: 0,
              quantityRemaining: input.quantityAvailable,
            }
          : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        ...(input.voucherValues ? { voucherValues: input.voucherValues } : {}),
        // Service-specific metadata
        ...(input.hourlyRate !== undefined ? { hourlyRate: input.hourlyRate } : {}),
        ...(input.estimatedDuration ? { estimatedDuration: input.estimatedDuration } : {}),
        ...(input.availability ? { availability: input.availability } : {}),
        ...(input.bookingDates?.length ? { bookingDates: input.bookingDates } : {}),
        ...(input.category ? { category: input.category } : {}),
        // Product-specific metadata
        ...(input.condition ? { condition: input.condition } : {}),
        // Bounty-specific metadata
        ...(input.bountyReward !== undefined ? { bountyReward: input.bountyReward } : {}),
        ...(input.bountyCriteria ? { bountyCriteria: input.bountyCriteria } : {}),
        ...(input.bountyDeadline ? { bountyDeadline: input.bountyDeadline } : {}),
        // Ticket-specific metadata
        ...(input.ticketEventName ? { ticketEventName: input.ticketEventName } : {}),
        ...(input.ticketDate ? { ticketDate: input.ticketDate } : {}),
        ...(input.ticketVenue ? { ticketVenue: input.ticketVenue } : {}),
        ...(input.ticketQuantity !== undefined ? { ticketQuantity: input.ticketQuantity } : {}),
        ...(input.ticketPrice !== undefined ? { ticketPrice: input.ticketPrice } : {}),
        // Trip-specific metadata
        ...(input.tripOrigin ? { tripOrigin: input.tripOrigin } : {}),
        ...(input.tripDestination ? { tripDestination: input.tripDestination } : {}),
        ...(input.tripDate ? { tripDate: input.tripDate } : {}),
        ...(input.tripCapacity !== undefined ? { tripCapacity: input.tripCapacity } : {}),
        // Skill-specific metadata
        ...(input.skillArea ? { skillArea: input.skillArea } : {}),
        ...(input.skillProficiency ? { skillProficiency: input.skillProficiency } : {}),
        ...(input.skillRate !== undefined ? { skillRate: input.skillRate } : {}),
        // Resource-specific metadata
        ...(input.resourceCategory ? { resourceCategory: input.resourceCategory } : {}),
        ...(input.resourceAvailability ? { resourceAvailability: input.resourceAvailability } : {}),
        ...(input.resourceCondition ? { resourceCondition: input.resourceCondition } : {}),
        ...(input.resourcePrice !== undefined ? { resourcePrice: input.resourcePrice } : {}),
        // Data-specific metadata
        ...(input.dataFormat ? { dataFormat: input.dataFormat } : {}),
        ...(input.dataSize ? { dataSize: input.dataSize } : {}),
        ...(input.dataPrice !== undefined ? { dataPrice: input.dataPrice } : {}),
        // Deal metadata
        ...(input.hasDeal ? {
          hasDeal: true,
          dealPriceCents: input.dealPrice ?? 0,
          dealDurationHours: input.dealDurationHours ?? 24,
          dealExpiresAt: new Date(Date.now() + (input.dealDurationHours ?? 24) * 60 * 60 * 1000).toISOString(),
        } : { hasDeal: false }),
      },
    });

    if (!result.success || !result.resourceId) return result;

    const offeringId = result.resourceId;

    // Create ledger grants for scoped groups and users (same as event visibility grants)
    if (hasAnyScoping) {
      const grantEntries: Array<{ subjectId: string }> = [
        ...(input.scopedGroupIds ?? []).map((id) => ({ subjectId: id })),
        ...(input.scopedUserIds ?? []).map((id) => ({ subjectId: id })),
      ];

      if (grantEntries.length > 0) {
        try {
          await db.insert(ledger).values(
            grantEntries.map(
              (entry) =>
                ({
                  verb: "grant" as const,
                  subjectId: entry.subjectId,
                  objectId: offeringId,
                  objectType: "resource" as const,
                  resourceId: offeringId,
                  isActive: true,
                  metadata: { action: "view", source: "visibility-scope" },
                }) as NewLedgerEntry
            )
          );
        } catch (error) {
          console.error("[createOfferingResource] grant creation failed:", error);
        }
      }
    }

    if (input.postToFeed !== false) {
      try {
        const chapterTags = (input.scopedLocaleIds ?? []).filter((id) => id !== "all");
        const scopeTags = Array.from(new Set([...chapterTags, ...groupTags]));

        const [authorAgent] = await db
          .select({ name: agents.name, image: agents.image })
          .from(agents)
          .where(eq(agents.id, ownerId))
          .limit(1);

        await createResourceWithLedger({
          name: input.title.trim(),
          type: "post",
          ownerId,
          content: input.description?.trim() || input.title.trim(),
          tags: scopeTags,
          metadata: {
            entityType: "post",
            postType: "offer",
            isLiveInvitation: false,
            linkedOfferingId: offeringId,
            totalPriceCents,
            offeringType: input.offeringType ?? derivedListingType,
            offeringItems: validatedItems.map((i) => ({
              resourceId: i.resourceId,
              term: i.term,
              priceCents: i.priceCents,
            })),
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.acceptedCurrencies?.length
              ? { acceptedCurrencies: Array.from(new Set(input.acceptedCurrencies)) }
              : {}),
            ...(typeof input.quantityAvailable === "number"
              ? {
                  quantityAvailable: input.quantityAvailable,
                  quantitySold: 0,
                  quantityRemaining: input.quantityAvailable,
                }
              : {}),
            ...(input.voucherValues ? { voucherValues: input.voucherValues } : {}),
            ...(input.bookingDates?.length ? { bookingDates: input.bookingDates } : {}),
            eventId: null,
            groupId: firstGroupId,
            imageUrl: null,
            images: [],
            chapterTags,
            groupTags,
            authorName: authorAgent?.name ?? null,
            authorImage: authorAgent?.image ?? null,
          },
        });
      } catch (error) {
        console.error("[createOfferingResource] companion post creation failed:", error);
      }
    }

    // Create notification ledger entries for directly scoped users
    if (hasScopedUsers && input.scopedUserIds) {
      try {
        await db.insert(ledger).values(
          input.scopedUserIds.map(
            (targetUserId) =>
              ({
                verb: "invite" as const,
                subjectId: resolvedUserId,
                objectId: targetUserId,
                objectType: "agent" as const,
                resourceId: offeringId,
                isActive: true,
                metadata: {
                  kind: "offering-notification",
                  offeringId,
                  message: "shared an offering with you",
                },
              }) as NewLedgerEntry
          )
        );
      } catch (error) {
        console.error("[createOfferingResource] notification creation failed:", error);
      }
    }

    revalidatePath("/");
    revalidatePath("/create");
    revalidatePath("/marketplace");
    revalidatePath("/profile");
    if (firstGroupId) {
      revalidatePath(`/groups/${firstGroupId}`);
      revalidatePath(`/rings/${firstGroupId}`);
      revalidatePath(`/families/${firstGroupId}`);
    }
    void syncMurmurationsProfilesForActor(ownerId).catch((syncError) => {
      console.error("[murmurations] createOfferingResource sync failed:", syncError);
    });

    return {
      success: true,
      message: "Offering created successfully",
      resourceId: offeringId,
    } as ActionResult;
      },
    );

    if (!facadeResult.success) {
      return {
        success: false,
        message: facadeResult.error ?? "Failed to create offering",
        error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
      };
    }

    const offeringActionResult = facadeResult.data as ActionResult;

    if (offeringActionResult?.success && offeringActionResult.resourceId) {
      emitDomainEvent({
        eventType: EVENT_TYPES.LISTING_CREATED,
        entityType: "resource",
        entityId: offeringActionResult.resourceId,
        actorId: resolvedUserId,
        payload: { offeringType: input.offeringType ?? null, ownerId },
      }).catch(() => {});
    }

    return offeringActionResult;
  } catch (error) {
    console.error("[createOfferingResource] unexpected error:", error);
    return {
      success: false,
      message: "An unexpected error occurred. Please try again.",
      error: { code: "SERVER_ERROR" },
    };
  }
}

export async function createMarketplaceListingResource(input: {
  listingType: "product" | "service";
  title: string;
  description: string;
  price: number;
  category: string;
  condition?: string;
  location: string;
  tags: string[];
  chapterTags: string[];
  images: string[];
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
}): Promise<ActionResult> {
  if (!input.title?.trim() || !input.description?.trim() || !Number.isFinite(input.price) || input.price < 0) {
    return {
      success: false,
      message: "Please fill in all required listing fields",
      error: {
        code: "INVALID_INPUT",
      },
    };
  }

  if (input.description.length > MAX_OFFERING_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description exceeds maximum length of ${MAX_OFFERING_DESCRIPTION_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const canonicalType: ResourceType = input.listingType === "service" ? "skill" : "resource";

  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in", error: { code: "UNAUTHENTICATED" } };
  }

  // Paid marketplace listings require a "seller" tier (or higher).
  if (Number.isFinite(input.price) && input.price > 0) {
    const canSell = await hasEntitlement(userId, "seller");
    if (!canSell) {
      return {
        success: false,
        message: "Selling marketplace listings requires a Seller membership or higher.",
        error: {
          code: "SUBSCRIPTION_REQUIRED",
          details: "Subscribe to Seller (or higher) to list items for sale.",
          requiredTier: "seller",
        },
      };
    }
  }

  const sellerAgent = await getAgent(userId);

  // Listing taxonomy maps service listings to "skill" resources for downstream compatibility.
  const listingFacadeResult = await updateFacade.execute(
    {
      type: "createMarketplaceListingResource",
      actorId: userId,
      targetAgentId: userId,
      payload: input,
    },
    async () => {
      return createResourceWithLedger({
        name: input.title,
        type: canonicalType,
        description: input.description,
        content: input.description,
        tags: input.tags,
        visibility: "public",
        metadata: {
          entityType: "listing",
          resourceKind: canonicalType,
          offerType: input.listingType,
          listingType: input.listingType,
          price: input.price,
          category: input.category,
          condition: input.condition ?? null,
          location: input.location,
          chapterTags: input.chapterTags,
          images: input.images,
          status: "active",
          sellerName: sellerAgent?.name ?? null,
          sellerImage: sellerAgent?.image ?? null,
          ...(input.eftValues ? { eftValues: input.eftValues } : {}),
          ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
          ...(input.auditValues ? { auditValues: input.auditValues } : {}),
        },
      });
    },
  );

  if (!listingFacadeResult.success) {
    return {
      success: false,
      message: listingFacadeResult.error ?? "Failed to create marketplace listing",
      error: { code: listingFacadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const listingActionResult = listingFacadeResult.data as ActionResult;

  if (listingActionResult?.success && listingActionResult.resourceId) {
    emitDomainEvent({
      eventType: EVENT_TYPES.LISTING_CREATED,
      entityType: "resource",
      entityId: listingActionResult.resourceId,
      actorId: userId,
      payload: { listingType: input.listingType, price: input.price },
    }).catch(() => {});
  }

  return listingActionResult;
}
