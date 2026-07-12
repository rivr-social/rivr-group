"use client"

/**
 * Share classes card — renders inside the group Treasury tab.
 *
 * Two audiences in one card:
 *  - EVERY member sees a "Your Shares" panel: the share classes they hold shares
 *    in for this org, their share count, and their pro-rata slice of the class's
 *    net-% of the org treasury (the Steward/Worker equity view).
 *  - ADMINS additionally get authoring: create hidden share classes (Stewards /
 *    Workers / custom), set each class's net-% + share cap, and assign members a
 *    number of shares.
 *
 * All money movement stays in the existing net-distribution rail; this card only
 * authors classes and holdings. Percentages are basis points under the hood
 * (netBps), shown as %.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PieChart, Plus, Users } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  createShareClassAction,
  setShareClassAllocationAction,
  setMemberSharesAction,
  getShareClassOverviewAction,
  getMemberShareHoldingsAction,
  getOrgMembersAction,
} from "@/app/actions/wallet"

interface ShareClassesCardProps {
  groupId: string
  canManage?: boolean
}

interface Holder {
  memberId: string
  memberName: string
  shares: number
}

interface ShareClass {
  id: string
  name: string
  shareCount: number
  netBps: number
  hidden: boolean
  tierKey: string | null
  holders: Holder[]
}

interface MyHolding {
  classId: string
  className: string
  orgId: string
  myShares: number
  classTotalShares: number
  classNetBps: number
  myNetBps: number
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`

export function ShareClassesCard({ groupId, canManage = false }: ShareClassesCardProps) {
  const { toast } = useToast()
  const [classes, setClasses] = useState<ShareClass[]>([])
  const [totalNetBps, setTotalNetBps] = useState(0)
  const [myHoldings, setMyHoldings] = useState<MyHolding[]>([])
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newTier, setNewTier] = useState<"none" | "steward" | "worker">("none")
  const [newShareCount, setNewShareCount] = useState("100")
  const [newNetPct, setNewNetPct] = useState("0")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const mine = await getMemberShareHoldingsAction().catch(() => null)
    if (mine?.success && mine.holdings) {
      setMyHoldings(mine.holdings.filter((h) => h.orgId === groupId))
    }
    if (canManage) {
      const [overview, mem] = await Promise.all([
        getShareClassOverviewAction(groupId).catch(() => null),
        getOrgMembersAction(groupId).catch(() => null),
      ])
      if (overview?.success && overview.classes) {
        setClasses(overview.classes as ShareClass[])
        setTotalNetBps(overview.totalNetBps ?? 0)
      }
      if (mem?.success && mem.members) setMembers(mem.members)
    }
    setLoading(false)
  }, [groupId, canManage])

  useEffect(() => {
    void load()
  }, [load])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast({ title: "Name required", description: "Give the share class a name.", variant: "destructive" })
      return
    }
    const shareCount = Number.parseInt(newShareCount, 10)
    const netPct = Number.parseFloat(newNetPct)
    if (!Number.isFinite(shareCount) || shareCount < 0) {
      toast({ title: "Invalid shares", description: "Share count must be a whole number ≥ 0.", variant: "destructive" })
      return
    }
    if (!Number.isFinite(netPct) || netPct < 0 || netPct > 100) {
      toast({ title: "Invalid net %", description: "Net % must be between 0 and 100.", variant: "destructive" })
      return
    }
    setBusy(true)
    const res = await createShareClassAction(groupId, {
      name,
      shareCount,
      netBps: Math.round(netPct * 100),
      tierKey: newTier === "none" ? null : newTier,
    })
    setBusy(false)
    if (!res.success) {
      toast({ title: "Could not create", description: res.error, variant: "destructive" })
      return
    }
    toast({ title: "Share class created", description: name })
    setCreateOpen(false)
    setNewName("")
    setNewTier("none")
    setNewShareCount("100")
    setNewNetPct("0")
    void load()
  }

  const handleSetShares = async (classId: string, memberId: string, shares: number) => {
    const res = await setMemberSharesAction(groupId, classId, memberId, shares)
    if (!res.success) {
      toast({ title: "Could not update shares", description: res.error, variant: "destructive" })
      return
    }
    void load()
  }

  const handleSetNet = async (classId: string, netPct: number) => {
    if (!Number.isFinite(netPct) || netPct < 0 || netPct > 100) return
    const res = await setShareClassAllocationAction(groupId, classId, { netBps: Math.round(netPct * 100) })
    if (!res.success) {
      toast({ title: "Could not update net %", description: res.error, variant: "destructive" })
      return
    }
    void load()
  }

  const hasAnything = myHoldings.length > 0 || (canManage && classes.length > 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="h-5 w-5" /> Shares
            </CardTitle>
            <CardDescription>
              Equity classes that receive a percentage of the org&apos;s net, split by shares held.
            </CardDescription>
            <CardDescription>
              A share class receives a slice of the group&apos;s net income; members split that slice
              by the shares they hold.
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New class
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Member self-view */}
            {myHoldings.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Your shares</h4>
                {myHoldings.map((h) => (
                  <div
                    key={h.classId}
                    className="flex items-center justify-between rounded-md border p-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">{h.className}</div>
                      <div className="text-muted-foreground">
                        {h.myShares} of {h.classTotalShares} shares
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{pct(h.myNetBps)}</div>
                      <div className="text-muted-foreground text-xs">of org net</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Admin authoring */}
            {canManage && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Share classes</h4>
                  <Badge variant={totalNetBps > 10000 ? "destructive" : "secondary"}>
                    {pct(totalNetBps)} of net allocated
                  </Badge>
                </div>
                {totalNetBps > 10000 && (
                  <p className="text-xs text-destructive">
                    You&apos;ve allocated more than 100% of net — reduce a class.
                  </p>
                )}
                {classes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No share classes yet. Create a Stewards or Workers class to allocate equity.
                  </p>
                ) : (
                  classes.map((c) => (
                    <div key={c.id} className="rounded-md border p-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.name}</span>
                          {c.tierKey && <Badge variant="outline">{c.tierKey}</Badge>}
                          {c.hidden && <Badge variant="outline">hidden</Badge>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground">net %</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            defaultValue={(c.netBps / 100).toString()}
                            className="h-8 w-24"
                            onBlur={(e) => {
                              const v = Number.parseFloat(e.target.value)
                              if (Math.round(v * 100) !== c.netBps) void handleSetNet(c.id, v)
                            }}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" /> Holders
                        </div>
                        {c.holders.length === 0 && (
                          <p className="text-xs text-muted-foreground">No members hold shares yet.</p>
                        )}
                        {c.holders.map((h) => (
                          <div key={h.memberId} className="flex items-center justify-between gap-2">
                            <span className="text-sm">{h.memberName}</span>
                            <Input
                              type="number"
                              min={0}
                              defaultValue={h.shares.toString()}
                              className="h-8 w-24"
                              onBlur={(e) => {
                                const v = Number.parseInt(e.target.value, 10)
                                if (Number.isFinite(v) && v !== h.shares) void handleSetShares(c.id, h.memberId, v)
                              }}
                            />
                          </div>
                        ))}
                        <AddHolder
                          members={members.filter((m) => !c.holders.some((h) => h.memberId === m.id))}
                          onAdd={(memberId, shares) => handleSetShares(c.id, memberId, shares)}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {!hasAnything && (
              <p className="text-sm text-muted-foreground">No share classes.</p>
            )}
          </>
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New share class</DialogTitle>
            <DialogDescription>
              An equity class (not shown in public directories) that receives a percentage of the
              org&apos;s net, split among its members by shares held.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Kind</Label>
              <Select value={newTier} onValueChange={(v) => setNewTier(v as "none" | "steward" | "worker")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Custom</SelectItem>
                  <SelectItem value="steward">Stewards</SelectItem>
                  <SelectItem value="worker">Workers</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-name">Name</Label>
              <Input
                id="sc-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Stewards"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="sc-shares">Total shares</Label>
                <Input
                  id="sc-shares"
                  type="number"
                  min={0}
                  value={newShareCount}
                  onChange={(e) => setNewShareCount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sc-net">Net % of treasury</Label>
                <Input
                  id="sc-net"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={newNetPct}
                  onChange={(e) => setNewNetPct(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Inline "add a member as a holder" row. */
function AddHolder({
  members,
  onAdd,
}: {
  members: Array<{ id: string; name: string }>
  onAdd: (memberId: string, shares: number) => void
}) {
  const [memberId, setMemberId] = useState("")
  const [shares, setShares] = useState("0")
  if (members.length === 0) return null
  return (
    <div className="flex items-center gap-2 pt-1">
      <Select value={memberId} onValueChange={setMemberId}>
        <SelectTrigger className="h-8 flex-1">
          <SelectValue placeholder="Add member…" />
        </SelectTrigger>
        <SelectContent>
          {members.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="number"
        min={0}
        value={shares}
        onChange={(e) => setShares(e.target.value)}
        className="h-8 w-20"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!memberId}
        onClick={() => {
          const v = Number.parseInt(shares, 10)
          if (memberId && Number.isFinite(v) && v > 0) {
            onAdd(memberId, v)
            setMemberId("")
            setShares("0")
          }
        }}
      >
        Add
      </Button>
    </div>
  )
}
