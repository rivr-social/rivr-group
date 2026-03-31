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
import { GovernanceTab } from "@/components/governance-tab"
import { StakeTab } from "@/components/stake-tab"
import { TreasuryTab } from "@/components/treasury-tab"
import { JobBoardTab } from "@/components/job-board-tab"
import { BadgesTab } from "@/components/badges-tab"
import { PressTab } from "@/components/press-tab"
import { PostFeed } from "@/components/post-feed"
import { EventFeed } from "@/components/event-feed"
import { PeopleFeed } from "@/components/people-feed"
import { GroupCalendar } from "@/components/group-calendar"
import { resourceToPost, resourceToMarketplaceListing } from "@/lib/graph-adapters"
import { createGovernanceProposalAction } from "@/app/actions/create-resources"
import { AboutDocumentsCard } from "@/components/about-documents-card"
import { AgentGraph } from "@/components/agent-graph"
import { DocumentsTab } from "@/components/documents-tab"
import { GroupAdminManager } from "@/components/group-admin-manager"
import { GroupRelationshipManager } from "@/components/group-relationship-manager"
import { FlowPassModal } from "@/components/flow-pass-modal"
import { GroupAccessDialog } from "@/components/group-access-dialog"
import type { Document } from "@/types/domain"
import type { User, MemberStake, Post } from "@/lib/types"
import { ProposalStatus } from "@/lib/types"
import type { SerializedResource } from "@/lib/graph-serializers"

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
  members: Array<{ id: string; name: string; username?: string; image?: string | null }>
  groupPostResources: SerializedResource[]
  eventResources: SerializedResource[]
  domainGroups: Array<{ id: string; name: string; description: string | null }>
  affiliatedGroups: unknown[]
  projectJobTrees: ProjectJobTree[]
  unassignedJobs: SerializedResource[]
  unassignedTasks: SerializedResource[]
  listingResources: SerializedResource[]
  governanceItems: unknown[]
  badgeResources: SerializedResource[]
  stakeActivity: ActivityEntry[]
  pressResources: SerializedResource[]
  documentResources: Document[]
  projectResources: SerializedResource[]
  jobResources: SerializedResource[]
  treasuryActivity: ActivityEntry[]
  publishActivity: ActivityEntry[]
  resourceCount: number
  passwordRequired?: boolean
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
  members,
  groupPostResources,
  eventResources,
  domainGroups,
  affiliatedGroups,
  projectJobTrees,
  unassignedJobs,
  unassignedTasks,
  listingResources,
  governanceItems,
  badgeResources,
  stakeActivity,
  pressResources,
  documentResources,
  projectResources,
  jobResources,
  treasuryActivity,
  publishActivity,
  resourceCount,
  passwordRequired,
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
  const visibleTabs = useMemo(
    () => (
      isBasicGroup
        ? ["about", "feed", "events", "groups", "members", "documents"]
        : ["about", "feed", "events", "groups", "members", "documents", "jobs", "marketplace", "governance", "badges", "stake", "press", "treasury"]
    ),
    [isBasicGroup]
  )
  const requestedTab = searchParams.get("tab")

  const [offeringModalOpen, setOfferingModalOpen] = useState(false)
  const [flowPassOpen, setFlowPassOpen] = useState(false)
  const [accessDialogOpen, setAccessDialogOpen] = useState(
    () => !!passwordRequired && !isGroupMember
  )
  const [activeTab, setActiveTab] = useState(() => (
    requestedTab && visibleTabs.includes(requestedTab) ? requestedTab : "about"
  ))

  useEffect(() => {
    if (!requestedTab || !visibleTabs.includes(requestedTab)) {
      setActiveTab("about")
      return
    }
    setActiveTab(requestedTab)
  }, [requestedTab, visibleTabs])

  const formatCurrency = (cents: number | null): string =>
    cents === null ? "Custom pricing" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

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

  const eventItems = useMemo(
    () =>
      eventResources.map((r) => {
        const meta = r.metadata ?? {}
        return {
          id: r.id,
          name: r.name,
          description: r.description || "",
          location: {
            name: String(meta.location ?? ""),
            address: String(meta.location ?? ""),
          },
          timeframe: {
            start: String(meta.date ?? meta.startDate ?? r.createdAt),
            end: String(meta.endDate ?? meta.date ?? r.createdAt),
          },
          image: String(meta.image ?? "/placeholder.svg"),
          price: typeof meta.price === "number" ? meta.price : 0,
          chapterTags: (meta.chapterTags as string[]) ?? [],
          organizer: r.ownerId,
          creator: r.ownerId,
        }
      }),
    [eventResources]
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
    () =>
      members.map((m) => ({
        user: {
          id: m.id,
          name: m.name,
          username: m.username || m.id,
          avatar: m.image || "/placeholder-user.jpg",
          followers: 0,
          following: 0,
        },
        profitShare: members.length > 0 ? Math.round((100 / members.length) * 100) / 100 : 0,
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
      })),
    [members, groupId]
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
          votes: {
            yes: Number(rec.votesFor ?? rec.votesYes ?? 0),
            no: Number(rec.votesAgainst ?? rec.votesNo ?? 0),
            abstain: Number(rec.votesAbstain ?? 0),
          },
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

  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])

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
    return { id: userId, name: "Unknown User", username: "unknown", avatar: "/placeholder-user.jpg", followers: 0, following: 0 }
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
          <TabsTrigger value="about" className="shrink-0">About</TabsTrigger>
          <TabsTrigger value="feed" className="shrink-0">Feed</TabsTrigger>
          <TabsTrigger value="events" className="shrink-0">Events</TabsTrigger>
          <TabsTrigger value="groups" className="shrink-0">Groups</TabsTrigger>
          <TabsTrigger value="members" className="shrink-0">Members</TabsTrigger>
          <TabsTrigger value="documents" className="shrink-0">Docs</TabsTrigger>
          {!isBasicGroup && (
            <>
              <TabsTrigger value="jobs" className="shrink-0">Jobs</TabsTrigger>
              <TabsTrigger value="marketplace" className="shrink-0">Mart</TabsTrigger>
              <TabsTrigger value="governance" className="shrink-0">Governance</TabsTrigger>
              <TabsTrigger value="badges" className="shrink-0">Badges</TabsTrigger>
              <TabsTrigger value="stake" className="shrink-0">Stake</TabsTrigger>
              <TabsTrigger value="press" className="shrink-0">Press</TabsTrigger>
              <TabsTrigger value="treasury" className="shrink-0">Treasury</TabsTrigger>
            </>
          )}
        </TabsList>
      </div>

      {/* ── About ── */}
      <TabsContent value="about" className="space-y-4 mt-4">
        <GroupCalendar
          eventResources={eventResources}
          projectResources={projectResources}
          jobResources={jobResources}
          groupName={groupName}
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
                <div key={plan.id} className="rounded-md border p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{plan.name}</p>
                    <div className="flex items-center gap-2">
                      {!plan.active && <Badge variant="outline">Inactive</Badge>}
                      {plan.isDefault && <Badge>Default</Badge>}
                    </div>
                  </div>
                  {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
                  <p className="text-sm text-muted-foreground">
                    Monthly: {formatCurrency(plan.amountMonthlyCents)} · Yearly: {formatCurrency(plan.amountYearlyCents)}
                  </p>
                  {plan.perks.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {plan.perks.map((perk) => <Badge key={perk} variant="secondary">{perk}</Badge>)}
                    </div>
                  )}
                </div>
              ))}
              <Link href={`/groups/${groupId}/settings`} className="inline-flex text-sm text-primary hover:underline">
                Manage membership plans
              </Link>
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
          totalStakes={100}
        />
      </TabsContent>

      {/* ── Press ── */}
      <TabsContent value="press" className="mt-4">
        <PressTab groupId={groupId} isGroupAdmin={isGroupAdmin} pressResources={pressResources} />
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
