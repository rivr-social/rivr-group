import { getBadgeDefinitions, getShifts } from "@/lib/queries/resources"
import { BadgesPageClient } from "./badges-page"
import { auth } from "@/auth"
import { fetchUserBadges } from "@/app/actions/graph"

export default async function BadgesPage() {
  const session = await auth()
  const userId = session?.user?.id

  const [allBadges, jobShifts, userBadgeResources] = await Promise.all([
    getBadgeDefinitions(),
    getShifts(),
    userId ? fetchUserBadges(userId) : Promise.resolve([]),
  ])

  // Map serialized badge resources to UserBadge shape for the client
  const userBadges = allBadges.filter((badge) =>
    userBadgeResources.some((r) => r.id === badge.id)
  )

  return (
    <BadgesPageClient
      allBadges={allBadges}
      userBadges={userBadges}
      jobShifts={jobShifts}
    />
  )
}
