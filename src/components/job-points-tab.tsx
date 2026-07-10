"use client"

/**
 * JobPointsTab — job-level point pool, peer allocation, and "claim complete"
 * (2026-07-10).
 *
 * Every assignee sets relative sliders over the OTHER assignees; the final
 * split of the job's point pool is the average of all raters' normalized
 * distributions (equal split until anyone rates), settled at mark-done. The
 * assignee's "Claim complete" flow carries the voucher-style self-ratings
 * (skillfulness required + difficulty, 1–100) on the job-level
 * work-completion claim for the reviewing admin/QA.
 *
 * Assignee status and share data are SERVER-computed (`getJobShareData`) —
 * the client user-context cannot see federated remote-viewer sessions.
 */

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Award, CheckCircle2, Star, Users, Zap } from "lucide-react"
import { setJobPointShareInputAction, claimJobFinishedAction, type JobShareData } from "@/app/actions/job-peer-allocation"
import { useToast } from "@/components/ui/use-toast"

/** Default slider weight for an unrated teammate. */
const DEFAULT_WEIGHT = 50

interface JobPointsTabProps {
  share: JobShareData
}

export function JobPointsTab({ share }: JobPointsTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const others = useMemo(
    () => share.assignees.filter((a) => a.id !== share.viewerId),
    [share],
  )

  // Slider state: my weight per other assignee (0–100 relative).
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {}
    for (const a of share.assignees) {
      if (a.id === share.viewerId) continue
      initial[a.id] = share.myWeights[a.id] ?? DEFAULT_WEIGHT
    }
    return initial
  })

  // Claim-complete self-ratings.
  const [skillfulness, setSkillfulness] = useState([50])
  const [difficulty, setDifficulty] = useState([50])
  const [claimOpen, setClaimOpen] = useState(false)

  const handleSaveShares = () => {
    startTransition(async () => {
      const result = await setJobPointShareInputAction(share.jobId, weights)
      if (result.success) {
        toast({ title: "Point shares saved", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Failed to save shares", description: result.message, variant: "destructive" })
      }
    })
  }

  const handleClaimComplete = () => {
    startTransition(async () => {
      const result = await claimJobFinishedAction(share.jobId, {
        skillfulness: skillfulness[0],
        difficulty: difficulty[0],
      })
      if (result.success) {
        setClaimOpen(false)
        toast({ title: "Claimed finished", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Failed to claim complete", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Aggregate allocation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-md flex items-center gap-2">
            <Star className="h-4 w-4 text-yellow-500" />
            {share.jobPoints !== null ? `Job Points — ${share.jobPoints} pool` : "Point Shares"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {share.assignees.length === 0 ? (
            <p className="text-sm text-muted-foreground">No assignees yet — claim the job to join the split.</p>
          ) : (
            share.assignees.map((a) => {
              const fraction = share.shareFractions[a.id] ?? 0
              const points = share.preview[a.id]
              return (
                <div key={a.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{a.name}</span>
                    <span className="text-muted-foreground">
                      {(fraction * 100).toFixed(1)}%
                      {typeof points === "number" ? ` · ${points} pts` : ""}
                    </span>
                  </div>
                  <Progress value={fraction * 100} className="h-2" />
                </div>
              )
            })
          )}
          <p className="text-xs text-muted-foreground">
            The split is the average of every assignee&apos;s sliders (equal until anyone rates);
            it settles as stake points when the job is marked done.
          </p>
        </CardContent>
      </Card>

      {/* My sliders over the other assignees */}
      {share.viewerIsAssignee && others.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-md flex items-center gap-2">
              <Users className="h-4 w-4" /> Your Assessment
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {others.map((a) => (
              <div key={a.id}>
                <div className="flex items-center justify-between mb-2">
                  <Label>{a.name}</Label>
                  <Badge variant="outline">{weights[a.id] ?? DEFAULT_WEIGHT}</Badge>
                </div>
                <Slider
                  value={[weights[a.id] ?? DEFAULT_WEIGHT]}
                  onValueChange={(value) => setWeights((prev) => ({ ...prev, [a.id]: value[0] }))}
                  min={0}
                  max={100}
                  step={1}
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Rate each teammate&apos;s relative contribution — your own share comes from THEIR sliders.
            </p>
            <Button size="sm" onClick={handleSaveShares} disabled={isPending}>
              {isPending ? "Saving…" : "Save shares"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Claim complete (assignees) */}
      {share.viewerIsAssignee && (
        <Card>
          <CardContent className="p-4 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" /> Claim the job complete
              </p>
              <p className="text-sm text-muted-foreground">
                Rate the work&apos;s required skillfulness and difficulty; an admin or QA reviews and settles.
              </p>
            </div>
            {share.viewerClaimedComplete ? (
              <Badge variant="secondary" className="bg-yellow-100 text-yellow-800">Claimed — awaiting review</Badge>
            ) : (
              <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">Claim complete</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Claim this job finished</DialogTitle>
                    <DialogDescription>
                      Your ratings ride on the completion claim and surface to the reviewer.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-6 py-2">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <Label className="flex items-center gap-2"><Zap className="h-4 w-4" />Skillfulness required</Label>
                        <Badge variant="outline">{skillfulness[0]}/100</Badge>
                      </div>
                      <Slider value={skillfulness} onValueChange={setSkillfulness} min={1} max={100} step={1} />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <Label className="flex items-center gap-2"><Award className="h-4 w-4" />Difficulty</Label>
                        <Badge variant="outline">{difficulty[0]}/100</Badge>
                      </div>
                      <Slider value={difficulty} onValueChange={setDifficulty} min={1} max={100} step={1} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setClaimOpen(false)} disabled={isPending}>
                      Cancel
                    </Button>
                    <Button onClick={handleClaimComplete} disabled={isPending}>
                      {isPending ? "Claiming…" : "Claim finished"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

