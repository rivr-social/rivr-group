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
import { auth } from "@/auth"
import { getShifts, getProjects, getUserBadgeIds } from "@/lib/queries/resources"
import { JobDetailClient } from "./job-detail"

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const jobId = params.id as string
  const session = await auth()
  const currentUserId = session?.user?.id ?? null

  const [jobShifts, projects, userBadgeIds] = await Promise.all([
    getShifts(),
    getProjects(),
    currentUserId ? getUserBadgeIds(currentUserId) : Promise.resolve<string[]>([]),
  ])

  return (
    <JobDetailClient
      jobId={jobId}
      jobShifts={jobShifts}
      projects={projects}
      userBadgeIds={userBadgeIds}
      currentUserId={currentUserId}
    />
  )
}
