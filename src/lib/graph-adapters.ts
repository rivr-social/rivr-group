/**
 * Adapter functions that map graph-layer entities into frontend domain models.
 *
 * Purpose:
 * - Convert `SerializedAgent`/`SerializedResource` records into UI-friendly shapes.
 * - Preserve backward-compatible defaults expected by existing client components.
 * - Centralize metadata fallback rules and type coercion behavior.
 *
 * Key exports:
 * - Agent adapters (`agentToUser`, `agentToGroup`, `agentToEvent`, etc.).
 * - Resource adapters (`resourceToMarketplaceListing`, `resourceToPost`, and
 *   `resourceTo*Agent` bridge helpers).
 * - `adaptAgent` dynamic dispatch helper for type-based agent adaptation.
 *
 * Dependencies:
 * - Graph action types from `@/app/actions/graph`.
 * - Frontend domain types and `GroupType` from `@/lib/types`.
 * - `AgentType` union from `@/db/schema`.
 * - Membership plan normalization from `@/lib/group-memberships`.
 */

import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers";
import type {
  User,
  Group,
  MarketplaceListing,
  Basin,
  Chapter,
  Ring,
  Family,
  Guild,
  Community,
  Domain,
  Bot,
  SystemAgent,
} from "@/lib/types";
import { GroupType } from "@/lib/types";
import type { AgentType } from "@/db/schema";
import { readGroupMembershipPlans } from "@/lib/group-memberships";

/**
 * Sanitize a string into a URL-safe slug.
 * Lowercases, strips non-alphanumeric characters (except dashes),
 * collapses consecutive dashes, and trims leading/trailing dashes.
 */
/** Strip wrapping double-quotes from DB strings (e.g. `"foo"` → `foo`). */
function stripWrappingQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return fallback;
}

function toBookingDates(value: unknown): Array<{ date: string; timeSlots: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const date = typeof record.date === "string" ? record.date : "";
      const timeSlots = toStringArray(record.timeSlots);
      if (!date || timeSlots.length === 0) return null;
      return { date, timeSlots };
    })
    .filter((entry): entry is { date: string; timeSlots: string[] } => entry !== null);
}

function getThanksValue(meta: Record<string, unknown>): number | undefined {
  const voucherValues =
    meta.voucherValues && typeof meta.voucherValues === "object" && !Array.isArray(meta.voucherValues)
      ? (meta.voucherValues as Record<string, unknown>)
      : null;

  const rawThanksValue =
    typeof voucherValues?.thanksValue === "number"
      ? voucherValues.thanksValue
      : typeof meta.thanksValue === "number"
        ? meta.thanksValue
        : null;

  if (rawThanksValue === null || Number.isNaN(rawThanksValue)) {
    return undefined;
  }

  const normalized = Math.max(0, Math.floor(rawThanksValue));
  return normalized > 0 ? normalized : undefined;
}

function getDurationMinutes(meta: Record<string, unknown>, listingType?: string): number | undefined {
  const voucherValues =
    meta.voucherValues && typeof meta.voucherValues === "object" && !Array.isArray(meta.voucherValues)
      ? (meta.voucherValues as Record<string, unknown>)
      : null;

  if (listingType === "voucher") {
    const hours = typeof voucherValues?.timeHours === "number" ? voucherValues.timeHours : 0;
    const minutes = typeof voucherValues?.timeMinutes === "number" ? voucherValues.timeMinutes : 0;
    const total = Math.round(hours * 60 + minutes);
    return total > 0 ? total : undefined;
  }

  if (meta.estimatedDuration && typeof meta.estimatedDuration === "object") {
    const duration = meta.estimatedDuration as Record<string, unknown>;
    const min = typeof duration.min === "number" ? duration.min : null;
    if (min != null && Number.isFinite(min) && min > 0) {
      return Math.max(15, Math.round(min * 60));
    }
  }

  return undefined;
}

function locationToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.address === "string" && record.address.length > 0) return record.address;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  if (typeof record.city === "string" && record.city.length > 0) return record.city;
  return undefined;
}

