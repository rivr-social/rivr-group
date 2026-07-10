"use client"

/**
 * AddMemberCard — admin control to add a person to the group (2026-07-10).
 *
 * Fills the gap that made members invisible when they never self-joined:
 * membership previously ONLY came from self-join or request→approve. Admins
 * search local + projected (federated) people and add them directly as
 * member or admin; the action is idempotent and role-updates existing
 * memberships instead of duplicating.
 *
 * Render only for admins (`isGroupAdmin` is server-computed on the page);
 * the actions re-check authority server-side regardless.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { UserPlus } from "lucide-react"
import {
  searchAddableAgents,
  addGroupMemberAction,
  type AddableAgent,
  type AddableMemberRole,
} from "@/app/actions/group-members"
import { useToast } from "@/components/ui/use-toast"

/** Debounce for the picker search, ms. */
const SEARCH_DEBOUNCE_MS = 300

interface AddMemberCardProps {
  groupId: string
}

export function AddMemberCard({ groupId }: AddMemberCardProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<AddableAgent[]>([])
  const [role, setRole] = useState<AddableMemberRole>("member")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      searchAddableAgents(groupId, query)
        .then(setResults)
        .catch(() => setResults([]))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [groupId, query])

  const handleAdd = (agent: AddableAgent) => {
    startTransition(async () => {
      const result = await addGroupMemberAction(groupId, agent.id, role)
      if (result.success) {
        toast({ title: "Member added", description: result.message })
        setQuery("")
        setResults([])
        router.refresh()
      } else {
        toast({ title: "Failed to add member", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-md flex items-center gap-2">
          <UserPlus className="h-4 w-4" /> Add a member
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Search people by name or username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select value={role} onValueChange={(value) => setRole(value as AddableMemberRole)}>
            <SelectTrigger className="w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {results.length > 0 && (
          <ul className="divide-y rounded-md border">
            {results.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3 p-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={agent.image ?? undefined} alt={agent.name} />
                    <AvatarFallback>{agent.name.slice(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{agent.name}</p>
                    {agent.username && (
                      <p className="text-xs text-muted-foreground truncate">@{agent.username}</p>
                    )}
                  </div>
                </div>
                <Button size="sm" onClick={() => handleAdd(agent)} disabled={isPending}>
                  {isPending ? "Adding…" : `Add as ${role}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && results.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No addable people match — existing members are excluded.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
