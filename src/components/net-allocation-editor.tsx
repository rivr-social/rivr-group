/**
 * @fileoverview NetAllocationEditor — admin Stake-tree editor (EPIC J7).
 *
 * Renders the org's net %-allocation TREE as an editable list of rules. Each
 * rule allocates a percentage (basis points) of the org net to either a
 * membership CLASS (e.g. all `host`-tier members) or a named INDIVIDUAL. The
 * org implicitly keeps the undistributed remainder, so the authored total may be
 * below 100% but must never exceed it.
 *
 * Persists via `saveNetAllocationAction` (admin-gated server action). The editor
 * itself never moves money — it only configures the distribution tree. The
 * Layer-2 distribution RUN that actually credits wallets is a separate,
 * explicit, confirm-gated action.
 */
"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { saveNetAllocationAction } from "@/app/actions/wallet/net-allocation"
import {
  NET_ALLOCATION_FULL_PIE_BPS,
  type NetAllocationRule,
  type NetAllocationTargetType,
} from "@/lib/net-allocation"

/** A membership class available as an allocation target. */
export interface NetAllocationClassOption {
  /** The class key (membership ledger role); used as the rule `targetId`. */
  key: string
  /** Number of members currently resolved into this class (for display). */
  memberCount: number
}

/** An individual member available as an allocation target. */
export interface NetAllocationMemberOption {
  id: string
  name: string
}

export interface NetAllocationEditorProps {
  /** The org/group agent id whose tree is being edited. */
  groupId: string
  /** The saved allocation rules (from `metadata.netAllocation.rules`). */
  initialRules: NetAllocationRule[]
  /** Membership classes available as `class`-target options. */
  classOptions: NetAllocationClassOption[]
  /** Individual members available as `individual`-target options. */
  memberOptions: NetAllocationMemberOption[]
}

/** Editor-local draft row; bps is held as a string for controlled inputs. */
interface DraftRule {
  /** Stable local id so React keys survive reorders/edits. */
  localId: string
  targetType: NetAllocationTargetType
  targetId: string
  /** Percent string (0–100) bound to the input; converted to bps on save. */
  percent: string
}

const PERCENT_TO_BPS = NET_ALLOCATION_FULL_PIE_BPS / 100 // 100 bps per percent
const MAX_PERCENT = 100

/** Converts a stored bps integer to a trimmed percent string (e.g. 2500 → "25"). */
function bpsToPercentString(bps: number): string {
  const pct = bps / PERCENT_TO_BPS
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, "")
}

/** Parses a percent string into integer bps; returns NaN on invalid input. */
function percentStringToBps(percent: string): number {
  const pct = Number(percent)
  if (!Number.isFinite(pct)) return Number.NaN
  return Math.round(pct * PERCENT_TO_BPS)
}

let draftCounter = 0
function nextLocalId(): string {
  draftCounter += 1
  return `rule-${draftCounter}`
}