function resolveBasinId(
  meta: Record<string, unknown>,
  parentId: string | null,
  pathIds: string[] | null = null
): string {
  // Prefer hierarchical parentId (DB UUID), then metadata basinId fallback.
  if (typeof parentId === "string" && parentId.length > 0) return parentId;
  if (typeof meta.basinDbId === "string" && meta.basinDbId.length > 0) return meta.basinDbId;
  if (typeof meta.basinId === "string" && meta.basinId.length > 0) return meta.basinId;
  if (Array.isArray(pathIds)) {
    const firstPathId = pathIds.find((id): id is string => typeof id === "string" && id.length > 0);
    if (firstPathId) return firstPathId;
  }
  return "";
}

/**
 * Converts a graph person agent into the frontend `User` model.
 *
 * @param {SerializedAgent} agent - Source graph agent with optional metadata.
 * @returns {User} Normalized user object with UI-safe defaults.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const user = agentToUser(personAgent);
 */
export function agentToUser(agent: SerializedAgent): User {
  const meta = agent.metadata ?? {};
  const username = typeof meta.username === "string" ? meta.username.trim() : "";
  // Chapter scoping falls back to traversal path IDs when tags are missing.
  const scopeTags = toStringArray(meta.chapterTags, agent.pathIds ?? []);

  return {
    id: agent.id,
    name: agent.name,
    username: username || slugify(agent.name),
    profileHref: `/profile/${username || agent.id}`,
    email: agent.email ?? undefined,
    bio: agent.description ?? (meta.bio as string) ?? undefined,
    avatar: agent.image ?? "/placeholder-user.jpg",
    followers: (meta.followers as number) ?? 0,
    following: (meta.following as number) ?? 0,
    isFollowing: false,
    isVerified: (meta.isVerified as boolean) ?? false,
    joinDate: agent.createdAt,
    joinedAt: agent.createdAt,
    location: locationToText(meta.location),
    website: (meta.website as string) ?? undefined,
    skills: (meta.skills as string[]) ?? [],
    resources: (meta.resources as string[]) ?? [],
    points: (meta.points as number) ?? (meta.reputation as number) ?? 0,
    chapterTags: scopeTags,
    groupTags: (meta.groupTags as string[]) ?? [],
    role: (meta.role as string) ?? undefined,
    // Persona fields
    geneKeys: (meta.geneKeys as string) ?? undefined,
    humanDesign: (meta.humanDesign as string) ?? undefined,
    westernAstrology: (meta.westernAstrology as string) ?? undefined,
    vedicAstrology: (meta.vedicAstrology as string) ?? undefined,
    ocean: (meta.ocean as string) ?? undefined,
    myersBriggs: (meta.myersBriggs as string) ?? undefined,
    enneagram: (meta.enneagram as string) ?? undefined,
  };
}

/**
 * Converts an organization-style graph agent into the frontend `Group` model.
 *
 * @param {SerializedAgent} agent - Source graph agent with organization metadata.
 * @returns {Group} Group object with normalized membership tier names and defaults.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const group = agentToGroup(orgAgent);
 */
export function agentToGroup(agent: SerializedAgent): Group {
  const meta = agent.metadata ?? {};
  const scopeTags = toStringArray(
    meta.chapterTags,
    toStringArray(meta.tags, agent.pathIds ?? [])
  );
  const membershipPlans = readGroupMembershipPlans(meta);

  // Explicit allowlist mapping prevents unknown metadata values from leaking through.
  let groupType: GroupType = GroupType.Basic;
  const rawGroupType = meta.groupType as string;
  if (rawGroupType === "ring") groupType = GroupType.Ring;
  else if (rawGroupType === "family") groupType = GroupType.Family;
  else if (rawGroupType === "organization" || rawGroupType === "org") groupType = GroupType.Organization;
  else if (rawGroupType === "group") groupType = GroupType.Group;

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder-event.jpg",
    avatar: agent.image ?? "/placeholder-event.jpg",
    memberCount: (meta.memberCount as number) ?? 0,
    isJoined: false,
    admins: undefined,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    tags: toStringArray(meta.tags),
    chapterTags: scopeTags,
    groupTags: (meta.groupTags as string[]) ?? [],
    createdAt: agent.createdAt,
    color: (meta.color as string) ?? undefined,
    coverImage: (meta.coverImage as string) ?? undefined,
    location: locationToText(meta.location),
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    phone: (meta.phone as string) ?? undefined,
    mission: (meta.mission as string) ?? undefined,
    history: (meta.history as string) ?? undefined,
    rules: (meta.rules as string[]) ?? undefined,
    meetingLocation: (meta.meetingLocation as string) ?? undefined,
    joinSettings:
      meta.joinSettings && typeof meta.joinSettings === "object"
        ? (meta.joinSettings as Group["joinSettings"])
        : undefined,
    defaultNotificationSettings:
      meta.defaultNotificationSettings && typeof meta.defaultNotificationSettings === "object"
        ? (meta.defaultNotificationSettings as Group["defaultNotificationSettings"])
        : undefined,
    membershipTiers: membershipPlans.map((plan) => plan.name),
    type: groupType as GroupType,
    parentGroupId: agent.parentId ?? undefined,
    modelUrl: (meta.modelUrl as string) ?? undefined,
  };
}

