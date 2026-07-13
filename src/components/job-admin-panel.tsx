/**
 * @fileoverview JobAdminPanel - Always-available admin controls on the job
 * detail page (2026-07-07 projects/treasury sprint).
 *
 * Rendered above the job tabs for owners/group admins (the `canManage` gate is
 * SERVER-computed on the page and passed down — the client user-context can't
 * see federated remote-viewer sessions, so it must not gate admin surfaces).
 *
 * Controls: edit job (name, description, compensation, slots, deadline),
 * add task (the coeurulea content-pass surface), and mark done (completes the
 * job, records contributions, and settles cash pay from the group treasury).
 */
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { updateResource } from "@/app/actions/create-resources"
import { addTaskToJobAction } from "@/app/actions/job-management"
import { markJobDoneAction } from "@/app/actions/job-completion"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BadgeCheck, ListPlus, Pencil } from "lucide-react"
import type { JobShift } from "@/types/domain"

interface JobAdminPanelProps {
  job: JobShift
  /** Server-computed: job owner or group write access on the owning agent. */
  canManage: boolean
}

/** Formats cents as a plain dollar string for input defaults (e.g. 2500 → "25"). */
function centsToDollarInput(cents: number | null): string {
  if (cents === null || cents <= 0) return ""
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)
}

/** Parses a dollar input string to integer cents, or null when empty/invalid. */
function dollarInputToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed.replace(/[^0-9.]/g, ""))
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100)
}

