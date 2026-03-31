/**
 * @fileoverview JobAboutTab - Displays detailed information about a job posting.
 *
 * Used on the job detail page to show job description, requirements, team members,
 * and metadata such as badges and avatars.
 */
"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { MessageSquare, Users, Award, MapPin, Clock, Calendar } from "lucide-react"
import type { JobShift } from "@/types/domain"

interface JobAboutTabProps {
  job: JobShift
  currentUserId: string
}

export function JobAboutTab({ job, currentUserId: _currentUserId }: JobAboutTabProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main Content */}
      <div className="lg:col-span-2 space-y-6">
        {/* Description */}
        <Card>
          <CardHeader>
            <CardTitle>Job Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700 leading-relaxed">{job.description}</p>
          </CardContent>
        </Card>

        {/* Required Skills */}
        {job.requiredBadges.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Award className="h-5 w-5" />
                Required Skills
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {job.requiredBadges.map((badge) => (
                  <Badge key={badge} variant="secondary">
                    {badge.replace("-", " ").replace(/\b\w/g, (l) => l.toUpperCase())}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Comments */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Discussion ({job.comments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {job.comments.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No comments yet. Be the first to start the discussion!</p>
            ) : (
              <div className="space-y-4">
                {job.comments.map((comment) => (
                  <div key={comment.id} className="border-l-2 border-gray-200 pl-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src="/placeholder-user.jpg" />
                        <AvatarFallback>{comment.userId.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium text-sm">{comment.userId}</span>
                      <span className="text-xs text-gray-500">{new Date(comment.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm text-gray-700 mb-2">{comment.content}</p>
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="ml-4 space-y-2">
                        {comment.replies.map((reply) => (
                          <div key={reply.id} className="bg-gray-50 rounded p-2">
                            <div className="flex items-center gap-2 mb-1">
                              <Avatar className="h-5 w-5">
                                <AvatarImage src="/placeholder-user.jpg" />
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
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sidebar */}
      <div className="space-y-6">
        {/* Job Details */}
        <Card>
          <CardHeader>
            <CardTitle>Job Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-gray-500" />
              <span className="text-sm">{job.location}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-500" />
              <span className="text-sm">{job.duration}</span>
            </div>
            {job.deadline && (
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-500" />
                <span className="text-sm">Due: {new Date(job.deadline).toLocaleDateString()}</span>
              </div>
            )}
            <Separator />
            <div className="flex justify-between">
              <span className="text-sm text-gray-600">Category</span>
              <Badge variant="outline">{job.category}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-600">Total Points</span>
              <span className="font-medium">{job.totalPoints}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-600">Team Size</span>
              <span className="font-medium">
                {job.assignees.length}/{job.maxAssignees}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Team Members */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Team Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            {job.assignees.length === 0 ? (
              <p className="text-gray-500 text-sm">No team members yet.</p>
            ) : (
              <div className="space-y-3">
                {job.assignees.map((assignee) => (
                  <div key={assignee} className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src="/placeholder-user.jpg" />
                      <AvatarFallback>{assignee.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium text-sm">{assignee}</p>
                      <p className="text-xs text-gray-500">Team Member</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
