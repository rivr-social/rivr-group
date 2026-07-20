"use client"

import { useState, useMemo, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ArrowLeft, MapPin, Clock, Users, Star, Calendar, Briefcase } from "lucide-react"
import type { JobShift, ProjectRecord } from "@/types/domain"
import { JobAboutTab } from "@/components/job-about-tab"
import { JobAdminPanel } from "@/components/job-admin-panel"
import { JobTasksTab } from "@/components/job-tasks-tab"
import { JobTimerTab } from "@/components/job-timer-tab"
import { JobClaimPanel } from "@/components/job-claim-panel"
import { JobPointsTab } from "@/components/job-points-tab"
import { JobQaReviewTab } from "@/components/job-qa-review-tab"
import { CommentFeed } from "@/components/comment-feed"
import { NavBreadcrumbs } from "@/components/nav-breadcrumbs"
import type { BreadcrumbNode } from "@/lib/breadcrumbs"
import { formatDateStable } from "@/lib/utils"
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
  stockNeedLists: import("@/lib/stock").StockNeedList[]
  /** Whether the viewer may edit stock needs (job owner or group content-write). */
  stockCanManage: boolean
  /** Server-computed: viewer may manage the job (owner or group write access). */
  canManage: boolean
  /** Server-computed: viewer may attest task completions (group authority OR
   *  the project lead/QA — the claim → attest rail). */
  canAttest: boolean
  /**
   * Server-resolved display names for the job's assignee agent ids
   * (`{ [agentId]: name }`). Passed straight to the About tab's Team Members
   * list so claimants render as their name, not a raw UUID.
   */
  assigneeNames?: Record<string, string>
  /** Server-computed peer point-share data (Points tab); null hides the tab. */
  share?: JobShareData | null
  /** Server-computed admin QA review data (Review tab); null hides the tab. */
  reviewData?: JobQaReviewData | null
  /** Server-computed: every cash-payout receipt on the job has settled a real
   *  Stripe transfer. When true the admin "Release payment" control shows a
   *  "Paid ✓" indicator instead of a live release button. */
  payoutReleased?: boolean
  /**
   * Server-computed hierarchical breadcrumb chain (group → subgroup → project →
   * job), root-first with the job last. Empty when there's no containment to
   * show. Resolved from the job's owner_id + linked project server-side.
   */
  breadcrumbItems?: BreadcrumbNode[]
}

export function JobDetailClient({ jobId, initialJob: serverJob, jobShifts, projects, userBadgeIds, currentUserId, claimPanel, stockInventory, stockNeedLists, stockCanManage, canManage, canAttest, assigneeNames, share, reviewData, payoutReleased = false, breadcrumbItems = [] }: JobDetailClientProps) {
  const router = useRouter()
  const effectiveUserId = currentUserId ?? ""

  // Derive initial job and parentProject from jobId (pure lookup)
  const initialJob = useMemo(() => serverJob ?? jobShifts.find((j) => j.id === jobId) ?? null, [serverJob, jobId, jobShifts])
  const parentProject = useMemo(() => {
    if (!initialJob) return null
    return projects.find(p => p.jobs && p.jobs.includes(jobId)) || null
  }, [initialJob, jobId, projects])
  // Allow local task updates to override the derived job (optimistic task chips).
  const [jobOverride, setJobOverride] = useState<JobShift | null>(null)
  // Any server refresh (a payKind/detail edit, an attest, a claim) delivers a
  // fresh `serverJob`; drop the stale optimistic override so the authoritative
  // job — INCLUDING a just-changed payKind (fixed → volunteer) — takes effect
  // immediately instead of being shadowed by the pre-edit snapshot.
  useEffect(() => {
    setJobOverride(null)
  }, [serverJob])
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
        {/* Hierarchical breadcrumb (group → subgroup → project → job). Falls back
            to the simple "Part of project" line when the server chain is empty. */}
        {breadcrumbItems.length >= 2 ? (
          <NavBreadcrumbs items={breadcrumbItems} className="mb-3" />
        ) : parentProject ? (
          <div className="mb-3">
            <p className="text-sm text-muted-foreground">
              Part of project: <span className="font-medium text-foreground">{parentProject.title}</span>
            </p>
          </div>
        ) : null}
        <div className="flex justify-between items-start mb-4">
          <div>
            <Badge variant="outline" className="mb-2 bg-blue-100 text-blue-800 border-blue-200">
              <Briefcase className="mr-1 h-3 w-3" />
              Job
            </Badge>
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
                <p className="font-medium">{formatDateStable(job.deadline)}</p>
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
        <JobAdminPanel job={job} canManage={canManage} payoutReleased={payoutReleased} />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList
          className={`grid w-full ${
            (() => {
              // Base tabs: About, Tasks, Timer, Discussion, Stock (5) + optional
              // Points (share) + optional Review (reviewData).
              const count = 5 + (share ? 1 : 0) + (reviewData ? 1 : 0)
              return count === 7 ? "grid-cols-7" : count === 6 ? "grid-cols-6" : "grid-cols-5"
            })()
          }`}
        >
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({totalTasks})</TabsTrigger>
          <TabsTrigger value="timer">Timer</TabsTrigger>
          {share && <TabsTrigger value="points">Points</TabsTrigger>}
          {reviewData && <TabsTrigger value="review">Review</TabsTrigger>}
          <TabsTrigger value="discussion">Discussion</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
        </TabsList>

        <TabsContent value="about" className="mt-6">
          <JobAboutTab job={job} currentUserId={effectiveUserId} assigneeNames={assigneeNames} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-6">
          <JobTasksTab job={job} currentUserId={effectiveUserId} userBadgeIds={userBadgeIds} canAttest={canAttest} onTaskUpdate={(updatedJob) => setJobOverride(updatedJob)} />
        </TabsContent>

        <TabsContent value="timer" className="mt-6">
          <JobTimerTab job={job} currentUserId={effectiveUserId} />
        </TabsContent>

        {share && (
          <TabsContent value="points" className="mt-6">
            <JobPointsTab share={share} canManage={canManage} canAttest={canAttest} payKind={job.payKind} estimatedHours={job.maxHours ?? null} />
          </TabsContent>
        )}

        {reviewData && (
          <TabsContent value="review" className="mt-6">
            <JobQaReviewTab data={reviewData} />
          </TabsContent>
        )}

        <TabsContent value="discussion" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Discussion</CardTitle>
            </CardHeader>
            <CardContent>
              <CommentFeed targetId={jobId} embedded />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stock" className="mt-6">
          <StockTab
            parentType="job"
            parentId={jobId}
            inventory={stockInventory}
            initialLists={stockNeedLists}
            canManage={stockCanManage}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
