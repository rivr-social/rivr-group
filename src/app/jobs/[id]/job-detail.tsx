"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ArrowLeft, MapPin, Clock, Users, Star, Calendar } from "lucide-react"
import type { JobShift, ProjectRecord } from "@/types/domain"
import { JobAboutTab } from "@/components/job-about-tab"
import { JobAdminPanel } from "@/components/job-admin-panel"
import { JobTasksTab } from "@/components/job-tasks-tab"
import { JobTimerTab } from "@/components/job-timer-tab"
import { JobClaimPanel } from "@/components/job-claim-panel"
import { JobPointsTab } from "@/components/job-points-tab"
import { JobQaReviewTab } from "@/components/job-qa-review-tab"
import { StockTab } from "@/components/stock-tab"
import type { StockInventoryItem, StockNeed } from "@/lib/stock"
import type { JobClaimPanelData } from "@/app/actions/interactions/project-team"
import type { JobShareData } from "@/app/actions/job-peer-allocation"
import type { JobQaReviewData } from "@/app/actions/job-qa"

interface JobDetailClientProps {
  jobId: string
  initialJob?: JobShift | null
  jobShifts: JobShift[]
  projects: ProjectRecord[]
  userBadgeIds: string[]
  currentUserId: string | null
  claimPanel?: JobClaimPanelData | null
  /** Read-only stock inventory linked to this job (Stock → Inventory subtab). */
  stockInventory: StockInventoryItem[]
  /** Persisted Needs list for the Stock → Needs subtab. */
  stockNeeds: StockNeed[]
  /** Whether the viewer may edit stock needs (job owner or group content-write). */
  stockCanManage: boolean
  /** Server-computed: viewer may manage the job (owner or group write access). */
  canManage: boolean
  /** Server-computed: viewer may attest task completions (group authority OR
   *  the project lead/QA — the claim → attest rail). */
  canAttest: boolean
  /** Server-computed peer point-share data (Points tab); null hides the tab. */
  share?: JobShareData | null
  /** Server-computed admin QA review data (Review tab); null hides the tab. */
  reviewData?: JobQaReviewData | null
}

