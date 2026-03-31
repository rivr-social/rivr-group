/**
 * Canonical frontend domain model definitions shared across UI, adapters, and state.
 *
 * Purpose:
 * - Define stable contracts for social, group, governance, marketplace, and app-state data.
 * - Keep model names and enum values centralized so adapters/components remain aligned.
 * - Document configuration patterns (status unions, discriminated `type` fields, and optional
 *   metadata bags) used across the application.
 *
 * Key exports:
 * - Core actor/content models (`User`, `Post`, `Event`, `Group`, `Project`).
 * - Domain-specific enums for membership, governance, treasury, and marketplace flows.
 * - Global app context contracts (`AppState`, `AppContextType`).
 *
 * Dependencies:
 * - None. This module intentionally contains type-only exports.
 */

/** Frontend representation of a person or account entity. */
export type User = {
  id: string
  name: string
  username: string
  profileHref?: string
  email?: string
  bio?: string
  tagline?: string
  avatar: string
  followers: number
  following: number
  isFollowing?: boolean
  isVerified?: boolean
  joinDate?: string
  joinedAt?: string
  location?: string
  website?: string
  skills?: string[]
  resources?: string[]
  points?: number
  chapterTags?: string[]
  groupTags?: string[]
  role?: string
  // Persona fields
  geneKeys?: string
  humanDesign?: string
  westernAstrology?: string
  vedicAstrology?: string
  ocean?: string
  myersBriggs?: string
  enneagram?: string
  homeLocale?: string
}



/** Basin-level place model used for geographic grouping of chapters. */
export type Basin = {
  id: string
  name: string
  huc6Code: string
  description?: string
  image?: string
}

/** Chapter/place model scoped to a basin and locale-level community context. */
export type Chapter = {
  id: string
  name: string
  slug: string
  memberCount: number
  image: string
  description: string
  location: string
  basinId: string
  isCommons: boolean
}

/** Social feed post model with optional offering metadata overlays. */
export type Post = {
  id: string
  content: string
  author: User
  createdAt: string
  timestamp?: string
  likes: number
  comments: number
  isLiked?: boolean
  images?: string[]
  tags?: string[]
  groupTags?: string[]
  chapterTags?: string[]

  type?: string
  postType?: PostType
  isLiveInvitation?: boolean

  // Offering-specific fields
  title?: string
  description?: string
  offeringType?: OfferingType
  basePrice?: number
  currency?: string
  acceptedCurrencies?: string[]
  isActive?: boolean
  linkedOfferingId?: string
  dealCode?: string
  dealPriceCents?: number
  dealDurationHours?: number
  timeValue?: number
  skillValue?: number
  difficultyValue?: number
  resourceValue?: number
  thanksValue?: number
  timeHours?: number
  timeMinutes?: number
  resourceCostDollars?: number
  eftValues?: Record<string, number>
  capitalValues?: Record<string, number>
  auditValues?: Record<string, number>
}

/** Event model used by community feeds and scheduling interfaces. */
export type Event = {
  id: string
  name: string
  title?: string
  description: string
  date?: string
  startDate?: string
  time?: string
  location?: {
    name: string
    address?: string
    coordinates?: {
      lat: number
      lng: number
    }
  }
  timeframe?: {
    start: string
    end: string
  }
  organizer: User
  attendees: number
  isAttending?: boolean
  image?: string
  price?: string
  tags?: string[]
  groupTags?: string[]
  chapterTags?: string[]

}

/** Controlled vocabulary for bookable venue categories. */
export enum VenueType {
  ConferenceRoom = "conference-room",
  EventSpace = "event-space",
  OutdoorSpace = "outdoor-space",
  Kitchen = "kitchen",
  Workshop = "workshop",
  Classroom = "classroom",
  Studio = "studio",
  Theater = "theater",
  Garden = "garden",
  Other = "other"
}

/** Supported social post intent types. */
export enum PostType {
  Social = "social",
  Offer = "offer",
  Request = "request",
  Gratitude = "gratitude"
}

/** Supported marketplace/offering categories. */
export enum OfferingType {
  Skill = "skill",
  Resource = "resource",
  Product = "product",
  Service = "service",
  Venue = "venue",
  Trip = "trip",
  Ticket = "ticket",
  Voucher = "voucher",
  Data = "data",
  Gift = "gift",
  Bounty = "bounty"
}

