"use client"

/**
 * Job board tab for group pages, displaying projects and their associated jobs.
 *
 * Data flow:
 * - Projects are fetched as child agents of the group (type "project") via `fetchAgentChildren`.
 * - Jobs are fetched as resources owned by each project via `fetchResourcesByOwner`.
 * - Job applications are loaded via `fetchMyJobApplicationIds` and submitted via `applyToJob`.
 *
 * Key props:
 * - `groupId`: the parent group whose projects/jobs are displayed
 * - `currentUserId`: optional authenticated user id for application state
 */

import type React from "react"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { MapPin, Users, Star, Calendar, Plus, Search, ChevronDown, ChevronUp, Briefcase, Shield, Loader2, FolderTree } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetchAgentChildren, fetchResourcesByOwner, fetchGroupDetail, fetchProjectJobBoard } from "@/app/actions/graph"
import type { ProjectJobBoardData, ProjectJobBoardJob } from "@/app/actions/graph"
import type { SerializedAgent, SerializedResource } from "@/lib/graph-serializers"
import { applyToJob, fetchMyJobApplicationIds } from "@/app/actions/interactions"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import { describeJobPay, JOB_PAY_TONE_CLASS } from "@/lib/job-pay"
import { JobClaimButton } from "@/components/job-claim-button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// ---------- Display-shape interfaces derived from real data ----------

interface ProjectDisplay {
  id: string
  title: string
  description: string
  status: string
  category: string
  priority: string
  deadline: string | null
  groupId: string
  /** The subgroup/circle that owns this project, when it belongs to one (vs. the parent group directly). */
  subgroupId?: string
  subgroupName?: string
}

// Job/points/completion for a project card come from `fetchProjectJobBoard`
// (ProjectJobBoardData) — aggregated server-side by projectId across every
// owning subtree agent, so subgroup-owned jobs are no longer dropped.

// ---------- Helpers for mapping server data to display shapes ----------

const DEFAULT_STATUS = "active"
const DEFAULT_CATEGORY = "General"
const DEFAULT_PRIORITY = "medium"

function mapAgentToProject(agent: SerializedAgent, groupId: string): ProjectDisplay {
  const meta = agent.metadata ?? {}
  return {
    id: agent.id,
    title: agent.name,
    description: agent.description ?? "",
    status: String(meta.status ?? DEFAULT_STATUS),
    category: String(meta.category ?? DEFAULT_CATEGORY),
    priority: String(meta.priority ?? DEFAULT_PRIORITY),
    deadline: meta.deadline ? String(meta.deadline) : null,
    groupId,
  }
}

function mapResourceToProject(resource: SerializedResource, groupId: string): ProjectDisplay {
  const meta = (resource.metadata ?? {}) as Record<string, unknown>
  return {
    id: resource.id,
    title: resource.name || String(meta.title ?? "Untitled Project"),
    description: resource.description ?? "",
    status: String(meta.status ?? DEFAULT_STATUS),
    category: String(meta.category ?? DEFAULT_CATEGORY),
    priority: String(meta.priority ?? DEFAULT_PRIORITY),
    deadline: meta.deadline ? String(meta.deadline) : null,
    groupId,
  }
}

// ---------- Component ----------

interface JobBoardTabProps {
  groupId: string
  currentUserId?: string
}

