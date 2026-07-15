"use client"

/**
 * Reusable "Required badges" selector for job admin surfaces (2026-07-15).
 *
 * Lets an admin badge-gate a job from surfaces OTHER than the full /create form:
 * the project page's Add-job modal and the job Edit dialog. Fetches the group's
 * badges through the permission-checked reader `fetchAllResources({ type:
 * "badge" })` — NOT `fetchPublicResources`, because group badges are usually
 * `members` visibility and the public-only feed excludes them (empty picker).
 *
 * Purely controlled: the parent owns the selected id list and wires it into the
 * job's `metadata.requiredBadges` on save. Claim eligibility is enforced
 * server-side (`evaluateJobClaimEligibility`); this only authors the gate.
 */

import { useEffect, useState } from "react"
import { fetchAllResources } from "@/app/actions/graph"
import type { SerializedResource } from "@/lib/graph-serializers"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Check } from "lucide-react"

interface JobRequiredBadgesFieldProps {
  /** Currently selected badge resource ids (controlled). */
  value: string[]
  /** Called with the next selected id list on toggle. */
  onChange: (next: string[]) => void
  /**
   * Whether to fetch. Pass the containing dialog's open state so badges load
   * only when the field is actually shown (avoids a fetch on every mount).
   */
  active?: boolean
}

export function JobRequiredBadgesField({ value, onChange, active = true }: JobRequiredBadgesFieldProps) {
  const [badges, setBadges] = useState<SerializedResource[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    fetchAllResources({ type: "badge", limit: 500 })
      .then((rows) => {
        if (cancelled) return
        const onlyBadges = rows.filter((resource) => {
          const meta = (resource.metadata ?? {}) as Record<string, unknown>
          return resource.type === "badge" || String(meta.resourceKind ?? "").toLowerCase() === "badge"
        })
        setBadges(onlyBadges as SerializedResource[])
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setBadges([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active])

  const toggle = (badgeId: string) => {
    onChange(value.includes(badgeId) ? value.filter((id) => id !== badgeId) : [...value, badgeId])
  }

  return (
    <div className="space-y-2">
      <Label>Required badges</Label>
      <p className="text-xs text-muted-foreground">
        Claimants must hold at least one selected badge. Group admins bypass badge gates.
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading badges…</p>
      ) : badges.length === 0 ? (
        <p className="text-xs text-muted-foreground">No badges available to gate on.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {badges.map((badge) => {
            const selected = value.includes(badge.id)
            return (
              <button key={badge.id} type="button" onClick={() => toggle(badge.id)} aria-pressed={selected}>
                <Badge variant={selected ? "default" : "outline"} className="cursor-pointer gap-1">
                  {selected && <Check className="h-3 w-3" />}
                  {badge.name}
                </Badge>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
