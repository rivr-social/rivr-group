/**
 * Project detail page for `/projects/[id]`.
 *
 * Purpose:
 * - Renders a comprehensive project profile with tabbed layout:
 *   About (owner, activity, events), Jobs (nested jobs with tasks/checkoff/points), Team (members).
 *
 * Rendering: Server Component (no `"use client"` directive).
 * Data requirements:
 * - Fetches the project agent directly via `fetchAgent(id)`.
 * - Resolves owner/creator from agent metadata via a second `fetchAgent` call.
 * - Loads child agents via `fetchAgentChildren` for the member list.
 * - Loads recent activity via `fetchAgentFeed` for the timeline.
 * - Loads owned resources and partitions into jobs/tasks for the Jobs tab.
 * - Normalizes the agent to a `Project` type via `agentToProject`.
 *
 * Auth: No explicit auth gate; visibility is enforced by graph-layer policy.
 *
 * @module projects/[id]/page
 */
import Link from "next/link"
import Image from "next/image"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import {
  ArrowLeft,
  Briefcase,
  Calendar,
  Clock,
  Edit,
  MapPin,
  MessageSquare,
  Plus,
  Star,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { getCurrentUserId } from "@/app/actions/interactions/helpers"
import { fetchAgent, fetchAgentChildren, fetchAgentFeed, fetchGroupDetail, fetchGroupRelationships, fetchProjectEvents, fetchResourcesByOwner } from "@/app/actions/graph"
import { hasGroupWriteAccess } from "@/app/actions/create-resources"
import { agentToProject } from "@/lib/graph-adapters"
import { buildGroupPageMetadata } from "@/lib/object-metadata"
import { buildProjectStructuredData, serializeJsonLd } from "@/lib/structured-data"
import { ProjectActions } from "@/components/project-actions"
import { ProjectJobsTab } from "@/components/project-jobs-tab"
import { ProjectRolesCard } from "@/components/project-roles-card"
import { getProjectRolesData } from "@/app/actions/project-roles"
import { StockTab } from "@/components/stock-tab"
import { getResourcesByProjectId } from "@/lib/queries/resources"
import { extractStockNeeds, toStockInventory } from "@/lib/stock"
import { ProjectDistributionTab } from "@/components/project-distribution-tab"
import { ProjectExpensePanel } from "@/components/project-expense-panel"
import { parseProjectDistribution, resolveSettlementSplits, allocateByBps, type SettlementRole } from "@/lib/settlement-splits"
import {
  parseLineageConfig,
  resolveEffectiveLineageConfig,
  getProjectAncestorChain,
  DEFAULT_LINEAGE_CASCADE_BPS,
} from "@/lib/lineage-distribution"
import { getProjectWalletForResource, getWalletBalance, getTransactionHistory } from "@/lib/wallet"
import { getJobTimerStatus } from "@/app/actions/job-timer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

// ─── Constants ──────────────────────────────────────────────────────────────

/** Status-to-progress mapping for project lifecycle stages. */
const STATUS_PROGRESS: Record<string, number> = {
  planning: 0,
  active: 50,
  completed: 100,
}

/** Status-to-badge-variant mapping for visual differentiation. */
const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  planning: "outline",
  active: "default",
  completed: "secondary",
}

/** Status-to-label mapping for display text. */
const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  completed: "Completed",
}

/** Icon mapping for activity feed verb types. */
const VERB_ICON_MAP: Record<string, typeof Star> = {
  create: Plus,
  join: UserPlus,
  update: Edit,
  delete: Trash2,
  comment: MessageSquare,
  like: Star,
}

/** Maximum number of members displayed before the overflow indicator. */
const MAX_VISIBLE_MEMBERS = 10

/** Maximum number of activity feed entries to display. */
const ACTIVITY_FEED_LIMIT = 10

// ─── Data Loading ───────────────────────────────────────────────────────────