export function JobBoardTab({ groupId, currentUserId }: JobBoardTabProps) {
  const { toast } = useToast()

  // Data state
  const [projects, setProjects] = useState<ProjectDisplay[]>([])
  // Per-project jobs/points/completion aggregated by projectId across ALL
  // owning subtree agents (server-computed) — keyed by project id.
  const [boardByProject, setBoardByProject] = useState<Record<string, ProjectJobBoardData>>({})
  const [appliedJobIds, setAppliedJobIds] = useState<Set<string>>(new Set())

  // Loading / error state
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [loadingJobs, setLoadingJobs] = useState<Record<string, boolean>>({})
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null)

  // Filter state
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  // Subgroup (circle) filter: "all" shows this group's projects plus every
  // subgroup's; a specific id narrows to that subgroup's projects.
  const [subgroupFilter, setSubgroupFilter] = useState<string>("all")
  const [subgroups, setSubgroups] = useState<Array<{ id: string; name: string }>>([])
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})

  // ---------- Fetch projects & applied jobs on mount ----------

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      setIsLoadingProjects(true)
      try {
        const [children, appliedIds, groupDetail] = await Promise.all([
          fetchAgentChildren(groupId),
          fetchMyJobApplicationIds(),
          fetchGroupDetail(groupId),
        ])

        if (cancelled) return

        // Projects can be either child agents (type=project) or resources (type=project)
        const projectAgents = children.filter((a) => a.type === "project")
        const projectResources = (groupDetail?.resources ?? []).filter(
          (r) => r.type === "project" || (r.metadata as Record<string, unknown>)?.resourceKind === "project"
        )
        // Merge both sources, dedup by ID
        const seen = new Set<string>()
        const allProjects: ProjectDisplay[] = []
        for (const a of projectAgents) {
          if (!seen.has(a.id)) { seen.add(a.id); allProjects.push(mapAgentToProject(a, groupId)) }
        }
        for (const r of projectResources) {
          if (!seen.has(r.id)) { seen.add(r.id); allProjects.push(mapResourceToProject(r, groupId)) }
        }

        // Aggregate projects owned by this group's subgroups (circles), tagged
        // with their owning subgroup so the Jobs tab can filter by all/each.
        const subgroupAgents = children.filter((a) => a.type === "organization")
        setSubgroups(subgroupAgents.map((s) => ({ id: s.id, name: s.name })))
        const perSubgroup = await Promise.all(
          subgroupAgents.map(async (sg) => {
            const [sgChildren, sgResources] = await Promise.all([
              fetchAgentChildren(sg.id).catch(() => []),
              fetchResourcesByOwner(sg.id).catch(() => []),
            ])
            const list: ProjectDisplay[] = []
            for (const a of sgChildren.filter((x) => x.type === "project")) {
              list.push({ ...mapAgentToProject(a, sg.id), subgroupId: sg.id, subgroupName: sg.name })
            }
            for (const r of sgResources.filter(
              (x) => x.type === "project" || (x.metadata as Record<string, unknown>)?.resourceKind === "project",
            )) {
              list.push({ ...mapResourceToProject(r, sg.id), subgroupId: sg.id, subgroupName: sg.name })
            }
            return list
          }),
        )
        for (const list of perSubgroup) {
          for (const p of list) {
            if (!seen.has(p.id)) { seen.add(p.id); allProjects.push(p) }
          }
        }

        if (cancelled) return
        setProjects(allProjects)
        setAppliedJobIds(new Set(appliedIds))

        // Eager-load each project's jobs/points/completion by projectId
        // linkage (owner-agnostic) so cards show REAL data without expanding —
        // the previous group-owned-only scope showed 0 for subgroup projects.
        void Promise.all(
          allProjects.map(async (p) => {
            const board = await fetchProjectJobBoard(p.id).catch(() => null)
            if (board && !cancelled) {
              setBoardByProject((prev) => ({ ...prev, [p.id]: board }))
            }
          }),
        )
      } catch (err) {
        console.error("[JobBoardTab] failed to load projects:", err)
        if (!cancelled) {
          toast({
            title: "Failed to load projects",
            description: "An unexpected error occurred while loading project data.",
            variant: "destructive",
          })
        }
      } finally {
        if (!cancelled) setIsLoadingProjects(false)
      }
    }

    loadData()
    return () => { cancelled = true }
  }, [groupId, toast])

  // ---------- Fetch jobs when a project is expanded ----------

  const loadBoardForProject = useCallback(async (projectId: string) => {
    if (boardByProject[projectId]) return // already loaded (eagerly or before)

    setLoadingJobs((prev) => ({ ...prev, [projectId]: true }))
    try {
      // Jobs link to a project purely by `metadata.projectId`, and the job/task
      // rows can be owned by ANY subtree agent (the parent group, an owning
      // circle/subgroup, or the project owner). fetchProjectJobBoard aggregates
      // them by projectId regardless of owner (visibility-respecting) — the old
      // fetchResourcesByOwner(groupId) scan dropped every subgroup-owned job.
      const board = await fetchProjectJobBoard(projectId)
      setBoardByProject((prev) => ({ ...prev, [projectId]: board }))
    } catch (err) {
      console.error(`[JobBoardTab] failed to load jobs for project ${projectId}:`, err)
      toast({
        title: "Failed to load jobs",
        description: "Could not fetch job listings for this project.",
        variant: "destructive",
      })
    } finally {
      setLoadingJobs((prev) => ({ ...prev, [projectId]: false }))
    }
  }, [boardByProject, toast])

  // ---------- Toggle project expansion ----------

  const toggleProjectExpansion = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] }
      if (next[projectId]) {
        loadBoardForProject(projectId)
      }
      return next
    })
  }, [loadBoardForProject])

  // ---------- Apply to job ----------

  const handleApply = useCallback(async (e: React.MouseEvent, jobId: string) => {
    e.preventDefault()
    e.stopPropagation()

    setApplyingJobId(jobId)
    try {
      const result = await applyToJob(jobId)
      if (result.success) {
        setAppliedJobIds((prev) => new Set([...prev, jobId]))
        toast({
          title: "Application submitted",
          description: result.message,
        })
      } else {
        toast({
          title: "Could not apply",
          description: result.message,
          variant: "destructive",
        })
      }
    } catch (err) {
      console.error("[JobBoardTab] handleApply failed:", err)
      toast({
        title: "Application failed",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setApplyingJobId(null)
    }
  }, [toast])

  // ---------- Derived / filtered data ----------

  const filteredProjects = projects.filter((project) => {
    const matchesSearch =
      project.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      project.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStatus = statusFilter === "all" || project.status === statusFilter
    const matchesCategory = categoryFilter === "all" || project.category === categoryFilter
    const matchesSubgroup = subgroupFilter === "all" || project.subgroupId === subgroupFilter
    return matchesSearch && matchesStatus && matchesCategory && matchesSubgroup
  })

  const categories = [...new Set(projects.map((p) => p.category))]

  // ---------- UI helpers ----------

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "border-l-red-500"
      case "medium":
        return "border-l-yellow-500"
      case "low":
        return "border-l-green-500"
      default:
        return "border-l-gray-500"
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
      case "open":
        return "text-green-600 bg-green-100"
      case "planning":
      case "in-progress":
        return "text-blue-600 bg-blue-100"
      case "completed":
        return "text-gray-600 bg-gray-100"
      case "cancelled":
        return "text-red-600 bg-red-100"
      default:
        return "text-gray-600 bg-gray-100"
    }
  }

  // ---------- Render ----------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Projects & Jobs</h2>
          <p className="text-muted-foreground">Find projects and jobs to contribute and earn points</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/create?tab=job&group=${groupId}`} className="flex-1 sm:flex-none">
            <Button variant="outline" className="w-full sm:w-auto">
              <Briefcase className="h-4 w-4 mr-2" />
              New Job
            </Button>
          </Link>
          <Link href={`/create?tab=project&group=${groupId}`} className="flex-1 sm:flex-none">
            <Button className="w-full sm:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              placeholder="Search jobs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="planning">Planning</SelectItem>
            <SelectItem value="in-progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter by category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={category}>
                {category}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {subgroups.length > 0 && (
          <Select value={subgroupFilter} onValueChange={setSubgroupFilter}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <SelectValue placeholder="Filter by subgroup" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All subgroups</SelectItem>
              {subgroups.map((sg) => (
                <SelectItem key={sg.id} value={sg.id}>
                  {sg.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Loading state */}
      {isLoadingProjects && (
        <Card>
          <CardContent className="p-8 flex items-center justify-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            <p className="text-gray-500">Loading projects...</p>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!isLoadingProjects && projects.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-gray-500 mb-2">No projects found for this group.</p>
            <p className="text-gray-400 text-sm">Create a new project to get started.</p>
          </CardContent>
        </Card>
      )}

      {/* Project Cards */}
      {!isLoadingProjects && projects.length > 0 && (
        <div className="grid gap-4">
          {filteredProjects.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-gray-500">No projects found matching your criteria.</p>
              </CardContent>
            </Card>
          ) : (
            filteredProjects.map((project) => {
              const board = boardByProject[project.id]
              const projectJobs: ProjectJobBoardJob[] = board?.jobs ?? []
              const completion = board?.completion ?? 0
              const totalPoints = board?.totalPoints ?? 0
              const isExpanded = expandedProjects[project.id] || false
              const isLoadingProjectJobs = (loadingJobs[project.id] || false) && !board

              return (
                <Collapsible
                  key={project.id}
                  open={isExpanded}
                  onOpenChange={() => toggleProjectExpansion(project.id)}
                  className="w-full"
                >
                  <Card
                    glass
                    // `.liquid-glass` forces `background: var(--glass-surface-bg)`
                    // (transparent by default), which overrides Tailwind bg
                    // classes — over the decorative gold page gradient the cards
                    // washed out. Give the glass surface a real semi-opaque fill.
                    // LIGHT: --card is white, so 0.9 reads clearly over the gold.
                    // DARK: --card (≈13% L) is nearly the same as --background
                    // (≈10% L), so the fill alone doesn't separate — a
                    // mode-contrasting border (black/10 light, white/15 dark)
                    // defines each card edge. Verified in both modes.
                    style={{ ["--glass-surface-bg" as string]: "hsl(var(--card) / 0.9)" }}
                    className={`border border-black/10 dark:border-white/15 border-l-4 ${getPriorityColor(project.priority)} shadow-md hover:shadow-lg transition-shadow`}
                  >
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-pointer hover:bg-muted/50">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <Link href={`/projects/${project.id}`} className="hover:underline">
                                <CardTitle className="text-lg">{project.title}</CardTitle>
                              </Link>
                              <Badge className={getStatusColor(project.status)}>
                                {project.status.charAt(0).toUpperCase() + project.status.slice(1)}
                              </Badge>
                              {project.subgroupName && (
                                <Badge
                                  variant="outline"
                                  className="text-xs font-normal text-muted-foreground gap-1"
                                  title={`In subgroup ${project.subgroupName}`}
                                >
                                  <FolderTree className="h-3 w-3" />
                                  {project.subgroupName}
                                </Badge>
                              )}
                            </div>
                            <CardDescription className="mt-1 line-clamp-2">{project.description}</CardDescription>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            <div className="flex items-center">
                              {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                            </div>
                            <Badge variant="outline">{project.category}</Badge>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                          <div className="flex items-center gap-2">
                            <Star className="h-4 w-4 text-yellow-500" />
                            <span className="font-medium">{totalPoints} total points</span>
                          </div>
                          {project.deadline && (
                            <div className="flex items-center gap-2 text-sm text-gray-600">
                              <Calendar className="h-4 w-4" />
                              <span>Due: {new Date(project.deadline).toLocaleDateString()}</span>
                            </div>
                          )}
                          <div className="space-y-1">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Completion</span>
                              <span className="font-medium tabular-nums">{completion}%</span>
                            </div>
                            <Progress value={completion} className="h-1.5 bg-black/10 dark:bg-white/10" />
                          </div>
                        </div>
                        <div className="flex justify-end mt-2">
                          <Link href={`/projects/${project.id}`}>
                            <Button variant="outline" size="sm" className="text-xs">
                              View Project Details
                            </Button>
                          </Link>
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <CardContent>
                        <div className="mb-4">
                          <h3 className="text-md font-semibold mb-2">Jobs in this Project</h3>

                          {isLoadingProjectJobs && (
                            <div className="flex items-center gap-2 py-4">
                              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                              <p className="text-gray-500 text-sm">Loading jobs...</p>
                            </div>
                          )}

                          {!isLoadingProjectJobs && projectJobs.length === 0 && (
                            <p className="text-gray-500 text-sm">No jobs have been created for this project yet.</p>
                          )}

                          {!isLoadingProjectJobs && projectJobs.length > 0 && (
                            <div className="space-y-3">
                              {projectJobs.map((job) => {
                                const completedTasks = job.tasks.filter((task) => task.completed).length
                                const totalTasks = job.tasks.length
                                const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0
                                const isAssigned = currentUserId ? job.assignees.includes(currentUserId) : false
                                const hasApplied = appliedJobIds.has(job.id)
                                const canApply =
                                  job.status === "open" &&
                                  job.assignees.length < job.maxAssignees &&
                                  !isAssigned &&
                                  !hasApplied
                                const isApplying = applyingJobId === job.id
                                const pay = describeJobPay(job)

                                return (
                                  <Link key={job.id} href={`/jobs/${job.id}`}>
                                    <Card className="border hover:shadow-sm transition-shadow cursor-pointer">
                                      <CardHeader className="py-3">
                                        <div className="flex justify-between items-start gap-2">
                                          <div className="flex-1 min-w-0">
                                            <CardTitle className="text-md hover:underline">{job.title}</CardTitle>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
                                            <Badge variant="outline" className={`text-xs ${JOB_PAY_TONE_CLASS[pay.tone]}`}>
                                              {pay.label}
                                            </Badge>
                                            <Badge className={getStatusColor(job.status)}>
                                              {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                                            </Badge>
                                          </div>
                                        </div>
                                      </CardHeader>
                                      <CardContent className="py-2">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                          <div className="space-y-1">
                                            {job.location && (
                                              <div className="flex items-center gap-2 text-sm text-gray-600">
                                                <MapPin className="h-3 w-3" />
                                                <span>{job.location}</span>
                                              </div>
                                            )}
                                            <div className="flex items-center gap-2 text-sm text-gray-600">
                                              <Users className="h-3 w-3" />
                                              <span>
                                                {job.assignees.length}/{job.maxAssignees} assigned
                                              </span>
                                            </div>
                                            {job.requiredBadges.length > 0 && (
                                              <div className="flex items-center gap-2 text-sm text-gray-600">
                                                <Shield className="h-3 w-3" />
                                                <span>
                                                  Requires:{" "}
                                                  {job.requiredBadges.map((badge) => (
                                                    <Badge key={badge} variant="outline" className="text-xs mr-1">
                                                      {badge}
                                                    </Badge>
                                                  ))}
                                                </span>
                                              </div>
                                            )}
                                          </div>
                                          <div className="space-y-1">
                                            <div className="flex items-center gap-2 text-sm">
                                              <Star className="h-3 w-3 text-yellow-500" />
                                              <span className="font-medium">{job.totalPoints} points</span>
                                            </div>
                                            <div className="flex justify-between text-xs">
                                              <span>Tasks:</span>
                                              <span>
                                                {completedTasks}/{totalTasks} completed
                                              </span>
                                            </div>
                                            <Progress value={progress} className="h-1" />
                                          </div>
                                        </div>
                                      </CardContent>
                                      <CardFooter className="pt-0 pb-3">
                                        <div className="flex justify-end items-center gap-2 w-full">
                                          {!isAssigned && (
                                            <JobClaimButton jobId={job.id} status={job.status} />
                                          )}
                                          {canApply && (
                                            <TooltipProvider>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={(e) => handleApply(e, job.id)}
                                                    disabled={isApplying}
                                                  >
                                                    {isApplying ? (
                                                      <>
                                                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                                        Applying...
                                                      </>
                                                    ) : (
                                                      "Apply"
                                                    )}
                                                  </Button>
                                                </TooltipTrigger>
                                                {job.requiredBadges.length > 0 && (
                                                  <TooltipContent>
                                                    <p>Required badges: {job.requiredBadges.join(", ")}</p>
                                                  </TooltipContent>
                                                )}
                                              </Tooltip>
                                            </TooltipProvider>
                                          )}
                                          {hasApplied && (
                                            <Badge variant="secondary">Application Submitted</Badge>
                                          )}
                                          {isAssigned && (
                                            <Badge variant="default" className="bg-green-600">
                                              You&apos;re Assigned
                                            </Badge>
                                          )}
                                        </div>
                                      </CardFooter>
                                    </Card>
                                  </Link>
                                )
                              })}
                            </div>
                          )}
                        </div>
                        <div className="flex justify-end">
                          <Link href={`/create?tab=job&group=${groupId}&project=${project.id}`}>
                            <Button variant="outline" size="sm">
                              <Plus className="h-3 w-3 mr-1" /> Add Job
                            </Button>
                          </Link>
                        </div>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