export function JobAdminPanel({ job, canManage }: JobAdminPanelProps) {
  const router = useRouter()
  const { toast } = useToast()

  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isAddTaskOpen, setIsAddTaskOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)

  // Edit drafts
  const [draftName, setDraftName] = useState(job.title)
  const [draftDescription, setDraftDescription] = useState(job.description)
  const [draftPayKind, setDraftPayKind] = useState<"none" | "fixed" | "hourly" | "volunteer">(job.payKind ?? "none")
  const [draftPayAmount, setDraftPayAmount] = useState(centsToDollarInput(job.payAmountCents))
  const [draftHourlyRate, setDraftHourlyRate] = useState(centsToDollarInput(job.hourlyRateCents))
  const [draftMaxAssignees, setDraftMaxAssignees] = useState(String(job.maxAssignees || 1))
  const [draftStartDate, setDraftStartDate] = useState(job.startDate ? job.startDate.slice(0, 10) : "")
  const [draftDeadline, setDraftDeadline] = useState(job.deadline ? job.deadline.slice(0, 10) : "")
  const [draftMaxHours, setDraftMaxHours] = useState(job.maxHours ? String(job.maxHours) : "")
  const [draftJobPoints, setDraftJobPoints] = useState(
    typeof job.points === "number" && job.points > 0 ? String(job.points) : "",
  )

  // Add-task drafts
  const [taskName, setTaskName] = useState("")
  const [taskDescription, setTaskDescription] = useState("")
  const [taskPoints, setTaskPoints] = useState("")
  const [taskEstimate, setTaskEstimate] = useState("")
  const [taskDeadline, setTaskDeadline] = useState("")
  const [taskMaxHours, setTaskMaxHours] = useState("")

  useEffect(() => {
    if (!isEditOpen) return
    setDraftName(job.title)
    setDraftDescription(job.description)
    setDraftPayKind(job.payKind ?? "none")
    setDraftPayAmount(centsToDollarInput(job.payAmountCents))
    setDraftHourlyRate(centsToDollarInput(job.hourlyRateCents))
    setDraftMaxAssignees(String(job.maxAssignees || 1))
    setDraftStartDate(job.startDate ? job.startDate.slice(0, 10) : "")
    setDraftDeadline(job.deadline ? job.deadline.slice(0, 10) : "")
    setDraftMaxHours(job.maxHours ? String(job.maxHours) : "")
    setDraftJobPoints(typeof job.points === "number" && job.points > 0 ? String(job.points) : "")
  }, [isEditOpen, job])

  if (!canManage) return null

  const isCompleted = job.status === "completed"

  const handleSaveJob = async () => {
    const trimmedName = draftName.trim()
    if (!trimmedName) {
      toast({ title: "Missing job title", description: "A job title is required.", variant: "destructive" })
      return
    }
    const payAmountCents = dollarInputToCents(draftPayAmount)
    const hourlyRateCents = dollarInputToCents(draftHourlyRate)
    if (draftPayKind === "fixed" && !payAmountCents) {
      toast({ title: "Missing amount", description: "Set a cash value for fixed-pay jobs.", variant: "destructive" })
      return
    }
    if (draftPayKind === "hourly" && !hourlyRateCents) {
      toast({ title: "Missing rate", description: "Set an hourly rate for hourly jobs.", variant: "destructive" })
      return
    }
    const maxAssignees = Number.parseInt(draftMaxAssignees, 10)
    const maxHours = draftMaxHours.trim() ? Number(draftMaxHours) : null
    if (maxHours !== null && (!Number.isFinite(maxHours) || maxHours <= 0)) {
      toast({ title: "Invalid max hours", description: "The hour budget must be a positive number.", variant: "destructive" })
      return
    }
    const jobPoints = draftJobPoints.trim() ? Number(draftJobPoints) : null
    if (jobPoints !== null && (!Number.isFinite(jobPoints) || jobPoints < 0)) {
      toast({ title: "Invalid points", description: "Job points must be a non-negative number.", variant: "destructive" })
      return
    }
    if (draftStartDate && draftDeadline && draftDeadline < draftStartDate) {
      toast({ title: "Invalid dates", description: "The deadline must not be before the start date.", variant: "destructive" })
      return
    }

    setIsSaving(true)
    try {
      const result = await updateResource({
        resourceId: job.id,
        name: trimmedName,
        description: draftDescription.trim() || null,
        content: draftDescription.trim() || null,
        metadataPatch: {
          payKind: draftPayKind === "none" ? null : draftPayKind,
          payAmountCents: draftPayKind === "fixed" ? payAmountCents : null,
          hourlyRateCents: draftPayKind === "hourly" ? hourlyRateCents : null,
          maxAssignees: Number.isInteger(maxAssignees) && maxAssignees > 0 ? maxAssignees : 1,
          startDate: draftStartDate || null,
          deadline: draftDeadline || null,
          maxHours,
          points: jobPoints,
        },
      })
      if (!result.success) {
        toast({ title: "Failed to update job", description: result.message, variant: "destructive" })
        return
      }
      setIsEditOpen(false)
      toast({ title: "Job updated" })
      router.refresh()
    } catch {
      toast({ title: "Failed to update job", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsSaving(false)
    }
  }

  const handleAddTask = async () => {
    const trimmedName = taskName.trim()
    if (!trimmedName) {
      toast({ title: "Missing task name", description: "A task name is required.", variant: "destructive" })
      return
    }
    const points = taskPoints.trim() ? Number(taskPoints) : null
    if (points !== null && (!Number.isFinite(points) || points < 0)) {
      toast({ title: "Invalid points", description: "Points must be a non-negative number.", variant: "destructive" })
      return
    }

    const maxHours = taskMaxHours.trim() ? Number(taskMaxHours) : null
    if (maxHours !== null && (!Number.isFinite(maxHours) || maxHours <= 0)) {
      toast({ title: "Invalid max hours", description: "The hour budget must be a positive number.", variant: "destructive" })
      return
    }

    setIsAddingTask(true)
    try {
      const result = await addTaskToJobAction(job.id, {
        name: trimmedName,
        description: taskDescription.trim() || undefined,
        points,
        estimatedTime: taskEstimate.trim() || null,
        deadline: taskDeadline || null,
        maxHours,
      })
      if (!result.success) {
        toast({ title: "Failed to add task", description: result.message, variant: "destructive" })
        return
      }
      setTaskName("")
      setTaskDescription("")
      setTaskPoints("")
      setTaskEstimate("")
      setTaskDeadline("")
      setTaskMaxHours("")
      setIsAddTaskOpen(false)
      toast({ title: "Task added" })
      router.refresh()
    } catch {
      toast({ title: "Failed to add task", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsAddingTask(false)
    }
  }

  const handleMarkDone = async () => {
    setIsCompleting(true)
    try {
      const result = await markJobDoneAction(job.id)
      if (!result.success) {
        toast({ title: "Failed to mark job done", description: result.message, variant: "destructive" })
        return
      }
      toast({ title: "Job completed", description: result.message })
      router.refresh()
    } catch {
      toast({ title: "Failed to mark job done", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsCompleting(false)
    }
  }

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">Admin</Badge>
          <span>
            {job.payKind === "fixed" && job.payAmountCents
              ? `Pays $${(job.payAmountCents / 100).toFixed(2)} (fixed)`
              : job.payKind === "hourly" && job.hourlyRateCents
                ? `Pays $${(job.hourlyRateCents / 100).toFixed(2)}/hr (tracked time)`
                : job.payKind === "volunteer"
                  ? "Volunteer — mints a Thanks voucher"
                  : "Points-only job"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit job
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Edit job</DialogTitle>
                <DialogDescription>Update details, compensation, and claim slots.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`job-name-${job.id}`}>Title</Label>
                  <Input
                    id={`job-name-${job.id}`}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`job-description-${job.id}`}>Description</Label>
                  <Textarea
                    id={`job-description-${job.id}`}
                    value={draftDescription}
                    onChange={(event) => setDraftDescription(event.target.value)}
                    className="min-h-[100px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Pay method</Label>
                  <Select value={draftPayKind} onValueChange={(value) => setDraftPayKind(value as typeof draftPayKind)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Points only (no cash)</SelectItem>
                      <SelectItem value="fixed">Fixed amount for the job</SelectItem>
                      <SelectItem value="hourly">Hourly rate × tracked time</SelectItem>
                      <SelectItem value="volunteer">Volunteer (mints a Thanks voucher)</SelectItem>
                    </SelectContent>
                  </Select>
                  {draftPayKind === "volunteer" && (
                    <p className="text-xs text-muted-foreground">
                      No cash moves. Marking the job done mints each volunteer a Thanks voucher the
                      group claims — valued from their claim-complete ratings.
                    </p>
                  )}
                  {draftPayKind === "fixed" && (
                    <div className="space-y-1">
                      <Label htmlFor={`job-pay-${job.id}`} className="text-xs text-muted-foreground">
                        Cash value (USD, split across assignees)
                      </Label>
                      <Input
                        id={`job-pay-${job.id}`}
                        inputMode="decimal"
                        placeholder="e.g. 250"
                        value={draftPayAmount}
                        onChange={(event) => setDraftPayAmount(event.target.value)}
                      />
                    </div>
                  )}
                  {draftPayKind === "hourly" && (
                    <div className="space-y-1">
                      <Label htmlFor={`job-rate-${job.id}`} className="text-xs text-muted-foreground">
                        Hourly rate (USD, paid against the job timer)
                      </Label>
                      <Input
                        id={`job-rate-${job.id}`}
                        inputMode="decimal"
                        placeholder="e.g. 25"
                        value={draftHourlyRate}
                        onChange={(event) => setDraftHourlyRate(event.target.value)}
                      />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`job-slots-${job.id}`}>Max assignees</Label>
                    <Input
                      id={`job-slots-${job.id}`}
                      inputMode="numeric"
                      value={draftMaxAssignees}
                      onChange={(event) => setDraftMaxAssignees(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`job-maxhours-${job.id}`}>Max hours</Label>
                    <Input
                      id={`job-maxhours-${job.id}`}
                      inputMode="decimal"
                      value={draftMaxHours}
                      onChange={(event) => setDraftMaxHours(event.target.value)}
                      placeholder="hour budget"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`job-startdate-${job.id}`}>Start date</Label>
                    <Input
                      id={`job-startdate-${job.id}`}
                      type="date"
                      value={draftStartDate}
                      onChange={(event) => setDraftStartDate(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`job-deadline-${job.id}`}>Deadline</Label>
                    <Input
                      id={`job-deadline-${job.id}`}
                      type="date"
                      value={draftDeadline}
                      onChange={(event) => setDraftDeadline(event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`job-points-${job.id}`}>Job points (task-less jobs)</Label>
                  <Input
                    id={`job-points-${job.id}`}
                    inputMode="numeric"
                    value={draftJobPoints}
                    onChange={(event) => setDraftJobPoints(event.target.value)}
                    placeholder="split across assignees at completion"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isSaving}>
                  Cancel
                </Button>
                <Button onClick={() => void handleSaveJob()} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save changes"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isAddTaskOpen} onOpenChange={setIsAddTaskOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <ListPlus className="mr-1.5 h-3.5 w-3.5" />
                Add task
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add a task</DialogTitle>
                <DialogDescription>
                  Tasks carry the points assignees earn; the job&apos;s progress tracks their completion.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`task-name-${job.id}`}>Task name</Label>
                  <Input
                    id={`task-name-${job.id}`}
                    value={taskName}
                    onChange={(event) => setTaskName(event.target.value)}
                    placeholder="What needs doing?"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`task-description-${job.id}`}>Description</Label>
                  <Textarea
                    id={`task-description-${job.id}`}
                    value={taskDescription}
                    onChange={(event) => setTaskDescription(event.target.value)}
                    placeholder="Details, acceptance criteria..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`task-points-${job.id}`}>Points</Label>
                    <Input
                      id={`task-points-${job.id}`}
                      inputMode="numeric"
                      value={taskPoints}
                      onChange={(event) => setTaskPoints(event.target.value)}
                      placeholder="e.g. 10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`task-estimate-${job.id}`}>Time estimate</Label>
                    <Input
                      id={`task-estimate-${job.id}`}
                      value={taskEstimate}
                      onChange={(event) => setTaskEstimate(event.target.value)}
                      placeholder="e.g. 2h"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={`task-deadline-${job.id}`}>Deadline</Label>
                    <Input
                      id={`task-deadline-${job.id}`}
                      type="date"
                      value={taskDeadline}
                      onChange={(event) => setTaskDeadline(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`task-maxhours-${job.id}`}>Max hours</Label>
                    <Input
                      id={`task-maxhours-${job.id}`}
                      inputMode="decimal"
                      value={taskMaxHours}
                      onChange={(event) => setTaskMaxHours(event.target.value)}
                      placeholder="budget"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddTaskOpen(false)} disabled={isAddingTask}>
                  Cancel
                </Button>
                <Button onClick={() => void handleAddTask()} disabled={isAddingTask}>
                  {isAddingTask ? "Adding..." : "Add task"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" disabled={isCompleted || isCompleting}>
                <BadgeCheck className="mr-1.5 h-3.5 w-3.5" />
                {isCompleted ? "Completed" : isCompleting ? "Completing..." : "Mark done"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark this job done?</AlertDialogTitle>
                <AlertDialogDescription>
                  {job.payKind === "volunteer"
                    ? "This completes the job and records a contribution for every assignee. No cash moves — each volunteer receives a Thanks voucher the group claims from them, valued from their claim-complete ratings."
                    : job.payKind
                      ? "This completes the job, records a contribution for every assignee, and pays cash compensation from the group treasury wallet. Payouts blocked by an underfunded treasury are parked and retried the next time you mark it done."
                      : "This completes the job and records a contribution for every assignee. This is a points-only job — no cash moves."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isCompleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleMarkDone()} disabled={isCompleting}>
                  {isCompleting ? "Completing..." : "Mark done"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  )
}
