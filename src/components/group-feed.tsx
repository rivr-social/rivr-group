"use client"

/**
 * GroupFeed renders a list of groups/rings/families with summary metadata
 * and a join toggle control.
 * It is used in group discovery and browsing surfaces where users can search,
 * filter by chapter, and join or leave groups.
 *
 * Key props:
 * - `groups`: source list of groups to display.
 * - `getMembers`: optional resolver for member profile previews.
 * - `onJoinGroup`: callback fired when join/leave is toggled.
 * - `query`, `chapterId`, `maxGroups`: controls for list filtering/limiting.
 */
import { useState, useMemo } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { MapPin, Users, Percent } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TypeBadge } from "@/components/type-badge"
import { TypeIcon } from "@/components/type-icon"
import Link from "next/link"
import { GroupType, JoinType, type Ring, type Family, type User, type FlowPass, type GroupJoinSettings } from "@/lib/types"

interface Group {
  id: string
  name: string
  description: string
  members?: string[]
  avatar?: string
  location?: string | {
    lat: number
    lng: number
    city?: string
  }
  chapterTags?: string[]
  groupTags?: string[]
  type?: GroupType
  parentGroupId?: string // For subgroups — UUID of the parent group
  parentRingId?: string // For families
  families?: string[] // For rings
  flowPasses?: FlowPass[] // Flow passes for automatic discounts
  joinSettings?: GroupJoinSettings
}

/** UUID v4 pattern used to detect raw identifiers in display strings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface GroupFeedProps {
  groups?: (Group | Ring | Family)[]
  getMembers?: (memberIds: string[]) => User[]
  onJoinGroup?: (groupId: string) => void
  initialJoinedGroups?: string[]
  maxGroups?: number
  query?: string
  chapterId?: string
  includeAllTypes?: boolean // New prop to include all group types
  resolveLocationName?: (id: string) => string // Resolves chapter/locale UUID to display name
}

/**
 * Feed component for rendering filtered group cards and local join state.
 *
 * @param props - List data, member lookup, and optional callbacks/filter settings.
 */
