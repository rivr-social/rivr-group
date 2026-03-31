const LISTING_TYPE_LABELS: Record<string, string> = {
  product: "Product",
  service: "Service",
  voucher: "Voucher",
  ticket: "Ticket",
  bounty: "Bounty",
  gift: "Gift",
  skill: "Skill",
  resource: "Resource",
  trip: "Trip",
  data: "Data",
  venue: "Venue",
  standalone: "Offer",
}

export function formatMarketplaceListingTypeLabel(type: string | null | undefined): string {
  if (!type) return "Offer"
  return LISTING_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1)
}

export function getMarketplacePrimaryActionLabel(type: string | null | undefined, hasBookableSchedule = false): string {
  if (hasBookableSchedule) return "Book Now"
  if (type === "product") return "Buy Now"
  if (type === "service" || type === "venue") return "Book Service"
  return "Get Offer"
}