export function NetAllocationEditor({
  groupId,
  initialRules,
  classOptions,
  memberOptions,
}: NetAllocationEditorProps) {
  const { toast } = useToast()
  const router = useRouter()

  const [drafts, setDrafts] = useState<DraftRule[]>(() =>
    initialRules.map((rule) => ({
      localId: nextLocalId(),
      targetType: rule.targetType,
      targetId: rule.targetId,
      percent: bpsToPercentString(rule.bps),
    })),
  )
  const [saving, setSaving] = useState(false)

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of memberOptions) map.set(m.id, m.name)
    return map
  }, [memberOptions])

  // Live running total in bps (invalid rows contribute 0 to the preview).
  const totalBps = useMemo(
    () =>
      drafts.reduce((sum, d) => {
        const bps = percentStringToBps(d.percent)
        return sum + (Number.isFinite(bps) && bps > 0 ? bps : 0)
      }, 0),
    [drafts],
  )
  const totalPercent = totalBps / PERCENT_TO_BPS
  const overAllocated = totalBps > NET_ALLOCATION_FULL_PIE_BPS
  const orgKeepPercent = Math.max(0, MAX_PERCENT - totalPercent)

  const addRule = (targetType: NetAllocationTargetType) => {
    setDrafts((prev) => [
      ...prev,
      { localId: nextLocalId(), targetType, targetId: "", percent: "" },
    ])
  }

  const removeRule = (localId: string) => {
    setDrafts((prev) => prev.filter((d) => d.localId !== localId))
  }

  const updateRule = (localId: string, patch: Partial<DraftRule>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.localId === localId ? { ...d, ...patch } : d)),
    )
  }

  const handleSave = async () => {
    // Validate every row before persisting; surface the first problem.
    const rules: NetAllocationRule[] = []
    for (const d of drafts) {
      if (!d.targetId) {
        toast({ title: "Incomplete rule", description: "Choose a target for every rule.", variant: "destructive" })
        return
      }
      const bps = percentStringToBps(d.percent)
      if (!Number.isFinite(bps) || bps <= 0) {
        toast({ title: "Invalid percentage", description: "Each rule needs a percentage greater than 0.", variant: "destructive" })
        return
      }
      const label =
        d.targetType === "individual" ? memberNameById.get(d.targetId) : d.targetId
      rules.push({ targetType: d.targetType, targetId: d.targetId, bps, label })
    }

    if (totalBps > NET_ALLOCATION_FULL_PIE_BPS) {
      toast({
        title: "Over-allocated",
        description: `Total allocation is ${totalPercent.toFixed(2)}%, which exceeds 100%.`,
        variant: "destructive",
      })
      return
    }

    setSaving(true)
    try {
      const result = await saveNetAllocationAction({ groupId, rules })
      if (!result.success) {
        toast({ title: "Could not save", description: result.error ?? "Save failed.", variant: "destructive" })
        return
      }
      toast({ title: "Net allocation saved", description: result.message })
      router.refresh()
    } catch (err) {
      toast({
        title: "Could not save",
        description: err instanceof Error ? err.message : "Save failed.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Net Allocation Tree</CardTitle>
        <CardDescription>
          Allocate a percentage of the org net to membership classes or specific
          individuals. The org keeps any undistributed remainder. Totals above
          100% are rejected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {drafts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No allocation rules yet. Add a class or individual rule below.
          </p>
        )}

        <div className="space-y-3">
          {drafts.map((draft) => {
            const rowBps = percentStringToBps(draft.percent)
            const rowInvalid =
              draft.percent !== "" && (!Number.isFinite(rowBps) || rowBps <= 0)
            return (
              <div
                key={draft.localId}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end"
              >
                <div className="flex-1 space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {draft.targetType === "class" ? "Membership class" : "Individual"}
                  </Label>
                  {draft.targetType === "class" ? (
                    <Select
                      value={draft.targetId}
                      onValueChange={(value) => updateRule(draft.localId, { targetId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a class" />
                      </SelectTrigger>
                      <SelectContent>
                        {classOptions.length === 0 && (
                          <SelectItem value="__none__" disabled>
                            No membership classes found
                          </SelectItem>
                        )}
                        {classOptions.map((opt) => (
                          <SelectItem key={opt.key} value={opt.key}>
                            {opt.key} ({opt.memberCount} member{opt.memberCount === 1 ? "" : "s"})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select
                      value={draft.targetId}
                      onValueChange={(value) => updateRule(draft.localId, { targetId: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a member" />
                      </SelectTrigger>
                      <SelectContent>
                        {memberOptions.length === 0 && (
                          <SelectItem value="__none__" disabled>
                            No members found
                          </SelectItem>
                        )}
                        {memberOptions.map((opt) => (
                          <SelectItem key={opt.id} value={opt.id}>
                            {opt.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <div className="w-full space-y-1 sm:w-32">
                  <Label className="text-xs text-muted-foreground">Percent</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={MAX_PERCENT}
                      step="any"
                      inputMode="decimal"
                      value={draft.percent}
                      placeholder="0"
                      aria-invalid={rowInvalid}
                      onChange={(e) => updateRule(draft.localId, { percent: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove rule"
                  onClick={() => removeRule(draft.localId)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => addRule("class")}>
            <Plus className="mr-2 h-4 w-4" />
            Add class rule
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addRule("individual")}>
            <Plus className="mr-2 h-4 w-4" />
            Add individual rule
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Allocated:</span>
            <Badge variant={overAllocated ? "destructive" : "secondary"}>
              {totalPercent.toFixed(2)}%
            </Badge>
            <span className="text-muted-foreground">Org keeps:</span>
            <Badge variant="outline">{orgKeepPercent.toFixed(2)}%</Badge>
            {overAllocated && (
              <span className="text-sm text-destructive">Total exceeds 100%.</span>
            )}
          </div>
          <Button type="button" onClick={handleSave} disabled={saving || overAllocated}>
            {saving ? "Saving…" : "Save allocation"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
