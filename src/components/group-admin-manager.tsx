"use client"

/**
 * GroupAdminManager manages admin-role assignments for a group.
 *
 * Two search modes:
 * - Local: filter current members by name/username.
 * - Federation: search across all Rivr instances via the global user-search
 *   endpoint. Selected remote users are mirrored into this peer's local
 *   `agents` table (see `/api/agents/mirror`) so they can be stored in
 *   `metadata.adminIds` without waiting for a first federated login.
 *
 * Changes persist via `setGroupAdmins` server action.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Shield, ShieldAlert, UserPlus, X, Search, Check, Globe, Loader2 } from "lucide-react"
import type { MemberInfo } from "@/types/domain"
import { setGroupAdmins } from "@/app/actions/group-admin"
import { getGlobalBaseUrl } from "@/lib/federation/global-url"

interface GroupAdminManagerProps {
  groupId: string
  members: string[]
  admins: string[]
  creator: string
  onAdminChange?: (admins: string[]) => void
  allUsers?: MemberInfo[]
}

/** Shape returned by the global /api/federation/users/search endpoint. */
interface FederationSearchResult {
  id: string
  name: string | null
  email: string | null
  homeBaseUrl: string | null
  avatarUrl: string | null
}

const GLOBAL_SEARCH_DEBOUNCE_MS = 250
const GLOBAL_SEARCH_MIN_CHARS = 2