async function getProjectPageData(id: string) {
  let agent = await fetchAgent(id)

  // Projects may be stored as resources rather than agents.
  // If not found in agents, look up the resource and synthesize an agent-like object.
  if (!agent) {
    const resources = await fetchResourcesByOwner(id).catch(() => [])
    // Try fetching the resource directly via a DB lookup
    const { db } = await import("@/db")
    const { resources: resourcesTable } = await import("@/db/schema")
    const { eq } = await import("drizzle-orm")
    const row = await db.query.resources.findFirst({
      where: eq(resourcesTable.id, id),
    })
    if (row && row.type === "project") {
      agent = {
        id: row.id,
        name: row.name ?? "Untitled Project",
        type: "project" as const,
        description: row.description,
        image: null,
        email: null,
        visibility: row.visibility,
        metadata: {
          ...(row.metadata as Record<string, unknown> ?? {}),
          groupId: (row.metadata as Record<string, unknown>)?.groupId ?? row.ownerId,
          ownerId: row.ownerId,
        },
        parentAgentId: row.ownerId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: null,
      } as unknown as NonNullable<typeof agent>
    }
  }

  if (!agent) return null

  const project = agentToProject(agent)
  const ownerId = resolveOwnerId(agent.metadata ?? {})
  const projectMeta = (agent.metadata ?? {}) as Record<string, unknown>
  const groupId = typeof projectMeta.groupId === "string" ? projectMeta.groupId : null
  const [owner, children, activity] = await Promise.all([
    ownerId ? fetchAgent(ownerId) : Promise.resolve(null),
    fetchAgentChildren(id),
    fetchAgentFeed(id, ACTIVITY_FEED_LIMIT),
  ])
  const [directlyOwnedResources, groupDetail, projectLinkedEvents] = await Promise.all([
    fetchResourcesByOwner(id).catch(() => []),
    groupId ? fetchGroupDetail(groupId).catch(() => null) : Promise.resolve(null),
    fetchProjectEvents(id).catch(() => []),
  ])
  // Jobs/tasks may be owned by the group but linked to this project via metadata.projectId.
  // Merge both sources and dedupe.
  const groupLinkedResources = (groupDetail?.resources ?? []).filter((resource) => {
    const meta = (resource.metadata ?? {}) as Record<string, unknown>
    return String(meta.projectId ?? "") === id
  })
  const seenIds = new Set(directlyOwnedResources.map((r) => r.id))
  const ownedResources = [
    ...directlyOwnedResources,
    ...groupLinkedResources.filter((r) => !seenIds.has(r.id)),
  ]
  const jobResources = ownedResources.filter((resource) => {
    const meta = (resource.metadata ?? {}) as Record<string, unknown>
    return resource.type === "job" || resource.type === "task" || meta.resourceKind === "job" || meta.resourceKind === "task"
  })
  // Events linked to this project via metadata.projectId/managingProjectId,
  // independent of who owns the event row. The dedicated SQL fetcher handles
  // the metadata lookup and visibility filtering.
  const linkedEvents = projectLinkedEvents

  return {
    agent,
    project,
    ownerId,
    owner,
    children,
    activity,
    linkedEvents,
    jobResources,
    ownedResources,
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const data = await getProjectPageData(id)

  if (!data) {
    return {
      title: "Project Not Found | RIVR",
    }
  }

  return buildGroupPageMetadata(data.agent, `/projects/${data.project.id}`)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolves the owner/creator ID from agent metadata, checking multiple fallback keys.
 */
function resolveOwnerId(metadata: Record<string, unknown>): string | null {
  if (typeof metadata.creatorId === "string" && metadata.creatorId.length > 0) {
    return metadata.creatorId
  }
  if (typeof metadata.ownerId === "string" && metadata.ownerId.length > 0) {
    return metadata.ownerId
  }
  return null
}

/**
 * Formats an ISO timestamp into a human-readable relative time string.
 */
function formatRelativeTime(timestamp: string): string {
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true })
  } catch {
    return "Unknown"
  }
}

/** Sample seller-net used to illustrate the Stake distribution cascade ($100). */
const STAKE_PREVIEW_SAMPLE_CENTS = 10000

/** Human-readable labels for each settlement role in the Stake preview. */
const SETTLEMENT_ROLE_LABEL: Record<SettlementRole, string> = {
  seller: "Seller",
  project: "Project treasury (keep)",
  parent_org: "Parent org",
  ally: "Allied group",
  distribution: "Distribution",
}

const FORMAT_MS_PER_HOUR = 3_600_000;
const FORMAT_MS_PER_MINUTE = 60_000;

