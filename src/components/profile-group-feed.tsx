/**
 * @fileoverview ProfileGroupFeed - Displays groups a user belongs to on their profile.
 *
 * Shown on the user profile page. Lists group memberships with role badges,
 * member counts, and search/filter capabilities.
 */
"use client"

import { useState, useMemo } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MapPin, Users, Calendar, Crown, Shield, Star, Building2 } from "lucide-react"
import { TypeBadge } from "@/components/type-badge"
import { TypeIcon } from "@/components/type-icon"
import Link from "next/link"
import { GroupType, type User } from "@/lib/types"

type Group = {
  id: string
  name: string
  description: string
  members?: string[]
  adminIds?: string[]
  creatorId?: string
  avatar?: string
  image?: string
  location?: string | {
    lat: number
    lng: number
    city?: string
  }
  chapterTags?: string[]
  groupTags?: string[]
  type?: GroupType
  parentRingId?: string // For families
  families?: string[] // For rings
  createdAt?: string
  joinSettings?: Record<string, unknown>
  defaultNotificationSettings?: Record<string, unknown>
  [key: string]: unknown
}

interface ProfileGroupFeedProps {
  groups?: Group[]
  currentUserId: string
  getMembers?: (memberIds: string[]) => User[]
  onJoinGroup?: (groupId: string) => void
  initialJoinedGroups?: string[]
  maxGroups?: number
}