/**
 * Converts an event agent into the feed event shape consumed by frontend views.
 *
 * @param {SerializedAgent} agent - Source graph event agent.
 * @returns {object} Event-shaped object compatible with current feed contracts.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const eventItem = agentToEvent(eventAgent);
 */
export function agentToEvent(agent: SerializedAgent) {
  const meta = agent.metadata ?? {};
  const scopeTags = toStringArray(
    meta.chapterTags,
    toStringArray(meta.tags, agent.pathIds ?? [])
  );

  return {
    id: agent.id,
    name: agent.name,
    title: agent.name,
    description: agent.description ?? "",
    type: "event" as const,
    image: agent.image ?? "/placeholder-event.jpg",
    timeframe: {
      start: (meta.startDate as string) ?? agent.createdAt,
      end: (meta.endDate as string) ?? agent.createdAt,
    },
    organizer: (meta.organizerId as string) ?? agent.parentId ?? "",
    creator: (meta.creatorId as string) ?? "",
    location: meta.location
      ? typeof meta.location === "string"
        ? { name: meta.location, address: meta.location }
        : {
            name: ((meta.location as Record<string, unknown>).name as string) ?? "",
            address: ((meta.location as Record<string, unknown>).address as string) ?? "",
            coordinates: (meta.location as Record<string, unknown>).coordinates as { lat: number; lng: number } | undefined,
          }
      : undefined,
    admins: (meta.adminIds as string[]) ?? [],
    chapterTags: scopeTags,
    tags: toStringArray(meta.tags),
    attendees: (meta.attendeeCount as number) ?? 0,
    price: (meta.price as string) ?? undefined,
    status: (meta.status as string) ?? "active",
  };
}

/**
 * Converts a project agent into the feed project shape consumed by frontend views.
 *
 * @param {SerializedAgent} agent - Source graph project agent.
 * @returns {object} Project-shaped object compatible with current feed contracts.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const projectItem = agentToProject(projectAgent);
 */
export function agentToProject(agent: SerializedAgent) {
  const meta = agent.metadata ?? {};
  const properties = (meta.properties ?? {}) as Record<string, string>;
  const scopeTags = toStringArray(
    meta.chapterTags,
    toStringArray(meta.tags, agent.pathIds ?? [])
  );

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    type: "project" as const,
    image: agent.image ?? "/placeholder-project.jpg",
    location: properties.location ?? (meta.location as string) ?? undefined,
    creatorId: (meta.creatorId as string) ?? "",
    memberCount: (meta.memberCount as number) ?? 0,
    status: (meta.status as "planning" | "active" | "completed") ?? "active",
    chapterTags: scopeTags,
    tags: toStringArray(meta.tags),
    createdAt: agent.createdAt,
  };
}

/**
 * Converts a graph resource into a frontend marketplace listing.
 *
 * @param {SerializedResource} resource - Source resource record.
 * @param {SerializedAgent} [ownerAgent] - Optional seller agent; falls back to lightweight placeholder seller.
 * @returns {MarketplaceListing} Marketplace listing with normalized seller and metadata defaults.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const listing = resourceToMarketplaceListing(resource, owner);
 */
