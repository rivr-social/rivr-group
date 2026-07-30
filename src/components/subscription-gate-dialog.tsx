"use client"

/**
 * Reusable subscription gate dialog that prompts users to subscribe when
 * they attempt a tier-gated action (e.g. creating paid offerings or events).
 *
 * Shows which tier is required and offers a subscribe button. Free trials
 * are OFF (Cameron, 2026-07-30): a subscription — even trialing — provisions
 * a paid Stripe connected account, so there is no free path.
 */

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { createCheckoutAction } from "@/app/actions/billing"
import type { MembershipTier } from "@/db/schema"
import { TIER_DISPLAY_NAMES } from "@/lib/subscription-constants"

interface SubscriptionGateDialogProps {
  /** Whether the dialog is visible. */
  open: boolean
  /** Called when the dialog should close (dismiss or after action). */
  onOpenChange: (open: boolean) => void
  /** The minimum tier required for the gated action. */
  requiredTier: MembershipTier
  /** Human-readable description of what is being gated. */
  featureDescription?: string
  /** Optional path to return to after checkout completes. */
  returnPath?: string
}

export function SubscriptionGateDialog({
  open,
  onOpenChange,
  requiredTier,
  featureDescription,
  returnPath,
}: SubscriptionGateDialogProps) {
  const [isPending, setIsPending] = useState(false)
  const { toast } = useToast()

  const tierName = TIER_DISPLAY_NAMES[requiredTier] ?? requiredTier

  const description =
    featureDescription ??
    `This feature requires a ${tierName} membership or higher.`

  const handleSubscribe = async () => {
    setIsPending(true)
    try {
      const result = await createCheckoutAction(requiredTier, "monthly", returnPath)
      if (result.success && result.url) {
        window.location.href = result.url
        return
      }
      toast({
        title: "Unable to start checkout",
        description: result.error ?? "Please try again.",
        variant: "destructive",
      })
      setIsPending(false)
    } catch {
      setIsPending(false)
      toast({
        title: "Unable to start checkout",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tierName} Membership Required</DialogTitle>
          <DialogDescription>
            {description} Subscribe to continue.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Not Now
          </Button>
          <Button onClick={handleSubscribe} disabled={isPending}>
            {isPending ? "Processing..." : "Subscribe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
