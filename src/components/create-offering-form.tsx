"use client"

/**
 * CreateOfferingForm - Full form for composing a new offering from the user's
 * existing resources. Includes items picker, per-item terms/pricing, audience
 * targeting by agent type with instance search, visibility scoping, and
 * optional feed posting.
 *
 * Used on the /create?tab=offering page.
 */

import type React from "react"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import {
  X,
  Package,
  Wrench,
  Ticket,
  MapPin,
  Users,
  Building2,
  Loader2,
  DollarSign,
  Clock,
  Award,
  Zap,
  Send,
  Tag,
  Gift,
  Target,
  Database,
  Calendar,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { SearchableSelect } from "@/components/searchable-select"
import { ImageUpload } from "@/components/image-upload"
import { BookingWeekScheduler } from "@/components/booking-week-scheduler"

import { getEntityBadgeClass } from "@/lib/entity-style"
import { fetchResourcesByOwner, searchAgentsByType } from "@/app/actions/graph"
import { fetchManagedGroupsAction } from "@/app/actions/event-form"
import { createOfferingResource } from "@/app/actions/create-resources"
import { getSubscriptionStatusAction } from "@/app/actions/billing"
import { useLocalesAndBasins } from "@/lib/hooks/use-graph-data"
import type { SerializedResource, SerializedAgent } from "@/lib/graph-serializers"
import { OfferingType } from "@/lib/types"
import type { BookingDate } from "@/lib/booking-slots"
import { SubscriptionGateDialog } from "@/components/subscription-gate-dialog"
import { FEATURE_TIER_REQUIREMENTS, FEATURE_DESCRIPTIONS } from "@/lib/subscription-constants"
import type { MembershipTier } from "@/db/schema"

// ─── Constants ───────────────────────────────────────────────────────────────

const SERVICE_CATEGORIES = [
  "Home Services",
  "Professional Services",
  "Creative Services",
  "Tech Services",
  "Education & Tutoring",
  "Health & Wellness",
  "Events & Entertainment",
  "Transportation",
  "Other",
] as const

const PRODUCT_CATEGORIES = [
  "Electronics",
  "Home & Garden",
  "Clothing & Accessories",
  "Sports & Outdoors",
  "Books & Media",
  "Vehicles",
  "Toys & Games",
  "Art & Collectibles",
  "Other",
] as const

const PRODUCT_CONDITIONS = ["New", "Like New", "Good", "Fair", "Poor"] as const

const SKILL_PROFICIENCY_LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"] as const

const RESOURCE_CATEGORIES = [
  "Tools & Equipment",
  "Building Materials",
  "Garden Supplies",
  "Kitchen Equipment",
  "Office Supplies",
  "Sports Equipment",
  "Art Supplies",
  "Electronics",
  "Other",
] as const

const RESOURCE_AVAILABILITY = ["Available Now", "By Appointment", "Limited"] as const

const DATA_FORMATS = ["PDF", "CSV", "JSON", "API", "Spreadsheet", "Other"] as const

const AVAILABILITY_OPTIONS = [
  "Weekdays",
  "Weekends",
  "Anytime",
  "By appointment",
] as const

/** Offering types that require pricing to be enabled. */
const PRICED_OFFERING_TYPES = new Set(["service", "product"])

const PICKABLE_RESOURCE_TYPES = ["resource", "skill", "voucher", "venue"] as const

/** Agent types available for targeting: people and groups. */
const TARGET_AGENT_TYPES = [
  { value: "person", label: "People", icon: Users },
  { value: "group", label: "Groups", icon: Building2 },
] as const

/** All group sub-types that the "Groups" search covers. */
const GROUP_AGENT_TYPES = [
  "organization",
  "ring",
  "family",
  "guild",
  "community",
] as const

const RESOURCE_TYPE_ICON: Record<string, React.ReactNode> = {
  resource: <Package className="h-3.5 w-3.5" />,
  skill: <Wrench className="h-3.5 w-3.5" />,
  voucher: <Ticket className="h-3.5 w-3.5" />,
  venue: <MapPin className="h-3.5 w-3.5" />,
}

const RESOURCE_TYPE_COLOR: Record<string, string> = {
  resource: getEntityBadgeClass("resource"),
  skill: getEntityBadgeClass("skill"),
  voucher: getEntityBadgeClass("voucher"),
  venue: getEntityBadgeClass("venue"),
}

const PRICED_TERMS = new Set(["sale", "rent", "borrow"])

const DEBOUNCE_MS = 300

/** Deal duration options with their hour values. */
const DEAL_DURATION_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "12 hours", hours: 12 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "14 days", hours: 336 },
  { label: "30 days", hours: 720 },
] as const

