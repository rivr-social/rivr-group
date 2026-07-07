import { notFound } from "next/navigation"
import { getBadgeDefinitions, userHasBadge, getShifts } from "@/lib/queries/resources"
import { BadgeDetailClient } from "./badge-detail"
import { auth } from "@/auth"
import { isUuid } from "@/app/actions/graph/types"

export default async function BadgeDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const badgeId = params.id as string
  // Any non-UUID path segment (e.g. /badges/create — there is no such route)
  // used to fall into this dynamic route and crash the server component with
  // an invalid-uuid DB error (persona finding, 2026-07-07). 404 instead.
  if (!isUuid(badgeId)) {
    notFound()
  }
  const session = await auth()
  const userId = session?.user?.id

  const [allBadges, isEarned, jobShifts] = await Promise.all([
    getBadgeDefinitions(),
    userId ? userHasBadge(userId, badgeId) : Promise.resolve(false),
    getShifts(),
  ])

  return (
    <BadgeDetailClient
      badgeId={badgeId}
      allBadges={allBadges}
      isEarned={isEarned}
      jobShifts={jobShifts}
    />
  )
}
