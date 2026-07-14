"use client"

/**
 * Card-level "Claim" affordance (2026-07-14).
 *
 * Puts the claim action ON the job card (project page + Jobs board) and in the
 * project-card dropdown, not only inside the job detail page. Calls the shared
 * `claimJobAction`, which enforces the full eligibility rail server-side
 * (membership/admin baseline, badge gate, open slot, approval-required → a
 * pending request) and returns a precise denial message on failure — so the
 * button can be shown broadly and the server decides.
 *
 * Rendered inside clickable cards/links; it stops event propagation so a claim
 * click never also toggles the collapsible or navigates to the job.
 */

import type React from "react"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { UserPlus, Loader2, CheckCircle2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { claimJobAction } from "@/app/actions/interactions/project-team"

interface JobClaimButtonProps {
  jobId: string
  /** Job status; the button hides once the job is completed/cancelled/filled. */
  status?: string
  size?: "sm" | "default"
  className?: string
}

/** Statuses for which claiming no longer makes sense. */
const UNCLAIMABLE_STATUSES = new Set(["completed", "cancelled", "closed", "filled"])

export function JobClaimButton({ jobId, status, size = "sm", className }: JobClaimButtonProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [claimed, setClaimed] = useState(false)

  if (status && UNCLAIMABLE_STATUSES.has(status)) return null

  const handleClaim = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    startTransition(async () => {
      const result = await claimJobAction(jobId)
      if (result.success) {
        // `pending` (approval-required) leaves the claim awaiting review.
        const pending = result.pending === true
        if (!pending) setClaimed(true)
        toast({ title: pending ? "Claim submitted" : "Job claimed", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Could not claim", description: result.message, variant: "destructive" })
      }
    })
  }

  if (claimed) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-green-700 ${className ?? ""}`}>
        <CheckCircle2 className="h-3.5 w-3.5" /> Claimed
      </span>
    )
  }

  return (
    <Button
      size={size}
      variant="outline"
      className={className}
      onClick={handleClaim}
      disabled={isPending}
      aria-label="Claim this job"
    >
      {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <UserPlus className="h-3.5 w-3.5 mr-1" />}
      Claim
    </Button>
  )
}
