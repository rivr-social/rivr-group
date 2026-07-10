"use client"

/**
 * ProjectRolesCard — lead + QA assignment for a project (2026-07-10).
 *
 * The lead coordinates the project and is the DEFAULT QA; the QA attests
 * work-completion claims (tasks land in awaiting_approval until the QA, lead,
 * or a group admin verifies — that's when stake points move). QA may be a
 * person from the group's family tree (group/parent/sibling/child members) or
 * an affiliated GROUP agent, whose admins then hold the authority.
 *
 * Visibility/authority are SERVER-computed (`getProjectRolesData.canManage`)
 * and passed as data — the client user-context cannot see federated
 * remote-viewer sessions.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ShieldCheck, UserCog } from "lucide-react"
import { setProjectRolesAction, type ProjectRolesData } from "@/app/actions/project-roles"
import { useToast } from "@/components/ui/use-toast"

/** Select sentinel for "no one assigned" — Select values cannot be "". */
const NONE_VALUE = "none"

interface ProjectRolesCardProps {
  roles: ProjectRolesData
}

export function ProjectRolesCard({ roles }: ProjectRolesCardProps) {
  const [leadId, setLeadId] = useState<string>(roles.leadId ?? NONE_VALUE)
  const [qaId, setQaId] = useState<string>(roles.qaId ?? NONE_VALUE)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const nameOf = (id: string | null): string => {
    if (!id) return "Unassigned"
    const match = [...roles.people, ...roles.groups].find((o) => o.id === id)
    return match?.name ?? id.slice(0, 8)
  }

  const dirty = (leadId === NONE_VALUE ? null : leadId) !== roles.leadId ||
    (qaId === NONE_VALUE ? null : qaId) !== roles.qaId

  const handleSave = () => {
    startTransition(async () => {
      const result = await setProjectRolesAction(roles.projectId, {
        leadId: leadId === NONE_VALUE ? null : leadId,
        qaId: qaId === NONE_VALUE ? null : qaId,
      })
      if (result.success) {
        toast({ title: "Roles updated", description: result.message })
      } else {
        toast({ title: "Failed to update roles", description: result.message, variant: "destructive" })
      }
    })
  }

  if (!roles.canManage) {
    // Read-only summary for non-managers.
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-md flex items-center gap-2">
            <UserCog className="h-4 w-4" /> Project Roles
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Lead:</span>
            <Badge variant="outline">{nameOf(roles.leadId)}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">QA:</span>
            <Badge variant="outline">{nameOf(roles.effectiveQaId)}</Badge>
            {!roles.qaId && roles.leadId && (
              <span className="text-xs text-muted-foreground">(defaults to lead)</span>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-md flex items-center gap-2">
          <UserCog className="h-4 w-4" /> Project Roles
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Lead</label>
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a lead" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Unassigned</SelectItem>
                <SelectGroup>
                  <SelectLabel>Members</SelectLabel>
                  {roles.people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Coordinates the project; default attester of finished work.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" /> QA
            </label>
            <Select value={qaId} onValueChange={setQaId}>
              <SelectTrigger>
                <SelectValue placeholder="Defaults to lead" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Default to lead</SelectItem>
                {roles.people.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>People (group + family)</SelectLabel>
                    {roles.people.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {roles.groups.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Groups (their admins attest)</SelectLabel>
                    {roles.groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Attests completed work; points land at attestation.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={handleSave} disabled={!dirty || isPending}>
          {isPending ? "Saving…" : "Save roles"}
        </Button>
      </CardContent>
    </Card>
  )
}
