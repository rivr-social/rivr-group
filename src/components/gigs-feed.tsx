"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Award, Briefcase, Clock, MapPin, Star, Users, Search } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { useHomeFeed } from "@/lib/hooks/use-graph-data"
import { fetchAllResources } from "@/app/actions/graph"
import type { SerializedResource } from "@/lib/graph-serializers"
import { applyToJob, fetchMyJobApplicationIds } from "@/app/actions/interactions"

/**
 * Gigs feed with sub-tabs for Roles (earnable badges from public orgs) and
 * Jobs (available shifts from public orgs on projects).
 */
interface GigsFeedProps {
  currentUserId?: string
  selectedLocale?: string
}

type GigSubTab = "roles" | "jobs"

// ─── Shared Helpers ──────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)
const asNumber = (value: unknown, fallback = 0): number => (typeof value === "number" ? value : fallback)
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** Returns true when a URL looks like a valid, fetchable image path (HTTP, API, or static asset with extension). */
const isValidImageUrl = (url: string): boolean => {
  if (url.startsWith("http://") || url.startsWith("https://")) return true
  if (url.startsWith("/api/")) return true
  // Static asset paths must have a recognizable image extension
  const ext = url.split(".").pop()?.toLowerCase()
  return !!ext && ["jpg", "jpeg", "png", "gif", "svg", "webp", "avif", "ico"].includes(ext)
}