/** Listing of a member-provided offering, including optional voucher metadata. */
export type Offering = {
  id: string
  title: string
  description: string
  type: OfferingType
  basePrice?: number
  currency?: string
  acceptedCurrencies?: string[]
  createdBy: string
  createdAt: string
  tags?: string[]
  isActive: boolean
  // Voucher specific fields (legacy)
  timeValue?: number
  skillValue?: number
  difficultyValue?: number
  resourceValue?: number
  thanksValue?: number
  // Voucher specific fields (new)
  timeHours?: number
  timeMinutes?: number
  resourceCostDollars?: number
}

/** Bookable venue entity with pricing, amenities, and availability constraints. */
export type Venue = {
  id: string
  name: string
  description: string
  type: VenueType
  capacity: number
  hourlyRate: number
  dailyRate?: number
  amenities: string[]
  location: string
  images?: string[]
  availability: { date: string; timeSlots: string[] }[]
  owner: User
  rules?: string[]
  setupTime?: number // minutes
  cleanupTime?: number // minutes
  tags?: string[]

}

/** Venue reservation record that tracks timing, status, and billing details. */
export type VenueBooking = {
  id: string
  venueId: string
  bookedBy: string
  eventId?: string
  projectId?: string
  startTime: string
  endTime: string
  purpose: string
  status: "pending" | "confirmed" | "cancelled"
  totalCost: number
  createdAt: string
  specialRequests?: string
}

/** Marketplace listing record for products, services, and optional venue offers. */
export type MarketplaceListing = {
  id: string
  title: string
  description: string
  price: string
  thanksValue?: number
  seller: User
  ownerKind?: "group" | "member"
  ownerLabel?: string
  ownerPath?: string
  createdAt: string
  imageUrl?: string
  images?: string[]
  tags?: string[]
  condition?: string
  category?: string

  // Type of listing
  type?: 'product' | 'service' | 'voucher' | 'ticket' | 'bounty' | 'gift' | 'skill' | 'resource' | 'trip' | 'data' | 'standalone'
  location?: string
  /** Currency the seller accepts (e.g. USD, USDC, ETH) */
  currency?: string
  /** All currencies/forms the seller accepts for this listing. */
  acceptedCurrencies?: string[]
  /** Total units currently available for purchase/claim. */
  quantityAvailable?: number
  /** Remaining units after completed purchases/claims. */
  quantityRemaining?: number
  /** Whether Stripe card checkout is currently available for this seller/listing. */
  cardCheckoutAvailable?: boolean
  /** Reason card checkout is unavailable, suitable for UI display. */
  cardCheckoutUnavailableReason?: string
  // Venue-specific fields (when listing is a venue)
  isVenue?: boolean
  venue?: Venue
  // Service-specific fields
  serviceDetails?: {
    availability: string[]
    duration: string
    durationMinutes?: number
    bookingDates: { date: string; timeSlots: string[] }[]
  }
}

/** Collaborative project model used by project feeds and membership panels. */
export type Project = {
  id: string
  title: string
  description: string
  creator: User
  createdAt: string
  members: User[]
  tags?: string[]
  image?: string
  status?: "planning" | "active" | "completed"

}

/** Comment record used for feed threads and nested replies. */
export type Comment = {
  id: string
  content: string
  author: string
  timestamp: string
  likes: number
  isLiked?: boolean
  postId?: string
  parentId?: string
}

/**
 * Group join policy configuration.
 *
 * Business rule:
 * - `InviteAndApply` is the strictest mode and generally requires both invitation and review.
 */
export enum JoinType {
  Public = "public", // Anyone can join
  ApprovalRequired = "approval_required", // Requires admin approval
  InviteOnly = "invite_only", // By invite link only
  InviteAndApply = "invite_and_apply", // Invite and application required
}

/** Allowed delivery channels for group/member notifications. */
export enum NotificationType {
  Native = "native",
  Email = "email",
  Text = "text",
}

/** Prompt definition for group join applications. */
export type JoinQuestion = {
  id: string
  question: string
  label?: string
  required: boolean
  type: "text" | "multipleChoice" | "checkbox" | "textarea" | "radio"
  options?: (string | { value: string; label: string })[]
}

