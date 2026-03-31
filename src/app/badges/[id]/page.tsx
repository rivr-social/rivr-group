import { getBadgeDefinitions, userHasBadge, getShifts } from "@/lib/queries/resources"
import { BadgeDetailClient } from "./badge-detail"
import { auth } from "@/auth"

export default async function BadgeDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const badgeId = params.id as string
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
