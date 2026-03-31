/**
 * @fileoverview ProjectFeed - Displays a list of project cards.
 *
 * Used on the group detail page or projects listing. Shows project metadata
 * including location, team size, dates, and status badges.
 */
"use client"

import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Briefcase, MapPin, Users, Calendar } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import Link from "next/link"

interface ProjectFeedProps {
  projects: { id: string; name: string; description?: string; status?: string; location?: string; memberCount?: number; startDate?: string; createdAt?: string; tags?: string[]; chapterTags?: string[] }[]
}

const STATUS_STYLES: Record<string, string> = {
  planning: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  completed: "bg-blue-100 text-blue-800",
}

export function ProjectFeed({ projects }: ProjectFeedProps) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects found"
        description="Projects created via the Natural Language Input will appear here."
        icon={<Briefcase className="h-10 w-10" />}
      />
    )
  }

  return (
    <div className="space-y-4 mt-4">
      {projects.map((project) => (
        <Card key={project.id} className="border shadow-sm">
          <CardHeader className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100 text-blue-800">
                  <Briefcase className="h-5 w-5" />
                </div>
                <div>
                  <Link
                    href={`/projects/${project.id}`}
                    className="text-lg font-semibold hover:underline"
                  >
                    {project.name}
                  </Link>
                  <Badge
                    variant="outline"
                    className={`ml-2 text-xs ${STATUS_STYLES[project.status || "active"] || STATUS_STYLES.active}`}
                  >
                    {project.status || "active"}
                  </Badge>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {project.description && (
              <p className="text-muted-foreground mb-3">{project.description}</p>
            )}
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              {project.location && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {project.location}
                </span>
              )}
              {(project.memberCount ?? 0) > 0 && (
                <span className="flex items-center gap-1">
                  <Users className="h-4 w-4" />
                  {project.memberCount} members
                </span>
              )}
              {project.createdAt && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {new Date(project.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </CardContent>
          {project.tags && project.tags.length > 0 && (
            <CardFooter className="p-4 pt-0">
              <div className="flex flex-wrap gap-1">
                {project.tags.map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </CardFooter>
          )}
        </Card>
      ))}
    </div>
  )
}
