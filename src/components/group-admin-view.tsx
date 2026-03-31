"use client"

/**
 * GroupAdminView renders the administrative control panel for a single group.
 * It is used in the group admin experience to manage membership requests,
 * view members, edit group metadata, and (for organization groups) create flow passes.
 *
 * Key props:
 * - `group`: the current group record being administered.
 * - `joinRequests`: inbound membership requests displayed in the requests tab.
 * - `onUpdateGroup`: callback invoked when admin saves group settings.
 * - `onApproveRequest` / `onRejectRequest`: callbacks for processing join requests.
 */
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import {
  Users, Settings, UserPlus,
  Edit, Save, X, Crown,
  CheckCircle, XCircle, Clock, Gift
} from "lucide-react"
import { Group, FlowPass, JoinRequest, GroupType, FlowPassType } from "@/lib/types"
import { useToast } from "@/components/ui/use-toast"
import { LocationAutocompleteInput } from "@/components/location-autocomplete-input"

interface GroupAdminViewProps {
  group: Group
  joinRequests?: JoinRequest[]
  onUpdateGroup?: (group: Group) => void
  onApproveRequest?: (requestId: string) => void
  onRejectRequest?: (requestId: string) => void
}

/**
 * Group administration UI with tabs for overview, members, requests, flow passes, and settings.
 *
 * @param props - Component props containing group data and admin action callbacks.
 */
