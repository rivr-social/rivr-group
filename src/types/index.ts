export type User = {
  id: string
  name: string
  username: string
  email?: string
  bio?: string
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
}



export type Basin = {
  id: string
  name: string
  huc6Code: string
  description?: string
  image?: string
}

export type Post = {
  id: string
  content: string
  author: User
  createdAt: string
  likes: number
  comments: number
  isLiked?: boolean
  images?: string[]
  tags?: string[]
  groupTags?: string[]

  postType?: PostType
  isLiveInvitation?: boolean

  // Offering-specific fields
  title?: string
  description?: string
  offeringType?: OfferingType
  basePrice?: number
  currency?: string
  isActive?: boolean
  timeValue?: number
  skillValue?: number
  difficultyValue?: number
  resourceValue?: number
  thanksValue?: number
}

export type Event = {
  id: string
  name: string
  title?: string
  description: string
  date?: string
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

}

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

export enum PostType {
  Social = "social",
  Offer = "offer",
  Request = "request",
  Gratitude = "gratitude"
}

export enum OfferingType {
  Skill = "skill",
  Resource = "resource",
  Product = "product",
  Service = "service",
  Trip = "trip",
  Ticket = "ticket",
  Voucher = "voucher",
  Data = "data",
  Gift = "gift",
  Bounty = "bounty"
}

export type Offering = {
  id: string
  title: string
  description: string
  type: OfferingType
  basePrice?: number
  currency?: string
  createdBy: string
  createdAt: string
  tags?: string[]
  isActive: boolean
  // Voucher specific fields
  timeValue?: number
  skillValue?: number
  difficultyValue?: number
  resourceValue?: number
  thanksValue?: number
}

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
  currency?: string
  acceptedCurrencies?: string[]
  quantityAvailable?: number
  quantityRemaining?: number
  cardCheckoutAvailable?: boolean
  cardCheckoutUnavailableReason?: string
  // Venue-specific fields (when listing is a venue)
  isVenue?: boolean
  venue?: Venue
  // Service-specific fields
  serviceDetails?: {
    availability: string[]
    duration: string
    bookingDates: { date: string; timeSlots: string[] }[]
  }
}

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

export enum JoinType {
  Public = "public", // Anyone can join
  ApprovalRequired = "approval_required", // Requires admin approval
  InviteOnly = "invite_only", // By invite link only
  InviteAndApply = "invite_and_apply", // Invite and application required
}

export enum NotificationType {
  Native = "native",
  Email = "email",
  Text = "text",
}

export type JoinQuestion = {
  id: string
  question: string
  required: boolean
  type: "text" | "multipleChoice" | "checkbox"
  options?: string[] // For multiple choice questions
}

export type GroupDiscoveryMode = "public" | "hidden"

export type GroupJoinSettings = {
  joinType: JoinType
  visibility?: GroupDiscoveryMode
  questions?: JoinQuestion[]
  approvalRequired?: boolean
  passwordRequired?: boolean
  inviteLink?: string
  applicationInstructions?: string
}

export type GroupNotificationSettings = {
  posts: NotificationType[]
  events: NotificationType[]
  marketplace: NotificationType[]
  governance: NotificationType[]
  memberUpdates: NotificationType[]
}

export type UserGroupSettings = {
  userId: string
  groupId: string
  notificationSettings: GroupNotificationSettings
  role?: "member" | "admin" | "creator"
  joinedAt: string
}

export enum GroupType {
  Group = "group",
  Ring = "ring",
  Family = "family",
  Basic = "basic",
  Organization = "organization",
}

// Flow Pass types for automatic discounts in organizations
export enum FlowPassType {
  Percentage = "percentage",
  Fixed = "fixed",
  FreeFlow = "free_flow", // For free access to services
}

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

// Treasury-related types
export enum TreasuryTransactionType {
  Deposit = "deposit",
  Withdrawal = "withdrawal",
  Transfer = "transfer",
  Fee = "fee",
}

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

export type MemberResourceRatio = {
  userId: string
  ringId: string
  totalDeposited: number
  totalWithdrawn: number
  resourceRatio: number // Calculated as totalDeposited / totalWithdrawn (minimum 0.1)
  maxWithdrawalLimit: number // Based on ratio and treasury balance
  lastUpdated: string
}

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

// Joint Venture types
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

