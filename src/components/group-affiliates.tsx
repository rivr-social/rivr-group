/**
 * @fileoverview GroupAffiliates - Displays affiliated groups (partner, coalition, affiliate).
 *
 * Shown on the group detail page sidebar. Derives affiliated groups from
 * ledger relationship entries, filtering out parent-child (subgroup) relationships.
 * Each affiliated group links to its detail page.
 *
 * Key props: groupId
 */
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Link2, ExternalLink, Users } from "lucide-react"
import { fetchGroups, fetchGroupRelationships } from "@/app/actions/graph"
import type { SerializedGroupRelationship } from "@/app/actions/graph"
import { agentToGroup } from "@/lib/graph-adapters"
import type { Group } from "@/lib/types"
import Link from "next/link"

interface GroupAffiliatesProps {
  groupId: string
}

/**
 * Renders a card listing all groups affiliated with the given group (excludes subgroups).
 *
 * @param {GroupAffiliatesProps} props
 * @param {string} props.groupId - The group whose affiliates are displayed
 */
export function GroupAffiliates({ groupId }: GroupAffiliatesProps) {
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [relationships, setRelationships] = useState<SerializedGroupRelationship[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      const [groupsData, relsData] = await Promise.all([
        fetchGroups(200),
        fetchGroupRelationships(groupId),
      ])
      setAllGroups(groupsData.map(agentToGroup))
      setRelationships(relsData)
      setLoading(false)
    }
    loadData()
  }, [groupId])

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-40 animate-pulse bg-muted rounded" />
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="h-10 w-10 animate-pulse bg-muted rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 animate-pulse bg-muted rounded" />
              <div className="h-3 w-1/2 animate-pulse bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Get current group
  const currentGroup = allGroups.find((g) => g.id === groupId)
  if (!currentGroup) return null

  // Get all relationships where this group is involved (excluding parent-child)
  const relevantRelationships = relationships.filter(
    (rel) => rel.type !== "subgroup",
  )

  // Get all groups that have a relationship with this group
  const affiliatedGroupIds = new Set<string>()
  relevantRelationships.forEach((rel) => {
    if (rel.sourceGroupId === groupId) {
      affiliatedGroupIds.add(rel.targetGroupId)
    } else if (rel.targetGroupId === groupId) {
      affiliatedGroupIds.add(rel.sourceGroupId)
    }
  })

  // Get affiliated groups
  const affiliatedGroups = allGroups.filter((g) => affiliatedGroupIds.has(g.id))

  const getRelationshipType = (group: Group): string => {
    const relationship = relevantRelationships.find(
      (rel) =>
        (rel.sourceGroupId === groupId && rel.targetGroupId === group.id) ||
        (rel.sourceGroupId === group.id && rel.targetGroupId === groupId),
    )

    return relationship?.type || "affiliate"
  }

  const getRelationshipBadge = (type: string) => {
    switch (type) {
      case "affiliate":
        return <Badge className="bg-green-100 text-green-800 border-green-200">Affiliate</Badge>
      case "partner":
        return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Partner</Badge>
      case "coalition":
        return <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200">Coalition</Badge>
      default:
        return <Badge variant="outline">Related</Badge>
    }
  }

  if (affiliatedGroups.length === 0) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Link2 className="h-5 w-5 mr-2 text-primary" />
          Affiliated Groups
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {affiliatedGroups.map((group) => {
            const relationshipType = getRelationshipType(group)
            return (
              <Link href={`/groups/${group.id}`} key={group.id} className="block">
                <div className="flex items-center justify-between p-3 rounded-md border hover:bg-gray-50 cursor-pointer">
                  <div className="flex items-center">
                    <Avatar className="h-10 w-10 mr-3">
                      <AvatarImage src={group.avatar || "/placeholder.svg"} alt={group.name} />
                      <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="flex items-center">
                        <h3 className="font-medium mr-2">{group.name}</h3>
                        {getRelationshipBadge(relationshipType)}
                      </div>
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Users className="h-3 w-3 mr-1" />
                        <span>{group.members?.length || group.memberCount || 0} members</span>
                      </div>
                    </div>
                  </div>
                  <ExternalLink className="h-5 w-5 text-muted-foreground" />
                </div>
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
