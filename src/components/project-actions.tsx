/**
 * @fileoverview ProjectActions - Edit/delete actions for project detail pages.
 *
 * Displayed when the current user is the project owner. Provides inline editing
 * and delete confirmation using `updateResource` and `deleteResource` server actions.
 */
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { updateResource, deleteResource } from "@/app/actions/create-resources"
import { completeProjectAction } from "@/app/actions/project-completion"
import { addJobToProjectAction } from "@/app/actions/job-management"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
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

/**
 * Props for owner-only project edit/delete actions.
 */
interface ProjectActionsProps {
  projectId: string
  projectName: string
  projectDescription?: string | null
  ownerId?: string | null
  /** Current project timeframe (datetime-local strings), for the range editor. */
  timeframeStart?: string | null
  timeframeEnd?: string | null
  /** Current project budget in dollars, for the edit dialog. */
  budget?: number | null
  /**
   * Server-computed authority (owner OR group write access). When provided it
   * replaces the legacy client-context owner check — the client user-context
   * cannot see federated remote-viewer sessions, so admin surfaces must not
   * gate on it.
   */
  canManage?: boolean
}

/**
 * Renders owner-only project mutation controls.
 *
 * @param props - Project identifiers and existing editable values.
 * @returns Edit/delete controls when current user owns the project; otherwise null.
 */