export function GroupAdminManager({
  groupId,
  members = [],
  admins = [],
  creator,
  onAdminChange,
  allUsers = [],
}: GroupAdminManagerProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [localAdmins, setLocalAdmins] = useState<string[]>(admins)
  const [persistBusy, setPersistBusy] = useState(false)

  // Federation search state.
  const [globalQuery, setGlobalQuery] = useState("")
  const [globalResults, setGlobalResults] = useState<FederationSearchResult[]>([])
  const [globalSearching, setGlobalSearching] = useState(false)
  const [mirroringId, setMirroringId] = useState<string | null>(null)
  const { toast } = useToast()

  const globalSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalSearchAbort = useRef<AbortController | null>(null)

  // Track federated users we've mirrored so we can render them as candidates
  // even though they aren't in the original `allUsers` prop.
  const [mirroredRemoteUsers, setMirroredRemoteUsers] = useState<MemberInfo[]>([])

  // Keep local admin state synchronized with server-side reload.
  useEffect(() => {
    setLocalAdmins(admins)
  }, [admins])

  const combinedUsers = useMemo<MemberInfo[]>(() => {
    const seen = new Set<string>()
    const out: MemberInfo[] = []
    for (const u of [...allUsers, ...mirroredRemoteUsers]) {
      if (seen.has(u.id)) continue
      seen.add(u.id)
      out.push(u)
    }
    return out
  }, [allUsers, mirroredRemoteUsers])

  const memberUsers = combinedUsers.filter(
    (user) => members?.includes(user.id) && !localAdmins.includes(user.id),
  )
  const adminUsers = combinedUsers.filter((user) => localAdmins?.includes(user.id))
  const creatorUser = combinedUsers.find((user) => user.id === creator)

  const filteredMembers = memberUsers.filter(
    (user) =>
      searchQuery === "" ||
      user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.username.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const handleToggleSelect = (userId: string) => {
    setSelectedMembers((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]))
  }

  const persistAdminList = async (next: string[]) => {
    setPersistBusy(true)
    try {
      const result = await setGroupAdmins(groupId, next)
      if (!result.success) {
        toast({
          title: "Could not update admin list",
          description: result.error ?? "Unknown error",
          variant: "destructive",
        })
        return false
      }
      setLocalAdmins(next)
      onAdminChange?.(next)
      return true
    } catch (error) {
      toast({
        title: "Could not update admin list",
        description: error instanceof Error ? error.message : "Unexpected error",
        variant: "destructive",
      })
      return false
    } finally {
      setPersistBusy(false)
    }
  }

  const handleMakeAdmins = async () => {
    if (selectedMembers.length === 0) return
    const next = Array.from(new Set([...localAdmins, ...selectedMembers]))
    const ok = await persistAdminList(next)
    if (ok) setSelectedMembers([])
  }

  const handleRemoveAdmin = async (adminId: string) => {
    if (adminId === creator) {
      toast({
        title: "Cannot remove creator",
        description: "The group creator always retains admin status.",
        variant: "destructive",
      })
      return
    }
    const next = localAdmins.filter((id) => id !== adminId)
    await persistAdminList(next)
  }

  // --- Federation search ---

  useEffect(() => {
    // Cancel the prior debounce on every keystroke.
    if (globalSearchTimer.current) {
      clearTimeout(globalSearchTimer.current)
      globalSearchTimer.current = null
    }
    if (globalSearchAbort.current) {
      globalSearchAbort.current.abort()
      globalSearchAbort.current = null
    }

    const q = globalQuery.trim()
    if (q.length < GLOBAL_SEARCH_MIN_CHARS) {
      setGlobalResults([])
      setGlobalSearching(false)
      return
    }

    setGlobalSearching(true)
    globalSearchTimer.current = setTimeout(async () => {
      const globalBase = getGlobalBaseUrl()
      if (!globalBase) {
        setGlobalSearching(false)
        return
      }
      const controller = new AbortController()
      globalSearchAbort.current = controller
      try {
        const url = `${globalBase.replace(/\/$/, "")}/api/federation/users/search?q=${encodeURIComponent(q)}&limit=25`
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          signal: controller.signal,
        })
        if (!resp.ok) {
          setGlobalResults([])
          return
        }
        const body = (await resp.json()) as { results?: FederationSearchResult[] }
        setGlobalResults(Array.isArray(body.results) ? body.results : [])
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("[GroupAdminManager] federation search failed:", error)
          setGlobalResults([])
        }
      } finally {
        if (globalSearchAbort.current === controller) {
          globalSearchAbort.current = null
        }
        setGlobalSearching(false)
      }
    }, GLOBAL_SEARCH_DEBOUNCE_MS)

    return () => {
      if (globalSearchTimer.current) clearTimeout(globalSearchTimer.current)
    }
  }, [globalQuery])

  const handleMirrorAndPromote = async (remote: FederationSearchResult) => {
    setMirroringId(remote.id)
    try {
      const mirrorResp = await fetch("/api/agents/mirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id: remote.id,
          name: remote.name,
          email: remote.email,
          homeBaseUrl: remote.homeBaseUrl,
          avatarUrl: remote.avatarUrl,
        }),
      })
      if (!mirrorResp.ok) {
        toast({
          title: "Could not add user",
          description: `Mirror failed (${mirrorResp.status})`,
          variant: "destructive",
        })
        return
      }
      // Add the mirrored user to the client-side candidate list so the
      // admin roster view can render them immediately.
      setMirroredRemoteUsers((prev) => {
        if (prev.some((u) => u.id === remote.id)) return prev
        const displayName = remote.name ?? remote.email ?? "Federated user"
        return [
          ...prev,
          {
            id: remote.id,
            name: displayName,
            username: remote.email ?? remote.id,
            avatar: remote.avatarUrl ?? undefined,
          } as MemberInfo,
        ]
      })
      // Promote immediately; this is the common intent when picking someone
      // from the federation search.
      const next = Array.from(new Set([...localAdmins, remote.id]))
      await persistAdminList(next)
    } finally {
      setMirroringId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <ShieldAlert className="h-5 w-5 mr-2 text-amber-500" />
          Group Admins
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium mb-2">Current Admins</h3>
            <div className="space-y-2">
              {creatorUser && (
                <div className="flex items-center justify-between p-2 rounded-md bg-amber-50 border border-amber-200">
                  <div className="flex items-center">
                    <Avatar className="h-8 w-8 mr-2">
                      <AvatarImage src={creatorUser.avatar || "/placeholder.svg"} alt={creatorUser.name} />
                      <AvatarFallback>{creatorUser.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{creatorUser.name}</p>
                      <div className="flex items-center">
                        <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">
                          Creator
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {adminUsers
                .filter((user) => user.id !== creator)
                .map((admin) => (
                  <div key={admin.id} className="flex items-center justify-between p-2 rounded-md border">
                    <div className="flex items-center">
                      <Avatar className="h-8 w-8 mr-2">
                        <AvatarImage src={admin.avatar || "/placeholder.svg"} alt={admin.name} />
                        <AvatarFallback>{admin.name.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{admin.name}</p>
                        <div className="flex items-center">
                          <Badge variant="outline" className="bg-blue-50 text-blue-800 border-blue-200">
                            <Shield className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleRemoveAdmin(admin.id)}
                      aria-label={`Remove admin ${admin.name}`}
                      disabled={persistBusy}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-2">Add from Group Members</h3>
            <div className="flex items-center mb-2">
              <Search className="h-4 w-4 mr-2 text-muted-foreground" />
              <Input
                placeholder="Search members..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1"
              />
            </div>

            {filteredMembers.length > 0 ? (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {filteredMembers.map((member) => (
                  <div
                    key={member.id}
                    className={`flex items-center justify-between p-2 rounded-md border cursor-pointer ${
                      selectedMembers.includes(member.id) ? "bg-blue-50 border-blue-200" : ""
                    }`}
                    onClick={() => handleToggleSelect(member.id)}
                  >
                    <div className="flex items-center">
                      <Avatar className="h-8 w-8 mr-2">
                        <AvatarImage src={member.avatar || "/placeholder.svg"} alt={member.name} />
                        <AvatarFallback>{member.name.substring(0, 2)}</AvatarFallback>
                      </Avatar>
                      <p className="font-medium">{member.name}</p>
                    </div>
                    <div className="flex items-center">
                      {selectedMembers.includes(member.id) ? (
                        <Check className="h-5 w-5 text-blue-500" />
                      ) : (
                        <UserPlus className="h-5 w-5 text-gray-400" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-2">No members found</p>
            )}

            {selectedMembers.length > 0 && (
              <Button className="w-full mt-4" onClick={handleMakeAdmins} disabled={persistBusy}>
                {persistBusy ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    Make {selectedMembers.length} {selectedMembers.length === 1 ? "Member" : "Members"} Admin
                  </>
                )}
              </Button>
            )}
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-2 flex items-center">
              <Globe className="h-4 w-4 mr-1" /> Invite from Anywhere on Rivr
            </h3>
            <p className="text-xs text-muted-foreground mb-2">
              Search all Rivr users. Selected people are added as admins and can sign in here with their home credentials.
            </p>
            <div className="flex items-center mb-2">
              <Search className="h-4 w-4 mr-2 text-muted-foreground" />
              <Input
                placeholder="Name or email…"
                value={globalQuery}
                onChange={(e) => setGlobalQuery(e.target.value)}
                className="flex-1"
              />
              {globalSearching && <Loader2 className="h-4 w-4 ml-2 animate-spin text-muted-foreground" />}
            </div>

            {globalQuery.trim().length >= GLOBAL_SEARCH_MIN_CHARS && globalResults.length === 0 && !globalSearching && (
              <p className="text-center text-xs text-muted-foreground py-2">No matches</p>
            )}

            {globalResults.length > 0 && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {globalResults.map((remote) => {
                  const alreadyAdmin = localAdmins.includes(remote.id)
                  const displayName = remote.name ?? remote.email ?? "Unnamed user"
                  return (
                    <div key={remote.id} className="flex items-center justify-between p-2 rounded-md border">
                      <div className="flex items-center min-w-0">
                        <Avatar className="h-8 w-8 mr-2 shrink-0">
                          <AvatarImage src={remote.avatarUrl ?? undefined} alt={displayName} />
                          <AvatarFallback>{displayName.substring(0, 2)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{displayName}</p>
                          {remote.email && (
                            <p className="text-xs text-muted-foreground truncate">{remote.email}</p>
                          )}
                          {remote.homeBaseUrl && (
                            <p className="text-[10px] text-muted-foreground truncate">{remote.homeBaseUrl}</p>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={alreadyAdmin ? "ghost" : "default"}
                        disabled={alreadyAdmin || mirroringId === remote.id || persistBusy}
                        onClick={() => handleMirrorAndPromote(remote)}
                      >
                        {alreadyAdmin ? (
                          <>
                            <Check className="h-4 w-4 mr-1" /> Admin
                          </>
                        ) : mirroringId === remote.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <Shield className="h-4 w-4 mr-1" /> Add as admin
                          </>
                        )}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
