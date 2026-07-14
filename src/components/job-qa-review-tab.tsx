"use client"

/**
 * JobQaReviewTab — the attester's admin review surface on the job detail page
 * (2026-07-13).
 *
 * Renders, per assignee, the recorded work periods (current `workperiod`
 * resources AND legacy `time_entry` rows), their claim-complete ratings /
 * proposed points, their attested points, and the DISCREPANCIES between
 * claimed and recorded/attested values — with inline editing of both the
 * recorded durations and the attested point values.
 *
 * All authority is SERVER-computed (`getJobQaReviewData` returns null for
 * non-admins) and every mutation re-checks it server-side; this component
 * never gates on client user-context (federated remote-viewer sessions are
 * invisible to it). Point edits route through the attestation single-writer.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"
import { AlertTriangle, Clock, Pencil, Star, Check, X } from "lucide-react"
import {
  editWorkPeriodDurationAction,
  setAttestedPointsAction,
  type JobQaReviewData,
  type JobAssigneeReview,
  type JobWorkPeriodRow,
  type JobDiscrepancyKind,
} from "@/app/actions/job-qa"

const MS_PER_HOUR = 3_600_000

interface JobQaReviewTabProps {
  data: JobQaReviewData
}

/** Formats a ms duration as "Hh Mm" (or "Mm" under an hour). */
function formatDuration(ms: number): string {
  if (ms <= 0) return "0m"
  const hours = Math.floor(ms / MS_PER_HOUR)
  const minutes = Math.round((ms % MS_PER_HOUR) / 60000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** Discrepancy badge color by severity. */
const DISCREPANCY_STYLE: Record<JobDiscrepancyKind, string> = {
  claimed_no_time: "bg-red-100 text-red-800 border-red-200",
  time_over_budget: "bg-orange-100 text-orange-800 border-orange-200",
  claimed_unattested: "bg-yellow-100 text-yellow-800 border-yellow-200",
  proposed_vs_attested: "bg-blue-100 text-blue-800 border-blue-200",
}

export function JobQaReviewTab({ data }: JobQaReviewTabProps) {
  if (data.assignees.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          No one has claimed this job yet — recorded work and claims will appear here for review.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Review each contributor&apos;s recorded time and attested points before you mark the job done.
        Discrepancies between what was <em>claimed</em> and what was <em>recorded/attested</em> are flagged.
      </p>
      {data.assignees.map((assignee) => (
        <AssigneeReviewCard key={assignee.assigneeId} jobId={data.jobId} assignee={assignee} canAttest={data.canAttest} />
      ))}
    </div>
  )
}

// ─── Per-assignee card ────────────────────────────────────────────────────────

function AssigneeReviewCard({
  jobId,
  assignee,
  canAttest,
}: {
  jobId: string
  assignee: JobAssigneeReview
  canAttest: boolean
}) {
  const reviewableTasks = assignee.tasks.filter(
    (t) => t.claimStatus !== null || t.attestedPoints !== null || t.taskPoints > 0,
  )
  const showJobPoints =
    assignee.jobProposedPoints !== null || assignee.jobAttestedPoints !== null || assignee.jobClaimStatus !== null

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-md flex items-center gap-2">
            {assignee.assigneeName}
            <span className="text-xs font-normal text-muted-foreground inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(assignee.trackedMs)} tracked · {assignee.totalAttestedPoints} pts attested
            </span>
          </CardTitle>
          <div className="flex flex-wrap gap-1">
            {assignee.discrepancies.map((d, i) => (
              <Badge key={i} variant="outline" className={`text-xs ${DISCREPANCY_STYLE[d.kind]}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                {d.message}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Claim ratings */}
        {(assignee.claimSkillfulness !== null || assignee.claimDifficulty !== null) && (
          <div className="text-xs text-muted-foreground">
            Claim ratings —
            {assignee.claimSkillfulness !== null ? ` skillfulness ${assignee.claimSkillfulness}/100` : ""}
            {assignee.claimSkillfulness !== null && assignee.claimDifficulty !== null ? " ·" : ""}
            {assignee.claimDifficulty !== null ? ` difficulty ${assignee.claimDifficulty}/100` : ""}
            {assignee.jobClaimStatus ? ` · claim ${assignee.jobClaimStatus}` : ""}
          </div>
        )}

        {/* Recorded work periods */}
        <div>
          <p className="text-sm font-medium mb-2">Recorded work periods</p>
          {assignee.workPeriods.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recorded work periods.</p>
          ) : (
            <div className="space-y-2">
              {assignee.workPeriods.map((period) => (
                <WorkPeriodRow key={period.id} period={period} canEdit={canAttest} />
              ))}
            </div>
          )}
        </div>

        {/* Attested points */}
        <div>
          <p className="text-sm font-medium mb-2">Points</p>
          <div className="space-y-2">
            {showJobPoints && (
              <PointsRow
                label="Job-level"
                targetId={jobId}
                targetType="job"
                workerId={assignee.assigneeId}
                proposedPoints={assignee.jobProposedPoints}
                attestedPoints={assignee.jobAttestedPoints}
                canEdit={canAttest}
              />
            )}
            {reviewableTasks.length === 0 && !showJobPoints ? (
              <p className="text-xs text-muted-foreground">No task points to review.</p>
            ) : (
              reviewableTasks.map((task) => (
                <PointsRow
                  key={task.taskId}
                  label={task.taskName}
                  targetId={task.taskId}
                  targetType="task"
                  workerId={assignee.assigneeId}
                  proposedPoints={task.proposedPoints}
                  attestedPoints={task.attestedPoints}
                  claimStatus={task.claimStatus}
                  canEdit={canAttest}
                />
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Editable work-period duration row ────────────────────────────────────────

function WorkPeriodRow({ period, canEdit }: { period: JobWorkPeriodRow; canEdit: boolean }) {
  const router = useRouter()
  const { toast } = useToast()
  const [isEditing, setIsEditing] = useState(false)
  const [hours, setHours] = useState((period.durationMs / MS_PER_HOUR).toFixed(2))
  const [isPending, startTransition] = useTransition()

  const save = () => {
    const parsed = Number(hours)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({ title: "Invalid duration", description: "Enter a non-negative number of hours.", variant: "destructive" })
      return
    }
    const durationMs = Math.round(parsed * MS_PER_HOUR)
    startTransition(async () => {
      const result = await editWorkPeriodDurationAction({ workPeriodId: period.id, source: period.source, durationMs })
      if (result.success) {
        setIsEditing(false)
        toast({ title: "Work period updated" })
        router.refresh()
      } else {
        toast({ title: "Failed to update", description: result.message, variant: "destructive" })
      }
    })
  }

  const startStop = [period.startedAt, period.stoppedAt]
    .map((t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"))
    .join(" – ")

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{period.taskName ?? "Whole job"}</span>
          {period.source === "legacy" && (
            <Badge variant="outline" className="text-[10px]">legacy</Badge>
          )}
          {period.running && (
            <Badge variant="outline" className="text-[10px] text-orange-700">running</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{startStop}</p>
        {period.editedBy && (
          <p className="text-[10px] text-muted-foreground">
            edited{period.previousDurationMs !== null ? ` (was ${formatDuration(period.previousDurationMs)})` : ""}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isEditing ? (
          <>
            <Input
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              inputMode="decimal"
              className="h-7 w-20 text-sm"
              aria-label="Duration in hours"
              autoFocus
            />
            <span className="text-xs text-muted-foreground">h</span>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={save} disabled={isPending} aria-label="Save duration">
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600" onClick={() => setIsEditing(false)} disabled={isPending} aria-label="Cancel">
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="font-mono font-medium tabular-nums">{formatDuration(period.durationMs)}</span>
            {canEdit && !period.running && (
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setIsEditing(true)} aria-label="Edit duration">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Editable attested-points row ─────────────────────────────────────────────

function PointsRow({
  label,
  targetId,
  targetType,
  workerId,
  proposedPoints,
  attestedPoints,
  claimStatus,
  canEdit,
}: {
  label: string
  targetId: string
  targetType: "task" | "job"
  workerId: string
  proposedPoints: number | null
  attestedPoints: number | null
  claimStatus?: string | null
  canEdit: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [isEditing, setIsEditing] = useState(false)
  const [value, setValue] = useState(String(attestedPoints ?? proposedPoints ?? 0))
  const [isPending, startTransition] = useTransition()

  const mismatch =
    proposedPoints !== null && attestedPoints !== null && proposedPoints !== attestedPoints

  const save = () => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({ title: "Invalid points", description: "Enter a non-negative number.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await setAttestedPointsAction({ targetId, targetType, workerId, points: Math.round(parsed) })
      if (result.success) {
        setIsEditing(false)
        toast({ title: "Points attested", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Failed to attest", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium truncate">{label}</span>
        <p className="text-xs text-muted-foreground">
          {proposedPoints !== null ? `proposed ${proposedPoints}` : "no proposal"}
          {claimStatus ? ` · ${claimStatus}` : ""}
          {mismatch && <span className="text-blue-700"> · differs from attested</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isEditing ? (
          <>
            <Star className="h-3.5 w-3.5 text-yellow-500" />
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="numeric"
              className="h-7 w-16 text-sm"
              aria-label="Attested points"
              autoFocus
            />
            <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={save} disabled={isPending} aria-label="Save points">
              <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600" onClick={() => setIsEditing(false)} disabled={isPending} aria-label="Cancel">
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 font-medium">
              <Star className="h-3.5 w-3.5 text-yellow-500" />
              {attestedPoints ?? "—"}
            </span>
            {canEdit && (
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setIsEditing(true)} aria-label="Edit attested points">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