export function resourceToMarketplaceListing(
  resource: SerializedResource,
  ownerAgent?: SerializedAgent
): MarketplaceListing {
  const meta = resource.metadata ?? {};
  const rawGroupType = String(ownerAgent?.metadata?.groupType ?? "").toLowerCase();
  const ownerIsGroup = Boolean(
    ownerAgent && ownerAgent.type !== "person"
  );
  const ownerPath = ownerAgent
    ? rawGroupType === "ring"
      ? `/rings/${ownerAgent.id}`
      : rawGroupType === "family"
        ? `/families/${ownerAgent.id}`
        : ownerIsGroup
          ? `/groups/${ownerAgent.id}`
          : `/profile/${(ownerAgent.metadata?.username as string) || ownerAgent.id}`
    : `/profile/${resource.ownerId}`;

  const seller: User = ownerAgent
    ? agentToUser(ownerAgent)
    : {
        // Intentionally minimal fallback seller prevents null dereferences in listing cards.
        id: resource.ownerId,
        name: (meta.sellerName as string) ?? "Unknown Seller",
        username: "unknown",
        avatar: "/placeholder-user.jpg",
        followers: 0,
        following: 0,
      };

  // Resolve display price from multiple possible metadata sources:
  // 1. Explicit price string (from marketplace listing creator)
  // 2. Hourly rate (from service offerings) formatted as "$X/hr"
  // 3. Base price in cents (from offering creator) formatted as "$X.XX"
  // 4. Total price in cents (computed from bundled items)
  const listingType = (meta.listingType as MarketplaceListing["type"]) ?? "product";
  const thanksValue = listingType === "voucher" ? getThanksValue(meta) : undefined;
  const durationMinutes = getDurationMinutes(meta, listingType);
  let displayPrice = thanksValue ? `${thanksValue} Thanks` : "Free";
  if (typeof meta.price === "string" && meta.price.length > 0) {
    // Strip wrapping quotes from stored price strings (e.g. '"0"' → '0')
    const cleanPrice = stripWrappingQuotes(meta.price);
    const numericPrice = Number(cleanPrice.replace(/[^0-9.]/g, ''));
    displayPrice = (!cleanPrice || numericPrice === 0) ? (thanksValue ? `${thanksValue} Thanks` : "Free") : cleanPrice;
  } else if (typeof meta.hourlyRate === "number" && meta.hourlyRate > 0) {
    displayPrice = `$${meta.hourlyRate.toFixed(2)}/hr`;
  } else if (typeof meta.basePrice === "number" && meta.basePrice > 0) {
    displayPrice = `$${(meta.basePrice / 100).toFixed(2)}`;
  } else if (typeof meta.totalPriceCents === "number" && (meta.totalPriceCents as number) > 0) {
    displayPrice = `$${((meta.totalPriceCents as number) / 100).toFixed(2)}`;
  }

  return {
    id: resource.id,
    title: resource.name,
    description: stripWrappingQuotes(resource.description ?? ""),
    price: displayPrice,
    thanksValue,
    seller,
    ownerKind: ownerIsGroup ? "group" : "member",
    ownerLabel: ownerIsGroup ? "Group offer" : "Member offer",
    ownerPath,
    createdAt: resource.createdAt,
    imageUrl: typeof meta.imageUrl === "string" ? meta.imageUrl : undefined,
    images: (meta.images as string[]) ?? [],
    tags: resource.tags ?? [],
    condition: (meta.condition as string) ?? undefined,
    category: (meta.category as string) ?? undefined,
    type: listingType,
    location: (meta.location as string) ?? undefined,
    currency: (meta.currency as string) ?? undefined,
    acceptedCurrencies: Array.isArray(meta.acceptedCurrencies)
      ? meta.acceptedCurrencies.filter((value): value is string => typeof value === "string")
      : undefined,
    quantityAvailable:
      typeof meta.quantityAvailable === "number" ? meta.quantityAvailable : undefined,
    quantityRemaining:
      typeof meta.quantityRemaining === "number"
        ? meta.quantityRemaining
        : typeof meta.quantityAvailable === "number"
          ? Math.max(
              meta.quantityAvailable - (typeof meta.quantitySold === "number" ? meta.quantitySold : 0),
              0,
            )
          : undefined,
    cardCheckoutAvailable:
      typeof meta.cardCheckoutAvailable === "boolean"
        ? meta.cardCheckoutAvailable
        : undefined,
    cardCheckoutUnavailableReason:
      typeof meta.cardCheckoutUnavailableReason === "string"
        ? meta.cardCheckoutUnavailableReason
        : undefined,
    serviceDetails:
      (typeof meta.availability === "string" || Array.isArray(meta.bookingDates) || meta.estimatedDuration) &&
      ((meta.listingType as string) === "service" ||
        (meta.listingType as string) === "resource" ||
        (meta.listingType as string) === "voucher")
        ? {
            availability:
              typeof meta.availability === "string" && meta.availability.length > 0
                ? [meta.availability]
                : [],
            duration:
              meta.estimatedDuration && typeof meta.estimatedDuration === "object"
                ? [
                    typeof (meta.estimatedDuration as Record<string, unknown>).min === "number"
                      ? `${(meta.estimatedDuration as Record<string, number>).min}h`
                      : null,
                    typeof (meta.estimatedDuration as Record<string, unknown>).max === "number"
                      ? `${(meta.estimatedDuration as Record<string, number>).max}h`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" - ")
                : "",
            durationMinutes,
            bookingDates: toBookingDates(meta.bookingDates),
          }
        : undefined,
  };
}