export function GroupFeed({
  groups,
  getMembers,
  onJoinGroup,
  initialJoinedGroups = [],
  maxGroups,
  query = "",
  chapterId = "all",
  includeAllTypes = false,
  resolveLocationName,
}: GroupFeedProps) {
  // Local UI state that tracks join/leave toggles for currently rendered groups.
  const [joinedGroups, setJoinedGroups] = useState<string[]>(initialJoinedGroups)

  // Use provided groups only (no mock fallbacks)
  const filteredGroups = useMemo(() => {
    let groupsToUse = groups || []

    // Filter by query if provided
    if (query) {
      const lowerQuery = query.toLowerCase()
      groupsToUse = groupsToUse.filter(
        (group) =>
          group.name.toLowerCase().includes(lowerQuery) || group.description.toLowerCase().includes(lowerQuery),
      )
    }

    // Filter by chapter if provided and not "all"
    if (chapterId && chapterId !== "all") {
      groupsToUse = groupsToUse.filter((group) => group.chapterTags?.includes(chapterId))
    }

    // Apply maxGroups limit if provided
    if (maxGroups) {
      groupsToUse = groupsToUse.slice(0, maxGroups)
    }

    return groupsToUse
  }, [groups, query, chapterId, maxGroups, includeAllTypes])

  const handleJoinGroup = (groupId: string) => {
    // Toggle local membership state for immediate UI feedback.
    const newJoinedGroups = joinedGroups.includes(groupId)
      ? joinedGroups.filter((id) => id !== groupId)
      : [...joinedGroups, groupId]

    setJoinedGroups(newJoinedGroups)

    // Side effect: notify parent/store so membership changes can be persisted externally.
    if (onJoinGroup) {
      onJoinGroup(groupId)
    }
  }

  const requiresJoinFlowPage = (group: Group | Ring | Family) =>
    Boolean(
      group.joinSettings?.passwordRequired ||
      (group.joinSettings?.questions?.length ?? 0) > 0 ||
      group.joinSettings?.joinType === JoinType.ApprovalRequired ||
      group.joinSettings?.joinType === JoinType.InviteOnly ||
      group.joinSettings?.joinType === JoinType.InviteAndApply
    )

  // Default getMembers function if not provided
  const defaultGetMembers = (memberIds: string[]) => {
    // Fallback placeholder data keeps avatar strip rendering predictable.
    return memberIds.map((id) => {
      return {
        id,
        name: "Unknown User",
        username: "unknown",
        avatar: "/placeholder.svg",
      }
    })
  }

  const getMembersFunction = getMembers || defaultGetMembers

  // Build a lookup from group ID → group name so subgroups can resolve parent names.
  const groupNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of groups || []) {
      map.set(g.id, g.name)
    }
    return map
  }, [groups])

  /**
   * Resolves the display location for a group. Prefers explicit location fields,
   * then parent group name (for subgroups), then chapter tag resolution, and
   * finally a static fallback. Raw UUIDs are never shown to the user.
   */
  const resolveGroupLocation = (group: Group | Ring | Family): string => {
    // 1. Explicit string location
    if (typeof group.location === "string" && group.location.length > 0) return group.location
    // 2. Object location with city
    if (typeof group.location === "object" && group.location?.city) return group.location.city
    // 3. Parent group name (subgroup hierarchy)
    const parentId = "parentGroupId" in group ? (group as Group).parentGroupId : undefined
    if (parentId) {
      const parentName = groupNameById.get(parentId)
      if (parentName) return parentName
    }
    // 4. First chapter tag that isn't a raw UUID
    const firstTag = group.chapterTags?.[0]
    if (firstTag) {
      if (UUID_RE.test(firstTag)) {
        // Try external resolver (locale/basin name map)
        if (resolveLocationName) {
          const resolved = resolveLocationName(firstTag)
          if (resolved !== firstTag) return resolved
        }
        // Try group name map (parent may be in the same feed)
        const groupName = groupNameById.get(firstTag)
        if (groupName) return groupName
        // UUID could not be resolved — skip it
      } else {
        return firstTag
      }
    }
    return "Location not specified"
  }

  return (
    <div className="space-y-4 mt-4">
      {filteredGroups.map((group) => {
        const memberCount =
          group.type === GroupType.Ring
            ? group.members?.length || 0
            : group.members?.length || 0
        const memberAvatars = getMembersFunction((group.members || []).slice(0, 3))
        const isJoined = joinedGroups.includes(group.id)

        return (
          <Card key={group.id} className="border shadow-sm">
            <CardHeader className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <Avatar className="h-12 w-12 border-2 border-border">
                    <AvatarImage src={"avatar" in group ? group.avatar || "/placeholder.svg" : "/placeholder.svg"} alt={group.name} />
                    <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <div>
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
                      {/* Conditional badge indicates an active qualifying flow pass. */}
                      {"flowPasses" in group && group.flowPasses?.some(pass => pass.isActive && pass.type === "percentage" && pass.value === 10) && (
                        <div className="flex items-center gap-1 mt-1">
                          <div className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Percent className="h-3 w-3" />
                            <span>Flow Pass</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <TypeIcon 
                    type={
                      group.type === GroupType.Ring ? "ring" :
                      group.type === GroupType.Family ? "family" :
                      group.type === GroupType.Basic ? "basic" :
                      "org"
                    } 
                    size={18} 
                    className="mr-2" 
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
                  {/* Conditional context metadata for family/ring hierarchy. */}
                  {group.type === GroupType.Family && group.parentRingId && (
                    <span className="ml-2 text-xs text-muted-foreground">in Ring</span>
                  )}
                  {group.type === GroupType.Ring && group.families && (
                    <span className="ml-2 text-xs text-muted-foreground">{group.families.length} families</span>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <p className="text-muted-foreground mb-4">{group.description}</p>
              <div className="space-y-2">
                <div className="flex items-center text-sm">
                  <MapPin className="h-4 w-4 mr-2 text-group" />
                  <span>{resolveGroupLocation(group)}</span>
                </div>
                <div className="flex items-center text-sm">
                  <Users className="h-4 w-4 mr-2 text-group" />
                  <span>{memberCount} members</span>
                </div>
                {/* Optional flow pass detail shown when the qualifying pass exists. */}
                {"flowPasses" in group && group.flowPasses?.some(pass => pass.isActive && pass.type === "percentage" && pass.value === 10) && (
                  <div className="flex items-center text-sm text-green-600">
                    <Percent className="h-4 w-4 mr-2 text-green-600" />
                    <span>10% off for members from same locale</span>
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter className="p-4 pt-0 flex justify-between items-center bg-muted/50 rounded-b-lg">
              <div className="flex -space-x-2">
                {memberAvatars.map((member, i) => (
                  <Avatar key={i} className="border-2 border-background h-8 w-8">
                    <AvatarImage
                      src={typeof member.avatar === "string" ? member.avatar : "/placeholder-user.jpg"}
                      alt={member.name}
                    />
                    <AvatarFallback>{member.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                ))}
                {memberCount > 3 && (
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-muted text-xs font-medium border-2 border-white">
                    +{memberCount - 3}
                  </div>
                )}
              </div>
              {requiresJoinFlowPage(group) ? (
                <Button asChild variant="secondary">
                  <Link href={`/groups/${group.id}`}>View Group</Link>
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  // Event handler toggles joined state and triggers optional external callback.
                  onClick={() => handleJoinGroup(group.id)}
                >
                  {isJoined ? "Joined" : "Join Group"}
                </Button>
              )}
            </CardFooter>
          </Card>
        )
      })}

      {filteredGroups.length === 0 && <div className="text-center py-8 text-muted-foreground">No groups found</div>}
    </div>
  )
}