export type VentureTransaction = {
  id: string
  ventureId: string
  type: "revenue" | "expense" | "profit_distribution" | "investment"
  amount: number
  description: string
  date: string
  ringRecipient?: string // Which ring received profit distribution
}

// Voucher Pool types
export enum VoucherCategory {
  Service = "service",
  Goods = "goods",
  Skill = "skill",
  Experience = "experience",
  Resource = "resource",
}

export enum VoucherStatus {
  Available = "available",
  Claimed = "claimed",
  Completed = "completed",
  Expired = "expired",
}

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
  type?: GroupType // Make this optional for backward compatibility
  avatar?: string
  // Organization-specific fields
  boardMembers?: { id: string; name: string; role: string; avatar: string }[]
  subgroups?: { id: string; name: string; description: string; membershipClass: string }[]
  offerings?: { id: string; name: string; description: string; type: string }[]
  flowPasses?: FlowPass[] // Flow passes for automatic discounts
  membershipTiers?: string[] // Available membership tiers
}

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

// New types for governance features
export enum IssueStatus {
  Open = "open",
  InProgress = "in-progress",
  Resolved = "resolved",
  Closed = "closed",
}

export enum ProposalStatus {
  Draft = "draft",
  Active = "active",
  Passed = "passed",
  Failed = "failed",
  Implemented = "implemented",
}

export enum VoteType {
  Yes = "yes",
  No = "no",
  Abstain = "abstain",
}

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

// New types for stake features
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

// Add these new types to the existing types.ts file

export enum TransactionType {
  Give = "give",
  Borrow = "borrow",
  Rent = "rent",
  Sale = "sale",
}

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

// Mutual Assets types for Rings
export enum AssetCategory {
  Vehicle = "vehicle",
  Tool = "tool",
  Equipment = "equipment",
  Property = "property",
  Technology = "technology",
  Other = "other",
}

export enum AssetStatus {
  Available = "available",
  InUse = "in_use",
  Maintenance = "maintenance",
  Reserved = "reserved",
}

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

// Wallet types (frontend-facing)
export interface WalletBalance {
  walletId: string
  ownerId: string
  ownerName: string
  type: "personal" | "group"
  balanceCents: number
  balanceDollars: number
  currency: string
  ethAddress?: string
  isFrozen: boolean
  /** Stripe Connect available balance in cents (from seller account). */
  connectAvailableCents?: number
  /** Stripe Connect pending balance in cents (from seller account). */
  connectPendingCents?: number
  /** Whether this agent has an active Stripe Connect account with charges enabled. */
  hasConnectAccount?: boolean
  /** Portion of the capital account cleared for external payout. */
  payoutEligibleCents?: number
  /** Portion of the capital account blocked pending Stripe settlement. */
  pendingSettlementCents?: number
  /** Test-mode Stripe sales that can be moved into the Rivr wallet for local simulation. */
  testReleasableCents?: number
  thanksTokenCount?: number
  thanksTokensBurned?: number
  thanksTransferred?: number
  thanksReceived?: number
  thanksFlowRatio?: number | null
}

export interface WalletTransactionView {
  id: string
  type: string
  amountCents: number
  amountDollars: number
  feeCents: number
  description: string | null
  fromWalletOwnerName?: string
  toWalletOwnerName?: string
  status: string
  createdAt: string
  ethTxHash?: string
  stripePaymentIntentId?: string
}

// App Context Types
export type AppState = {
  user: User | null
  groups: Group[]
  events: Event[]
  posts: Post[]
  notifications: Record<string, unknown>[]
  settings: Record<string, unknown>

  likedPosts: string[]
  rsvpStatuses: Record<string, "none" | "going" | "interested">
  joinedGroups: string[]
  followedUsers: string[]
}

export type AppContextType = {
  state: AppState
  dispatch: (action: Record<string, unknown>) => void
  addGroup: (group: Group) => void
  removeGroup: (id: string) => void
  addEvent: (event: Event) => void
  removeEvent: (id: string) => void
  addPost: (post: Post) => void
  removePost: (id: string) => void

  toggleLikePost: (postId: string) => void
  setRsvpStatus: (eventId: string, status: "none" | "going" | "interested") => void
  toggleJoinGroup: (groupId: string) => void
  toggleFollowUser: (userId: string) => void
}