const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD ($)" },
  { value: "USDC", label: "USDC" },
  { value: "ETH", label: "ETH" },
  { value: "THANKS", label: "Thanks Points" },
  { value: "TRADE", label: "Trade / Barter" },
] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAllowedTerms(resource: SerializedResource): string[] {
  const type = resource.type
  const metadata = resource.metadata ?? {}
  const listingType = metadata.listingType as string | undefined
  const hasPrice = typeof metadata.price === "number" && metadata.price > 0

  switch (type) {
    case "resource": {
      if (listingType === "product" || hasPrice) return ["borrow", "rent", "sale"]
      return ["give", "voucher"]
    }
    case "skill": {
      if (listingType === "service" || hasPrice) return ["sale"]
      return ["give", "voucher"]
    }
    case "voucher":
      return ["give"]
    case "gift":
      return ["give"]
    case "bounty":
      return ["give"]
    case "venue":
      return ["rent"]
    default:
      return ["give"]
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SelectedItem {
  resourceId: string
  resource: SerializedResource
  term: string
  priceCents?: number
}

export interface SelectedAgent {
  id: string
  name: string
  type: string
}

export interface OfferingDraftPayload {
  title: string
  description: string
  imageUrl?: string
  items?: Array<{
    resourceId: string
    term: string
    priceCents?: number
  }>
  offeringType?: string
  basePrice?: number
  currency?: string
  acceptedCurrencies?: string[]
  quantityAvailable?: number
  tags?: string[]
  voucherValues?: {
    timeHours: number
    timeMinutes: number
    skillValue: number
    difficultyValue: number
    resourceCostDollars: number
    thanksValue?: number
  }
  hourlyRate?: number
  estimatedDuration?: { min?: number; max?: number }
  availability?: string
  bookingDates?: Array<{ date: string; timeSlots: string[] }>
  category?: string
  condition?: string
  bountyReward?: number
  bountyCriteria?: string
  bountyDeadline?: string
  ticketEventName?: string
  ticketDate?: string
  ticketVenue?: string
  ticketQuantity?: number
  ticketPrice?: number
  tripOrigin?: string
  tripDestination?: string
  tripDate?: string
  tripCapacity?: number
  skillArea?: string
  skillProficiency?: string
  skillRate?: number
  resourceCategory?: string
  resourceAvailability?: string
  resourceCondition?: string
  resourcePrice?: number
  dataFormat?: string
  dataSize?: string
  dataPrice?: number
  hasDeal?: boolean
  dealPrice?: number
  dealDurationHours?: number
  targetAgentTypes: string[]
  ownerId?: string
  scopedLocaleIds?: string[]
  scopedGroupIds?: string[]
  scopedUserIds?: string[]
  postToFeed?: boolean
  eftValues?: Record<string, number>
  capitalValues?: Record<string, number>
  auditValues?: Record<string, number>
}

interface CreateOfferingFormProps {
  locales?: Array<{ id: string; name: string; basinId?: string }>
  eftValues?: Record<string, number>
  capitalValues?: Record<string, number>
  auditValues?: Record<string, number>
  initialValues?: Partial<OfferingDraftPayload> & {
    targetAgents?: SelectedAgent[]
  }
  scopeMode?: "internal" | "external"
  titleText?: string
  submitLabel?: string
  onCancel?: () => void
  onCreated?: (result: { resourceId?: string; payload: OfferingDraftPayload }) => void
  onSubmitPayload?: (payload: OfferingDraftPayload) => Promise<void> | void
}

// ─── Agent Type Search Select ────────────────────────────────────────────────

function AgentTypeSearchSelect({
  agentType,
  label,
  icon: Icon,
  selectedAgents,
  onAdd,
  onRemove,
}: {
  agentType: string
  label: string
  icon: React.ElementType
  selectedAgents: SelectedAgent[]
  onAdd: (agent: SelectedAgent) => void
  onRemove: (id: string) => void
}) {
  const [search, setSearch] = useState("")
  const [focused, setFocused] = useState(false)
  const [results, setResults] = useState<SerializedAgent[]>([])
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedIds = useMemo(
    () => new Set(selectedAgents.map((a) => a.id)),
    [selectedAgents],
  )

  const doSearch = useCallback(
    (query: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        setLoading(true)
        try {
          if (agentType === "group") {
            // Search across all group sub-types in parallel
            const allResults = await Promise.all(
              GROUP_AGENT_TYPES.map((t) =>
                searchAgentsByType(t, query || undefined, 30),
              ),
            )
            setResults(allResults.flat())
          } else {
            const agents = await searchAgentsByType(agentType, query || undefined, 30)
            setResults(agents)
          }
        } finally {
          setLoading(false)
        }
      }, DEBOUNCE_MS)
    },
    [agentType],
  )

  useEffect(() => {
    if (focused) doSearch(search)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [search, focused, doSearch])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const filtered = results.filter((a) => !selectedIds.has(a.id))
  const groupTypes = new Set<string>(GROUP_AGENT_TYPES)
  const typeAgents = selectedAgents.filter((a) =>
    agentType === "group" ? groupTypes.has(a.type) : a.type === agentType,
  )
  const showDropdown = focused && (filtered.length > 0 || loading)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      {typeAgents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {typeAgents.map((agent) => (
            <Badge
              key={agent.id}
              variant="secondary"
              className="flex items-center gap-1"
            >
              {agent.name}
              <button
                type="button"
                onClick={() => onRemove(agent.id)}
                className="ml-1 hover:text-destructive"
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove</span>
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div ref={containerRef} className="relative">
        <Input
          placeholder={`Search ${label.toLowerCase()}...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setFocused(true)}
          className="h-9"
        />
        {showDropdown && (
          <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
            <div className="max-h-[200px] overflow-y-auto p-1">
              {loading && filtered.length === 0 ? (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                filtered.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onAdd({ id: agent.id, name: agent.name, type: agent.type ?? agentType })
                      setSearch("")
                    }}
                  >
                    <span className="truncate">{agent.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Locale Picker ───────────────────────────────────────────────────────────

function LocalePicker({
  locales,
  selectedLocaleIds,
  onToggle,
  onRemove,
}: {
  locales: Array<{ id: string; name: string }>
  selectedLocaleIds: string[]
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [search, setSearch] = useState("")
  const [focused, setFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(
    () => new Set(selectedLocaleIds),
    [selectedLocaleIds],
  )

  const filtered = useMemo(() => {
    let list = locales.filter((l) => !selectedSet.has(l.id))
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((l) => l.name.toLowerCase().includes(q))
    }
    return list
  }, [locales, selectedSet, search])

  const getLocaleName = (id: string) =>
    locales.find((l) => l.id === id)?.name ?? id

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const showDropdown = focused && filtered.length > 0

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Locales</span>
      </div>
      {selectedLocaleIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedLocaleIds.map((id) => (
            <Badge key={id} variant="secondary" className="flex items-center gap-1">
              {getLocaleName(id)}
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="ml-1 hover:text-destructive"
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove</span>
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div ref={containerRef} className="relative">
        <Input
          placeholder="Search locales..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setFocused(true)}
          className="h-9"
        />
        {showDropdown && (
          <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
            <div className="max-h-[200px] overflow-y-auto p-1">
              {filtered.map((locale) => (
                <button
                  key={locale.id}
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onToggle(locale.id)
                    setSearch("")
                  }}
                >
                  <span>{locale.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Item Search Dropdown ────────────────────────────────────────────────────

function ItemSearchDropdown({
  resources,
  loading,
  search,
  onSearchChange,
  onSelect,
}: {
  resources: SerializedResource[]
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  onSelect: (resource: SerializedResource) => void
}) {
  const [focused, setFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const showDropdown = focused && (resources.length > 0 || loading)

  return (
    <div ref={containerRef} className="relative">
      <Input
        placeholder="Search your resources..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        onFocus={() => setFocused(true)}
        className="h-9"
      />
      {showDropdown && (
        <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="max-h-[200px] overflow-y-auto p-1">
            {loading && resources.length === 0 ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              resources.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(r)
                  }}
                >
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs ${RESOURCE_TYPE_COLOR[r.type] ?? ""}`}
                  >
                    {RESOURCE_TYPE_ICON[r.type]}
                    {capitalize(r.type)}
                  </span>
                  <span className="truncate">{r.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function CreateOfferingForm({
  locales,
  eftValues,
  capitalValues,
  auditValues,
  initialValues,
  scopeMode = "internal",
  titleText = "Create an Offering",
  submitLabel = "Create Offering",
  onCancel,
  onCreated,
  onSubmitPayload,
}: CreateOfferingFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { data: session } = useSession()
  const { data: localeData } = useLocalesAndBasins()
  const [manageableGroups, setManageableGroups] = useState<Array<{ id: string; name: string; description: string | null; groupType: string | null }>>([])

  // Resources loaded from the current user's account
  const [resources, setResources] = useState<SerializedResource[]>([])
  const [resourcesLoading, setResourcesLoading] = useState(false)

  // Items picker state
  const [itemSearch, setItemSearch] = useState("")
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])

  // Offering details
  const [title, setTitle] = useState(initialValues?.title ?? "")
  const [titleManuallyEdited, setTitleManuallyEdited] = useState(Boolean(initialValues?.title))
  const [description, setDescription] = useState(initialValues?.description ?? "")
  const [offeringImageUrls, setOfferingImageUrls] = useState<string[]>(
    initialValues?.imageUrl ? [initialValues.imageUrl] : [],
  )

  // Target audience — specific agent instances selected per type
  const [targetAgents, setTargetAgents] = useState<SelectedAgent[]>(initialValues?.targetAgents ?? [])

  // Locale scoping
  const [selectedLocaleIds, setSelectedLocaleIds] = useState<string[]>(initialValues?.scopedLocaleIds ?? [])
  const [ownerId, setOwnerId] = useState<string>(initialValues?.ownerId ?? "self")

  // Post to feed
  const [postToFeed, setPostToFeed] = useState(initialValues?.postToFeed ?? true)

  // Standalone offering fields
  const [offeringType, setOfferingType] = useState<string>(initialValues?.offeringType ?? "")
  const [hasPrice, setHasPrice] = useState(Boolean(initialValues?.basePrice))
  const [basePrice, setBasePrice] = useState(
    initialValues?.basePrice !== undefined ? String((initialValues.basePrice ?? 0) / 100) : ""
  )
  const [currency, setCurrency] = useState(initialValues?.currency ?? "USD")
  const [acceptedCurrencies, setAcceptedCurrencies] = useState<string[]>(
    initialValues?.acceptedCurrencies?.length
      ? initialValues.acceptedCurrencies
      : initialValues?.currency
        ? [initialValues.currency]
        : ["USD"],
  )
  const [tagsInput, setTagsInput] = useState(initialValues?.tags?.join(", ") ?? "")
  const [quantityAvailable, setQuantityAvailable] = useState(
    initialValues?.quantityAvailable ? String(initialValues.quantityAvailable) : "",
  )
  // Service-specific fields
  const [hourlyRate, setHourlyRate] = useState(initialValues?.hourlyRate ? String(initialValues.hourlyRate) : "")
  const [estimatedDurationMin, setEstimatedDurationMin] = useState(initialValues?.estimatedDuration?.min ? String(initialValues.estimatedDuration.min) : "")
  const [estimatedDurationMax, setEstimatedDurationMax] = useState(initialValues?.estimatedDuration?.max ? String(initialValues.estimatedDuration.max) : "")
  const [availability, setAvailability] = useState(initialValues?.availability ?? "")
  const [bookingDates, setBookingDates] = useState<BookingDate[]>(initialValues?.bookingDates?.length ? initialValues.bookingDates : [])
  const [serviceCategory, setServiceCategory] = useState(initialValues?.category ?? "")

  // Product-specific fields
  const [unitPrice, setUnitPrice] = useState(
    initialValues?.offeringType === "product" && initialValues?.basePrice !== undefined
      ? String((initialValues.basePrice ?? 0) / 100)
      : ""
  )
  const [productCondition, setProductCondition] = useState(initialValues?.condition ?? "")
  const [productCategory, setProductCategory] = useState(initialValues?.category ?? "")

  // Voucher calculator
  const [voucherHours, setVoucherHours] = useState(initialValues?.voucherValues?.timeHours ?? 1)
  const [voucherMinutes, setVoucherMinutes] = useState(initialValues?.voucherValues?.timeMinutes ?? 0)
  const [skillValue, setSkillValue] = useState([initialValues?.voucherValues?.skillValue ?? 5])
  const [difficultyValue, setDifficultyValue] = useState([initialValues?.voucherValues?.difficultyValue ?? 5])
  const [resourceCostDollars, setResourceCostDollars] = useState(
    initialValues?.voucherValues?.resourceCostDollars !== undefined
      ? String(initialValues.voucherValues.resourceCostDollars)
      : ""
  )

  // Deal fields
  const [hasDeal, setHasDeal] = useState(initialValues?.hasDeal ?? false)
  const [dealPrice, setDealPrice] = useState(initialValues?.dealPrice ? String(initialValues.dealPrice / 100) : "")
  const [dealDurationHours, setDealDurationHours] = useState<number>(initialValues?.dealDurationHours ?? 24)

  // Bounty-specific fields
  const [bountyReward, setBountyReward] = useState(initialValues?.bountyReward ? String(initialValues.bountyReward) : "")
  const [bountyCriteria, setBountyCriteria] = useState(initialValues?.bountyCriteria ?? "")
  const [bountyDeadline, setBountyDeadline] = useState(initialValues?.bountyDeadline ?? "")

  // Ticket-specific fields
  const [ticketEventName, setTicketEventName] = useState(initialValues?.ticketEventName ?? "")
  const [ticketDate, setTicketDate] = useState(initialValues?.ticketDate ?? "")
  const [ticketVenue, setTicketVenue] = useState(initialValues?.ticketVenue ?? "")
  const [ticketQuantity, setTicketQuantity] = useState(initialValues?.ticketQuantity ? String(initialValues.ticketQuantity) : "")
  const [ticketPrice, setTicketPrice] = useState(initialValues?.ticketPrice ? String(initialValues.ticketPrice) : "")

  // Trip-specific fields
  const [tripOrigin, setTripOrigin] = useState(initialValues?.tripOrigin ?? "")
  const [tripDestination, setTripDestination] = useState(initialValues?.tripDestination ?? "")
  const [tripDate, setTripDate] = useState(initialValues?.tripDate ?? "")
  const [tripCapacity, setTripCapacity] = useState(initialValues?.tripCapacity ? String(initialValues.tripCapacity) : "")
  const [tripPrice, setTripPrice] = useState(
    initialValues?.offeringType === "trip" && initialValues?.basePrice !== undefined
      ? String((initialValues.basePrice ?? 0) / 100)
      : ""
  )

  // Skill-specific fields
  const [skillArea, setSkillArea] = useState(initialValues?.skillArea ?? "")
  const [skillProficiency, setSkillProficiency] = useState(initialValues?.skillProficiency ?? "")
  const [skillRate, setSkillRate] = useState(initialValues?.skillRate ? String(initialValues.skillRate) : "")

  // Resource-specific fields
  const [resourceCategory, setResourceCategory] = useState(initialValues?.resourceCategory ?? "")
  const [resourceAvailability, setResourceAvailability] = useState(initialValues?.resourceAvailability ?? "")
  const [resourceCondition, setResourceCondition] = useState(initialValues?.resourceCondition ?? "")
  const [resourcePrice, setResourcePrice] = useState(initialValues?.resourcePrice ? String(initialValues.resourcePrice) : "")

  // Data-specific fields
  const [dataFormat, setDataFormat] = useState(initialValues?.dataFormat ?? "")
  const [dataSize, setDataSize] = useState(initialValues?.dataSize ?? "")
  const [dataPrice, setDataPrice] = useState(initialValues?.dataPrice ? String(initialValues.dataPrice) : "")

  // Submission
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showSubscriptionGate, setShowSubscriptionGate] = useState(false)
  const [gateRequiredTier, setGateRequiredTier] = useState<MembershipTier>(FEATURE_TIER_REQUIREMENTS.PAID_OFFERINGS)
  const [pendingPayloadAfterGate, setPendingPayloadAfterGate] = useState<OfferingDraftPayload | null>(null)
  const resolvedLocales = useMemo(
    () => locales ?? localeData.locales.map((locale) => ({ id: locale.id, name: locale.name, basinId: locale.basinId })),
    [localeData.locales, locales],
  )
  const validLocaleIds = useMemo(() => new Set(resolvedLocales.map((locale) => locale.id)), [resolvedLocales])

  useEffect(() => {
    setSelectedLocaleIds((current) => current.filter((id) => validLocaleIds.has(id)))
  }, [validLocaleIds])

  useEffect(() => {
    let cancelled = false
    fetchManagedGroupsAction()
      .then((groups) => {
        if (cancelled) return
        setManageableGroups(groups)
      })
      .catch(() => {
        if (cancelled) return
        setManageableGroups([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  // ─── Auto-enable pricing for service/product offerings ──────────────────

  useEffect(() => {
    if (PRICED_OFFERING_TYPES.has(offeringType)) {
      setHasPrice(true)
    }
    if (offeringType === "gift") {
      setHasPrice(false)
    }
  }, [offeringType])

  useEffect(() => {
    setAcceptedCurrencies((prev) => (prev.includes(currency) ? prev : [...prev, currency]))
  }, [currency])

  // ─── Fetch user resources on mount ────────────────────────────────────────

  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) return

    let cancelled = false
    async function load() {
      setResourcesLoading(true)
      try {
        const all = await fetchResourcesByOwner(userId!)
        if (cancelled) return
        const pickable = all.filter((r) =>
          (PICKABLE_RESOURCE_TYPES as readonly string[]).includes(r.type),
        )
        setResources(pickable)
      } finally {
        if (!cancelled) setResourcesLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  // ─── Auto-generate title from selected item names ─────────────────────────

  useEffect(() => {
    if (titleManuallyEdited) return
    if (selectedItems.length === 0) {
      setTitle("")
      return
    }
    const names = selectedItems.map((i) => i.resource.name)
    setTitle(names.join(", "))
  }, [selectedItems, titleManuallyEdited])

  // ─── Filtered resources for the picker popover ────────────────────────────

  const filteredResources = useMemo(() => {
    const selectedIds = new Set(selectedItems.map((i) => i.resourceId))
    let list = resources.filter((r) => !selectedIds.has(r.id))
    if (itemSearch) {
      const q = itemSearch.toLowerCase()
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q),
      )
    }
    return list
  }, [resources, selectedItems, itemSearch])

  // ─── Item selection handlers ──────────────────────────────────────────────

  const addItem = (resource: SerializedResource) => {
    const terms = getAllowedTerms(resource)
    const defaultTerm = terms[0]
    setSelectedItems((prev) => [
      ...prev,
      { resourceId: resource.id, resource, term: defaultTerm },
    ])
    setItemSearch("")
  }

  const removeItem = (resourceId: string) => {
    setSelectedItems((prev) => prev.filter((i) => i.resourceId !== resourceId))
  }

  const updateItemTerm = (resourceId: string, term: string) => {
    setSelectedItems((prev) =>
      prev.map((i) => {
        if (i.resourceId !== resourceId) return i
        return {
          ...i,
          term,
          priceCents: PRICED_TERMS.has(term) ? i.priceCents : undefined,
        }
      }),
    )
  }

  const updateItemPrice = (resourceId: string, dollars: string) => {
    const cents = dollars ? Math.round(parseFloat(dollars) * 100) : undefined
    setSelectedItems((prev) =>
      prev.map((i) =>
        i.resourceId === resourceId ? { ...i, priceCents: cents } : i,
      ),
    )
  }

  // ─── Target agent handlers ────────────────────────────────────────────────

  const addTargetAgent = (agent: SelectedAgent) => {
    setTargetAgents((prev) => {
      if (prev.some((a) => a.id === agent.id)) return prev
      return [...prev, agent]
    })
  }

  const removeTargetAgent = (id: string) => {
    setTargetAgents((prev) => prev.filter((a) => a.id !== id))
  }

  // ─── Locale handlers ──────────────────────────────────────────────────────

  const toggleLocale = (id: string) => {
    setSelectedLocaleIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
    )
  }

  const removeLocale = (id: string) => {
    setSelectedLocaleIds((prev) => prev.filter((l) => l !== id))
  }

  // ─── Derived data for submission ──────────────────────────────────────────

  // Whether the type-specific details card embeds title/description/tags
  const isInlineDetailsType = offeringType === "service" || offeringType === "product" || offeringType === "gift" || offeringType === "bounty" || offeringType === "ticket" || offeringType === "trip" || offeringType === "skill" || offeringType === "resource" || offeringType === "data"

  const buildPayload = (): OfferingDraftPayload => {
    let effectiveBasePrice = hasPrice && basePrice ? Math.round(parseFloat(basePrice) * 100) : undefined
    if (offeringType === "service" && hourlyRate) {
      effectiveBasePrice = Math.round(parseFloat(hourlyRate) * 100)
    } else if (offeringType === "product" && unitPrice) {
      effectiveBasePrice = Math.round(parseFloat(unitPrice) * 100)
    } else if (offeringType === "bounty" && bountyReward) {
      effectiveBasePrice = Math.round(parseFloat(bountyReward) * 100)
    } else if (offeringType === "ticket" && ticketPrice) {
      effectiveBasePrice = Math.round(parseFloat(ticketPrice) * 100)
    } else if (offeringType === "trip" && tripPrice) {
      effectiveBasePrice = Math.round(parseFloat(tripPrice) * 100)
    } else if (offeringType === "skill" && skillRate) {
      effectiveBasePrice = Math.round(parseFloat(skillRate) * 100)
    } else if (offeringType === "resource" && resourcePrice) {
      effectiveBasePrice = Math.round(parseFloat(resourcePrice) * 100)
    } else if (offeringType === "data" && dataPrice) {
      effectiveBasePrice = Math.round(parseFloat(dataPrice) * 100)
    }

    const targetAgentTypes = [...new Set(targetAgents.map((a) => a.type))]
    const scopedUserIds = targetAgents.filter((a) => a.type === "person").map((a) => a.id)
    const scopedGroupIds = targetAgents
      .filter((a) => ["organization", "ring", "family", "guild", "community"].includes(a.type))
      .map((a) => a.id)

    const normalizedAcceptedCurrencies = Array.from(
      new Set([
        ...acceptedCurrencies,
        ...(currency ? [currency] : []),
      ].filter(Boolean)),
    )
    const normalizedBookingDates = bookingDates.filter((booking) => booking.date && booking.timeSlots.length > 0)

    return {
      title: title.trim(),
      description: description.trim(),
      imageUrl: offeringImageUrls[0],
      items: selectedItems.length > 0 ? selectedItems.map((i) => ({
        resourceId: i.resourceId,
        term: i.term,
        priceCents: i.priceCents,
      })) : undefined,
      offeringType: offeringType || undefined,
      basePrice: effectiveBasePrice,
      currency: hasPrice || effectiveBasePrice !== undefined ? currency : undefined,
      acceptedCurrencies: normalizedAcceptedCurrencies.length > 0 ? normalizedAcceptedCurrencies : undefined,
      quantityAvailable: quantityAvailable ? parseInt(quantityAvailable, 10) : undefined,
      tags: tagsInput ? tagsInput.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      voucherValues: offeringType === "voucher" ? {
        timeHours: voucherHours,
        timeMinutes: voucherMinutes,
        skillValue: skillValue[0],
        difficultyValue: difficultyValue[0],
        resourceCostDollars: resourceCostDollars ? parseFloat(resourceCostDollars) : 0,
        thanksValue: Math.round(Math.sqrt(skillValue[0] * difficultyValue[0]) * (voucherHours + voucherMinutes / 60)),
      } : undefined,
      hourlyRate: offeringType === "service" && hourlyRate ? parseFloat(hourlyRate) : undefined,
      estimatedDuration: offeringType === "service" && (estimatedDurationMin || estimatedDurationMax) ? {
        min: estimatedDurationMin ? parseFloat(estimatedDurationMin) : undefined,
        max: estimatedDurationMax ? parseFloat(estimatedDurationMax) : undefined,
      } : undefined,
      availability: offeringType === "service" && availability ? availability : undefined,
      bookingDates:
        (offeringType === "service" || offeringType === "resource" || offeringType === "voucher") && normalizedBookingDates.length > 0
          ? normalizedBookingDates
          : undefined,
      category: (offeringType === "service" && serviceCategory) || (offeringType === "product" && productCategory) || undefined,
      condition: offeringType === "product" && productCondition ? productCondition : undefined,
      bountyReward: offeringType === "bounty" && bountyReward ? parseFloat(bountyReward) : undefined,
      bountyCriteria: offeringType === "bounty" && bountyCriteria ? bountyCriteria : undefined,
      bountyDeadline: offeringType === "bounty" && bountyDeadline ? bountyDeadline : undefined,
      ticketEventName: offeringType === "ticket" && ticketEventName ? ticketEventName : undefined,
      ticketDate: offeringType === "ticket" && ticketDate ? ticketDate : undefined,
      ticketVenue: offeringType === "ticket" && ticketVenue ? ticketVenue : undefined,
      ticketQuantity: offeringType === "ticket" && ticketQuantity ? parseInt(ticketQuantity) : undefined,
      ticketPrice: offeringType === "ticket" && ticketPrice ? parseFloat(ticketPrice) : undefined,
      tripOrigin: offeringType === "trip" && tripOrigin ? tripOrigin : undefined,
      tripDestination: offeringType === "trip" && tripDestination ? tripDestination : undefined,
      tripDate: offeringType === "trip" && tripDate ? tripDate : undefined,
      tripCapacity: offeringType === "trip" && tripCapacity ? parseInt(tripCapacity) : undefined,
      skillArea: offeringType === "skill" && skillArea ? skillArea : undefined,
      skillProficiency: offeringType === "skill" && skillProficiency ? skillProficiency : undefined,
      skillRate: offeringType === "skill" && skillRate ? parseFloat(skillRate) : undefined,
      resourceCategory: offeringType === "resource" && resourceCategory ? resourceCategory : undefined,
      resourceAvailability: offeringType === "resource" && resourceAvailability ? resourceAvailability : undefined,
      resourceCondition: offeringType === "resource" && resourceCondition ? resourceCondition : undefined,
      resourcePrice: offeringType === "resource" && resourcePrice ? parseFloat(resourcePrice) : undefined,
      dataFormat: offeringType === "data" && dataFormat ? dataFormat : undefined,
      dataSize: offeringType === "data" && dataSize ? dataSize : undefined,
      dataPrice: offeringType === "data" && dataPrice ? parseFloat(dataPrice) : undefined,
      hasDeal,
      dealPrice: hasDeal && dealPrice ? Math.round(parseFloat(dealPrice) * 100) : undefined,
      dealDurationHours: hasDeal ? dealDurationHours : undefined,
      targetAgentTypes,
      ownerId: ownerId !== "self" ? ownerId : undefined,
      scopedLocaleIds: selectedLocaleIds.length > 0 ? selectedLocaleIds : undefined,
      scopedGroupIds: scopedGroupIds.length > 0 ? scopedGroupIds : undefined,
      scopedUserIds: scopedUserIds.length > 0 ? scopedUserIds : undefined,
      postToFeed,
      eftValues: eftValues && Object.values(eftValues).some((v) => v > 0) ? eftValues : undefined,
      capitalValues: capitalValues && Object.values(capitalValues).some((v) => v > 0) ? capitalValues : undefined,
      auditValues: auditValues && Object.values(auditValues).some((v) => v > 0) ? auditValues : undefined,
    }
  }

  // ─── Submit ───────────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (selectedItems.length === 0 && !offeringType) {
      toast({
        title: "Missing information",
        description: "Select an offering type or add at least one item.",
        variant: "destructive",
      })
      return
    }

    if (!title.trim()) {
      toast({
        title: "Title required",
        description: "Enter a title for your offering.",
        variant: "destructive",
      })
      return
    }

    if (quantityAvailable && (!Number.isInteger(Number(quantityAvailable)) || Number(quantityAvailable) <= 0)) {
      toast({
        title: "Invalid quantity",
        description: "Quantity available must be a positive whole number.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    try {
      const payload = buildPayload()

      // Pre-check: if the offering has a price, verify subscription before server call.
      const offeringHasPrice =
        (payload.basePrice !== undefined && payload.basePrice > 0) ||
        (payload.items && payload.items.some((i) => (i.priceCents ?? 0) > 0))
      if (offeringHasPrice) {
        const sub = await getSubscriptionStatusAction().catch(() => null)
        if (!sub) {
          setGateRequiredTier(FEATURE_TIER_REQUIREMENTS.PAID_OFFERINGS)
          setPendingPayloadAfterGate(payload)
          setShowSubscriptionGate(true)
          return
        }
      }

      if (onSubmitPayload) {
        await onSubmitPayload(payload)
        onCreated?.({ payload })
        return
      }

      const result = await createOfferingResource(payload)

      if (!result.success) {
        // Handle server-side subscription gate response
        if (result.error?.code === "SUBSCRIPTION_REQUIRED") {
          const tier = (result.error.requiredTier ?? "seller") as MembershipTier
          setGateRequiredTier(tier)
          setPendingPayloadAfterGate(payload)
          setShowSubscriptionGate(true)
          return
        }
        toast({
          title: "Failed to create offering",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Offering created",
        description: "Your offering is now live.",
      })
      onCreated?.({ resourceId: result.resourceId, payload })
      if (onCancel) {
        onCancel()
      } else {
        router.push("/profile?tab=offerings")
      }
    } catch {
      toast({
        title: "Failed to create offering",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * Retries offering creation after a subscription trial is started.
   * Called from the SubscriptionGateDialog's onTrialStarted callback.
   */
  const handleRetryAfterTrial = async () => {
    if (!pendingPayloadAfterGate) return
    setIsSubmitting(true)
    try {
      if (onSubmitPayload) {
        await onSubmitPayload(pendingPayloadAfterGate)
        onCreated?.({ payload: pendingPayloadAfterGate })
        return
      }
      const result = await createOfferingResource(pendingPayloadAfterGate)
      if (!result.success) {
        toast({
          title: "Failed to create offering",
          description: result.message,
          variant: "destructive",
        })
        return
      }
      toast({
        title: "Offering created",
        description: "Your offering is now live.",
      })
      onCreated?.({ resourceId: result.resourceId, payload: pendingPayloadAfterGate })
      if (onCancel) {
        onCancel()
      } else {
        router.push("/profile?tab=offerings")
      }
    } catch {
      toast({
        title: "Failed to create offering",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setPendingPayloadAfterGate(null)
    }
  }

  // ─── Shared field fragments ────────────────────────────────────────────────

  const titleField = (
    <div className="space-y-1">
      <Label htmlFor="offering-title">Title</Label>
      <Input
        id="offering-title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
          setTitleManuallyEdited(true)
        }}
        placeholder="Offering title"
        required
      />
    </div>
  )

  const descriptionField = (
    <div className="space-y-1">
      <Label htmlFor="offering-description">Description</Label>
      <Textarea
        id="offering-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe what you're offering..."
        rows={3}
      />
      <div className="space-y-2 pt-2">
        <Label>Offering Image</Label>
        <ImageUpload value={offeringImageUrls} onChange={setOfferingImageUrls} maxFiles={1} />
        <p className="text-xs text-muted-foreground">
          This image will appear on the linked offering card, the offering page, and marketplace cards.
        </p>
      </div>
    </div>
  )

  const currencyField = (
    <div className="space-y-1">
      <Label>Primary Price Currency</Label>
      <Select value={currency} onValueChange={setCurrency}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {CURRENCY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const acceptedCurrenciesField = (
    <div className="space-y-2">
      <Label>Accepted Currency Types</Label>
      <div className="flex flex-wrap gap-2">
        {CURRENCY_OPTIONS.map((option) => {
          const checked = acceptedCurrencies.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() =>
                setAcceptedCurrencies((prev) =>
                  prev.includes(option.value)
                    ? prev.filter((value) => value !== option.value)
                    : [...prev, option.value],
                )
              }
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${checked ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Select every currency or exchange mode you will accept for this offering.
      </p>
    </div>
  )

  const quantityField = (
    <div className="space-y-1">
      <Label>Quantity Available</Label>
      <Input
        type="number"
        min="1"
        step="1"
        value={quantityAvailable}
        onChange={(e) => setQuantityAvailable(e.target.value)}
        placeholder="How many are available?"
      />
      <p className="text-xs text-muted-foreground">
        Purchases or claims will stop once this limit is reached.
      </p>
    </div>
  )

  const normalizedBookingDates = bookingDates.filter((booking) => booking.date && booking.timeSlots.length > 0)
  const schedulerBlockDurationMinutes =
    offeringType === "voucher"
      ? Math.max(15, voucherHours * 60 + voucherMinutes)
      : offeringType === "service" && estimatedDurationMin
        ? Math.max(15, Math.round(parseFloat(estimatedDurationMin || "0") * 60))
        : 60

  const bookingScheduleField = (
    <div className="space-y-3">
      <div>
        <Label className="inline-flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Bookable Schedule
        </Label>
        <p className="text-xs text-muted-foreground">
          Click the week-view blocks when you can be booked. Buyers will choose one block before checkout or voucher claim.
        </p>
      </div>

      <div className="overflow-x-auto">
        <BookingWeekScheduler
          bookingDates={bookingDates}
          onChange={setBookingDates}
          blockDurationMinutes={schedulerBlockDurationMinutes}
          emptyLabel="No bookable blocks yet. Leave empty for a non-bookable offering."
        />
      </div>

      {normalizedBookingDates.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {normalizedBookingDates.reduce((count, booking) => count + booking.timeSlots.length, 0)} total bookable blocks selected.
        </p>
      ) : null}
    </div>
  )

  const tagsField = (
    <div className="space-y-1">
      <Label htmlFor="offering-tags">Tags</Label>
      <Input id="offering-tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Comma-separated tags..." />
      <p className="text-xs text-muted-foreground">e.g., gardening, organic, local</p>
    </div>
  )

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">{titleText}</h2>

        {/* ── Offering Type Selector ──────────────────────────────────────── */}
        <div className="space-y-2">
          <Label>Offering Type</Label>
          <Select value={offeringType} onValueChange={setOfferingType}>
            <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="skill">Skill - Knowledge &amp; Expertise</SelectItem>
              <SelectItem value="resource">Resource - Tools &amp; Materials</SelectItem>
              <SelectItem value="product">Product - Physical Items</SelectItem>
              <SelectItem value="service">Service - Labor &amp; Tasks</SelectItem>
              <SelectItem value="trip">Trip - Transportation</SelectItem>
              <SelectItem value="ticket">Ticket - Event Access</SelectItem>
              <SelectItem value="voucher">Voucher - Community Help</SelectItem>
              <SelectItem value="data">Data - Information &amp; Reports</SelectItem>
              <SelectItem value="gift">Gift - Free Offering</SelectItem>
              <SelectItem value="bounty">Bounty - Request with Reward</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* ── Voucher Value Calculator ──────────────────────────────────────── */}
        {offeringType === "voucher" && (() => {
          const totalHours = voucherHours + voucherMinutes / 60;
          const thanksValue = Math.round(Math.sqrt(skillValue[0] * difficultyValue[0]) * totalHours);
          return (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Award className="h-5 w-5" />Voucher Value Calculator
              </CardTitle>
              <p className="text-sm text-muted-foreground">Set effort levels to calculate thanks points</p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label className="flex items-center gap-2"><Clock className="h-4 w-4" />Time Required</Label>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <Label className="text-xs text-muted-foreground">Hours</Label>
                    <Input type="number" min={0} max={999} value={voucherHours} onChange={(e) => setVoucherHours(Math.max(0, parseInt(e.target.value) || 0))} />
                  </div>
                  <div className="flex-1">
                    <Label className="text-xs text-muted-foreground">Minutes</Label>
                    <select className="w-full p-2 border rounded-md bg-background text-foreground" value={voucherMinutes} onChange={(e) => setVoucherMinutes(parseInt(e.target.value))}>
                      <option value={0}>0</option>
                      <option value={15}>15</option>
                      <option value={30}>30</option>
                      <option value={45}>45</option>
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="flex items-center gap-2"><Zap className="h-4 w-4" />Skill Level</Label>
                  <Badge variant="outline">{skillValue[0]}/100</Badge>
                </div>
                <Slider value={skillValue} onValueChange={setSkillValue} min={1} max={100} step={1} />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="flex items-center gap-2"><Award className="h-4 w-4" />Difficulty</Label>
                  <Badge variant="outline">{difficultyValue[0]}/100</Badge>
                </div>
                <Slider value={difficultyValue} onValueChange={setDifficultyValue} min={1} max={100} step={1} />
              </div>
              <div className="space-y-3">
                <Label className="flex items-center gap-2"><DollarSign className="h-4 w-4" />Resource Cost ($)</Label>
                <Input type="number" min={0} step="0.01" placeholder="0.00" value={resourceCostDollars} onChange={(e) => setResourceCostDollars(e.target.value)} />
              </div>
              <div className="text-center p-3 rounded-lg bg-muted">
                <p className="text-sm text-muted-foreground">Estimated Thanks Value</p>
                <p className="text-2xl font-bold">{thanksValue} Thanks</p>
                {resourceCostDollars && (
                  <p className="text-lg text-muted-foreground mt-1">${parseFloat(resourceCostDollars).toFixed(2)} Resource Cost</p>
                )}
              </div>
              {bookingScheduleField}
            </CardContent>
          </Card>
          );
        })()}

        {/* ── Service Details (consolidated: title, description, rate, duration, availability, category, currency, tags) ── */}
        {offeringType === "service" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Wrench className="h-5 w-5" />Service Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Hourly Rate (required)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Estimated Duration (hours)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={estimatedDurationMin}
                    onChange={(e) => setEstimatedDurationMin(e.target.value)}
                    placeholder="Min"
                    className="flex-1"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={estimatedDurationMax}
                    onChange={(e) => setEstimatedDurationMax(e.target.value)}
                    placeholder="Max"
                    className="flex-1"
                  />
                </div>
                <p className="text-xs text-muted-foreground">e.g., 1 to 4 hours</p>
              </div>
              <div className="space-y-1">
                <Label>Availability</Label>
                <Select value={availability} onValueChange={setAvailability}>
                  <SelectTrigger><SelectValue placeholder="Select availability..." /></SelectTrigger>
                  <SelectContent>
                    {AVAILABILITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Service Category</Label>
                <Select value={serviceCategory} onValueChange={setServiceCategory}>
                  <SelectTrigger><SelectValue placeholder="Select category..." /></SelectTrigger>
                  <SelectContent>
                    {SERVICE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {bookingScheduleField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Product Details (consolidated: title, description, price, condition, category, currency, tags) ── */}
        {offeringType === "product" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Package className="h-5 w-5" />Product Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Unit Price (required)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Condition</Label>
                <Select value={productCondition} onValueChange={setProductCondition}>
                  <SelectTrigger><SelectValue placeholder="Select condition..." /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_CONDITIONS.map((cond) => (
                      <SelectItem key={cond} value={cond}>{cond}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Product Category</Label>
                <Select value={productCategory} onValueChange={setProductCategory}>
                  <SelectTrigger><SelectValue placeholder="Select category..." /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {bookingScheduleField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Gift Details ──────────────────────────────────────────────── */}
        {offeringType === "gift" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Gift className="h-5 w-5" />Gift Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">A free offering — no price required</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Bounty Details ──────────────────────────────────────────────── */}
        {offeringType === "bounty" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Target className="h-5 w-5" />Bounty Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Post a request with a reward for completion</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Reward Amount (required)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={bountyReward}
                    onChange={(e) => setBountyReward(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Completion Criteria</Label>
                <Textarea
                  value={bountyCriteria}
                  onChange={(e) => setBountyCriteria(e.target.value)}
                  placeholder="Describe what needs to be done to claim the bounty..."
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label>Deadline (optional)</Label>
                <Input
                  type="date"
                  value={bountyDeadline}
                  onChange={(e) => setBountyDeadline(e.target.value)}
                />
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Ticket Details ──────────────────────────────────────────────── */}
        {offeringType === "ticket" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Ticket className="h-5 w-5" />Ticket Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Sell access to an event or experience</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Event Name</Label>
                <Input
                  value={ticketEventName}
                  onChange={(e) => setTicketEventName(e.target.value)}
                  placeholder="Name of the event..."
                />
              </div>
              <div className="space-y-1">
                <Label>Event Date</Label>
                <Input
                  type="date"
                  value={ticketDate}
                  onChange={(e) => setTicketDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Venue / Location</Label>
                <Input
                  value={ticketVenue}
                  onChange={(e) => setTicketVenue(e.target.value)}
                  placeholder="Where is the event held..."
                />
              </div>
              <div className="space-y-1">
                <Label>Quantity Available</Label>
                <Input
                  type="number"
                  min="1"
                  value={ticketQuantity}
                  onChange={(e) => setTicketQuantity(e.target.value)}
                  placeholder="Number of tickets..."
                />
              </div>
              <div className="space-y-1">
                <Label>Ticket Price (required)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={ticketPrice}
                    onChange={(e) => setTicketPrice(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Trip Details ──────────────────────────────────────────────── */}
        {offeringType === "trip" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="h-5 w-5" />Trip Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Offer transportation or a shared ride</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Origin</Label>
                <Input
                  value={tripOrigin}
                  onChange={(e) => setTripOrigin(e.target.value)}
                  placeholder="Departure location..."
                />
              </div>
              <div className="space-y-1">
                <Label>Destination</Label>
                <Input
                  value={tripDestination}
                  onChange={(e) => setTripDestination(e.target.value)}
                  placeholder="Arrival location..."
                />
              </div>
              <div className="space-y-1">
                <Label>Departure Date</Label>
                <Input
                  type="date"
                  value={tripDate}
                  onChange={(e) => setTripDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Available Seats</Label>
                <Input
                  type="number"
                  min="1"
                  value={tripCapacity}
                  onChange={(e) => setTripCapacity(e.target.value)}
                  placeholder="Number of seats..."
                />
              </div>
              <div className="space-y-1">
                <Label>Price per Seat (optional)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={tripPrice}
                    onChange={(e) => setTripPrice(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                  />
                </div>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Skill Details ──────────────────────────────────────────────── */}
        {offeringType === "skill" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Wrench className="h-5 w-5" />Skill Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Share your knowledge and expertise</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Area of Expertise</Label>
                <Input
                  value={skillArea}
                  onChange={(e) => setSkillArea(e.target.value)}
                  placeholder="e.g., Web Development, Carpentry, Music..."
                />
              </div>
              <div className="space-y-1">
                <Label>Proficiency Level</Label>
                <Select value={skillProficiency} onValueChange={setSkillProficiency}>
                  <SelectTrigger><SelectValue placeholder="Select proficiency..." /></SelectTrigger>
                  <SelectContent>
                    {SKILL_PROFICIENCY_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>{level}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Hourly Rate (optional)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={skillRate}
                    onChange={(e) => setSkillRate(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                  />
                </div>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Resource Details ──────────────────────────────────────────────── */}
        {offeringType === "resource" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Package className="h-5 w-5" />Resource Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Offer tools, materials, or equipment</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Category</Label>
                <Select value={resourceCategory} onValueChange={setResourceCategory}>
                  <SelectTrigger><SelectValue placeholder="Select category..." /></SelectTrigger>
                  <SelectContent>
                    {RESOURCE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Availability</Label>
                <Select value={resourceAvailability} onValueChange={setResourceAvailability}>
                  <SelectTrigger><SelectValue placeholder="Select availability..." /></SelectTrigger>
                  <SelectContent>
                    {RESOURCE_AVAILABILITY.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Condition</Label>
                <Select value={resourceCondition} onValueChange={setResourceCondition}>
                  <SelectTrigger><SelectValue placeholder="Select condition..." /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_CONDITIONS.map((cond) => (
                      <SelectItem key={cond} value={cond}>{cond}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Price (optional)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={resourcePrice}
                    onChange={(e) => setResourcePrice(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                  />
                </div>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Data Details ──────────────────────────────────────────────── */}
        {offeringType === "data" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Database className="h-5 w-5" />Data Details
              </CardTitle>
              <p className="text-sm text-muted-foreground">Share information, reports, or datasets</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {titleField}
              {descriptionField}
              <div className="space-y-1">
                <Label>Format</Label>
                <Select value={dataFormat} onValueChange={setDataFormat}>
                  <SelectTrigger><SelectValue placeholder="Select format..." /></SelectTrigger>
                  <SelectContent>
                    {DATA_FORMATS.map((fmt) => (
                      <SelectItem key={fmt} value={fmt}>{fmt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Approximate Size</Label>
                <Input
                  value={dataSize}
                  onChange={(e) => setDataSize(e.target.value)}
                  placeholder="e.g., 50 pages, 2MB, 10,000 rows..."
                />
              </div>
              <div className="space-y-1">
                <Label>Price (optional)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={dataPrice}
                    onChange={(e) => setDataPrice(e.target.value)}
                    className="pl-10"
                    placeholder="0.00"
                  />
                </div>
              </div>
              {currencyField}
              {acceptedCurrenciesField}
              {quantityField}
              {tagsField}
            </CardContent>
          </Card>
        )}

        {/* ── Section 1: Items Picker (Optional) ─────────────────────────── */}
        <div className="space-y-2">
          <Label>Bundle Existing Resources (Optional)</Label>
          <p className="text-xs text-muted-foreground">Optionally attach your existing resources to this offering</p>
          {selectedItems.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selectedItems.map((item) => (
                <Badge
                  key={item.resourceId}
                  variant="secondary"
                  className="flex items-center gap-1"
                >
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs ${RESOURCE_TYPE_COLOR[item.resource.type] ?? ""}`}
                  >
                    {RESOURCE_TYPE_ICON[item.resource.type]}
                    {capitalize(item.resource.type)}
                  </span>
                  <span className="ml-1">{item.resource.name}</span>
                  <button
                    type="button"
                    onClick={() => removeItem(item.resourceId)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                    <span className="sr-only">Remove</span>
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <ItemSearchDropdown
            resources={filteredResources}
            loading={resourcesLoading}
            search={itemSearch}
            onSearchChange={setItemSearch}
            onSelect={(r) => {
              addItem(r)
              setItemSearch("")
            }}
          />
        </div>

        {/* ── Section 2: Terms per item ──────────────────────────────────── */}
        {selectedItems.length > 0 && (
          <div className="space-y-3">
            <Label>Terms per item</Label>
            {selectedItems.map((item) => {
              const terms = getAllowedTerms(item.resource)
              return (
                <div
                  key={item.resourceId}
                  className="flex items-center gap-3 rounded-md border p-3"
                >
                  <span className="text-sm font-medium min-w-[120px] truncate">
                    {item.resource.name}
                  </span>
                  <Select
                    value={item.term}
                    onValueChange={(v) => updateItemTerm(item.resourceId, v)}
                  >
                    <SelectTrigger className="w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {terms.map((t) => (
                        <SelectItem key={t} value={t}>
                          {capitalize(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {PRICED_TERMS.has(item.term) && (
                    <div className="relative w-[120px]">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        $
                      </span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        className="pl-7"
                        placeholder="0.00"
                        value={
                          item.priceCents !== undefined
                            ? (item.priceCents / 100).toFixed(2)
                            : ""
                        }
                        onChange={(e) =>
                          updateItemPrice(item.resourceId, e.target.value)
                        }
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Generic Title / Description / Pricing / Tags (hidden for service & product) ── */}
        {!isInlineDetailsType && (
          <>
            <div className="space-y-2">
              <Label htmlFor="offering-title">Title</Label>
              <Input
                id="offering-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setTitleManuallyEdited(true)
                }}
                placeholder="Offering title"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="offering-description">Description</Label>
              <Textarea
                id="offering-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what you're offering..."
                rows={4}
              />
            </div>

            {/* ── Pricing ────────────────────────────────────────────────────── */}
            <div className="space-y-4">
              <div className="flex items-center space-x-2">
                <Switch id="has-price" checked={hasPrice} onCheckedChange={setHasPrice} />
                <Label htmlFor="has-price">Set a price for this offering</Label>
              </div>
              {hasPrice && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Price</Label>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input type="number" min="0" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} className="pl-10" placeholder="0.00" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Primary Price Currency</Label>
                    <Select value={currency} onValueChange={setCurrency}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {acceptedCurrenciesField}
              {quantityField}
            </div>

            {/* ── Tags ───────────────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label htmlFor="offering-tags">Tags</Label>
              <Input id="offering-tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="Comma-separated tags..." />
              <p className="text-xs text-muted-foreground">e.g., gardening, organic, local</p>
            </div>
          </>
        )}

        {/* ── Post this offering (unified: locales, groups, people, deal toggle) ── */}
        {scopeMode === "internal" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Send className="h-5 w-5" />Post this offering
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Choose where and how to share this offering
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <LocalePicker
                locales={resolvedLocales}
                selectedLocaleIds={selectedLocaleIds}
                onToggle={toggleLocale}
                onRemove={removeLocale}
              />

              <div className="space-y-2">
                <Label>Offer this as</Label>
                <SearchableSelect
                  value={ownerId}
                  onChange={setOwnerId}
                  placeholder="Choose owner"
                  searchPlaceholder="Search groups..."
                  emptyLabel="No managed groups found."
                  options={[
                    { value: "self", label: session?.user?.name || "My profile", description: "Offer as yourself" },
                    ...manageableGroups.map((group) => ({
                      value: group.id,
                      label: group.name,
                      description: group.description ?? group.groupType ?? "Managed group",
                      keywords: [group.groupType ?? ""],
                    })),
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  Choose whether this offering is yours personally or belongs to a group you manage.
                </p>
              </div>

              <AgentTypeSearchSelect
                agentType="group"
                label="Groups"
                icon={Building2}
                selectedAgents={targetAgents}
                onAdd={addTargetAgent}
                onRemove={removeTargetAgent}
              />

              <AgentTypeSearchSelect
                agentType="person"
                label="People"
                icon={Users}
                selectedAgents={targetAgents}
                onAdd={addTargetAgent}
                onRemove={removeTargetAgent}
              />

              <div className="flex items-center space-x-2">
                <Switch
                  id="post-to-feed"
                  checked={postToFeed}
                  onCheckedChange={setPostToFeed}
                />
                <Label htmlFor="post-to-feed">
                  Post offering to feeds for selected locales and groups
                </Label>
              </div>

              <div className="space-y-3 pt-2 border-t">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="has-deal"
                    checked={hasDeal}
                    onCheckedChange={setHasDeal}
                  />
                  <Label htmlFor="has-deal" className="flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    Post this offering with a deal
                  </Label>
                </div>
                {hasDeal && (
                  <div className="grid grid-cols-2 gap-4 pl-6">
                    <div className="space-y-1">
                      <Label>Deal Price</Label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={dealPrice}
                          onChange={(e) => setDealPrice(e.target.value)}
                          className="pl-10"
                          placeholder="0.00"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">Discounted price for the deal</p>
                    </div>
                    <div className="space-y-1">
                      <Label>Deal Duration</Label>
                      <Select
                        value={String(dealDurationHours)}
                        onValueChange={(v) => setDealDurationHours(Number(v))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DEAL_DURATION_OPTIONS.map((opt) => (
                            <SelectItem key={opt.hours} value={String(opt.hours)}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">How long the deal lasts</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Submit / Cancel ────────────────────────────────────────────────── */}
      <div className="flex justify-end gap-4">
        <Button type="button" variant="outline" onClick={() => (onCancel ? onCancel() : router.back())}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : submitLabel}
        </Button>
      </div>

    </form>

    {/* Subscription gate dialog for paid offering creation */}
    <SubscriptionGateDialog
      open={showSubscriptionGate}
      onOpenChange={(open) => {
        setShowSubscriptionGate(open)
        if (!open) setPendingPayloadAfterGate(null)
      }}
      requiredTier={gateRequiredTier}
      featureDescription={FEATURE_DESCRIPTIONS.PAID_OFFERINGS}
      onTrialStarted={handleRetryAfterTrial}
    />
    </>
  )
}
