/**
 * @fileoverview JobDetailsModal - Modal dialog showing full job details.
 *
 * Opened from job board or job card interactions to display comprehensive
 * job information, application status, and action buttons.
 */
"use client"

import { useState, useTransition } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent } from "@/components/ui/card"
import { MapPin, Clock, Users, Star, Calendar, CheckCircle2, Circle, MessageSquare } from "lucide-react"
import type { JobShift } from "@/types/domain"
import { applyToJob } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"

interface JobDetailsModalProps {
  job: JobShift | null
  isOpen: boolean
  onClose: () => void
}

export function JobDetailsModal({ job, isOpen, onClose }: JobDetailsModalProps) {
  const [selectedTasks, setSelectedTasks] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  if (!job) return null

  const completedTasks = job.tasks.filter((task) => task.completed).length
  const totalTasks = job.tasks.length
  const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0

  const handleTaskSelect = (taskId: string) => {
    setSelectedTasks((prev) => (prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]))
  }

  const handleApply = () => {
    startTransition(async () => {
      const result = await applyToJob(job.id)
      if (result.success) {
        toast({
          title: "Application submitted",
          description: result.message,
        })
        onClose()
      } else {
        toast({
          title: "Failed to apply",
          description: result.message,
          variant: "destructive",
        })
      }
    })
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "text-red-600 bg-red-50"
      case "medium":
        return "text-yellow-600 bg-yellow-50"
      case "low":
        return "text-green-600 bg-green-50"
      default:
        return "text-muted-foreground bg-muted"
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open":
        return "text-green-600 bg-green-50"
      case "in-progress":
        return "text-blue-600 bg-blue-50"
      case "completed":
        return "text-muted-foreground bg-muted"
      case "cancelled":
        return "text-red-600 bg-red-50"
      default:
        return "text-muted-foreground bg-muted"
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">{job.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Job Overview */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-gray-500" />
                <span className="text-sm">{job.location}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-gray-500" />
                <span className="text-sm">{job.duration}</span>
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-gray-500" />
                <span className="text-sm">
                  {job.assignees.length}/{job.maxAssignees} assigned
                </span>
              </div>
              {job.deadline && (
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-gray-500" />
                  <span className="text-sm">Due: {new Date(job.deadline).toLocaleDateString()}</span>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Star className="h-4 w-4 text-yellow-500" />
                <span className="text-sm font-medium">{job.totalPoints} points total</span>
              </div>
              <Badge className={getPriorityColor(job.priority)}>
                {job.priority.charAt(0).toUpperCase() + job.priority.slice(1)} Priority
              </Badge>
              <Badge className={getStatusColor(job.status)}>
                {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
              </Badge>
              <Badge variant="outline">{job.category}</Badge>
            </div>
          </div>

          <Separator />

          {/* Description */}
          <div>
            <h3 className="font-semibold mb-2">Description</h3>
            <p className="text-gray-700">{job.description}</p>
          </div>

          {/* Required Badges */}
          {job.requiredBadges.length > 0 && (
            <div>
              <h3 className="font-semibold mb-2">Required Skills</h3>
              <div className="flex flex-wrap gap-2">
                {job.requiredBadges.map((badge) => (
                  <Badge key={badge} variant="secondary">
                    {badge.replace("-", " ").replace(/\b\w/g, (l) => l.toUpperCase())}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Progress */}
          {totalTasks > 0 && (
            <div>
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold">Progress</h3>
                <span className="text-sm text-gray-500">
                  {completedTasks}/{totalTasks} tasks completed
                </span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {/* Tasks */}
          {job.tasks.length > 0 && (
            <div>
              <h3 className="font-semibold mb-3">Tasks</h3>
              <div className="space-y-3">
                {job.tasks.map((task) => (
                  <Card key={task.id} className="border-l-4 border-l-blue-500">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                          <button
                            onClick={() => handleTaskSelect(task.id)}
                            className="mt-1"
                            disabled={!!(task.completed || task.assignedTo)}
                          >
                            {task.completed ? (
                              <CheckCircle2 className="h-5 w-5 text-green-500" />
                            ) : (
                              <Circle
                                className={`h-5 w-5 ${
                                  selectedTasks.includes(task.id) ? "text-blue-500" : "text-gray-400"
                                }`}
                              />
                            )}
                          </button>
                          <div className="flex-1">
                            <h4 className="font-medium">{task.name}</h4>
                            <p className="text-sm text-gray-600 mt-1">{task.description}</p>
                            <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                              <span>⭐ {task.points} points</span>
                              <span>⏱️ {task.estimatedTime}</span>
                              {task.assignedTo && <span>👤 Assigned to {task.assignedTo}</span>}
                              {task.requiredBadge && (
                                <Badge variant="outline" className="text-xs">
                                  Requires: {task.requiredBadge.replace("-", " ")}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Current Assignees */}
          {job.assignees.length > 0 && (
            <div>
              <h3 className="font-semibold mb-2">Current Team</h3>
              <div className="flex flex-wrap gap-2">
                {job.assignees.map((assignee) => (
                  <div key={assignee} className="flex items-center gap-2 bg-muted rounded-full px-3 py-1">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={`/placeholder-user.jpg`} />
                      <AvatarFallback>{assignee.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm">{assignee}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          {job.comments.length > 0 && (
            <div>
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Comments ({job.comments.length})
              </h3>
              <div className="space-y-3">
                {job.comments.map((comment) => (
                  <div key={comment.id} className="bg-muted rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={`/placeholder-user.jpg`} />
                        <AvatarFallback>{comment.userId.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium text-sm">{comment.userId}</span>
                      <span className="text-xs text-gray-500">{new Date(comment.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm text-gray-700">{comment.content}</p>
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="ml-6 mt-2 space-y-2">
                        {comment.replies.map((reply) => (
                          <div key={reply.id} className="bg-card rounded p-2">
                            <div className="flex items-center gap-2 mb-1">
                              <Avatar className="h-5 w-5">
                                <AvatarImage src={`/placeholder-user.jpg`} />
                                <AvatarFallback>{reply.userId.slice(0, 2).toUpperCase()}</AvatarFallback>
                              </Avatar>
                              <span className="font-medium text-xs">{reply.userId}</span>
                              <span className="text-xs text-gray-500">
                                {new Date(reply.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <p className="text-xs text-gray-700">{reply.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4 border-t">
            {job.status === "open" && job.assignees.length < job.maxAssignees && (
              <Button onClick={handleApply} className="flex-1" disabled={isPending}>
                {isPending
                  ? "Applying..."
                  : selectedTasks.length > 0
                  ? `Apply for ${selectedTasks.length} task${selectedTasks.length > 1 ? "s" : ""}`
                  : "Apply for Job"}
              </Button>
            )}
            {job.status === "open" && job.assignees.length >= job.maxAssignees && (
              <Button disabled className="flex-1">
                <Users className="h-4 w-4 mr-2" />
                Team Full
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