export type GroupDiscoveryMode = "public" | "hidden"

/** Group join workflow configuration model. */
export type GroupJoinSettings = {
  joinType: JoinType
  visibility?: GroupDiscoveryMode
  questions?: JoinQuestion[]
  approvalRequired?: boolean
  passwordRequired?: boolean
  inviteLink?: string
  applicationInstructions?: string
}

/** Notification channel preferences grouped by product surface. */
export type GroupNotificationSettings = {
  posts: NotificationType[]
  events: NotificationType[]
  marketplace: NotificationType[]
  governance: NotificationType[]
  memberUpdates: NotificationType[]
}

/** Per-user membership state and notification preferences inside a group. */
export type UserGroupSettings = {
  userId: string
  groupId: string
  notificationSettings: GroupNotificationSettings
  role?: "member" | "admin" | "creator"
  joinedAt: string
}

/** Canonical group taxonomy used by adapters and group UI flows. */
export enum GroupType {
  Group = "group",
  Ring = "ring",
  Family = "family",
  Basic = "basic",
  Organization = "organization",
}

/** Discount pass strategy for organization marketplace transactions. */
export enum FlowPassType {
  Percentage = "percentage",
  Fixed = "fixed",
  FreeFlow = "free_flow", // For free access to services
}

/** Organization discount/pass definition applied to eligible services and tiers. */
export type FlowPass = {
  id: string
  organizationId: string
  title: string
  description: string
  type: FlowPassType
  value?: number // Percentage discount (1-100) or fixed amount off
  applicableServices: string[] // Service IDs this pass applies to
  eligibleMembershipTiers: string[] // Which membership tiers get this pass
  isActive: boolean
  createdAt: string
  expiresAt?: string
  usageLimit?: number // Max uses per member
  currentUsage?: Record<string, number> // userId -> usage count
  tags?: string[]
}

/** Audit record for each time a flow pass is redeemed. */
export type FlowPassUsage = {
  id: string
  passId: string
  userId: string
  serviceId: string
  originalPrice: number
  discountAmount: number
  finalPrice: number
  usedAt: string
}

/** Treasury ledger transaction category. */
export enum TreasuryTransactionType {
  Deposit = "deposit",
  Withdrawal = "withdrawal",
  Transfer = "transfer",
  Fee = "fee",
}

/** Ring treasury ledger transaction entry. */
export type TreasuryTransaction = {
  id: string
  ringId: string
  userId: string
  type: TreasuryTransactionType
  amount: number
  description: string
  timestamp: string
  fromUserId?: string // For transfers
  toUserId?: string // For transfers
  approved: boolean
  approvedBy?: string
  approvedAt?: string
}

/** Per-member withdrawal capacity metrics derived from contribution history. */
export type MemberResourceRatio = {
  userId: string
  ringId: string
  totalDeposited: number
  totalWithdrawn: number
  resourceRatio: number // Calculated as totalDeposited / totalWithdrawn (minimum 0.1)
  maxWithdrawalLimit: number // Based on ratio and treasury balance
  lastUpdated: string
}

/** Aggregate treasury state for a ring, including ledger and member ratios. */
export type RingTreasury = {
  ringId: string
  totalBalance: number
  totalDeposited: number
  totalWithdrawn: number
  createdAt: string
  lastUpdated: string
  transactions: TreasuryTransaction[]
  memberRatios: MemberResourceRatio[]
  monthlyFlowVolume?: number // Added to track business flow from ventures
  totalFlowVolume?: number // Cumulative flow from all ventures
}

/** Joint venture record linking organizations and participating parent rings. */
export type JointVenture = {
  id: string
  name: string
  description: string
  orgId: string // Reference to the org that operates this venture
  parentRings: string[] // Ring IDs that own this venture
  ownershipShares: { ringId: string; percentage: number }[] // Ownership distribution
  status: "planning" | "active" | "profitable" | "dormant" | "dissolved"
  foundedDate: string
  industry: string
  businessModel: string
  monthlyRevenue?: number
  monthlyExpenses?: number
  netProfit?: number
  profitDistributionDate?: string // When profits were last distributed
  flowVolume?: number // Monthly flow volume to parent rings
}