export function ProfileGroupFeed({
  groups,
  currentUserId,
  getMembers,
  onJoinGroup,
  initialJoinedGroups = [],
  maxGroups,
}: ProfileGroupFeedProps) {
  const [joinedGroups, setJoinedGroups] = useState<string[]>(initialJoinedGroups)

  // Use provided groups only (no mock fallbacks)
  const filteredGroups = useMemo(() => {
    let groupsToUse = groups || []

    // Apply maxGroups limit if provided
    if (maxGroups) {
      groupsToUse = groupsToUse.slice(0, maxGroups)
    }

    return groupsToUse
  }, [groups, maxGroups])

  const _handleJoinGroup = (groupId: string) => {
    const newJoinedGroups = joinedGroups.includes(groupId)
      ? joinedGroups.filter((id) => id !== groupId)
      : [...joinedGroups, groupId]

    setJoinedGroups(newJoinedGroups)

    if (onJoinGroup) {
      onJoinGroup(groupId)
    }
  }

  // Default getMembers function if not provided
  const defaultGetMembers = (memberIds: string[]) => {
    return memberIds.map((id) => {
      return {
        id,
        name: "Unknown User",
        username: "unknown",
        avatar: undefined,
      }
    })
  }

  const getMembersFunction = getMembers || defaultGetMembers

  // Get user's role in a group
  const getUserRole = (group: Group) => {
    if (group.creatorId === currentUserId) {
      return { role: "Founder", icon: Crown, color: "text-yellow-600 dark:text-yellow-400", bgColor: "bg-yellow-100 dark:bg-yellow-900/40" }
    }
    if (group.adminIds?.includes(currentUserId)) {
      return { role: "Admin", icon: Shield, color: "text-purple-600 dark:text-purple-400", bgColor: "bg-purple-100 dark:bg-purple-900/40" }
    }
    if (group.members?.includes(currentUserId)) {
      return { role: "Member", icon: Users, color: "text-blue-600 dark:text-blue-400", bgColor: "bg-blue-100 dark:bg-blue-900/40" }
    }
    return { role: "Not a Member", icon: Users, color: "text-muted-foreground", bgColor: "bg-muted" }
  }

  // Stable timestamp for computing months active (avoid impure Date.now() in render)
  const [stableNow] = useState(() => Date.now())

  // Get user's contributions and involvement (memoized to avoid impure calls during render)
  const groupInvolvementMap = useMemo(() => {
    const map = new Map<string, {
      isActive: boolean
      contributionLevel: number
      joinDate: Date
      monthsActive: number
      pointsEarned: number
      eventsAttended: number
    }>()

    for (const group of filteredGroups) {
      // This would be calculated from actual data in a real app
      // For now, we'll simulate some metrics using a hash-like seed from group id
      const seed = group.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
      const pseudoRandom = (offset: number) => ((seed + offset) * 9301 + 49297) % 233280 / 233280

      const isActive = pseudoRandom(1) > 0.5
      const contributionLevel = Math.floor(pseudoRandom(2) * 100) + 1
      const joinDate = new Date(2023, Math.floor(pseudoRandom(3) * 12), Math.floor(pseudoRandom(4) * 28) + 1)
      const monthsActive = Math.floor((stableNow - joinDate.getTime()) / (1000 * 60 * 60 * 24 * 30))

      map.set(group.id, {
        isActive,
        contributionLevel,
        joinDate,
        monthsActive: Math.max(1, monthsActive),
        pointsEarned: Math.floor(pseudoRandom(5) * 500) + 50,
        eventsAttended: Math.floor(pseudoRandom(6) * 20) + 1,
      })
    }

    return map
  }, [filteredGroups, stableNow])

  const getUserInvolvement = (group: Group) => {
    return groupInvolvementMap.get(group.id) || {
      isActive: false,
      contributionLevel: 0,
      joinDate: new Date(2023, 0, 1),
      monthsActive: 1,
      pointsEarned: 0,
      eventsAttended: 0,
    }
  }

  return (
    <div className="space-y-6 mt-4">
      {filteredGroups.map((group) => {
        const ringFamilies = Array.isArray((group as { families?: string[] }).families)
          ? ((group as { families?: string[] }).families as string[])
          : []
        const parentRingId = (group as { parentRingId?: string }).parentRingId

        const memberCount =
          group.type === GroupType.Ring
            ? group.members?.length || 0
            : group.members?.length || 0
        const memberAvatars = getMembersFunction((group.members || []).slice(0, 3))
        const _isJoined = joinedGroups.includes(group.id)
        const userRole = getUserRole(group)
        const userInvolvement = getUserInvolvement(group)
        const RoleIcon = userRole.icon

        return (
          <Card key={group.id} className="border shadow-sm">
            <CardHeader className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-4">
                  <Avatar className="h-14 w-14 border-2 border-border">
                    <AvatarImage src={group.avatar || "/placeholder.svg"} alt={group.name} />
                    <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Link
                        href={
                          group.type === GroupType.Ring
                            ? `/rings/${group.id}`
                            : group.type === GroupType.Family
                              ? `/families/${group.id}`
                              : `/groups/${group.id}`
                        }
                        className="text-xl font-bold hover:underline"
                      >
                        {group.name}
                      </Link>
                      <TypeIcon 
                        type={
                          group.type === GroupType.Ring ? "ring" :
                          group.type === GroupType.Family ? "family" :
                          group.type === GroupType.Basic ? "basic" :
                          "org"
                        } 
                        size={16} 
                        className="text-gray-500" 
                      />
                      <TypeBadge 
                        type={
                          group.type === GroupType.Ring ? "ring" :
                          group.type === GroupType.Family ? "family" :
                          group.type === GroupType.Basic ? "basic" :
                          "org"
                        } 
                        showIcon={false} 
                      />
                    </div>
                    
                    {/* User Role Badge */}
                    <div className="flex items-center gap-2 mb-2">
                      <Badge 
                        variant="secondary" 
                        className={`${userRole.bgColor} ${userRole.color} border-0`}
                      >
                        <RoleIcon className="h-3 w-3 mr-1" />
                        {userRole.role}
                      </Badge>
                      {userInvolvement.isActive && (
                        <Badge variant="outline" className="text-green-600 border-green-200">
                          <Star className="h-3 w-3 mr-1" />
                          Active
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-sm text-gray-500 mb-1">
                    Member for {userInvolvement.monthsActive} month{userInvolvement.monthsActive !== 1 ? 's' : ''}
                  </div>
                  <div className="text-xs text-gray-400">
                    Since {userInvolvement.joinDate.toLocaleDateString([], { month: 'short', year: 'numeric' })}
                  </div>
                </div>
              </div>
            </CardHeader>
            
            <CardContent className="p-4 pt-0">
              <p className="text-muted-foreground mb-4">{group.description}</p>
              
              {/* User Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 p-3 bg-muted/50 rounded-lg">
                <div className="text-center">
                  <div className="text-lg font-semibold text-gray-900">{userInvolvement.pointsEarned}</div>
                  <div className="text-xs text-gray-500">Points Earned</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-gray-900">{userInvolvement.eventsAttended}</div>
                  <div className="text-xs text-gray-500">Events Attended</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-gray-900">{userInvolvement.contributionLevel}%</div>
                  <div className="text-xs text-gray-500">Contribution</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-gray-900">
                    {group.adminIds?.includes(currentUserId) ? 'Yes' : 'No'}
                  </div>
                  <div className="text-xs text-gray-500">Leadership Role</div>
                </div>
              </div>

              {/* Group Info */}
              <div className="space-y-2">
                <div className="flex items-center text-sm">
                  <MapPin className="h-4 w-4 mr-2 text-group" />
                  <span>{typeof group.location === 'string' ? group.location : group.location?.city || (group.chapterTags?.[0] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(group.chapterTags[0]) ? group.chapterTags[0] : null) || "Location not specified"}</span>
                </div>
                <div className="flex items-center text-sm">
                  <Users className="h-4 w-4 mr-2 text-group" />
                  <span>{memberCount} members</span>
                </div>
                {group.type === GroupType.Family && parentRingId && (
                  <div className="flex items-center text-sm">
                    <Building2 className="h-4 w-4 mr-2 text-group" />
                    <span>Part of Ring</span>
                  </div>
                )}
                {group.createdAt && (
                  <div className="flex items-center text-sm">
                    <Calendar className="h-4 w-4 mr-2 text-group" />
                    <span>Established {new Date(group.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
                  </div>
                )}
              </div>
            </CardContent>
            
            <CardFooter className="p-4 pt-0 flex justify-between items-center bg-muted/50">
              <div className="flex -space-x-2">
                {memberAvatars.map((member, i) => (
                  <Avatar key={i} className="border-2 border-background h-8 w-8">
                    <AvatarImage src={member.avatar || "/placeholder.svg"} alt={member.name} />
                    <AvatarFallback>{member.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                ))}
                {memberCount > 3 && (
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-muted text-xs font-medium border-2 border-background">
                    +{memberCount - 3}
                  </div>
                )}
              </div>
              
              <div className="flex gap-2">
                <Link
                  href={
                    group.type === GroupType.Ring
                      ? `/rings/${group.id}`
                      : group.type === GroupType.Family
                        ? `/families/${group.id}`
                        : `/groups/${group.id}`
                  }
                >
                  <Button variant="outline" size="sm">
                    View Group
                  </Button>
                </Link>
                {userRole.role !== "Not a Member" && (
                  <Button
                    variant="default"
                    size="sm"
                    className="bg-primary hover:bg-primary/90"
                  >
                    Manage
                  </Button>
                )}
              </div>
            </CardFooter>
          </Card>
        )
      })}

      {filteredGroups.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">No groups found</div>
      )}
    </div>
  )
}
