/**
 * @fileoverview ProjectDistributionTab - Admin UI for configuring how a project's
 * sale settlement is cascaded to downstream recipients (parent org, allied groups).
 *
 * Renders on the project detail page. When a project-bound offering sells, the
 * seller-net is split per this config by the server-side resolver
 * (`@/lib/settlement-splits`): the project treasury keeps the remainder after the
 * configured downstream shares. This component is the single surface that writes
 * `project.metadata.distribution` — an array of `{ recipientId, bps, role }` —
 * which is the EXACT shape `parseProjectDistribution`/`resolveSettlementSplits`
 * consume. Percentages entered here are stored as basis points (1% = 100 bps).
 *
 * Non-admins see a read-only summary of the cascade.
 *
 * Key props: projectId, ownerId, ownerName, initialDistribution, recipientOptions, isAdmin
 */
"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Trash2, Landmark, Share2, Loader2, GitBranch } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { updateResource } from "@/app/actions/create-resources"
import { FULL_PIE_BPS, type SettlementRole } from "@/lib/settlement-splits"

/** A downstream distribution entry as stored on a project resource. */
interface ProjectDistributionEntry {
  recipientId: string
  bps: number
  role?: SettlementRole
}

/** A recipient the admin can quickly pick from (parent org / known allies). */
interface RecipientOption {
  id: string
  name: string
  type: string
}

/** A single parent-lineage ancestor available to receive a cascade share. */
interface LineageAncestor {
  agentId: string
  name: string
}

/**
 * The EFFECTIVE lineage cascade config (J6/J8). `explicit` reflects whether the
 * PROJECT authored its own config; when false the values shown are the resolved
 * default (system or org-level), pre-filled and editable. `levelBps[i]` is the
 * share for `ancestors[i]`. `defaultPerHopBps` is the system per-hop default a
 * newly-added/reset hop should pre-fill to.
 */
interface LineageConfigProp {
  explicit: boolean
  enabled: boolean
  levelBps: number[]
  defaultPerHopBps: number
  ancestors: LineageAncestor[]
}

interface ProjectDistributionTabProps {
  projectId: string
  /** The project owner agent — receives the retained "keep" share. */
  ownerId: string | null
  ownerName: string | null
  /** Persisted distribution config (server-parsed) for the project. */
  initialDistribution: ProjectDistributionEntry[]
  /** Quick-pick recipients (parent org, allied groups). */
  recipientOptions: RecipientOption[]
  isAdmin: boolean
  /** Effective parent-lineage cascade config (default ON, overridable). */
  lineage: LineageConfigProp
}

/** Downstream-recipient roles selectable in the UI. */
const ROLE_OPTIONS: { value: Exclude<SettlementRole, "seller" | "project">; label: string }[] = [
  { value: "parent_org", label: "Parent organization" },
  { value: "ally", label: "Allied group" },
  { value: "distribution", label: "Distribution" },
]

const ROLE_LABEL: Record<string, string> = {
  parent_org: "Parent organization",
  ally: "Allied group",
  distribution: "Distribution",
}

/** Local editable row; carries a stable client key and a percentage for the input. */
interface DistributionRow {
  key: string
  recipientId: string
  role: Exclude<SettlementRole, "seller" | "project">
  /** Whole/decimal percentage (0–100); converted to bps on save. */
  percent: number
}

/** 1% expressed in basis points. */
const BPS_PER_PERCENT = FULL_PIE_BPS / 100

function bpsToPercent(bps: number): number {
  return Math.round((bps / BPS_PER_PERCENT) * 100) / 100
}

function percentToBps(percent: number): number {
  return Math.round(percent * BPS_PER_PERCENT)
}

function entryToRow(entry: ProjectDistributionEntry, index: number): DistributionRow {
  const role =
    entry.role === "parent_org" || entry.role === "ally" || entry.role === "distribution"
      ? entry.role
      : "distribution"
  return {
    key: `dist_${index}_${entry.recipientId}`,
    recipientId: entry.recipientId,
    role,
    percent: bpsToPercent(entry.bps),
  }
}

