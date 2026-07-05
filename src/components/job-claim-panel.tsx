"use client"

/**
 * Job claim panel for the job detail page.
 *
 * Renders the claim call-to-action for the viewer (claim / request-to-claim /
 * awaiting-approval / claimed) honoring the job's configured gates, and — for
 * admins of the owning group — the pending-claim review queue (approve/reject).
 *
 * All authorization is enforced server-side by the actions; this component only
 * reflects the resolved `JobClaimPanelData` and drives the mutations.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Clock3, ShieldCheck, UserCheck, Lock } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  claimJobAction,
  reviewJobClaimRequest,
  type JobClaimPanelData,
  type JobClaimRequestRecord,
} from "@/app/actions/interactions/project-team"

interface JobClaimPanelProps {
  data: JobClaimPanelData
}

export function JobClaimPanel({ data }: JobClaimPanelProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<JobClaimPanelData["status"]>(data.status)
  const [requests, setRequests] = useState<JobClaimRequestRecord[]>(data.pendingRequests)

  const slotsFull =
    data.maxAssignees != null && data.maxAssignees > 0 && data.claimantCount >= data.maxAssignees

  const handleClaim = () => {
    startTransition(async () => {
      const result = await claimJobAction(data.jobId)
      if (result.success) {
        setStatus(result.pending ? "pending" : "claimed")
        toast({ title: result.pending ? "Claim submitted" : "Job claimed", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Could not claim", description: result.message, variant: "destructive" })
      }
    })
  }

  const handleReview = (requestId: string, decision: "approved" | "rejected") => {
    startTransition(async () => {
      const result = await reviewJobClaimRequest(requestId, decision)
      if (result.success) {
        setRequests((prev) => prev.filter((r) => r.id !== requestId))
        toast({ title: decision === "approved" ? "Claim approved" : "Claim rejected", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Review failed", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Card className="mb-6">
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h3 className="font-semibold">Claim this job</h3>
            <div className="flex flex-wrap gap-2">
              {data.approvalRequired && (
                <Badge variant="outline" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Approval required
                </Badge>
              )}
              {data.gateMembership && (
                <Badge variant="outline" className="gap-1">
                  <UserCheck className="h-3 w-3" /> Members only
                </Badge>
              )}
              {data.gateAdmin && (
                <Badge variant="outline" className="gap-1">
                  <Lock className="h-3 w-3" /> Admins only
                </Badge>
              )}
              {data.maxAssignees != null && data.maxAssignees > 0 && (
                <Badge variant="secondary">
                  {data.claimantCount}/{data.maxAssignees} claimed
                </Badge>
              )}
            </div>
          </div>

          <div className="shrink-0">
            {!data.signedIn ? (
              <Button onClick={() => router.push("/api/auth/signin")} variant="outline">
                Sign in to claim
              </Button>
            ) : status === "claimed" ? (
              <span className="inline-flex items-center gap-2 text-green-600 font-medium">
                <CheckCircle2 className="h-5 w-5" /> Claimed
              </span>
            ) : status === "pending" ? (
              <span className="inline-flex items-center gap-2 text-yellow-600 font-medium">
                <Clock3 className="h-5 w-5" /> Awaiting approval
              </span>
            ) : (
              <Button
                onClick={handleClaim}
                disabled={isPending || !data.claimable || slotsFull}
              >
                {!data.claimable
                  ? "Not open for claims"
                  : slotsFull
                    ? "No open slots"
                    : data.approvalRequired
                      ? "Request to claim"
                      : "Claim job"}
              </Button>
            )}
          </div>
        </div>

        {/* Admin review queue for pending approval-gated claims. */}
        {data.isAdmin && requests.length > 0 && (
          <div className="border-t pt-4 space-y-3">
            <h4 className="text-sm font-medium">
              Pending claim requests ({requests.length})
            </h4>
            <ul className="space-y-2">
              {requests.map((req) => (
                <li
                  key={req.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {req.claimantAvatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={req.claimantAvatar}
                        alt={req.claimantName ?? "Claimant"}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-muted" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {req.claimantName ?? "Member"}
                      </p>
                      {req.claimantUsername && (
                        <p className="text-xs text-gray-500 truncate">@{req.claimantUsername}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() => handleReview(req.id, "rejected")}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleReview(req.id, "approved")}
                    >
                      Approve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
