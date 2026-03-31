/**
 * @fileoverview JobTimerTab - Time-tracking interface for job shifts.
 *
 * Shown within the job detail page. Provides a start/stop timer, elapsed time
 * display, and shift history using refs and effects for accurate timekeeping.
 */
"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Play, Pause, Square, Clock, Calendar, BarChart3 } from "lucide-react"
import type { JobShift } from "@/types/domain"

interface WorkPeriod {
  id: string
  taskId: string
  taskName: string
  startTime: Date
  endTime?: Date
  duration: number // in seconds
  notes?: string
}

interface JobTimerTabProps {
  job: JobShift
  currentUserId: string
}

export function JobTimerTab({ job, currentUserId }: JobTimerTabProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string>("")
  const [workPeriods, setWorkPeriods] = useState<WorkPeriod[]>([])
  const [currentPeriod, setCurrentPeriod] = useState<WorkPeriod | null>(null)
  const periodCounter = useRef(0)

  // Get tasks assigned to current user
  const myTasks = job.tasks.filter((task) => task.assignedTo === currentUserId)

  useEffect(() => {
    let interval: NodeJS.Timeout
    if (isRunning) {
      interval = setInterval(() => {
        setCurrentTime((prev) => prev + 1)
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [isRunning])

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const handleStart = useCallback(() => {
    if (!selectedTaskId) return

    const task = myTasks.find((t) => t.id === selectedTaskId)
    if (!task) return

    periodCounter.current += 1
    const newPeriod: WorkPeriod = {
      id: `period-${periodCounter.current}`,
      taskId: selectedTaskId,
      taskName: task.name,
      startTime: new Date(),
      duration: 0,
    }

    setCurrentPeriod(newPeriod)
    setCurrentTime(0)
    setIsRunning(true)
  }, [selectedTaskId, myTasks])

  const handlePause = useCallback(() => {
    setIsRunning(false)
  }, [])

  const handleStop = useCallback(() => {
    if (currentPeriod) {
      const completedPeriod: WorkPeriod = {
        ...currentPeriod,
        endTime: new Date(),
        duration: currentTime,
      }

      setWorkPeriods((prev) => [...prev, completedPeriod])
      setCurrentPeriod(null)
    }

    setIsRunning(false)
    setCurrentTime(0)
  }, [currentPeriod, currentTime])

  const getTotalTimeForTask = (taskId: string) => {
    return workPeriods
      .filter((period) => period.taskId === taskId)
      .reduce((total, period) => total + period.duration, 0)
  }

  const getTotalTimeWorked = () => {
    return workPeriods.reduce((total, period) => total + period.duration, 0) + (currentPeriod ? currentTime : 0)
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
          {/* Task Selection */}
          <div>
            <label className="text-sm font-medium mb-2 block">Select Task</label>
            <Select value={selectedTaskId} onValueChange={setSelectedTaskId} disabled={isRunning}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a task to work on" />
              </SelectTrigger>
              <SelectContent>
                {myTasks.map((task) => (
                  <SelectItem key={task.id} value={task.id}>
                    {task.name} ({task.points} points)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Timer Display */}
          <div className="text-center py-8">
            <div className="text-6xl font-mono font-bold mb-4">{formatTime(currentTime)}</div>
            {currentPeriod && (
              <div className="text-lg text-gray-600 mb-4">
                Working on: <span className="font-medium">{currentPeriod.taskName}</span>
              </div>
            )}
            <div className="flex justify-center gap-2">
              {!isRunning ? (
                <Button onClick={handleStart} disabled={!selectedTaskId} size="lg">
                  <Play className="h-5 w-5 mr-2" />
                  Start
                </Button>
              ) : (
                <>
                  <Button onClick={handlePause} variant="outline" size="lg">
                    <Pause className="h-5 w-5 mr-2" />
                    Pause
                  </Button>
                  <Button onClick={handleStop} variant="destructive" size="lg">
                    <Square className="h-5 w-5 mr-2" />
                    Stop
                  </Button>
                </>
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
            <p className="text-sm text-gray-600">Total Time Today</p>
            <p className="text-2xl font-bold">{formatTime(getTotalTimeWorked())}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <BarChart3 className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p className="text-sm text-gray-600">Work Sessions</p>
            <p className="text-2xl font-bold">{workPeriods.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <Calendar className="h-8 w-8 mx-auto mb-2 text-purple-500" />
            <p className="text-sm text-gray-600">Tasks Worked</p>
            <p className="text-2xl font-bold">{new Set(workPeriods.map((p) => p.taskId)).size}</p>
          </CardContent>
        </Card>
      </div>

      {/* Task Time Breakdown */}
      {myTasks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Time by Task</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {myTasks.map((task) => {
                const timeSpent = getTotalTimeForTask(task.id)
                return (
                  <div key={task.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div>
                      <h4 className="font-medium">{task.name}</h4>
                      <p className="text-sm text-gray-600">Estimated: {task.estimatedTime}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-bold">{formatTime(timeSpent)}</p>
                      <Badge variant="outline" className="text-xs">
                        {task.points} points
                      </Badge>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Work History */}
      {workPeriods.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Work History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {workPeriods
                .slice()
                .reverse()
                .map((period) => (
                  <div key={period.id} className="flex justify-between items-center p-3 border rounded-lg">
                    <div>
                      <h4 className="font-medium">{period.taskName}</h4>
                      <p className="text-sm text-gray-600">
                        {period.startTime.toLocaleTimeString()} - {period.endTime?.toLocaleTimeString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-bold">{formatTime(period.duration)}</p>
                      <p className="text-xs text-gray-500">{period.startTime.toLocaleDateString()}</p>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {myTasks.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <Clock className="h-12 w-12 mx-auto mb-4 text-gray-400" />
            <h3 className="text-lg font-semibold mb-2">No Tasks Assigned</h3>
            <p className="text-gray-600">You need to claim some tasks before you can start tracking time.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
