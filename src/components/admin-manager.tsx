"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Shield, ShieldAlert, UserPlus, X, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import type { MemberInfo } from "@/types/domain"
import { useToast } from "@/components/ui/use-toast"

/**
 * Admin management panel for entity settings pages (group, event, or chapter).
 * It displays current admins, protects creator privileges, and supports adding/removing
 * admins from a local user directory.
 *
 * Key props:
 * - `entityId`: Entity identifier for context (currently reserved).
 * - `entityType`: Entity label used in UI copy and toast messaging.
 * - `admins`: Current admin user IDs.
 * - `creator`: User ID of the immutable creator admin.
 * - `onAdminChange`: Callback fired when admin membership is updated.
 */
interface AdminManagerProps {
  entityId: string
  entityType: "group" | "event" | "chapter"
  admins: string[]
  creator: string
  onAdminChange: (admins: string[]) => void
  members?: MemberInfo[]
}

/**
 * Renders admin role controls and emits admin membership updates to parent state.
 *
 * @param props - Component props.
 * @param props.entityId - Entity identifier for this admin scope.
 * @param props.entityType - Entity type label for contextual messages.
 * @param props.admins - Array of current admin user IDs.
 * @param props.creator - Creator user ID that cannot be removed.
 * @param props.onAdminChange - Callback used to persist updated admin IDs.
 */
export function AdminManager({ entityId: _entityId, entityType, admins, creator, onAdminChange, members = [] }: AdminManagerProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [showAddAdmin, setShowAddAdmin] = useState(false)
  const { toast } = useToast()

  const adminUsers = members.filter((user) => admins.includes(user.id))
  const creatorUser = members.find((user) => user.id === creator)

  const filteredUsers = members.filter(
    (user) =>
      !admins.includes(user.id) &&
      (searchQuery === "" ||
        user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        user.username.toLowerCase().includes(searchQuery.toLowerCase())),
  )

  const handleRemoveAdmin = (adminId: string) => {
    // Guard clause: creator retains admin privileges and cannot be removed.
    if (adminId === creator) {
      toast({
        title: "Cannot remove creator",
        description: "The creator of this entity cannot be removed from admin status.",
        variant: "destructive",
      })
      return
    }

    const newAdmins = admins.filter((id) => id !== adminId)
    // Emit updated admin list to parent-managed state/store.
    onAdminChange(newAdmins)

    // Side effect: user feedback toast after successful local update.
    toast({
      title: "Admin removed",
      description: `Admin has been removed from this ${entityType}.`,
    })
  }

  const handleAddAdmin = (userId: string) => {
    // Add the selected user to the admin IDs and notify parent ownership settings.
    const newAdmins = [...admins, userId]
    onAdminChange(newAdmins)
    // Reset search UI once assignment completes.
    setShowAddAdmin(false)
    setSearchQuery("")

    // Side effect: user feedback toast for successful role assignment.
    toast({
      title: "Admin added",
      description: `New admin has been added to this ${entityType}.`,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <ShieldAlert className="h-5 w-5 mr-2 text-amber-500" />
          Admin Management
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium mb-2">Current Admins</h3>
            <div className="space-y-2">
              {/* Creator */}
              {creatorUser && (
                <div className="flex items-center justify-between p-2 rounded-md bg-amber-50 border border-amber-200">
                  <div className="flex items-center">
                    <Avatar className="h-8 w-8 mr-2">
                      <AvatarImage src={creatorUser.avatar || "/placeholder.svg"} alt={creatorUser.name} />
                      <AvatarFallback>{creatorUser.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{creatorUser.name}</p>
                      <div className="flex items-center">
                        <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">
                          Creator
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Other admins */}
              {adminUsers
                .filter((user) => user.id !== creator)
                .map((admin) => (
                  <div key={admin.id} className="flex items-center justify-between p-2 rounded-md border">
                    <div className="flex items-center">
                      <Avatar className="h-8 w-8 mr-2">
                        <AvatarImage src={admin.avatar || "/placeholder.svg"} alt={admin.name} />
                        <AvatarFallback>{admin.name.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{admin.name}</p>
                        <div className="flex items-center">
                          <Badge variant="outline" className="bg-blue-50 text-blue-800 border-blue-200">
                            <Shield className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleRemoveAdmin(admin.id)}
                      aria-label={`Remove admin ${admin.name}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
            </div>
          </div>

          {/* Conditional rendering: either show add-admin search workflow or the trigger button. */}
          {showAddAdmin ? (
            <div className="border rounded-md p-3">
              <div className="flex items-center mb-2">
                <Search className="h-4 w-4 mr-2 text-muted-foreground" />
                <Input
                  placeholder="Search for users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1"
                />
              </div>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {filteredUsers.length > 0 ? (
                  filteredUsers.map((user) => (
                    <div key={user.id} className="flex items-center justify-between p-2 rounded-md border">
                      <div className="flex items-center">
                        <Avatar className="h-8 w-8 mr-2">
                          <AvatarImage src={user.avatar || "/placeholder.svg"} alt={user.name} />
                          <AvatarFallback>{user.name.substring(0, 2)}</AvatarFallback>
                        </Avatar>
                        <p className="font-medium">{user.name}</p>
                      </div>
                      <Button size="sm" onClick={() => handleAddAdmin(user.id)}>
                        Add
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-muted-foreground py-2">No users found</p>
                )}
              </div>
              <div className="mt-2 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowAddAdmin(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button className="w-full" onClick={() => setShowAddAdmin(true)}>
              <UserPlus className="h-4 w-4 mr-2" />
              Add Admin
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