export function JobDetailClient({ jobId, initialJob: serverJob, jobShifts, projects, userBadgeIds, currentUserId, claimPanel, stockInventory, stockNeeds, stockCanManage, canManage, canAttest, share, reviewData }: JobDetailClientProps) {
  const router = useRouter()
  const effectiveUserId = currentUserId ?? ""

  // Derive initial job and parentProject from jobId (pure lookup)
  const initialJob = useMemo(() => serverJob ?? jobShifts.find((j) => j.id === jobId) ?? null, [serverJob, jobId, jobShifts])
  const parentProject = useMemo(() => {
    if (!initialJob) return null
    return projects.find(p => p.jobs && p.jobs.includes(jobId)) || null
  }, [initialJob, jobId, projects])
  // Allow local task updates to override the derived job
  const [jobOverride, setJobOverride] = useState<JobShift | null>(null)
  const job = jobOverride?.id === jobId ? jobOverride : initialJob
  const [activeTab, setActiveTab] = useState("about")

  const handleBackNavigation = () => {
    if (parentProject) {
      router.push(`/projects/${parentProject.id}`)
    } else {
      router.back()
    }
  }

  if (!job) {
    return (
      <div className="container max-w-4xl mx-auto p-4">
        <Button variant="ghost" onClick={handleBackNavigation} className="mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold mb-2">Job Not Found</h2>
          <p className="text-gray-600">The job you&apos;re looking for doesn&apos;t exist or has been removed.</p>
        </div>
      </div>
    )
  }

  const _isAssigned = job.assignees.includes(effectiveUserId)
  const completedTasks = job.tasks.filter((task) => task.completed).length
  const totalTasks = job.tasks.length
  const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "text-red-600 bg-red-50"
      case "medium":
        return "text-yellow-600 bg-yellow-50"
      case "low":
        return "text-green-600 bg-green-50"
      default:
        return "text-gray-600 bg-gray-50"
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open":
        return "text-green-600 bg-green-50"
      case "in-progress":
        return "text-blue-600 bg-blue-50"
      case "completed":
        return "text-gray-600 bg-gray-50"
      case "cancelled":
        return "text-red-600 bg-red-50"
      default:
        return "text-gray-600 bg-gray-50"
    }
  }

  return (
    <div className="container max-w-6xl mx-auto p-4 pb-20">
      <Button variant="ghost" onClick={handleBackNavigation} className="mb-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        {parentProject ? `Back to ${parentProject.title}` : "Back to Jobs"}
      </Button>

      {/* Job Header */}
      <div className="mb-6">
        {parentProject && (
          <div className="mb-3">
            <p className="text-sm text-gray-500">
              Part of project: <span className="font-medium text-blue-600">{parentProject.title}</span>
            </p>
          </div>
        )}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h1 className="text-3xl font-bold mb-2">{job.title}</h1>
            <p className="text-gray-600 text-lg">{job.description}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Badge className={getPriorityColor(job.priority)}>
              {job.priority.charAt(0).toUpperCase() + job.priority.slice(1)} Priority
            </Badge>
            <Badge className={getStatusColor(job.status)}>
              {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
            </Badge>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="p-4 text-center">
              <MapPin className="h-5 w-5 mx-auto mb-2 text-gray-500" />
              <p className="text-sm text-gray-600">Location</p>
              <p className="font-medium">{job.location}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Clock className="h-5 w-5 mx-auto mb-2 text-gray-500" />
              <p className="text-sm text-gray-600">Duration</p>
              <p className="font-medium">{job.duration}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Users className="h-5 w-5 mx-auto mb-2 text-gray-500" />
              <p className="text-sm text-gray-600">Team</p>
              <p className="font-medium">
                {job.assignees.length}/{job.maxAssignees}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Star className="h-5 w-5 mx-auto mb-2 text-yellow-500" />
              <p className="text-sm text-gray-600">Points</p>
              <p className="font-medium">{job.totalPoints}</p>
            </CardContent>
          </Card>
          {job.deadline && (
            <Card>
              <CardContent className="p-4 text-center">
                <Calendar className="h-5 w-5 mx-auto mb-2 text-gray-500" />
                <p className="text-sm text-gray-600">Deadline</p>
                <p className="font-medium">{new Date(job.deadline).toLocaleDateString()}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Progress Bar */}
        {totalTasks > 0 && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold">Overall Progress</h3>
                <span className="text-sm text-gray-500">
                  {completedTasks}/{totalTasks} tasks completed
                </span>
              </div>
              <Progress value={progress} className="h-3" />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Claim / approval panel */}
      {claimPanel && <JobClaimPanel data={claimPanel} />}

      {/* Admin controls — always available to owners/group admins, on every tab */}
      <div className="mb-6">
        <JobAdminPanel job={job} canManage={canManage} />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList
          className={`grid w-full ${
            4 + (share ? 1 : 0) + (reviewData ? 1 : 0) === 6
              ? "grid-cols-6"
              : 4 + (share ? 1 : 0) + (reviewData ? 1 : 0) === 5
                ? "grid-cols-5"
                : "grid-cols-4"
          }`}
        >
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({totalTasks})</TabsTrigger>
          <TabsTrigger value="timer">Timer</TabsTrigger>
          {share && <TabsTrigger value="points">Points</TabsTrigger>}
          {reviewData && <TabsTrigger value="review">Review</TabsTrigger>}
          <TabsTrigger value="stock">Stock</TabsTrigger>
        </TabsList>

        <TabsContent value="about" className="mt-6">
          <JobAboutTab job={job} currentUserId={effectiveUserId} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-6">
          <JobTasksTab job={job} currentUserId={effectiveUserId} userBadgeIds={userBadgeIds} canAttest={canAttest} onTaskUpdate={(updatedJob) => setJobOverride(updatedJob)} />
        </TabsContent>

        <TabsContent value="timer" className="mt-6">
          <JobTimerTab job={job} currentUserId={effectiveUserId} />
        </TabsContent>

        {share && (
          <TabsContent value="points" className="mt-6">
            <JobPointsTab share={share} />
          </TabsContent>
        )}

        {reviewData && (
          <TabsContent value="review" className="mt-6">
            <JobQaReviewTab data={reviewData} />
          </TabsContent>
        )}

        <TabsContent value="stock" className="mt-6">
          <StockTab
            parentType="job"
            parentId={jobId}
            inventory={stockInventory}
            initialNeeds={stockNeeds}
            canManage={stockCanManage}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
