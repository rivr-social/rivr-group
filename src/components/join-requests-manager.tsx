/**
 * @fileoverview JoinRequestsManager - Admin interface for reviewing group membership requests.
 *
 * Displayed in the group admin settings. Lists pending join requests with applicant
 * details and approve/reject actions.
 */
"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { UserPlus, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp } from "lucide-react"
import type { JoinRequest, User } from "@/lib/types"
import { EmptyState } from "@/components/empty-state"

interface JoinRequestsManagerProps {
  groupId: string
  requests: JoinRequest[]
  getUser: (userId: string) => User | undefined
  onApprove: (requestId: string, notes?: string) => void
  onReject: (requestId: string, notes?: string) => void
}

export function JoinRequestsManager({ groupId: _groupId, requests, getUser, onApprove, onReject }: JoinRequestsManagerProps) {
  const [activeTab, setActiveTab] = useState("pending")
  const [expandedRequests, setExpandedRequests] = useState<Record<string, boolean>>({})
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({})

  const pendingRequests = requests.filter((r) => r.status === "pending")
  const approvedRequests = requests.filter((r) => r.status === "approved")
  const rejectedRequests = requests.filter((r) => r.status === "rejected")

  const toggleExpand = (requestId: string) => {
    setExpandedRequests({
      ...expandedRequests,
      [requestId]: !expandedRequests[requestId],
    })
  }

  const handleAdminNotesChange = (requestId: string, notes: string) => {
    setAdminNotes({
      ...adminNotes,
      [requestId]: notes,
    })
  }

  const handleApprove = (requestId: string) => {
    onApprove(requestId, adminNotes[requestId])
  }

  const handleReject = (requestId: string) => {
    onReject(requestId, adminNotes[requestId])
  }

  const renderRequestCard = (request: JoinRequest, showActions = false) => {
    const user = getUser(request.userId)
    if (!user) return null

    const isExpanded = expandedRequests[request.id]

    return (
      <Card key={request.id} className="mb-4">
        <CardContent className="pt-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src={user.avatar || "/placeholder.svg"} alt={user.name} />
                <AvatarFallback>{user.name.substring(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{user.name}</p>
                <p className="text-sm text-muted-foreground">@{user.username}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Requested {new Date(request.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {request.status === "pending" && (
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                  <Clock className="h-3 w-3 mr-1" />
                  Pending
                </Badge>
              )}
              {request.status === "approved" && (
                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Approved
                </Badge>
              )}
              {request.status === "rejected" && (
                <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                  <XCircle className="h-3 w-3 mr-1" />
                  Rejected
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleExpand(request.id)}
                aria-label={isExpanded ? "Collapse request details" : "Expand request details"}
              >
                {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {isExpanded && (
            <div className="mt-4 space-y-4">
              {request.answers && request.answers.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Application Answers</h4>
                  <div className="space-y-2">
                    {request.answers.map((answer, index) => (
                      <div key={index} className="bg-muted/50 p-3 rounded-md">
                        <p className="text-sm font-medium">Question {index + 1}</p>
                        <p className="text-sm mt-1">{answer.answer}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(request.status === "approved" || request.status === "rejected") && request.adminNotes && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Admin Notes</h4>
                  <div className="bg-muted/50 p-3 rounded-md">
                    <p className="text-sm">{request.adminNotes}</p>
                  </div>
                  {request.reviewedBy && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Reviewed by {getUser(request.reviewedBy)?.name || "Admin"} on{" "}
                      {request.reviewedAt ? new Date(request.reviewedAt).toLocaleDateString() : "Unknown date"}
                    </p>
                  )}
                </div>
              )}

              {showActions && (
                <div className="space-y-3">
                  <Textarea
                    placeholder="Add notes about this request (optional)"
                    value={adminNotes[request.id] || ""}
                    onChange={(e) => handleAdminNotesChange(request.id, e.target.value)}
                    rows={3}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleReject(request.id)}
                      className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Reject
                    </Button>
                    <Button onClick={() => handleApprove(request.id)} className="bg-green-600 hover:bg-green-700">
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Approve
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <UserPlus className="h-5 w-5 mr-2" />
          Join Requests
        </CardTitle>
        <CardDescription>Review and manage requests to join this group</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-3 mb-4">
            <TabsTrigger value="pending" className="flex items-center justify-center">
              <Clock className="h-4 w-4 mr-2" />
              Pending
              {pendingRequests.length > 0 && <Badge className="ml-2 bg-amber-500">{pendingRequests.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="approved">
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Approved
            </TabsTrigger>
            <TabsTrigger value="rejected">
              <XCircle className="h-4 w-4 mr-2" />
              Rejected
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {pendingRequests.length > 0 ? (
              <ScrollArea className="h-[400px] pr-4">
                {pendingRequests.map((request) => renderRequestCard(request, true))}
              </ScrollArea>
            ) : (
              <EmptyState
                icon={<Clock className="h-12 w-12 text-muted-foreground" />}
                title="No Pending Requests"
                description="There are no pending requests to join this group."
              />
            )}
          </TabsContent>

          <TabsContent value="approved">
            {approvedRequests.length > 0 ? (
              <ScrollArea className="h-[400px] pr-4">
                {approvedRequests.map((request) => renderRequestCard(request))}
              </ScrollArea>
            ) : (
              <EmptyState
                icon={<CheckCircle2 className="h-12 w-12 text-muted-foreground" />}
                title="No Approved Requests"
                description="There are no approved join requests yet."
              />
            )}
          </TabsContent>

          <TabsContent value="rejected">
            {rejectedRequests.length > 0 ? (
              <ScrollArea className="h-[400px] pr-4">
                {rejectedRequests.map((request) => renderRequestCard(request))}
              </ScrollArea>
            ) : (
              <EmptyState
                icon={<XCircle className="h-12 w-12 text-muted-foreground" />}
                title="No Rejected Requests"
                description="There are no rejected join requests."
              />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
