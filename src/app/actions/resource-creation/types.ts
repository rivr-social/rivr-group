import type { ResourceEmbed, ResourceType, VisibilityLevel } from "@/db/schema";

export interface ActionResult {
  success: boolean;
  message: string;
  resourceId?: string;
  linkedEventId?: string;
  linkedDocumentId?: string;
  error?: {
    code: string;
    details?: string;
    requiredTier?: string;
  };
}

export interface CreateResourceInput {
  name: string;
  type: ResourceType;
  ownerId?: string;
  description?: string;
  content?: string;
  tags?: string[];
  visibility?: VisibilityLevel;
  metadata?: Record<string, unknown>;
  /** Rich link/unfurl embeds attached to the new resource. */
  embeds?: ResourceEmbed[];
  location?: { lat: number; lng: number };
  federate?: boolean;
}

export interface UpdateResourceInput {
  resourceId: string;
  ownerId?: string;
  name?: string;
  description?: string | null;
  content?: string | null;
  tags?: string[];
  visibility?: VisibilityLevel;
  metadataPatch?: Record<string, unknown>;
}

export interface UpdateGroupResourceInput {
  groupId: string;
  name?: string;
  description?: string;
  metadataPatch?: Record<string, unknown>;
}

export interface CommentData {
  id: string;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  content: string;
  timestamp: string;
  parentCommentId: string | null;
  isGift?: boolean;
  giftType?: "voucher" | "thanks";
  giftMessage?: string;
  voucherId?: string;
  voucherName?: string;
  thanksTokenCount?: number;
}

export const GROUP_LIKE_OWNER_AGENT_TYPES = [
  "organization",
  "place",
  "ring",
  "family",
  "guild",
  "community",
  "domain",
  "org",
] as const;

/**
 * Per-group member content-capability toggles. Members may, by default, author
 * the content-participation verbs in a group they belong to; a group admin can
 * restrict this per-verb via `agents.metadata.memberCapabilities`
 * (`Record<verb, boolean>`). Absence of a toggle means default-on.
 *
 * This is the verified-principal authz axis made per-group: the toggle is the
 * explicit grant a member's posting hangs on — a `join`/`belong` row alone never
 * grants write (see `hasGroupManageAccess`).
 *
 * Lives in this pure module (not the `"use server"` helpers) so the synchronous
 * resolver can be exported without violating the server-actions-must-be-async
 * constraint.
 */
export const MEMBER_CAPABILITY_VERBS = ["create", "comment", "react"] as const;
export type MemberCapabilityVerb = (typeof MEMBER_CAPABILITY_VERBS)[number];

export function resolveGroupMemberCapability(
  metadata: Record<string, unknown> | null | undefined,
  verb: MemberCapabilityVerb,
): boolean {
  const caps = (metadata ?? {}).memberCapabilities;
  if (caps && typeof caps === "object" && !Array.isArray(caps)) {
    const value = (caps as Record<string, unknown>)[verb];
    if (typeof value === "boolean") return value;
  }
  // Default-on for the recognized content verbs.
  return (MEMBER_CAPABILITY_VERBS as readonly string[]).includes(verb);
}

/**
 * Convert a dollar amount to integer cents. Offering/listing prices arrive from
 * the form as DOLLARS but are persisted (and forwarded over federation) in
 * CENTS — so this helper is the single conversion point.
 *
 * Returns 0 for non-finite or non-positive inputs so callers can safely
 * compare against `0` to detect "no price".
 */
export function dollarsToCents(amount: number | null | undefined): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return 0;
  }
  return Math.round(amount * 100);
}

// --- Event ticket types and helpers ---

export type EventTicketInput = {
  id?: string;
  name: string;
  description?: string | null;
  price?: number | null;
  quantity?: number | null;
};

export type NormalizedEventTicket = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  quantity: number | null;
  term: "sale" | "voucher";
};

export function normalizeEventTickets(input: {
  ticketTypes?: EventTicketInput[];
  price?: number | null;
}): NormalizedEventTicket[] {
  const ticketTypes = Array.isArray(input.ticketTypes) ? input.ticketTypes : [];
  const normalized = ticketTypes
    .map((ticket, index) => {
      const name = ticket.name?.trim();
      if (!name) return null;
      const price = typeof ticket.price === "number" ? ticket.price : Number(ticket.price ?? 0);
      const priceCents = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : 0;
      const quantity =
        typeof ticket.quantity === "number" && Number.isFinite(ticket.quantity) && ticket.quantity > 0
          ? Math.trunc(ticket.quantity)
          : null;
      return {
        id: ticket.id?.trim() || `ticket-${index + 1}`,
        name,
        description: ticket.description?.trim() || "",
        priceCents,
        quantity,
        term: priceCents > 0 ? "sale" : "voucher",
      } satisfies NormalizedEventTicket;
    })
    .filter((ticket): ticket is NormalizedEventTicket => Boolean(ticket));

  if (normalized.length > 0) return normalized;

  const legacyPrice = typeof input.price === "number" ? input.price : Number(input.price ?? 0);
  const priceCents = Number.isFinite(legacyPrice) && legacyPrice > 0 ? Math.round(legacyPrice * 100) : 0;
  return [{
    id: "general-admission",
    name: "General Admission",
    description: "",
    priceCents,
    quantity: null,
    term: priceCents > 0 ? "sale" : "voucher",
  }];
}

// --- Offering helpers ---

const TERM_RULES: Record<string, { default: string[]; commercial: string[] }> = {
  resource: { default: ["give", "voucher"], commercial: ["borrow", "rent", "sale"] },
  skill: { default: ["give", "voucher"], commercial: ["sale"] },
  voucher: { default: ["give"], commercial: ["give"] },
  venue: { default: ["rent"], commercial: ["rent"] },
  gift: { default: ["give"], commercial: ["give"] },
  bounty: { default: ["give"], commercial: ["sale"] },
};

export function getAllowedTerms(
  resourceType: string,
  metadata: Record<string, unknown>
): string[] {
  const rules = TERM_RULES[resourceType];
  if (!rules) return ["give"];

  const listingType = String(metadata.listingType ?? "").toLowerCase();
  const hasPrice =
    typeof metadata.price === "number" && metadata.price > 0;
  const isCommercial =
    listingType === "product" ||
    listingType === "service" ||
    hasPrice;

  return isCommercial ? rules.commercial : rules.default;
}

export function deriveOfferingListingType(
  items: Array<{ resourceType: string; term: string }>
): string {
  const hasSale = items.some((i) => i.term === "sale");
  const hasRent = items.some((i) => i.term === "rent");
  const hasBorrow = items.some((i) => i.term === "borrow");
  const hasSkill = items.some((i) => i.resourceType === "skill");
  const hasVenue = items.some((i) => i.resourceType === "venue");

  if (hasSale && hasSkill) return "service";
  if (hasSale) return "product";
  if (hasRent && hasVenue) return "venue";
  if (hasRent || hasBorrow) return "resource";
  return "offering";
}
