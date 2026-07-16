/**
 * Job detail page for `/jobs/[id]`.
 *
 * Purpose:
 * - Displays a single job/shift with header stats, progress bar, and
 *   tabbed sections for About, Tasks, and Timer.
 *
 * Rendering: Server Component (fetches data) wrapping a client component for interactivity.
 * Data requirements:
 * - Fetches shifts, projects, and user badge IDs from the database.
 *
 * Auth: Public route. Badge permissions are derived from the server-side
 *   `auth()` session when present; anonymous visitors resolve to no badges.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module jobs/[id]/page
 */
import { getCurrentUserId } from "@/app/actions/interactions/helpers"
import { getAuthenticatedActorId } from "@/lib/server-auth"
import { getJobById, getShifts, getProjects, getUserBadgeIds, getResource, getResourcesByJobId } from "@/lib/queries/resources"
import { getAgentsByIds } from "@/lib/queries/agents"
import { getJobClaimPanelData } from "@/app/actions/interactions/project-team"
import { getJobShareData } from "@/app/actions/job-peer-allocation"
import { hasGroupWriteAccess } from "@/app/actions/create-resources"
import { fetchGroupLineage, fetchPublicAgentById } from "@/app/actions/graph"
import { extractStockNeeds, toStockInventory } from "@/lib/stock"
import { buildContainmentChain, type BreadcrumbNode } from "@/lib/breadcrumbs"
import { JobDetailClient } from "./job-detail"

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const jobId = params.id as string
  // Unified session (local or federated remote-viewer, normalized to a local
  // agent id) so sovereign-homed admins get their claim/edit affordances.
  // getCurrentUserId covers local + federated *sessions* only; an SSO-landed
  // admin holds just the remote-viewer COOKIE, which only
  // getAuthenticatedActorId reads — without the fallback they render as
  // anonymous and lose every manage/attest affordance.
  const currentUserId = (await getCurrentUserId()) ?? (await getAuthenticatedActorId())

  // Fetch the job DIRECTLY by id (type job OR legacy shift). Resolving via
  // getShifts() alone capped at 100 rows and 404'd every older job.
  const [job, jobShifts, projects, userBadgeIds, claimPanel, jobResource, stockResources, share] = await Promise.all([
    getJobById(jobId),
    getShifts(),
    getProjects(),
    currentUserId ? getUserBadgeIds(currentUserId) : Promise.resolve<string[]>([]),
    getJobClaimPanelData(jobId),
    getResource(jobId).catch(() => null),
    getResourcesByJobId(jobId).catch(() => []),
    getJobShareData(jobId).catch(() => null),
  ])

  // ── Stock tab data ── inventory linked to this job (metadata.jobId), the
  // editable Needs list on the job's own resource metadata, and whether the
  // viewer may manage it (job owner OR content-write on the owning group).
  const stockInventory = toStockInventory(stockResources)
  const stockNeeds = extractStockNeeds((jobResource?.metadata ?? {}) as Record<string, unknown>)
  // Authoritative owning agent = the job RESOURCE's owner_id — the exact node
  // the server actions (markJobDoneAction / updateTaskStatus / job-management)
  // enforce against. The domain `job.groupId` reads `metadata.groupId`, which
  // is often "" or points at a DIFFERENT group than the owner, so gating the
  // admin UI on it silently hid the panel from admins the server would happily
  // authorize (and `hasGroupWriteAccess` was skipped entirely on an empty
  // groupId). `hasGroupWriteAccess` cascades via `isGroupAdmin`, so a
  // parent-group admin passes here for a subgroup-owned job.
  const owningAgentId = jobResource?.ownerId ?? (job?.groupId || null)
  const stockCanManage = Boolean(
    currentUserId &&
      owningAgentId &&
      (owningAgentId === currentUserId ||
        job?.createdBy === currentUserId ||
        (await hasGroupWriteAccess(currentUserId, owningAgentId))),
  )
  // Same authority set gates the admin panel (edit / add task / mark done).
  const canManage = stockCanManage

  // Attestation authority (claim → attest rail): group authority PLUS the
  // project lead / QA resolved from the job's project. Server-computed — the
  // client user-context cannot see federated remote-viewer sessions.
  let canAttest = canManage
  if (!canAttest && currentUserId && owningAgentId) {
    const { resolveProjectAuthority, canAttestWork } = await import("@/lib/work-completion")
    const jobMeta = (jobResource?.metadata ?? {}) as Record<string, unknown>
    const authority = await resolveProjectAuthority({
      targetType: "job",
      jobId,
      projectId: typeof jobMeta.projectId === "string" ? jobMeta.projectId : null,
    })
    canAttest = await canAttestWork(currentUserId, owningAgentId, authority)
  }

  // Admin QA review data (recorded work periods + claims + attested points +
  // discrepancies). Server-computed authority; null for non-admins. Only
  // fetched when the viewer can manage or attest — the action re-checks anyway.
  const { getJobQaReviewData } = await import("@/app/actions/job-qa")
  const reviewData = canManage || canAttest ? await getJobQaReviewData(jobId).catch(() => null) : null

  // Payout-release state (drives the admin "Release payment" button). Once every
  // job-payout receipt has settled a real Stripe transfer, the button becomes a
  // "Paid ✓" indicator instead of a live release control. Only computed for
  // managers (the only viewers who see the button).
  const { getJobPayoutReleaseState } = await import("@/app/actions/job-completion")
  const payoutState = canManage ? await getJobPayoutReleaseState(jobId).catch(() => null) : null
  const payoutReleased = payoutState?.allPaid ?? false

  // Hierarchical breadcrumb (group → subgroup → project → job), computed
  // server-side from the true containment: the job resource's owning agent
  // (owner_id) → its group lineage, then the linked project. Client state can't
  // see the owner/lineage, so this is resolved here and passed down.
  const jobMetaForCrumbs = (jobResource?.metadata ?? {}) as Record<string, unknown>
  const breadcrumbProjectId =
    typeof jobMetaForCrumbs.projectId === "string" && jobMetaForCrumbs.projectId.length > 0
      ? jobMetaForCrumbs.projectId
      : null
  const breadcrumbProject = breadcrumbProjectId
    ? projects.find((p) => p.id === breadcrumbProjectId) ?? null
    : null
  // Assignee display names for the About tab's Team Members list. The domain
  // JobShift carries only agent ids in `assignees`; resolve them to names
  // server-side (same source the Review tab uses) so claimants render as their
  // name instead of a raw UUID. Falls back to the id when no agent row exists.
  const assigneeNames: Record<string, string> = {}
  const assigneeIds = job?.assignees ?? []
  if (assigneeIds.length > 0) {
    const assigneeAgents = await getAgentsByIds(assigneeIds).catch(() => [])
    for (const agent of assigneeAgents) assigneeNames[agent.id] = agent.name
  }

  let breadcrumbItems: BreadcrumbNode[] = []
  if (owningAgentId && job) {
    const [ownerLineage, ownerAgent] = await Promise.all([
      fetchGroupLineage(owningAgentId).catch(() => []),
      fetchPublicAgentById(owningAgentId).catch(() => null),
    ])
    const ancestors: BreadcrumbNode[] = [
      ...ownerLineage.map((a) => ({ id: a.id, label: a.name, href: `/groups/${a.id}` })),
      ...(ownerAgent
        ? [{ id: owningAgentId, label: ownerAgent.name, href: `/groups/${owningAgentId}` }]
        : []),
      ...(breadcrumbProject
        ? [{ id: breadcrumbProject.id, label: breadcrumbProject.title, href: `/projects/${breadcrumbProject.id}` }]
        : []),
    ]
    breadcrumbItems = buildContainmentChain(ancestors, { id: jobId, label: job.title })
  }

  return (
    <JobDetailClient
      jobId={jobId}
      initialJob={job}
      jobShifts={jobShifts}
      projects={projects}
      userBadgeIds={userBadgeIds}
      currentUserId={currentUserId}
      claimPanel={claimPanel}
      stockInventory={stockInventory}
      stockNeeds={stockNeeds}
      stockCanManage={stockCanManage}
      canManage={canManage}
      canAttest={canAttest}
      assigneeNames={assigneeNames}
      share={share}
      reviewData={reviewData}
      payoutReleased={payoutReleased}
      breadcrumbItems={breadcrumbItems}
    />
  )
}
