"use client"

/**
 * Eligibility-gate picker (governance P2). Shared by the create-poll and
 * create-proposal modals ("Who can vote") and the admin governance-settings
 * dialog ("Who can propose"). Emits a draft gate; the server action
 * re-validates and verifies any referenced badge/share class belongs to the
 * group.
 */
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DEFAULT_MIN_SHARES,
  ELIGIBILITY_KINDS,
  ELIGIBILITY_KIND_DESCRIPTIONS,
  ELIGIBILITY_KIND_PROPOSE_DESCRIPTIONS,
  ELIGIBILITY_KIND_LABELS,
  type EligibilityKind,
} from "@/lib/governance-eligibility"

/** The picker's in-flight state (minShares kept as text for the input). */
export interface EligibilityGateDraft {
  kind: EligibilityKind
  badgeId: string
  shareClassId: string
  minShares: string
}

/** Options the pickers offer (server-fetched: the group's badges + classes). */
export interface GovernanceGateOptions {
  badges: Array<{ id: string; name: string }>
  shareClasses: Array<{ id: string; name: string }>
}

export const EMPTY_GATE_OPTIONS: GovernanceGateOptions = { badges: [], shareClasses: [] }

export function makeGateDraft(kind: EligibilityKind = "member"): EligibilityGateDraft {
  return { kind, badgeId: "", shareClassId: "", minShares: String(DEFAULT_MIN_SHARES) }
}

/** Serialize a draft into the server action's `voteEligibility`/`gate` input. */
export function draftToGateInput(draft: EligibilityGateDraft): {
  kind: string
  badgeId?: string
  shareClassId?: string
  minShares?: number
} {
  const gate: { kind: string; badgeId?: string; shareClassId?: string; minShares?: number } = {
    kind: draft.kind,
  }
  if (draft.kind === "badge-holder" && draft.badgeId) gate.badgeId = draft.badgeId
  if (draft.kind === "share-holder") {
    if (draft.shareClassId) gate.shareClassId = draft.shareClassId
    const minShares = Number.parseInt(draft.minShares, 10)
    gate.minShares = Number.isInteger(minShares) && minShares >= 1 ? minShares : DEFAULT_MIN_SHARES
  }
  return gate
}

/** Sentinel for the "any badge / any class" select rows (Radix forbids ""). */
const ANY_OPTION = "__any__"

interface GovernanceEligibilityPickerProps {
  /** Field label, e.g. "Who can vote" / "Who can propose". */
  label: string
  value: EligibilityGateDraft
  onChange: (draft: EligibilityGateDraft) => void
  options: GovernanceGateOptions
  /** Stable id prefix for the form controls. */
  idPrefix: string
  /** Phrases the helper text: "vote" (default) or "propose". */
  context?: "vote" | "propose"
}

export function GovernanceEligibilityPicker({
  label,
  value,
  onChange,
  options,
  idPrefix,
  context = "vote",
}: GovernanceEligibilityPickerProps) {
  const descriptions =
    context === "propose" ? ELIGIBILITY_KIND_PROPOSE_DESCRIPTIONS : ELIGIBILITY_KIND_DESCRIPTIONS
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-kind`}>{label}</Label>
      <Select
        value={value.kind}
        onValueChange={(kind) => onChange({ ...value, kind: kind as EligibilityKind })}
      >
        <SelectTrigger id={`${idPrefix}-kind`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ELIGIBILITY_KINDS.map((kind) => (
            <SelectItem
              key={kind}
              value={kind}
              disabled={
                (kind === "badge-holder" && options.badges.length === 0) ||
                (kind === "share-holder" && options.shareClasses.length === 0)
              }
            >
              {ELIGIBILITY_KIND_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{descriptions[value.kind]}</p>

      {value.kind === "badge-holder" && options.badges.length > 0 && (
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
              <SelectItem value={ANY_OPTION}>Any governance badge</SelectItem>
              {options.badges.map((badge) => (
                <SelectItem key={badge.id} value={badge.id}>
                  {badge.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {value.kind === "share-holder" && options.shareClasses.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-class`} className="text-xs">
              Share class
            </Label>
            <Select
              value={value.shareClassId || ANY_OPTION}
              onValueChange={(shareClassId) =>
                onChange({ ...value, shareClassId: shareClassId === ANY_OPTION ? "" : shareClassId })
              }
            >
              <SelectTrigger id={`${idPrefix}-class`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_OPTION}>Any share class</SelectItem>
                {options.shareClasses.map((cls) => (
                  <SelectItem key={cls.id} value={cls.id}>
                    {cls.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-min-shares`} className="text-xs">
              Minimum shares
            </Label>
            <Input
              id={`${idPrefix}-min-shares`}
              type="number"
              min={1}
              step={1}
              value={value.minShares}
              onChange={(event) => onChange({ ...value, minShares: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
