/**
 * @fileoverview GroupSubgroups - Displays and manages subgroups of a parent group.
 *
 * Shown on the group detail page. Lists child groups with member counts and
 * links to their detail pages. Admins/creators can open a dialog to create new subgroups.
 *
 * Key props: parentGroupId, isCreator, isAdmin
 */
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Layers, ChevronRight, Users, Plus } from "lucide-react"
import { fetchAgent, fetchAgentChildren } from "@/app/actions/graph"
import { agentToGroup } from "@/lib/graph-adapters"
import type { Group } from "@/lib/types"
import Link from "next/link"

interface GroupSubgroupsProps {
  parentGroupId: string
  isCreator: boolean
  isAdmin: boolean
}

/**
 * Renders a card with a list of subgroups and a create-subgroup dialog for admins.
 *
 * @param {GroupSubgroupsProps} props
 * @param {string} props.parentGroupId - The parent group's ID
 * @param {boolean} props.isCreator - Whether the current user created the parent group
 * @param {boolean} props.isAdmin - Whether the current user is an admin of the parent group
 */
export function GroupSubgroups({ parentGroupId, isCreator, isAdmin }: GroupSubgroupsProps) {
  const router = useRouter()
  const [isAddingGroup, setIsAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState("")
  const [newGroupDescription, setNewGroupDescription] = useState("")
  const [parentGroup, setParentGroup] = useState<Group | null>(null)
  const [childGroups, setChildGroups] = useState<Group[]>([])

  useEffect(() => {
    async function loadData() {
      const [parentAgent, childAgents] = await Promise.all([
        fetchAgent(parentGroupId),
        fetchAgentChildren(parentGroupId),
      ])
      if (parentAgent) {
        setParentGroup(agentToGroup(parentAgent))
      }
      const orgChildren = childAgents
        .filter((a) => a.type === "organization")
        .map(agentToGroup)
      setChildGroups(orgChildren)
    }
    loadData()
  }, [parentGroupId])

  const handleAddGroup = () => {
    const params = new URLSearchParams({
      tab: "group",
      parent: parentGroupId,
    })
    if (newGroupName.trim()) params.set("name", newGroupName.trim())
    if (newGroupDescription.trim()) params.set("description", newGroupDescription.trim())
    setIsAddingGroup(false)
    setNewGroupName("")
    setNewGroupDescription("")
    router.push(`/create?${params.toString()}`)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center">
          <Layers className="h-5 w-5 mr-2 text-primary" />
          Subgroups
        </CardTitle>
        {(isCreator || isAdmin) && (
          <Dialog open={isAddingGroup} onOpenChange={setIsAddingGroup}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Create Subgroup
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a New Subgroup</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <label htmlFor="groupName" className="block text-sm font-medium text-foreground mb-1">
                    Subgroup Name
                  </label>
                  <Input
                    id="groupName"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Enter subgroup name"
                  />
                </div>
                <div>
                  <label htmlFor="groupDescription" className="block text-sm font-medium text-foreground mb-1">
                    Description
                  </label>
                  <Textarea
                    id="groupDescription"
                    value={newGroupDescription}
                    onChange={(e) => setNewGroupDescription(e.target.value)}
                    placeholder="Enter subgroup description"
                  />
                </div>
                <Button className="w-full" onClick={handleAddGroup}>
                  Create Subgroup
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {childGroups.length > 0 ? (
          <div className="space-y-3">
            {childGroups.map((group) => (
              <Link href={`/groups/${group.id}`} key={group.id} className="block">
                <div className="flex items-center justify-between p-3 rounded-md border hover:bg-muted cursor-pointer">
                  <div className="flex items-center">
                    <Avatar className="h-10 w-10 mr-3">
                      <AvatarImage src={group.avatar || "/placeholder.svg"} alt={group.name} />
                      <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="font-medium">{group.name}</h3>
                      <div className="flex items-center text-sm text-muted-foreground">
                        <Users className="h-3 w-3 mr-1" />
                        <span>{(group.members ?? []).length || group.memberCount} members</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-muted-foreground">
            <p>No subgroups yet</p>
            {(isCreator || isAdmin) && <p className="text-sm mt-1">Create a subgroup to organize your community</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
