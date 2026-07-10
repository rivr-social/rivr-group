/**
 * Group detail page for `/groups/[id]`.
 *
 * Server Component that fetches group data and delegates interactive tab
 * rendering to `GroupTabsClient` (a client component with create buttons,
 * modals, and wired-in interactive components).
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { MessageSquare, Settings } from "lucide-react"
import { fetchAgentFeed, fetchGroupDetail, fetchPublicAgentsByIds , fetchGroupLineage, hasOrgGradeAffiliation } from "@/app/actions/graph"
import { agentToGroup, agentToUser } from "@/lib/graph-adapters"
import { isUuid } from "@/app/actions/graph/types"
import { resolveEventWindow } from "@/lib/calendar/event-window"
import { readGroupMembershipPlans } from "@/lib/group-memberships"
import { getActiveGroupSubscriptionPlanId } from "@/lib/group-subscriptions"
import { buildGroupPageMetadata } from "@/lib/object-metadata"
import { parseFacetedTagsFromMetadata } from "@/lib/parachute-doc"
import { AgentPageShell } from "@/components/agent-page-shell"
import { Button } from "@/components/ui/button"
import { GroupJoinControl } from "@/components/group-join-control"
import { GroupTabsClient } from "@/components/group-tabs-client"
import { GroupProfileHeader } from "@/components/group-profile-header"
import { buildGroupStructuredData, serializeJsonLd } from "@/lib/structured-data"
import { getAuthenticatedActorId } from "@/lib/server-auth"
import { isGroupAdmin as isGroupAdminCascade } from "@/app/actions/group-admin"
import { calculateTotalStakes, getMemberStakesForGroup } from "@/lib/queries/stakes"
import { getRecordedContributions } from "@/app/actions/interactions"
import { getGroupMembersByClass } from "@/app/actions/wallet/net-allocation"
import { parseNetAllocationTree } from "@/lib/net-allocation"
import { canPostToGroup } from "@/app/actions/create-resources"
import { extractStockNeeds, isStockInventoryType } from "@/lib/stock"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const detail = await fetchGroupDetail(id)

  if (!detail) {
    return {
      title: "Group Not Found | RIVR",
    }
  }

  return buildGroupPageMetadata(detail.group, `/groups/${detail.group.id}`)
}

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [detail, activity, session] = await Promise.all([
    fetchGroupDetail(id),
    fetchAgentFeed(id, 40).catch(() => []),
    getAuthenticatedActorId(),
  ])

  if (!detail) {
    notFound()
  }

  const group = agentToGroup(detail.group)
  const members = detail.members.map(agentToUser)
  const domainGroups = detail.subgroups.map(agentToGroup)
  const groupMeta = (detail.group.metadata ?? {}) as Record<string, unknown>
  const rawGroupType = String(groupMeta.groupType ?? "").toLowerCase()
  const agentGroupType = String(detail.group.type ?? "").toLowerCase()
  const fallbackGroupType = ["organization", "org", "ring", "family", "guild", "community"].includes(agentGroupType) ? "organization" : "basic"
  const ownerId = typeof groupMeta.creatorId === "string" ? groupMeta.creatorId : undefined
  const currentUserId = session ?? null
  // Independent lookups batched into one round instead of four sequential hops
  // on the instance-home hot path:
  // - Parent lineage (root-first) powers the subgroup breadcrumb under the
  //   group name AND org-tab inheritance: a subgroup anywhere under an
  //   organization gets the FULL org tab set even when its own groupType is
  //   unset or "basic".
  // - isGroupAdmin uses the canonical cascading admin gate (a Spirit admin
  //   administers its circles) rather than an inline creatorId/adminIds check.
  // - activeGroupPlanId lets the About tab hide the already-subscribed plan's
  //   Subscribe CTA (B2).
  // - memberCanCreate feeds the Stock tab's manage gate further below.
  const [groupLineage, isGroupAdmin, activeGroupPlanId, memberCanCreate] = await Promise.all([
    detail.group.parentId ? fetchGroupLineage(group.id) : Promise.resolve([]),
    currentUserId ? isGroupAdminCascade(currentUserId, id) : Promise.resolve(false),
    currentUserId
      ? getActiveGroupSubscriptionPlanId(currentUserId, group.id).catch(() => null)
      : Promise.resolve(null),
    currentUserId ? canPostToGroup(currentUserId, id, "create").catch(() => false) : Promise.resolve(false),
  ])
  const hasOrgAncestor = groupLineage.some(
    (a) => ["organization", "org"].includes(String(a.groupType ?? "").toLowerCase()) ||
           ["organization", "org", "ring", "family", "guild", "community"].includes(a.type.toLowerCase()),
  )
  const ownGroupType = rawGroupType === "org" ? "organization" : (rawGroupType || fallbackGroupType)
  // Partner/affiliated groups linked to an org-grade group inherit the org tab
  // set (jobs, treasury, governance, …) the same way a subgroup does. Affiliate
  // edges live in the ledger — disjoint from the parentId chain above — so a
  // basic group that is only a partner (not a subgroup) of an org would
  // otherwise stay "basic" and its members never saw the Jobs board. Only
  // evaluated when the group isn't already org-grade by its own type or a
  // subgroup ancestor, so it adds at most one relationship lookup.
  const hasOrgAffiliation =
    ownGroupType === "basic" && !hasOrgAncestor ? await hasOrgGradeAffiliation(group.id) : false
  const canonicalGroupType =
    (hasOrgAncestor || hasOrgAffiliation) && ownGroupType === "basic" ? "organization" : ownGroupType
  const isMember = !!(currentUserId && members.some((m) => m.id === currentUserId))
  const membershipPlans = readGroupMembershipPlans(groupMeta)
  const affiliatedGroupsRaw = (
    (groupMeta.affiliatedGroups as unknown[]) ??
    (groupMeta.affiliations as unknown[]) ??
    []
  ) as unknown[]

  // ── Resource filters ──
  const eventResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "event" || meta.resourceKind === "event"
  })
  // Resolve each event's canonical start/end window server-side (the helper is
  // runtime-local and only correct on the server/UTC), so the card + calendar
  // render the same schedule as the event-detail page instead of re-deriving
  // from raw metadata and dropping the time / shifting the day in the browser.
  const eventWindows: Record<string, { start: string; end: string }> = {}
  for (const r of eventResources) {
    const win = resolveEventWindow((r.metadata ?? {}) as Record<string, unknown>)
    if (win.start) {
      eventWindows[r.id] = {
        start: win.start.toISOString(),
        end: (win.end ?? win.start).toISOString(),
      }
    }
  }
  const groupPostResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "post" || r.type === "note" || String(meta.entityType ?? "") === "post"
  })
  const projectResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "project" || meta.resourceKind === "project"
  })
  const listingResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return (
      (r.type === "listing" || r.type === "resource" || r.type === "skill" || r.type === "venue")
      && (typeof meta.listingType === "string" || String(meta.listingKind ?? "").toLowerCase() === "marketplace-listing")
    )
  })
  // Hydrate owner agents for posts/events/listings whose authors are NOT in
  // the member roster (marketplace-offer owners, federated authors, members
  // missing from the roster). Without this the feed resolves authors only
  // against members and falls back to "Unknown User" / /profile/unknown.
  const memberIdSet = new Set(members.map((m) => m.id))
  const authorIds = Array.from(
    new Set(
      [...groupPostResources, ...eventResources, ...listingResources]
        .map((r) => r.ownerId)
        .filter((ownerId): ownerId is string =>
          typeof ownerId === "string" && ownerId.length > 0 && !memberIdSet.has(ownerId)
        )
    )
  )
  // Chapter-tag UUIDs resolve to human names so the header renders "Boulder"
  // instead of an opaque id. Unresolved UUIDs are dropped at render time by
  // GroupProfileHeader's UUID guard.
  const chapterTags = (group.chapterTags ?? []) as string[]
  const chapterTagUuids = chapterTags.filter((tag) => isUuid(tag))
  // Both hydrations depend only on `detail`; resolve in parallel. Author
  // identities go via the public/optional path so logged-out visitors on this
  // anonymously-viewable group page still get author identities. The
  // auth-required variant throws for anonymous viewers, and the `.catch`
  // would then silently degrade every non-member (group-owned or federated)
  // post author to the "Unknown User" fallback.
  const [authorAgents, chapterTagAgents] = await Promise.all([
    authorIds.length > 0 ? fetchPublicAgentsByIds(authorIds).catch(() => []) : Promise.resolve([]),
    chapterTagUuids.length > 0 ? fetchPublicAgentsByIds(chapterTagUuids).catch(() => []) : Promise.resolve([]),
  ])
  const authors = authorAgents.map(agentToUser).map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    image: u.avatar,
  }))

  const tagLabels: Record<string, string> = {}
  for (const agentRow of chapterTagAgents) {
    if (agentRow?.id && agentRow.name) tagLabels[agentRow.id] = agentRow.name
  }

  // Tag each item with its governance `type` on merge — the client
  // (group-tabs-client) filters governanceItems by `rec.type === "proposal"|
  // "poll"|"issue"`, but the create actions store these objects WITHOUT a type
  // field, so an untagged merge made every proposal/poll/issue invisible in the
  // Governance tab even though they persist in group metadata.
  const tagType = (items: unknown, type: string): Record<string, unknown>[] =>
    (Array.isArray(items) ? items : []).map((it) => ({
      ...(it as Record<string, unknown>),
      type,
    }))
  const governanceItems = [
    ...tagType(groupMeta.proposals, "proposal"),
    ...tagType(groupMeta.polls, "poll"),
    ...tagType(groupMeta.issues, "issue"),
  ]
  const documentResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "resource" && (String(meta.resourceSubtype ?? "").toLowerCase() === "document" || typeof r.content === "string")
  })
  const jobResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "job" || r.type === "task" || meta.resourceKind === "job" || meta.resourceKind === "task"
  })
  const jobOnlyResources = jobResources.filter((r) => r.type === "job" || String(((r.metadata ?? {}) as Record<string, unknown>).resourceKind ?? "") === "job")
  const taskResources = jobResources.filter((r) => r.type === "task" || String(((r.metadata ?? {}) as Record<string, unknown>).resourceKind ?? "") === "task")

  // ── Project/job/task tree construction ──
  const projectHints = new Map<string, Set<string>>()
  for (const project of projectResources) {
    const meta = (project.metadata ?? {}) as Record<string, unknown>
    const hints = new Set<string>()
    const jobs = Array.isArray(meta.jobs) ? (meta.jobs as unknown[]) : []
    for (const item of jobs) {
      if (typeof item === "string" && item.trim()) hints.add(item.trim().toLowerCase())
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>
        for (const key of ["id", "jobId", "title", "name"]) {
          const value = rec[key]
          if (typeof value === "string" && value.trim()) hints.add(value.trim().toLowerCase())
        }
      }
    }
    projectHints.set(project.id, hints)
  }

  const jobBelongsToProject = (job: (typeof jobOnlyResources)[number], projectId: string): boolean => {
    const meta = (job.metadata ?? {}) as Record<string, unknown>
    const linkedProjectId = String(meta.projectId ?? meta.projectDbId ?? "")
    if (linkedProjectId && linkedProjectId === projectId) return true
    const hints = projectHints.get(projectId)
    if (!hints || hints.size === 0) return false
    if (hints.has(job.id.toLowerCase())) return true
    if (hints.has(job.name.toLowerCase())) return true
    return false
  }
  const taskBelongsToJob = (task: (typeof taskResources)[number], jobId: string): boolean => {
    const meta = (task.metadata ?? {}) as Record<string, unknown>
    return String(meta.jobId ?? meta.jobDbId ?? "") === jobId
  }
  const taskBelongsToProject = (task: (typeof taskResources)[number], projectId: string): boolean => {
    const meta = (task.metadata ?? {}) as Record<string, unknown>
    return String(meta.projectId ?? meta.projectDbId ?? "") === projectId
  }

  // Build trees and serialize Map → Record for client component props.
  const projectJobTrees = projectResources.map((project) => {
    const jobs = jobOnlyResources.filter((job) => jobBelongsToProject(job, project.id))
    const tasksByJobMap = new Map<string, typeof taskResources>()
    for (const job of jobs) {
      tasksByJobMap.set(job.id, taskResources.filter((task) => taskBelongsToJob(task, job.id)))
    }
    const projectLevelTasks = taskResources.filter((task) =>
      taskBelongsToProject(task, project.id) &&
      !Array.from(tasksByJobMap.values()).flat().some((t) => t.id === task.id)
    )
    // Serialize Map to plain Record for JSON transport to client component.
    const tasksByJob: Record<string, typeof taskResources> = {}
    for (const [k, v] of tasksByJobMap) tasksByJob[k] = v
    return { project, jobs, tasksByJob, projectLevelTasks }
  })

  const assignedJobIds = new Set(projectJobTrees.flatMap((tree) => tree.jobs.map((job) => job.id)))
  const assignedTaskIds = new Set(
    projectJobTrees.flatMap((tree) => [
      ...tree.projectLevelTasks.map((task) => task.id),
      ...Object.values(tree.tasksByJob).flat().map((task) => task.id),
    ])
  )
  const unassignedJobs = jobOnlyResources.filter((job) => !assignedJobIds.has(job.id))
  const unassignedTasks = taskResources.filter((task) => !assignedTaskIds.has(task.id))
  const badgeResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "badge" || meta.resourceKind === "badge"
  })
  const pressResources = documentResources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const category = String(meta.category ?? "").toLowerCase()
    return category.includes("press") || category.includes("news") || category.includes("media")
  })
  // ── Stock tab ── tangible-stock resources (material/asset REA types) for the
  // read-only Inventory subtab, plus the editable Needs list persisted on the
  // org's own metadata. Managing needs requires admin or group content-write.
  const stockResources = detail.resources.filter((r) => isStockInventoryType(r.type))
  const stockNeeds = extractStockNeeds(groupMeta)
  const stockCanManage = currentUserId ? isGroupAdmin || memberCanCreate : false

  // ── Activity filters ──
  const activityEntries = (activity as Array<{ id: string; verb: string; timestamp: string; [key: string]: unknown }>)
  const stakeActivity = activityEntries.filter((entry) => entry.verb === "fund")
  const treasuryActivity = activityEntries.filter((entry) => entry.verb === "transfer")
  const publishActivity = activityEntries.filter((entry) => entry.verb === "publish" || entry.verb === "create")

  // ── Derived display data ──
  const groupTags = Array.isArray(groupMeta.tags) ? groupMeta.tags.filter((tag): tag is string => typeof tag === "string") : []
  const groupContact = (groupMeta.contactInfo ?? groupMeta.contact ?? {}) as Record<string, unknown>
  const groupAdmins = members.filter((member) =>
    member.id === (groupMeta.creatorId as string) ||
    (Array.isArray(groupMeta.adminIds) && (groupMeta.adminIds as unknown[]).includes(member.id))
  )
  const groupCreator = groupAdmins.find((member) => member.id === (groupMeta.creatorId as string))
  const groupLocationText =
    typeof group.location === "string"
      ? group.location
      : group.location && typeof group.location === "object"
        ? String((group.location as Record<string, unknown>).address ?? (group.location as Record<string, unknown>).name ?? "Location not provided")
        : "Location not provided"
  const structuredData = buildGroupStructuredData(group, {
    path: `/groups/${group.id}`,
    visibility: detail.group.visibility ?? null,
    groupType: String(groupMeta.groupType ?? "organization"),
    memberCount: members.length || group.memberCount || 0,
  })
  const serverMemberStakes = await getMemberStakesForGroup(id).catch(() => [])
  const serverTotalStakes = serverMemberStakes.length > 0 ? calculateTotalStakes(serverMemberStakes) : 0

  // Admin-only calendar work sessions (getGroupWorkPeriods gates internally —
  // non-admin viewers get [] and the calendar kind simply never renders).
  const { getGroupWorkPeriods } = await import("@/app/actions/calendar-work")
  const groupWorkPeriods = await getGroupWorkPeriods(id).catch(() => [])

  // Job-contribution stakeholders (J2 corrected model): contributors recorded on
  // job completion surface in the Stake tab. Resolve their display names.
  const recordedContributionRows = await getRecordedContributions({ groupId: id }).catch(() => [])
  const contributionAgents =
    recordedContributionRows.length > 0
      ? await fetchPublicAgentsByIds(recordedContributionRows.map((row) => row.contributorId)).catch(() => [])
      : []
  const contributionAgentById = new Map(contributionAgents.map((a) => [a.id, a]))
  const recordedContributions = recordedContributionRows.map((row) => {
    const agent = contributionAgentById.get(row.contributorId)
    return {
      contributorId: row.contributorId,
      contributorName: agent?.name ?? row.contributorId,
      contributorImage: typeof agent?.image === "string" ? agent.image : null,
      jobCount: row.jobCount,
    }
  })

  // Net-allocation Stake-tree editor data (EPIC J7). Admin-only: the editor is
  // gated by `isGroupAdmin` and only authoring admins ever see/edit the tree, so
  // we skip the membership-by-class query entirely for non-admins.
  const netAllocationTree = parseNetAllocationTree(groupMeta)
  const netAllocationRules = netAllocationTree.rules
  let netAllocationClasses: Array<{ key: string; memberCount: number }> = []
  if (isGroupAdmin) {
    const membersByClass = await getGroupMembersByClass(id).catch(
      () => new Map<string, string[]>(),
    )
    netAllocationClasses = Array.from(membersByClass.entries()).map(
      ([key, memberIds]) => ({ key, memberCount: memberIds.length }),
    )
  }
  const netAllocationMembers = members.map((m) => ({ id: m.id, name: m.name }))

  const header = (
    <GroupProfileHeader
      groupId={group.id}
      name={group.name}
      description={group.description}
      avatar={group.image || "/placeholder.svg"}
      coverImage={
        typeof groupMeta.coverImage === "string" && groupMeta.coverImage
          ? groupMeta.coverImage as string
          : "/vibrant-garden-tending.png"
      }
      location={groupLocationText}
      memberCount={members.length || group.memberCount || 0}
      lineage={groupLineage.map(({ id: lid, name }) => ({ id: lid, name }))}
      tags={group.chapterTags ?? []}
      tagLabels={tagLabels}
      isAdmin={isGroupAdmin}
    >
      <div className="flex flex-wrap items-center gap-2">
        {isGroupAdmin && (
          <Link href={`/groups/${group.id}/settings`}>
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              Group Settings
            </Button>
          </Link>
        )}
        {isMember && (
          <Link href={`/messages?group=${group.id}`}>
            <Button variant="outline" size="sm">
              <MessageSquare className="h-4 w-4 mr-2" />
              Chat
            </Button>
          </Link>
        )}
        <GroupJoinControl
          groupId={group.id}
          groupName={group.name}
          joinSettings={group.joinSettings}
          initiallyJoined={isMember}
        />
      </div>
    </GroupProfileHeader>
  )

  return (
    <AgentPageShell
      header={header}
      structuredDataJson={structuredData ? serializeJsonLd(structuredData) : null}
    >
      <GroupTabsClient
        groupId={group.id}
        groupName={group.name}
        groupDescription={group.description}
        groupType={canonicalGroupType}
        groupLocation={groupLocationText}
        groupTags={groupTags}
        groupContact={groupContact}
        groupAdmins={groupAdmins.map((a) => ({ id: a.id, name: a.name }))}
        groupCreatorName={groupCreator?.name ?? null}
        isGroupAdmin={!!isGroupAdmin}
        currentUserId={currentUserId}
        membershipPlans={membershipPlans}
        activeSubscriptionPlanId={activeGroupPlanId}
        members={members.map((m) => ({ id: m.id, name: m.name, username: m.username, image: m.avatar }))}
        authors={authors}
        groupPostResources={groupPostResources}
        eventResources={eventResources}
        eventWindows={eventWindows}
        domainGroups={domainGroups.map((d) => ({ id: d.id, name: d.name, description: d.description }))}
        affiliatedGroups={affiliatedGroupsRaw}
        projectJobTrees={projectJobTrees}
        unassignedJobs={unassignedJobs}
        unassignedTasks={unassignedTasks}
        listingResources={listingResources}
        governanceItems={governanceItems}
        badgeResources={badgeResources}
        stakeActivity={stakeActivity}
        serverMemberStakes={serverMemberStakes}
        serverTotalStakes={serverTotalStakes}
        recordedContributions={recordedContributions}
        netAllocationRules={netAllocationRules}
        netAllocationClasses={netAllocationClasses}
        netAllocationMembers={netAllocationMembers}
        pressResources={pressResources}
        stockResources={stockResources}
        stockNeeds={stockNeeds}
        stockCanManage={stockCanManage}
        documentResources={documentResources.map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>
          return {
            id: r.id,
            title: r.name,
            description: r.description || "",
            content: typeof r.content === "string" ? r.content : "",
            createdAt: r.createdAt,
            updatedAt: r.updatedAt ?? r.createdAt,
            createdBy: r.ownerId,
            groupId: id,
            tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
            facetedTags: parseFacetedTagsFromMetadata(
              r.metadata,
              Array.isArray(meta.tags) ? (meta.tags as string[]) : r.tags,
            ),
            category: typeof meta.category === "string" ? meta.category : undefined,
            showOnAbout: meta.showOnAbout === true,
          }
        })}
        projectResources={projectResources}
        jobResources={jobOnlyResources}
        groupWorkPeriods={groupWorkPeriods}
        treasuryActivity={treasuryActivity}
        publishActivity={publishActivity}
        resourceCount={detail.resources.length}
        passwordRequired={Boolean(group.joinSettings?.passwordRequired)}
        tabVisibility={(groupMeta.tabVisibility ?? {}) as Record<string, string>}
      />
    </AgentPageShell>
  )
}