/**
 * Converts a place agent into the chapter-like location card shape.
 *
 * @param {SerializedAgent} agent - Source place agent.
 * @returns {object} Place object compatible with chapter-oriented UI components.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const place = agentToPlace(placeAgent);
 */
export function agentToPlace(agent: SerializedAgent) {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    slug: (meta.slug as string) ?? slugify(agent.name),
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder-event.jpg",
    location: (meta.location as string) ?? "",
    memberCount: (meta.memberCount as number) ?? 0,
    basinId: resolveBasinId(meta, agent.parentId, agent.pathIds),
    isCommons: (meta.isCommons as boolean) ?? false,
  };
}

/**
 * Converts a graph resource into a post-like object for social feed rendering.
 *
 * @param {SerializedResource} resource - Source resource representing a post.
 * @param {SerializedAgent} [author] - Optional author agent for rich author mapping.
 * @returns {object} Post-shaped object with safe defaults for optional metadata.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const post = resourceToPost(resource, authorAgent);
 */
export function resourceToPost(resource: SerializedResource, author?: SerializedAgent) {
  const meta = resource.metadata ?? {};

  return {
    id: resource.id,
    content: stripWrappingQuotes(resource.content ?? resource.description ?? ""),
    author: author
      ? agentToUser(author)
      : {
          // Fallback author keeps post cards renderable when user records are missing.
          id: resource.ownerId,
          name: (meta.authorName as string) ?? "Unknown",
          username: (meta.authorName as string)?.toLowerCase().replace(/\s+/g, "-") ?? "unknown",
          avatar: (meta.authorImage as string) ?? "/placeholder-user.jpg",
          followers: 0,
          following: 0,
        },
    createdAt: resource.createdAt,
    likes: (meta.likes as number) ?? 0,
    comments: (meta.commentCount as number) ?? 0,
    isLiked: false,
    images: (meta.images as string[]) ?? [],
    tags: resource.tags ?? [],
    groupTags: (meta.groupTags as string[]) ?? [],
    chapterTags: (meta.chapterTags as string[]) ?? [],
    postType: (meta.postType as string) ?? "social",
    isLiveInvitation: meta.isLiveInvitation === true,
    title: (meta.title as string) ?? resource.name ?? undefined,
    basePrice: typeof meta.basePrice === "number"
      ? meta.basePrice
      : typeof meta.totalPriceCents === "number"
        ? meta.totalPriceCents / 100
        : undefined,
    offeringType: (meta.offeringType as string) ?? undefined,
    linkedOfferingId: (meta.linkedOfferingId as string) ?? undefined,
    dealCode: (meta.dealCode as string) ?? undefined,
    dealPriceCents: typeof meta.dealPriceCents === "number" ? meta.dealPriceCents : undefined,
    dealDurationHours: typeof meta.dealDurationHours === "number" ? meta.dealDurationHours : undefined,
    eftValues: meta.eftValues && typeof meta.eftValues === "object" && !Array.isArray(meta.eftValues)
      ? (meta.eftValues as Record<string, number>)
      : undefined,
    capitalValues: meta.capitalValues && typeof meta.capitalValues === "object" && !Array.isArray(meta.capitalValues)
      ? (meta.capitalValues as Record<string, number>)
      : undefined,
    auditValues: meta.auditValues && typeof meta.auditValues === "object" && !Array.isArray(meta.auditValues)
      ? (meta.auditValues as Record<string, number>)
      : undefined,
  };
}

