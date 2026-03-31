"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { GroupType, JoinType, type GroupJoinSettings } from "@/lib/types"
import {
  createBadgeResourceAction,
  createLiveClassAction,
  createEventResource,
  createGroupResource,
  createProjectResource,
} from "@/app/actions/create-resources"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveTabsList } from "@/components/responsive-tabs-list"
import { CreatePost } from "@/components/create-post"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Calendar, Clock, MapPin, DollarSign, ImageIcon, Users, Building2, Plus, X, AlertCircle, Briefcase, Eye, Globe, Loader2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { useHomeFeed, useLocalesAndBasins } from "@/lib/hooks/use-graph-data"
import { useAppContext } from "@/contexts/app-context"
import { LocationAutocompleteInput } from "@/components/location-autocomplete-input"
import { VisibilityScopeSelector, type VisibilityScopeState } from "@/components/visibility-scope-selector"
import { SearchableSelect } from "@/components/searchable-select"
import dynamic from "next/dynamic"
import { defaultEftValues, defaultCapitalValues, defaultAuditValues, type EftValues, type CapitalValues, type AuditValues } from "@/components/eft-picker"

const EftPicker = dynamic(() => import("@/components/eft-picker").then((mod) => ({ default: mod.EftPicker })), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse bg-muted rounded" />,
})

const Ecosocial3dPlot = dynamic(() => import("@/components/ecosocial-3d-plot").then((mod) => ({ default: mod.Ecosocial3dPlot })), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse bg-muted rounded" />,
})
import {
  fetchGroupDetail,
  fetchMarketplaceListings,
  fetchPublicResources,
} from "@/app/actions/graph"
import { fetchManagedGroupsAction } from "@/app/actions/event-form"
import type { SerializedResource } from "@/lib/graph-serializers"
import { getLocalResourcesByType, type LocalResource } from "@/lib/local-db"
import {
  getSubscriptionStatusAction,
} from "@/app/actions/billing"
import { CreateOfferingModal } from "@/components/create-offering-modal"
import type { OfferingDraftPayload } from "@/components/create-offering-form"
import { JoinQuestionEditor } from "@/components/join-question-editor"
import { SubscriptionGateDialog } from "@/components/subscription-gate-dialog"
import { FEATURE_TIER_REQUIREMENTS, FEATURE_DESCRIPTIONS } from "@/lib/subscription-constants"
import type { MembershipTier } from "@/db/schema"

const THANKS_VOUCHER_FLOW_KEY = "rivr:thanks-voucher-flow"
const PENDING_ORG_CREATION_KEY = "rivr:pending-org-creation"

/**
 * Client-side create workspace for composing posts, events, projects, groups, and marketplace listings.
 *
 * Route: `/create`
 * Rendering: Client Component (`"use client"`); uses browser hooks, local form state, and client navigation.
 * Data requirements:
 * - Home feed entities (`useHomeFeed`) for selectable groups/rings.
 * - Locales/basins (`useLocalesAndBasins`) for locale scope selectors.
 * - Supplemental resources fetched on mount (`fetchMarketplaceListings`, `fetchPublicResources`).
 *
 * Metadata: This page file does not export `metadata` or `generateMetadata`.
 */
/**
 * Renders the multi-tab creation interface and handles all create-form submission workflows.
 *
 * @returns Create page UI with tabbed forms and subscription-gated ticketing flow.
 */