function formatTotalTimeMs(ms: number): string {
  if (ms <= 0) return "0m";
  const hours = Math.floor(ms / FORMAT_MS_PER_HOUR);
  const minutes = Math.floor((ms % FORMAT_MS_PER_HOUR) / FORMAT_MS_PER_MINUTE);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatProjectDate(timestamp: string | null | undefined): string {
  if (!timestamp) return "Date not set"
  try {
    return new Date(timestamp).toLocaleDateString()
  } catch {
    return "Date not set"
  }
}

/**
 * Partitions flat job/task resources into nested job-with-tasks structures.
 * Jobs are resources of type "job"; tasks are type "task" with metadata.jobId linking them.
 */
function buildJobsWithTasks(
  allResources: Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    metadata: Record<string, unknown>;
  }>,
) {
  const jobs = allResources.filter(
    (r) => r.type === "job" || (r.metadata as Record<string, unknown>).resourceKind === "job",
  )
  const tasks = allResources.filter(
    (r) => r.type === "task" || (r.metadata as Record<string, unknown>).resourceKind === "task",
  )

  // Index tasks by jobId for efficient lookups.
  const tasksByJobId = new Map<string, typeof tasks>()
  for (const task of tasks) {
    const jobId = typeof task.metadata.jobId === "string" ? task.metadata.jobId : null
    if (jobId) {
      const existing = tasksByJobId.get(jobId) ?? []
      existing.push(task)
      tasksByJobId.set(jobId, existing)
    }
  }

  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    description: job.description,
    metadata: job.metadata,
    tasks: (tasksByJobId.get(job.id) ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      metadata: t.metadata,
    })),
  }))
}

// ─── Page Component ─────────────────────────────────────────────────────────

