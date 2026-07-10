"use client"

/**
 * GroupInviteBanner — the invitee's accept/decline surface (2026-07-10).
 *
 * Rendered at the top of a group page when the VIEWER holds a pending
 * membership invitation (server-fetched via getMyPendingGroupInvite —
 * consent model: membership starts only here, never at the admin's send).
 */

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { MailOpen } from "lucide-react"
import { respondToGroupInviteAction, type MyGroupInvite } from "@/app/actions/group-members"
import { useToast } from "@/components/ui/use-toast"

interface GroupInviteBannerProps {
  invite: MyGroupInvite
}

export function GroupInviteBanner({ invite }: GroupInviteBannerProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const respond = (accept: boolean) => {
    startTransition(async () => {
      const result = await respondToGroupInviteAction(invite.id, accept)
      if (result.success) {
        toast({ title: accept ? "Invitation accepted" : "Invitation declined", description: result.message })
        router.refresh()
      } else {
        toast({ title: "Failed to respond", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <MailOpen className="h-5 w-5 text-primary" />
          <p className="text-sm">
            <span className="font-medium">{invite.inviterName}</span> invited you to join this group
            {invite.role === "admin" ? " as an admin" : ""}. Membership starts only if you accept.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => respond(true)} disabled={isPending}>
            {isPending ? "…" : "Accept"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => respond(false)} disabled={isPending}>
            Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
