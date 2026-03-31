/**
 * @fileoverview RingFeed - Displays a list of ring (circle/trust-ring) groups.
 *
 * Used on the rings listing page. Shows ring cards with member previews,
 * activity indicators, and search/filter controls.
 */
"use client"

import { useState, useMemo } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { MapPin, Users, Network } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TypeBadge } from "@/components/type-badge"
import { TypeIcon } from "@/components/type-icon"
import Link from "next/link"
import type { Ring, Family, User } from "@/lib/types"

interface RingFeedProps {
  rings?: Ring[]
  families?: Family[]
  getMembers?: (memberIds: string[]) => User[]
  onJoinRing?: (ringId: string) => void
  initialJoinedRings?: string[]
  maxRings?: number
  query?: string
  chapterId?: string
}

export function RingFeed({
  rings,
  families,
  getMembers,
  onJoinRing,
  initialJoinedRings = [],
  maxRings,
  query = "",
  chapterId = "all",
}: RingFeedProps) {
  const [joinedRings, setJoinedRings] = useState<string[]>(initialJoinedRings)

  const filteredRings = useMemo(() => {
    let ringsToUse = rings ?? []

    // Filter by query if provided
    if (query) {
      const lowerQuery = query.toLowerCase()
      ringsToUse = ringsToUse.filter(
        (ring) => ring.name.toLowerCase().includes(lowerQuery) || ring.description.toLowerCase().includes(lowerQuery),
      )
    }

    // Filter by chapter if provided and not "all"
    if (chapterId && chapterId !== "all") {
      ringsToUse = ringsToUse.filter((ring) => ring.chapterTags?.includes(chapterId))
    }

    // Apply maxRings limit if provided
    if (maxRings) {
      ringsToUse = ringsToUse.slice(0, maxRings)
    }

    return ringsToUse
  }, [rings, query, chapterId, maxRings])

  const handleJoinRing = (ringId: string) => {
    const newJoinedRings = joinedRings.includes(ringId)
      ? joinedRings.filter((id) => id !== ringId)
      : [...joinedRings, ringId]

    setJoinedRings(newJoinedRings)

    if (onJoinRing) {
      onJoinRing(ringId)
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

  // Get families for a ring
  const getFamiliesForRing = (ringId: string) => {
    const familiesToUse = families ?? []
    return familiesToUse.filter((family) => family.parentRingId === ringId)
  }

  return (
    <div className="space-y-4 mt-4">
      {filteredRings.map((ring) => {
        const ringFamilies = getFamiliesForRing(ring.id)
        const totalMembers = ringFamilies.reduce((sum, family) => sum + (family.members?.length || 0), 0)
        const isJoined = joinedRings.includes(ring.id)

        return (
          <Card key={ring.id} className="border shadow-sm">
            <CardHeader className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <Avatar className="h-12 w-12 border-2 border-gray-200">
                    <AvatarImage src={ring.image || "/placeholder.svg"} alt={ring.name} />
                    <AvatarFallback>{ring.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <Link href={`/rings/${ring.id}`} className="text-xl font-bold hover:underline">
                      {ring.name}
                    </Link>
                  </div>
                </div>
                <div className="flex items-center">
                  <TypeIcon type="ring" size={18} className="mr-2" />
                  <TypeBadge type="ring" showIcon={false} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <p className="text-muted-foreground mb-4">{ring.description}</p>
              <div className="space-y-2">
                <div className="flex items-center text-sm">
                  <MapPin className="h-4 w-4 mr-2 text-purple-600" />
                  <span>{(ring.chapterTags?.[0] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ring.chapterTags[0]) ? ring.chapterTags[0] : null) || "Location not specified"}</span>
                </div>
                <div className="flex items-center text-sm">
                  <Network className="h-4 w-4 mr-2 text-purple-600" />
                  <span>{ringFamilies.length} families</span>
                </div>
                <div className="flex items-center text-sm">
                  <Users className="h-4 w-4 mr-2 text-purple-600" />
                  <span>{totalMembers} total members</span>
                </div>
              </div>

              {/* Show families preview */}
              {ringFamilies.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium mb-2">Families in this Ring:</h4>
                  <div className="flex flex-wrap gap-2">
                    {ringFamilies.slice(0, 3).map((family) => (
                      <Link
                        key={family.id}
                        href={`/families/${family.id}`}
                        className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-purple-100 text-purple-800 hover:bg-purple-200"
                      >
                        {family.name} ({family.members?.length || 0})
                      </Link>
                    ))}
                    {ringFamilies.length > 3 && (
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-600">
                        +{ringFamilies.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
            <CardFooter className="p-4 pt-0 flex justify-between items-center bg-gray-50">
              <div className="flex -space-x-2">
                {/* Show avatars from first few families */}
                {ringFamilies.slice(0, 3).map((family) => {
                  const familyMembers = getMembersFunction(family.members?.slice(0, 2) || [])
                  return familyMembers.map((member, i) => (
                    <Avatar key={`${family.id}-${i}`} className="border-2 border-white h-8 w-8">
                      <AvatarImage src={member.avatar || "/placeholder.svg"} alt={member.name} />
                      <AvatarFallback>{member.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                  ))
                })}
                {totalMembers > 6 && (
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-muted text-xs font-medium border-2 border-white">
                    +{totalMembers - 6}
                  </div>
                )}
              </div>
              <Button
                className={
                  isJoined ? "bg-gray-200 hover:bg-gray-300 text-gray-700" : "bg-purple-600 hover:bg-purple-700"
                }
                onClick={() => handleJoinRing(ring.id)}
              >
                {isJoined ? "Joined" : "Join Ring"}
              </Button>
            </CardFooter>
          </Card>
        )
      })}

      {filteredRings.length === 0 && <div className="text-center py-8 text-muted-foreground">No rings found</div>}
    </div>
  )
}