const statusClass = (status: string) => {
  switch (status) {
    case "open":
      return "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/40"
    case "in-progress":
      return "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40"
    case "completed":
      return "text-muted-foreground bg-muted"
    default:
      return "text-muted-foreground bg-muted"
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type GigItem = {
  id: string
  title: string
  description: string
  status: string
  groupId: string
  groupName: string
  location: string
  duration: string
  totalPoints: number
  requiredBadges: string[]
  maxAssignees: number
  assigneeCount: number
  projectTitle: string
  completedTasks: number
  totalTasks: number
}

type RoleItem = {
  id: string
  name: string
  description: string
  groupId: string
  groupName: string
  criteria: string
  points: number
  image?: string
  tags: string[]
}

const resolveResourceGroupName = (
  resource: SerializedResource,
  groupsById: Map<string, { name?: string }>,
  explicitGroupId?: string
): string => {
  const meta = asRecord(resource.metadata)
  const owner = (resource as SerializedResource & { owner?: { id: string; name: string } | null }).owner
  const groupId = explicitGroupId || asString(meta.groupId || meta.groupDbId || meta.ownerGroupId) || resource.ownerId

  return (
    groupsById.get(groupId)?.name ||
    asString(meta.groupName) ||
    owner?.name ||
    "Community"
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GigsFeed({ currentUserId = "", selectedLocale = "all" }: GigsFeedProps) {
  const { toast } = useToast()
  const { data: homeData } = useHomeFeed(500, selectedLocale)

  const [subTab, setSubTab] = useState<GigSubTab>("roles")

  // Jobs state
  const [jobs, setJobs] = useState<SerializedResource[]>([])
  const [tasks, setTasks] = useState<SerializedResource[]>([])
  const [appliedJobIds, setAppliedJobIds] = useState<string[]>([])
  const [jobSearch, setJobSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("open")
  const [jobGroupFilter, setJobGroupFilter] = useState<string>("all")
  const [submittingJobId, setSubmittingJobId] = useState<string | null>(null)

  // Roles state
  const [badges, setBadges] = useState<SerializedResource[]>([])
  const [roleSearch, setRoleSearch] = useState("")
  const [roleGroupFilter, setRoleGroupFilter] = useState<string>("all")

  // Loading state
  const [isLoading, setIsLoading] = useState(true)

  // Fetch jobs, tasks, badges, and application IDs
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    Promise.all([
      fetchAllResources({ type: "job", limit: 600 }).catch(() => []),
      fetchAllResources({ type: "task", limit: 1200 }).catch(() => []),
      fetchAllResources({ type: "badge", limit: 600 }).catch(() => []),
      fetchMyJobApplicationIds().catch(() => []),
    ]).then(([jobResources, taskResources, badgeResources, applications]) => {
      if (cancelled) return
      setJobs(jobResources)
      setTasks(taskResources)
      setBadges(badgeResources)
      setAppliedJobIds(applications)
      setIsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Lookup maps — combine home feed groups with owner data from fetched resources
  // so jobs/badges whose owning group is outside the home feed still resolve a name.
  const groupsById = useMemo(() => {
    const map = new Map(homeData.groups.map((g) => [g.id, g]))
    // Supplement from resource owner agents (attached by fetchAllResources)
    for (const resource of [...jobs, ...badges]) {
      const owner = (resource as SerializedResource & { owner?: { id: string; name: string } | null }).owner
      if (owner && !map.has(owner.id)) {
        map.set(owner.id, { id: owner.id, name: owner.name } as typeof homeData.groups[number])
      }
    }
    return map
  }, [homeData.groups, jobs, badges])
  const projectsById = useMemo(() => new Map(homeData.projects.map((p) => [p.id, p])), [homeData.projects])
  const badgeNamesById = useMemo(() => new Map(badges.map((b) => [b.id, b.name])), [badges])

  // ─── Roles (Badges) ─────────────────────────────────────────────────────

  const roleItems = useMemo<RoleItem[]>(() => {
    return badges
      .map((badge) => {
        const meta = asRecord(badge.metadata)
        const groupId = asString(meta.groupId || meta.groupDbId || meta.ownerGroupId) || badge.ownerId
        const group = groupsById.get(groupId)

        return {
          id: badge.id,
          name: badge.name,
          description: (badge.description || "").replace(/^"|"$/g, ''),
          groupId,
          groupName: group?.name || resolveResourceGroupName(badge, groupsById, groupId),
          criteria: asString(meta.criteria || meta.requirements, "").replace(/^"|"$/g, ''),
          points: asNumber(meta.points || meta.totalPoints, 0),
          image: asString(meta.image || meta.icon, "") || undefined,
          tags: badge.tags ?? [],
        }
      })
      .filter((item) => {
        if (selectedLocale === "all") return true
        const group = groupsById.get(item.groupId)
        const tags = new Set([...(group?.chapterTags ?? []), ...(group?.tags ?? [])])
        return tags.has(selectedLocale)
      })
  }, [badges, groupsById, selectedLocale])

  const availableRoleGroups = useMemo(
    () =>
      Array.from(new Set(roleItems.map((r) => r.groupId).filter(Boolean))).map((groupId) => ({
        id: groupId,
        name: groupsById.get(groupId)?.name || "Unknown Group",
      })),
    [roleItems, groupsById]
  )

  const filteredRoles = useMemo(
    () =>
      roleItems.filter((role) => {
        const query = roleSearch.trim().toLowerCase()
        const matchesSearch =
          !query ||
          role.name.toLowerCase().includes(query) ||
          role.description.toLowerCase().includes(query) ||
          role.groupName.toLowerCase().includes(query)
        const matchesGroup = roleGroupFilter === "all" || role.groupId === roleGroupFilter
        return matchesSearch && matchesGroup
      }),
    [roleItems, roleSearch, roleGroupFilter]
  )

  // ─── Jobs ────────────────────────────────────────────────────────────────

  // Pre-index tasks by job ID to avoid O(n*m) filtering inside gigItems
  const tasksByJobId = useMemo(() => {
    const map = new Map<string, typeof tasks>()
    for (const task of tasks) {
      const tmeta = asRecord(task.metadata)
      const jobId = asString(tmeta.jobId || tmeta.jobDbId)
      if (jobId) {
        const existing = map.get(jobId) ?? []
        existing.push(task)
        map.set(jobId, existing)
      }
    }
    return map
  }, [tasks])

  const gigItems = useMemo<GigItem[]>(() => {
    return jobs
      .map((job) => {
        const meta = asRecord(job.metadata)
        const groupId = asString(meta.groupId || meta.groupDbId || meta.ownerGroupId) || job.ownerId
        const projectId = asString(meta.projectId || meta.projectDbId)
        const assignedTo = asStringArray(meta.assignees)
        const maxAssignees = asNumber(meta.maxAssignees, 1)
        const linkedTasks = tasksByJobId.get(job.id) ?? []
        const completedTasks = linkedTasks.filter((task) => {
          const tmeta = asRecord(task.metadata)
          return Boolean(tmeta.completed) || asString(tmeta.status) === "completed"
        }).length

        return {
          id: job.id,
          title: job.name,
          description: job.description || "",
          status: asString(meta.status, "open"),
          groupId,
          groupName: resolveResourceGroupName(job, groupsById, groupId),
          location: asString(meta.location, "Location not specified"),
          duration: asString(meta.duration, ""),
          totalPoints: asNumber(meta.totalPoints, asNumber(meta.points, 0)),
          requiredBadges: asStringArray(meta.requiredBadges),
          maxAssignees,
          assigneeCount: assignedTo.length,
          projectTitle: asString(meta.projectTitle, projectsById.get(projectId)?.name || ""),
          completedTasks,
          totalTasks: linkedTasks.length,
        }
      })
      .filter((item) => {
        if (selectedLocale === "all") return true
        const group = groupsById.get(item.groupId)
        const tags = new Set([...(group?.chapterTags ?? []), ...(group?.tags ?? [])])
        return tags.has(selectedLocale)
      })
  }, [jobs, tasksByJobId, projectsById, groupsById, selectedLocale])

  const availableJobGroups = useMemo(
    () =>
      Array.from(new Set(gigItems.map((item) => item.groupId).filter(Boolean))).map((groupId) => ({
        id: groupId,
        name: gigItems.find((item) => item.groupId === groupId)?.groupName || groupsById.get(groupId)?.name || "Community",
      })),
    [gigItems, groupsById]
  )

  const filteredJobs = useMemo(
    () =>
      gigItems.filter((job) => {
        const query = jobSearch.trim().toLowerCase()
        const matchesSearch =
          !query ||
          job.title.toLowerCase().includes(query) ||
          job.description.toLowerCase().includes(query) ||
          job.projectTitle.toLowerCase().includes(query)
        const matchesStatus = statusFilter === "all" || job.status === statusFilter
        const matchesGroup = jobGroupFilter === "all" || job.groupId === jobGroupFilter
        return matchesSearch && matchesStatus && matchesGroup
      }),
    [gigItems, jobSearch, statusFilter, jobGroupFilter]
  )

  const handleApply = async (jobId: string) => {
    if (!currentUserId) {
      toast({
        title: "Sign in required",
        description: "You must be signed in to apply for jobs.",
        variant: "destructive",
      })
      return
    }

    setSubmittingJobId(jobId)
    const result = await applyToJob(jobId)
    setSubmittingJobId(null)
    if (!result.success) {
      toast({ title: "Application failed", description: result.message, variant: "destructive" })
      return
    }

    if (result.active) {
      setAppliedJobIds((prev) => Array.from(new Set([...prev, jobId])))
    } else {
      setAppliedJobIds((prev) => prev.filter((id) => id !== jobId))
    }

    toast({
      title: result.active ? "Applied" : "Application withdrawn",
      description: result.message,
    })
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Sub-tab toggle */}
      <div className="flex gap-2">
        <Button
          variant={subTab === "roles" ? "default" : "outline"}
          size="sm"
          onClick={() => setSubTab("roles")}
          className="flex items-center gap-1.5"
        >
          <Award className="h-4 w-4" />
          Roles
        </Button>
        <Button
          variant={subTab === "jobs" ? "default" : "outline"}
          size="sm"
          onClick={() => setSubTab("jobs")}
          className="flex items-center gap-1.5"
        >
          <Briefcase className="h-4 w-4" />
          Jobs
        </Button>
      </div>

      {/* ── Roles View ─────────────────────────────────────────────────────── */}
      {subTab === "roles" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold">Available Roles</h2>
            <p className="text-muted-foreground text-sm">Badges you can earn from community organizations.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search roles..."
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={roleGroupFilter} onValueChange={setRoleGroupFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Filter by org" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Organizations</SelectItem>
                {availableRoleGroups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={`role-skeleton-${i}`} className="animate-pulse">
                  <CardHeader className="pb-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 h-12 w-12 rounded-lg bg-muted" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-2/3 bg-muted rounded" />
                        <div className="h-5 w-20 bg-muted rounded" />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    <div className="h-3 w-full bg-muted rounded" />
                    <div className="h-3 w-4/5 bg-muted rounded" />
                  </CardContent>
                </Card>
              ))
            ) : null}
          </div>

          {!isLoading && <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            {filteredRoles.length === 0 ? (
              <Card className="col-span-full">
                <CardContent className="p-8 text-center">
                  <Award className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                  <p className="text-muted-foreground">No roles available right now.</p>
                </CardContent>
              </Card>
            ) : (
              filteredRoles.map((role) => (
                <Card key={role.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start gap-3">
                      {role.image && isValidImageUrl(role.image) ? (
                        <div className="shrink-0 h-12 w-12 rounded-lg bg-muted overflow-hidden relative">
                          <Image src={role.image} alt={role.name} fill className="object-cover" sizes="48px" />
                        </div>
                      ) : (
                        <div className="shrink-0 h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Award className="h-6 w-6 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base line-clamp-1">{role.name}</CardTitle>
                        <Badge variant="outline" className="text-xs mt-1">
                          {role.groupName}
                        </Badge>
                      </div>
                      {role.points > 0 && (
                        <div className="flex items-center gap-1 text-sm shrink-0">
                          <Star className="h-4 w-4 text-yellow-500" />
                          <span className="font-medium">{role.points}</span>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {role.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">{role.description}</p>
                    )}
                    {role.criteria && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium">How to earn:</span> {role.criteria}
                      </div>
                    )}
                    {role.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {role.tags.slice(0, 5).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>}
        </div>
      )}

      {/* ── Jobs View ──────────────────────────────────────────────────────── */}
      {subTab === "jobs" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold">Available Jobs</h2>
            <p className="text-muted-foreground text-sm">Shifts and positions from community projects.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search jobs..."
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in-progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={jobGroupFilter} onValueChange={setJobGroupFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Filter by group" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Groups</SelectItem>
                {availableJobGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="grid gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={`job-skeleton-${i}`} className="animate-pulse">
                  <CardHeader>
                    <div className="flex justify-between items-start">
                      <div className="flex-1 space-y-2">
                        <div className="h-5 w-1/2 bg-muted rounded" />
                        <div className="flex gap-2">
                          <div className="h-5 w-24 bg-muted rounded" />
                          <div className="h-5 w-20 bg-muted rounded" />
                        </div>
                      </div>
                      <div className="h-6 w-16 bg-muted rounded" />
                    </div>
                    <div className="h-3 w-full bg-muted rounded mt-2" />
                    <div className="h-3 w-3/4 bg-muted rounded mt-1" />
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="h-3 w-3/4 bg-muted rounded" />
                        <div className="h-3 w-1/2 bg-muted rounded" />
                      </div>
                      <div className="space-y-2">
                        <div className="h-3 w-1/3 bg-muted rounded" />
                        <div className="h-2 w-full bg-muted rounded-full" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
          <div className="grid gap-4">
            {filteredJobs.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <Briefcase className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                  <p className="text-muted-foreground">No jobs matched this filter.</p>
                </CardContent>
              </Card>
            ) : (
              filteredJobs.map((job) => {
                const hasApplied = appliedJobIds.includes(job.id)
                const canApply = job.status === "open"
                const progress = job.totalTasks > 0 ? (job.completedTasks / job.totalTasks) * 100 : 0
                const groupName = job.groupName

                return (
                  <Link key={job.id} href={`/jobs/${job.id}`}>
                    <Card className="border hover:shadow-md transition-shadow cursor-pointer">
                      <CardHeader>
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <CardTitle className="text-lg">{job.title}</CardTitle>
                            <div className="flex items-center gap-2 mt-2">
                              <Badge variant="outline" className="text-xs">{groupName}</Badge>
                              {job.projectTitle ? (
                                <Badge variant="secondary" className="text-xs">{job.projectTitle}</Badge>
                              ) : null}
                            </div>
                          </div>
                          <Badge className={statusClass(job.status)}>
                            {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                          </Badge>
                        </div>
                        {job.description ? (
                          <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{job.description}</p>
                        ) : null}
                      </CardHeader>

                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <MapPin className="h-4 w-4" />
                              <span>{job.location}</span>
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Users className="h-4 w-4" />
                              <span>{job.assigneeCount}/{job.maxAssignees} assigned</span>
                            </div>
                            {job.duration ? (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Clock className="h-4 w-4" />
                                <span>{job.duration}</span>
                              </div>
                            ) : null}
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-2 text-sm">
                              <Star className="h-4 w-4 text-yellow-500" />
                              <span className="font-medium">{job.totalPoints} points</span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span>Tasks:</span>
                              <span>{job.completedTasks}/{job.totalTasks} completed</span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${Math.min(100, progress)}%` }} />
                            </div>
                          </div>
                        </div>

                        {job.requiredBadges.length > 0 ? (
                          <div className="mt-4 pt-4 border-t">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                              <span className="font-medium">Required badges:</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {job.requiredBadges.map((badgeId) => (
                                <Badge key={badgeId} variant="outline" className="text-xs">{badgeNamesById.get(badgeId) || badgeId}</Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </CardContent>

                      <CardFooter className="pt-0">
                        <div className="flex justify-end w-full">
                          {hasApplied ? (
                            <Badge variant="secondary">Application Submitted</Badge>
                          ) : canApply ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={submittingJobId === job.id}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void handleApply(job.id)
                              }}
                            >
                              {submittingJobId === job.id ? "Submitting..." : "Apply"}
                            </Button>
                          ) : null}
                        </div>
                      </CardFooter>
                    </Card>
                  </Link>
                )
              })
            )}
          </div>
          )}
        </div>
      )}
    </div>
  )
}
