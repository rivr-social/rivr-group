"use client"

/**
 * Visual query composer for the explore graph + contract/agreement system.
 *
 * Lets users construct Subject-Verb-Object conditional queries that filter
 * the D3 force graph, AND save them as auto-executing contract rules.
 *
 * Layout:
 * - WHEN row: [det] [who] [does what] [det] [with what]
 * - THEN rows (chainable): [I] [do what] [det] [with what] to [det] [who]
 * - Optional IF row via "+ Add Condition"
 * - Mini SVG canvas showing the sentence as a graph
 * - "Save as Agreement" + "My Agreements" section
 *
 * Determiners (any, my, the, that, a, all) prefix agent/resource slots
 * to scope how they match at runtime.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "@/app/actions/graph"
import {
  createContractRule,
  listMyContractRules,
  toggleContractRule,
  deleteContractRule,
} from "@/app/actions/contracts"
import type { ContractRuleRow } from "@/app/actions/contracts"
import type { ContractAction } from "@/db/schema"
import { Plus, X, Search, Filter, Trash2, Save, FileText, ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { parseNaturalLanguageV2 } from "@/lib/nlp-parser-v2"
import type { V2ParseResult } from "@/lib/nlp-parser-v2"
import { ENTITY_COLORS } from "@/lib/entity-style"

// ─── Constants ──────────────────────────────────────────────────────────────

/** All verbs from the verbTypeEnum in schema.ts, grouped logically. */
const VERB_GROUPS: { label: string; verbs: string[] }[] = [
  {
    label: "Economic",
    verbs: ["buy", "sell", "trade", "gift", "give", "earn", "redeem", "fund", "pledge", "transact", "refund"],
  },
  {
    label: "CRUD",
    verbs: ["create", "update", "delete", "transfer", "share", "view", "clone", "merge", "split"],
  },
  {
    label: "Work",
    verbs: ["work", "clock_in", "clock_out", "produce", "consume"],
  },
  {
    label: "Governance",
    verbs: ["vote", "propose", "approve", "reject"],
  },
  {
    label: "Membership",
    verbs: ["join", "manage", "own", "locate", "follow", "belong", "assign", "invite", "employ", "contain", "leave"],
  },
  {
    label: "Lifecycle",
    verbs: ["start", "complete", "cancel", "archive", "publish"],
  },
  {
    label: "Social",
    verbs: ["attend", "host", "schedule", "endorse", "mention", "comment", "react"],
  },
  {
    label: "Permissions",
    verbs: ["grant", "revoke", "rent", "use", "request"],
  },
]

/** Color map for agent/resource types — delegates to centralized entity-style. */
const TYPE_COLORS: Record<string, string> = {
  ...ENTITY_COLORS,
  offering: ENTITY_COLORS.listing,
  wildcard: ENTITY_COLORS.unknown,
  self: ENTITY_COLORS.person,
}

/** Node radii for the mini canvas */
const MINI_NODE_RADII: Record<string, number> = {
  person: 14,
  organization: 18,
  group: 18,
  event: 16,
  post: 10,
  offering: 12,
  wildcard: 12,
  self: 14,
  default: 12,
}

const WILDCARD_AGENTS = [
  { id: "__everyone__", name: "Everyone", type: "wildcard" },
  { id: "__any_person__", name: "Any Person", type: "person" },
  { id: "__any_group__", name: "Any Group", type: "organization" },
]

/** Agent determiner options */
const AGENT_DETERMINERS = ["any", "my", "the", "that"] as const
/** Resource determiner options */
const RESOURCE_DETERMINERS = ["any", "my", "the", "that", "a", "all"] as const

/** All known verb strings for NLP matching */
const ALL_VERBS = VERB_GROUPS.flatMap((g) => g.verbs)

// ─── Verb ↔ Resource Type Contextual Mappings ──────────────────────────────

/** Which resource types each verb can operate on. Empty array = targets agents only. */
const VERB_RESOURCE_TYPES: Record<string, string[]> = {
  // Commerce
  buy: ["listing", "product", "voucher"],
  sell: ["listing", "product", "voucher"],
  trade: ["listing", "product", "voucher", "thanks_token"],
  transact: ["listing", "product", "voucher", "thanks_token"],
  refund: ["listing", "product", "voucher", "receipt"],

  // Gifting
  give: ["thanks_token", "voucher", "listing", "product", "badge"],
  gift: ["thanks_token", "voucher", "listing", "product", "badge"],
  earn: ["thanks_token", "voucher", "badge"],
  redeem: ["voucher", "thanks_token"],
  fund: ["project", "proposal"],
  pledge: ["project", "proposal"],

  // CRUD
  create: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note", "group", "shift", "booking"],
  update: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note", "group", "shift", "booking"],
  delete: ["post", "event", "listing", "project", "job", "task", "proposal", "badge", "document", "note"],
  transfer: ["thanks_token", "voucher", "listing", "product", "asset"],
  share: ["post", "event", "listing", "project", "document", "note"],
  view: ["post", "event", "listing", "project", "document", "note", "badge", "image", "video"],
  clone: ["document", "project", "listing"],
  merge: ["document", "project"],
  split: ["document", "project"],

  // Work
  work: ["job", "task", "shift", "project"],
  clock_in: ["shift", "job"],
  clock_out: ["shift", "job"],
  produce: ["product", "listing", "document"],
  consume: ["voucher", "thanks_token"],

  // Governance
  vote: ["proposal"],
  propose: ["proposal", "project"],
  approve: ["proposal", "task", "job"],
  reject: ["proposal", "task", "job"],

  // Membership — these target agents (groups, people), not resources
  join: [],
  manage: [],
  own: [],
  locate: ["place", "venue"],
  follow: [],
  belong: [],
  assign: ["job", "task", "shift"],
  invite: [],
  employ: [],
  contain: [],
  leave: [],

  // Lifecycle
  start: ["event", "project", "task", "job", "shift"],
  complete: ["task", "job", "shift", "project"],
  cancel: ["event", "booking", "listing", "job", "shift"],
  archive: ["post", "event", "listing", "project", "document"],
  publish: ["post", "event", "listing", "document"],

  // Social
  attend: ["event"],
  host: ["event"],
  schedule: ["event", "booking", "shift"],
  endorse: ["post", "listing", "badge"],
  mention: ["post"],
  comment: ["post", "event", "listing"],
  react: ["post", "event", "listing"],

  // Permissions
  grant: ["badge", "permission_policy"],
  revoke: ["badge", "permission_policy"],
  rent: ["listing", "asset", "venue"],
  use: ["voucher", "thanks_token", "asset"],
  request: ["listing", "job", "badge", "permission_policy"],
}

