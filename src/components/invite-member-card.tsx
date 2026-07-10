"use client"

/**
 * InviteMemberCard — admin control to INVITE a person to the group
 * (2026-07-10, consent model: membership starts only when they accept).
 *
 * Admins search local + projected (federated) people and send an invitation
 * carrying a member or admin role; pending invitations list below with
 * cancel. The invitee sees the invite in their notifications and as a banner
 * on the group page, where they accept or decline.
 *
 * Render only for admins (`isGroupAdmin` is server-computed on the page);
 * every action re-checks authority server-side regardless.
 */

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MailPlus, X } from "lucide-react"
import {
  searchAddableAgents,
  inviteGroupMemberAction,
  cancelGroupInviteAction,
  type AddableAgent,
  type GroupInvite,
  type InvitableMemberRole,
} from "@/app/actions/group-members"
import { useToast } from "@/components/ui/use-toast"

/** Debounce for the picker search, ms. */
const SEARCH_DEBOUNCE_MS = 300

interface InviteMemberCardProps {
  groupId: string
  /** Server-fetched pending invitations (admins only). */
  pendingInvites: GroupInvite[]
}

export function InviteMemberCard({ groupId, pendingInvites }: InviteMemberCardProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<AddableAgent[]>([])
  const [role, setRole] = useState<InvitableMemberRole>("member")
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

  const handleInvite = (agent: AddableAgent) => {
    startTransition(async () => {
      const result = await inviteGroupMemberAction(groupId, agent.id, role)
      if (result.success) {
        toast({ title: "Invitation sent", description: result.message })
        setQuery("")
        setResults([])
        router.refresh()
      } else {
        toast({ title: "Failed to invite", description: result.message, variant: "destructive" })
      }
    })
  }

  const handleCancel = (inviteId: string) => {
    startTransition(async () => {
      const result = await cancelGroupInviteAction(inviteId)
      if (result.success) {
        toast({ title: "Invitation cancelled" })
        router.refresh()
      } else {
        toast({ title: "Failed to cancel", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-md flex items-center gap-2">
          <MailPlus className="h-4 w-4" /> Invite a member
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Search people by name or username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select value={role} onValueChange={(value) => setRole(value as InvitableMemberRole)}>
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
                <Button size="sm" onClick={() => handleInvite(agent)} disabled={isPending}>
                  {isPending ? "Inviting…" : `Invite as ${role}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && results.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No invitable people match — existing members are excluded.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Membership starts only when the person accepts the invitation.
        </p>

        {pendingInvites.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Pending invitations</p>
            <ul className="divide-y rounded-md border">
              {pendingInvites.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between gap-3 p-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm truncate">{invite.inviteeName}</p>
                    <Badge variant="outline" className="text-xs">{invite.role}</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCancel(invite.id)}
                    disabled={isPending}
                    title="Cancel invitation"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
