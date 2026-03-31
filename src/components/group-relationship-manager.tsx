/**
 * @fileoverview GroupRelationshipManager - Admin tool for managing inter-group relationships.
 *
 * Rendered in the group admin settings. Displays existing relationships (affiliate,
 * partner, coalition, subgroup, parent) and provides a dialog for creating new ones
 * by searching available groups.
 *
 * Key props: groupId, isCreator, isAdmin
 */
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Search, Plus, X, ExternalLink } from "lucide-react"
import { fetchAgent, fetchGroups, fetchGroupRelationships } from "@/app/actions/graph"
import type { SerializedGroupRelationship } from "@/app/actions/graph"
import { agentToGroup } from "@/lib/graph-adapters"
import type { Group } from "@/lib/types"

interface GroupRelationshipManagerProps {
  groupId: string
  isCreator: boolean
  isAdmin: boolean
}

/**
 * Renders a card listing existing group relationships with an add-relationship dialog for admins.
 *
 * @param {GroupRelationshipManagerProps} props
 * @param {string} props.groupId - The group whose relationships are managed
 * @param {boolean} props.isCreator - Whether the current user created this group
 * @param {boolean} props.isAdmin - Whether the current user is a group admin
 */
export function GroupRelationshipManager({ groupId, isCreator, isAdmin }: GroupRelationshipManagerProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedRelationshipType, setSelectedRelationshipType] = useState<string>("affiliate")
  const [relationshipDescription, setRelationshipDescription] = useState("")
  const [showAddRelationship, setShowAddRelationship] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  const [currentGroup, setCurrentGroup] = useState<Group | null>(null)
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [relationships, setRelationships] = useState<SerializedGroupRelationship[]>([])

  useEffect(() => {
    async function loadData() {
      const [agentData, groupsData, relsData] = await Promise.all([
        fetchAgent(groupId),
        fetchGroups(200),
        fetchGroupRelationships(groupId),
      ])
      if (agentData) {
        setCurrentGroup(agentToGroup(agentData))
      }
      setAllGroups(groupsData.map(agentToGroup))
      setRelationships(relsData)
    }
    loadData()
  }, [groupId])

  if (!currentGroup) return null

  // Get all relationships where this group is involved
  const relevantRelationships = relationships

  // Get all groups that have a relationship with this group
  const relatedGroupIds = new Set<string>()
  relevantRelationships.forEach((rel) => {
    if (rel.sourceGroupId === groupId) {
      relatedGroupIds.add(rel.targetGroupId)
    } else if (rel.targetGroupId === groupId) {
      relatedGroupIds.add(rel.sourceGroupId)
    }
  })

  // Also include subgroups (children) and parent from hierarchical structure
  const subgroupIds = allGroups.filter((g) => g.parentGroupId === groupId).map((g) => g.id)
  subgroupIds.forEach((id) => relatedGroupIds.add(id))
  if (currentGroup.parentGroupId) {
    relatedGroupIds.add(currentGroup.parentGroupId)
  }

  // Get related groups
  const relatedGroups = allGroups.filter((g) => relatedGroupIds.has(g.id))

  // Get groups that don't have a relationship with this group yet
  const availableGroups = allGroups.filter(
    (g) => g.id !== groupId && !relatedGroupIds.has(g.id) && !g.parentGroupId && !currentGroup.parentGroupId,
  )

  // Filter available groups based on search query
  const filteredAvailableGroups = availableGroups.filter(
    (group) =>
      searchQuery === "" ||
      group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      group.description.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const getRelationshipType = (group: Group): string => {
    if (group.parentGroupId === groupId) return "subgroup"
    if (currentGroup.parentGroupId === group.id) return "parent"

    const relationship = relevantRelationships.find(
      (rel) =>
        (rel.sourceGroupId === groupId && rel.targetGroupId === group.id) ||
        (rel.sourceGroupId === group.id && rel.targetGroupId === groupId),
    )

    return relationship?.type || "affiliate"
  }

  const getRelationshipBadge = (type: string) => {
    switch (type) {
      case "subgroup":
        return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Subgroup</Badge>
      case "parent":
        return <Badge className="bg-purple-100 text-purple-800 border-purple-200">Parent Group</Badge>
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

  const handleAddRelationship = () => {
    if (!selectedGroupId) return

    // In a real app, this would create a new relationship in the database
    alert(
      `New ${selectedRelationshipType} relationship would be created between ${currentGroup.name} and ${
        allGroups.find((g) => g.id === selectedGroupId)?.name
      }`,
    )

    setShowAddRelationship(false)
    setSelectedGroupId(null)
    setRelationshipDescription("")
  }

  const handleRemoveRelationship = (relatedGroupId: string) => {
    // In a real app, this would remove the relationship from the database
    alert(
      `Relationship would be removed between ${currentGroup.name} and ${allGroups.find((g) => g.id === relatedGroupId)?.name}`,
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Group Relationships</CardTitle>
        {(isCreator || isAdmin) && (
          <Dialog open={showAddRelationship} onOpenChange={setShowAddRelationship}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Relationship
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a New Group Relationship</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <label htmlFor="relationshipType" className="block text-sm font-medium text-foreground mb-1">
                    Relationship Type
                  </label>
                  <Select value={selectedRelationshipType} onValueChange={setSelectedRelationshipType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select relationship type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="affiliate">Affiliate</SelectItem>
                      <SelectItem value="partner">Partner</SelectItem>
                      <SelectItem value="coalition">Coalition</SelectItem>
                      <SelectItem value="subgroup">Subgroup</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label htmlFor="groupSearch" className="block text-sm font-medium text-foreground mb-1">
                    Search for a Group
                  </label>
                  <div className="flex items-center mb-2">
                    <Search className="h-4 w-4 mr-2 text-muted-foreground" />
                    <Input
                      id="groupSearch"
                      placeholder="Search for groups..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="flex-1"
                    />
                  </div>

                  <div className="max-h-60 overflow-y-auto border rounded-md">
                    {filteredAvailableGroups.length > 0 ? (
                      filteredAvailableGroups.map((group) => (
                        <div
                          key={group.id}
                          className={`flex items-center justify-between p-2 hover:bg-muted cursor-pointer ${
                            selectedGroupId === group.id ? "bg-blue-50" : ""
                          }`}
                          onClick={() => setSelectedGroupId(group.id)}
                        >
                          <div className="flex items-center">
                            <Avatar className="h-8 w-8 mr-2">
                              <AvatarImage src={group.avatar || "/placeholder.svg"} alt={group.name} />
                              <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">{group.name}</p>
                              <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                {group.description}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-muted-foreground py-4">No groups found</p>
                    )}
                  </div>
                </div>

                <div>
                  <label htmlFor="relationshipDescription" className="block text-sm font-medium text-foreground mb-1">
                    Relationship Description (Optional)
                  </label>
                  <Textarea
                    id="relationshipDescription"
                    placeholder="Describe the relationship between these groups..."
                    value={relationshipDescription}
                    onChange={(e) => setRelationshipDescription(e.target.value)}
                  />
                </div>

                <Button className="w-full" onClick={handleAddRelationship} disabled={!selectedGroupId}>
                  Create Relationship
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {relatedGroups.length > 0 ? (
          <div className="space-y-3">
            {relatedGroups.map((group) => {
              const relationshipType = getRelationshipType(group)
              return (
                <div key={group.id} className="flex items-center justify-between p-3 rounded-md border">
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
                      <p className="text-sm text-muted-foreground">{group.description.substring(0, 60)}...</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/groups/${group.id}`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-1" />
                        View
                      </a>
                    </Button>
                    {(isCreator || isAdmin) && relationshipType !== "parent" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={() => handleRemoveRelationship(group.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-6 text-muted-foreground">
            <p>No group relationships yet</p>
            {(isCreator || isAdmin) && (
              <p className="text-sm mt-1">Create relationships to connect with other groups in your network</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