/** Verbs that target AGENTS (groups, people) instead of resources */
const AGENT_VERBS = new Set(["join", "leave", "manage", "own", "follow", "belong", "invite", "employ", "contain"])

/** Resource types that support quantity (stored in metadata.quantityAvailable) */
const QUANTIFIABLE_RESOURCE_TYPES = new Set(["voucher", "thanks_token", "product", "listing", "badge"])

/** Reverse mapping: resource type → applicable verbs. Derived from VERB_RESOURCE_TYPES. */
const RESOURCE_TYPE_VERBS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {}
  for (const [verb, types] of Object.entries(VERB_RESOURCE_TYPES)) {
    for (const t of types) {
      if (!map[t]) map[t] = []
      map[t].push(verb)
    }
  }
  return map
})()

/** Known determiner words for NLP extraction */
const KNOWN_DETERMINERS = new Set(["any", "my", "the", "that", "a", "all", "every", "each"])

/** Agent-like type keywords the NLP parser might produce */
const AGENT_TYPE_KEYWORDS = new Set(["person", "people", "user", "member", "group", "organization", "org", "team"])

// ─── NLP → Composer Mapping ──────────────────────────────────────────────────

/**
 * Parse a natural language sentence and map it to composer state.
 * Returns partial state for WHEN, THEN actions, and IF condition.
 */
function parseNlpToComposer(
  input: string,
  agents: DropdownOption[],
  resources: DropdownOption[]
): {
  when: QueryCondition
  thenActions: ThenAction[]
  ifCondition: QueryCondition
  hasIf: boolean
} {
  const result = parseNaturalLanguageV2(input)
  const when: QueryCondition = {}
  const thenActions: ThenAction[] = []
  const ifCondition: QueryCondition = {}
  let hasIf = false

  const lowerInput = input.toLowerCase()

  // Helper: find an agent by name match
  const findAgent = (name: string): DropdownOption | undefined => {
    const lower = name.toLowerCase()
    return agents.find((a) => a.name.toLowerCase() === lower)
  }

  // Helper: find a resource by name match
  const findResource = (name: string): DropdownOption | undefined => {
    const lower = name.toLowerCase()
    return resources.find((r) => r.name.toLowerCase() === lower)
  }

  // Helper: find a verb in the input near a position
  const findVerb = (text: string): string | undefined => {
    const words = text.toLowerCase().split(/\s+/)
    for (const word of words) {
      // Check direct match
      if (ALL_VERBS.includes(word)) return word
      // Check with 's' stripped (buys → buy)
      if (word.endsWith("s") && ALL_VERBS.includes(word.slice(0, -1))) return word.slice(0, -1)
      // Check common verb forms
      const verbMap: Record<string, string> = {
        buys: "buy", sells: "sell", trades: "trade", gifts: "gift", gives: "give",
        delivers: "transfer", deliver: "transfer", sends: "transfer", send: "transfer",
        assigns: "assign", creates: "create", updates: "update", joins: "join",
        follows: "follow", manages: "manage", approves: "approve", rejects: "reject",
        endorses: "endorse", shares: "share", produces: "produce", consumes: "consume",
        attends: "attend", hosts: "host", schedules: "schedule", earns: "earn",
        publishes: "publish", starts: "start", completes: "complete", cancels: "cancel",
      }
      if (verbMap[word]) return verbMap[word]
    }
    return undefined
  }

  // Helper: extract determiner from text before a noun
  const extractDeterminer = (text: string, nounName: string): string | undefined => {
    const idx = text.toLowerCase().indexOf(nounName.toLowerCase())
    if (idx < 0) return undefined
    const before = text.slice(0, idx).trim().split(/\s+/)
    const lastWord = before[before.length - 1]?.toLowerCase()
    if (lastWord && KNOWN_DETERMINERS.has(lastWord)) return lastWord === "every" || lastWord === "each" ? "any" : lastWord
    return undefined
  }

  // Split on "when" / "whenever" to extract trigger vs action
  const whenMatch = lowerInput.match(/^(?:when(?:ever)?|if)\s+(.+?)(?:,\s*(?:then\s+)?|(?:\s+then\s+))(.+)$/i)

  if (whenMatch) {
    const whenPart = whenMatch[1].trim()
    const thenPart = whenMatch[2].trim()

    // Parse WHEN part
    const whenVerb = findVerb(whenPart)
    if (whenVerb) when.verb = whenVerb

    // Try to find subject and object in the WHEN clause
    for (const entity of result.entities) {
      if (whenPart.toLowerCase().includes(entity.name.toLowerCase())) {
        const det = extractDeterminer(whenPart, entity.name)
        const isAgent = entity.targetTable === "agents" || AGENT_TYPE_KEYWORDS.has(entity.type)
        if (isAgent && !when.agentId) {
          const found = findAgent(entity.name)
          if (found) {
            when.agentId = found.id
            when.agentName = found.name
            when.agentType = found.type
          }
          when.agentDeterminer = det
        } else if (!isAgent && !when.resourceId) {
          const found = findResource(entity.name)
          if (found) {
            when.resourceId = found.id
            when.resourceName = found.name
            when.resourceType = found.type
          }
          when.resourceDeterminer = det
        }
      }
    }

    // If WHEN has "any person" pattern without a specific entity
    if (!when.agentId && whenPart.match(/\bany\s+(person|people|user|member)\b/i)) {
      when.agentDeterminer = "any"
    }
    if (!when.agentId && whenPart.match(/\bany\s+(group|org|organization|team)\b/i)) {
      when.agentDeterminer = "any"
    }

    // Parse THEN part — split on "and then" or "and" for chaining
    const thenParts = thenPart.split(/\s+and\s+then\s+|\s+and\s+(?=\w+\s+(?:the|my|a|that|any)\s+)/i)

    for (const part of thenParts) {
      const action: ThenAction = {}
      const verb = findVerb(part)
      if (verb) action.verb = verb

      // Try to find object and target in the action
      const toMatch = part.match(/\bto\s+(.+)$/i)
      if (toMatch) {
        const targetPart = toMatch[1].trim()
        const objectPart = part.replace(/\bto\s+.+$/i, "").trim()

        // Target (after "to")
        if (targetPart.match(/\bthat\s+(person|subject|user)\b/i)) {
          action.targetDeterminer = "that"
        } else {
          const targetDet = extractDeterminer(targetPart, targetPart.split(/\s+/).slice(-1)[0])
          if (targetDet) action.targetDeterminer = targetDet
          for (const entity of result.entities) {
            if (targetPart.toLowerCase().includes(entity.name.toLowerCase())) {
              const found = findAgent(entity.name)
              if (found) {
                action.targetId = found.id
                action.targetName = found.name
                action.targetType = found.type
              }
              break
            }
          }
        }

        // Object (before "to")
        for (const entity of result.entities) {
          if (objectPart.toLowerCase().includes(entity.name.toLowerCase())) {
            const found = findResource(entity.name)
            if (found) {
              action.objectId = found.id
              action.objectName = found.name
              action.objectType = found.type
            }
            action.objectDeterminer = extractDeterminer(objectPart, entity.name)
            break
          }
        }
      } else {
        // No "to" — just look for objects
        for (const entity of result.entities) {
          if (part.toLowerCase().includes(entity.name.toLowerCase())) {
            const found = findResource(entity.name)
            if (found) {
              action.objectId = found.id
              action.objectName = found.name
              action.objectType = found.type
            }
            action.objectDeterminer = extractDeterminer(part, entity.name)
            break
          }
        }
      }

      if (action.verb) {
        thenActions.push(action)
      }
    }
  } else {
    // No when/then structure — try to parse as a simple action
    const verb = findVerb(lowerInput)
    if (verb) {
      const action: ThenAction = { verb }
      thenActions.push(action)
    }
  }

  // Use V2 conditionals for IF conditions if present
  for (const cond of result.conditionals) {
    if (cond.determiner.toLowerCase() === "if" && !hasIf) {
      hasIf = true
      const condVerb = findVerb(cond.predicate)
      if (condVerb) ifCondition.verb = condVerb
    }
  }

  // Default to at least one empty action
  if (thenActions.length === 0) {
    thenActions.push({})
  }

  return { when, thenActions, ifCondition, hasIf }
}

