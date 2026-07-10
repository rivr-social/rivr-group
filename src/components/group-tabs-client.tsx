"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Plus,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import { CreatePost } from "@/components/create-post"
import { CreateOfferingModal } from "@/components/create-offering-modal"
import { GroupSubgroups } from "@/components/group-subgroups"
import { GroupAffiliates } from "@/components/group-affiliates"
import { PostFeed } from "@/components/post-feed"
import { PeopleFeed } from "@/components/people-feed"
import { resourceToPost, resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { GroupPlanCard } from "@/components/group-plan-card"
import { collectGalleryItems, type GallerySourcePost, type GallerySourceResource } from "@/lib/gallery"
import { createGovernanceProposalAction } from "@/app/actions/create-resources"
import type { GroupWorkPeriodItem } from "@/app/actions/calendar-work"
import { AboutDocumentsCard } from "@/components/about-documents-card"
import { AgentGraph } from "@/components/agent-graph"
import { FlowPassModal } from "@/components/flow-pass-modal"
import { GroupAccessDialog } from "@/components/group-access-dialog"
import type {
  NetAllocationClassOption,
  NetAllocationMemberOption,
} from "@/components/net-allocation-editor"
import type { NetAllocationRule } from "@/lib/net-allocation"
import type { Document } from "@/types/domain"
import type { User, MemberStake, Post, TabVisibilitySettings, TabVisibilityLevel, GroupTabKey } from "@/lib/types"
import { ProposalStatus, GROUP_TAB_KEYS, DEFAULT_TAB_VISIBILITY } from "@/lib/types"
import type { SerializedResource } from "@/lib/graph-serializers"
import { toStockInventory, type StockNeed } from "@/lib/stock"
import dynamic from "next/dynamic"

// Per-tab code splitting: each non-default tab panel loads as its own chunk
// on activation instead of shipping in the route's first-load chunk. Radix
// unmounts inactive tabs, so nothing below renders until selected. SSR stays
// enabled so deep-linked tabs still server-render.
const tabLoading = () => (
  <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
)
const GovernanceTab = dynamic(() => import("@/components/governance-tab").then((m) => m.GovernanceTab), { loading: tabLoading })
const StakeTab = dynamic(() => import("@/components/stake-tab").then((m) => m.StakeTab), { loading: tabLoading })
const TreasuryTab = dynamic(() => import("@/components/treasury-tab").then((m) => m.TreasuryTab), { loading: tabLoading })
const JobBoardTab = dynamic(() => import("@/components/job-board-tab").then((m) => m.JobBoardTab), { loading: tabLoading })
const BadgesTab = dynamic(() => import("@/components/badges-tab").then((m) => m.BadgesTab), { loading: tabLoading })
const PressTab = dynamic(() => import("@/components/press-tab").then((m) => m.PressTab), { loading: tabLoading })
const StockTab = dynamic(() => import("@/components/stock-tab").then((m) => m.StockTab), { loading: tabLoading })
const GroupCalendar = dynamic(() => import("@/components/group-calendar").then((m) => m.GroupCalendar), { loading: tabLoading })
const DocumentsTab = dynamic(() => import("@/components/documents-tab").then((m) => m.DocumentsTab), { loading: tabLoading })
const GroupAdminManager = dynamic(() => import("@/components/group-admin-manager").then((m) => m.GroupAdminManager), { loading: tabLoading })
const GroupRelationshipManager = dynamic(() => import("@/components/group-relationship-manager").then((m) => m.GroupRelationshipManager), { loading: tabLoading })
const EventFeed = dynamic(() => import("@/components/event-feed").then((m) => m.EventFeed), { loading: tabLoading })

interface ActivityEntry {
  id: string
  verb: string
  timestamp: string
  [key: string]: unknown
}

interface MembershipPlan {
  id: string
  name: string
  description?: string
  active: boolean
  isDefault: boolean
  amountMonthlyCents: number | null
  amountYearlyCents: number | null
  perks: string[]
}

interface ProjectJobTree {
  project: SerializedResource
  jobs: SerializedResource[]
  tasksByJob: Record<string, SerializedResource[]>
  projectLevelTasks: SerializedResource[]
}

/**
 * A contributor surfaced in the Stake tab because they completed one or more
 * jobs (recorded via `recordJobContributionAction`). This is the corrected J2
 * contribution model: completion records a Stake contribution rather than
 * awarding a badge.
 */
export interface RecordedContribution {
  contributorId: string
  contributorName: string
  contributorImage?: string | null
  jobCount: number
}

/**
 * Page tabs available to a "basic" group. Org groups get the full
 * {@link GROUP_TAB_KEYS} set. Derived against the canonical registry so the
 * trigger list and the visibility filter stay in lockstep.
 */
const BASIC_GROUP_PAGE_TABS: readonly GroupTabKey[] = [
  "about", "feed", "events", "groups", "members", "documents",
] as const

/**
 * Registry keys that are NOT rendered as top-level page tabs. `gallery` is
 * retained in the canonical {@link GROUP_TAB_KEYS} registry (so tab-visibility
 * settings keep working) but its media now lives inside Press → Media (D2), so
 * it is excluded from the page-tab strip.
 */
const NON_PAGE_TAB_KEYS: ReadonlySet<GroupTabKey> = new Set<GroupTabKey>(["gallery"])

/**
 * Short, tab-strip labels for each page tab. These intentionally differ from
 * the full {@link GROUP_TAB_LABELS} (e.g. "Docs"/"Mart") to fit the horizontal
 * strip; keyed by the same canonical {@link GroupTabKey} so the strip is
 * rendered from the registry rather than a hardcoded JSX list.
 */
const GROUP_TAB_TRIGGER_LABELS: Record<GroupTabKey, string> = {
  about: "About",
  feed: "Feed",
  events: "Events",
  groups: "Groups",
  members: "Members",
  documents: "Docs",
  jobs: "Jobs",
  marketplace: "Mart",
  governance: "Governance",
  badges: "Badges",
  stake: "Stake",
  press: "Press",
  treasury: "Treasury",
  gallery: "Gallery",
  stock: "Stock",
}

export interface GroupTabsClientProps {
  groupId: string
  groupName: string
  groupDescription: string | null
  groupType: string
  groupLocation: string
  groupTags: string[]
  groupContact: Record<string, unknown>
  groupAdmins: Array<{ id: string; name: string }>
  groupCreatorName: string | null
  isGroupAdmin: boolean
  currentUserId: string | null
  membershipPlans: MembershipPlan[]
  /** The viewer's currently active group-subscription plan id, if any (B2). */
  activeSubscriptionPlanId?: string | null
  members: Array<{ id: string; name: string; username?: string; image?: string | null }>
  /**
   * Owner agents for posts/events/listings whose authors are NOT in the
   * member roster (marketplace-offer owners, federated authors, former or
   * not-yet-rostered members). Resolving against this in addition to
   * `members` prevents the "Unknown User" / /profile/unknown fallback. Optional:
   * when omitted the component degrades to member-only author resolution.
   */
  authors?: Array<{ id: string; name: string; username?: string; image?: string | null }>
  groupPostResources: SerializedResource[]
  eventResources: SerializedResource[]
  /**
   * Server-resolved event start/end ISO timestamps keyed by event id. Computed
   * via the canonical event-window contract (lib/calendar/event-window) on the
   * server so the card/calendar window matches the event-detail page exactly.
   * Composition is runtime-local wall-clock (server = UTC); display surfaces
   * render these back in UTC. Falls back to raw metadata when an id is absent.
   */
  eventWindows?: Record<string, { start: string; end: string }>
  domainGroups: Array<{ id: string; name: string; description: string | null }>
  affiliatedGroups: unknown[]
  projectJobTrees: ProjectJobTree[]
  unassignedJobs: SerializedResource[]
  unassignedTasks: SerializedResource[]
  listingResources: SerializedResource[]
  governanceItems: unknown[]
  badgeResources: SerializedResource[]
  stakeActivity: ActivityEntry[]
  serverMemberStakes?: MemberStake[]
  serverTotalStakes?: number
  /**
   * Recorded job-contribution stakeholders (EPIC J / J2 contribution model).
   * Each entry is a contributor who completed one or more jobs, surfaced in the
   * Stake tab so contributors appear as recognized stakeholders. Optional: when
   * omitted the Stake tab renders without a contributions section.
   */
  recordedContributions?: RecordedContribution[]
  /**
   * Saved org net-allocation rules (`metadata.netAllocation.rules`). Fed into the
   * admin-only Stake-tree editor under the Stake tab. Optional: when omitted the
   * editor starts empty.
   */
  netAllocationRules?: NetAllocationRule[]
  /** Membership classes available as allocation targets in the Stake-tree editor. */
  netAllocationClasses?: NetAllocationClassOption[]
  /** Individual members available as allocation targets in the Stake-tree editor. */
  netAllocationMembers?: NetAllocationMemberOption[]
  pressResources: SerializedResource[]
  /** Tangible-stock resources (type resource/asset) for the Stock → Inventory subtab. */
  stockResources: SerializedResource[]
  /** Persisted Needs shopping list for the Stock → Needs subtab. */
  stockNeeds: StockNeed[]
  /** Whether the viewer may edit stock needs (admin or group content-write). */
  stockCanManage: boolean
  documentResources: Document[]
  projectResources: SerializedResource[]
  jobResources: SerializedResource[]
  /** Admin-only completed work sessions for the calendar (server-gated: []
   *  for non-admin viewers). */
  groupWorkPeriods?: GroupWorkPeriodItem[]
  treasuryActivity: ActivityEntry[]
  publishActivity: ActivityEntry[]
  resourceCount: number
  passwordRequired?: boolean
  tabVisibility?: TabVisibilitySettings
}

export function GroupTabsClient({
  groupId,
  groupName,
  groupDescription,
  groupType,
  groupLocation,
  groupTags,
  groupContact,
  groupAdmins,
  groupCreatorName,
  isGroupAdmin,
  currentUserId,
  membershipPlans,
  activeSubscriptionPlanId = null,
  members,
  authors = [],
  groupPostResources,
  eventResources,
  eventWindows = {},
  domainGroups,
  affiliatedGroups,
  projectJobTrees,
  unassignedJobs,
  unassignedTasks,
  listingResources,
  governanceItems,
  badgeResources,
  stakeActivity,
  serverMemberStakes,
  serverTotalStakes,
  recordedContributions = [],
  netAllocationRules = [],
  netAllocationClasses = [],
  netAllocationMembers = [],
  pressResources,
  stockResources,
  stockNeeds,
  stockCanManage,
  documentResources,
  projectResources,
  jobResources,
  groupWorkPeriods = [],
  treasuryActivity,
  publishActivity,
  resourceCount,
  passwordRequired,
  tabVisibility,
}: GroupTabsClientProps) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const isBasicGroup = groupType === "basic"
  const isGroupMember = useMemo(
    () => !!currentUserId && members.some((m) => m.id === currentUserId),
    [currentUserId, members],
  )
  const visibleTabs = useMemo(() => {
    // Derive the candidate page tabs from the canonical registry: basic groups
    // get the basic subset, org groups get every page tab.
    const allTabs: readonly GroupTabKey[] = isBasicGroup
      ? BASIC_GROUP_PAGE_TABS
      : GROUP_TAB_KEYS

    return allTabs.filter((tab) => {
      if (NON_PAGE_TAB_KEYS.has(tab)) return false
      const level: TabVisibilityLevel = tabVisibility?.[tab] ?? DEFAULT_TAB_VISIBILITY[tab]
      if (level === "hidden") return false
      if (level === "admin") return isGroupAdmin
      if (level === "members") return isGroupMember || isGroupAdmin
      return true
    })
  }, [isBasicGroup, tabVisibility, isGroupAdmin, isGroupMember])
  const requestedTab = searchParams.get("tab")

  const [offeringModalOpen, setOfferingModalOpen] = useState(false)
  const [flowPassOpen, setFlowPassOpen] = useState(false)
  const [accessDialogOpen, setAccessDialogOpen] = useState(
    () => !!passwordRequired && !isGroupMember
  )
  const [activeTab, setActiveTab] = useState(() => (
    requestedTab && visibleTabs.includes(requestedTab as GroupTabKey) ? requestedTab : "about"
  ))

  useEffect(() => {
    if (!requestedTab || !visibleTabs.includes(requestedTab as GroupTabKey)) {
      setActiveTab("about")
      return
    }
    setActiveTab(requestedTab)
  }, [requestedTab, visibleTabs])

  const handleOfferingCreated = () => {
    setOfferingModalOpen(false)
    toast({ title: "Listing created" })
    router.refresh()
  }

  // ── Data conversions for rich components ──

  const posts = useMemo(
    () => groupPostResources.map((r) => resourceToPost(r) as Post),
    [groupPostResources]
  )

  // Group media gallery: drawn from the group's posts plus its image/video and
  // listing/offering resources (same source model as the user profile gallery).
  const galleryItems = useMemo(() => {
    const galleryPosts: GallerySourcePost[] = posts.map((post) => ({
      id: post.id,
      content: post.content,
      images: Array.isArray(post.images) ? post.images : [],
      createdAt: post.createdAt,
      timestamp: post.timestamp,
    }))
    const toSource = (r: SerializedResource): GallerySourceResource => ({
      id: r.id,
      name: r.name,
      type: r.type,
      url: r.url,
      createdAt: r.createdAt,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    })
    const galleryResources: GallerySourceResource[] = [
      ...groupPostResources.map(toSource),
      ...listingResources.map(toSource),
      ...eventResources.map(toSource),
    ]
    return collectGalleryItems({ posts: galleryPosts, resources: galleryResources })
  }, [posts, groupPostResources, listingResources, eventResources])

  const eventItems = useMemo(
    () =>
      eventResources.map((r) => {
        const meta = r.metadata ?? {}
        // Prefer the server-resolved canonical window (matches the event-detail
        // page); fall back to raw metadata only when no window was provided.
        const win = eventWindows[r.id]
        return {
          id: r.id,
          name: r.name,
          description: r.description || "",
          location: {
            name: String(meta.location ?? ""),
            address: String(meta.location ?? ""),
          },
          timeframe: {
            start: win?.start ?? String(meta.date ?? meta.startDate ?? r.createdAt),
            end: win?.end ?? String(meta.endDate ?? meta.date ?? r.createdAt),
          },
          image: String(meta.image ?? "/placeholder.svg"),
          price: typeof meta.price === "number" ? meta.price : 0,
          chapterTags: (meta.chapterTags as string[]) ?? [],
          organizer: r.ownerId,
          creator: r.ownerId,
        }
      }),
    [eventResources, eventWindows]
  )

  const peopleUsers: User[] = useMemo(
    () =>
      members.map((m) => ({
        id: m.id,
        name: m.name,
        username: m.username || m.id,
        avatar: m.image || "/placeholder-user.jpg",
        followers: 0,
        following: 0,
      })),
    [members]
  )

  const memberStakes: MemberStake[] = useMemo(
    () => {
      if (serverMemberStakes && serverMemberStakes.length > 0) {
        return serverMemberStakes
      }

      return members.map((m) => ({
        user: {
          id: m.id,
          name: m.name,
          username: m.username || m.id,
          avatar: m.image || "/placeholder-user.jpg",
          followers: 0,
          following: 0,
        },
        profitShare: members.length > 0 ? Math.round((100 / members.length) * 100) / 100 : 0,
        pointsEarned: 0,
        contributionMetrics: {
          offersCreated: 0,
          offersAccepted: 0,
          thanksReceived: 0,
          thanksGiven: 0,
          proposalsCreated: 0,
          votesParticipated: 0,
        },
        joinedAt: new Date().toISOString(),
        groupId,
      }))
    },
    [members, groupId, serverMemberStakes]
  )

  const governanceProposals = useMemo(() => {
    return governanceItems
      .filter((item) => {
        const rec = item as Record<string, unknown>
        return rec.type === "proposal" || rec.title != null
      })
      .map((item) => {
        const rec = item as Record<string, unknown>
        return {
          id: String(rec.id ?? ""),
          title: String(rec.title ?? rec.question ?? "Untitled"),
          description: String(rec.description ?? ""),
          status: (ProposalStatus[(String(rec.status ?? "Active").charAt(0).toUpperCase() + String(rec.status ?? "Active").slice(1)) as keyof typeof ProposalStatus] ?? ProposalStatus.Active),
          votes: (() => {
            // createGovernanceProposalAction stores a nested `votes: {yes,no,abstain}`;
            // older/other shapes use flat votesFor/votesYes. Read both.
            const nested = (rec.votes && typeof rec.votes === "object" ? rec.votes : {}) as Record<string, unknown>
            return {
              yes: Number(rec.votesFor ?? rec.votesYes ?? nested.yes ?? 0),
              no: Number(rec.votesAgainst ?? rec.votesNo ?? nested.no ?? 0),
              abstain: Number(rec.votesAbstain ?? nested.abstain ?? 0),
            }
          })(),
          quorum: Number(rec.quorum ?? 0),
          threshold: Number(rec.threshold ?? 50),
          endDate: String(rec.deadline ?? rec.endDate ?? ""),
          creator: { id: "", name: String(rec.creatorName ?? "Unknown"), username: "unknown", avatar: "", followers: 0, following: 0 } as User,
          createdAt: String(rec.createdAt ?? ""),
          comments: Number(rec.comments ?? 0),
          groupId,
        }
      })
  }, [governanceItems, groupId])

  const governancePolls = useMemo(() => {
    return governanceItems
      .filter((item) => {
        const rec = item as Record<string, unknown>
        return rec.type === "poll"
      })
      .map((item) => {
        const rec = item as Record<string, unknown>
        const rawOptions = Array.isArray(rec.options) ? (rec.options as Record<string, unknown>[]) : []
        return {
          id: String(rec.id ?? ""),
          question: String(rec.question ?? rec.title ?? ""),
          options: rawOptions.map((o, idx) => ({
            id: String(o.id ?? `opt-${idx}`),
            text: String(o.label ?? o.text ?? ""),
            votes: Number(o.votes ?? 0),
          })),
          totalVotes: Number(rec.totalVotes ?? 0),
          creator: { id: "", name: String(rec.creatorName ?? "Unknown"), username: "unknown", avatar: "", followers: 0, following: 0 } as User,
          createdAt: String(rec.createdAt ?? ""),
          endDate: String(rec.deadline ?? rec.endDate ?? ""),
          groupId,
        }
      })
  }, [governanceItems, groupId])

  const governanceIssues = useMemo(() => {
    return governanceItems
      .filter((item) => {
        const rec = item as Record<string, unknown>
        return rec.type === "issue"
      })
      .map((item) => {
        const rec = item as Record<string, unknown>
        return {
          id: String(rec.id ?? ""),
          title: String(rec.title ?? ""),
          description: String(rec.description ?? ""),
          status: String(rec.status ?? "open"),
          creator: { name: String(rec.creatorName ?? "Unknown") },
          createdAt: String(rec.createdAt ?? ""),
          tags: Array.isArray(rec.tags) ? (rec.tags as string[]) : [],
          votes: { up: Number(rec.votesUp ?? 0), down: Number(rec.votesDown ?? 0) },
          comments: Number(rec.comments ?? 0),
        }
      })
  }, [governanceItems])

  const memberInfos = useMemo(
    () =>
      members.map((m) => ({
        id: m.id,
        name: m.name,
        username: m.username || m.id,
        avatar: m.image || "/placeholder-user.jpg",
      })),
    [members]
  )

  // Resolve display identities against members first, then the hydrated
  // author agents (post/event/listing owners who aren't in the roster).
  // This is the lookup that keeps non-member authors from rendering as
  // "Unknown User" while still preferring roster data when both exist.
  const membersById = useMemo(() => {
    const map = new Map<string, { id: string; name: string; username?: string; image?: string | null }>()
    for (const a of authors) map.set(a.id, a)
    for (const m of members) map.set(m.id, m)
    return map
  }, [members, authors])

  const getUser = (userId: string): User => {
    const m = membersById.get(userId)
    if (m) {
      return {
        id: m.id,
        name: m.name,
        username: m.username || m.id,
        avatar: m.image || "/placeholder-user.jpg",
        followers: 0,
        following: 0,
      }
    }
    // Last resort only when the owner id could not be hydrated to an agent.
    // Keep the real id as the username so the profile link still resolves to a
    // real record instead of the dead /profile/unknown route.
    return {
      id: userId,
      name: "Unknown User",
      username: userId || "unknown",
      avatar: "/placeholder-user.jpg",
      followers: 0,
      following: 0,
    }
  }

  const handleSharePost = async (postId: string) => {
    const shareUrl = `${window.location.origin}/posts/${postId}`
    if (navigator.share) {
      await navigator.share({ title: "Post", url: shareUrl })
      return
    }
    await navigator.clipboard.writeText(shareUrl)
    toast({ title: "Link copied", description: "Post URL copied to clipboard." })
  }

  const handleTabChange = (nextTab: string) => {
    setActiveTab(nextTab)

    const params = new URLSearchParams(searchParams.toString())
    if (nextTab === "about") {
      params.delete("tab")
    } else {
      params.set("tab", nextTab)
    }

    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      <div className="overflow-x-auto -mx-4 px-4 scrollbar-hide">
        <TabsList className="inline-flex w-max min-w-full gap-1">
          {visibleTabs.map((tab) => (
            <TabsTrigger key={tab} value={tab} className="shrink-0">
              {GROUP_TAB_TRIGGER_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {/* ── About ── */}
      <TabsContent value="about" className="space-y-4 mt-4">
        <GroupCalendar
          eventResources={eventResources}
          projectResources={projectResources}
          jobResources={jobResources}
          groupName={groupName}
          eventWindows={eventWindows}
          workPeriods={groupWorkPeriods}
          memberNames={Object.fromEntries(groupWorkPeriods.map((p) => [p.workerId, p.workerName]))}
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Group Overview</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>{groupDescription || "No description yet."}</p>
              {groupTags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {groupTags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Group Stats</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Members: {members.length}</p>
              <p>Posts: {groupPostResources.length}</p>
              <p>Events: {eventResources.length}</p>
              <p>Resources: {resourceCount}</p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Leadership</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {groupCreatorName ? (
                <p><span className="font-medium">Founder:</span> {groupCreatorName}</p>
              ) : (
                <p className="text-muted-foreground">Founder not specified.</p>
              )}
              {groupAdmins.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {groupAdmins.map((admin) => <Badge key={admin.id} variant="outline">{admin.name}</Badge>)}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm text-muted-foreground">
              {typeof groupContact.website === "string" && <p>Website: {groupContact.website}</p>}
              {typeof groupContact.email === "string" && <p>Email: {groupContact.email}</p>}
              {typeof groupContact.phone === "string" && <p>Phone: {groupContact.phone}</p>}
              {Object.keys(groupContact).length === 0 && <p>No contact info set.</p>}
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader><CardTitle>Membership Subscriptions</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {membershipPlans.length === 0 && (
                <p className="text-sm text-muted-foreground">No membership plans configured yet.</p>
              )}
              {membershipPlans.map((plan) => (
                <GroupPlanCard
                  key={plan.id}
                  groupId={groupId}
                  plan={plan}
                  currentUserId={currentUserId}
                  isSubscribed={activeSubscriptionPlanId === plan.id}
                />
              ))}
              {isGroupAdmin && (
                <Link href={`/groups/${groupId}/settings?tab=memberships`} className="inline-flex text-sm text-primary hover:underline">
                  Manage membership plans
                </Link>
              )}
            </CardContent>
          </Card>
        </div>

        <AboutDocumentsCard
          documents={documentResources}
          docsPath={`/groups/${groupId}/docs`}
          emptyLabel="Open the documents page to create one and turn on Show on About page."
        />

        <Card>
          <CardHeader><CardTitle>Relationships</CardTitle></CardHeader>
          <CardContent>
            <AgentGraph agentId={groupId} agentName={groupName} agentType={groupType} />
          </CardContent>
        </Card>

        {isGroupAdmin && (
          <GroupRelationshipManager
            groupId={groupId}
            isCreator={isGroupAdmin}
            isAdmin={isGroupAdmin}
          />
        )}
      </TabsContent>

      {/* ── Feed ── */}
      <TabsContent value="feed" className="space-y-3 mt-4">
        {isGroupMember && <CreatePost groupId={groupId} onPostCreated={() => router.refresh()} />}
        <PostFeed
          posts={posts}
          listings={listingResources.map((r) => resourceToMarketplaceListing(r))}
          getUser={getUser}
          onShare={(postId) => void handleSharePost(postId)}
        />
      </TabsContent>

      {/* ── Events ── */}
      <TabsContent value="events" className="space-y-3 mt-4">
        {isGroupAdmin && (
          <div className="flex justify-end mb-2">
            <Link href={`/create?tab=event&group=${groupId}`}>
              <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-2" />Create Event</Button>
            </Link>
          </div>
        )}
        <EventFeed
          events={eventItems}
          getGroupName={() => groupName}
          getGroupId={() => groupId}
          getCreatorName={(creatorId) => {
            const m = membersById.get(creatorId)
            return m?.name || "Unknown"
          }}
          getCreatorUsername={(creatorId) => {
            const m = membersById.get(creatorId)
            return m?.username || creatorId
          }}
        />
      </TabsContent>

      {/* ── Groups ── */}
      <TabsContent value="groups" className="space-y-4 mt-4">
        <GroupSubgroups
          parentGroupId={groupId}
          isCreator={isGroupAdmin ?? false}
          isAdmin={isGroupAdmin ?? false}
        />
        <GroupAffiliates groupId={groupId} />
      </TabsContent>

      {/* ── Members ── */}
      <TabsContent value="members" className="space-y-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-muted-foreground">{members.length} member{members.length !== 1 ? "s" : ""}</p>
        </div>
        <PeopleFeed people={peopleUsers} />
        {isGroupAdmin && (
          <GroupAdminManager
            groupId={groupId}
            members={members.map((m) => m.id)}
            admins={groupAdmins.map((a) => a.id)}
            creator={groupAdmins[0]?.id ?? ""}
            onAdminChange={(_updatedAdmins) => router.refresh()}
            allUsers={members.map((m) => ({
              id: m.id,
              name: m.name,
              username: m.username || m.id,
              avatar: m.image || "/placeholder-user.jpg",
            }))}
          />
        )}
      </TabsContent>

      {/* ── Documents ── */}
      <TabsContent value="documents" className="mt-4">
        <DocumentsTab
          groupId={groupId}
          documents={documentResources}
          docsPath={`/groups/${groupId}/docs`}
        />
      </TabsContent>

      {/* ── Jobs ── */}
      <TabsContent value="jobs" className="space-y-3 mt-4">
        {isGroupAdmin && (
          <div className="flex justify-end mb-2">
            <Link href={`/create?tab=job&group=${groupId}`}>
              <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-2" />Post Job</Button>
            </Link>
          </div>
        )}
        <JobBoardTab groupId={groupId} currentUserId={currentUserId ?? undefined} />
      </TabsContent>

      {/* ── Marketplace ── */}
      <TabsContent value="marketplace" className="space-y-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">Total listings: {listingResources.length}</p>
            {isGroupMember && (
              <Button size="sm" variant="ghost" onClick={() => setFlowPassOpen(true)}>
                Flow Pass
              </Button>
            )}
          </div>
          {isGroupMember && (
            <Button size="sm" variant="outline" onClick={() => setOfferingModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />Add Listing
            </Button>
          )}
        </div>
        <FlowPassModal
          open={flowPassOpen}
          onClose={() => setFlowPassOpen(false)}
          groupName={groupName}
          isBasicMember={isGroupMember}
        />
        <CreateOfferingModal
          open={offeringModalOpen}
          onClose={() => setOfferingModalOpen(false)}
          onCreated={handleOfferingCreated}
          title={`Create Offering for ${groupName}`}
          description="Create a product, service, voucher, or other offering and optionally share it to this group's feeds."
          initialValues={{
            ownerId: groupId,
            targetAgents: [{ id: groupId, name: groupName, type: groupType }],
            scopedGroupIds: [groupId],
            postToFeed: true,
          }}
        />
        {listingResources.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">No listings in this group yet. Add the first one!</p>
          </div>
        ) : (
          listingResources.map((listing) => {
            const meta = listing.metadata ?? {}
            const seller = membersById.get(listing.ownerId)
            const isGroupOwnedListing = listing.ownerId === groupId
            const ownerLabel = isGroupOwnedListing
              ? `${groupName} · Group offer`
              : seller
                ? `${seller.name} · Member offer`
                : "Member offer"
            return (
              <Card key={listing.id}>
                <CardContent className="py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{listing.name}</p>
                    {typeof meta.listingType === "string" && (
                      <Badge variant="outline">{meta.listingType}</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{listing.description || "No description"}</p>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">By {ownerLabel}</p>
                    <Badge variant={isGroupOwnedListing ? "default" : "secondary"}>
                      {isGroupOwnedListing ? "Group" : "Member"}
                    </Badge>
                  </div>
                  {typeof meta.price === "number" && (
                    <p className="text-sm font-medium">${meta.price}</p>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </TabsContent>

      {/* ── Governance ── */}
      <TabsContent value="governance" className="mt-4">
        <GovernanceTab
          groupId={groupId}
          issues={governanceIssues}
          polls={governancePolls}
          proposals={governanceProposals}
        />
      </TabsContent>

      {/* ── Badges ── */}
      <TabsContent value="badges" className="mt-4">
        <BadgesTab
          groupId={groupId}
          currentUserId={currentUserId ?? ""}
          isAdmin={isGroupAdmin}
          members={memberInfos}
        />
      </TabsContent>

      {/* ── Stake ── */}
      <TabsContent value="stake" className="mt-4">
        <StakeTab
          groupId={groupId}
          memberStakes={memberStakes}
          totalStakes={serverTotalStakes && serverTotalStakes > 0 ? serverTotalStakes : 100}
          recordedContributions={recordedContributions}
          isGroupAdmin={isGroupAdmin}
          netAllocationRules={netAllocationRules}
          netAllocationClasses={netAllocationClasses}
          netAllocationMembers={netAllocationMembers}
        />
      </TabsContent>

      {/* ── Press ── */}
      <TabsContent value="press" className="mt-4">
        <PressTab groupId={groupId} isGroupAdmin={isGroupAdmin} pressResources={pressResources} galleryItems={galleryItems} />
      </TabsContent>

      {/* ── Stock ── */}
      <TabsContent value="stock" className="mt-4">
        <StockTab
          parentType="org"
          parentId={groupId}
          inventory={toStockInventory(stockResources)}
          initialNeeds={stockNeeds}
          canManage={stockCanManage}
        />
      </TabsContent>

      {/* ── Treasury ── */}
      <TabsContent value="treasury" className="mt-4">
        <TreasuryTab groupId={groupId} canManageStripe={isGroupAdmin} />
      </TabsContent>

      {/* Password-protected group access dialog for non-members */}
      <GroupAccessDialog
        groupId={groupId}
        groupName={groupName}
        open={accessDialogOpen}
        onOpenChange={setAccessDialogOpen}
        onAccessGranted={() => {
          setAccessDialogOpen(false)
          router.refresh()
        }}
      />
    </Tabs>
  )
}
