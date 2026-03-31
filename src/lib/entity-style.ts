/**
 * @fileoverview Centralized entity type visual constants.
 *
 * SINGLE source of truth for all entity type colors, labels, badge classes,
 * and graph node radii used across the app. Components import from here
 * instead of defining their own local color/label maps.
 *
 * Color palette: earth-tone pastels designed for dark (#003333) backgrounds.
 * Muted, warm, organic — not neon or saturated.
 */

// ─── Entity Category Type ────────────────────────────────────────────────────

/** Union of all entity types used across the app. */
export type EntityCategory =
  | "person" | "organization" | "group" | "ring" | "family"  // agents
  | "event" | "post" | "note" | "story"                      // content
  | "listing" | "product" | "service" | "voucher" | "ticket"  // marketplace
  | "bounty" | "gift" | "skill" | "venue" | "resource"        // marketplace subtypes
  | "badge" | "task" | "job" | "project" | "shift" | "role"   // work
  | "thanks_token" | "token" | "money" | "asset"              // currency/value
  | "agreement" | "offer" | "request" | "training"            // interactions
  | "location" | "time" | "plan" | "polling" | "character"    // context
  | "interest" | "sharing" | "gratis"                          // social

// ─── Hex Colors (Earth-Tone Pastels) ────────────────────────────────────────

/** Hex colors for each entity type — muted earthy pastels for dark backgrounds. */
export const ENTITY_COLORS: Record<string, string> = {
  // Agents — warm greens and teals
  person: "#7fb5a0",          // sage green
  organization: "#c8956b",    // warm amber/terra cotta
  group: "#6b9e8a",           // muted teal-green
  ring: "#9b8ec4",            // soft lavender
  family: "#d4a57b",          // warm peach
  character: "#8bb5a8",       // dusty sage

  // Content — warm tones
  event: "#c47a7a",           // dusty rose
  post: "#7a9ebd",            // slate blue
  note: "#7a9ebd",            // slate blue
  story: "#8bb5a8",           // dusty sage

  // Marketplace — earthy mixes
  listing: "#c49b7a",         // sandy tan
  product: "#b8917a",         // warm clay
  service: "#7ab5a8",         // seafoam
  voucher: "#d4a57b",         // warm peach
  ticket: "#c98bad",          // mauve pink
  bounty: "#c8956b",          // terra cotta
  gift: "#98c4a8",            // mint sage
  skill: "#7ab5c4",           // soft cyan
  venue: "#c47a7a",           // dusty rose
  resource: "#b5a87a",        // warm khaki
  offer: "#98c4a8",           // mint sage
  request: "#9bb5c4",         // dusty blue
  sharing: "#7ab5a8",         // seafoam

  // Work — muted earth tones
  badge: "#c8a84b",           // golden ochre
  task: "#b5b89b",            // sage tan
  job: "#8b9ec4",             // periwinkle
  project: "#9b8ec4",         // soft lavender
  shift: "#a0a89b",           // olive gray
  role: "#8bb5a8",            // dusty sage
  plan: "#b5917a",            // warm clay
  training: "#c49b7a",        // sandy tan
  agreement: "#b5917a",       // warm clay

  // Currency/Value — warm golds
  thanks_token: "#c98bad",    // mauve pink
  token: "#c8a84b",           // golden ochre
  money: "#b5c47a",           // golden green
  asset: "#c8b84b",           // warm gold
  gratis: "#c98bad",          // mauve pink

  // Context
  location: "#c47a7a",        // dusty rose
  time: "#b5917a",            // warm clay
  polling: "#8b9ec4",         // periwinkle
  interest: "#9b8ec4",        // soft lavender

  // Wildcard/default
  unknown: "#8a9a8a",         // neutral sage gray
}

// ─── Tailwind Badge Classes ──────────────────────────────────────────────────

/**
 * Tailwind badge classes — earth-tone pastels.
 * Dark mode uses translucent backgrounds that work on #003333.
 */
