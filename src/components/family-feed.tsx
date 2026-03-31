"use client"

import { useState, useMemo } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { MapPin, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TypeBadge } from "@/components/type-badge"
import { TypeIcon } from "@/components/type-icon"
import Link from "next/link"
import type { Family, Ring, User } from "@/lib/types"

/**
 * Family discovery/feed list used in browse and ring/chapter filtered family views.
 * Key props:
 * - `families`: source family records to render.
 * - `rings`: optional ring metadata used to label each family's parent ring.
 * - `getMembers`: optional resolver for member profile display data.
 * - `onJoinFamily`: optional callback when a join/unjoin action is triggered.
 * - `initialJoinedFamilies`, `maxFamilies`, `query`, `chapterId`, `ringId`: UI filtering and display controls.
 */
interface FamilyFeedProps {
  families?: Family[]
  rings?: Ring[]
  getMembers?: (memberIds: string[]) => User[]
  onJoinFamily?: (familyId: string) => void
  initialJoinedFamilies?: string[]
  maxFamilies?: number
  query?: string
  chapterId?: string
  ringId?: string
}

/**
 * Renders a filterable list of family cards with membership actions.
 *
 * @param {FamilyFeedProps} props - Component props.
 * @param {Family[]} [props.families] - Family records to display.
 * @param {Ring[]} [props.rings] - Ring records used for parent ring labels.
 * @param {(memberIds: string[]) => User[]} [props.getMembers] - Optional member lookup helper.
 * @param {(familyId: string) => void} [props.onJoinFamily] - Optional join/unjoin callback.
 * @param {string[]} [props.initialJoinedFamilies=[]] - Initial local joined-family IDs.
 * @param {number} [props.maxFamilies] - Optional render limit.
 * @param {string} [props.query=""] - Search text for name/description filtering.
 * @param {string} [props.chapterId="all"] - Chapter filter key.
 * @param {string} [props.ringId] - Parent ring filter key.
 */
export function FamilyFeed({
  families,
  rings,
  getMembers,
  onJoinFamily,
  initialJoinedFamilies = [],
  maxFamilies,
  query = "",
  chapterId = "all",
  ringId,
}: FamilyFeedProps) {
  // Local UI state tracks membership toggles for join button presentation.
  const [joinedFamilies, setJoinedFamilies] = useState<string[]>(initialJoinedFamilies)

  const filteredFamilies = useMemo(() => {
    // Start from provided families and progressively apply ring/search/chapter/limit filters.
    let familiesToUse = families ?? []

    // Filter by ring if provided
    if (ringId) {
      familiesToUse = familiesToUse.filter((family) => family.parentRingId === ringId)
    }

    // Filter by query if provided
    if (query) {
      const lowerQuery = query.toLowerCase()
      familiesToUse = familiesToUse.filter(
        (family) =>
          family.name.toLowerCase().includes(lowerQuery) || family.description.toLowerCase().includes(lowerQuery),
      )
    }

    // Filter by chapter if provided and not "all"
    if (chapterId && chapterId !== "all") {
      familiesToUse = familiesToUse.filter((family) => family.chapterTags?.includes(chapterId))
    }

    // Apply maxFamilies limit if provided
    if (maxFamilies) {
      familiesToUse = familiesToUse.slice(0, maxFamilies)
    }

    return familiesToUse
  }, [families, query, chapterId, maxFamilies, ringId])

  const handleJoinFamily = (familyId: string) => {
    // Toggle membership locally to provide immediate UI feedback.
    const newJoinedFamilies = joinedFamilies.includes(familyId)
      ? joinedFamilies.filter((id) => id !== familyId)
      : [...joinedFamilies, familyId]

    setJoinedFamilies(newJoinedFamilies)

    if (onJoinFamily) {
      // Optional side effect hook for parent-managed membership behavior.
      onJoinFamily(familyId)
    }
  }

  // Default getMembers function if not provided
  const defaultGetMembers = (memberIds: string[]) => {
    return memberIds.map((id) => ({
      id,
      name: "Unknown User",
      username: "unknown",
      avatar: undefined,
      followers: 0,
      following: 0,
    }))
  }

  const getMembersFunction = getMembers || defaultGetMembers

  // Get ring name for a family
  const getRingName = (parentRingId: string) => {
    const ringsToUse = rings ?? []
    const ring = ringsToUse.find((r) => r.id === parentRingId)
    return ring?.name || "Unknown Ring"
  }

  return (
    <div className="space-y-4 mt-4">
      {filteredFamilies.map((family) => {
        // Derive card-level display values from the family and current local state.
        const memberCount = family.members?.length || 0
        const memberAvatars = getMembersFunction(family.members?.slice(0, 3) || [])
        const isJoined = joinedFamilies.includes(family.id)
        const ringName = getRingName(family.parentRingId)

        return (
          <Card key={family.id} className="border shadow-sm">
            <CardHeader className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <Avatar className="h-12 w-12 border-2 border-border">
                    <AvatarImage src={family.image || "/placeholder.svg"} alt={family.name} />
                    <AvatarFallback>{family.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <Link href={`/families/${family.id}`} className="text-xl font-bold hover:underline">
                      {family.name}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      Part of{" "}
                      <Link href={`/rings/${family.parentRingId}`} className="text-purple-600 hover:underline">
                        {ringName}
                      </Link>
                    </p>
                  </div>
                </div>
                <div className="flex items-center">
                  <TypeIcon type="family" size={18} className="mr-2" />
                  <TypeBadge type="family" showIcon={false} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <p className="text-muted-foreground mb-4">{family.description}</p>
              <div className="space-y-2">
                <div className="flex items-center text-sm">
                  <MapPin className="h-4 w-4 mr-2 text-orange-600" />
                  <span>{(family.chapterTags?.[0] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(family.chapterTags[0]) ? family.chapterTags[0] : null) || "Location not specified"}</span>
                </div>
                <div className="flex items-center text-sm">
                  <Users className="h-4 w-4 mr-2 text-orange-600" />
                  <span>{memberCount} members</span>
                </div>
              </div>
            </CardContent>
            <CardFooter className="p-4 pt-0 flex justify-between items-center bg-muted/50">
              <div className="flex -space-x-2">
                {memberAvatars.map((member, i) => (
                  <Avatar key={i} className="border-2 border-background h-8 w-8">
                    <AvatarImage src={"avatar" in member ? member.avatar || "/placeholder.svg" : "/placeholder.svg"} alt={member.name} />
                    <AvatarFallback>{member.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                ))}
                {memberCount > 3 && (
                  // Conditional render: overflow indicator when more than three members exist.
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-muted text-xs font-medium border-2 border-background">
                    +{memberCount - 3}
                  </div>
                )}
              </div>
              <Button
                className={
                  isJoined ? "bg-secondary hover:bg-secondary/80 text-secondary-foreground" : "bg-orange-600 hover:bg-orange-700 text-white"
                }
                onClick={() => handleJoinFamily(family.id)}
              >
                {isJoined ? "Joined" : "Join Family"}
              </Button>
            </CardFooter>
          </Card>
        )
      })}

      {/* Conditional render: empty state when no families match active filters. */}
      {filteredFamilies.length === 0 && <div className="text-center py-8 text-muted-foreground">No families found</div>}
    </div>
  )
}
