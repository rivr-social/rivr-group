"use client"

/**
 * Vote-weight picker (governance P3). Used by the create-poll/proposal modals
 * ("Vote weight", seeded with the org's governance default) and the admin
 * governance-settings dialog ("Default vote weight"). Emits a draft config;
 * the server action re-validates and verifies a referenced badge belongs to
 * the group.
 */
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  WEIGHT_KINDS,
  WEIGHT_KIND_DESCRIPTIONS,
  WEIGHT_KIND_LABELS,
  isWeightKind,
  type WeightConfig,
  type WeightKind,
} from "@/lib/governance-weight"

/** The picker's in-flight state. */
export interface WeightConfigDraft {
  kind: WeightKind
  badgeId: string
}

export function makeWeightDraft(config?: WeightConfig): WeightConfigDraft {
  if (!config || !isWeightKind(config.kind)) return { kind: "equal", badgeId: "" }
  return { kind: config.kind, badgeId: config.badgeId ?? "" }
}

/** Serialize a draft into the server action's `voteWeight`/`defaultWeight` input. */
export function draftToWeightInput(draft: WeightConfigDraft): { kind: string; badgeId?: string } {
  const config: { kind: string; badgeId?: string } = { kind: draft.kind }
  if (draft.kind === "badge-weight" && draft.badgeId) config.badgeId = draft.badgeId
  return config
}

/** Sentinel for the "highest held badge" select row (Radix forbids ""). */
const ANY_OPTION = "__any__"

interface GovernanceWeightPickerProps {
  /** Field label, e.g. "Vote weight" / "Default vote weight". */
  label: string
  value: WeightConfigDraft
  onChange: (draft: WeightConfigDraft) => void
  /** The group's governance badges (for the badge-weight reference picker). */
  badges: Array<{ id: string; name: string }>
  /** Whether the org has any share classes carrying voteBps (enables voting-shares). */
  hasVotingShares: boolean
  /** Stable id prefix for the form controls. */
  idPrefix: string
}

export function GovernanceWeightPicker({
  label,
  value,
  onChange,
  badges,
  hasVotingShares,
  idPrefix,
}: GovernanceWeightPickerProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-kind`}>{label}</Label>
      <Select
        value={value.kind}
        onValueChange={(kind) => onChange({ ...value, kind: kind as WeightKind })}
      >
        <SelectTrigger id={`${idPrefix}-kind`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEIGHT_KINDS.map((kind) => (
            <SelectItem
              key={kind}
              value={kind}
              disabled={
                (kind === "badge-weight" && badges.length === 0) ||
                (kind === "voting-shares" && !hasVotingShares)
              }
            >
              {WEIGHT_KIND_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{WEIGHT_KIND_DESCRIPTIONS[value.kind]}</p>

      {value.kind === "badge-weight" && badges.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-badge`} className="text-xs">
            Badge
          </Label>
          <Select
            value={value.badgeId || ANY_OPTION}
            onValueChange={(badgeId) =>
              onChange({ ...value, badgeId: badgeId === ANY_OPTION ? "" : badgeId })
            }
          >
            <SelectTrigger id={`${idPrefix}-badge`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_OPTION}>Highest held governance badge</SelectItem>
              {badges.map((badge) => (
                <SelectItem key={badge.id} value={badge.id}>
                  {badge.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