export const ENTITY_BADGE_CLASSES: Record<string, string> = {
  person: "bg-[#7fb5a0]/20 text-[#7fb5a0] border border-[#7fb5a0]/30",
  organization: "bg-[#c8956b]/20 text-[#c8956b] border border-[#c8956b]/30",
  group: "bg-[#6b9e8a]/20 text-[#6b9e8a] border border-[#6b9e8a]/30",
  ring: "bg-[#9b8ec4]/20 text-[#9b8ec4] border border-[#9b8ec4]/30",
  family: "bg-[#d4a57b]/20 text-[#d4a57b] border border-[#d4a57b]/30",
  event: "bg-[#c47a7a]/20 text-[#c47a7a] border border-[#c47a7a]/30",
  post: "bg-[#7a9ebd]/20 text-[#7a9ebd] border border-[#7a9ebd]/30",
  note: "bg-[#7a9ebd]/20 text-[#7a9ebd] border border-[#7a9ebd]/30",
  listing: "bg-[#c49b7a]/20 text-[#c49b7a] border border-[#c49b7a]/30",
  product: "bg-[#b8917a]/20 text-[#b8917a] border border-[#b8917a]/30",
  service: "bg-[#7ab5a8]/20 text-[#7ab5a8] border border-[#7ab5a8]/30",
  voucher: "bg-[#d4a57b]/20 text-[#d4a57b] border border-[#d4a57b]/30",
  ticket: "bg-[#c98bad]/20 text-[#c98bad] border border-[#c98bad]/30",
  badge: "bg-[#c8a84b]/20 text-[#c8a84b] border border-[#c8a84b]/30",
  task: "bg-[#b5b89b]/20 text-[#b5b89b] border border-[#b5b89b]/30",
  job: "bg-[#8b9ec4]/20 text-[#8b9ec4] border border-[#8b9ec4]/30",
  project: "bg-[#9b8ec4]/20 text-[#9b8ec4] border border-[#9b8ec4]/30",
  skill: "bg-[#7ab5c4]/20 text-[#7ab5c4] border border-[#7ab5c4]/30",
  venue: "bg-[#c47a7a]/20 text-[#c47a7a] border border-[#c47a7a]/30",
  bounty: "bg-[#c8956b]/20 text-[#c8956b] border border-[#c8956b]/30",
  gift: "bg-[#98c4a8]/20 text-[#98c4a8] border border-[#98c4a8]/30",
  resource: "bg-[#b5a87a]/20 text-[#b5a87a] border border-[#b5a87a]/30",
  shift: "bg-[#a0a89b]/20 text-[#a0a89b] border border-[#a0a89b]/30",
  thanks_token: "bg-[#c98bad]/20 text-[#c98bad] border border-[#c98bad]/30",
  role: "bg-[#8bb5a8]/20 text-[#8bb5a8] border border-[#8bb5a8]/30",
  offer: "bg-[#98c4a8]/20 text-[#98c4a8] border border-[#98c4a8]/30",
  request: "bg-[#9bb5c4]/20 text-[#9bb5c4] border border-[#9bb5c4]/30",
  agreement: "bg-[#b5917a]/20 text-[#b5917a] border border-[#b5917a]/30",
  token: "bg-[#c8a84b]/20 text-[#c8a84b] border border-[#c8a84b]/30",
  money: "bg-[#b5c47a]/20 text-[#b5c47a] border border-[#b5c47a]/30",
  asset: "bg-[#c8b84b]/20 text-[#c8b84b] border border-[#c8b84b]/30",
  plan: "bg-[#b5917a]/20 text-[#b5917a] border border-[#b5917a]/30",
  training: "bg-[#c49b7a]/20 text-[#c49b7a] border border-[#c49b7a]/30",
  location: "bg-[#c47a7a]/20 text-[#c47a7a] border border-[#c47a7a]/30",
  time: "bg-[#b5917a]/20 text-[#b5917a] border border-[#b5917a]/30",
  polling: "bg-[#8b9ec4]/20 text-[#8b9ec4] border border-[#8b9ec4]/30",
  character: "bg-[#8bb5a8]/20 text-[#8bb5a8] border border-[#8bb5a8]/30",
  interest: "bg-[#9b8ec4]/20 text-[#9b8ec4] border border-[#9b8ec4]/30",
  sharing: "bg-[#7ab5a8]/20 text-[#7ab5a8] border border-[#7ab5a8]/30",
  gratis: "bg-[#c98bad]/20 text-[#c98bad] border border-[#c98bad]/30",
  story: "bg-[#8bb5a8]/20 text-[#8bb5a8] border border-[#8bb5a8]/30",
  unknown: "bg-[#8a9a8a]/20 text-[#8a9a8a] border border-[#8a9a8a]/30",
}