export default function CreatePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { state: appState, setSelectedChapter } = useAppContext()
  const { data: homeData } = useHomeFeed(500, "all")
  const { data: localeData } = useLocalesAndBasins()

  // Read URL parameters once for initialization
  const urlTab = searchParams.get('tab')
  const urlParent = searchParams.get('parent')
  const urlGroup = searchParams.get('group')
  const urlProject = searchParams.get('project')
  const urlType = searchParams.get('type')
  const urlOffering = searchParams.get('offering')
  const urlTitle = searchParams.get('title')
  const urlDescription = searchParams.get('description')
  const urlLocation = searchParams.get('location')
  const urlReturnToThanks = searchParams.get('returnToThanks') === '1'
  const urlReturnPath = searchParams.get('returnPath')
  const resumeGroupCreation = searchParams.get('resumeGroupCreation') === '1'
  const isLiveClass = urlType === 'live-class'
  const supportedCreateTabs = new Set(["post", "event", "project", "group"])
  const initialCreateTab = urlTab === "job"
    ? "project"
    : urlTab && supportedCreateTabs.has(urlTab)
      ? urlTab
      : "post"
  const initialGroupType = (() => {
    if (urlType === "group") return "basic"
    if (urlType === "org" || urlType === "ring" || urlType === "family" || urlType === "basic") return urlType
    return "basic"
  })()

  const [activeTab, setActiveTab] = useState(initialCreateTab)

  // Event form state - initialize from URL params where applicable
  const [eventTitle, setEventTitle] = useState(() => isLiveClass && urlTitle ? decodeURIComponent(urlTitle) : "")
  const [eventDescription, setEventDescription] = useState(() => isLiveClass && urlDescription ? decodeURIComponent(urlDescription) : "")
  const [eventDate, setEventDate] = useState("")
  const [eventTime, setEventTime] = useState("")
  const [eventLocation, setEventLocation] = useState(() => isLiveClass && urlLocation ? decodeURIComponent(urlLocation) : "")
  const [eventType, setEventType] = useState(() => isLiveClass ? "in-person" : "in-person") // "in-person" or "online"
  const [postEventAsGroup, setPostEventAsGroup] = useState(() => Boolean(urlGroup))
  const [selectedVenue, setSelectedVenue] = useState("none")
  const [venueStartTime, setVenueStartTime] = useState("")
  const [venueEndTime, setVenueEndTime] = useState("")
  const [eventGroup, setEventGroup] = useState(() => urlGroup || "none")
  const [eventProject, setEventProject] = useState("none")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showMembershipGate, setShowMembershipGate] = useState(false)
  const [gateRequiredTier, setGateRequiredTier] = useState<MembershipTier>(FEATURE_TIER_REQUIREMENTS.PAID_EVENTS)
  const [gateFeatureDescription, setGateFeatureDescription] = useState<string>(FEATURE_DESCRIPTIONS.PAID_EVENTS)
  const [gateAction, setGateAction] = useState<"event" | "group">("event")
  const [eventGroupProjects, setEventGroupProjects] = useState<Array<{ id: string; name: string }>>([])
  const [manageableGroups, setManageableGroups] = useState<Array<{ id: string; name: string; description: string | null; groupType: string | null }>>([])
  const [eventVisibilityScope, setEventVisibilityScope] = useState<VisibilityScopeState>({
    localeIds: [],
    groupIds: [],
    userIds: [],
  })
  const [eventIsGlobal, setEventIsGlobal] = useState(true)
  const [liveVenueResources, setLiveVenueResources] = useState<SerializedResource[]>([])
  const [liveBadges, setLiveBadges] = useState<SerializedResource[]>([])
  const [venuesLoading, setVenuesLoading] = useState(true)
  const [badgesLoading, setBadgesLoading] = useState(true)
  const hasResumedGroupCreationRef = useRef(false)
  const [eventTickets, setEventTickets] = useState<Array<{
    id: string
    name: string
    description: string
    price: string
    quantity: string
  }>>([
    {
      id: "general-admission",
      name: "General Admission",
      description: "",
      price: "",
      quantity: "",
    },
  ])

  // Event image upload state
  const [eventImageUrl, setEventImageUrl] = useState<string | null>(null)
  const [isEventImageUploading, setIsEventImageUploading] = useState(false)
  const eventImageInputRef = useRef<HTMLInputElement>(null)

  // EFT (Ecological Footprint) state — shared across event/project/group tabs
  const [eftValues, setEftValues] = useState<EftValues>(defaultEftValues)
  const [capitalValues, setCapitalValues] = useState<CapitalValues>(defaultCapitalValues)
  const [auditValues, setAuditValues] = useState<AuditValues>(defaultAuditValues)

  // Group form state - initialize parent from URL params
  const [groupName, setGroupName] = useState("")
  const [groupDescription, setGroupDescription] = useState("")
  const [groupType, setGroupType] = useState(initialGroupType)
  const [legalWrapper, setLegalWrapper] = useState("llc")
  const [groupChapter, setGroupChapter] = useState("boulder")
  const [groupParent, setGroupParent] = useState(() => urlParent || "none")

  // Project form state - initialize group from URL params
  const [projectTitle, setProjectTitle] = useState("")
  const [projectDescription, setProjectDescription] = useState("")
  const [projectCategory, setProjectCategory] = useState("")
  const [projectTimeframeStart, setProjectTimeframeStart] = useState("")
  const [projectTimeframeEnd, setProjectTimeframeEnd] = useState("")
  const [projectBudget, setProjectBudget] = useState("")
  const [projectGroup, setProjectGroup] = useState(() => urlGroup || "")
  const [projectVisibilityScope, setProjectVisibilityScope] = useState<VisibilityScopeState>({
    localeIds: [],
    groupIds: [],
    userIds: [],
  })
  const [projectIsGlobal, setProjectIsGlobal] = useState(true)
  const [projectVenue, setProjectVenue] = useState("none")
  const [projectVenueStartTime, setProjectVenueStartTime] = useState("")
  const [projectVenueEndTime, setProjectVenueEndTime] = useState("")
  const [showCreateVenueModal, setShowCreateVenueModal] = useState(false)
  const [showCreateVoucherModal, setShowCreateVoucherModal] = useState(urlOffering === "voucher")

  const [groupVisibilityScope, setGroupVisibilityScope] = useState<VisibilityScopeState>({
    localeIds: [],
    groupIds: [],
    userIds: [],
  })
  const [groupIsGlobal, setGroupIsGlobal] = useState(true)
  const [groupJoinSettings, setGroupJoinSettings] = useState<GroupJoinSettings>({
    joinType: JoinType.Public,
    visibility: "public",
    approvalRequired: false,
    passwordRequired: false,
    questions: [],
  })
  const [groupPassword, setGroupPassword] = useState("")

  const liveGroups = useMemo(() => homeData.groups, [homeData.groups])
  const liveRings = useMemo(
    () => liveGroups.filter((group) => group.type === GroupType.Ring),
    [liveGroups]
  )

  // Client-side data fetching for venue and badge resource pickers used by event/project/job flows.
  useEffect(() => {
    setShowCreateVoucherModal(urlOffering === "voucher")
  }, [urlOffering])

  useEffect(() => {
    let cancelled = false

    // Phase 1: Instant read from IndexedDB for venue/badge pickers.
    const localResourceToSerialized = (r: LocalResource): SerializedResource => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description,
      content: r.content,
      url: r.url,
      ownerId: r.ownerId,
      isPublic: r.isPublic,
      metadata: r.metadata,
      tags: r.tags,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })

    Promise.all([
      getLocalResourcesByType("listing", 500).catch(() => [] as LocalResource[]),
      getLocalResourcesByType("badge", 500).catch(() => [] as LocalResource[]),
    ]).then(([localListings, localBadges]) => {
      if (cancelled) return
      if (localListings.length > 0) {
        const venues = localListings.filter((r) => {
          const meta = r.metadata ?? {}
          return r.type === "venue" || String(meta.resourceKind ?? "").toLowerCase() === "venue" || meta.isVenue === true
        })
        if (venues.length > 0) setLiveVenueResources(venues.map(localResourceToSerialized))
      }
      if (localBadges.length > 0) {
        setLiveBadges(localBadges.map(localResourceToSerialized))
      }
    })

    // Phase 2: Authoritative server fetch for fresh data.
    fetchMarketplaceListings(500)
      .then((rows) => {
        if (cancelled) return
        const venues = rows.filter((resource) => {
          const meta = (resource.metadata ?? {}) as Record<string, unknown>
          return (
            resource.type === "venue" ||
            String(meta.resourceKind ?? "").toLowerCase() === "venue" ||
            meta.isVenue === true
          )
        })
        setLiveVenueResources(venues as SerializedResource[])
        setVenuesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLiveVenueResources([])
        setVenuesLoading(false)
      })

    fetchPublicResources(500)
      .then((rows) => {
        if (cancelled) return
        const badges = rows.filter((resource) => {
          const meta = (resource.metadata ?? {}) as Record<string, unknown>
          return resource.type === "badge" || String(meta.resourceKind ?? "").toLowerCase() === "badge"
        })
        setLiveBadges(badges as SerializedResource[])
        setBadgesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLiveBadges([])
        setBadgesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchManagedGroupsAction()
      .then((groups) => {
        if (!cancelled) setManageableGroups(groups)
      })
      .catch(() => {
        if (!cancelled) setManageableGroups([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const selectedLocaleId = appState.selectedChapter
    if (!selectedLocaleId || selectedLocaleId === "all") return

    setEventVisibilityScope((prev) =>
      prev.localeIds.length > 0 ? prev : { ...prev, localeIds: [selectedLocaleId] }
    )
    setProjectVisibilityScope((prev) =>
      prev.localeIds.length > 0 ? prev : { ...prev, localeIds: [selectedLocaleId] }
    )
    setGroupVisibilityScope((prev) =>
      prev.localeIds.length > 0 ? prev : { ...prev, localeIds: [selectedLocaleId] }
    )
    setGroupChapter((prev) => (prev && prev !== "boulder" ? prev : selectedLocaleId))
  }, [appState.selectedChapter])

  // Refetch projects whenever the selected event group changes so the project selector stays scoped.
  useEffect(() => {
    let cancelled = false
    if (!eventGroup || eventGroup === "none") {
      return
    }

    fetchGroupDetail(eventGroup)
      .then((detail) => {
        if (cancelled || !detail) return
        const projects = detail.resources
          .filter((resource) => {
            const meta = (resource.metadata ?? {}) as Record<string, unknown>
            return resource.type === "project" || String(meta.resourceKind ?? "").toLowerCase() === "project"
          })
          .map((project) => ({ id: project.id, name: project.name }))
        setEventGroupProjects(projects)
      })
      .catch(() => {
        if (cancelled) return
        setEventGroupProjects([])
      })

    return () => {
      cancelled = true
    }
  }, [eventGroup])

  /**
   * Updates selected event group and clears the currently selected project.
   *
   * @param newGroup Group identifier selected in the event form.
   */
  const handleEventGroupChange = (newGroup: string) => {
    setEventGroup(newGroup)
    setEventProject("none")
    if (!newGroup || newGroup === "none") {
      setEventGroupProjects([])
    }
  }

  const eventPublishingGroups = useMemo(() => {
    const merged = new Map<string, { id: string; name: string; description: string | null; groupType: string | null }>()

    for (const group of manageableGroups) {
      merged.set(group.id, group)
    }

    for (const group of liveGroups) {
      if (!merged.has(group.id)) {
        merged.set(group.id, {
          id: group.id,
          name: group.name,
          description: group.description ?? null,
          groupType: typeof group.type === "string" ? group.type : null,
        })
      }
    }

    if (urlGroup && !merged.has(urlGroup)) {
      const contextualGroup = liveGroups.find((group) => group.id === urlGroup)
      if (contextualGroup) {
        merged.set(contextualGroup.id, {
          id: contextualGroup.id,
          name: contextualGroup.name,
          description: contextualGroup.description ?? null,
          groupType: typeof contextualGroup.type === "string" ? contextualGroup.type : null,
        })
      }
    }

    return [...merged.values()]
  }, [liveGroups, manageableGroups, urlGroup])

  const updateEventTicket = (
    ticketId: string,
    field: "name" | "description" | "price" | "quantity",
    fieldValue: string,
  ) => {
    setEventTickets((current) =>
      current.map((ticket) => (ticket.id === ticketId ? { ...ticket, [field]: fieldValue } : ticket))
    )
  }

  const addEventTicket = () => {
    setEventTickets((current) => [
      ...current,
      {
        id: `ticket-${Date.now()}`,
        name: "",
        description: "",
        price: "",
        quantity: "",
      },
    ])
  }

  const removeEventTicket = (ticketId: string) => {
    setEventTickets((current) => (current.length === 1 ? current : current.filter((ticket) => ticket.id !== ticketId)))
  }

  const handleVenueOfferingCreated = (result: { resourceId?: string; payload: OfferingDraftPayload }) => {
    const resourceId = result.resourceId
    if (!resourceId) {
      toast({
        title: "Venue draft created",
        description: "The venue offering was created, but the live venue list will refresh after save.",
      })
      return
    }

    const selectedOwner =
      eventPublishingGroups.find((group) => group.id === projectGroup) ??
      eventPublishingGroups.find((group) => group.id === eventGroup)

    const venueResource: SerializedResource = {
      id: resourceId,
      name: result.payload.title,
      type: "venue",
      description: result.payload.description,
      content: result.payload.description,
      url: null,
      ownerId: selectedOwner?.id ?? projectGroup ?? eventGroup ?? "",
      isPublic: true,
      metadata: {
        resourceKind: "venue",
        venue: {
          name: result.payload.title,
          location: result.payload.ticketVenue ?? (eventLocation || null),
          hourlyRate: result.payload.hourlyRate ?? result.payload.basePrice ?? result.payload.resourcePrice ?? 0,
        },
      },
      tags: result.payload.tags ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    setLiveVenueResources((current) => {
      const next = [venueResource, ...current.filter((resource) => resource.id !== resourceId)]
      return next
    })
    setProjectVenue(resourceId)
    setSelectedVenue(resourceId)
    setShowCreateVenueModal(false)
    toast({
      title: "Venue created",
      description: "The new venue offering is now available for booking.",
    })
  }

  const returnToThanksVoucherFlow = (result?: { resourceId?: string; payload: OfferingDraftPayload }) => {
    if (typeof window !== "undefined") {
      const raw = window.sessionStorage.getItem(THANKS_VOUCHER_FLOW_KEY)
      if (raw) {
        try {
          const pending = JSON.parse(raw) as Record<string, unknown>
          window.sessionStorage.setItem(
            THANKS_VOUCHER_FLOW_KEY,
            JSON.stringify({
              ...pending,
              createdVoucherId: result?.resourceId,
              reopen: true,
            }),
          )
        } catch {
          window.sessionStorage.removeItem(THANKS_VOUCHER_FLOW_KEY)
        }
      }
    }

    setShowCreateVoucherModal(false)
    router.push(urlReturnPath || "/")
  }

  /**
   * Updates the global chapter/locale used by post creation.
   *
   * @param localeId Locale identifier selected in the Post tab.
   */
  const handlePostLocaleChange = (localeId: string) => {
    setSelectedChapter(localeId)
  }
  // Types for job/task/badge creation forms
  type TaskFormData = {
    id: string
    name: string
    description: string
    estimatedTime: number
    points: number
    required: boolean
  }

  type JobFormData = {
    id: string
    title: string
    description: string
    location: string
    startTime: string
    endTime: string
    category: string
    priority: "low" | "medium" | "high"
    maxAssignees: number
    tasks: TaskFormData[]
    skills: string[]
    requiredBadges: string[]
    duration: string
    totalPoints: number
    status: string
    assignees: string[]
    createdAt: string
  }

  type TrainingModule = {
    id: string
    title: string
    description: string
    type: "video" | "reading" | "quiz" | "assignment"
    content: string
    duration: number
    order: number
  }

  type LiveClassData = {
    title: string
    description: string
    date: string
    duration: number
  }

  const [projectJobs, setProjectJobs] = useState<JobFormData[]>([])
  const [showJobCreation, setShowJobCreation] = useState(() => urlTab === "job")
  const [currentJob, setCurrentJob] = useState({
    title: "",
    description: "",
    location: "",
    startTime: "",
    endTime: "",
    category: "",
    priority: "medium" as "low" | "medium" | "high",
    maxAssignees: 1,
    tasks: [] as TaskFormData[],
    skills: [] as string[],
    requiredBadges: [] as string[]
  })
  const [currentTask, setCurrentTask] = useState({
    name: "",
    description: "",
    estimatedTime: 30,
    points: 10,
    required: true,
  })
  const [newSkill, setNewSkill] = useState("")
  const [showBadgeCreation, setShowBadgeCreation] = useState(false)
  const [newBadge, setNewBadge] = useState({
    name: "",
    description: "",
    icon: "",
    level: "beginner" as "beginner" | "intermediate" | "advanced" | "expert",
    category: "",
    requirements: [] as string[],
    trainingModules: [] as TrainingModule[],
    liveClass: null as LiveClassData | null
  })
  const [showLiveClassDialog, setShowLiveClassDialog] = useState(false)
  const [liveClassForm, setLiveClassForm] = useState({
    title: "",
    description: "",
    date: "",
    durationMinutes: 60,
    maxParticipants: 20,
    location: "",
    tasks: [] as Array<{ name: string; description: string; required: boolean }>,
  })
  const [newLiveClassTask, setNewLiveClassTask] = useState({ name: "", description: "", required: true })
  const [liveClassSubmitting, setLiveClassSubmitting] = useState(false)

  useEffect(() => {
    if (urlTab !== "job") return
    setActiveTab("project")
    setShowJobCreation(true)
    if (urlGroup) {
      setProjectGroup(urlGroup)
    }
    if (urlProject && urlProject.trim().length > 0) {
      setProjectTitle((prev) => (prev.trim().length > 0 ? prev : "Add Job to Existing Project"))
    }
  }, [urlGroup, urlProject, urlTab])
  const [currentTrainingModule, setCurrentTrainingModule] = useState({
    id: "",
    title: "",
    description: "",
    type: "video" as "video" | "reading" | "quiz" | "assignment",
    content: "",
    duration: 0,
    order: 0
  })
  
  // Define the GroupFeature type
  type GroupFeature = {
    name: string;
    description: string;
  }

  // Define the GroupTypeFeatures type
  type GroupTypeFeatures = {
    [key: string]: GroupFeature[];
  }

  // Group type features mapping
  const groupTypeFeatures: GroupTypeFeatures = {
    basic: [
      { name: "About", description: "Group information" },
      { name: "Feed", description: "Discussion board" },
      { name: "Events", description: "Event scheduling" },
      { name: "Groups", description: "Connected groups" },
      { name: "Members", description: "Member directory" }
    ],
    org: [
      { name: "About", description: "Organization information" },
      { name: "Feed", description: "Discussion board" },
      { name: "Events", description: "Event management" },
      { name: "Mart", description: "Buy and sell items" },
      { name: "Jobs", description: "Employment opportunities" },
      { name: "Badges", description: "Recognition system" },
      { name: "Members", description: "Member directory" },
      { name: "Groups", description: "Subgroups" },
      { name: "Governance", description: "Decision-making" },
      { name: "Stake", description: "Resource investment" },
      { name: "Treasury", description: "Financial management" }
    ],
    ring: [
      { name: "Feed", description: "Community discussions" },
      { name: "Families", description: "Family groups" },
      { name: "Mutual Assets", description: "Shared community assets" },
      { name: "Voucher Pool", description: "Community credit system" },
      { name: "Treasury", description: "Shared financial resources" },
      { name: "Governance", description: "Community decision-making" },
      { name: "About", description: "Ring information" },
      { name: "Admins", description: "Management team" }
    ],
    family: [
      { name: "Feed", description: "Family conversations" },
      { name: "Members", description: "Family directory" },
      { name: "Treasury", description: "Shared finances" },
      { name: "Activity", description: "Recent actions" },
      { name: "About", description: "Family information" },
      { name: "Admins", description: "Family administrators" }
    ]
  }

  /**
   * Handles event image file selection and uploads to the server.
   * Sets the uploaded URL into eventImageUrl state on success.
   */
  const handleEventImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsEventImageUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("bucket", "uploads")

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        throw new Error(errorData?.error ?? `Upload failed with status ${response.status}`)
      }

      const data = await response.json()
      const uploadedUrl: string | undefined = data.results?.[0]?.url
      if (!uploadedUrl) {
        throw new Error("Upload succeeded but no URL was returned")
      }

      setEventImageUrl(uploadedUrl)
    } catch (error) {
      toast({
        title: "Image upload failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsEventImageUploading(false)
      if (eventImageInputRef.current) {
        eventImageInputRef.current.value = ""
      }
    }
  }

  /**
   * Retries event creation after subscription trial is started from the gate dialog.
   */
  const handleEventTrialStarted = () => {
    setShowMembershipGate(false)
    handleCreateEvent(true)
  }

  const persistPendingOrganizationDraft = () => {
    if (typeof window === "undefined") return

    const normalizedGroupLocales = groupVisibilityScope.localeIds.length > 0
      ? groupVisibilityScope.localeIds
      : appState.selectedChapter
        ? [appState.selectedChapter]
        : []

    window.sessionStorage.setItem(PENDING_ORG_CREATION_KEY, JSON.stringify({
      name: groupName,
      description: groupDescription,
      groupType,
      legalWrapper,
      chapter: normalizedGroupLocales[0] ?? "",
      scopedLocaleIds: normalizedGroupLocales,
      scopedGroupIds: groupVisibilityScope.groupIds,
      scopedUserIds: groupVisibilityScope.userIds,
      isGlobal: groupIsGlobal,
      parentGroupId: groupParent !== "none" ? groupParent : null,
      joinSettings: groupJoinSettings,
      groupPassword: groupJoinSettings.passwordRequired ? groupPassword : null,
      features: groupTypeFeatures[groupType as keyof typeof groupTypeFeatures] ?? [],
      eftValues: Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
      capitalValues: Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
      auditValues: Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
    }))
  }

  const clearPendingOrganizationDraft = () => {
    if (typeof window === "undefined") return
    window.sessionStorage.removeItem(PENDING_ORG_CREATION_KEY)
  }

  const handleGroupTrialStarted = async () => {
    setShowMembershipGate(false)
    await handleCreateGroup()
  }

  /**
   * Validates and submits event creation.
   * Applies subscription gating for paid ticketed events and redirects to the created event route on success.
   *
   * @param skipMembershipGate When `true`, bypasses the subscription pre-check (used after starting trial).
   */
  const handleCreateEvent = async (skipMembershipGate = false) => {
    if (!eventTitle || !eventDescription || !eventDate || !eventTime || !eventLocation) {
      toast({
        title: "Missing information",
        description: "Please fill in all required fields.",
        variant: "destructive",
      })
      return
    }
    if (postEventAsGroup && (!eventGroup || eventGroup === "none")) {
      toast({
        title: "Select a group",
        description: "Choose which group should publish this event.",
        variant: "destructive",
      })
      return
    }

    const normalizedTickets = eventTickets
      .map((ticket) => ({
        id: ticket.id,
        name: ticket.name.trim(),
        description: ticket.description.trim(),
        price: ticket.price.trim() ? Number.parseFloat(ticket.price.trim()) : 0,
        quantity: ticket.quantity.trim() ? Number.parseInt(ticket.quantity.trim(), 10) : null,
      }))
      .filter((ticket) => ticket.name.length > 0)
    const isPaidTicketedEvent = normalizedTickets.some((ticket) => Number.isFinite(ticket.price) && ticket.price > 0)
    const primaryLocaleId = eventVisibilityScope.localeIds[0] ?? null

    // Subscription gate: paid ticketed events require a Host membership (or higher).
    if (isPaidTicketedEvent && !skipMembershipGate) {
      const sub = await getSubscriptionStatusAction().catch(() => null)
      if (!sub) {
        setGateRequiredTier(FEATURE_TIER_REQUIREMENTS.PAID_EVENTS)
        setGateFeatureDescription(FEATURE_DESCRIPTIONS.PAID_EVENTS)
        setGateAction("event")
        setShowMembershipGate(true)
        return
      }
    }

    setIsSubmitting(true)
    try {
      const result = await createEventResource({
        title: eventTitle,
        description: eventDescription,
        date: eventDate,
        time: eventTime,
        location: eventLocation,
        eventType: eventType as "in-person" | "online",
        price: normalizedTickets[0] && Number.isFinite(normalizedTickets[0].price) ? normalizedTickets[0].price : null,
        imageUrl: eventImageUrl ?? undefined,
        ownerId: postEventAsGroup && eventGroup !== "none" ? eventGroup : null,
        groupId: eventGroup !== "none" ? eventGroup : null,
        projectId: eventProject !== "none" ? eventProject : null,
        venueId: selectedVenue !== "none" ? selectedVenue : null,
        venueStartTime: venueStartTime || null,
        venueEndTime: venueEndTime || null,
        localeId: primaryLocaleId,
        scopedLocaleIds: eventVisibilityScope.localeIds.length > 0 ? eventVisibilityScope.localeIds : undefined,
        scopedGroupIds: eventVisibilityScope.groupIds.length > 0 ? eventVisibilityScope.groupIds : undefined,
        scopedUserIds: eventVisibilityScope.userIds.length > 0 ? eventVisibilityScope.userIds : undefined,
        isGlobal: eventIsGlobal,
        eftValues: Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
        capitalValues: Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
        auditValues: Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
        ticketTypes: normalizedTickets,
      })

      setIsSubmitting(false)

      if (!result.success || !result.resourceId) {
        if (result.error?.code === "SUBSCRIPTION_REQUIRED") {
          const tier = (result.error.requiredTier ?? "host") as MembershipTier
          setGateRequiredTier(tier)
          setGateFeatureDescription(FEATURE_DESCRIPTIONS.PAID_EVENTS)
          setGateAction("event")
          setShowMembershipGate(true)
        }
        toast({
          title: "Failed to create event",
          description: result.error?.details ? `${result.message} ${result.error.details}` : result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Event created",
        description: "Your event has been created successfully.",
      })
      // Redirect to the created event detail page.
      router.push(`/events/${result.resourceId}`)
    } catch {
      setIsSubmitting(false)
      toast({
        title: "Failed to create event",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    }
  }

  /**
   * Appends a task draft to the current job and resets task inputs.
   */
  const addTask = () => {
    if (currentTask.name.trim()) {
      const newTask = {
        id: `task-${Date.now()}`,
        ...currentTask,
      }
      setCurrentJob(prev => ({
        ...prev,
        tasks: [...prev.tasks, newTask]
      }))
      setCurrentTask({
        name: "",
        description: "",
        estimatedTime: 30,
        points: 10,
        required: true,
      })
    }
  }

  /**
   * Removes a task from the in-progress job draft.
   *
   * @param taskId Task identifier to remove.
   */
  const removeTask = (taskId: string) => {
    setCurrentJob(prev => ({
      ...prev,
      tasks: prev.tasks.filter((task) => task.id !== taskId)
    }))
  }

  /**
   * Adds a unique required skill to the current job draft.
   */
  const addSkill = () => {
    if (newSkill.trim() && !currentJob.skills.includes(newSkill.trim())) {
      setCurrentJob(prev => ({
        ...prev,
        skills: [...prev.skills, newSkill.trim()]
      }))
      setNewSkill("")
    }
  }

  /**
   * Removes a required skill from the current job draft.
   *
   * @param skill Skill label to remove.
   */
  const removeSkill = (skill: string) => {
    setCurrentJob(prev => ({
      ...prev,
      skills: prev.skills.filter((s) => s !== skill)
    }))
  }

  /**
   * Calculates a human-readable duration from current job start/end times.
   *
   * @returns Duration string in hours or an empty string when invalid/missing.
   */
  const calculateJobDuration = () => {
    if (currentJob.startTime && currentJob.endTime) {
      const start = new Date(`2000-01-01T${currentJob.startTime}`)
      const end = new Date(`2000-01-01T${currentJob.endTime}`)
      const diffMs = end.getTime() - start.getTime()
      const diffHours = diffMs / (1000 * 60 * 60)
      return diffHours > 0 ? `${diffHours} hours` : ""
    }
    return ""
  }

  /**
   * Sums point values across all tasks in the current job draft.
   *
   * @returns Total points for the current job.
   */
  const calculateJobTotalPoints = () => {
    return currentJob.tasks.reduce((total, task) => total + task.points, 0)
  }

  /**
   * Validates the current job draft and attaches it to the project draft state.
   */
  const addJobToProject = () => {
    if (!currentJob.title.trim() || !currentJob.description.trim() || currentJob.tasks.length === 0) {
      toast({
        title: "Missing information",
        description: "Please fill in job title, description, and add at least one task.",
        variant: "destructive",
      })
      return
    }

    const newJob = {
      id: `job-${Date.now()}`,
      ...currentJob,
      duration: calculateJobDuration(),
      totalPoints: calculateJobTotalPoints(),
      status: "open",
      assignees: [],
      createdAt: new Date().toISOString(),
    }

    setProjectJobs(prev => [...prev, newJob])
    
    // Reset job form
    setCurrentJob({
      title: "",
      description: "",
      location: "",
      startTime: "",
      endTime: "",
      category: "",
      priority: "medium",
      maxAssignees: 1,
      tasks: [],
      skills: [],
      requiredBadges: []
    })
    setShowJobCreation(false)

    toast({
      title: "Job added",
      description: "Job has been added to the project successfully.",
    })
  }

  /**
   * Removes a previously added job from the project draft.
   *
   * @param jobId Job identifier to remove.
   */
  const removeJobFromProject = (jobId: string) => {
    setProjectJobs(prev => prev.filter(job => job.id !== jobId))
  }

  /**
   * Adds a badge requirement to the current job draft if it is not already selected.
   *
   * @param badgeId Badge identifier to include.
   */
  const addBadgeToJob = (badgeId: string) => {
    if (!currentJob.requiredBadges.includes(badgeId)) {
      setCurrentJob(prev => ({
        ...prev,
        requiredBadges: [...prev.requiredBadges, badgeId]
      }))
    }
  }

  /**
   * Removes a badge requirement from the current job draft.
   *
   * @param badgeId Badge identifier to remove.
   */
  const removeBadgeFromJob = (badgeId: string) => {
    setCurrentJob(prev => ({
      ...prev,
      requiredBadges: prev.requiredBadges.filter(id => id !== badgeId)
    }))
  }

  /**
   * Appends a training module draft to the badge draft and resets module inputs.
   */
  const addTrainingModule = () => {
    if (currentTrainingModule.title.trim()) {
      const newModule = {
        ...currentTrainingModule,
        id: `module-${Date.now()}`,
        order: newBadge.trainingModules.length
      }
      setNewBadge(prev => ({
        ...prev,
        trainingModules: [...prev.trainingModules, newModule]
      }))
      setCurrentTrainingModule({
        id: "",
        title: "",
        description: "",
        type: "video",
        content: "",
        duration: 0,
        order: 0
      })
    }
  }

  /**
   * Removes a training module from the badge draft.
   *
   * @param moduleId Training module identifier to remove.
   */
  const removeTrainingModule = (moduleId: string) => {
    setNewBadge(prev => ({
      ...prev,
      trainingModules: prev.trainingModules.filter(m => m.id !== moduleId)
    }))
  }

  /**
   * Creates a badge resource via the server action and attaches it to the current job requirements.
   * Requires a project group to be selected so the badge has an owner.
   */
  const createBadge = async () => {
    if (!newBadge.name.trim() || !newBadge.description.trim()) {
      toast({
        title: "Missing information",
        description: "Please fill in badge name and description.",
        variant: "destructive",
      })
      return
    }

    if (!projectGroup) {
      toast({
        title: "No group selected",
        description: "Please select a project group before creating badges.",
        variant: "destructive",
      })
      return
    }

    const result = await createBadgeResourceAction({
      groupId: projectGroup,
      name: newBadge.name.trim(),
      description: newBadge.description.trim(),
      category: newBadge.category || undefined,
      level: newBadge.level as "beginner" | "intermediate" | "advanced" | "expert",
      icon: newBadge.icon || undefined,
      requirements: newBadge.requirements,
    })

    if (!result.success) {
      toast({
        title: "Badge creation failed",
        description: result.message || "Could not create the badge.",
        variant: "destructive",
      })
      return
    }

    // Use the real resource ID returned by the server action
    const badgeId = result.resourceId as string
    addBadgeToJob(badgeId)

    // Reset form
    setNewBadge({
      name: "",
      description: "",
      icon: "",
      level: "beginner",
      category: "",
      requirements: [],
      trainingModules: [],
      liveClass: null
    })
    setShowBadgeCreation(false)

    toast({
      title: "Badge created",
      description: "New badge has been created and added to the job.",
    })
  }

  /**
   * Creates a live class (job resource) linked to the last-created badge.
   * Requires a project group and at least a title and date.
   */
  const handleCreateLiveClass = async () => {
    if (!liveClassForm.title.trim() || !liveClassForm.date.trim()) {
      toast({
        title: "Missing information",
        description: "Please provide at least a title and date for the live class.",
        variant: "destructive",
      })
      return
    }

    if (!projectGroup) {
      toast({
        title: "No group selected",
        description: "Please select a project group before creating a live class.",
        variant: "destructive",
      })
      return
    }

    const latestBadge = currentJob.requiredBadges.length > 0
      ? currentJob.requiredBadges[currentJob.requiredBadges.length - 1]
      : null

    if (!latestBadge) {
      toast({
        title: "Badge required",
        description: "Create and save a badge first, then set up a live class for it.",
        variant: "destructive",
      })
      return
    }

    setLiveClassSubmitting(true)
    try {
      const result = await createLiveClassAction({
        groupId: projectGroup,
        badgeId: latestBadge,
        title: liveClassForm.title.trim(),
        description: liveClassForm.description.trim(),
        date: liveClassForm.date,
        durationMinutes: liveClassForm.durationMinutes,
        maxParticipants: liveClassForm.maxParticipants || undefined,
        location: liveClassForm.location.trim() || undefined,
        tasks: liveClassForm.tasks.length > 0 ? liveClassForm.tasks : undefined,
      })

      if (!result.success) {
        toast({
          title: "Live class creation failed",
          description: result.message || "Could not create the live class.",
          variant: "destructive",
        })
        return
      }

      setNewBadge(prev => ({
        ...prev,
        liveClass: {
          title: liveClassForm.title.trim(),
          description: liveClassForm.description.trim(),
          date: liveClassForm.date,
          duration: liveClassForm.durationMinutes,
        },
      }))
      setShowLiveClassDialog(false)
      setLiveClassForm({
        title: "",
        description: "",
        date: "",
        durationMinutes: 60,
        maxParticipants: 20,
        location: "",
        tasks: [],
      })
      setNewLiveClassTask({ name: "", description: "", required: true })

      toast({
        title: "Live class created",
        description: "Live class has been created and linked to the badge.",
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error creating live class."
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      })
    } finally {
      setLiveClassSubmitting(false)
    }
  }

  /**
   * Validates and submits project creation, including optional venue and job data.
   * Redirects to the created project route on success.
   */
  const handleCreateProject = async () => {
    if (!projectTitle || !projectDescription || !projectCategory || !projectGroup) {
      toast({
        title: "Missing information",
        description: "Please fill in all required fields.",
        variant: "destructive",
      })
      return
    }
    if (projectTimeframeStart && projectTimeframeEnd && projectTimeframeEnd < projectTimeframeStart) {
      toast({
        title: "Invalid timeframe",
        description: "Project timeframe end must be after the start.",
        variant: "destructive",
      })
      return
    }

    const parsedProjectBudget = projectBudget ? Number.parseFloat(projectBudget) : null

    setIsSubmitting(true)
    try {
      const normalizedProjectLocales = projectVisibilityScope.localeIds.length > 0
        ? projectVisibilityScope.localeIds
        : appState.selectedChapter
          ? [appState.selectedChapter]
          : []
      const result = await createProjectResource({
        title: projectTitle,
        description: projectDescription,
        category: projectCategory,
        groupId: projectGroup,
        deadline: projectTimeframeEnd || undefined,
        timeframe: {
          start: projectTimeframeStart || null,
          end: projectTimeframeEnd || null,
        },
        budget: Number.isFinite(parsedProjectBudget) ? parsedProjectBudget : null,
        venueId: projectVenue !== "none" ? projectVenue : null,
        venueStartTime: projectVenueStartTime || null,
        venueEndTime: projectVenueEndTime || null,
        jobs: projectJobs,
        localeId: normalizedProjectLocales[0] ?? null,
        scopedLocaleIds: normalizedProjectLocales,
        scopedGroupIds: projectVisibilityScope.groupIds,
        scopedUserIds: projectVisibilityScope.userIds,
        isGlobal: projectIsGlobal,
        eftValues: Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
        capitalValues: Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
        auditValues: Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
      })

      setIsSubmitting(false)

      if (!result.success || !result.resourceId) {
        toast({
          title: "Failed to create project",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Project created",
        description: `Your project has been created successfully${projectJobs.length > 0 ? ` with ${projectJobs.length} job(s)` : ""}.`,
      })
      // Redirect to the owning group's project tab, or home if no group.
      router.push(projectGroup ? `/groups/${projectGroup}?tab=projects` : "/")
    } catch {
      setIsSubmitting(false)
      toast({
        title: "Failed to create project",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    }
  }

  /**
   * Validates and submits group creation based on selected group type requirements.
   * Redirects to the created group route on success.
   */
  const handleCreateGroup = async () => {
    // Check which fields are required based on group type
    const needsLegalWrapper = groupType === "org" || groupType === "ring";
    const normalizedGroupLocales = groupVisibilityScope.localeIds.length > 0
      ? groupVisibilityScope.localeIds
      : appState.selectedChapter
        ? [appState.selectedChapter]
        : []
    
    if (!groupName || !groupDescription || normalizedGroupLocales.length === 0 || (needsLegalWrapper && !legalWrapper)) {
      toast({
        title: "Missing information",
        description: "Please fill in all required fields.",
        variant: "destructive",
      })
      return
    }
    if (groupJoinSettings.passwordRequired && groupPassword.trim().length < 8) {
      toast({
        title: "Missing password",
        description: "Password-gated groups need a join password with at least 8 characters.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    try {
      const result = await createGroupResource({
        name: groupName,
        description: groupDescription,
        groupType,
        legalWrapper: needsLegalWrapper ? legalWrapper : undefined,
        chapter: normalizedGroupLocales[0],
        scopedLocaleIds: normalizedGroupLocales,
        scopedGroupIds: groupVisibilityScope.groupIds,
        scopedUserIds: groupVisibilityScope.userIds,
        isGlobal: groupIsGlobal,
        parentGroupId: groupParent !== "none" ? groupParent : null,
        joinSettings: groupJoinSettings,
        groupPassword: groupJoinSettings.passwordRequired ? groupPassword : null,
        features: groupTypeFeatures[groupType as keyof typeof groupTypeFeatures] ?? [],
        eftValues: Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
        capitalValues: Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
        auditValues: Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
      })

      setIsSubmitting(false)

      if (!result.success || !result.resourceId) {
        if (result.error?.code === "SUBSCRIPTION_REQUIRED" && groupType === "org") {
          persistPendingOrganizationDraft()
          setGateAction("group")
          setGateRequiredTier((result.error.requiredTier ?? "organizer") as MembershipTier)
          setGateFeatureDescription("Creating an organization requires an Organizer membership or higher.")
          setShowMembershipGate(true)
          return
        }
        toast({
          title: "Failed to create group",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      toast({
        title: "Group created",
        description: "Your group has been created successfully.",
      })
      // Redirect to the created group detail page.
      router.push(`/groups/${result.resourceId}`)
    } catch {
      setIsSubmitting(false)
      toast({
        title: "Failed to create group",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    }
  }

  useEffect(() => {
    if (!resumeGroupCreation || hasResumedGroupCreationRef.current || typeof window === "undefined") return

    const pendingDraft = window.sessionStorage.getItem(PENDING_ORG_CREATION_KEY)
    if (!pendingDraft) return

    hasResumedGroupCreationRef.current = true

    void (async () => {
      const subscription = await getSubscriptionStatusAction().catch(() => null)
      const tierRank: Record<MembershipTier, number> = {
        basic: 0,
        host: 1,
        seller: 2,
        organizer: 3,
        steward: 4,
      }

      if (!subscription || tierRank[subscription.tier] < tierRank.organizer) {
        hasResumedGroupCreationRef.current = false
        return
      }

      try {
        const draft = JSON.parse(pendingDraft) as Parameters<typeof createGroupResource>[0]
        const result = await createGroupResource(draft)
        if (!result.success || !result.resourceId) {
          toast({
            title: "Failed to create organization",
            description: result.message,
            variant: "destructive",
          })
          hasResumedGroupCreationRef.current = false
          return
        }

        clearPendingOrganizationDraft()
        toast({
          title: "Organization created",
          description: "Your organization has been created successfully.",
        })
        router.replace(`/groups/${result.resourceId}`)
      } catch {
        toast({
          title: "Failed to create organization",
          description: "An unexpected error occurred.",
          variant: "destructive",
        })
        hasResumedGroupCreationRef.current = false
      }
    })()
  }, [resumeGroupCreation, router, toast])

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Create</h1>
      </div>

      {/* Conditional rendering switches form content by active tab selection. */}
      <Tabs defaultValue="post" value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <ResponsiveTabsList className="max-w-3xl">
          <TabsTrigger value="post">Post</TabsTrigger>
          <TabsTrigger value="event">Event</TabsTrigger>
          <TabsTrigger value="project">Project</TabsTrigger>
          <TabsTrigger value="group">Group</TabsTrigger>
        </ResponsiveTabsList>

        <TabsContent value="post" className="space-y-6">
          <CreatePost
            eftValues={eftValues}
            capitalValues={capitalValues}
            auditValues={auditValues}
            locales={localeData.locales}
            selectedLocale={appState.selectedChapter}
            onLocaleChange={handlePostLocaleChange}
          />
          <EftPicker value={eftValues} onChange={setEftValues} capitalValue={capitalValues} onCapitalChange={setCapitalValues} auditValue={auditValues} onAuditChange={setAuditValues} />
          <Ecosocial3dPlot capitalValues={capitalValues} auditValues={auditValues} eftValues={eftValues} />
        </TabsContent>

        <TabsContent value="event" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Create an Event</CardTitle>
              <CardDescription>Fill in the details to create a new event</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="event-title">Event Title</Label>
                <Input
                  id="event-title"
                  placeholder="Enter event title"
                  value={eventTitle}
                  onChange={(e) => setEventTitle(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="event-description">Description</Label>
                <Textarea
                  id="event-description"
                  placeholder="Describe your event"
                  className="min-h-[100px]"
                  value={eventDescription}
                  onChange={(e) => setEventDescription(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="event-date">Date</Label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                    <Input
                      id="event-date"
                      type="date"
                      className="pl-10"
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="event-time">Time</Label>
                  <div className="relative">
                    <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                    <Input
                      id="event-time"
                      type="time"
                      className="pl-10"
                      value={eventTime}
                      onChange={(e) => setEventTime(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="event-type">Event Type</Label>
                <Select value={eventType} onValueChange={setEventType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select event type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in-person">In-Person</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                Locale is set from the Visibility Scope picker below. Add one or more locales there to scope and tag this event.
              </div>

              <div className="space-y-2">
                <Label htmlFor="event-location">
                  {eventType === "online" ? "Meeting Link/Platform" : "Location"}
                </Label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                  {eventType === "online" ? (
                    <Input
                      id="event-location"
                      placeholder="Zoom, Meet, or platform link"
                      className="pl-10"
                      value={eventLocation}
                      onChange={(e) => setEventLocation(e.target.value)}
                    />
                  ) : (
                    <LocationAutocompleteInput
                      id="event-location"
                      value={eventLocation}
                      onValueChange={setEventLocation}
                      placeholder="Search address or place"
                      inputClassName="pl-10"
                    />
                  )}
                </div>
              </div>

              {/* Venue Booking Section - Only show for in-person events */}
              {eventType === "in-person" && (
                <div className="space-y-4 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  <Label className="text-base font-medium">Venue Booking (Optional)</Label>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="venue-select">Select Venue</Label>
                  {venuesLoading ? (
                    <div className="h-10 animate-pulse bg-muted rounded-md" />
                  ) : (
                  <SearchableSelect
                    value={selectedVenue}
                    onChange={setSelectedVenue}
                    placeholder="Choose a venue to book"
                    searchPlaceholder="Search venues..."
                    emptyLabel="No venues found."
                    options={[
                      { value: "none", label: "No venue booking" },
                      ...liveVenueResources.map((resource) => {
                        const meta = (resource.metadata ?? {}) as Record<string, unknown>
                        const venue = (meta.venue ?? {}) as Record<string, unknown>
                        const venueName = String(venue.name ?? resource.name)
                        const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0)
                        const capacity = Number(venue.capacity ?? 0)
                        return {
                          value: resource.id,
                          label: venueName,
                          description: `$${hourlyRate}/hour${capacity > 0 ? ` • Capacity ${capacity}` : ""}`,
                        }
                      }),
                    ]}
                  />
                  )}
                </div>

                {selectedVenue && selectedVenue !== "none" && (
                  /* Conditional rendering: booking-time inputs are only relevant once a venue is chosen. */
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="venue-start-time">Start Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="venue-start-time"
                          type="time"
                          className="pl-10"
                          value={venueStartTime}
                          onChange={(e) => setVenueStartTime(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="venue-end-time">End Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="venue-end-time"
                          type="time"
                          className="pl-10"
                          value={venueEndTime}
                          onChange={(e) => setVenueEndTime(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {selectedVenue && selectedVenue !== "none" && (
                  /* Conditional rendering: show computed cost/amenity summary only for selected venues. */
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    {(() => {
                      const selected = liveVenueResources.find((resource) => resource.id === selectedVenue)
                      if (!selected) return null
                      const meta = (selected.metadata ?? {}) as Record<string, unknown>
                      const venue = (meta.venue ?? {}) as Record<string, unknown>
                      const venueName = String(venue.name ?? selected.name)
                      const venueLocation = String(venue.location ?? meta.location ?? "")
                      const venueAmenities = Array.isArray(venue.amenities) ? (venue.amenities as string[]) : []
                      const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0)
                      
                      const startTime = venueStartTime ? new Date(`2000-01-01T${venueStartTime}`) : null
                      const endTime = venueEndTime ? new Date(`2000-01-01T${venueEndTime}`) : null
                      const hours = startTime && endTime ? 
                        Math.max(1, Math.ceil((endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60))) : 1
                      const totalCost = hourlyRate * hours
                      
                      return (
                        <div className="space-y-2">
                          <h4 className="font-medium text-blue-900">Booking Summary</h4>
                          <div className="text-sm text-blue-800">
                            <p><strong>Venue:</strong> {venueName}</p>
                            <p><strong>Location:</strong> {venueLocation || "Not specified"}</p>
                            <p><strong>Duration:</strong> {hours} hour{hours !== 1 ? 's' : ''}</p>
                            <p><strong>Total Cost:</strong> ${totalCost}</p>
                            {venueAmenities.length > 0 && (
                              <p><strong>Amenities:</strong> {venueAmenities.join(', ')}</p>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="post-event-as-group"
                      checked={postEventAsGroup}
                      onCheckedChange={(checked) => {
                        const next = checked === true
                        setPostEventAsGroup(next)
                        if (!next) {
                          setEventGroup("none")
                          setEventProject("none")
                        }
                      }}
                    />
                    <Label htmlFor="post-event-as-group" className="text-sm font-normal">
                      Post event as a group
                    </Label>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="event-group">
                      {postEventAsGroup ? "Publishing Group" : "Associated Group (optional)"}
                    </Label>
                    <SearchableSelect
                      value={eventGroup}
                      onChange={handleEventGroupChange}
                      placeholder={postEventAsGroup ? "Select your group" : "Select group"}
                      searchPlaceholder="Search groups..."
                      emptyLabel="No groups found."
                    options={[
                      { value: "none", label: postEventAsGroup ? "Select a group" : "No group association" },
                        ...(postEventAsGroup ? eventPublishingGroups : liveGroups).map((group) => ({
                          value: group.id,
                          label: group.name,
                          description: "description" in group ? (group.description ?? undefined) : undefined,
                        })),
                    ]}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="event-project">Associated Project (optional)</Label>
                  <SearchableSelect
                    value={eventProject}
                    onChange={setEventProject}
                    disabled={!eventGroup || eventGroup === "none"}
                    placeholder={eventGroup && eventGroup !== "none" ? "Select project" : "Select group first"}
                    searchPlaceholder="Search projects..."
                    emptyLabel="No projects found."
                    options={[
                      { value: "none", label: "No project association" },
                      ...eventGroupProjects.map((project) => ({
                        value: project.id,
                        label: project.name,
                      })),
                    ]}
                  />
                </div>
              </div>

              <Separator />

              <VisibilityScopeSelector
                value={eventVisibilityScope}
                onChange={setEventVisibilityScope}
                locales={localeData.locales.map((l) => ({ id: l.id, name: l.name }))}
              />

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="event-global"
                  checked={eventIsGlobal}
                  onCheckedChange={(checked) => setEventIsGlobal(checked === true)}
                />
                <Label htmlFor="event-global" className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  Show globally
                </Label>
                <span className="text-xs text-muted-foreground">
                  Visible to everyone on the home feed
                </span>
              </div>

              <Separator />

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Tickets</Label>
                    <p className="text-xs text-muted-foreground">
                      Tickets are event offerings. Add multiple ticket tiers if needed.
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={addEventTicket}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Ticket
                  </Button>
                </div>
                <div className="space-y-3">
                  {eventTickets.map((ticket, index) => (
                    <div key={ticket.id} className="rounded-lg border p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">Ticket {index + 1}</p>
                        {eventTickets.length > 1 ? (
                          <Button type="button" variant="ghost" size="sm" onClick={() => removeEventTicket(ticket.id)}>
                            <X className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Ticket Name</Label>
                          <Input
                            value={ticket.name}
                            onChange={(e) => updateEventTicket(ticket.id, "name", e.target.value)}
                            placeholder="General Admission"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Quantity</Label>
                          <Input
                            type="number"
                            min="0"
                            value={ticket.quantity}
                            onChange={(e) => updateEventTicket(ticket.id, "quantity", e.target.value)}
                            placeholder="Unlimited"
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Price</Label>
                          <div className="relative">
                            <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                            <Input
                              placeholder="0.00"
                              className="pl-10"
                              value={ticket.price}
                              onChange={(e) => updateEventTicket(ticket.id, "price", e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Description</Label>
                          <Input
                            value={ticket.description}
                            onChange={(e) => updateEventTicket(ticket.id, "description", e.target.value)}
                            placeholder="What does this ticket include?"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />
              <EftPicker value={eftValues} onChange={setEftValues} capitalValue={capitalValues} onCapitalChange={setCapitalValues} auditValue={auditValues} onAuditChange={setAuditValues} />

              <div className="space-y-2">
                <Label>Event Image</Label>
                {eventImageUrl ? (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={eventImageUrl}
                      alt="Event upload preview"
                      className="max-h-48 rounded-md border object-cover"
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-1 right-1 h-6 w-6 rounded-full"
                      onClick={() => setEventImageUrl(null)}
                      aria-label="Remove image"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div
                    className="border-2 border-dashed rounded-md p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-muted"
                    onClick={() => eventImageInputRef.current?.click()}
                  >
                    {isEventImageUploading ? (
                      <Loader2 className="h-8 w-8 text-muted-foreground mb-2 animate-spin" />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-muted-foreground mb-2" />
                    )}
                    <p className="text-sm text-gray-500">
                      {isEventImageUploading ? "Uploading..." : "Click to upload an image"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">PNG, JPG up to 5MB</p>
                  </div>
                )}
                <input
                  ref={eventImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleEventImageSelect}
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={() => handleCreateEvent()} disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Event"}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="project" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Create a Project</CardTitle>
              <CardDescription>Start a new community project with goals, timelines, and team collaboration</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-title">Project Title</Label>
                <Input
                  id="project-title"
                  placeholder="Enter project title"
                  value={projectTitle}
                  onChange={(e) => setProjectTitle(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-description">Description</Label>
                <Textarea
                  id="project-description"
                  placeholder="Describe your project's goals and objectives"
                  className="min-h-[100px]"
                  value={projectDescription}
                  onChange={(e) => setProjectDescription(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="project-category">Category</Label>
                  <Select value={projectCategory} onValueChange={setProjectCategory}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="environment">Environment</SelectItem>
                      <SelectItem value="community">Community</SelectItem>
                      <SelectItem value="business">Business</SelectItem>
                      <SelectItem value="technology">Technology</SelectItem>
                      <SelectItem value="education">Education</SelectItem>
                      <SelectItem value="arts-culture">Arts & Culture</SelectItem>
                      <SelectItem value="health">Health</SelectItem>
                      <SelectItem value="housing">Housing</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-group">Associated Group</Label>
                  <SearchableSelect
                    value={projectGroup}
                    onChange={setProjectGroup}
                    placeholder="Select group"
                    searchPlaceholder="Search groups..."
                    emptyLabel="No groups found."
                    options={eventPublishingGroups.map((group) => ({
                      value: group.id,
                      label: group.name,
                      description: group.description ?? undefined,
                    }))}
                  />
                </div>
              </div>

              <div className="space-y-4 border rounded-lg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Visibility Scope</Label>
                    <p className="text-sm text-muted-foreground">
                      Choose the locales, groups, and people who should discover this project.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="project-global"
                      checked={projectIsGlobal}
                      onCheckedChange={(checked) => setProjectIsGlobal(Boolean(checked))}
                    />
                    <Label htmlFor="project-global" className="text-sm font-normal">Show globally</Label>
                  </div>
                </div>
                <VisibilityScopeSelector
                  locales={localeData.locales}
                  value={projectVisibilityScope}
                  onChange={setProjectVisibilityScope}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="project-timeframe-start">Timeframe start</Label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                    <Input
                      id="project-timeframe-start"
                      type="datetime-local"
                      className="pl-10"
                      value={projectTimeframeStart}
                      onChange={(e) => setProjectTimeframeStart(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-timeframe-end">Timeframe end</Label>
                  <div className="relative">
                    <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                    <Input
                      id="project-timeframe-end"
                      type="datetime-local"
                      className="pl-10"
                      value={projectTimeframeEnd}
                      onChange={(e) => setProjectTimeframeEnd(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-budget">Budget (optional)</Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                  <Input
                    id="project-budget"
                    placeholder="0.00"
                    className="pl-10"
                    value={projectBudget}
                    onChange={(e) => setProjectBudget(e.target.value)}
                  />
                </div>
              </div>

              {/* Project Venue Booking Section */}
              <div className="space-y-4 border-t pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <Label className="text-base font-medium">Venue Booking (Optional)</Label>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowCreateVenueModal(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Venue Offering
                  </Button>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="project-venue-select">Select Venue</Label>
                  {venuesLoading ? (
                    <div className="h-10 animate-pulse bg-muted rounded-md" />
                  ) : (
                  <SearchableSelect
                    value={projectVenue}
                    onChange={setProjectVenue}
                    placeholder="Choose a venue for project events"
                    searchPlaceholder="Search venues..."
                    emptyLabel="No venues found."
                    options={[
                      { value: "none", label: "No venue booking" },
                      ...liveVenueResources.map((resource) => {
                        const meta = (resource.metadata ?? {}) as Record<string, unknown>
                        const venue = (meta.venue ?? {}) as Record<string, unknown>
                        const venueName = String(venue.name ?? resource.name)
                        const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0)
                        const capacity = Number(venue.capacity ?? 0)
                        return {
                          value: resource.id,
                          label: venueName,
                          description: `$${hourlyRate}/hour${capacity > 0 ? ` • Capacity: ${capacity}` : ""}`,
                        }
                      }),
                    ]}
                  />
                  )}
                </div>

                {projectVenue && projectVenue !== "none" && (
                  /* Conditional rendering: project venue timing appears only when a venue is selected. */
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="project-venue-start-time">Preferred Start Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="project-venue-start-time"
                          type="time"
                          className="pl-10"
                          value={projectVenueStartTime}
                          onChange={(e) => setProjectVenueStartTime(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="project-venue-end-time">Preferred End Time</Label>
                      <div className="relative">
                        <Clock className="absolute left-3 top-3 h-4 w-4 text-gray-500" />
                        <Input
                          id="project-venue-end-time"
                          type="time"
                          className="pl-10"
                          value={projectVenueEndTime}
                          onChange={(e) => setProjectVenueEndTime(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {projectVenue && projectVenue !== "none" && (
                  /* Conditional rendering: render selected project venue summary only when applicable. */
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    {(() => {
                      const selected = liveVenueResources.find((resource) => resource.id === projectVenue)
                      if (!selected) return null
                      const meta = (selected.metadata ?? {}) as Record<string, unknown>
                      const venue = (meta.venue ?? {}) as Record<string, unknown>
                      const venueName = String(venue.name ?? selected.name)
                      const venueLocation = String(venue.location ?? meta.location ?? "")
                      const hourlyRate = Number(venue.hourlyRate ?? meta.price ?? 0)
                      const capacity = Number(venue.capacity ?? 0)
                      const venueAmenities = Array.isArray(venue.amenities) ? (venue.amenities as string[]) : []
                      
                      return (
                        <div className="space-y-2">
                          <h4 className="font-medium text-green-900">Project Venue Preference</h4>
                          <div className="text-sm text-green-800">
                            <p><strong>Venue:</strong> {venueName}</p>
                            <p><strong>Location:</strong> {venueLocation || "Not specified"}</p>
                            <p><strong>Rate:</strong> ${hourlyRate}/hour</p>
                            {capacity > 0 ? <p><strong>Capacity:</strong> {capacity} people</p> : null}
                            {venueAmenities.length > 0 && (
                              <p><strong>Amenities:</strong> {venueAmenities.join(', ')}</p>
                            )}
                            <p className="mt-2 text-xs text-green-600">
                              This venue will be available for booking when creating project events
                            </p>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>

              {/* Jobs Section */}
              <Separator />
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                      <Briefcase className="h-5 w-5" />
                      Project Jobs ({projectJobs.length})
                    </h3>
                    <p className="text-sm text-gray-600">Add jobs with specific tasks to organize project work</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowJobCreation(true)}
                    disabled={!projectGroup}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Job
                  </Button>
                </div>

                {/* Job Creation Form */}
                {showJobCreation && (
                  /* Conditional rendering: expanded job creation form is shown on demand. */
                  <Card className="border-2 border-blue-200">
                    <CardHeader>
                      <CardTitle className="text-base">Create Job</CardTitle>
                      <CardDescription>Define a specific job with tasks for this project</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Basic Job Info */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="job-title">Job Title *</Label>
                          <Input
                            id="job-title"
                            value={currentJob.title}
                            onChange={(e) => setCurrentJob({ ...currentJob, title: e.target.value })}
                            placeholder="e.g., Garden Setup Team"
                            required
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="job-category">Category</Label>
                          <Select
                            value={currentJob.category}
                            onValueChange={(value) => setCurrentJob({ ...currentJob, category: value })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select category" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="maintenance">Maintenance</SelectItem>
                              <SelectItem value="environment">Environment</SelectItem>
                              <SelectItem value="technology">Technology</SelectItem>
                              <SelectItem value="creative">Creative</SelectItem>
                              <SelectItem value="administrative">Administrative</SelectItem>
                              <SelectItem value="community">Community</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="job-description">Description *</Label>
                        <Textarea
                          id="job-description"
                          value={currentJob.description}
                          onChange={(e) => setCurrentJob({ ...currentJob, description: e.target.value })}
                          placeholder="Describe what this job involves..."
                          rows={3}
                          required
                        />
                      </div>

                      {/* Time and Location */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="job-start-time">Start Time</Label>
                          <Input
                            id="job-start-time"
                            type="time"
                            value={currentJob.startTime}
                            onChange={(e) => setCurrentJob({ ...currentJob, startTime: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="job-end-time">End Time</Label>
                          <Input
                            id="job-end-time"
                            type="time"
                            value={currentJob.endTime}
                            onChange={(e) => setCurrentJob({ ...currentJob, endTime: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="job-location">Location</Label>
                          <LocationAutocompleteInput
                            id="job-location"
                            value={currentJob.location}
                            onValueChange={(value) => setCurrentJob({ ...currentJob, location: value })}
                            placeholder="Search address or place"
                          />
                        </div>
                      </div>

                      {/* Priority and Max Assignees */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="job-priority">Priority</Label>
                          <Select
                            value={currentJob.priority}
                            onValueChange={(value: "low" | "medium" | "high") => setCurrentJob({ ...currentJob, priority: value })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="low">Low</SelectItem>
                              <SelectItem value="medium">Medium</SelectItem>
                              <SelectItem value="high">High</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="job-max-assignees">Max Assignees</Label>
                          <Input
                            id="job-max-assignees"
                            type="number"
                            min="1"
                            max="20"
                            value={currentJob.maxAssignees}
                            onChange={(e) => setCurrentJob({ ...currentJob, maxAssignees: Number.parseInt(e.target.value) || 1 })}
                          />
                        </div>
                      </div>

                      {/* Tasks Section */}
                      <div className="space-y-4">
                        <h4 className="font-medium">Tasks *</h4>
                        
                        {/* Add Task Form */}
                        <div className="border rounded-lg p-4 bg-muted">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div className="space-y-2">
                              <Label htmlFor="task-name">Task Name</Label>
                              <Input
                                id="task-name"
                                value={currentTask.name}
                                onChange={(e) => setCurrentTask({ ...currentTask, name: e.target.value })}
                                placeholder="e.g., Set up irrigation"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="task-points">Points</Label>
                              <Input
                                id="task-points"
                                type="number"
                                min="1"
                                value={currentTask.points}
                                onChange={(e) => setCurrentTask({ ...currentTask, points: Number.parseInt(e.target.value) || 1 })}
                              />
                            </div>
                          </div>
                          <div className="space-y-2 mb-4">
                            <Label htmlFor="task-description">Task Description</Label>
                            <Textarea
                              id="task-description"
                              value={currentTask.description}
                              onChange={(e) => setCurrentTask({ ...currentTask, description: e.target.value })}
                              placeholder="Describe what this task involves..."
                              rows={2}
                            />
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label htmlFor="task-time">Est. Time (minutes)</Label>
                              <Input
                                id="task-time"
                                type="number"
                                min="5"
                                step="5"
                                value={currentTask.estimatedTime}
                                onChange={(e) => setCurrentTask({ ...currentTask, estimatedTime: Number.parseInt(e.target.value) || 30 })}
                              />
                            </div>
                            <div className="flex items-end">
                              <Button type="button" onClick={addTask} className="w-full">
                                <Plus className="h-4 w-4 mr-2" />
                                Add Task
                              </Button>
                            </div>
                          </div>
                        </div>

                        {/* Tasks List */}
                        {currentJob.tasks.length > 0 && (
                          <div className="space-y-2">
                            <h5 className="font-medium">Tasks ({currentJob.tasks.length})</h5>
                            <div className="space-y-2">
                              {currentJob.tasks.map((task) => (
                                <div key={task.id} className="flex justify-between items-start p-3 border rounded-lg bg-card">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <h6 className="font-medium">{task.name}</h6>
                                      <div className="flex gap-1">
                                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">{task.points} pts</span>
                                        <span className="text-xs bg-muted text-foreground px-2 py-1 rounded">{task.estimatedTime}min</span>
                                      </div>
                                    </div>
                                    {task.description && <p className="text-sm text-gray-600">{task.description}</p>}
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeTask(task.id)}
                                    aria-label={`Remove task ${task.name}`}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Skills Section */}
                      <div className="space-y-4">
                        <h4 className="font-medium">Required Skills</h4>
                        <div className="flex gap-2">
                          <Input
                            value={newSkill}
                            onChange={(e) => setNewSkill(e.target.value)}
                            placeholder="Add a skill..."
                            onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addSkill())}
                          />
                          <Button type="button" onClick={addSkill}>
                            Add
                          </Button>
                        </div>
                        {currentJob.skills.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {currentJob.skills.map((skill) => (
                              <span key={skill} className="inline-flex items-center gap-1 px-2 py-1 bg-muted text-foreground rounded-md text-sm cursor-pointer" onClick={() => removeSkill(skill)}>
                                {skill}
                                <X className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Required Badges Section */}
                      <div className="space-y-4">
                        <div className="flex justify-between items-center">
                          <h4 className="font-medium">Required Badges</h4>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setShowBadgeCreation(true)}
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Create Badge
                          </Button>
                        </div>
                        
                        <div className="space-y-3">
                          <h5 className="text-sm font-medium text-gray-700">Available Badges</h5>
                          {badgesLoading ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i} className="h-14 animate-pulse bg-muted rounded-lg" />
                              ))}
                            </div>
                          ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                            {liveBadges.map((badge) => {
                              const badgeMeta = (badge.metadata ?? {}) as Record<string, unknown>
                              const isSelected = currentJob.requiredBadges.includes(badge.id)
                              return (
                                <div
                                  key={badge.id}
                                  className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                                    isSelected
                                      ? 'bg-blue-50 border-blue-200'
                                      : 'hover:bg-muted'
                                  }`}
                                  onClick={() => {
                                    if (isSelected) {
                                      removeBadgeFromJob(badge.id)
                                    } else {
                                      addBadgeToJob(badge.id)
                                    }
                                  }}
                                >
                                  <span className="text-2xl">{String(badgeMeta.icon ?? "🏅")}</span>
                                  <div className="flex-1">
                                    <p className="font-medium text-sm">{badge.name}</p>
                                    <p className="text-xs text-gray-500">{String(badgeMeta.level ?? "badge")}</p>
                                  </div>
                                  {isSelected && (
                                    <div className="h-4 w-4 bg-blue-500 rounded-full flex items-center justify-center">
                                      <span className="text-white text-xs">✓</span>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          )}
                        </div>

                        {currentJob.requiredBadges.length > 0 && (
                          <div className="space-y-2">
                            <h5 className="text-sm font-medium text-gray-700">Selected Badges</h5>
                            <div className="flex flex-wrap gap-2">
                              {currentJob.requiredBadges.map((badgeId) => {
                                const badge = liveBadges.find((b) => b.id === badgeId)
                                if (!badge) return null
                                const badgeMeta = (badge.metadata ?? {}) as Record<string, unknown>
                                return (
                                  <span
                                    key={badge.id}
                                    className="inline-flex items-center gap-2 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm cursor-pointer"
                                    onClick={() => removeBadgeFromJob(badge.id)}
                                  >
                                    <span>{String(badgeMeta.icon ?? "🏅")}</span>
                                    <span>{badge.name}</span>
                                    <X className="h-3 w-3" />
                                  </span>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Job Summary */}
                      {(currentJob.title || currentJob.tasks.length > 0) && (
                        <div className="border-t pt-4">
                          <h4 className="font-medium mb-3">Job Summary</h4>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                            <div className="flex items-center gap-2">
                              <Clock className="h-4 w-4 text-gray-500" />
                              <span>{calculateJobDuration() || "Not set"}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Users className="h-4 w-4 text-gray-500" />
                              <span>{currentJob.maxAssignees} max</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-1 rounded text-xs ${currentJob.priority === 'high' ? 'bg-red-100 text-red-800' : currentJob.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                                {currentJob.priority === "high" && <AlertCircle className="h-3 w-3 mr-1 inline" />}
                                {currentJob.priority}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{calculateJobTotalPoints()} total points</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Job Actions */}
                      <div className="flex justify-end gap-2 pt-4 border-t">
                        <Button type="button" variant="outline" onClick={() => setShowJobCreation(false)}>
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          onClick={addJobToProject}
                          disabled={!currentJob.title.trim() || !currentJob.description.trim() || currentJob.tasks.length === 0}
                        >
                          Add Job to Project
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Badge Creation Modal */}
                {showBadgeCreation && (
                  /* Conditional rendering: inline badge-creation workflow shown within job builder. */
                  <Card className="border-2 border-green-200">
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <span className="text-2xl">🏆</span>
                        Create New Badge
                      </CardTitle>
                      <CardDescription>Design a comprehensive badge with training materials and requirements</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      {/* Basic Badge Info */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="badge-name">Badge Name *</Label>
                          <Input
                            id="badge-name"
                            value={newBadge.name}
                            onChange={(e) => setNewBadge({ ...newBadge, name: e.target.value })}
                            placeholder="e.g., Solar Panel Installer"
                            required
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="badge-icon">Icon (Emoji)</Label>
                          <Input
                            id="badge-icon"
                            value={newBadge.icon}
                            onChange={(e) => setNewBadge({ ...newBadge, icon: e.target.value })}
                            placeholder="e.g., ⚡"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="badge-description">Description *</Label>
                        <Textarea
                          id="badge-description"
                          value={newBadge.description}
                          onChange={(e) => setNewBadge({ ...newBadge, description: e.target.value })}
                          placeholder="Describe the skills and knowledge this badge represents..."
                          rows={3}
                          required
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="badge-level">Level</Label>
                          <Select
                            value={newBadge.level}
                            onValueChange={(value: "beginner" | "intermediate" | "advanced" | "expert") => 
                              setNewBadge({ ...newBadge, level: value })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="beginner">Beginner</SelectItem>
                              <SelectItem value="intermediate">Intermediate</SelectItem>
                              <SelectItem value="advanced">Advanced</SelectItem>
                              <SelectItem value="expert">Expert</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="badge-category">Category</Label>
                          <Select
                            value={newBadge.category}
                            onValueChange={(value) => setNewBadge({ ...newBadge, category: value })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select category" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="environmental">Environmental</SelectItem>
                              <SelectItem value="technical">Technical</SelectItem>
                              <SelectItem value="leadership">Leadership</SelectItem>
                              <SelectItem value="creative">Creative</SelectItem>
                              <SelectItem value="community">Community</SelectItem>
                              <SelectItem value="business">Business</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <Separator />

                      {/* Training Modules Section */}
                      <div className="space-y-4">
                        <h4 className="font-medium">Training Modules</h4>
                        
                        {/* Add Training Module Form */}
                        <div className="border rounded-lg p-4 bg-muted">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div className="space-y-2">
                              <Label htmlFor="module-title">Module Title</Label>
                              <Input
                                id="module-title"
                                value={currentTrainingModule.title}
                                onChange={(e) => setCurrentTrainingModule({ ...currentTrainingModule, title: e.target.value })}
                                placeholder="e.g., Introduction to Solar Energy"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="module-type">Type</Label>
                              <Select
                                value={currentTrainingModule.type}
                                onValueChange={(value: "video" | "reading" | "quiz" | "assignment") => 
                                  setCurrentTrainingModule({ ...currentTrainingModule, type: value })
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="video">Video</SelectItem>
                                  <SelectItem value="reading">Reading</SelectItem>
                                  <SelectItem value="quiz">Quiz</SelectItem>
                                  <SelectItem value="assignment">Assignment</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div className="space-y-2 mb-4">
                            <Label htmlFor="module-description">Description</Label>
                            <Textarea
                              id="module-description"
                              value={currentTrainingModule.description}
                              onChange={(e) => setCurrentTrainingModule({ ...currentTrainingModule, description: e.target.value })}
                              placeholder="Describe this training module..."
                              rows={2}
                            />
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label htmlFor="module-content">Content URL/Text</Label>
                              <Input
                                id="module-content"
                                value={currentTrainingModule.content}
                                onChange={(e) => setCurrentTrainingModule({ ...currentTrainingModule, content: e.target.value })}
                                placeholder="YouTube URL, PDF link, or text content..."
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="module-duration">Duration (minutes)</Label>
                              <Input
                                id="module-duration"
                                type="number"
                                min="1"
                                value={currentTrainingModule.duration}
                                onChange={(e) => setCurrentTrainingModule({ ...currentTrainingModule, duration: parseInt(e.target.value) || 0 })}
                                placeholder="15"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end mt-4">
                            <Button type="button" onClick={addTrainingModule}>
                              <Plus className="h-4 w-4 mr-2" />
                              Add Module
                            </Button>
                          </div>
                        </div>

                        {/* Training Modules List */}
                        {newBadge.trainingModules.length > 0 && (
                          <div className="space-y-2">
                            <h5 className="font-medium">Training Modules ({newBadge.trainingModules.length})</h5>
                            <div className="space-y-2">
                              {newBadge.trainingModules.map((module, index) => (
                                <div key={module.id} className="flex items-start justify-between p-3 border rounded-lg bg-card">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="text-sm font-medium">#{index + 1}</span>
                                      <h6 className="font-medium">{module.title}</h6>
                                      <div className="flex gap-1">
                                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">{module.type}</span>
                                        <span className="text-xs bg-muted text-foreground px-2 py-1 rounded">{module.duration}min</span>
                                      </div>
                                    </div>
                                    {module.description && <p className="text-sm text-gray-600 mb-1">{module.description}</p>}
                                    {module.content && <p className="text-xs text-gray-500">Content: {module.content}</p>}
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeTrainingModule(module.id)}
                                    aria-label={`Remove training module ${module.title}`}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      <Separator />

                      {/* Live Class Option */}
                      <div className="space-y-4">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium">Live Class</h4>
                          <span className="text-sm text-gray-500">(Optional)</span>
                        </div>
                        <div className="p-4 border rounded-lg bg-blue-50">
                          <p className="text-sm text-blue-800 mb-3">
                            Create a live class session as a job with practical tasks that participants must complete to earn this badge.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setShowLiveClassDialog(true)}
                          >
                            <Briefcase className="h-4 w-4 mr-2" />
                            Set Up Live Class
                          </Button>
                          {newBadge.liveClass && (
                            <p className="text-xs text-green-700 mt-2">
                              Live class scheduled: {newBadge.liveClass.title} on {newBadge.liveClass.date} ({newBadge.liveClass.duration} min)
                            </p>
                          )}
                        </div>

                        {/* Live Class Dialog */}
                        {showLiveClassDialog && (
                          <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50/50 space-y-4">
                            <div className="flex items-center justify-between">
                              <h4 className="font-medium">Create Live Class</h4>
                              <Button type="button" variant="ghost" size="sm" onClick={() => setShowLiveClassDialog(false)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label htmlFor="live-class-title">Class Title *</Label>
                                <Input
                                  id="live-class-title"
                                  value={liveClassForm.title}
                                  onChange={(e) => setLiveClassForm(prev => ({ ...prev, title: e.target.value }))}
                                  placeholder="e.g., Solar Panel Installation Workshop"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="live-class-date">Date *</Label>
                                <Input
                                  id="live-class-date"
                                  type="date"
                                  value={liveClassForm.date}
                                  onChange={(e) => setLiveClassForm(prev => ({ ...prev, date: e.target.value }))}
                                />
                              </div>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="live-class-description">Description</Label>
                              <Textarea
                                id="live-class-description"
                                value={liveClassForm.description}
                                onChange={(e) => setLiveClassForm(prev => ({ ...prev, description: e.target.value }))}
                                placeholder="Describe what participants will learn and do..."
                                rows={3}
                              />
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div className="space-y-2">
                                <Label htmlFor="live-class-duration">Duration (minutes)</Label>
                                <Input
                                  id="live-class-duration"
                                  type="number"
                                  min="15"
                                  value={liveClassForm.durationMinutes}
                                  onChange={(e) => setLiveClassForm(prev => ({ ...prev, durationMinutes: parseInt(e.target.value) || 60 }))}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="live-class-max">Max Participants</Label>
                                <Input
                                  id="live-class-max"
                                  type="number"
                                  min="1"
                                  value={liveClassForm.maxParticipants}
                                  onChange={(e) => setLiveClassForm(prev => ({ ...prev, maxParticipants: parseInt(e.target.value) || 20 }))}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="live-class-location">Location</Label>
                                <Input
                                  id="live-class-location"
                                  value={liveClassForm.location}
                                  onChange={(e) => setLiveClassForm(prev => ({ ...prev, location: e.target.value }))}
                                  placeholder="Address or online link"
                                />
                              </div>
                            </div>

                            {/* Live Class Tasks */}
                            <div className="space-y-2">
                              <Label>Practical Tasks</Label>
                              {liveClassForm.tasks.length > 0 && (
                                <div className="space-y-1">
                                  {liveClassForm.tasks.map((task, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-2 border rounded bg-card text-sm">
                                      <div>
                                        <span className="font-medium">{task.name}</span>
                                        {task.description && <span className="text-muted-foreground ml-2">- {task.description}</span>}
                                        {task.required && <span className="text-xs text-red-600 ml-1">(required)</span>}
                                      </div>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setLiveClassForm(prev => ({
                                          ...prev,
                                          tasks: prev.tasks.filter((_, i) => i !== idx),
                                        }))}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="flex gap-2">
                                <Input
                                  placeholder="Task name"
                                  value={newLiveClassTask.name}
                                  onChange={(e) => setNewLiveClassTask(prev => ({ ...prev, name: e.target.value }))}
                                  className="flex-1"
                                />
                                <Input
                                  placeholder="Description (optional)"
                                  value={newLiveClassTask.description}
                                  onChange={(e) => setNewLiveClassTask(prev => ({ ...prev, description: e.target.value }))}
                                  className="flex-1"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={!newLiveClassTask.name.trim()}
                                  onClick={() => {
                                    if (!newLiveClassTask.name.trim()) return
                                    setLiveClassForm(prev => ({
                                      ...prev,
                                      tasks: [...prev.tasks, { ...newLiveClassTask, name: newLiveClassTask.name.trim(), description: newLiveClassTask.description.trim() }],
                                    }))
                                    setNewLiveClassTask({ name: "", description: "", required: true })
                                  }}
                                >
                                  <Plus className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            <div className="flex justify-end gap-2 pt-2">
                              <Button type="button" variant="outline" onClick={() => setShowLiveClassDialog(false)}>
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                onClick={handleCreateLiveClass}
                                disabled={!liveClassForm.title.trim() || !liveClassForm.date.trim() || liveClassSubmitting}
                              >
                                {liveClassSubmitting ? (
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                  <Briefcase className="h-4 w-4 mr-2" />
                                )}
                                {liveClassSubmitting ? "Creating..." : "Create Live Class"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Badge Preview */}
                      {(newBadge.name || newBadge.icon) && (
                        <div className="border-t pt-4">
                          <h4 className="font-medium mb-3">Badge Preview</h4>
                          <div className="flex items-center gap-4 p-4 border rounded-lg bg-gradient-to-r from-blue-50 to-purple-50">
                            <div className="text-4xl">
                              {newBadge.icon || "🏆"}
                            </div>
                            <div className="flex-1">
                              <h5 className="font-bold text-lg">{newBadge.name || "Badge Name"}</h5>
                              <p className="text-sm text-gray-600 mb-2">{newBadge.description || "Badge description..."}</p>
                              <div className="flex gap-2">
                                <span className={`text-xs px-2 py-1 rounded ${
                                  newBadge.level === 'beginner' ? 'bg-green-100 text-green-800' :
                                  newBadge.level === 'intermediate' ? 'bg-blue-100 text-blue-800' :
                                  newBadge.level === 'advanced' ? 'bg-purple-100 text-purple-800' :
                                  'bg-yellow-100 text-yellow-800'
                                }`}>
                                  {newBadge.level}
                                </span>
                                {newBadge.category && (
                                  <span className="text-xs px-2 py-1 rounded bg-muted text-foreground">
                                    {newBadge.category}
                                  </span>
                                )}
                                {newBadge.trainingModules.length > 0 && (
                                  <span className="text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-800">
                                    {newBadge.trainingModules.length} modules
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Badge Actions */}
                      <div className="flex justify-end gap-2 pt-4 border-t">
                        <Button type="button" variant="outline" onClick={() => setShowBadgeCreation(false)}>
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          onClick={createBadge}
                          disabled={!newBadge.name.trim() || !newBadge.description.trim()}
                        >
                          Create Badge & Add to Job
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Created Jobs List */}
                {projectJobs.length > 0 && (
                  /* Conditional rendering: created jobs summary appears only after jobs are added. */
                  <div className="space-y-3">
                    <h4 className="font-medium">Added Jobs</h4>
                    {projectJobs.map((job) => (
                      <Card key={job.id} className="border-l-4 border-l-blue-500">
                        <CardContent className="p-4">
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <h5 className="font-medium">{job.title}</h5>
                                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">{job.totalPoints} pts</span>
                                <span className="text-xs bg-muted text-foreground px-2 py-1 rounded">{job.tasks.length} tasks</span>
                              </div>
                              <p className="text-sm text-gray-600 mb-2">{job.description}</p>
                              <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                                {job.location && <span>📍 {job.location}</span>}
                                {job.duration && <span>⏱ {job.duration}</span>}
                                <span>👥 {job.maxAssignees} max</span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeJobFromProject(job.id)}
                              aria-label={`Remove job ${job.title}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>

              <Separator />
              <EftPicker value={eftValues} onChange={setEftValues} capitalValue={capitalValues} onCapitalChange={setCapitalValues} auditValue={auditValues} onAuditChange={setAuditValues} />

              <div className="space-y-2">
                <Label>Project Image</Label>
                <div className="border-2 border-dashed rounded-md p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-muted">
                  <ImageIcon className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-gray-500">Click to upload an image</p>
                  <p className="text-xs text-muted-foreground mt-1">PNG, JPG up to 5MB</p>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={handleCreateProject} disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Project"}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="group" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Users className="h-5 w-5 mr-2" />
                Create a Group
              </CardTitle>
              <CardDescription>Start a new community group with features that match your needs</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="group-name">Group Name</Label>
                <Input
                  id="group-name"
                  placeholder="Enter group name"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="group-description">Description</Label>
                <Textarea
                  id="group-description"
                  placeholder="Describe your group's purpose and goals"
                  className="min-h-[100px]"
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="group-type">Group Type</Label>
                  <Select value={groupType} onValueChange={setGroupType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select group type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic</SelectItem>
                      <SelectItem value="org">Org</SelectItem>
                      <SelectItem value="ring">Ring</SelectItem>
                      <SelectItem value="family">Family</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {(groupType === "org" || groupType === "ring") && (
                  /* Conditional rendering: legal wrapper is required for org/ring types only. */
                  <div className="space-y-2">
                    <Label htmlFor="legal-wrapper">Legal Wrapper</Label>
                    <Select value={legalWrapper} onValueChange={setLegalWrapper}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select legal wrapper" />
                      </SelectTrigger>
                      <SelectContent>
                        {groupType === "org" ? (
                          <>
                            <SelectItem value="llc">LLC</SelectItem>
                            <SelectItem value="pbc">PBC</SelectItem>
                            <SelectItem value="lca">LCA</SelectItem>
                            <SelectItem value="cooperative">Cooperative</SelectItem>
                            <SelectItem value="c-corp">C-Corp</SelectItem>
                            <SelectItem value="s-corp">S-Corp</SelectItem>
                            <SelectItem value="nonprofit">Non-Profit</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="501c7">501(c)7</SelectItem>
                            <SelectItem value="llc">LLC</SelectItem>
                            <SelectItem value="unincorporated">Unincorporated Association</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                
                {/* Add a placeholder div when legal wrapper is not shown to maintain the grid layout */}
                {!(groupType === "org" || groupType === "ring") && <div></div>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-4 border rounded-lg p-4 col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>Visibility Scope</Label>
                      <p className="text-sm text-muted-foreground">
                        The first selected locale becomes the group&apos;s primary locale. Hidden groups still use this scope.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="group-global"
                        checked={groupIsGlobal}
                        onCheckedChange={(checked) => setGroupIsGlobal(Boolean(checked))}
                      />
                      <Label htmlFor="group-global" className="text-sm font-normal">Show globally</Label>
                    </div>
                  </div>
                  <VisibilityScopeSelector
                    locales={localeData.locales}
                    value={groupVisibilityScope}
                    onChange={(scope) => {
                      setGroupVisibilityScope(scope)
                      if (scope.localeIds[0]) {
                        setGroupChapter(scope.localeIds[0])
                      }
                    }}
                  />
                </div>

                {/* Only show Parent Group for Basic and Family types */}
                {(groupType === "basic" || groupType === "family" || groupType === "org") && (
                  /* Conditional rendering: parent group options are limited to compatible group types. */
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="group-parent">Parent Group {groupType !== "family" && "(Optional)"}</Label>
                    <Select
                      value={groupParent}
                      onValueChange={setGroupParent}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select parent group" />
                      </SelectTrigger>
                      <SelectContent>
                        {groupType !== "family" && <SelectItem value="none">No parent group</SelectItem>}
                        {groupType === "family" 
                          ? liveRings.map((ring) => (
                              <SelectItem key={ring.id} value={ring.id}>
                                {ring.name} (Ring)
                              </SelectItem>
                            ))
                          : [
                              // Groups can have both rings and other groups as parents
                              ...liveRings.map((ring) => (
                                <SelectItem key={ring.id} value={ring.id}>
                                  {ring.name} (Ring)
                                </SelectItem>
                              )),
                              ...liveGroups
                                .filter((group) => {
                                  // Filter groups based on the selected group type
                                  switch (groupType) {
                                    case "basic":
                                      return group.type === GroupType.Basic;
                                    case "org":
                                      return group.type === GroupType.Group || group.type === GroupType.Organization;
                                    default:
                                      return false;
                                  }
                                })
                                .map((group) => (
                                  <SelectItem key={group.id} value={group.id}>
                                    {group.name} (Group)
                                  </SelectItem>
                                ))
                            ]
                        }
                      </SelectContent>
                    </Select>
                  </div>
                )}
                
                {/* Add a placeholder div when parent group is not shown to maintain the grid layout */}
                {groupType === "ring" && <div></div>}
              </div>

              <div className="space-y-2">
                <Label>Group Features</Label>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {groupTypeFeatures[groupType as keyof typeof groupTypeFeatures]?.map((feature: GroupFeature, index: number) => (
                    <div key={index} className="flex items-center p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{feature.name}</p>
                        <p className="text-muted-foreground">{feature.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4 border rounded-lg p-4">
                <div>
                  <Label>Join Flow</Label>
                  <p className="text-sm text-muted-foreground">
                    Configure whether the group is public or hidden, and whether joining is open, approval-based, or invite-only.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="group-discovery-mode">Discovery</Label>
                    <Select
                      value={groupJoinSettings.visibility ?? "public"}
                      onValueChange={(value) =>
                        setGroupJoinSettings((prev) => ({ ...prev, visibility: value === "hidden" ? "hidden" : "public" }))
                      }
                    >
                      <SelectTrigger id="group-discovery-mode">
                        <SelectValue placeholder="Select discovery mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="hidden">Hidden</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="group-join-mode">Join mode</Label>
                    <Select
                      value={groupJoinSettings.joinType}
                      onValueChange={(value) =>
                        setGroupJoinSettings((prev) => ({
                          ...prev,
                          joinType: value as JoinType,
                          approvalRequired:
                            value === JoinType.ApprovalRequired || value === JoinType.InviteAndApply,
                        }))
                      }
                    >
                      <SelectTrigger id="group-join-mode">
                        <SelectValue placeholder="Select join mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={JoinType.Public}>Open</SelectItem>
                        <SelectItem value={JoinType.ApprovalRequired}>Apply and approve</SelectItem>
                        <SelectItem value={JoinType.InviteOnly}>Invite only</SelectItem>
                        <SelectItem value={JoinType.InviteAndApply}>Invite + apply and approve</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="group-password-required"
                    checked={Boolean(groupJoinSettings.passwordRequired)}
                    onCheckedChange={(checked) =>
                      setGroupJoinSettings((prev) => ({ ...prev, passwordRequired: Boolean(checked) }))
                    }
                  />
                  <Label htmlFor="group-password-required" className="text-sm font-normal">
                    Require a password to join
                  </Label>
                </div>

                {groupJoinSettings.passwordRequired && (
                  <div className="space-y-2">
                    <Label htmlFor="group-password">Join password</Label>
                    <Input
                      id="group-password"
                      type="password"
                      value={groupPassword}
                      onChange={(event) => setGroupPassword(event.target.value)}
                      placeholder="Minimum 8 characters"
                    />
                    <p className="text-xs text-muted-foreground">
                      Use this for hidden invite/password-gated groups. Admins can rotate it later in settings.
                    </p>
                  </div>
                )}

                <JoinQuestionEditor
                  value={groupJoinSettings.questions ?? []}
                  onChange={(questions) =>
                    setGroupJoinSettings((prev) => ({ ...prev, questions }))
                  }
                />
              </div>

              <Separator />
              <EftPicker value={eftValues} onChange={setEftValues} capitalValue={capitalValues} onCapitalChange={setCapitalValues} auditValue={auditValues} onAuditChange={setAuditValues} />
            </CardContent>
            <CardFooter>
              <Button onClick={handleCreateGroup} disabled={isSubmitting} className="w-full">
                {isSubmitting ? "Creating..." : "Create Group"}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

      </Tabs>

      <CreateOfferingModal
        open={showCreateVoucherModal}
        onClose={() => {
          setShowCreateVoucherModal(false)
          if (urlReturnToThanks) {
            router.push(urlReturnPath || "/")
          }
        }}
        title="Create Voucher Offering"
        description="Create a voucher in the shared offering composer, then return to your Thank flow with it selected."
        initialValues={{
          offeringType: "voucher",
          postToFeed: false,
        }}
        onCreated={(result) => {
          if (urlReturnToThanks) {
            returnToThanksVoucherFlow(result)
            return
          }
          setShowCreateVoucherModal(false)
        }}
      />

      <CreateOfferingModal
        open={showCreateVenueModal}
        onClose={() => setShowCreateVenueModal(false)}
        title="Create Venue Offering"
        description="Create a venue once, then attach bookings to your project or event."
        initialValues={{
          title: projectTitle ? `${projectTitle} Venue` : "",
          description: projectDescription,
          offeringType: "venue",
          targetAgents: projectGroup
            ? eventPublishingGroups
                .filter((group) => group.id === projectGroup)
                .map((group) => ({ id: group.id, name: group.name, type: "organization" }))
            : [],
          scopedLocaleIds: projectVisibilityScope.localeIds,
          scopedGroupIds: projectVisibilityScope.groupIds,
          scopedUserIds: projectVisibilityScope.userIds,
          postToFeed: false,
        }}
        onCreated={handleVenueOfferingCreated}
      />

      {/* Subscription gate dialog for paid creation flows (events, offerings). */}
      <SubscriptionGateDialog
        open={showMembershipGate}
        onOpenChange={setShowMembershipGate}
        requiredTier={gateRequiredTier}
        featureDescription={gateFeatureDescription}
        onTrialStarted={gateAction === "group" ? handleGroupTrialStarted : handleEventTrialStarted}
        returnPath={gateAction === "group" ? "/create?tab=group&resumeGroupCreation=1" : undefined}
      />
    </div>
  )
}
