import type { ResourceType, VisibilityLevel } from "@/db/schema";

export interface ActionResult {
  success: boolean;
  message: string;
  resourceId?: string;
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
