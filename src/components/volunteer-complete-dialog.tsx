"use client"

/**
 * VolunteerCompleteDialog — the voucher-creator popup on the Complete action of
 * a VOLUNTEER-pay job (2026-07-14, round 4).
 *
 * A volunteer job pays no cash: at completion the group transfers Thanks it
 * already holds to each volunteer, valued from a skillfulness × difficulty ×
 * hours formula (`computeVoucherThanksValue`, the same one the VoucherBuilder
 * uses). Rounds 1–3 collected those ratings on the assignee's own "claim
 * complete" flow buried in the Points tab — the admin clicking Complete never
 * saw them. This dialog surfaces the exact skill/difficulty sliders ON the
 * Complete action itself: confirming settles the job with the Thanks total the
 * completer set (via `markJobDoneAction`'s `volunteerRating` override, which
 * values every volunteer's voucher, each still scaled by their own hours).
 *
 * It is controlled (open/onOpenChange) so the various Complete surfaces
 * (JobAdminPanel, JobPointsTab) drive it from their own trigger buttons.
 */

import { useState } from "react"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Award, HandHeart, Zap } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { markJobDoneAction } from "@/app/actions/job-completion"
import { computeVoucherThanksValue } from "@/lib/voucher-valuation"

/** Default slider position (mid-scale), matching the claim-complete dialog. */
const DEFAULT_RATING = 50

/** Hours assumed for the preview total when the job carries no hour estimate. */
const PREVIEW_FALLBACK_HOURS = 1

interface VolunteerCompleteDialogProps {
  jobId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Representative hours for the live Thanks preview (the job's max-hours
   * budget when set). Each volunteer's actual voucher is scaled by their own
   * tracked/estimated hours at settlement; this only drives the preview number.
   */
  estimatedHours?: number | null
  /** Called after a successful completion so the caller can refresh. */
  onCompleted?: () => void
}

export function VolunteerCompleteDialog({
  jobId,
  open,
  onOpenChange,
  estimatedHours,
  onCompleted,
}: VolunteerCompleteDialogProps) {
  const { toast } = useToast()
  const [skillfulness, setSkillfulness] = useState([DEFAULT_RATING])
  const [difficulty, setDifficulty] = useState([DEFAULT_RATING])
  const [isCompleting, setIsCompleting] = useState(false)

  const previewHours =
    typeof estimatedHours === "number" && Number.isFinite(estimatedHours) && estimatedHours > 0
      ? estimatedHours
      : PREVIEW_FALLBACK_HOURS
  // Thanks per hour worked = the rating factor alone; the settled total scales
  // it by each volunteer's hours.
  const thanksPerHour = computeVoucherThanksValue({
    skillfulness: skillfulness[0],
    difficulty: difficulty[0],
    hours: 1,
  })
  const previewTotal = computeVoucherThanksValue({
    skillfulness: skillfulness[0],
    difficulty: difficulty[0],
    hours: previewHours,
  })

  const handleComplete = () => {
    setIsCompleting(true)
    void (async () => {
      try {
        const result = await markJobDoneAction(jobId, {
          volunteerRating: { skillfulness: skillfulness[0], difficulty: difficulty[0] },
        })
        if (result.success) {
          toast({ title: "Job completed", description: result.message })
          onOpenChange(false)
          onCompleted?.()
        } else {
          toast({ title: "Failed to complete job", description: result.message, variant: "destructive" })
        }
      } catch {
        toast({ title: "Failed to complete job", description: "An unexpected error occurred.", variant: "destructive" })
      } finally {
        setIsCompleting(false)
      }
    })()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandHeart className="h-5 w-5 text-purple-600" />
            Rate your contribution
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Zap className="h-4 w-4" />
                Skillfulness required
              </Label>
              <Badge variant="outline">{skillfulness[0]}/100</Badge>
            </div>
            <Slider value={skillfulness} onValueChange={setSkillfulness} min={1} max={100} step={1} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Award className="h-4 w-4" />
                Difficulty (sucks-ness)
              </Label>
              <Badge variant="outline">{difficulty[0]}/100</Badge>
            </div>
            <Slider value={difficulty} onValueChange={setDifficulty} min={1} max={100} step={1} />
          </div>

          {/* The computed Thanks value sits below the sliders as a quiet,
              secondary readout — the ratings are the primary input. */}
          <p className="text-center text-xs text-muted-foreground">
            {thanksPerHour} Thanks/hour · ≈ {previewTotal} Thanks for {previewHours}h of work
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCompleting}>
            Cancel
          </Button>
          <Button onClick={handleComplete} disabled={isCompleting}>
            {isCompleting ? "Completing…" : "Complete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