/**
 * Converts a basin place agent into the frontend `Basin` model.
 *
 * @param {SerializedAgent} agent - Source basin agent.
 * @returns {Basin} Basin model with nullable description/image defaults.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const basin = agentToBasin(basinAgent);
 */
export function agentToBasin(agent: SerializedAgent): Basin {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    huc6Code: (meta.huc6Code as string) ?? "",
    description: agent.description ?? undefined,
    image: agent.image ?? undefined,
  };
}

/**
 * Converts a chapter place agent into the frontend `Chapter` model.
 *
 * @param {SerializedAgent} agent - Source chapter/place agent.
 * @returns {Chapter} Chapter model with resolved basin relationship.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const chapter = agentToLocale(chapterAgent);
 */
export function agentToLocale(agent: SerializedAgent): Chapter {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    slug: (meta.slug as string) ?? slugify(agent.name),
    memberCount: (meta.memberCount as number) ?? 0,
    image: agent.image ?? "/placeholder-event.jpg",
    description: agent.description ?? "",
    location: (meta.location as string) ?? "",
    basinId: resolveBasinId(meta, agent.parentId, agent.pathIds),
    isCommons: (meta.isCommons as boolean) ?? false,
  };
}

/**
 * Converts a ring agent into the frontend `Ring` model.
 *
 * @param {SerializedAgent} agent - Source ring agent.
 * @returns {Ring} Ring model with treasury and governance-related metadata where present.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const ring = agentToRing(ringAgent);
 */
export function agentToRing(agent: SerializedAgent): Ring {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder.svg",
    memberCount: (meta.memberCount as number) ?? 0,
    isJoined: false,
    admins: undefined,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    families: (meta.familyIds as string[]) ?? [],
    tags: (meta.tags as string[]) ?? [],
    chapterTags: (meta.chapterTags as string[]) ?? [],
    groupTags: (meta.groupTags as string[]) ?? [],
    createdAt: agent.createdAt,
    color: (meta.color as string) ?? undefined,
    coverImage: (meta.coverImage as string) ?? undefined,
    location: (meta.location as string) ?? undefined,
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    phone: (meta.phone as string) ?? undefined,
    mission: (meta.mission as string) ?? undefined,
    history: (meta.history as string) ?? undefined,
    rules: (meta.rules as string[]) ?? undefined,
    meetingLocation: (meta.meetingLocation as string) ?? undefined,
    type: GroupType.Ring,
    treasury: (meta.treasury as Ring["treasury"]) ?? undefined,
  };
}

/**
 * Converts a family agent into the frontend `Family` model.
 *
 * @param {SerializedAgent} agent - Source family agent.
 * @returns {Family} Family model with parent ring fallback logic.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const family = agentToFamily(familyAgent);
 */
export function agentToFamily(agent: SerializedAgent): Family {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder.svg",
    memberCount: (meta.memberCount as number) ?? 0,
    isJoined: false,
    admins: undefined,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    parentRingId: (meta.parentRingId as string) ?? agent.parentId ?? "",
    tags: (meta.tags as string[]) ?? [],
    chapterTags: (meta.chapterTags as string[]) ?? [],
    groupTags: (meta.groupTags as string[]) ?? [],
    createdAt: agent.createdAt,
    color: (meta.color as string) ?? undefined,
    coverImage: (meta.coverImage as string) ?? undefined,
    location: (meta.location as string) ?? undefined,
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    phone: (meta.phone as string) ?? undefined,
    mission: (meta.mission as string) ?? undefined,
    history: (meta.history as string) ?? undefined,
    rules: (meta.rules as string[]) ?? undefined,
    meetingLocation: (meta.meetingLocation as string) ?? undefined,
    type: GroupType.Family,
  };
}

/**
 * Converts a guild agent into the frontend `Guild` model.
 *
 * @param {SerializedAgent} agent - Source guild agent.
 * @returns {Guild} Guild model with normalized optional metadata.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const guild = agentToGuild(guildAgent);
 */
