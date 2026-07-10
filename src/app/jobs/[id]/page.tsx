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
import { getJobById, getShifts, getProjects, getUserBadgeIds, getResource, getResourcesByJobId } from "@/lib/queries/resources"
import { getJobClaimPanelData } from "@/app/actions/interactions/project-team"
import { getJobShareData } from "@/app/actions/job-peer-allocation"
import { hasGroupWriteAccess } from "@/app/actions/create-resources"
import { extractStockNeeds, toStockInventory } from "@/lib/stock"
import { JobDetailClient } from "./job-detail"

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const jobId = params.id as string
  // Unified session (local or federated remote-viewer, normalized to a local
  // agent id) so sovereign-homed admins get their claim/edit affordances.
  const currentUserId = await getCurrentUserId()

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
  const stockCanManage = currentUserId
    ? job?.createdBy === currentUserId ||
      (!!job?.groupId && (await hasGroupWriteAccess(currentUserId, job.groupId)))
    : false
  // Same authority set gates the admin panel (edit / add task / mark done).
  const canManage = stockCanManage

  // Attestation authority (claim → attest rail): group authority PLUS the
  // project lead / QA resolved from the job's project. Server-computed — the
  // client user-context cannot see federated remote-viewer sessions.
  let canAttest = canManage
  if (!canAttest && currentUserId && job?.groupId) {
    const { resolveProjectAuthority, canAttestWork } = await import("@/lib/work-completion")
    const jobMeta = (jobResource?.metadata ?? {}) as Record<string, unknown>
    const authority = await resolveProjectAuthority({
      targetType: "job",
      jobId,
      projectId: typeof jobMeta.projectId === "string" ? jobMeta.projectId : null,
    })
    canAttest = await canAttestWork(currentUserId, job.groupId, authority)
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
      share={share}
    />
  )
}
