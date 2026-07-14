"use client";

import { useState, useEffect, useTransition, useCallback, useRef } from "react";
import { Briefcase, CheckCircle, ChevronDown, ChevronUp, Clock, Edit, MessageSquare, Play, Send, Square, Star, XCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/components/ui/use-toast";
import { toggleTaskCompletion } from "@/app/actions/toggle-task-completion";
import { updateTaskStatus } from "@/app/actions/interactions";
import { startJobTimer, stopJobTimer } from "@/app/actions/job-timer";
import { addTaskNote, type TaskNote } from "@/app/actions/task-notes";
import { updateTaskDescription } from "@/app/actions/edit-task";

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskResource {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
}

interface JobWithTasks {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  tasks: TaskResource[];
}

interface TimerData {
  activeTimer: {
    id: string;
    startedAt: string;
    stoppedAt: string | null;
    durationMs: number | null;
  } | null;
  totalTimeMs: number;
}

interface ProjectJobsTabProps {
  jobs: JobWithTasks[];
  /** Total points available across all jobs/tasks. */
  totalPoints: number;
  /** Total points already earned (completed tasks). */
  earnedPoints: number;
  /** Timer status keyed by job ID, loaded server-side. */
  timersByJobId?: Record<string, TimerData>;
  /** Aggregate total time across all jobs (ms), for header display. */
  totalProjectTimeMs?: number;
  /** Current authenticated user ID, null if not logged in. */
  currentUserId?: string | null;
  /** Whether the current user is a group admin for this project. */
  isAdmin?: boolean;
}

/** Summary shown after stopping a timer with completed tasks. */
interface WorkPeriodSummary {
  jobId: string;
  taskCount: number;
  durationMs: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_COLOR_MAP: Record<string, string> = {
  active: "text-green-700 bg-green-100",
  open: "text-green-700 bg-green-100",
  planning: "text-blue-700 bg-blue-100",
  "in-progress": "text-blue-700 bg-blue-100",
  in_progress: "text-blue-700 bg-blue-100",
  completed: "text-gray-600 bg-gray-100",
  not_started: "text-orange-700 bg-orange-100",
};

const PRIORITY_BORDER_MAP: Record<string, string> = {
  high: "border-l-red-500",
  medium: "border-l-yellow-500",
  low: "border-l-green-500",
};

const TIMER_TICK_INTERVAL_MS = 1000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getStatusColor(status: string): string {
  return STATUS_COLOR_MAP[status] ?? "text-gray-600 bg-gray-100";
}

function getPriorityBorder(priority: string): string {
  return PRIORITY_BORDER_MAP[priority] ?? "border-l-gray-300";
}

function getJobPoints(job: JobWithTasks): number {
  const fromMeta = typeof job.metadata.totalPoints === "number" ? job.metadata.totalPoints : 0;
  if (fromMeta > 0) return fromMeta;
  return job.tasks.reduce((sum, task) => {
    const pts = typeof task.metadata.points === "number" ? task.metadata.points : 0;
    return sum + pts;
  }, 0);
}

function isTaskCompleted(task: TaskResource): boolean {
  return task.metadata.completed === true || task.metadata.status === "completed";
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Running timers show H:MM:SS, totals show Xh Xm.
 */
function formatElapsed(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTotalTime(ms: number): string {
  if (ms <= 0) return "0m";
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── Job Timer Hook ─────────────────────────────────────────────────────────

function useJobTimer(
  jobId: string,
  initialData?: TimerData,
  onWorkPeriodComplete?: (summary: WorkPeriodSummary) => void,
) {
  const [activeStartedAt, setActiveStartedAt] = useState<string | null>(
    initialData?.activeTimer?.startedAt ?? null,
  );
  const [totalTimeMs, setTotalTimeMs] = useState(initialData?.totalTimeMs ?? 0);
  const [elapsed, setElapsed] = useState(0);
  const [isPending, startTransition] = useTransition();

  // Track task IDs completed during the current work period.
  const completedDuringPeriodRef = useRef<Set<string>>(new Set());

  const isRunning = activeStartedAt !== null;

  // Tick the elapsed counter while a timer is running.
  useEffect(() => {
    if (!activeStartedAt) {
      setElapsed(0);
      return;
    }

    const computeElapsed = () =>
      Math.max(0, Date.now() - new Date(activeStartedAt).getTime());

    setElapsed(computeElapsed());

    const interval = setInterval(() => {
      setElapsed(computeElapsed());
    }, TIMER_TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [activeStartedAt]);

  /** Record a task as completed during the current work period. */
  const trackTaskCompletion = useCallback((taskId: string) => {
    if (activeStartedAt) {
      completedDuringPeriodRef.current.add(taskId);
    }
  }, [activeStartedAt]);

  /** Remove a task from the completed-during-period set (unchecked). */
  const untrackTaskCompletion = useCallback((taskId: string) => {
    completedDuringPeriodRef.current.delete(taskId);
  }, []);

  const handleStart = useCallback(() => {
    startTransition(async () => {
      const result = await startJobTimer(jobId);
      if (result.success) {
        completedDuringPeriodRef.current = new Set();
        setActiveStartedAt(new Date().toISOString());
      }
    });
  }, [jobId]);

  const handleStop = useCallback(() => {
    startTransition(async () => {
      const taskIds = Array.from(completedDuringPeriodRef.current);
      const result = await stopJobTimer(jobId, taskIds);
      if (result.success && result.durationMs !== undefined) {
        setTotalTimeMs((prev) => prev + result.durationMs!);
        onWorkPeriodComplete?.({
          jobId,
          taskCount: taskIds.length,
          durationMs: result.durationMs,
        });
      }
      completedDuringPeriodRef.current = new Set();
      setActiveStartedAt(null);
    });
  }, [jobId, onWorkPeriodComplete]);

  return {
    isRunning,
    elapsed,
    totalTimeMs,
    isPending,
    handleStart,
    handleStop,
    trackTaskCompletion,
    untrackTaskCompletion,
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ProjectJobsTab({
  jobs,
  totalPoints,
  earnedPoints,
  timersByJobId = {},
  totalProjectTimeMs = 0,
  currentUserId = null,
  isAdmin = false,
}: ProjectJobsTabProps) {
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});
  const [optimisticTasks, setOptimisticTasks] = useState<Record<string, boolean>>({});
  // Optimistic attestation status so the Attest/Reject buttons resolve without
  // a reload once an admin acts on a claimed task.
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, "completed" | "rejected">>({});
  const [isPending, startTransition] = useTransition();
  const [workPeriodSummary, setWorkPeriodSummary] = useState<WorkPeriodSummary | null>(null);
  const { toast } = useToast();

  const toggleExpand = (jobId: string) => {
    setExpandedJobs((prev) => ({ ...prev, [jobId]: !prev[jobId] }));
  };

  // Attest (approve) or reject a worker's claimed-finished task. Verification
  // is where stake points land; the server re-checks cascading admin/QA/lead
  // authority (`updateTaskStatus`). Optimistic so the chips resolve instantly.
  const handleAttestTask = (taskId: string, approved: boolean) => {
    setOptimisticStatus((prev) => ({ ...prev, [taskId]: approved ? "completed" : "rejected" }));
    setOptimisticTasks((prev) => ({ ...prev, [taskId]: approved }));
    startTransition(async () => {
      const result = await updateTaskStatus(taskId, approved ? "completed" : "rejected");
      if (!result.success) {
        setOptimisticStatus((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        setOptimisticTasks((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        toast({ title: "Attestation failed", description: result.message, variant: "destructive" });
      } else {
        toast({ title: approved ? "Task attested" : "Task rejected", description: result.message });
      }
    });
  };

  const resolveStatus = (task: TaskResource): string => {
    if (task.id in optimisticStatus) return optimisticStatus[task.id];
    return typeof task.metadata.status === "string" ? task.metadata.status : "not_started";
  };

  const handleToggleTask = (taskId: string, currentCompleted: boolean) => {
    // Optimistic update.
    setOptimisticTasks((prev) => ({ ...prev, [taskId]: !currentCompleted }));

    startTransition(async () => {
      const result = await toggleTaskCompletion(taskId);
      if (!result.success) {
        // Revert optimistic update on failure.
        setOptimisticTasks((prev) => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        return;
      }
      // A non-verifier's check-off lands as a finish-claim awaiting
      // attestation — reflect the real state instead of showing completed.
      if (result.status === "awaiting_approval") {
        setOptimisticTasks((prev) => ({ ...prev, [taskId]: false }));
      }
    });
  };

  const resolveCompleted = (task: TaskResource): boolean => {
    if (taskId(task) in optimisticTasks) {
      return optimisticTasks[taskId(task)];
    }
    return isTaskCompleted(task);
  };

  const taskId = (task: TaskResource) => task.id;

  // Compute live totals including optimistic state.
  const allTasks = jobs.flatMap((j) => j.tasks);
  const completedCount = allTasks.filter(resolveCompleted).length;
  const totalTaskCount = allTasks.length;
  const overallProgress = totalTaskCount > 0 ? Math.round((completedCount / totalTaskCount) * 100) : 0;

  // Compute live earned points.
  const liveEarnedPoints = allTasks.reduce((sum, task) => {
    if (resolveCompleted(task)) {
      const pts = typeof task.metadata.points === "number" ? task.metadata.points : 0;
      return sum + pts;
    }
    return sum;
  }, 0);

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Briefcase className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
          <p className="text-muted-foreground">No jobs have been created for this project yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium">
                {completedCount}/{totalTaskCount} tasks completed
              </span>
              <span className="inline-flex items-center gap-1 text-sm">
                <Star className="h-4 w-4 text-yellow-500" />
                {liveEarnedPoints}/{totalPoints} points
              </span>
              {totalProjectTimeMs > 0 ? (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  {formatTotalTime(totalProjectTimeMs)} logged
                </span>
              ) : null}
            </div>
            <span className="text-sm text-muted-foreground">{overallProgress}%</span>
          </div>
          <Progress value={overallProgress} className="h-2" />
        </CardContent>
      </Card>

      {/* Work period summary banner */}
      {workPeriodSummary ? (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="p-3 flex items-center justify-between">
            <span className="text-sm text-green-800">
              Completed {workPeriodSummary.taskCount} task{workPeriodSummary.taskCount !== 1 ? "s" : ""} in{" "}
              {formatTotalTime(workPeriodSummary.durationMs)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-green-700 hover:text-green-900"
              onClick={() => setWorkPeriodSummary(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Job cards */}
      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          timerData={timersByJobId[job.id]}
          isExpanded={expandedJobs[job.id] ?? false}
          onToggleExpand={toggleExpand}
          resolveCompleted={resolveCompleted}
          resolveStatus={resolveStatus}
          handleToggleTask={handleToggleTask}
          handleAttestTask={handleAttestTask}
          isTaskPending={isPending}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onWorkPeriodComplete={setWorkPeriodSummary}
        />
      ))}
    </div>
  );
}

// ─── Job Card Sub-Component ─────────────────────────────────────────────────

interface JobCardProps {
  job: JobWithTasks;
  timerData?: TimerData;
  isExpanded: boolean;
  onToggleExpand: (jobId: string) => void;
  resolveCompleted: (task: TaskResource) => boolean;
  resolveStatus: (task: TaskResource) => string;
  handleToggleTask: (taskId: string, completed: boolean) => void;
  handleAttestTask: (taskId: string, approved: boolean) => void;
  isTaskPending: boolean;
  currentUserId?: string | null;
  isAdmin?: boolean;
  onWorkPeriodComplete?: (summary: WorkPeriodSummary) => void;
}

function JobCard({
  job,
  timerData,
  isExpanded,
  onToggleExpand,
  resolveCompleted,
  resolveStatus,
  handleToggleTask,
  handleAttestTask,
  isTaskPending,
  currentUserId,
  isAdmin = false,
  onWorkPeriodComplete,
}: JobCardProps) {
  const {
    isRunning,
    elapsed,
    totalTimeMs,
    isPending: isTimerPending,
    handleStart,
    handleStop,
    trackTaskCompletion,
    untrackTaskCompletion,
  } = useJobTimer(job.id, timerData, onWorkPeriodComplete);

  const jobTasks = job.tasks;
  const jobCompleted = jobTasks.filter(resolveCompleted).length;
  const jobTotal = jobTasks.length;
  const jobProgress = jobTotal > 0 ? Math.round((jobCompleted / jobTotal) * 100) : 0;
  const jobPoints = getJobPoints(job);
  const status = typeof job.metadata.status === "string" ? job.metadata.status : "active";
  const priority = typeof job.metadata.priority === "string" ? job.metadata.priority : "medium";

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={() => onToggleExpand(job.id)}
      className="w-full"
    >
      <Card className={`border-l-4 ${getPriorityBorder(priority)}`}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-accent/40 transition-colors">
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-lg">{job.name}</CardTitle>
                  <Badge className={getStatusColor(status)}>
                    {status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </Badge>
                </div>
                {job.description ? (
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                    {job.description}
                  </p>
                ) : null}
              </div>

              {/* Timer button + chevron */}
              <div className="shrink-0 ml-2 flex items-center gap-2">
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                  }}
                  role="presentation"
                >
                  {isRunning ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-orange-600 tabular-nums">
                        {formatElapsed(elapsed)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={handleStop}
                        disabled={isTimerPending}
                        aria-label="Stop timer"
                      >
                        <Square className="h-4 w-4 fill-current" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {totalTimeMs > 0 ? (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTotalTime(totalTimeMs)}
                        </span>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={handleStart}
                        disabled={isTimerPending}
                        aria-label="Start timer"
                      >
                        <Play className="h-4 w-4 fill-current" />
                      </Button>
                    </div>
                  )}
                </div>
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div className="flex items-center gap-2 text-sm">
                <Star className="h-4 w-4 text-yellow-500" />
                <span className="font-medium">{jobPoints} points</span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Tasks</span>
                  <span>
                    {jobCompleted}/{jobTotal}
                  </span>
                </div>
                <Progress value={jobProgress} className="h-2" />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0">
            {jobTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No tasks defined for this job.
              </p>
            ) : (
              <div className="space-y-2">
                {jobTasks.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    completed={resolveCompleted(task)}
                    status={resolveStatus(task)}
                    onToggle={(taskId, wasCompleted) => {
                      handleToggleTask(taskId, wasCompleted);
                      // Track completions during running timer period.
                      if (!wasCompleted) {
                        trackTaskCompletion(taskId);
                      } else {
                        untrackTaskCompletion(taskId);
                      }
                    }}
                    onAttest={handleAttestTask}
                    isTaskPending={isTaskPending}
                    currentUserId={currentUserId}
                    isAdmin={isAdmin}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// ─── Task Item Sub-Component ───────────────────────────────────────────────

interface TaskItemProps {
  task: TaskResource;
  completed: boolean;
  status: string;
  onToggle: (taskId: string, wasCompleted: boolean) => void;
  onAttest: (taskId: string, approved: boolean) => void;
  isTaskPending: boolean;
  currentUserId?: string | null;
  isAdmin?: boolean;
}

function TaskItem({
  task,
  completed,
  status,
  onToggle,
  onAttest,
  isTaskPending,
  currentUserId,
  isAdmin = false,
}: TaskItemProps) {
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editedDescription, setEditedDescription] = useState(task.description ?? "");
  const [localDescription, setLocalDescription] = useState(task.description);
  const [isDescPending, startDescTransition] = useTransition();

  const [noteText, setNoteText] = useState("");
  const [localNotes, setLocalNotes] = useState<TaskNote[]>(
    Array.isArray(task.metadata.notes) ? (task.metadata.notes as TaskNote[]) : [],
  );
  const [isNotePending, startNoteTransition] = useTransition();

  const taskPoints = typeof task.metadata.points === "number" ? task.metadata.points : 0;
  const assigneeId = typeof task.metadata.assigneeId === "string" ? task.metadata.assigneeId : undefined;
  const assignedTo = typeof task.metadata.assignedTo === "string" ? task.metadata.assignedTo : undefined;
  const isAssignee = currentUserId != null && (assigneeId === currentUserId || assignedTo === currentUserId);

  const handleSaveDescription = () => {
    startDescTransition(async () => {
      const result = await updateTaskDescription(task.id, editedDescription);
      if (result.success) {
        setLocalDescription(editedDescription.trim());
        setIsEditingDescription(false);
      }
    });
  };

  const handleAddNote = () => {
    const trimmed = noteText.trim();
    if (trimmed.length === 0) return;

    startNoteTransition(async () => {
      const result = await addTaskNote(task.id, trimmed);
      if (result.success) {
        setLocalNotes((prev) => [
          ...prev,
          {
            text: trimmed,
            authorId: currentUserId ?? "",
            createdAt: new Date().toISOString(),
          },
        ]);
        setNoteText("");
      }
    });
  };

  const displayDescription = localDescription ?? task.description;
  // A worker's claimed-finished task awaits attestation. For an admin the
  // checkbox is NOT the control here — clicking it would RETRACT the claim
  // (toggleTaskCompletion treats awaiting_approval as "done" and reopens it) —
  // so we surface explicit Attest/Reject buttons and lock the checkbox instead.
  const isAwaitingApproval = status === "awaiting_approval";
  const showAttestControls = isAdmin && isAwaitingApproval;

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        completed ? "bg-muted/50" : isAwaitingApproval ? "bg-yellow-50/60" : "bg-background"
      }`}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={completed}
          onCheckedChange={() => onToggle(task.id, completed)}
          disabled={isTaskPending || showAttestControls}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium ${
              completed ? "line-through text-muted-foreground" : "text-foreground"
            }`}
          >
            {task.name}
          </p>

          {/* Description with inline editing for admins */}
          {isEditingDescription ? (
            <div className="flex items-center gap-2 mt-1">
              <Input
                value={editedDescription}
                onChange={(e) => setEditedDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveDescription();
                  if (e.key === "Escape") {
                    setIsEditingDescription(false);
                    setEditedDescription(displayDescription ?? "");
                  }
                }}
                onBlur={handleSaveDescription}
                className="text-xs h-7"
                disabled={isDescPending}
                autoFocus
              />
            </div>
          ) : displayDescription ? (
            <div className="flex items-center gap-1 mt-0.5">
              <p className="text-xs text-muted-foreground">{displayDescription}</p>
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditedDescription(displayDescription);
                    setIsEditingDescription(true);
                  }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Edit description"
                >
                  <Edit className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ) : isAdmin ? (
            <button
              type="button"
              onClick={() => {
                setEditedDescription("");
                setIsEditingDescription(true);
              }}
              className="text-xs text-muted-foreground hover:text-foreground mt-0.5 flex items-center gap-1"
            >
              <Edit className="h-3 w-3" />
              Add description
            </button>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {taskPoints > 0 ? (
            <Badge variant="outline" className="text-xs">
              <Star className="h-3 w-3 mr-1 text-yellow-500" />
              {taskPoints} pts
            </Badge>
          ) : null}
          {isAwaitingApproval ? (
            <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 text-xs">Awaiting approval</Badge>
          ) : null}
        </div>
      </div>

      {/* Attestation controls (cascading admin / QA / lead — server re-checked).
          The claim → attest rail: verification is where stake points land. */}
      {showAttestControls ? (
        <div className="mt-2 ml-8 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 bg-green-50 hover:bg-green-100 text-green-700 border-green-200"
            onClick={() => onAttest(task.id, true)}
            disabled={isTaskPending}
          >
            <CheckCircle className="h-4 w-4 mr-1" /> Attest
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
            onClick={() => onAttest(task.id, false)}
            disabled={isTaskPending}
          >
            <XCircle className="h-4 w-4 mr-1" /> Reject
          </Button>
        </div>
      ) : null}

      {/* Notes section */}
      {(localNotes.length > 0 || isAssignee) ? (
        <div className="mt-2 ml-8 space-y-1.5">
          {localNotes.length > 0 ? (
            <div className="space-y-1">
              {localNotes.map((note, idx) => (
                <div key={`${note.createdAt}-${idx}`} className="flex items-start gap-1.5">
                  <MessageSquare className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    {note.text}
                    <span className="ml-1 opacity-70">
                      &mdash; {formatNoteTimestamp(note.createdAt)}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Note input for assignee */}
          {isAssignee ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddNote();
                }}
                placeholder="Add a note..."
                className="text-xs h-7 flex-1"
                disabled={isNotePending}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={handleAddNote}
                disabled={isNotePending || noteText.trim().length === 0}
                aria-label="Add note"
              >
                <Send className="h-3 w-3" />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Note Timestamp Formatter ──────────────────────────────────────────────

function formatNoteTimestamp(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "just now";
  }
}