/** Financial transaction entry for joint venture accounting flows. */
export type VentureTransaction = {
  id: string
  ventureId: string
  type: "revenue" | "expense" | "profit_distribution" | "investment"
  amount: number
  description: string
  date: string
  ringRecipient?: string // Which ring received profit distribution
}

/** Voucher classification for ring-level exchange pools. */
export enum VoucherCategory {
  Service = "service",
  Goods = "goods",
  Skill = "skill",
  Experience = "experience",
  Resource = "resource",
}

/** Lifecycle status of a voucher listing. */
export enum VoucherStatus {
  Available = "available",
  Claimed = "claimed",
  Completed = "completed",
  Expired = "expired",
}

/** Voucher offer published into a ring-level pool. */
export type Voucher = {
  id: string
  title: string
  description: string
  category: VoucherCategory
  offeredBy: string // User ID
  ringId: string
  createdAt: string
  expiresAt?: string
  status: VoucherStatus
  claimedBy?: string // User ID
  claimedAt?: string
  completedAt?: string
  tags?: string[]
  estimatedValue?: number
  timeCommitment?: string // e.g., "2 hours", "1 day"
  location?: string
  maxClaims?: number // For vouchers that can be claimed multiple times
  currentClaims?: number
}

/** Claim lifecycle record for voucher usage and fulfillment. */
export type VoucherClaim = {
  id: string
  voucherId: string
  claimedBy: string
  claimedAt: string
  status: "pending" | "accepted" | "completed" | "cancelled"
  notes?: string
  completedAt?: string
  rating?: number
  feedback?: string
}

/**
 * General-purpose group model.
 *
 * Configuration pattern:
 * - `type` is optional to preserve compatibility with legacy data snapshots.
 */
export type Group = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  isJoined?: boolean
  admins?: User[]
  adminIds?: string[]
  creatorId?: string
  members?: string[]
  tags?: string[]
  chapterTags?: string[]
  groupTags?: string[]
  createdAt: string

  color?: string
  coverImage?: string
  location?: string
  website?: string
  email?: string
  phone?: string
  mission?: string
  history?: string
  rules?: string[]
  meetingLocation?: string
  milestones?: { date: string; description: string }[]
  joinSettings?: GroupJoinSettings
  defaultNotificationSettings?: GroupNotificationSettings
  parentGroupId?: string // For subgroups
  affiliatedGroups?: string[]
  affiliatedGroupIds?: string[]
  type?: GroupType // Make this optional for backward compatibility
  avatar?: string
  // Organization-specific fields
  boardMembers?: { id: string; name: string; role: string; avatar: string }[]
  subgroups?: { id: string; name: string; description: string; membershipClass: string }[]
  offerings?: { id: string; name: string; description: string; type: string }[]
  flowPasses?: FlowPass[] // Flow passes for automatic discounts
  membershipTiers?: string[] // Available membership tiers
  modelUrl?: string // GLB 3D model URL for map markers
}

/** Ring specialization of `Group` with treasury fields and required ring type. */
export type Ring = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  isJoined?: boolean
  admins?: User[]
  adminIds?: string[]
  creatorId?: string
  members?: string[]
  families?: string[] // Array of Family IDs that belong to this Ring
  tags?: string[]
  chapterTags?: string[]
  groupTags?: string[]
  createdAt: string

  color?: string
  coverImage?: string
  location?: string
  website?: string
  email?: string
  phone?: string
  mission?: string
  history?: string
  rules?: string[]
  meetingLocation?: string
  milestones?: { date: string; description: string }[]
  joinSettings?: GroupJoinSettings
  defaultNotificationSettings?: GroupNotificationSettings
  type: GroupType.Ring
  treasury?: RingTreasury // Treasury for the Ring
}

/** Family specialization linked to a parent ring. */
export type Family = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  isJoined?: boolean
  admins?: User[]
  adminIds?: string[]
  creatorId?: string
  members?: string[] // Array of User IDs in this Family
  parentRingId: string // ID of the Ring this Family belongs to
  tags?: string[]
  chapterTags?: string[]
  groupTags?: string[]
  createdAt: string

  color?: string
  coverImage?: string
  location?: string
  website?: string
  email?: string
  phone?: string
  mission?: string
  history?: string
  rules?: string[]
  meetingLocation?: string
  milestones?: { date: string; description: string }[]
  joinSettings?: GroupJoinSettings
  defaultNotificationSettings?: GroupNotificationSettings
  type: GroupType.Family
}