// ─── Display Labels ──────────────────────────────────────────────────────────

/** Human-readable labels for each entity type. */
export const ENTITY_LABELS: Record<string, string> = {
  person: "Person",
  organization: "Org",
  group: "Group",
  ring: "Ring",
  family: "Family",
  character: "Character",
  event: "Event",
  post: "Post",
  note: "Note",
  story: "Story",
  listing: "Listing",
  product: "Product",
  service: "Service",
  voucher: "Voucher",
  ticket: "Ticket",
  bounty: "Bounty",
  gift: "Gift",
  skill: "Skill",
  venue: "Venue",
  resource: "Resource",
  offer: "Offer",
  request: "Request",
  sharing: "Sharing",
  badge: "Badge",
  task: "Task",
  job: "Job",
  project: "Project",
  shift: "Shift",
  role: "Role",
  plan: "Plan",
  training: "Training",
  agreement: "Agreement",
  thanks_token: "Thanks",
  token: "Token",
  money: "Money",
  asset: "Asset",
  gratis: "Gratis",
  location: "Location",
  time: "Time",
  polling: "Polling",
  interest: "Interest",
  unknown: "Unknown",
}

// ─── Graph Node Radii ────────────────────────────────────────────────────────

/** Node radii for the full-size D3 force-directed graph. */
export const ENTITY_RADII: Record<string, number> = {
  person: 20,
  organization: 28,
  group: 28,
  ring: 24,
  family: 24,
  character: 18,
  event: 22,
  post: 14,
  note: 14,
  story: 16,
  listing: 18,
  product: 18,
  service: 18,
  voucher: 16,
  ticket: 16,
  bounty: 18,
  gift: 16,
  skill: 16,
  venue: 20,
  resource: 16,
  offer: 16,
  request: 16,
  sharing: 16,
  badge: 16,
  task: 14,
  job: 18,
  project: 22,
  shift: 14,
  role: 18,
  plan: 18,
  training: 16,
  agreement: 20,
  thanks_token: 14,
  token: 14,
  money: 16,
  asset: 16,
  gratis: 14,
  location: 18,
  time: 16,
  polling: 18,
  interest: 16,
  unknown: 16,
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/** Returns the hex color for a given entity type, falling back to gray. */
export function getEntityColor(type: string): string {
  return ENTITY_COLORS[type] ?? ENTITY_COLORS.unknown
}

/** Returns the Tailwind badge class string for a given entity type. */
export function getEntityBadgeClass(type: string): string {
  return ENTITY_BADGE_CLASSES[type] ?? ENTITY_BADGE_CLASSES.unknown
}

/** Returns the display label for a given entity type. */
export function getEntityLabel(type: string): string {
  return ENTITY_LABELS[type] ?? type
}

/** Returns the graph node radius for a given entity type. */
export function getEntityRadius(type: string): number {
  return ENTITY_RADII[type] ?? ENTITY_RADII.unknown ?? 16
}

// ─── Graph Node Category ─────────────────────────────────────────────────────

/** Coarser grouping used in the explore graph legend and type filters. */
export type GraphNodeCategory = "person" | "group" | "event" | "post" | "offering"

/** Maps a fine-grained entity type to a coarser graph category. */
export function toGraphCategory(type: string): GraphNodeCategory {
  if (type === "person" || type === "character") return "person"
  if (["organization", "group", "ring", "family"].includes(type)) return "group"
  if (["event", "venue"].includes(type)) return "event"
  if (["post", "note", "story"].includes(type)) return "post"
  return "offering"
}

/** Graph-level colors for the coarser categories. */
export const GRAPH_CATEGORY_COLORS: Record<GraphNodeCategory, string> = {
  person: ENTITY_COLORS.person,
  group: ENTITY_COLORS.group,
  event: ENTITY_COLORS.event,
  post: ENTITY_COLORS.post,
  offering: ENTITY_COLORS.listing,
}

/** Graph-level radii for the coarser categories. */
export const GRAPH_CATEGORY_RADII: Record<GraphNodeCategory, number> = {
  person: ENTITY_RADII.person,
  group: ENTITY_RADII.group,
  event: ENTITY_RADII.event,
  post: ENTITY_RADII.post,
  offering: ENTITY_RADII.listing,
}