export function agentToGuild(agent: SerializedAgent): Guild {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder.svg",
    memberCount: (meta.memberCount as number) ?? 0,
    isJoined: false,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    tags: (meta.tags as string[]) ?? [],
    chapterTags: (meta.chapterTags as string[]) ?? [],
    groupTags: (meta.groupTags as string[]) ?? [],
    createdAt: agent.createdAt,
    color: (meta.color as string) ?? undefined,
    coverImage: (meta.coverImage as string) ?? undefined,
    location: (meta.location as string) ?? undefined,
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    phone: (meta.phone as string) ?? undefined,
    mission: (meta.mission as string) ?? undefined,
    rules: (meta.rules as string[]) ?? undefined,
    meetingLocation: (meta.meetingLocation as string) ?? undefined,
    type: "guild",
  };
}

/**
 * Converts a community agent into the frontend `Community` model.
 *
 * @param {SerializedAgent} agent - Source community agent.
 * @returns {Community} Community model with normalized optional metadata.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const community = agentToCommunity(communityAgent);
 */
export function agentToCommunity(agent: SerializedAgent): Community {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder.svg",
    memberCount: (meta.memberCount as number) ?? 0,
    isJoined: false,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    tags: (meta.tags as string[]) ?? [],
    chapterTags: (meta.chapterTags as string[]) ?? [],
    groupTags: (meta.groupTags as string[]) ?? [],
    createdAt: agent.createdAt,
    color: (meta.color as string) ?? undefined,
    coverImage: (meta.coverImage as string) ?? undefined,
    location: (meta.location as string) ?? undefined,
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    phone: (meta.phone as string) ?? undefined,
    mission: (meta.mission as string) ?? undefined,
    rules: (meta.rules as string[]) ?? undefined,
    meetingLocation: (meta.meetingLocation as string) ?? undefined,
    type: "community",
  };
}

/**
 * Converts a domain agent into the frontend `Domain` model.
 *
 * @param {SerializedAgent} agent - Source domain agent.
 * @returns {Domain} Domain model with parent group references.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const domain = agentToDomain(domainAgent);
 */
export function agentToDomain(agent: SerializedAgent): Domain {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    image: agent.image ?? "/placeholder.svg",
    memberCount: (meta.memberCount as number) ?? 0,
    adminIds: (meta.adminIds as string[]) ?? [],
    creatorId: (meta.creatorId as string) ?? undefined,
    members: (meta.memberIds as string[]) ?? [],
    tags: (meta.tags as string[]) ?? [],
    createdAt: agent.createdAt,
    parentGroupId: agent.parentId ?? undefined,
    location: (meta.location as string) ?? undefined,
    website: (meta.website as string) ?? undefined,
    email: agent.email ?? undefined,
    type: "domain",
  };
}

/**
 * Converts a bot agent into the frontend `Bot` model.
 *
 * @param {SerializedAgent} agent - Source bot agent.
 * @returns {Bot} Bot model including ownership and capability metadata.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const bot = agentToBot(botAgent);
 */
export function agentToBot(agent: SerializedAgent): Bot {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    username: (meta.username as string) || slugify(agent.name),
    description: agent.description ?? "",
    avatar: agent.image ?? "/placeholder-bot.jpg",
    createdAt: agent.createdAt,
    ownerId: (meta.ownerId as string) ?? agent.parentId ?? undefined,
    capabilities: (meta.capabilities as string[]) ?? [],
    isActive: (meta.isActive as boolean) ?? true,
    tags: (meta.tags as string[]) ?? [],
    type: "bot",
  };
}

/**
 * Converts a system agent into the frontend `SystemAgent` model.
 *
 * @param {SerializedAgent} agent - Source system agent.
 * @returns {SystemAgent} System-level agent model with version/capability metadata.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const system = agentToSystem(systemAgent);
 */
export function agentToSystem(agent: SerializedAgent): SystemAgent {
  const meta = agent.metadata ?? {};

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    avatar: agent.image ?? "/placeholder-system.jpg",
    createdAt: agent.createdAt,
    isActive: (meta.isActive as boolean) ?? true,
    version: (meta.version as string) ?? undefined,
    capabilities: (meta.capabilities as string[]) ?? [],
    type: "system",
  };
}