/** Guild specialization with a fixed `"guild"` discriminator. */
export type Guild = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  isJoined?: boolean
  admins?: User[]
  adminIds?: string[]
  creatorId?: string
  members?: string[]
  tags?: string[]
  chapterTags?: string[]
  groupTags?: string[]
  createdAt: string
  color?: string
  coverImage?: string
  location?: string
  website?: string
  email?: string
  phone?: string
  mission?: string
  rules?: string[]
  meetingLocation?: string
  joinSettings?: GroupJoinSettings
  type: "guild"
}

/** Community specialization with a fixed `"community"` discriminator. */
export type Community = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  isJoined?: boolean
  admins?: User[]
  adminIds?: string[]
  creatorId?: string
  members?: string[]
  tags?: string[]
  chapterTags?: string[]
  groupTags?: string[]
  createdAt: string
  color?: string
  coverImage?: string
  location?: string
  website?: string
  email?: string
  phone?: string
  mission?: string
  rules?: string[]
  meetingLocation?: string
  joinSettings?: GroupJoinSettings
  type: "community"
}

/** Domain specialization with a fixed `"domain"` discriminator. */
export type Domain = {
  id: string
  name: string
  description: string
  image: string
  memberCount: number
  adminIds?: string[]
  creatorId?: string
  members?: string[]
  tags?: string[]
  createdAt: string
  parentGroupId?: string
  location?: string
  website?: string
  email?: string
  type: "domain"
}

/** Bot actor model used for automated agents in feeds and memberships. */
export type Bot = {
  id: string
  name: string
  username: string
  description: string
  avatar: string
  createdAt: string
  ownerId?: string
  capabilities?: string[]
  isActive: boolean
  tags?: string[]
  type: "bot"
}

/** System-managed actor model for built-in platform automations. */
export type SystemAgent = {
  id: string
  name: string
  description: string
  avatar: string
  createdAt: string
  isActive: boolean
  version?: string
  capabilities?: string[]
  type: "system"
}

/** Workflow states for governance issues. */
export enum IssueStatus {
  Open = "open",
  InProgress = "in-progress",
  Resolved = "resolved",
  Closed = "closed",
}

/** Workflow states for governance proposals. */
export enum ProposalStatus {
  Draft = "draft",
  Active = "active",
  Passed = "passed",
  Failed = "failed",
  Implemented = "implemented",
}

/** Vote options for governance motions and proposals. */
export enum VoteType {
  Yes = "yes",
  No = "no",
  Abstain = "abstain",
}

/** Governance issue record tracked within a group. */
export type Issue = {
  id: string
  title: string
  description: string
  creator: User
  createdAt: string
  status: IssueStatus
  votes: {
    up: number
    down: number
  }
  comments: number
  tags?: string[]
  groupId: string
}

/** Polling record for group decision-making and member signaling. */
export type Poll = {
  id: string
  question: string
  description?: string
  creator: User
  createdAt: string
  endDate: string
  options: {
    id: string
    text: string
    votes: number
  }[]
  totalVotes: number
  groupId: string
  userVoted?: string // ID of the option the user voted for
}

/** Governance proposal record with quorum/threshold voting configuration. */
export type Proposal = {
  id: string
  title: string
  description: string
  creator: User
  createdAt: string
  status: ProposalStatus
  votes: {
    yes: number
    no: number
    abstain: number
  }
  quorum: number // Minimum number of votes needed
  threshold: number // Percentage needed to pass (0-100)
  endDate: string
  comments: number
  tags?: string[]
  groupId: string
  userVote?: VoteType
}

/** Member stake and contribution metrics used for group profit-share calculations. */
export type MemberStake = {
  user: User
  profitShare: number // Percentage (0-100)
  contributionMetrics: {
    offersCreated: number
    offersAccepted: number
    thanksReceived: number
    thanksGiven: number
    proposalsCreated: number
    votesParticipated: number
  }
  joinedAt: string
  groupId: string
}