export function ProjectActions({ projectId, projectName, projectDescription, ownerId, timeframeStart, timeframeEnd, budget, canManage }: ProjectActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCompleteOpen, setIsCompleteOpen] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [draftName, setDraftName] = useState(projectName)
  const [draftDescription, setDraftDescription] = useState(projectDescription ?? "")
  const [draftStart, setDraftStart] = useState(timeframeStart ?? "")
  const [draftEnd, setDraftEnd] = useState(timeframeEnd ?? "")
  const [draftBudget, setDraftBudget] = useState(budget != null && budget > 0 ? String(budget) : "")

  // Add-job dialog state
  const [isAddJobOpen, setIsAddJobOpen] = useState(false)
  const [isAddingJob, setIsAddingJob] = useState(false)
  const [jobTitle, setJobTitle] = useState("")
  const [jobDescription, setJobDescription] = useState("")
  const [jobPayKind, setJobPayKind] = useState<"none" | "fixed" | "hourly">("none")
  const [jobPayAmount, setJobPayAmount] = useState("")
  const [jobHourlyRate, setJobHourlyRate] = useState("")
  const [jobMaxAssignees, setJobMaxAssignees] = useState("1")
  const [jobDeadline, setJobDeadline] = useState("")

  /**
   * Syncs draft fields from latest server values when edit dialog opens.
   */
  useEffect(() => {
    if (!isEditOpen) return
    setDraftName(projectName)
    setDraftDescription(projectDescription ?? "")
    setDraftStart(timeframeStart ?? "")
    setDraftEnd(timeframeEnd ?? "")
    setDraftBudget(budget != null && budget > 0 ? String(budget) : "")
  }, [isEditOpen, projectName, projectDescription, timeframeStart, timeframeEnd, budget])

  /**
   * Updates project name/description through shared resource action.
   */
  const handleUpdateProject = async () => {
    const trimmedName = draftName.trim()
    const trimmedDescription = draftDescription.trim()

    if (!trimmedName) {
      toast({
        title: "Missing project name",
        description: "Project name is required.",
        variant: "destructive",
      })
      return
    }

    setIsUpdating(true)
    try {
      const result = await updateResource({
        resourceId: projectId,
        name: trimmedName,
        description: trimmedDescription || null,
        content: trimmedDescription || null,
        metadataPatch: {
          timeframe: draftStart || draftEnd ? { start: draftStart || null, end: draftEnd || null } : null,
          deadline: draftEnd || null,
          budget: draftBudget.trim() && Number(draftBudget) > 0 ? Number(draftBudget) : null,
        },
      })

      if (!result.success) {
        toast({
          title: "Failed to update project",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsEditOpen(false)
      toast({ title: "Project updated" })
      router.refresh()
    } catch {
      toast({
        title: "Failed to update project",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  /**
   * Completes the project: expenses are already debited, so the remaining
   * project-wallet balance sweeps into the owning group's treasury.
   */
  const handleCompleteProject = async () => {
    setIsCompleting(true)
    try {
      const result = await completeProjectAction(projectId)
      if (!result.success) {
        toast({ title: "Failed to complete project", description: result.message, variant: "destructive" })
        return
      }
      setIsCompleteOpen(false)
      toast({ title: "Project completed", description: result.message })
      router.refresh()
    } catch {
      toast({ title: "Failed to complete project", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsCompleting(false)
    }
  }

  /**
   * Soft-deletes the project through shared resource deletion action.
   */
  const handleDeleteProject = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteResource(projectId)

      if (!result.success) {
        toast({
          title: "Failed to delete project",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsDeleteOpen(false)
      toast({ title: "Project deleted" })
      router.push("/")
      router.refresh()
    } catch {
      toast({
        title: "Failed to delete project",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsDeleting(false)
    }
  }

  /**
   * Creates a job under this project through the structural-add action.
   */
  const handleAddJob = async () => {
    const trimmedTitle = jobTitle.trim()
    if (!trimmedTitle) {
      toast({ title: "Missing job title", description: "A job title is required.", variant: "destructive" })
      return
    }
    const toCents = (value: string): number | null => {
      const parsed = Number(value.trim().replace(/[^0-9.]/g, ""))
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null
    }
    const payAmountCents = toCents(jobPayAmount)
    const hourlyRateCents = toCents(jobHourlyRate)
    if (jobPayKind === "fixed" && !payAmountCents) {
      toast({ title: "Missing amount", description: "Set a cash value for fixed-pay jobs.", variant: "destructive" })
      return
    }
    if (jobPayKind === "hourly" && !hourlyRateCents) {
      toast({ title: "Missing rate", description: "Set an hourly rate for hourly jobs.", variant: "destructive" })
      return
    }
    const maxAssignees = Number.parseInt(jobMaxAssignees, 10)

    setIsAddingJob(true)
    try {
      const result = await addJobToProjectAction(projectId, {
        title: trimmedTitle,
        description: jobDescription.trim() || undefined,
        payKind: jobPayKind === "none" ? null : jobPayKind,
        payAmountCents: jobPayKind === "fixed" ? payAmountCents : null,
        hourlyRateCents: jobPayKind === "hourly" ? hourlyRateCents : null,
        maxAssignees: Number.isInteger(maxAssignees) && maxAssignees > 0 ? maxAssignees : 1,
        deadline: jobDeadline || null,
      })
      if (!result.success) {
        toast({ title: "Failed to add job", description: result.message, variant: "destructive" })
        return
      }
      setJobTitle("")
      setJobDescription("")
      setJobPayKind("none")
      setJobPayAmount("")
      setJobHourlyRate("")
      setJobMaxAssignees("1")
      setJobDeadline("")
      setIsAddJobOpen(false)
      toast({ title: "Job added" })
      router.refresh()
    } catch {
      toast({ title: "Failed to add job", description: "An unexpected error occurred.", variant: "destructive" })
    } finally {
      setIsAddingJob(false)
    }
  }

  /**
   * Authority gate: prefer the server-computed `canManage` (owner OR group
   * write access, remote-viewer-aware); fall back to the legacy client-side
   * owner check for callsites that don't pass it.
   */
  const allowed = canManage ?? Boolean(ownerId && currentUser?.id && currentUser.id === ownerId)
  if (!allowed) return null

  return (
    <div className="flex items-center gap-2">
      <Dialog open={isAddJobOpen} onOpenChange={setIsAddJobOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Add job
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add a job</DialogTitle>
            <DialogDescription>
              Create a work item under this project. It inherits the project&apos;s visibility.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`add-job-title-${projectId}`}>Title</Label>
              <Input
                id={`add-job-title-${projectId}`}
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
                placeholder="Job title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`add-job-description-${projectId}`}>Description</Label>
              <Textarea
                id={`add-job-description-${projectId}`}
                value={jobDescription}
                onChange={(event) => setJobDescription(event.target.value)}
                placeholder="What is this job about?"
              />
            </div>
            <div className="space-y-2">
              <Label>Cash compensation</Label>
              <Select value={jobPayKind} onValueChange={(value) => setJobPayKind(value as typeof jobPayKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Points only (no cash)</SelectItem>
                  <SelectItem value="fixed">Fixed amount for the job</SelectItem>
                  <SelectItem value="hourly">Hourly rate × tracked time</SelectItem>
                </SelectContent>
              </Select>
              {jobPayKind === "fixed" && (
                <Input
                  inputMode="decimal"
                  placeholder="Cash value in USD, e.g. 250"
                  value={jobPayAmount}
                  onChange={(event) => setJobPayAmount(event.target.value)}
                />
              )}
              {jobPayKind === "hourly" && (
                <Input
                  inputMode="decimal"
                  placeholder="Hourly rate in USD, e.g. 25"
                  value={jobHourlyRate}
                  onChange={(event) => setJobHourlyRate(event.target.value)}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor={`add-job-slots-${projectId}`}>Max assignees</Label>
                <Input
                  id={`add-job-slots-${projectId}`}
                  inputMode="numeric"
                  value={jobMaxAssignees}
                  onChange={(event) => setJobMaxAssignees(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`add-job-deadline-${projectId}`}>Deadline</Label>
                <Input
                  id={`add-job-deadline-${projectId}`}
                  type="date"
                  value={jobDeadline}
                  onChange={(event) => setJobDeadline(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddJobOpen(false)} disabled={isAddingJob}>
              Cancel
            </Button>
            <Button onClick={() => void handleAddJob()} disabled={isAddingJob}>
              {isAddingJob ? "Adding..." : "Add job"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>Update your project name and description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`project-name-${projectId}`}>Name</Label>
              <Input
                id={`project-name-${projectId}`}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Project name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`project-description-${projectId}`}>Description</Label>
              <Textarea
                id={`project-description-${projectId}`}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Describe your project..."
                className="min-h-[140px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`project-budget-${projectId}`}>Budget (USD)</Label>
              <Input
                id={`project-budget-${projectId}`}
                inputMode="decimal"
                value={draftBudget}
                onChange={(event) => setDraftBudget(event.target.value)}
                placeholder="e.g. 5000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`project-timeframe-${projectId}`}>Timeframe</Label>
              <DateTimeRangePicker
                id={`project-timeframe-${projectId}`}
                start={draftStart}
                end={draftEnd}
                onChange={(s, e) => {
                  setDraftStart(s)
                  setDraftEnd(e)
                }}
                startLabel="Start time"
                endLabel="End time"
                placeholder="Set the project start & end"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdateProject()} disabled={isUpdating}>
              {isUpdating ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isCompleteOpen} onOpenChange={setIsCompleteOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm">
            Complete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Complete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              The project is marked completed and its treasury settles: expenses are
              already debited, so the remaining balance — the net — sweeps into the
              owning group&apos;s treasury. Run a net distribution first if this
              project&apos;s net should split beyond the owning group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCompleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleCompleteProject()} disabled={isCompleting}>
              {isCompleting ? "Completing..." : "Complete & settle"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The project and its detail page will be removed from active surfaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteProject()} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
