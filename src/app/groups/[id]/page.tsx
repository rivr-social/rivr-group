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
import { auth } from "@/auth"
import { fetchAgentFeed, fetchGroupDetail } from "@/app/actions/graph"
import { agentToGroup, agentToUser } from "@/lib/graph-adapters"
import { readGroupMembershipPlans } from "@/lib/group-memberships"
import { buildGroupPageMetadata } from "@/lib/object-metadata"
import { AgentPageShell } from "@/components/agent-page-shell"
import { Button } from "@/components/ui/button"
import { GroupJoinControl } from "@/components/group-join-control"
import { GroupActions } from "@/components/group-actions"
import { GroupTabsClient } from "@/components/group-tabs-client"
import { GroupProfileHeader } from "@/components/group-profile-header"
import { buildGroupStructuredData, serializeJsonLd } from "@/lib/structured-data"

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
    auth(),
  ])

  if (!detail) {
    notFound()
  }

  const group = agentToGroup(detail.group)
  const members = detail.members.map(agentToUser)
  const domainGroups = detail.subgroups.map(agentToGroup)
  const groupMeta = (detail.group.metadata ?? {}) as Record<string, unknown>
  const rawGroupType = String(groupMeta.groupType ?? "").toLowerCase()
  const canonicalGroupType = rawGroupType === "org" ? "organization" : (rawGroupType || "basic")
  const ownerId = typeof groupMeta.creatorId === "string" ? groupMeta.creatorId : undefined
  const currentUserId = session?.user?.id ?? null
  const isGroupAdmin = !!(currentUserId && (
    groupMeta.creatorId === currentUserId ||
    (Array.isArray(groupMeta.adminIds) && (groupMeta.adminIds as unknown[]).includes(currentUserId))
  ))
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
  const governanceItems = [
    ...(((groupMeta.proposals as unknown[]) ?? []) as unknown[]),
    ...(((groupMeta.polls as unknown[]) ?? []) as unknown[]),
    ...(((groupMeta.issues as unknown[]) ?? []) as unknown[]),
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
      tags={group.chapterTags ?? []}
      isAdmin={isGroupAdmin}
      groupType={canonicalGroupType}
      commissionBps={typeof groupMeta.commissionBps === "number" ? groupMeta.commissionBps as number : undefined}
    >
      <div className="flex items-center gap-2">
        {isGroupAdmin && (
          <Link href={`/groups/${group.id}/settings`}>
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              Edit Group
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
        <GroupActions
          groupId={group.id}
          groupName={group.name}
          groupDescription={group.description}
          ownerId={ownerId}
        />
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
      backHref="/groups"
      backLabel="Back to groups"
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
        members={members.map((m) => ({ id: m.id, name: m.name, username: m.username, image: m.avatar }))}
        groupPostResources={groupPostResources}
        eventResources={eventResources}
        domainGroups={domainGroups.map((d) => ({ id: d.id, name: d.name, description: d.description }))}
        affiliatedGroups={affiliatedGroupsRaw}
        projectJobTrees={projectJobTrees}
        unassignedJobs={unassignedJobs}
        unassignedTasks={unassignedTasks}
        listingResources={listingResources}
        governanceItems={governanceItems}
        badgeResources={badgeResources}
        stakeActivity={stakeActivity}
        pressResources={pressResources}
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
            category: typeof meta.category === "string" ? meta.category : undefined,
            showOnAbout: meta.showOnAbout === true,
          }
        })}
        projectResources={projectResources}
        jobResources={jobOnlyResources}
        treasuryActivity={treasuryActivity}
        publishActivity={publishActivity}
        resourceCount={detail.resources.length}
        passwordRequired={Boolean(group.joinSettings?.passwordRequired)}
      />
    </AgentPageShell>
  )
}
