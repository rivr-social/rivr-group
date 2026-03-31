/**
 * @fileoverview GroupRelationships - Tabbed view of a group's subgroups, parent, and affiliations.
 *
 * Displayed on the group detail page. Provides tabs for Subgroups, Parent Group, and
 * Affiliations. Admins/creators can create subgroups and manage affiliations.
 * Includes a GroupCard sub-component for rendering individual relationship cards.
 *
 * Key props: group, allGroups, isAdmin, currentUserId
 */
"use client"

import { useState, useEffect, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { Group } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PlusCircle, Users, LinkIcon, Unlink } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { fetchAgent } from "@/app/actions/graph"
import type { SerializedAgent } from "@/lib/graph-serializers"
import { removeGroupRelationshipAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"

interface GroupRelationshipsProps {
  group: Group
  allGroups: Group[]
  isAdmin: boolean
  currentUserId: string
}

/**
 * Renders a tabbed interface showing subgroups, parent group, and affiliated groups.
 *
 * @param {GroupRelationshipsProps} props
 * @param {Group} props.group - The group whose relationships are displayed
 * @param {Group[]} props.allGroups - Full list of groups for lookup
 * @param {boolean} props.isAdmin - Whether the current user is an admin
 * @param {string} props.currentUserId - The logged-in user's ID for permission checks
 */
export function GroupRelationships({ group, allGroups, isAdmin: _isAdmin, currentUserId }: GroupRelationshipsProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("subgroups")
  const [showManageAffiliations, setShowManageAffiliations] = useState(false)

  // Check if current user is admin or creator
  const isAdminOrCreator = group.creatorId === currentUserId || group.adminIds?.includes(currentUserId)

  // Handle create subgroup navigation
  const handleCreateSubgroup = () => {
    router.push(`/create?tab=group&parent=${group.id}`)
  }

  // Get subgroups from allGroups prop
  const subgroups = allGroups.filter((g) => g.parentGroupId === group.id)

  // Get parent group from allGroups prop
  const parentGroup = group.parentGroupId ? allGroups.find((g) => g.id === group.parentGroupId) : null

  // Get affiliated groups from allGroups prop
  const affiliatedGroups = group.affiliatedGroups
    ? allGroups.filter((g) => group.affiliatedGroups?.includes(g.id))
    : []

  return (
    <div className="space-y-4">
      <Tabs defaultValue="subgroups" value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="subgroups" className="relative">
              Subgroups
              {subgroups.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {subgroups.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="parent">
              Parent Group
              {parentGroup && (
                <Badge variant="secondary" className="ml-2">
                  1
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="affiliations">
              Affiliations
              {affiliatedGroups.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {affiliatedGroups.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {isAdminOrCreator && (
            <div className="flex gap-2">
              {activeTab === "subgroups" && (
                <Button size="sm" variant="outline" onClick={handleCreateSubgroup}>
                  <PlusCircle className="h-4 w-4 mr-2" />
                  Create Subgroup
                </Button>
              )}

              {activeTab === "affiliations" && (
                <Dialog open={showManageAffiliations} onOpenChange={setShowManageAffiliations}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Manage Affiliations
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                      <DialogTitle>Manage Affiliations</DialogTitle>
                    </DialogHeader>
                    <ManageAffiliations group={group} onSuccess={() => setShowManageAffiliations(false)} />
                  </DialogContent>
                </Dialog>
              )}
            </div>
          )}
        </div>

        <TabsContent value="subgroups" className="space-y-4">
          {subgroups.length > 0 ? (
            <ScrollArea className="h-[400px] pr-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {subgroups.map((subgroup) => (
                  <GroupCard
                    key={subgroup.id}
                    group={subgroup}
                    relationshipType="subgroup"
                    currentUserId={currentUserId}
                    parentGroup={group}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Users className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No Subgroups</h3>
              <p className="text-muted-foreground mt-1 max-w-md">
                This group doesn&apos;t have any subgroups yet.
                {isAdminOrCreator && " Create a subgroup to organize members around specific initiatives."}
              </p>
              {isAdminOrCreator && (
                <Button variant="outline" className="mt-4" onClick={handleCreateSubgroup}>
                  <PlusCircle className="h-4 w-4 mr-2" />
                  Create Subgroup
                </Button>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="parent">
          {parentGroup ? (
            <GroupCard group={parentGroup} relationshipType="parent" currentUserId={currentUserId} childGroup={group} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Users className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No Parent Group</h3>
              <p className="text-muted-foreground mt-1 max-w-md">
                This is a top-level group and doesn&apos;t belong to any parent group.
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="affiliations" className="space-y-4">
          {affiliatedGroups.length > 0 ? (
            <ScrollArea className="h-[400px] pr-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {affiliatedGroups.map((affiliatedGroup) => (
                  <GroupCard
                    key={affiliatedGroup.id}
                    group={affiliatedGroup}
                    relationshipType="affiliated"
                    currentUserId={currentUserId}
                    affiliatedWith={group}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <LinkIcon className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No Affiliated Groups</h3>
              <p className="text-muted-foreground mt-1 max-w-md">
                This group doesn&apos;t have any affiliations with other groups yet.
                {isAdminOrCreator && " Create affiliations to connect with related groups."}
              </p>
              {isAdminOrCreator && (
                <Button variant="outline" className="mt-4" onClick={() => setShowManageAffiliations(true)}>
                  <LinkIcon className="h-4 w-4 mr-2" />
                  Manage Affiliations
                </Button>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface GroupCardProps {
  group: Group
  relationshipType: "subgroup" | "parent" | "affiliated"
  currentUserId: string
  parentGroup?: Group
  childGroup?: Group
  affiliatedWith?: Group
}

function GroupCard({
  group,
  relationshipType,
  currentUserId,
  parentGroup,
  childGroup: _childGroup,
  affiliatedWith,
}: GroupCardProps) {
  const [showRemoveDialog, setShowRemoveDialog] = useState(false)
  const [creatorName, setCreatorName] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  // Fetch creator info from DB instead of mock data
  useEffect(() => {
    if (!group.creatorId) return
    fetchAgent(group.creatorId).then((agent: SerializedAgent | null) => {
      if (agent) setCreatorName(agent.name)
    })
  }, [group.creatorId])

  // Check if current user is admin or creator of the relevant group
  const isAdminOrCreator =
    relationshipType === "subgroup" && parentGroup
      ? parentGroup.creatorId === currentUserId || parentGroup.adminIds?.includes(currentUserId)
      : relationshipType === "affiliated" && affiliatedWith
        ? affiliatedWith.creatorId === currentUserId || affiliatedWith.adminIds?.includes(currentUserId)
        : false

  // Get member count
  const memberCount = group.members?.length || group.memberCount || 0

  // Get relationship label
  const getRelationshipLabel = () => {
    switch (relationshipType) {
      case "subgroup":
        return "Subgroup"
      case "parent":
        return "Parent Group"
      case "affiliated":
        return "Affiliated Group"
    }
  }

  // Resolve parent group ID for the relationship removal call based on relationship type.
  const resolveRelationshipIds = (): { parentGroupId: string; childGroupId: string } | null => {
    if (relationshipType === "subgroup" && parentGroup) {
      return { parentGroupId: parentGroup.id, childGroupId: group.id }
    }
    if (relationshipType === "affiliated" && affiliatedWith) {
      return { parentGroupId: affiliatedWith.id, childGroupId: group.id }
    }
    return null
  }

  // Handle remove relationship by calling the server action and providing user feedback.
  const handleRemoveRelationship = () => {
    const ids = resolveRelationshipIds()
    if (!ids) {
      setShowRemoveDialog(false)
      return
    }
    startTransition(async () => {
      const result = await removeGroupRelationshipAction({
        relationshipType: relationshipType as "subgroup" | "affiliated",
        parentGroupId: ids.parentGroupId,
        childGroupId: ids.childGroupId,
      })
      if (result.success) {
        toast({ title: "Relationship removed", description: "The group relationship has been removed." })
        setShowRemoveDialog(false)
      } else {
        toast({ title: "Failed to remove relationship", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            <Avatar className="h-8 w-8">
              <AvatarImage src={group.avatar || "/placeholder.svg"} alt={group.name} />
              <AvatarFallback>{group.name.substring(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div>
              <CardTitle className="text-base">
                <a href={`/groups/${group.id}`} className="hover:underline">
                  {group.name}
                </a>
              </CardTitle>
              <CardDescription className="text-xs">
                {creatorName ? `Created by ${creatorName}` : group.creatorId ? "Loading..." : "Unknown creator"}
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline">{getRelationshipLabel()}</Badge>
        </div>
      </CardHeader>
      <CardContent className="pb-2">
        <p className="text-sm line-clamp-2">{group.description}</p>
        <div className="flex items-center gap-2 mt-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{memberCount} members</span>
        </div>
      </CardContent>
      <CardFooter className="pt-2 flex justify-between">
        <Button variant="outline" size="sm" asChild>
          <a href={`/groups/${group.id}`}>View Group</a>
        </Button>

        {isAdminOrCreator && (
          <Dialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Unlink className="h-4 w-4 mr-2" />
                Remove
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove Relationship</DialogTitle>
              </DialogHeader>
              <div className="py-4">
                <p>Are you sure you want to remove this {relationshipType} relationship?</p>
                {relationshipType === "subgroup" && (
                  <p className="text-sm text-muted-foreground mt-2">
                    This will not delete the group, but it will no longer be a subgroup of {parentGroup?.name}.
                  </p>
                )}
                {relationshipType === "affiliated" && (
                  <p className="text-sm text-muted-foreground mt-2">
                    This will remove the affiliation between {affiliatedWith?.name} and {group.name}.
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowRemoveDialog(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleRemoveRelationship} disabled={isPending}>
                  {isPending ? "Removing..." : "Remove"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardFooter>
    </Card>
  )
}

function ManageAffiliations({ group: _group, onSuccess }: { group: Group; onSuccess: () => void }) {
  return (
    <div className="py-4">
      <p>Manage Affiliations Form Placeholder</p>
      <Button className="mt-4" onClick={onSuccess}>
        Save Changes
      </Button>
    </div>
  )
}