/** Transaction semantics for group marketplace exchanges. */
export enum TransactionType {
  Give = "give",
  Borrow = "borrow",
  Rent = "rent",
  Sale = "sale",
}

/** Basic resource inventory record for marketplace references. */
export interface Resource {
  id: string
  name: string
  description: string
  category: string
  ownerId: string
  createdAt: string
  tags?: string[]
  image?: string
}

/** Skill inventory record for marketplace references. */
export interface Skill {
  id: string
  name: string
  description: string
  category: string
  level: "beginner" | "intermediate" | "advanced" | "expert"
  ownerId: string
  createdAt: string
  tags?: string[]
}

/** Marketplace listing scoped specifically to a group context. */
export interface GroupMarketplaceListing {
  id: string
  title: string
  description: string
  transactionType: TransactionType
  price?: number // For rent or sale
  duration?: string // For borrow or rent
  resourceId?: string // Reference to a resource
  skillId?: string // Reference to a skill
  sellerId: string
  ownerKind?: "group" | "member"
  ownerLabel?: string
  ownerPath?: string
  groupId: string
  createdAt: string
  expiresAt?: string
  imageUrl?: string
  images?: string[]
  tags?: string[]
  status: "available" | "pending" | "completed"
}

/** Membership request and moderation record for group join workflows. */
export type JoinRequest = {
  id: string
  userId: string
  groupId: string
  status: "pending" | "approved" | "rejected"
  createdAt: string
  answers?: { questionId: string; answer: string }[]
  adminNotes?: string
  reviewedBy?: string
  reviewedAt?: string
}

/** Shared ring asset category taxonomy. */
export enum AssetCategory {
  Vehicle = "vehicle",
  Tool = "tool",
  Equipment = "equipment",
  Property = "property",
  Technology = "technology",
  Other = "other",
}

/** Utilization state for shared ring assets. */
export enum AssetStatus {
  Available = "available",
  InUse = "in_use",
  Maintenance = "maintenance",
  Reserved = "reserved",
}

/** Shared asset contributed to a ring's mutual asset pool. */
export type MutualAsset = {
  id: string
  name: string
  description: string
  category: AssetCategory
  ringId: string
  ownedBy: string // User ID of the person who contributed the asset
  addedAt: string
  status: AssetStatus
  currentUserId?: string // Who is currently using it
  currentUseStartDate?: string
  currentUseEndDate?: string
  images?: string[]
  tags?: string[]
  value?: number // Estimated value in dollars
  maintenanceNotes?: string
  location?: string // Where the asset is stored/located
  usageInstructions?: string
  restrictions?: string[] // Any usage restrictions
  bookingRequired?: boolean // Whether advance booking is required
}

/** Reservation and approval record for shared asset usage windows. */
export type AssetBooking = {
  id: string
  assetId: string
  userId: string
  startDate: string
  endDate: string
  status: "pending" | "approved" | "active" | "completed" | "cancelled"
  purpose?: string
  notes?: string
  createdAt: string
  approvedBy?: string
  approvedAt?: string
}

/** Root application state shape used by context/store providers. */
export type AppState = {
  user: User | null
  groups: Group[]
  events: Event[]
  posts: Post[]
  notifications: Record<string, unknown>[]
  settings: Record<string, unknown>
  selectedChapter: string

  likedPosts: string[]
  rsvpStatuses: Record<string, "none" | "going" | "interested">
  joinedGroups: string[]
  followedUsers: string[]
}

/** App context API contract for state mutations and helper actions. */
export type AppContextType = {
  state: AppState
  dispatch: (action: Record<string, unknown>) => void
  addGroup: (group: Group) => void
  removeGroup: (id: string) => void
  addEvent: (event: Event) => void
  removeEvent: (id: string) => void
  addPost: (post: Post) => void
  removePost: (id: string) => void
  setSelectedChapter: (chapterId: string) => void

  toggleLikePost: (postId: string) => void
  setRsvpStatus: (eventId: string, status: "none" | "going" | "interested") => void
  toggleJoinGroup: (groupId: string) => void
  toggleFollowUser: (userId: string) => void
}
