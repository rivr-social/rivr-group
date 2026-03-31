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
 * Auth: Uses a hardcoded `currentUserId` mock; no server-side auth gate.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module jobs/[id]/page
 */
import { getShifts, getProjects, getUserBadgeIds } from "@/lib/queries/resources"
import { JobDetailClient } from "./job-detail"

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const jobId = params.id as string
  const currentUserId = "user1" // In a real app, this would come from auth

  const [jobShifts, projects, userBadgeIds] = await Promise.all([
    getShifts(),
    getProjects(),
    getUserBadgeIds(currentUserId),
  ])

  return (
    <JobDetailClient
      jobId={jobId}
      jobShifts={jobShifts}
      projects={projects}
      userBadgeIds={userBadgeIds}
    />
  )
}