/**
 * Converts a group resource into a synthetic `SerializedAgent` for reuse of `agentToGroup`.
 *
 * @param {SerializedResource} resource - Resource with group semantics.
 * @returns {SerializedAgent} Synthetic organization agent preserving resource identifiers.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const syntheticGroupAgent = resourceToGroupAgent(groupResource);
 */
export function resourceToGroupAgent(resource: SerializedResource): SerializedAgent {
  const meta = resource.metadata ?? {};
  return {
    id: resource.id,
    name: resource.name,
    type: "organization",
    description: resource.description,
    email: null,
    image: null,
    metadata: {
      // Include minimal metadata required by downstream group adapter defaults.
      groupType: (meta.groupType as string) ?? "basic",
      chapter: (meta.chapter as string) ?? null,
      creatorId: resource.ownerId,
      tags: resource.tags ?? [],
    },
    parentId: (meta.parentGroupId as string) ?? null,
    depth: 0,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

/**
 * Converts an event resource into a synthetic `SerializedAgent` for `agentToEvent`.
 *
 * @param {SerializedResource} resource - Resource with event semantics.
 * @returns {SerializedAgent} Synthetic event agent preserving timestamps and ownership.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const syntheticEventAgent = resourceToEventAgent(eventResource);
 */
export function resourceToEventAgent(resource: SerializedResource): SerializedAgent {
  const meta = resource.metadata ?? {};
  return {
    id: resource.id,
    name: resource.name,
    type: "event",
    description: resource.description,
    email: null,
    image: null,
    metadata: {
      startDate: (meta.date as string) ?? resource.createdAt,
      endDate: (meta.date as string) ?? resource.createdAt,
      location: (meta.location as string) ?? "",
      creatorId: resource.ownerId,
      price: (meta.price as string) ?? null,
      eventType: (meta.eventType as string) ?? "in-person",
      chapterTags: [],
      tags: resource.tags ?? [],
    },
    parentId: (meta.groupId as string) ?? null,
    depth: 0,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

/**
 * Converts a project resource into a synthetic `SerializedAgent` for `agentToProject`.
 *
 * @param {SerializedResource} resource - Resource with project semantics.
 * @returns {SerializedAgent} Synthetic project agent preserving ownership and tags.
 * @throws {never} This adapter does not intentionally throw.
 * @example
 * const syntheticProjectAgent = resourceToProjectAgent(projectResource);
 */
export function resourceToProjectAgent(resource: SerializedResource): SerializedAgent {
  const meta = resource.metadata ?? {};
  return {
    id: resource.id,
    name: resource.name,
    type: "project",
    description: resource.description,
    email: null,
    image: null,
    metadata: {
      category: (meta.category as string) ?? "",
      creatorId: resource.ownerId,
      status: "active",
      chapterTags: [],
      tags: resource.tags ?? [],
    },
    parentId: (meta.groupId as string) ?? null,
    depth: 0,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

/**
 * Dispatch table mapping graph `AgentType` values to concrete adapter functions.
 *
 * This explicit mapping avoids dynamic eval/reflection and makes type coverage audit-friendly.
 */
const AGENT_ADAPTER_MAP: Record<AgentType, (agent: SerializedAgent) => unknown> = {
  person: agentToUser,
  organization: agentToGroup,
  org: agentToGroup,
  project: agentToProject,
  event: agentToEvent,
  place: agentToPlace,
  ring: agentToRing,
  family: agentToFamily,
  guild: agentToGuild,
  community: agentToCommunity,
  domain: agentToDomain,
  bot: agentToBot,
  system: agentToSystem,
};

/**
 * Adapts any graph agent into its frontend model using type-based dispatch.
 *
 * @param {SerializedAgent} agent - Source graph agent to adapt.
 * @returns {unknown} Adapted frontend model corresponding to `agent.type`.
 * @throws {Error} Thrown when no adapter is registered for the provided agent type.
 * @example
 * const model = adaptAgent(agent);
 */
export function adaptAgent(agent: SerializedAgent): unknown {
  const adapter = AGENT_ADAPTER_MAP[agent.type as AgentType];
  if (!adapter) {
    // Fail closed for unknown types so schema drift is caught quickly.
    throw new Error(`Unknown agent type: "${agent.type}". No adapter registered for this type.`);
  }
  return adapter(agent);
}