/**
 * Server-rendered page component for a single project.
 *
 * Fetches the project agent directly by ID, resolves the owner, loads members,
 * activity feed, and job/task resources, then renders a tabbed layout with
 * About, Jobs, and Team tabs.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getProjectPageData(id)

  if (!data) {
    notFound()
  }

  const { agent, project, ownerId, owner, children, activity, linkedEvents, jobResources, ownedResources } = data
  const members = children.filter((child) => child.type === "person")

  // Partition resources into jobs with nested tasks.
  const jobsWithTasks = buildJobsWithTasks(ownedResources)

  // Load timer status for each job in parallel.
  const jobIds = jobsWithTasks.map((j) => j.id)
  const timerResults = await Promise.all(
    jobIds.map((jid) => getJobTimerStatus(jid).catch(() => null)),
  )
  const timersByJobId: Record<string, { activeTimer: NonNullable<Awaited<ReturnType<typeof getJobTimerStatus>>>["activeTimer"]; totalTimeMs: number }> = {}
  let totalProjectTimeMs = 0
  for (let i = 0; i < jobIds.length; i++) {
    const result = timerResults[i]
    if (result && result.success) {
      timersByJobId[jobIds[i]] = {
        activeTimer: result.activeTimer,
        totalTimeMs: result.totalTimeMs,
      }
      totalProjectTimeMs += result.totalTimeMs
    }
  }

  // Compute points totals from tasks.
  const allTasks = jobsWithTasks.flatMap((j) => j.tasks)
  const totalPoints = allTasks.reduce((sum, t) => {
    const pts = typeof t.metadata.points === "number" ? t.metadata.points : 0
    return sum + pts
  }, 0)
  const earnedPoints = allTasks.reduce((sum, t) => {
    const completed = t.metadata.completed === true || t.metadata.status === "completed"
    const pts = typeof t.metadata.points === "number" ? t.metadata.points : 0
    return completed ? sum + pts : sum
  }, 0)

  // Job/task counts for the header.
  const linkedJobCount = jobResources.filter((resource) => resource.type === "job" || ((resource.metadata ?? {}) as Record<string, unknown>).resourceKind === "job").length
  const linkedTaskCount = jobResources.filter((resource) => resource.type === "task" || ((resource.metadata ?? {}) as Record<string, unknown>).resourceKind === "task").length

  // Derive status display values.
  const statusKey = project.status || "active"
  const progressValue = STATUS_PROGRESS[statusKey] ?? 50
  const badgeVariant = STATUS_BADGE_VARIANT[statusKey] ?? "default"
  const statusLabel = STATUS_LABEL[statusKey] ?? statusKey

  // Task-based progress: use task completion if tasks exist, otherwise fall back to status-based.
  const taskBasedProgress = allTasks.length > 0
    ? Math.round((allTasks.filter((t) => t.metadata.completed === true || t.metadata.status === "completed").length / allTasks.length) * 100)
    : progressValue

  // Count overflow members beyond the visible limit.
  const visibleMembers = members.slice(0, MAX_VISIBLE_MEMBERS)
  const overflowCount = members.length - visibleMembers.length
  const structuredData = buildProjectStructuredData(project, {
    visibility: agent.visibility ?? null,
    ownerName: owner?.name ?? null,
  })

  // Resolve current user ID (unified: local or federated remote-viewer,
  // normalized to a local agent id) and admin status for the jobs tab.
  const currentUserId = await getCurrentUserId()
  // Lead/QA roles + eligible option lists (server-computed authority).
  const projectRoles = await getProjectRolesData(project.id).catch(() => null)
  const projectMeta2 = (agent.metadata ?? {}) as Record<string, unknown>
  const projectGroupId = typeof projectMeta2.groupId === "string" ? projectMeta2.groupId : null
  const isAdmin = currentUserId
    ? (currentUserId === ownerId ||
       (projectGroupId ? await hasGroupWriteAccess(currentUserId, projectGroupId) : false))
    : false

  // ── Revenue-distribution config ──────────────────────────────────────────
  // The project's owning agent (resources.ownerId) holds the treasury keep; its
  // affiliated/allied groups are the natural downstream cascade candidates.
  const projectOwnerAgentId = typeof projectMeta2.ownerId === "string" ? projectMeta2.ownerId : ownerId
  const distributionConfig = parseProjectDistribution(agent.metadata as Record<string, unknown>)
  const relationshipGroupId = projectOwnerAgentId ?? projectGroupId
  const relationships = relationshipGroupId
    ? await fetchGroupRelationships(relationshipGroupId).catch(() => [])
    : []
  const candidateRecipientIds = Array.from(
    new Set(
      relationships
        .flatMap((rel) => [rel.sourceGroupId, rel.targetGroupId])
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id !== relationshipGroupId),
    ),
  )
  const candidateAgents = await Promise.all(
    candidateRecipientIds.map((id) => fetchAgent(id).catch(() => null)),
  )
  const recipientOptions = candidateAgents
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .map((candidate) => ({ id: candidate.id, name: candidate.name, type: candidate.type }))

  // ── Effective lineage cascade config (J6/J8: default ON, overridable) ─────
  // Resolve what the cascade WILL do today (explicit project → explicit org →
  // system default) and surface it to the editor as the pre-filled value.
  const projectLineageConfig = parseLineageConfig(agent.metadata as Record<string, unknown>)
  const ownerAgentForLineage = projectOwnerAgentId
    ? await fetchAgent(projectOwnerAgentId).catch(() => null)
    : null
  const orgLineageConfig = projectLineageConfig.explicit
    ? null
    : parseLineageConfig((ownerAgentForLineage?.metadata ?? null) as Record<string, unknown> | null)
  const effectiveLineageConfig = resolveEffectiveLineageConfig(
    projectLineageConfig,
    orgLineageConfig,
  )
  // The ancestor chain gives human names for each per-hop level in the editor.
  const lineageAncestorIds = projectOwnerAgentId
    ? await getProjectAncestorChain(projectOwnerAgentId).catch(() => [])
    : []
  const lineageAncestorAgents = await Promise.all(
    lineageAncestorIds.map((id) => fetchAgent(id).catch(() => null)),
  )
  const lineageAncestors = lineageAncestorIds.map((id, index) => ({
    agentId: id,
    name: lineageAncestorAgents[index]?.name ?? id,
  }))

  // Read-only treasury view: balance + recent settlement transactions. The
  // wallet is only created lazily on first settlement, so absence is normal.
  const projectWallet = await getProjectWalletForResource(project.id).catch(() => null)
  const [projectWalletBalance, projectWalletHistory, projectExpenseHistory] = projectWallet
    ? await Promise.all([
        getWalletBalance(projectWallet.id).catch(() => null),
        getTransactionHistory(projectWallet.id, { limit: 10 }).catch(() => ({ transactions: [], total: 0 })),
        getTransactionHistory(projectWallet.id, { limit: 10, type: "project_expense" }).catch(() => ({ transactions: [], total: 0 })),
      ])
    : [null, { transactions: [], total: 0 }, { transactions: [], total: 0 }]

  // ── Stake distribution preview (read-only) ───────────────────────────────
  // Show how a sample sale's seller-net cascades per the authoritative config
  // on the project resource. `resolveSettlementSplits` reads the resources row
  // directly, so this preview reflects exactly what settlement will do.
  // ── Stock tab data ── tangible-stock resources linked to this project via
  // metadata.projectId, plus the editable Needs list on the project's own
  // resource metadata. Managing needs uses the same gate as the Jobs tab.
  const stockInventory = toStockInventory(await getResourcesByProjectId(project.id).catch(() => []))
  const projectStockNeeds = extractStockNeeds(agent.metadata as Record<string, unknown>)

  const previewSplits = projectOwnerAgentId
    ? await resolveSettlementSplits({
        sellerId: projectOwnerAgentId,
        listingMeta: { projectId: project.id },
      }).catch(() => [])
    : []
  const previewAllocations =
    previewSplits.length > 0 ? allocateByBps(STAKE_PREVIEW_SAMPLE_CENTS, previewSplits) : []
  const previewNameMap = new Map<string, string>()
  if (projectOwnerAgentId && owner?.name) previewNameMap.set(projectOwnerAgentId, owner.name)
  for (const option of recipientOptions) previewNameMap.set(option.id, option.name)
  const unknownPreviewIds = Array.from(
    new Set(previewAllocations.map((alloc) => alloc.ownerAgentId).filter((id) => !previewNameMap.has(id))),
  )
  const unknownPreviewAgents = await Promise.all(
    unknownPreviewIds.map((id) => fetchAgent(id).catch(() => null)),
  )
  for (const previewAgent of unknownPreviewAgents) {
    if (previewAgent) previewNameMap.set(previewAgent.id, previewAgent.name)
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        />
      ) : null}
      {/* Back navigation link */}
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to home
      </Link>

      {/* Main project header card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-2xl">{project.name}</CardTitle>
              {project.description ? (
                <p className="text-muted-foreground">{project.description}</p>
              ) : null}
            </div>
            <Badge variant={badgeVariant}>{statusLabel}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Status progress bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Progress</span>
              <span>{taskBasedProgress}%</span>
            </div>
            <Progress value={taskBasedProgress} className="h-2" />
          </div>

          {/* Quick stats row */}
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Users className="h-4 w-4" />
              {project.memberCount || members.length || 0} members
            </span>
            <span className="inline-flex items-center gap-2">
              <Briefcase className="h-4 w-4" />
              {linkedJobCount} job{linkedJobCount !== 1 ? "s" : ""}
            </span>
            <span className="inline-flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500" />
              {earnedPoints}/{totalPoints} points
            </span>
            {totalProjectTimeMs > 0 ? (
              <span className="inline-flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {formatTotalTimeMs(totalProjectTimeMs)} logged
              </span>
            ) : null}
            <span className="inline-flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              {project.location || "Location not provided"}
            </span>
            <span className="inline-flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              {new Date(project.createdAt).toLocaleDateString()}
            </span>
          </div>

          {/* Chapter tags */}
          {project.chapterTags?.length ? (
            <div className="flex flex-wrap gap-2">
              {project.chapterTags.map((tag) => (
                <Badge key={tag} variant="secondary">{tag}</Badge>
              ))}
            </div>
          ) : null}

          {/* General tags */}
          {project.tags?.length ? (
            <div className="flex flex-wrap gap-2">
              {project.tags.map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              ))}
            </div>
          ) : null}

          {/* Admin edit/add-job/delete actions (server-computed authority) */}
          <ProjectActions
            projectId={project.id}
            projectName={project.name}
            projectDescription={project.description}
            ownerId={ownerId}
            timeframeStart={typeof (projectMeta2.timeframe as { start?: string } | undefined)?.start === "string" ? (projectMeta2.timeframe as { start?: string }).start : null}
            timeframeEnd={typeof (projectMeta2.timeframe as { end?: string } | undefined)?.end === "string" ? (projectMeta2.timeframe as { end?: string }).end : null}
            budget={typeof projectMeta2.budget === "number" ? projectMeta2.budget : null}
            canManage={isAdmin}
          />
        </CardContent>
      </Card>

      {/* Tabbed content */}
      <Tabs defaultValue="about">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="jobs">Jobs ({linkedJobCount})</TabsTrigger>
          <TabsTrigger value="team">Team ({members.length})</TabsTrigger>
          <TabsTrigger value="treasury">Treasury</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
        </TabsList>

        {/* ── About Tab ─────────────────────────────────────────────────── */}
        <TabsContent value="about" className="space-y-4 mt-4">
          {/* Owner / project lead card */}
          {owner ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Project Lead</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/profile/${(owner.metadata?.username as string) || owner.id}`}
                  className="inline-flex items-center gap-3 hover:opacity-80 transition-opacity"
                >
                  <Image
                    src={owner.image || "/placeholder-user.jpg"}
                    alt={owner.name}
                    width={40}
                    height={40}
                    className="rounded-full object-cover"
                  />
                  <div>
                    <p className="text-sm font-medium leading-none">{owner.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">Project lead</p>
                  </div>
                </Link>
              </CardContent>
            </Card>
          ) : null}

          {/* Event Workstreams card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Event Workstreams</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{linkedEvents.length} event{linkedEvents.length !== 1 ? "s" : ""}</Badge>
                <Badge variant="secondary">{linkedJobCount} job{linkedJobCount !== 1 ? "s" : ""}</Badge>
                <Badge variant="secondary">{linkedTaskCount} task{linkedTaskCount !== 1 ? "s" : ""}</Badge>
              </div>
              {linkedEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events are linked to this project yet.</p>
              ) : (
                <div className="grid gap-3">
                  {linkedEvents.map((event) => {
                    const meta = (event.metadata ?? {}) as Record<string, unknown>
                    const financialSummary = meta.financialSummary && typeof meta.financialSummary === "object"
                      ? (meta.financialSummary as Record<string, unknown>)
                      : null
                    const revenueCents = typeof financialSummary?.revenueCents === "number" ? financialSummary.revenueCents : 0
                    const payoutCents = typeof financialSummary?.payoutsCents === "number" ? financialSummary.payoutsCents : 0
                    return (
                      <Link
                        key={event.id}
                        href={`/events/${event.id}`}
                        className="rounded-lg border p-4 hover:bg-accent/40 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{event.name}</p>
                            <p className="text-sm text-muted-foreground mt-1">{event.description || "No description yet."}</p>
                          </div>
                          <Badge variant="outline">
                            {formatProjectDate(typeof meta.date === "string" ? meta.date : typeof meta.startDate === "string" ? meta.startDate : event.createdAt)}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <Badge variant="secondary">
                            Revenue {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(revenueCents / 100)}
                          </Badge>
                          <Badge variant="secondary">
                            Payouts {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(payoutCents / 100)}
                          </Badge>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Activity feed card */}
          {activity.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {activity.map((entry) => {
                    const VerbIcon = VERB_ICON_MAP[entry.verb] ?? Briefcase
                    const description =
                      typeof entry.metadata?.description === "string"
                        ? entry.metadata.description
                        : `${entry.verb} on ${entry.objectType || "item"}`

                    return (
                      <div key={entry.id} className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                          <VerbIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{description}</p>
                          <p className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-1">
                            <Clock className="h-3 w-3" />
                            {formatRelativeTime(entry.timestamp)}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        {/* ── Jobs Tab ──────────────────────────────────────────────────── */}
        <TabsContent value="jobs" className="mt-4">
          <ProjectJobsTab
            jobs={jobsWithTasks}
            totalPoints={totalPoints}
            earnedPoints={earnedPoints}
            timersByJobId={timersByJobId}
            totalProjectTimeMs={totalProjectTimeMs}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
          />
        </TabsContent>

        {/* ── Team Tab ──────────────────────────────────────────────────── */}
        <TabsContent value="team" className="space-y-4 mt-4">
          {/* Lead + QA roles (claim → attest rail authority) */}
          {projectRoles ? <ProjectRolesCard roles={projectRoles} /> : null}
          {/* Project owner */}
          {owner ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Project Lead</CardTitle>
              </CardHeader>
              <CardContent>
                <Link
                  href={`/profile/${(owner.metadata?.username as string) || owner.id}`}
                  className="inline-flex items-center gap-3 hover:opacity-80 transition-opacity"
                >
                  <Image
                    src={owner.image || "/placeholder-user.jpg"}
                    alt={owner.name}
                    width={40}
                    height={40}
                    className="rounded-full object-cover"
                  />
                  <div>
                    <p className="text-sm font-medium leading-none">{owner.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">Project lead</p>
                  </div>
                </Link>
              </CardContent>
            </Card>
          ) : null}

          {/* Members grid */}
          {members.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  Members
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    ({members.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                  {visibleMembers.map((member) => (
                    <Link
                      key={member.id}
                      href={`/profile/${(member.metadata?.username as string) || member.id}`}
                      className="flex flex-col items-center gap-2 hover:opacity-80 transition-opacity"
                    >
                      <Image
                        src={member.image || "/placeholder-user.jpg"}
                        alt={member.name}
                        width={40}
                        height={40}
                        className="rounded-full object-cover"
                      />
                      <span className="text-xs text-center truncate max-w-[80px]">{member.name}</span>
                    </Link>
                  ))}
                  {overflowCount > 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                        +{overflowCount}
                      </div>
                      <span className="text-xs text-muted-foreground">more</span>
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <Users className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                <p className="text-muted-foreground">No team members have joined this project yet.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Treasury / Distribution Tab ───────────────────────────────── */}
        <TabsContent value="treasury" className="space-y-4 mt-4">
          {/* Project treasury balance + recent settlements (read-only). */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Project Treasury</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Balance</span>
                <span className="text-2xl font-semibold">
                  {new Intl.NumberFormat("en-US", { style: "currency", currency: (projectWalletBalance?.currency || "USD").toUpperCase() }).format((projectWalletBalance?.balanceCents ?? 0) / 100)}
                </span>
              </div>
              {projectWalletBalance && (projectWalletBalance.pendingSettlementCents ?? 0) > 0 ? (
                <p className="text-xs text-muted-foreground text-right">
                  {new Intl.NumberFormat("en-US", { style: "currency", currency: (projectWalletBalance.currency || "USD").toUpperCase() }).format((projectWalletBalance.pendingSettlementCents ?? 0) / 100)} pending settlement
                </p>
              ) : null}
              <div className="space-y-2">
                <p className="text-sm font-medium">Recent settlements</p>
                {projectWalletHistory.transactions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No settlements yet. Sales of offerings bound to this project will appear here.
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {projectWalletHistory.transactions.map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{tx.description || tx.type}</p>
                          <p className="text-xs text-muted-foreground">{formatRelativeTime(tx.createdAt)}</p>
                        </div>
                        <span className="font-medium whitespace-nowrap">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(tx.amountCents / 100)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Read-only Stake distribution preview — how a sample sale cascades. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Stake distribution preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                On a sample {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(STAKE_PREVIEW_SAMPLE_CENTS / 100)} sale of a project-bound offering, the seller-net cascades as:
              </p>
              {previewAllocations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No distribution configured yet — the project treasury keeps the full seller-net.
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {previewAllocations.map((alloc, index) => (
                    <div key={`${alloc.ownerAgentId}-${alloc.role}-${index}`} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="text-sm truncate">
                          {alloc.walletKind === "project"
                            ? SETTLEMENT_ROLE_LABEL.project
                            : previewNameMap.get(alloc.ownerAgentId) ?? alloc.ownerAgentId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {SETTLEMENT_ROLE_LABEL[alloc.role]} · {(alloc.bps / 100).toFixed(2)}%
                        </p>
                      </div>
                      <span className="font-medium whitespace-nowrap">
                        {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(alloc.amountCents / 100)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <ProjectExpensePanel
            projectId={project.id}
            groupId={ownerId ?? null}
            currency={(projectWalletBalance?.currency || "USD").toUpperCase()}
            balanceCents={projectWalletBalance?.balanceCents ?? 0}
            canManage={isAdmin}
            initialExpenses={projectExpenseHistory.transactions.map((tx) => ({
              id: tx.id,
              amountCents: tx.amountCents,
              description: tx.description ?? null,
              createdAt: tx.createdAt,
              status: tx.status,
            }))}
          />

          <ProjectDistributionTab
            projectId={project.id}
            ownerId={projectOwnerAgentId}
            ownerName={owner?.name ?? null}
            initialDistribution={distributionConfig}
            recipientOptions={recipientOptions}
            isAdmin={isAdmin}
            lineage={{
              explicit: projectLineageConfig.explicit ?? false,
              enabled: effectiveLineageConfig.enabled,
              levelBps: effectiveLineageConfig.levelBps ?? [],
              defaultPerHopBps: DEFAULT_LINEAGE_CASCADE_BPS,
              ancestors: lineageAncestors,
            }}
          />
        </TabsContent>

        {/* ── Stock Tab ─────────────────────────────────────────────────── */}
        <TabsContent value="stock" className="mt-4">
          <StockTab
            parentType="project"
            parentId={project.id}
            inventory={stockInventory}
            initialNeeds={projectStockNeeds}
            canManage={isAdmin}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