export function ProjectDistributionTab({
  projectId,
  ownerId,
  ownerName,
  initialDistribution,
  recipientOptions,
  isAdmin,
  lineage,
}: ProjectDistributionTabProps) {
  const { toast } = useToast()
  const [rows, setRows] = useState<DistributionRow[]>(() => initialDistribution.map(entryToRow))
  const [saving, setSaving] = useState(false)

  // ── Lineage cascade editor state (J6/J8: default ON, fully overridable) ─────
  // Pre-fill with the EFFECTIVE config (default or org/project override). One
  // editable percentage per ancestor hop; the org keeps whatever is left.
  const [lineageEnabled, setLineageEnabled] = useState(lineage.enabled)
  const [lineagePercents, setLineagePercents] = useState<number[]>(() =>
    lineage.ancestors.map((_, index) => bpsToPercent(lineage.levelBps[index] ?? lineage.defaultPerHopBps)),
  )
  const [savingLineage, setSavingLineage] = useState(false)
  const defaultPerHopPercent = bpsToPercent(lineage.defaultPerHopBps)

  const handleLineagePercentChange = (index: number, value: number) => {
    setLineagePercents((prev) => prev.map((p, i) => (i === index ? value : p)))
  }

  const handleResetLineageDefaults = () => {
    setLineageEnabled(true)
    setLineagePercents(lineage.ancestors.map(() => defaultPerHopPercent))
  }

  const handleSaveLineage = async () => {
    // Persist as metadata.lineage. enabled=false is an explicit OPT-OUT that the
    // system default will NOT re-enable. levelBps is trimmed of trailing zeros.
    const levelBps = lineagePercents.map((p) => percentToBps(p))
    while (levelBps.length > 0 && levelBps[levelBps.length - 1] <= 0) levelBps.pop()

    setSavingLineage(true)
    try {
      const result = await updateResource({
        resourceId: projectId,
        metadataPatch: { lineage: { enabled: lineageEnabled, levelBps } },
      })
      if (result.success) {
        toast({
          title: "Lineage cascade saved",
          description: lineageEnabled
            ? `Cascading up to ${levelBps.length} parent level${levelBps.length === 1 ? "" : "s"}.`
            : "Lineage cascade turned off for this project.",
        })
      } else {
        toast({
          title: "Could not save lineage cascade",
          description: result.message || "Please try again.",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("[ProjectDistributionTab] lineage save failed:", error)
      toast({
        title: "Could not save lineage cascade",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setSavingLineage(false)
    }
  }

  const recipientNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const option of recipientOptions) map.set(option.id, option.name)
    if (ownerId && ownerName) map.set(ownerId, ownerName)
    return map
  }, [recipientOptions, ownerId, ownerName])

  // Distributed total (bps) excludes malformed/zero rows. Project keeps the rest.
  const distributedBps = useMemo(
    () => rows.reduce((sum, row) => sum + percentToBps(row.percent), 0),
    [rows],
  )
  const keepBps = FULL_PIE_BPS - distributedBps
  const overAllocated = distributedBps > FULL_PIE_BPS

  const handleAddRow = () => {
    setRows((prev) => [
      ...prev,
      { key: `dist_new_${Date.now()}`, recipientId: "", role: "distribution", percent: 0 },
    ])
  }

  const handleRemoveRow = (key: string) => {
    setRows((prev) => prev.filter((row) => row.key !== key))
  }

  const handleRowChange = <K extends keyof DistributionRow>(
    key: string,
    field: K,
    value: DistributionRow[K],
  ) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)))
  }

  const handleSave = async () => {
    // Drop rows without a recipient or a positive share; collapse duplicates by
    // summing into the first occurrence so the persisted config matches the
    // resolver's dedupe semantics.
    const byRecipient = new Map<string, ProjectDistributionEntry>()
    for (const row of rows) {
      const recipientId = row.recipientId.trim()
      const bps = percentToBps(row.percent)
      if (!recipientId || bps <= 0) continue
      const existing = byRecipient.get(recipientId)
      if (existing) {
        existing.bps += bps
      } else {
        byRecipient.set(recipientId, { recipientId, bps, role: row.role })
      }
    }
    const distribution = Array.from(byRecipient.values())
    const totalBps = distribution.reduce((sum, entry) => sum + entry.bps, 0)

    if (totalBps > FULL_PIE_BPS) {
      toast({
        title: "Allocation exceeds 100%",
        description: "Downstream shares total more than the full sale. Reduce a share and try again.",
        variant: "destructive",
      })
      return
    }

    setSaving(true)
    try {
      const result = await updateResource({
        resourceId: projectId,
        metadataPatch: { distribution },
      })
      if (result.success) {
        toast({
          title: "Distribution saved",
          description:
            distribution.length === 0
              ? "All sale proceeds now stay in the project treasury."
              : `Project keeps ${bpsToPercent(FULL_PIE_BPS - totalBps)}%; ${distribution.length} downstream recipient${distribution.length === 1 ? "" : "s"}.`,
        })
        // Re-key rows so future edits stay stable after a save.
        setRows(distribution.map(entryToRow))
      } else {
        toast({
          title: "Could not save distribution",
          description: result.message || "Please try again.",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("[ProjectDistributionTab] save failed:", error)
      toast({
        title: "Could not save distribution",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  // ── Read-only summary (non-admins) ──────────────────────────────────────────
  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Revenue Distribution</CardTitle>
          <CardDescription>How this project shares the proceeds of its sales.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
            <span className="inline-flex items-center gap-2 font-medium">
              <Landmark className="h-4 w-4 text-emerald-600" />
              Project treasury
            </span>
            <span className="font-semibold">{bpsToPercent(Math.max(keepBps, 0))}%</span>
          </div>
          {initialDistribution.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              All sale proceeds stay in the project treasury.
            </p>
          ) : (
            initialDistribution.map((entry, index) => (
              <div key={`${entry.recipientId}-${index}`} className="flex items-center justify-between p-3 border rounded-md">
                <span className="inline-flex items-center gap-2">
                  <Share2 className="h-4 w-4 text-muted-foreground" />
                  <span>{recipientNameById.get(entry.recipientId) ?? entry.recipientId}</span>
                  <Badge variant="outline">{ROLE_LABEL[entry.role ?? "distribution"]}</Badge>
                </span>
                <span className="font-semibold">{bpsToPercent(entry.bps)}%</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    )
  }

  // ── Admin editor ────────────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Revenue Distribution</CardTitle>
        <CardDescription>
          Configure how the proceeds of this project&apos;s sales cascade to downstream recipients.
          The project treasury keeps whatever is left after these shares.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Project keep summary */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 font-medium">
              <Landmark className="h-4 w-4 text-emerald-600" />
              Project treasury keeps
            </span>
            <span className={`font-semibold ${overAllocated ? "text-destructive" : ""}`}>
              {bpsToPercent(Math.max(keepBps, 0))}%
            </span>
          </div>
          <Progress value={Math.max(0, Math.min(100, bpsToPercent(keepBps)))} className="h-2" />
          {overAllocated ? (
            <p className="text-sm text-destructive">
              Downstream shares total {bpsToPercent(distributedBps)}% — more than the full sale.
              Reduce a share before saving.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {bpsToPercent(distributedBps)}% distributed downstream.
            </p>
          )}
        </div>

        <Separator />

        {/* Downstream recipient rows */}
        <div className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No downstream recipients. All sale proceeds stay in the project treasury.
            </p>
          ) : (
            rows.map((row) => (
              <div key={row.key} className="grid gap-3 p-3 border rounded-md sm:grid-cols-[1fr_auto]">
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`recipient-${row.key}`}>Recipient</Label>
                      {recipientOptions.length > 0 ? (
                        <Select
                          value={recipientOptions.some((o) => o.id === row.recipientId) ? row.recipientId : "__custom__"}
                          onValueChange={(value) =>
                            handleRowChange(row.key, "recipientId", value === "__custom__" ? "" : value)
                          }
                        >
                          <SelectTrigger id={`recipient-${row.key}`}>
                            <SelectValue placeholder="Select a recipient" />
                          </SelectTrigger>
                          <SelectContent>
                            {recipientOptions.map((option) => (
                              <SelectItem key={option.id} value={option.id}>
                                {option.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="__custom__">Custom (enter ID)…</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : null}
                      {recipientOptions.length === 0 || !recipientOptions.some((o) => o.id === row.recipientId) ? (
                        <Input
                          placeholder="Recipient agent ID"
                          value={row.recipientId}
                          onChange={(e) => handleRowChange(row.key, "recipientId", e.target.value)}
                        />
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`role-${row.key}`}>Role</Label>
                      <Select
                        value={row.role}
                        onValueChange={(value) =>
                          handleRowChange(row.key, "role", value as DistributionRow["role"])
                        }
                      >
                        <SelectTrigger id={`role-${row.key}`}>
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`percent-${row.key}`}>Share of each sale (%)</Label>
                    <Input
                      id={`percent-${row.key}`}
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={Number.isFinite(row.percent) ? row.percent : 0}
                      onChange={(e) => {
                        const parsed = Number.parseFloat(e.target.value)
                        handleRowChange(row.key, "percent", Number.isFinite(parsed) ? parsed : 0)
                      }}
                      className="max-w-[140px]"
                    />
                  </div>
                </div>
                <div className="flex items-start justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveRow(row.key)}
                    aria-label="Remove recipient"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          )}

          <Button variant="outline" onClick={handleAddRow} disabled={saving}>
            <Plus className="h-4 w-4 mr-2" />
            Add recipient
          </Button>
        </div>

        <Separator />

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || overAllocated}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Save Distribution"
            )}
          </Button>
        </div>

        <Separator />

        {/* ── Parent-lineage cascade (off until explicitly configured) ─────── */}
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="inline-flex items-center gap-2 font-medium">
                <GitBranch className="h-4 w-4 text-indigo-600" />
                Parent-lineage cascade
              </h3>
              <p className="text-sm text-muted-foreground">
                Optionally share a slice of net up the parent-organization chain.
                This is OFF until you turn it on and set a share per level — net is
                distributed only to the recipients you configure here.
                {!lineage.explicit ? " Nothing is cascaded by default; enable and save to set shares." : null}
              </p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                id="lineage-enabled"
                checked={lineageEnabled}
                onCheckedChange={setLineageEnabled}
                aria-label="Enable parent-lineage cascade"
              />
              <Label htmlFor="lineage-enabled" className="text-sm">
                {lineageEnabled ? "On" : "Off"}
              </Label>
            </div>
          </div>

          {lineage.ancestors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This organization has no parent in its lineage, so there is nothing to cascade to.
            </p>
          ) : lineageEnabled ? (
            <div className="space-y-3">
              {lineage.ancestors.map((ancestor, index) => (
                <div
                  key={ancestor.agentId}
                  className="flex items-center justify-between gap-3 p-3 border rounded-md"
                >
                  <div className="min-w-0">
                    <p className="text-sm truncate">{ancestor.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Level {index + 1} {index === 0 ? "(immediate parent)" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={Number.isFinite(lineagePercents[index]) ? lineagePercents[index] : 0}
                      onChange={(e) => {
                        const parsed = Number.parseFloat(e.target.value)
                        handleLineagePercentChange(index, Number.isFinite(parsed) ? parsed : 0)
                      }}
                      className="w-24"
                      aria-label={`Cascade share for ${ancestor.name}`}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Lineage cascade is turned off — no net flows up the parent chain by default.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={handleResetLineageDefaults}
              disabled={savingLineage || lineage.ancestors.length === 0}
            >
              Reset to defaults
            </Button>
            <Button
              variant="outline"
              onClick={handleSaveLineage}
              disabled={savingLineage || lineage.ancestors.length === 0}
            >
              {savingLineage ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save Lineage Cascade"
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