export function GroupAdminView({ 
  group, 
  joinRequests = [], 
  onUpdateGroup, 
  onApproveRequest,
  onRejectRequest 
}: GroupAdminViewProps) {
  const { toast } = useToast()
  // Tracks whether group settings fields are currently editable.
  const [isEditing, setIsEditing] = useState(false)
  // Local draft of group data used by the settings form before persisting.
  const [editedGroup, setEditedGroup] = useState(group)
  // Form state for creating a new flow pass in the organization-only tab.
  const [newFlowPass, setNewFlowPass] = useState({
    title: "",
    description: "",
    type: FlowPassType.Percentage,
    value: 10,
    eligibleMembershipTiers: [] as string[]
  })

  const handleSaveChanges = () => {
    // Side effect: informs parent to persist the locally edited group values.
    onUpdateGroup?.(editedGroup)
    setIsEditing(false)
    // UI feedback side effect for a completed save action.
    toast({ title: "Group settings updated successfully!" })
  }

  const handleAddFlowPass = () => {
    // Guard clause to keep required flow pass fields populated.
    if (!newFlowPass.title || !newFlowPass.description) {
      toast({ title: "Please fill in all required fields", variant: "destructive" })
      return
    }

    // Creates a new local flow pass record and appends it to the edited group draft.
    const flowPass: FlowPass = {
      id: `flow-pass-${Date.now()}`,
      organizationId: group.id,
      title: newFlowPass.title,
      description: newFlowPass.description,
      type: newFlowPass.type,
      value: newFlowPass.value,
      applicableServices: [],
      eligibleMembershipTiers: newFlowPass.eligibleMembershipTiers,
      isActive: true,
      createdAt: new Date().toISOString(),
      tags: []
    }

    // Update the editable group draft without mutating existing references.
    const updatedGroup = {
      ...editedGroup,
      flowPasses: [...(editedGroup.flowPasses || []), flowPass]
    }

    setEditedGroup(updatedGroup)
    // Reset flow pass form state after a successful add.
    setNewFlowPass({
      title: "",
      description: "",
      type: FlowPassType.Percentage,
      value: 10,
      eligibleMembershipTiers: []
    })
    // UI feedback side effect for add action completion.
    toast({ title: "Flow pass added successfully!" })
  }

  // Derived list used to power both tab badge counts and requests content.
  const pendingRequests = joinRequests.filter(r => r.status === "pending")
  // Feature flag for organization-only sections (flow passes and metrics).
  const isOrganization = group.type === GroupType.Organization

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Crown className="h-6 w-6 text-yellow-500" />
          <div>
            <h1 className="text-2xl font-bold">{group.name} - Admin Panel</h1>
            <p className="text-gray-600">Manage your group settings and members</p>
          </div>
        </div>
        <Badge variant={isOrganization ? "default" : "secondary"}>
          {group.type || "Group"}
        </Badge>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="requests">
            {/* Conditional badge renders only when there are pending requests. */}
            Requests {pendingRequests.length > 0 && (
              <Badge variant="destructive" className="ml-1 h-4 w-4 p-0 text-xs">
                {pendingRequests.length}
              </Badge>
            )}
          </TabsTrigger>
          {isOrganization && <TabsTrigger value="flowpasses">Flow Passes</TabsTrigger>}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Members</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{group.memberCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Pending Requests</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{pendingRequests.length}</div>
              </CardContent>
            </Card>
            {isOrganization && (
              // Organization groups show flow-pass-specific summary metrics.
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Flow Passes</CardTitle>
                  <Gift className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{group.flowPasses?.length || 0}</div>
                </CardContent>
              </Card>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <UserPlus className="h-4 w-4 text-green-500" />
                  <span>3 new members joined this week</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Settings className="h-4 w-4 text-blue-500" />
                  <span>Group settings updated 2 days ago</span>
                </div>
                {isOrganization && (
                  <div className="flex items-center gap-2 text-sm">
                    <Gift className="h-4 w-4 text-purple-500" />
                    <span>Flow pass created 1 week ago</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="members" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Group Members</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {group.members?.slice(0, 10).map((memberId) => (
                  <div key={memberId} className="flex items-center justify-between p-3 border rounded">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src="/placeholder-user.jpg" />
                        <AvatarFallback>{memberId.substring(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{memberId}</p>
                        <p className="text-sm text-gray-500">Member since {group.createdAt.substring(0, 10)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={group.adminIds?.includes(memberId) ? "default" : "secondary"}>
                        {group.adminIds?.includes(memberId) ? "Admin" : "Member"}
                      </Badge>
                      <Button variant="outline" size="sm">
                        <Settings className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="requests" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Join Requests</CardTitle>
            </CardHeader>
            <CardContent>
              {pendingRequests.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No pending join requests</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingRequests.map((request) => (
                    <div key={request.id} className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src="/placeholder-user.jpg" />
                            <AvatarFallback>{request.userId.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{request.userId}</p>
                            <p className="text-sm text-gray-500">Applied {new Date(request.createdAt).toLocaleDateString()}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button 
                            size="sm" 
                            // Event handler delegates request approval to parent callback.
                            onClick={() => onApproveRequest?.(request.id)}
                            className="bg-green-600 hover:bg-green-700"
                          >
                            <CheckCircle className="h-4 w-4 mr-1" />
                            Approve
                          </Button>
                          <Button 
                            variant="outline" 
                            size="sm"
                            // Event handler delegates request rejection to parent callback.
                            onClick={() => onRejectRequest?.(request.id)}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </div>
                      {/* Conditional rendering for optional application questionnaire answers. */}
                      {request.answers && request.answers.length > 0 && (
                        <div className="bg-gray-50 p-3 rounded mt-2">
                          <p className="text-sm font-medium mb-1">Application Answers:</p>
                          {request.answers.map((answer, index) => (
                            <p key={index} className="text-sm">• {answer.answer}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {isOrganization && (
          <TabsContent value="flowpasses" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Flow Passes</CardTitle>
                <p className="text-sm text-gray-600">Automatic discounts and benefits for members</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {group.flowPasses?.map((pass) => (
                  <div key={pass.id} className="p-4 border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-medium">{pass.title}</h4>
                      <Badge variant={pass.isActive ? "default" : "secondary"}>
                        {pass.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-600 mb-2">{pass.description}</p>
                    <div className="flex gap-2 text-xs">
                      <Badge variant="outline">
                        {pass.type === FlowPassType.Percentage ? `${pass.value}% off` : 
                         pass.type === FlowPassType.Fixed ? `$${pass.value} off` : 
                         "Free access"}
                      </Badge>
                      <Badge variant="outline">
                        {pass.eligibleMembershipTiers.join(", ")}
                      </Badge>
                    </div>
                  </div>
                ))}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Add New Flow Pass</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label htmlFor="pass-title">Title</Label>
                      <Input 
                        id="pass-title"
                        value={newFlowPass.title}
                        // Controlled input updates flow pass draft title.
                        onChange={(e) => setNewFlowPass(prev => ({...prev, title: e.target.value}))}
                        placeholder="e.g., Student Discount"
                      />
                    </div>
                    <div>
                      <Label htmlFor="pass-description">Description</Label>
                      <Textarea 
                        id="pass-description"
                        value={newFlowPass.description}
                        // Controlled input updates flow pass draft description.
                        onChange={(e) => setNewFlowPass(prev => ({...prev, description: e.target.value}))}
                        placeholder="Description of the flow pass benefits"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="pass-type">Type</Label>
                        <Select 
                          value={newFlowPass.type} 
                          // Keeps selected flow pass type in local form state.
                          onValueChange={(value) => setNewFlowPass(prev => ({...prev, type: value as FlowPassType}))}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={FlowPassType.Percentage}>Percentage Discount</SelectItem>
                            <SelectItem value={FlowPassType.Fixed}>Fixed Amount Discount</SelectItem>
                            <SelectItem value={FlowPassType.FreeFlow}>Free Access</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {/* Value field is hidden for free-flow passes since no numeric value is needed. */}
                      {newFlowPass.type !== FlowPassType.FreeFlow && (
                        <div>
                          <Label htmlFor="pass-value">Value</Label>
                          <Input 
                            id="pass-value"
                            type="number"
                            value={newFlowPass.value}
                            // Converts numeric input string to number in local state.
                            onChange={(e) => setNewFlowPass(prev => ({...prev, value: Number(e.target.value)}))}
                            placeholder={newFlowPass.type === FlowPassType.Percentage ? "10" : "5"}
                          />
                        </div>
                      )}
                    </div>
                    <Button onClick={handleAddFlowPass} className="w-full">
                      <Gift className="h-4 w-4 mr-2" />
                      Add Flow Pass
                    </Button>
                  </CardContent>
                </Card>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="settings" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Group Settings</CardTitle>
              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    {/* Save persists draft fields via callback and exits edit mode. */}
                    <Button onClick={handleSaveChanges} size="sm">
                      <Save className="h-4 w-4 mr-1" />
                      Save
                    </Button>
                    {/* Cancel exits edit mode while preserving current local draft values. */}
                    <Button variant="outline" onClick={() => setIsEditing(false)} size="sm">
                      <X className="h-4 w-4 mr-1" />
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setIsEditing(true)} size="sm">
                    <Edit className="h-4 w-4 mr-1" />
                    Edit
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="group-name">Group Name</Label>
                <Input 
                  id="group-name"
                  value={editedGroup.name}
                  // Controlled field keeps group name in editable draft state.
                  onChange={(e) => setEditedGroup(prev => ({...prev, name: e.target.value}))}
                  disabled={!isEditing}
                />
              </div>
              <div>
                <Label htmlFor="group-description">Description</Label>
                <Textarea 
                  id="group-description"
                  value={editedGroup.description}
                  // Controlled field keeps group description in editable draft state.
                  onChange={(e) => setEditedGroup(prev => ({...prev, description: e.target.value}))}
                  disabled={!isEditing}
                />
              </div>
              <div>
                <Label htmlFor="group-mission">Mission</Label>
                <Textarea 
                  id="group-mission"
                  value={editedGroup.mission || ""}
                  // Controlled field keeps optional mission text in editable draft state.
                  onChange={(e) => setEditedGroup(prev => ({...prev, mission: e.target.value}))}
                  disabled={!isEditing}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="group-location">Location</Label>
                  <LocationAutocompleteInput
                    id="group-location"
                    value={editedGroup.location || ""}
                    // Controlled location input updates draft location text.
                    onValueChange={(value) => setEditedGroup(prev => ({...prev, location: value}))}
                    disabled={!isEditing}
                  />
                </div>
                <div>
                  <Label htmlFor="group-website">Website</Label>
                  <Input 
                    id="group-website"
                    value={editedGroup.website || ""}
                    // Controlled field updates draft website value.
                    onChange={(e) => setEditedGroup(prev => ({...prev, website: e.target.value}))}
                    disabled={!isEditing}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