/**
 * Generate a human-readable sentence summary from the composer state.
 */
function composerToSentence(
  when: QueryCondition,
  thenActions: ThenAction[],
  ifCondition: QueryCondition,
  showIf: boolean,
  ownerName: string
): string {
  const parts: string[] = []

  // WHEN
  const whenSubject = when.agentName ?? (when.agentDeterminer ? `${when.agentDeterminer} agent` : "")
  const whenVerb = when.verb?.replace("_", " ") ?? ""
  const whenObject = when.resourceName ?? (when.resourceDeterminer ? `${when.resourceDeterminer} resource` : "")
  if (whenSubject || whenVerb || whenObject) {
    parts.push(`When ${when.agentDeterminer ?? ""} ${whenSubject} ${whenVerb} ${when.resourceDeterminer ?? ""} ${whenObject}`.replace(/\s+/g, " ").trim())
  }

  // THEN
  const actionParts = thenActions
    .filter((a) => a.verb)
    .map((a) => {
      const verb = a.verb?.replace("_", " ") ?? ""
      const qty = a.delta && a.delta > 1 ? `${a.delta}x ` : ""
      const obj = a.objectName ? `${qty}${a.objectDeterminer ?? ""} ${a.objectName}`.trim() : ""
      const target = a.targetName
        ? `to ${a.targetDeterminer ?? ""} ${a.targetName}`.trim()
        : a.targetDeterminer === "that"
          ? "to that subject"
          : ""
      return `${verb} ${obj} ${target}`.trim()
    })

  if (actionParts.length > 0) {
    parts.push(`${ownerName || "I"} ${actionParts.join(", then ")}`)
  }

  // IF
  if (showIf && ifCondition.verb) {
    const ifSubject = ifCondition.agentName ?? ""
    const ifVerb = ifCondition.verb?.replace("_", " ") ?? ""
    const ifObject = ifCondition.resourceName ?? ""
    parts.push(`if ${ifSubject} ${ifVerb} ${ifObject}`.trim())
  }

  return parts.join(", ").replace(/\s+/g, " ").trim()
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QueryCondition {
  agentDeterminer?: string
  agentId?: string
  agentName?: string
  agentType?: string
  verb?: string
  resourceDeterminer?: string
  resourceId?: string
  resourceName?: string
  resourceType?: string
  startDate?: string
  endDate?: string
}

/** THEN action row with 4 slots: [I] [do what] [det+what] to [det+who] */
export interface ThenAction {
  verb?: string
  objectDeterminer?: string
  objectId?: string
  objectName?: string
  objectType?: string
  /** Quantity for quantifiable resources (vouchers, tokens, products). Stored as contract delta. */
  delta?: number
  targetDeterminer?: string
  targetId?: string
  targetName?: string
  targetType?: string
}

export interface ComposerQuery {
  when: QueryCondition
  then: ThenAction[]
  if?: QueryCondition
}

export interface LedgerFilter {
  subjectId?: string
  verb?: string
  objectId?: string
  startDate?: string
  endDate?: string
}

interface QueryComposerProps {
  onApply: (filter: LedgerFilter) => void
  onClear: () => void
}

// ─── Searchable Dropdown ────────────────────────────────────────────────────

interface DropdownOption {
  id: string
  name: string
  type: string
  /** Total quantity available (from metadata.quantityAvailable) */
  quantityAvailable?: number
  /** Remaining quantity (from metadata.quantityRemaining) */
  quantityRemaining?: number
}

function SearchableDropdown({
  options,
  value,
  onSelect,
  onClear,
  placeholder,
  label,
}: {
  options: DropdownOption[]
  value?: { id: string; name: string; type: string }
  onSelect: (opt: DropdownOption) => void
  onClear: () => void
  placeholder: string
  label: string
}) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)

  const filtered = search
    ? options.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : options

  const displayFiltered = filtered.slice(0, 50)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-[100px] max-w-[160px] h-8 px-2.5 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors text-left truncate"
          title={label}
        >
          {value ? (
            <span className="flex items-center gap-1.5 truncate">
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: TYPE_COLORS[value.type] ?? "#6b7280" }}
              />
              <span className="truncate">{value.name}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClear()
                }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={`Search ${label.toLowerCase()}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {displayFiltered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No results</p>
          ) : (
            displayFiltered.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent transition-colors text-left"
                onClick={() => {
                  onSelect(opt)
                  setSearch("")
                  setOpen(false)
                }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: TYPE_COLORS[opt.type] ?? "#6b7280" }}
                />
                <span className="truncate">{opt.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground capitalize shrink-0">
                  {opt.type}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Verb Dropdown ──────────────────────────────────────────────────────────

function VerbDropdown({
  value,
  onSelect,
  onClear,
  allowedVerbs,
}: {
  value?: string
  onSelect: (verb: string) => void
  onClear: () => void
  /** When set, only these verbs are shown (filtered by selected resource type) */
  allowedVerbs?: Set<string>
}) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)

  const filteredGroups = useMemo(() => {
    let groups = VERB_GROUPS

    // Filter by allowed verbs (from resource type selection)
    if (allowedVerbs) {
      groups = groups.map((g) => ({
        ...g,
        verbs: g.verbs.filter((v) => allowedVerbs.has(v)),
      })).filter((g) => g.verbs.length > 0)
    }

    // Filter by search text
    if (search) {
      groups = groups.map((g) => ({
        ...g,
        verbs: g.verbs.filter((v) => v.includes(search.toLowerCase())),
      })).filter((g) => g.verbs.length > 0)
    }

    return groups
  }, [allowedVerbs, search])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-[90px] max-w-[130px] h-8 px-2.5 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors text-left truncate"
        >
          {value ? (
            <span className="flex items-center gap-1.5 truncate">
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                {value.replace("_", " ")}
              </Badge>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClear()
                }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">does what</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search verbs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-semibold text-muted-foreground px-3 pt-2 pb-0.5 uppercase tracking-wider">
                {group.label}
              </p>
              {group.verbs.map((verb) => (
                <button
                  key={verb}
                  type="button"
                  className={`w-full px-3 py-1 text-xs hover:bg-accent transition-colors text-left ${
                    value === verb ? "bg-accent font-medium" : ""
                  }`}
                  onClick={() => {
                    onSelect(verb)
                    setSearch("")
                    setOpen(false)
                  }}
                >
                  {verb.replace("_", " ")}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Determiner Dropdown ─────────────────────────────────────────────────────

function DeterminerDropdown({
  value,
  options,
  onSelect,
}: {
  value?: string
  options: readonly string[]
  onSelect: (det: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center min-w-[40px] h-8 px-1.5 rounded-md border border-dashed border-border/60 bg-background text-[11px] italic text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          {value || "any"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-24 p-1" align="start">
        {options.map((det) => (
          <button
            key={det}
            type="button"
            className={`w-full px-2 py-1 text-xs text-left rounded hover:bg-accent transition-colors ${
              value === det ? "bg-accent font-medium" : ""
            }`}
            onClick={() => {
              onSelect(det)
              setOpen(false)
            }}
          >
            {det}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ─── WHEN Condition Row ──────────────────────────────────────────────────────

function WhenConditionRow({
  label,
  condition,
  agents,
  resources,
  onChange,
}: {
  label: string
  condition: QueryCondition
  agents: DropdownOption[]
  resources: DropdownOption[]
  onChange: (c: QueryCondition) => void
}) {
  const agentOptions: DropdownOption[] = [...WILDCARD_AGENTS, ...agents]

  // Contextual filtering: verb → resource types, resource type → verbs
  const isAgentVerb = condition.verb ? AGENT_VERBS.has(condition.verb) : false
  const allowedResourceTypes = useMemo(() => {
    if (!condition.verb) return undefined
    const types = VERB_RESOURCE_TYPES[condition.verb]
    return types && types.length > 0 ? new Set(types) : undefined
  }, [condition.verb])

  const allowedVerbs = useMemo(() => {
    if (!condition.resourceType) return undefined
    const verbs = RESOURCE_TYPE_VERBS[condition.resourceType]
    return verbs ? new Set(verbs) : undefined
  }, [condition.resourceType])

  // Filter resources by verb selection; if agent verb, show agents in the "what" slot
  const filteredResources = useMemo(() => {
    if (isAgentVerb) return [] // agent verbs show agents, not resources
    if (!allowedResourceTypes) return resources
    return resources.filter((r) => allowedResourceTypes.has(r.type))
  }, [resources, allowedResourceTypes, isAgentVerb])

  // For agent verbs, the "with what" slot shows agents instead
  const objectOptions = isAgentVerb ? agentOptions : filteredResources

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Row label */}
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground w-10 shrink-0">
        {label}
      </span>

      {/* [det] Who */}
      <DeterminerDropdown
        value={condition.agentDeterminer}
        options={AGENT_DETERMINERS}
        onSelect={(det) => onChange({ ...condition, agentDeterminer: det })}
      />
      <SearchableDropdown
        options={agentOptions}
        value={
          condition.agentId
            ? { id: condition.agentId, name: condition.agentName ?? "Unknown", type: condition.agentType ?? "person" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...condition, agentId: opt.id, agentName: opt.name, agentType: opt.type })
        }
        onClear={() =>
          onChange({ ...condition, agentId: undefined, agentName: undefined, agentType: undefined })
        }
        placeholder="who"
        label="Agent"
      />

      {/* Does what — filtered by selected resource type */}
      <VerbDropdown
        value={condition.verb}
        onSelect={(verb) => onChange({ ...condition, verb })}
        onClear={() => onChange({ ...condition, verb: undefined })}
        allowedVerbs={allowedVerbs}
      />

      {/* [det] With what — filtered by selected verb */}
      <DeterminerDropdown
        value={condition.resourceDeterminer}
        options={isAgentVerb ? AGENT_DETERMINERS : RESOURCE_DETERMINERS}
        onSelect={(det) => onChange({ ...condition, resourceDeterminer: det })}
      />
      <SearchableDropdown
        options={objectOptions}
        value={
          condition.resourceId
            ? { id: condition.resourceId, name: condition.resourceName ?? "Unknown", type: condition.resourceType ?? "resource" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...condition, resourceId: opt.id, resourceName: opt.name, resourceType: opt.type })
        }
        onClear={() =>
          onChange({ ...condition, resourceId: undefined, resourceName: undefined, resourceType: undefined })
        }
        placeholder={isAgentVerb ? "whom" : "what"}
        label={isAgentVerb ? "Agent" : "Resource"}
      />

      {/* Date range (only for WHEN) */}
      {label === "when" && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={condition.startDate ?? ""}
            onChange={(e) => onChange({ ...condition, startDate: e.target.value || undefined })}
            className="h-8 w-[110px] text-xs"
            placeholder="from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={condition.endDate ?? ""}
            onChange={(e) => onChange({ ...condition, endDate: e.target.value || undefined })}
            className="h-8 w-[110px] text-xs"
            placeholder="to"
          />
        </div>
      )}
    </div>
  )
}

// ─── THEN Action Row ─────────────────────────────────────────────────────────

function ThenActionRow({
  label,
  ownerName,
  action,
  agents,
  resources,
  onChange,
  onRemove,
  canRemove,
}: {
  label: string
  ownerName: string
  action: ThenAction
  agents: DropdownOption[]
  resources: DropdownOption[]
  onChange: (a: ThenAction) => void
  onRemove?: () => void
  canRemove: boolean
}) {
  const agentOptions: DropdownOption[] = [
    { id: "__trigger_subject__", name: "Trigger Subject", type: "wildcard" },
    ...WILDCARD_AGENTS,
    ...agents,
  ]

  // Contextual filtering for THEN rows
  const isAgentVerb = action.verb ? AGENT_VERBS.has(action.verb) : false
  const allowedResourceTypes = useMemo(() => {
    if (!action.verb) return undefined
    const types = VERB_RESOURCE_TYPES[action.verb]
    return types && types.length > 0 ? new Set(types) : undefined
  }, [action.verb])

  const allowedVerbs = useMemo(() => {
    if (!action.objectType) return undefined
    const verbs = RESOURCE_TYPE_VERBS[action.objectType]
    return verbs ? new Set(verbs) : undefined
  }, [action.objectType])

  const filteredResources = useMemo(() => {
    if (isAgentVerb) return []
    if (!allowedResourceTypes) return resources
    return resources.filter((r) => allowedResourceTypes.has(r.type))
  }, [resources, allowedResourceTypes, isAgentVerb])

  const objectOptions = isAgentVerb ? agentOptions : filteredResources

  // Look up the selected resource to check if it's quantifiable
  const selectedResource = action.objectId
    ? resources.find((r) => r.id === action.objectId)
    : undefined
  const isQuantifiable = !!(
    action.objectType && QUANTIFIABLE_RESOURCE_TYPES.has(action.objectType)
  ) || !!(
    action.objectDeterminer && (action.objectDeterminer === "all" || /^\d+$/.test(action.objectDeterminer))
  )
  const maxQuantity = selectedResource?.quantityRemaining
    ?? selectedResource?.quantityAvailable
    ?? undefined

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Row label */}
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground w-10 shrink-0">
        {label}
      </span>

      {/* I (auto-filled, read-only) */}
      <span className="flex items-center gap-1.5 min-w-[60px] h-8 px-2.5 rounded-md border border-border bg-muted/50 text-sm truncate">
        <span className="inline-block h-2 w-2 rounded-full shrink-0 bg-blue-500" />
        <span className="truncate text-xs font-medium">{ownerName || "I"}</span>
      </span>

      {/* Do what — filtered by selected object type */}
      <VerbDropdown
        value={action.verb}
        onSelect={(verb) => onChange({ ...action, verb })}
        onClear={() => onChange({ ...action, verb: undefined })}
        allowedVerbs={allowedVerbs}
      />

      {/* [det] With what — filtered by selected verb */}
      <DeterminerDropdown
        value={action.objectDeterminer}
        options={isAgentVerb ? AGENT_DETERMINERS : RESOURCE_DETERMINERS}
        onSelect={(det) => onChange({ ...action, objectDeterminer: det })}
      />

      {/* Quantity input — shown for quantifiable resource types */}
      {isQuantifiable && (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={maxQuantity}
            value={action.delta ?? 1}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              onChange({ ...action, delta: Number.isNaN(val) ? undefined : Math.max(1, val) })
            }}
            className="h-8 w-[56px] text-xs text-center px-1"
            title="Quantity"
          />
          {maxQuantity !== undefined && (
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              of {maxQuantity}
            </span>
          )}
        </div>
      )}

      <SearchableDropdown
        options={objectOptions}
        value={
          action.objectId
            ? { id: action.objectId, name: action.objectName ?? "Unknown", type: action.objectType ?? "resource" }
            : undefined
        }
        onSelect={(opt) => {
          const res = resources.find((r) => r.id === opt.id)
          const hasQty = QUANTIFIABLE_RESOURCE_TYPES.has(opt.type)
          onChange({
            ...action,
            objectId: opt.id,
            objectName: opt.name,
            objectType: opt.type,
            // Auto-set delta to 1 for quantifiable resources if not already set
            ...(hasQty && !action.delta ? { delta: 1 } : {}),
            // Clear delta if non-quantifiable
            ...(!hasQty ? { delta: undefined } : {}),
          })
        }}
        onClear={() =>
          onChange({ ...action, objectId: undefined, objectName: undefined, objectType: undefined, delta: undefined })
        }
        placeholder={isAgentVerb ? "whom" : "what"}
        label={isAgentVerb ? "Agent" : "Resource"}
      />

      {/* to [det] [who] */}
      <span className="text-xs text-muted-foreground">to</span>
      <DeterminerDropdown
        value={action.targetDeterminer}
        options={AGENT_DETERMINERS}
        onSelect={(det) => onChange({ ...action, targetDeterminer: det })}
      />
      <SearchableDropdown
        options={agentOptions}
        value={
          action.targetId
            ? { id: action.targetId, name: action.targetName ?? "Unknown", type: action.targetType ?? "person" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...action, targetId: opt.id, targetName: opt.name, targetType: opt.type })
        }
        onClear={() =>
          onChange({ ...action, targetId: undefined, targetName: undefined, targetType: undefined })
        }
        placeholder="who"
        label="Target"
      />

      {/* Remove button */}
      {canRemove && onRemove && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="h-8 w-8 p-0 shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

// ─── Mini Canvas ─────────────────────────────────────────────────────────────

interface MiniNode {
  id: string
  label: string
  type: string
  x: number
  y: number
  determiner?: string
}

interface MiniEdge {
  from: string
  to: string
  label: string
  dashed?: boolean
}

function MiniCanvas({
  whenCondition,
  thenActions,
  ifCondition,
  showIf,
  ownerName,
}: {
  whenCondition: QueryCondition
  thenActions: ThenAction[]
  ifCondition: QueryCondition
  showIf: boolean
  ownerName: string
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragState, setDragState] = useState<{ id: string; startX: number; startY: number } | null>(null)
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({})

  // Build nodes and edges from the current composer state
  const { nodes, edges } = useMemo(() => {
    const ns: MiniNode[] = []
    const es: MiniEdge[] = []
    const seenIds = new Set<string>()

    const addNode = (id: string, label: string, type: string, x: number, y: number, determiner?: string) => {
      if (seenIds.has(id)) return
      seenIds.add(id)
      ns.push({ id, label, type, x, y, determiner })
    }

    // WHEN subject
    const whenSubjectId = whenCondition.agentId ?? "when-subject"
    const whenSubjectLabel = whenCondition.agentName ?? (whenCondition.agentDeterminer === "any" ? "Anyone" : "?")
    const whenSubjectType = whenCondition.agentType ?? "wildcard"
    if (whenCondition.agentId || whenCondition.agentDeterminer) {
      addNode(whenSubjectId, whenSubjectLabel, whenSubjectType, 60, 60, whenCondition.agentDeterminer)
    }

    // WHEN object
    const whenObjectId = whenCondition.resourceId ?? "when-object"
    const whenObjectLabel = whenCondition.resourceName ?? "?"
    const whenObjectType = whenCondition.resourceType ?? "wildcard"
    if (whenCondition.resourceId || whenCondition.resourceDeterminer) {
      addNode(whenObjectId, whenObjectLabel, whenObjectType, 200, 60, whenCondition.resourceDeterminer)
    }

    // WHEN verb edge
    if (whenCondition.verb && seenIds.has(whenSubjectId) && seenIds.has(whenObjectId)) {
      es.push({ from: whenSubjectId, to: whenObjectId, label: whenCondition.verb })
    }

    // "I" node (rule creator) for THEN actions
    const iNodeId = "self-owner"
    if (thenActions.some((a) => a.verb)) {
      addNode(iNodeId, ownerName || "I", "self", 360, 60)

      // Dashed "then" edge from WHEN to THEN
      if (seenIds.has(whenSubjectId) || seenIds.has(whenObjectId)) {
        const fromId = seenIds.has(whenObjectId) ? whenObjectId : whenSubjectId
        if (seenIds.has(fromId)) {
          es.push({ from: fromId, to: iNodeId, label: "then", dashed: true })
        }
      }
    }

    // THEN action nodes
    thenActions.forEach((action, i) => {
      if (!action.verb) return
      const yOffset = 60 + i * 55

      // Action object
      const objId = action.objectId ?? `then-obj-${i}`
      const objLabel = action.objectName ?? "?"
      const objType = action.objectType ?? "wildcard"
      if (action.objectId || action.objectDeterminer) {
        addNode(objId, objLabel, objType, 480, yOffset, action.objectDeterminer)
        es.push({ from: iNodeId, to: objId, label: action.verb })
      } else {
        // Even without object, show the verb from I
        const phantomId = `then-phantom-${i}`
        addNode(phantomId, action.verb, "wildcard", 480, yOffset)
        es.push({ from: iNodeId, to: phantomId, label: action.verb })
      }

      // Action target
      if (action.targetId || action.targetDeterminer) {
        const targetId = action.targetId ?? `then-target-${i}`
        const targetLabel = action.targetName ?? (action.targetDeterminer === "that" ? "Trigger" : "?")
        const targetType = action.targetType ?? "person"
        const sourceId = action.objectId || action.objectDeterminer ? objId : `then-phantom-${i}`
        addNode(targetId, targetLabel, targetType, 600, yOffset, action.targetDeterminer)
        if (seenIds.has(sourceId)) {
          es.push({ from: sourceId, to: targetId, label: "to" })
        }
      }
    })

    // IF condition nodes
    if (showIf && (ifCondition.agentId || ifCondition.verb || ifCondition.resourceId)) {
      const ifSubjectId = ifCondition.agentId ?? "if-subject"
      const ifSubjectLabel = ifCondition.agentName ?? "?"
      const ifSubjectType = ifCondition.agentType ?? "wildcard"
      if (ifCondition.agentId || ifCondition.agentDeterminer) {
        addNode(ifSubjectId, ifSubjectLabel, ifSubjectType, 120, 160, ifCondition.agentDeterminer)
      }

      const ifObjectId = ifCondition.resourceId ?? "if-object"
      const ifObjectLabel = ifCondition.resourceName ?? "?"
      const ifObjectType = ifCondition.resourceType ?? "wildcard"
      if (ifCondition.resourceId || ifCondition.resourceDeterminer) {
        addNode(ifObjectId, ifObjectLabel, ifObjectType, 280, 160, ifCondition.resourceDeterminer)
      }

      if (ifCondition.verb && seenIds.has(ifSubjectId) && seenIds.has(ifObjectId)) {
        es.push({ from: ifSubjectId, to: ifObjectId, label: ifCondition.verb })
      }
    }

    return { nodes: ns, edges: es }
  }, [whenCondition, thenActions, ifCondition, showIf, ownerName])

  // Merge computed positions with drag overrides
  const getPos = (node: MiniNode) => {
    if (nodePositions[node.id]) return nodePositions[node.id]
    return { x: node.x, y: node.y }
  }

  if (nodes.length === 0) return null

  const handleMouseDown = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()?.inverse()
    if (!ctm) return
    const svgPt = pt.matrixTransform(ctm)
    setDragState({ id, startX: svgPt.x, startY: svgPt.y })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragState) return
    const svg = svgRef.current
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()?.inverse()
    if (!ctm) return
    const svgPt = pt.matrixTransform(ctm)
    setNodePositions((prev) => ({
      ...prev,
      [dragState.id]: { x: svgPt.x, y: svgPt.y },
    }))
  }

  const handleMouseUp = () => {
    setDragState(null)
  }

  const canvasHeight = Math.max(180, 80 + thenActions.length * 55 + (showIf ? 80 : 0))

  return (
    <svg
      ref={svgRef}
      className="w-full border border-border/50 rounded-md bg-card/50"
      viewBox={`0 0 680 ${canvasHeight}`}
      style={{ height: `${Math.min(canvasHeight, 250)}px` }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <defs>
        <marker
          id="mini-arrow"
          viewBox="0 0 10 6"
          refX="10"
          refY="3"
          markerWidth="8"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,3 L0,6" fill="#94a3b8" />
        </marker>
        <marker
          id="mini-arrow-dashed"
          viewBox="0 0 10 6"
          refX="10"
          refY="3"
          markerWidth="8"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,3 L0,6" fill="#f59e0b" />
        </marker>
      </defs>

      {/* Edges */}
      {edges.map((edge, i) => {
        const fromNode = nodes.find((n) => n.id === edge.from)
        const toNode = nodes.find((n) => n.id === edge.to)
        if (!fromNode || !toNode) return null
        const fromPos = getPos(fromNode)
        const toPos = getPos(toNode)
        const r = MINI_NODE_RADII[toNode.type] ?? MINI_NODE_RADII.default
        // Shorten line to stop at node boundary
        const dx = toPos.x - fromPos.x
        const dy = toPos.y - fromPos.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const endX = toPos.x - (dx / dist) * (r + 4)
        const endY = toPos.y - (dy / dist) * (r + 4)
        const midX = (fromPos.x + toPos.x) / 2
        const midY = (fromPos.y + toPos.y) / 2

        return (
          <g key={`edge-${i}`}>
            <line
              x1={fromPos.x}
              y1={fromPos.y}
              x2={endX}
              y2={endY}
              stroke={edge.dashed ? "#f59e0b" : "#94a3b8"}
              strokeWidth={1.5}
              strokeDasharray={edge.dashed ? "4 3" : undefined}
              markerEnd={edge.dashed ? "url(#mini-arrow-dashed)" : "url(#mini-arrow)"}
              opacity={0.7}
            />
            <text
              x={midX}
              y={midY - 6}
              textAnchor="middle"
              fontSize="9"
              fill="#94a3b8"
              fontWeight="500"
            >
              {edge.label.replace("_", " ")}
            </text>
          </g>
        )
      })}

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = getPos(node)
        const r = MINI_NODE_RADII[node.type] ?? MINI_NODE_RADII.default
        const color = TYPE_COLORS[node.type] ?? "#6b7280"
        const truncated = node.label.length > 14 ? node.label.slice(0, 12) + ".." : node.label

        return (
          <g
            key={node.id}
            transform={`translate(${pos.x},${pos.y})`}
            style={{ cursor: "grab" }}
            onMouseDown={(e) => handleMouseDown(node.id, e)}
          >
            {/* Determiner label */}
            {node.determiner && (
              <text
                y={-r - 4}
                textAnchor="middle"
                fontSize="8"
                fill="#94a3b8"
                fontStyle="italic"
              >
                {node.determiner}
              </text>
            )}

            {/* Node shape */}
            {node.type === "organization" || node.type === "group" ? (
              <rect
                x={-r}
                y={-r * 0.8}
                width={r * 2}
                height={r * 1.6}
                rx={4}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            ) : node.type === "event" ? (
              <polygon
                points={`0,${-r} ${r},0 0,${r} ${-r},0`}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            ) : (
              <circle
                r={r}
                fill={color}
                fillOpacity={0.85}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
            )}

            {/* Icon (simplified white lineal) */}
            <g fill="none" stroke="white" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
              {(node.type === "person" || node.type === "self") && (
                <>
                  <circle cx={0} cy={-2} r={3} />
                  <path d="M-5 6 C-5 2 5 2 5 6" />
                </>
              )}
              {(node.type === "organization" || node.type === "group") && (
                <>
                  <circle cx={-2} cy={-2} r={2.5} />
                  <circle cx={3} cy={-2} r={2.5} />
                  <path d="M-6 5 C-6 2 7 2 7 5" />
                </>
              )}
              {node.type === "event" && (
                <>
                  <rect x={-4} y={-2} width={8} height={7} rx={1} />
                  <line x1={-2} y1={-4} x2={-2} y2={-1} />
                  <line x1={2} y1={-4} x2={2} y2={-1} />
                </>
              )}
            </g>

            {/* Label */}
            <text
              y={r + 10}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              fontWeight="400"
              pointerEvents="none"
            >
              {truncated}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── Agreements List ─────────────────────────────────────────────────────────

function AgreementsList({ rules, onRefresh }: { rules: ContractRuleRow[]; onRefresh: () => void }) {
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(false)

  if (rules.length === 0) return null

  const handleToggle = async (id: string, enabled: boolean) => {
    const result = await toggleContractRule(id, enabled)
    if (result.success) {
      onRefresh()
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    }
  }

  const handleDelete = async (id: string) => {
    const result = await deleteContractRule(id)
    if (result.success) {
      onRefresh()
      toast({ title: "Agreement deleted" })
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    }
  }

  const summarizeActions = (actions: ContractAction[]) => {
    return actions
      .map((a) => {
        const verb = a.verb?.replace("_", " ") ?? "?"
        const obj = a.objectId ? "..." : ""
        const target = a.targetDeterminer === "that" ? "trigger subject" : (a.targetId ? "..." : "")
        return `${verb}${obj}${target ? ` to ${target}` : ""}`
      })
      .join(", then ")
  }

  return (
    <div className="border-t pt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors py-1 w-full"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <FileText className="h-3.5 w-3.5" />
        My Agreements ({rules.length})
      </button>

      {expanded && (
        <div className="space-y-1.5 mt-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 p-2 rounded-md border bg-background text-xs"
            >
              <Switch
                checked={rule.enabled}
                onCheckedChange={(val) => handleToggle(rule.id, val)}
                className="scale-75"
              />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{rule.name}</p>
                <p className="text-muted-foreground truncate">
                  When {rule.triggerSubjectDeterminer ?? "any"} {rule.triggerVerb ?? "*"}{" "}
                  {rule.triggerObjectDeterminer ?? ""} → I {summarizeActions(rule.actions)}
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {rule.fireCount}{rule.maxFires !== null ? `/${rule.maxFires}` : ""}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(rule.id)}
                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QueryComposer({ onApply, onClear }: QueryComposerProps) {
  const { toast } = useToast()
  const [whenCondition, setWhenCondition] = useState<QueryCondition>({})
  const [thenActions, setThenActions] = useState<ThenAction[]>([{}])
  const [ifCondition, setIfCondition] = useState<QueryCondition>({})
  const [showIf, setShowIf] = useState(false)

  const [agents, setAgents] = useState<DropdownOption[]>([])
  const [resources, setResources] = useState<DropdownOption[]>([])
  const [loaded, setLoaded] = useState(false)

  // NLP input state
  const [nlpInput, setNlpInput] = useState("")

  // Agreement state
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState("")
  const [saving, setSaving] = useState(false)
  const [myRules, setMyRules] = useState<ContractRuleRow[]>([])
  const [ownerName, setOwnerName] = useState("")

  // Fetch agents, resources, and rules on mount
  useEffect(() => {
    if (loaded) return
    let cancelled = false

    async function load() {
      const [agentRows, resourceRows] = await Promise.all([
        fetchAgentsForComposer(),
        fetchResourcesForComposer(),
      ])

      if (cancelled) return

      setAgents(agentRows.map((a) => ({ id: a.id, name: a.name, type: a.type })))
      setResources(resourceRows.map((r) => ({
        id: r.id,
        name: r.title,
        type: r.type,
        quantityAvailable: r.quantityAvailable,
        quantityRemaining: r.quantityRemaining,
      })))
      setLoaded(true)

      // Load rules
      try {
        const rules = await listMyContractRules()
        if (!cancelled) setMyRules(rules)
      } catch {
        // Not authenticated or no rules
      }
    }

    load()
    return () => { cancelled = true }
  }, [loaded])

  const refreshRules = useCallback(async () => {
    try {
      const rules = await listMyContractRules()
      setMyRules(rules)
    } catch {
      // ignore
    }
  }, [])

  // NLP parse handler
  const handleNlpParse = useCallback(() => {
    if (!nlpInput.trim()) return
    const parsed = parseNlpToComposer(nlpInput.trim(), agents, resources)
    setWhenCondition(parsed.when)
    setThenActions(parsed.thenActions.length > 0 ? parsed.thenActions : [{}])
    if (parsed.hasIf) {
      setIfCondition(parsed.ifCondition)
      setShowIf(true)
    }
  }, [nlpInput, agents, resources])

  // Generate sentence summary from current state
  const sentenceSummary = useMemo(
    () => composerToSentence(whenCondition, thenActions, ifCondition, showIf, ownerName || "I"),
    [whenCondition, thenActions, ifCondition, showIf, ownerName]
  )

  // Update THEN actions
  const updateThenAction = useCallback((index: number, action: ThenAction) => {
    setThenActions((prev) => {
      const next = [...prev]
      next[index] = action
      return next
    })
  }, [])

  const addThenAction = useCallback(() => {
    setThenActions((prev) => [...prev, {}])
  }, [])

  const removeThenAction = useCallback((index: number) => {
    setThenActions((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleApply = useCallback(() => {
    const filter: LedgerFilter = {}

    const resolveAgent = (cond: QueryCondition) => {
      if (!cond.agentId || cond.agentId.startsWith("__")) return undefined
      return cond.agentId
    }

    filter.subjectId = resolveAgent(whenCondition)
    filter.verb = whenCondition.verb
    filter.objectId = whenCondition.resourceId
    filter.startDate = whenCondition.startDate
    filter.endDate = whenCondition.endDate

    onApply(filter)
  }, [whenCondition, onApply])

  const handleClear = useCallback(() => {
    setWhenCondition({})
    setThenActions([{}])
    setIfCondition({})
    setShowIf(false)
    onClear()
  }, [onClear])

  const handleSaveAgreement = useCallback(async () => {
    if (!saveName.trim()) return
    setSaving(true)

    // Build actions array from THEN rows
    const contractActions: ContractAction[] = thenActions
      .filter((a) => a.verb)
      .map((a) => ({
        verb: a.verb!,
        objectDeterminer: a.objectDeterminer,
        objectId: a.objectId && !a.objectId.startsWith("__") ? a.objectId : undefined,
        targetDeterminer: a.targetDeterminer,
        targetId: a.targetId === "__trigger_subject__" ? undefined : (a.targetId && !a.targetId.startsWith("__") ? a.targetId : undefined),
        delta: a.delta ?? 0,
      }))

    if (contractActions.length === 0) {
      toast({ title: "Error", description: "At least one THEN action with a verb is required", variant: "destructive" })
      setSaving(false)
      return
    }

    const resolveId = (id?: string) => {
      if (!id || id.startsWith("__")) return undefined
      return id
    }

    const result = await createContractRule({
      name: saveName.trim(),
      triggerSubjectDeterminer: whenCondition.agentDeterminer,
      triggerSubjectId: resolveId(whenCondition.agentId),
      triggerVerb: whenCondition.verb,
      triggerObjectDeterminer: whenCondition.resourceDeterminer,
      triggerObjectId: resolveId(whenCondition.resourceId),
      actions: contractActions,
      conditionSubjectDeterminer: showIf ? ifCondition.agentDeterminer : undefined,
      conditionSubjectId: showIf ? resolveId(ifCondition.agentId) : undefined,
      conditionVerb: showIf ? ifCondition.verb : undefined,
      conditionObjectDeterminer: showIf ? ifCondition.resourceDeterminer : undefined,
      conditionObjectId: showIf ? resolveId(ifCondition.resourceId) : undefined,
    })

    setSaving(false)
    setSaveDialogOpen(false)
    setSaveName("")

    if ("error" in result) {
      toast({ title: "Error", description: result.error, variant: "destructive" })
    } else {
      toast({ title: "Agreement saved", description: `"${saveName.trim()}" is now active` })
      refreshRules()
    }
  }, [saveName, thenActions, whenCondition, ifCondition, showIf, toast, refreshRules])

  const hasAnyFilter =
    whenCondition.agentId ||
    whenCondition.verb ||
    whenCondition.resourceId ||
    thenActions.some((a) => a.verb)

  const hasAnyThenVerb = thenActions.some((a) => a.verb)

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Query Composer
        </h3>
        <div className="flex items-center gap-1.5">
          {hasAnyThenVerb && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveDialogOpen(true)}
              className="h-7 text-xs gap-1 px-2"
            >
              <Save className="h-3 w-3" />
              Save as Agreement
            </Button>
          )}
          {hasAnyFilter && (
            <Button variant="ghost" size="sm" onClick={handleClear} className="h-7 text-xs gap-1 px-2">
              <Trash2 className="h-3 w-3" />
              Clear
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleApply}
            disabled={!hasAnyFilter}
            className="h-7 text-xs gap-1 px-3"
          >
            <Filter className="h-3 w-3" />
            Apply
          </Button>
        </div>
      </div>

      {/* NLP input bar */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Sparkles className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Describe your agreement in plain English..."
            value={nlpInput}
            onChange={(e) => setNlpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleNlpParse()
              }
            }}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleNlpParse}
          disabled={!nlpInput.trim()}
          className="h-8 text-xs px-2.5 gap-1"
        >
          <Sparkles className="h-3 w-3" />
          Parse
        </Button>
      </div>

      {/* Sentence summary */}
      {sentenceSummary && (
        <p className="text-xs text-muted-foreground italic px-1 py-0.5 border-l-2 border-border/50 ml-1">
          {sentenceSummary}
        </p>
      )}

      {/* WHEN row */}
      <WhenConditionRow
        label="when"
        condition={whenCondition}
        agents={agents}
        resources={resources}
        onChange={setWhenCondition}
      />

      {/* THEN rows (chainable) */}
      {thenActions.map((action, i) => (
        <ThenActionRow
          key={i}
          label={i === 0 ? "then" : "and"}
          ownerName={ownerName || "I"}
          action={action}
          agents={agents}
          resources={resources}
          onChange={(a) => updateThenAction(i, a)}
          onRemove={() => removeThenAction(i)}
          canRemove={thenActions.length > 1}
        />
      ))}

      {/* + Add Action */}
      <button
        type="button"
        onClick={addThenAction}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5 ml-10"
      >
        <Plus className="h-3 w-3" />
        Add Action
      </button>

      {/* IF row (optional) */}
      {showIf ? (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <WhenConditionRow
              label="if"
              condition={ifCondition}
              agents={agents}
              resources={resources}
              onChange={setIfCondition}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowIf(false)
              setIfCondition({})
            }}
            className="h-8 w-8 p-0 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowIf(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Condition
        </button>
      )}

      {/* Mini Canvas */}
      <MiniCanvas
        whenCondition={whenCondition}
        thenActions={thenActions}
        ifCondition={ifCondition}
        showIf={showIf}
        ownerName={ownerName || "I"}
      />

      {/* My Agreements */}
      <AgreementsList rules={myRules} onRefresh={refreshRules} />

      {/* Save Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Save as Agreement</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium">Agreement Name</label>
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g., Auto-deliver seedlings"
              className="mt-1.5"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveName.trim()) {
                  handleSaveAgreement()
                }
              }}
            />
            <p className="text-xs text-muted-foreground mt-2">
              This agreement will automatically execute the THEN actions whenever the WHEN trigger fires.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAgreement}
              disabled={!saveName.trim() || saving}
            >
              {saving ? "Saving..." : "Save Agreement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
