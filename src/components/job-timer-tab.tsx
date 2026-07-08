/**
 * @fileoverview JobTimerTab - Time-tracking interface for a job.
 *
 * Pressing Start creates a persisted `workperiod` record on the server
 * (startJobTimer); Stop closes it (stopJobTimer). Work periods survive reloads
 * and feed hourly-rate payout. A task may optionally be selected to scope the
 * period; otherwise it is a job-level work period.
 */
"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { Play, Square, Clock, Calendar, BarChart3, Loader2 } from "lucide-react"
import type { JobShift } from "@/types/domain"
import {
  startJobTimer,
  stopJobTimer,
  getJobTimerStatus,
  listJobWorkPeriods,
  type WorkPeriodRecord,
} from "@/app/actions/job-timer"

interface JobTimerTabProps {
  job: JobShift
  currentUserId: string
}

/** Sentinel Select value for "no specific task" (job-level work period). */
const NO_TASK_VALUE = "__job_level__"

export function JobTimerTab({ job, currentUserId }: JobTimerTabProps) {
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string>(NO_TASK_VALUE)
  const [myPeriods, setMyPeriods] = useState<WorkPeriodRecord[]>([])
  const runningStartedAtRef = useRef<number | null>(null)

  const taskName = (taskId: string | null) =>
    (taskId && job.tasks.find((t) => t.id === taskId)?.name) || "General"

  const refresh = useCallback(async () => {
    const [status, periods] = await Promise.all([
      getJobTimerStatus(job.id),
      listJobWorkPeriods(job.id),
    ])
    const mine = periods.filter((p) => p.workerId === currentUserId)
    setMyPeriods(mine)
    if (status.activeTimer) {
      setIsRunning(true)
      runningStartedAtRef.current = new Date(status.activeTimer.startedAt).getTime()
      setSelectedTaskId(status.activeTimer.taskId ?? NO_TASK_VALUE)
      setElapsedSeconds(Math.floor((Date.now() - runningStartedAtRef.current) / 1000))
    } else {
      setIsRunning(false)
      runningStartedAtRef.current = null
      setElapsedSeconds(0)
    }
    setIsLoading(false)
  }, [job.id, currentUserId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Tick from the server-recorded start time so a reload shows accurate elapsed.
  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(() => {
      if (runningStartedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - runningStartedAtRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isRunning])

  const formatTime = (seconds: number) => {
    const s = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(s / 3600)
    const minutes = Math.floor((s % 3600) / 60)
    const secs = s % 60
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const handleStart = useCallback(async () => {
    setIsBusy(true)
    try {
      const taskId = selectedTaskId === NO_TASK_VALUE ? undefined : selectedTaskId
      const result = await startJobTimer(job.id, taskId)
      if (!result.success) {
        toast({ title: "Couldn't start timer", description: result.message, variant: "destructive" })
        return
      }
      toast({ title: "Timer started" })
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }, [job.id, selectedTaskId, toast, refresh])

  const handleStop = useCallback(async () => {
    setIsBusy(true)
    try {
      const completed = selectedTaskId === NO_TASK_VALUE ? [] : [selectedTaskId]
      const result = await stopJobTimer(job.id, completed)
      if (!result.success) {
        toast({ title: "Couldn't stop timer", description: result.message, variant: "destructive" })
        return
      }
      const mins = Math.round((result.durationMs ?? 0) / 60000)
      toast({ title: "Timer stopped", description: `Logged ${mins} min work period.` })
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }, [job.id, selectedTaskId, toast, refresh])

  const completedPeriods = myPeriods.filter((p) => p.status === "completed")
  const totalMs = completedPeriods.reduce((sum, p) => sum + (p.durationMs ?? 0), 0)
  const liveMs = isRunning ? elapsedSeconds * 1000 : 0
  const tasksWorked = new Set(completedPeriods.map((p) => p.taskId).filter(Boolean)).size

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading timer…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Timer Control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Work Timer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Optional task selection */}
          {job.tasks.length > 0 && (
            <div>
              <label className="text-sm font-medium mb-2 block">Task (optional)</label>
              <Select value={selectedTaskId} onValueChange={setSelectedTaskId} disabled={isRunning || isBusy}>
                <SelectTrigger>
                  <SelectValue placeholder="Work on the whole job, or pick a task" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TASK_VALUE}>Whole job (no specific task)</SelectItem>
                  {job.tasks.map((task) => (
                    <SelectItem key={task.id} value={task.id}>
                      {task.name} ({task.points} points)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Timer Display */}
          <div className="text-center py-8">
            <div className="text-6xl font-mono font-bold mb-4">{formatTime(elapsedSeconds)}</div>
            {isRunning && (
              <div className="text-lg text-muted-foreground mb-4">
                Working on: <span className="font-medium">{taskName(selectedTaskId === NO_TASK_VALUE ? null : selectedTaskId)}</span>
              </div>
            )}
            <div className="flex justify-center gap-2">
              {!isRunning ? (
                <Button onClick={() => void handleStart()} disabled={isBusy} size="lg">
                  {isBusy ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <Play className="h-5 w-5 mr-2" />}
                  Start
                </Button>
              ) : (
                <Button onClick={() => void handleStop()} variant="destructive" size="lg" disabled={isBusy}>
                  {isBusy ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <Square className="h-5 w-5 mr-2" />}
                  Stop
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Time Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <Clock className="h-8 w-8 mx-auto mb-2 text-blue-500" />
            <p className="text-sm text-muted-foreground">Total Tracked</p>
            <p className="text-2xl font-bold">{formatTime((totalMs + liveMs) / 1000)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <BarChart3 className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p className="text-sm text-muted-foreground">Work Periods</p>
            <p className="text-2xl font-bold">{completedPeriods.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Calendar className="h-8 w-8 mx-auto mb-2 text-purple-500" />
            <p className="text-sm text-muted-foreground">Tasks Worked</p>
            <p className="text-2xl font-bold">{tasksWorked}</p>
          </CardContent>
        </Card>
      </div>

      {/* Work History */}
      {completedPeriods.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Work Periods</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {completedPeriods.map((period) => {
                const start = period.startedAt ? new Date(period.startedAt) : null
                const end = period.stoppedAt ? new Date(period.stoppedAt) : null
                return (
                  <div key={period.id} className="flex justify-between items-center p-3 border rounded-lg">
                    <div>
                      <h4 className="font-medium">{taskName(period.taskId)}</h4>
                      <p className="text-sm text-muted-foreground">
                        {start ? start.toLocaleTimeString() : "—"} - {end ? end.toLocaleTimeString() : "—"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-bold">{formatTime((period.durationMs ?? 0) / 1000)}</p>
                      <p className="text-xs text-muted-foreground">{start ? start.toLocaleDateString() : ""}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {completedPeriods.length === 0 && !isRunning && (
        <Card>
          <CardContent className="p-8 text-center">
            <Clock className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No work periods yet</h3>
            <p className="text-muted-foreground">Press Start to log your first work period on this job.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
