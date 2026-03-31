/**
 * @fileoverview PeopleFeed - Displays a searchable/filterable grid of user profiles.
 *
 * Used on the people/directory page and group member lists. Shows compact user
 * cards in a responsive grid with avatars, names, bios, and action buttons.
 */
"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Gift, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ThankModule } from "@/components/thank-module"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import type { User } from "@/lib/types"
import { toggleFollowAgent } from "@/app/actions/interactions/social"

interface PeopleFeedProps {
  people?: User[]
  query?: string
  chapterId?: string
  onConnect?: (personId: string) => void
  initialConnections?: string[]
  maxPeople?: number
}

export function PeopleFeed({
  people = [],
  query,
  chapterId: _chapterId,
  onConnect,
  initialConnections = [],
  maxPeople,
}: PeopleFeedProps) {
  const [connections, setConnections] = useState<string[]>(initialConnections)
  const [pendingConnects, setPendingConnects] = useState<Set<string>>(new Set())
  const { data: session } = useSession()
  const { toast } = useToast()

  // Apply maxPeople limit if provided
  const displayPeople = maxPeople ? people.slice(0, maxPeople) : people

  const handleConnect = async (personId: string) => {
    if (pendingConnects.has(personId)) return
    setPendingConnects((prev) => new Set(prev).add(personId))

    try {
      const result = await toggleFollowAgent(personId)
      if (!result.success) {
        toast({ title: "Could not connect", description: result.message, variant: "destructive" })
        return
      }

      const newConnections = connections.includes(personId)
        ? connections.filter((id) => id !== personId)
        : [...connections, personId]

      setConnections(newConnections)

      if (onConnect) {
        onConnect(personId)
      }
    } finally {
      setPendingConnects((prev) => {
        const next = new Set(prev)
        next.delete(personId)
        return next
      })
    }
  }

  return (
    <div className="mt-4">
      {displayPeople.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {displayPeople.map((person) => {
            const isConnected = connections.includes(person.id)
            const profileHref = person.profileHref || `/profile/${person.id}`
            const canGiveToPerson = session?.user?.id !== person.id

            return (
              <Card key={person.id} className="border shadow-sm overflow-hidden">
                <Link href={profileHref} className="block focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-t-lg">
                  <CardContent className="p-3 flex flex-col items-center text-center">
                    <Avatar className="h-16 w-16 border-2 border-border mb-2">
                      <AvatarImage src={person.avatar || "/placeholder.svg"} alt={person.name} />
                      <AvatarFallback>{person.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <p className="font-semibold text-sm truncate w-full">{person.name}</p>
                    <p className="text-xs text-muted-foreground truncate w-full">@{person.username}</p>
                    {person.bio ? (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2 w-full">{person.bio}</p>
                    ) : null}
                  </CardContent>
                </Link>
                <div className="px-3 pb-3 flex justify-center gap-1.5">
                  <Link href={`/messages?user=${person.id}`}>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                      <MessageSquare className="h-3 w-3 mr-1" />
                      Message
                    </Button>
                  </Link>
                  {canGiveToPerson ? (
                    <ThankModule
                      recipientId={person.id}
                      recipientName={person.name}
                      recipientAvatar={person.avatar}
                      triggerButton={
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" type="button">
                          <Gift className="h-3 w-3 mr-1" />
                          Give
                        </Button>
                      }
                    />
                  ) : null}
                  <Button
                    variant={isConnected ? "secondary" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={pendingConnects.has(person.id)}
                    onClick={() => void handleConnect(person.id)}
                  >
                    {pendingConnects.has(person.id) ? "..." : isConnected ? "Connected" : "Connect"}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          {query ? `No people found matching "${query}"` : "No people found"}
        </div>
      )}
    </div>
  )
}
