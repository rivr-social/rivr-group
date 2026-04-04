"use client"

/**
 * Post creation composer for feed/event/group surfaces.
 *
 * Purpose: allows a signed-in user to draft and publish a post with optional
 * post-type metadata, invitation toggles, linked offerings, and image placeholder.
 * Used in: social feed contexts, including scoped event/group timelines.
 * Key props:
 * - `eventId` / `groupId`: optional context IDs attached to created post.
 * - `onPostCreated`: optional callback with optimistic post payload after success.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ChangeEvent } from "react"
import { useRouter } from "next/navigation"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ImagePlus, Heart, HandHeart, Gift, Globe, MapPin, Sailboat, Loader2, X, Share2 } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
import { OfferingType, PostType } from "@/lib/types"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { createPostCommerceResource, createPostResource } from "@/app/actions/create-resources"
import { searchAgentsByType } from "@/app/actions/graph"
import { useMarketplace } from "@/lib/hooks/use-graph-data"
import { VisibilityScopeSelector, type VisibilityScopeState } from "@/components/visibility-scope-selector"
import { Checkbox } from "@/components/ui/checkbox"
import { useLocalesAndBasins } from "@/lib/hooks/use-graph-data"
import { SearchableSelect } from "@/components/searchable-select"
import { ThankModule } from "@/components/thank-module"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  CreateOfferingForm,
  type OfferingDraftPayload,
} from "@/components/create-offering-form"

interface CreatePostProps {
  eventId?: string
  groupId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPostCreated?: (post: any) => void
  eftValues?: Record<string, number>
  capitalValues?: Record<string, number>
  auditValues?: Record<string, number>
  locales?: Array<{ id: string; name: string }>
  selectedLocale?: string
  onLocaleChange?: (localeId: string) => void
}

type FederationState =
  | { status: "idle" | "loading" | "unavailable" }
  | {
      status: "enabled"
      nodeSlug: string
      baseUrl?: string
      queuedEvents?: number
      trustedPeers?: number
    }

/**
 * Renders an expandable post composer and submits post resources.
 *
 * @param props - Component props.
 * @param props.eventId - Optional event context ID for the new post.
 * @param props.groupId - Optional group context ID for the new post.
 * @param props.onPostCreated - Optional callback fired with newly created post data.
 * @returns Post creation card with draft controls and submit actions.
 */
export function CreatePost({ eventId, groupId, onPostCreated, eftValues, capitalValues, auditValues, locales, selectedLocale, onLocaleChange }: CreatePostProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const { data: localeData } = useLocalesAndBasins()
  // Local composer state for content, expansion, submission lock, and optional metadata.
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [isExpanded, setIsExpanded] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [postType, setPostType] = useState<PostType>(PostType.Social)
  const [isLiveInvitation, setIsLiveInvitation] = useState(false)
  const [liveLocation, setLiveLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [linkedOfferingId, setLinkedOfferingId] = useState<string | null>(null)
  const [offeringMode, setOfferingMode] = useState<"none" | "existing" | "new">("none")
  const [offeringComposerOpen, setOfferingComposerOpen] = useState(false)
  const [draftOffering, setDraftOffering] = useState<OfferingDraftPayload | null>(null)
  const [gratitudeRecipientId, setGratitudeRecipientId] = useState<string | null>(null)
  const [gratitudeRecipientName, setGratitudeRecipientName] = useState<string>("")
  const [gratitudeOptions, setGratitudeOptions] = useState<Array<{ value: string; label: string; description?: string }>>([])
  const [hasDeal, setHasDeal] = useState(false)
  const [dealCode, setDealCode] = useState("")
  const [dealPrice, setDealPrice] = useState("")
  const [dealDurationHours, setDealDurationHours] = useState("24")
  const [visibilityScope, setVisibilityScope] = useState<VisibilityScopeState>({
    localeIds: selectedLocale && selectedLocale !== "all" ? [selectedLocale] : [],
    groupIds: [],
    userIds: [],
  })
  const [isGlobalPost, setIsGlobalPost] = useState(true)
  const [shouldFederate, setShouldFederate] = useState(false)
  const [federationState, setFederationState] = useState<FederationState>({ status: "idle" })
  // Lazy marketplace fetch: only load when the composer is expanded AND an Offer
  // post type is selected.  This prevents the 1000+ server action calls that were
  // firing on mount (the event Updates tab rendered CreatePost immediately but the
  // user rarely needs marketplace data until they're actively composing an Offer).
  const wantsMarketplace = isExpanded && postType === PostType.Offer
  const { listings } = useMarketplace(wantsMarketplace ? 200 : 0)
  const resolvedLocales = locales ?? localeData.locales.map((locale) => ({ id: locale.id, name: locale.name }))
  // Derived list: only offerings owned by current user are linkable in this composer.
  const myOfferings = listings.filter((listing) => listing.seller?.id === currentUser?.id)
  const offeringOptions = useMemo(
    () => [
      { value: "none", label: "No offering" },
      ...myOfferings.map((offering) => ({
        value: offering.id,
        label: offering.title,
        description: offering.type,
        keywords: [offering.description ?? "", offering.price ?? ""],
      })),
    ],
    [myOfferings],
  )

  useEffect(() => {
    if (!onLocaleChange) return
    const primaryLocale = visibilityScope.localeIds[0] ?? "all"
    if (primaryLocale === (selectedLocale ?? "all")) return
    onLocaleChange(primaryLocale)
  }, [onLocaleChange, selectedLocale, visibilityScope.localeIds])

  useEffect(() => {
    if (!isExpanded || federationState.status !== "idle") return

    let cancelled = false
    setFederationState({ status: "loading" })

    void (async () => {
      try {
        const response = await fetch("/api/federation/status", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        })

        if (!response.ok) {
          if (!cancelled) {
            setFederationState({ status: "unavailable" })
          }
          return
        }

        const data = (await response.json()) as {
          node?: { slug?: string; baseUrl?: string }
          metrics?: { queuedEvents?: number; trustedPeers?: number }
        }
        if (cancelled) return

        setFederationState({
          status: "enabled",
          nodeSlug: data.node?.slug ?? "local-node",
          baseUrl: data.node?.baseUrl,
          queuedEvents: data.metrics?.queuedEvents,
          trustedPeers: data.metrics?.trustedPeers,
        })
      } catch {
        if (!cancelled) {
          setFederationState({ status: "unavailable" })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [federationState.status, isExpanded])

  useEffect(() => {
    if (!isExpanded || postType !== PostType.Gratitude) return

    let cancelled = false
    void (async () => {
      try {
        const people = await searchAgentsByType("person", undefined, 100)
        if (cancelled) return
        setGratitudeOptions(
          people
            .filter((person) => person.id !== currentUser?.id)
            .map((person) => ({
              value: person.id,
              label: person.name,
              description:
                typeof person.metadata?.username === "string" ? `@${person.metadata.username}` : undefined,
            })),
        )
      } catch {
        if (!cancelled) {
          setGratitudeOptions([])
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentUser?.id, isExpanded, postType])

  const handleLiveInvitationToggle = (checked: boolean) => {
    setIsLiveInvitation(checked)
    if (checked && !liveLocation) {
      if (!navigator.geolocation) {
        toast({ title: "Geolocation not supported", description: "Your browser doesn't support location sharing.", variant: "destructive" })
        setIsLiveInvitation(false)
        return
      }
      setLocationLoading(true)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLiveLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
          setLocationLoading(false)
        },
        (err) => {
          toast({ title: "Location access denied", description: err.message || "Please allow location access to use live invitations.", variant: "destructive" })
          setIsLiveInvitation(false)
          setLocationLoading(false)
        },
        { enableHighAccuracy: true, timeout: 10000 },
      )
    }
    if (!checked) {
      setLiveLocation(null)
    }
  }

  const handleFocus = () => {
    // Expands compact input into the full composer UI.
    setIsExpanded(true)
  }

  const handleCancel = () => {
    // Restores initial draft state and collapses advanced controls.
    setIsExpanded(false)
    setTitle("")
    setContent("")
    setSelectedImage(null)
    setPostType(PostType.Social)
    setIsLiveInvitation(false)
    setLiveLocation(null)
    setLinkedOfferingId(null)
    setOfferingMode("none")
    setDraftOffering(null)
    setOfferingComposerOpen(false)
    setGratitudeRecipientId(null)
    setGratitudeRecipientName("")
    setGratitudeOptions([])
    setHasDeal(false)
    setDealCode("")
    setDealPrice("")
    setDealDurationHours("24")
    setVisibilityScope({
      localeIds: selectedLocale && selectedLocale !== "all" ? [selectedLocale] : [],
      groupIds: [],
      userIds: [],
    })
    setIsGlobalPost(true)
    setShouldFederate(false)
  }

  const handleImageSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
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

      setSelectedImage(uploadedUrl)
    } catch (error) {
      toast({
        title: "Image upload failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUploading(false)
      // Reset the input so re-selecting the same file triggers onChange again.
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  const handleRemoveImage = () => {
    setSelectedImage(null)
  }

  const handleSubmit = async () => {
    // Guard clause prevents empty submissions and duplicate concurrent requests.
    if (!content.trim() || isSubmitting) return

    setIsSubmitting(true)
    try {
      const hasInlineCommerce =
        postType === PostType.Offer &&
        (offeringMode !== "none" || hasDeal)
      const localeIds = visibilityScope.localeIds.filter((id) => id !== "all")
      const localeId = localeIds[0] ?? null
      const canFederateVisibility = visibilityScope.groupIds.length === 0 && visibilityScope.userIds.length === 0
      const federate = shouldFederate && federationState.status === "enabled" && canFederateVisibility

      if (!isGlobalPost && visibilityScope.localeIds.length === 0 && visibilityScope.groupIds.length === 0 && visibilityScope.userIds.length === 0) {
        throw new Error("Choose at least one locale, group, or person when global visibility is off.")
      }

      if (postType === PostType.Offer && offeringMode === "existing" && !linkedOfferingId) {
        throw new Error("Choose an existing offering to link.")
      }

      if (postType === PostType.Offer && offeringMode === "new") {
        if (!draftOffering?.title?.trim()) throw new Error("Configure the new offering before posting.")
      }

      if (hasDeal) {
        if (!dealPrice || Number(dealPrice) <= 0) {
          throw new Error("Enter a valid deal price.")
        }
      }

      const gratitudeRecipientIdValue =
        postType === PostType.Gratitude ? gratitudeRecipientId : null
      const gratitudeRecipientNameValue =
        postType === PostType.Gratitude ? gratitudeRecipientName || null : null

      const result = hasInlineCommerce
        ? await createPostCommerceResource({
            title: title.trim(),
            content,
            postType,
            isLiveInvitation: isLiveInvitation,
            liveLocation: isLiveInvitation ? liveLocation : null,
            linkedOfferingId: offeringMode === "existing" ? linkedOfferingId : null,
            createOffering:
              offeringMode === "new"
                ? {
                    title: draftOffering!.title.trim(),
                    description: draftOffering!.description.trim() || content.trim(),
                    imageUrl: draftOffering!.imageUrl,
                    offeringType: draftOffering!.offeringType ?? OfferingType.Product,
                    basePriceCents: draftOffering!.basePrice,
                    currency: draftOffering!.currency,
                    acceptedCurrencies: draftOffering!.acceptedCurrencies,
                    quantityAvailable: draftOffering!.quantityAvailable,
                    tags: draftOffering!.tags,
                    items: draftOffering!.items,
                    voucherValues: draftOffering!.voucherValues,
                    hourlyRate: draftOffering!.hourlyRate,
                    estimatedDuration: draftOffering!.estimatedDuration,
                    availability: draftOffering!.availability,
                    category: draftOffering!.category,
                    condition: draftOffering!.condition,
                    bountyReward: draftOffering!.bountyReward,
                    bountyCriteria: draftOffering!.bountyCriteria,
                    bountyDeadline: draftOffering!.bountyDeadline,
                    ticketEventName: draftOffering!.ticketEventName,
                    ticketDate: draftOffering!.ticketDate,
                    ticketVenue: draftOffering!.ticketVenue,
                    ticketQuantity: draftOffering!.ticketQuantity,
                    ticketPrice: draftOffering!.ticketPrice,
                    tripOrigin: draftOffering!.tripOrigin,
                    tripDestination: draftOffering!.tripDestination,
                    tripDate: draftOffering!.tripDate,
                    tripCapacity: draftOffering!.tripCapacity,
                    skillArea: draftOffering!.skillArea,
                    skillProficiency: draftOffering!.skillProficiency,
                    skillRate: draftOffering!.skillRate,
                    resourceCategory: draftOffering!.resourceCategory,
                    resourceAvailability: draftOffering!.resourceAvailability,
                    resourceCondition: draftOffering!.resourceCondition,
                    resourcePrice: draftOffering!.resourcePrice,
                    dataFormat: draftOffering!.dataFormat,
                    dataSize: draftOffering!.dataSize,
                    dataPrice: draftOffering!.dataPrice,
                  }
                : null,
            dealCode: hasDeal ? dealCode.trim() || null : null,
            dealPriceCents: hasDeal ? Math.round(Number(dealPrice) * 100) : null,
            dealDurationHours: hasDeal ? Number(dealDurationHours) : null,
            eventId,
            groupId,
            imageUrl: selectedImage,
            localeId,
            scopedLocaleIds: localeIds,
            scopedGroupIds: visibilityScope.groupIds,
            scopedUserIds: visibilityScope.userIds,
            isGlobal: isGlobalPost,
            eftValues: eftValues && Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
            capitalValues: capitalValues && Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
            auditValues: auditValues && Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
            gratitudeRecipientId: gratitudeRecipientIdValue,
            gratitudeRecipientName: gratitudeRecipientNameValue,
            federate,
          })
        : await createPostResource({
            title: title.trim(),
            content,
            postType,
            isLiveInvitation: postType === PostType.Social && isLiveInvitation,
            liveLocation: postType === PostType.Social && isLiveInvitation ? liveLocation : null,
            linkedOfferingId,
            eventId,
            groupId,
            imageUrl: selectedImage,
            localeId,
            scopedLocaleIds: localeIds,
            scopedGroupIds: visibilityScope.groupIds,
            scopedUserIds: visibilityScope.userIds,
            isGlobal: isGlobalPost,
            eftValues: eftValues && Object.values(eftValues).some(v => v > 0) ? eftValues : undefined,
            capitalValues: capitalValues && Object.values(capitalValues).some(v => v > 0) ? capitalValues : undefined,
            auditValues: auditValues && Object.values(auditValues).some(v => v > 0) ? auditValues : undefined,
            gratitudeRecipientId: gratitudeRecipientIdValue,
            gratitudeRecipientName: gratitudeRecipientNameValue,
            federate,
          })

      if (!result.success || !result.resourceId) {
        setIsSubmitting(false)
        toast({
          title: "Failed to create post",
          description: result.error?.details ? `${result.message}: ${result.error.details}` : result.message,
          variant: "destructive",
        })
        return
      }

      // Local optimistic payload used by parent feed update callback.
      const newPost = {
        id: result.resourceId,
        author: currentUser?.id,
        title: title.trim(),
        content,
        postType,
        isLiveInvitation: postType === PostType.Social && isLiveInvitation,
        linkedOfferingId,
        dealCode: hasDeal ? dealCode : undefined,
        dealPriceCents: hasDeal ? Math.round(Number(dealPrice) * 100) : undefined,
        timestamp: new Date().toISOString(),
        likes: 0,
        comments: 0,
        images: selectedImage ? [selectedImage] : [],
        eventId,
        groupId,
        gratitudeRecipientId: postType === PostType.Gratitude ? gratitudeRecipientId : undefined,
        gratitudeRecipientName: postType === PostType.Gratitude ? gratitudeRecipientName : undefined,
        chapterTags:
          localeIds,
      }

      // Side effects on success: notify parent, reset composer, toast, and refresh route data.
      onPostCreated?.(newPost)
      handleCancel()
      setIsSubmitting(false)
      toast({ title: result.message || "Post created successfully!" })
      router.refresh()
    } catch {
      setIsSubmitting(false)
      toast({
        title: "Failed to create post",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keyboard shortcut: Cmd/Ctrl+Enter submits from textarea.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }
  
  return (
    <Card className="border shadow-sm mb-6">
      <CardContent className="p-4">
        <div className="flex gap-3">
          <Avatar className="h-10 w-10">
            <AvatarImage src={currentUser?.avatar} alt={currentUser?.name} />
            <AvatarFallback>{currentUser?.name?.substring(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onFocus={handleFocus}
              onKeyDown={handleKeyDown}
              placeholder={`What's on your mind, ${currentUser?.name}?`}
              className={`resize-none transition-all duration-300 ${isExpanded ? "min-h-[120px]" : "min-h-[40px]"}`}
            />
            {/* Conditional rendering: advanced composer controls appear only after focus. */}
            {isExpanded && (
              <div className="space-y-3 mt-3">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Add a title"
                  className="text-base font-medium"
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant={postType === PostType.Social ? 'default' : 'outline'} size="sm" onClick={() => setPostType(PostType.Social)}>Social</Button>
                  <Button variant={postType === PostType.Offer ? 'default' : 'outline'} size="sm" onClick={() => setPostType(PostType.Offer)}><Gift className="h-4 w-4 mr-2" />Offer</Button>
                  <Button variant={postType === PostType.Request ? 'default' : 'outline'} size="sm" onClick={() => setPostType(PostType.Request)}><HandHeart className="h-4 w-4 mr-2" />Request</Button>
                  <Button variant={postType === PostType.Gratitude ? 'default' : 'outline'} size="sm" onClick={() => setPostType(PostType.Gratitude)}><Heart className="h-4 w-4 mr-2" />Gratitude</Button>
                </div>
                <VisibilityScopeSelector
                  value={visibilityScope}
                  onChange={setVisibilityScope}
                  locales={resolvedLocales}
                />
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="post-global"
                    checked={isGlobalPost}
                    onCheckedChange={(checked) => setIsGlobalPost(checked === true)}
                  />
                  <Label htmlFor="post-global" className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    Show globally
                  </Label>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="post-federate" className="flex items-center gap-2 text-sm font-medium">
                        <Share2 className="h-4 w-4 text-muted-foreground" />
                        Federate this post
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {federationState.status === "loading"
                          ? "Checking your federation node..."
                          : federationState.status === "enabled"
                            ? `Queue this post for export from ${federationState.nodeSlug}${typeof federationState.trustedPeers === "number" ? ` to ${federationState.trustedPeers} trusted peer${federationState.trustedPeers === 1 ? "" : "s"}` : ""}.`
                            : "Federation is only available for accounts that own a hosted federation node on this deployment."}
                      </p>
                      {visibilityScope.groupIds.length > 0 || visibilityScope.userIds.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Federation currently supports public and locale-scoped posts, not group- or person-restricted posts.
                        </p>
                      ) : null}
                    </div>
                    <Switch
                      id="post-federate"
                      checked={shouldFederate}
                      onCheckedChange={setShouldFederate}
                      disabled={
                        federationState.status !== "enabled" ||
                        visibilityScope.groupIds.length > 0 ||
                        visibilityScope.userIds.length > 0
                      }
                    />
                  </div>
                </div>
                {/* Conditional rendering: invitation toggle applies only to social posts. */}
                {postType === PostType.Social && (
                    <div className="space-y-2">
                        <div className="flex items-center space-x-2">
                            <Switch id="live-invitation" checked={isLiveInvitation} onCheckedChange={handleLiveInvitationToggle} disabled={locationLoading} />
                            <Label htmlFor="live-invitation" className="flex items-center gap-2 text-sm">
                                <Sailboat className="h-4 w-4"/>
                                {locationLoading ? "Getting location..." : "Mark as Live Invitation"}
                            </Label>
                        </div>
                        {isLiveInvitation && liveLocation && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                Your location will be shared on the map for 1 hour
                            </p>
                        )}
                    </div>
                )}
                {postType === PostType.Gratitude && (
                  <div className="grid gap-3 rounded-lg border p-3">
                    <div>
                      <Label>Who are you thanking?</Label>
                      <SearchableSelect
                        value={gratitudeRecipientId || "none"}
                        onChange={(value) => {
                          if (value === "none") {
                            setGratitudeRecipientId(null)
                            setGratitudeRecipientName("")
                            return
                          }
                          const match = gratitudeOptions.find((option) => option.value === value)
                          setGratitudeRecipientId(value)
                          setGratitudeRecipientName(match?.label ?? "")
                        }}
                        options={[
                          { value: "none", label: "No recipient selected" },
                          ...gratitudeOptions,
                        ]}
                        placeholder="Select a person to thank..."
                        searchPlaceholder="Search people..."
                        emptyLabel="No people found."
                      />
                    </div>
                    {gratitudeRecipientId && gratitudeRecipientName ? (
                      <div className="rounded-md bg-muted/40 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Heart className="h-4 w-4 text-primary" />
                          <p className="text-sm font-medium">Send tangible thanks to {gratitudeRecipientName}</p>
                        </div>
                        <ThankModule
                          recipientId={gratitudeRecipientId}
                          recipientName={gratitudeRecipientName}
                          context="gratitude-post"
                          inline
                        />
                      </div>
                    ) : null}
                  </div>
                )}
                {/* Conditional rendering: offering link picker applies only to offer/request posts. */}
                {(postType === PostType.Offer || postType === PostType.Request) && (
                    <div className="space-y-2">
                        <Label>Offer Commerce</Label>
                        <div className="flex flex-wrap gap-2">
                          <Button variant={offeringMode === "none" ? "default" : "outline"} size="sm" onClick={() => setOfferingMode("none")}>No Offer</Button>
                          <Button variant={offeringMode === "existing" ? "default" : "outline"} size="sm" onClick={() => setOfferingMode("existing")}>Link Existing</Button>
                          <Button variant={offeringMode === "new" ? "default" : "outline"} size="sm" onClick={() => setOfferingMode("new")}>Create New</Button>
                        </div>

                        {offeringMode === "existing" && (
                          <SearchableSelect
                            value={linkedOfferingId || "none"}
                            onChange={(value) => setLinkedOfferingId(value === "none" ? null : value)}
                            options={offeringOptions}
                            placeholder="Choose an offering to link..."
                            searchPlaceholder="Search your offerings..."
                            emptyLabel="No offerings found."
                          />
                        )}

                        {offeringMode === "new" && (
                          <div className="grid gap-3 rounded-lg border p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium">Embedded offering</p>
                                <p className="text-xs text-muted-foreground">
                                  Create the structured offering once, then publish it through this post.
                                </p>
                              </div>
                              <Button type="button" variant="outline" size="sm" onClick={() => setOfferingComposerOpen(true)}>
                                {draftOffering ? "Edit Offering" : "Configure Offering"}
                              </Button>
                            </div>
                            {draftOffering ? (
                              <div className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
                                <div className="font-medium">{draftOffering.title}</div>
                                <div className="text-muted-foreground">
                                  {(draftOffering.offeringType ?? "offering").toString()}
                                  {draftOffering.basePrice ? ` · $${(draftOffering.basePrice / 100).toFixed(2)}` : ""}
                                </div>
                                {draftOffering.description ? (
                                  <div className="text-muted-foreground line-clamp-2">{draftOffering.description}</div>
                                ) : null}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">
                                No embedded offering configured yet.
                              </div>
                            )}
                          </div>
                        )}

                        {postType === PostType.Offer && offeringMode !== "none" && (
                          <div className="grid gap-3 rounded-lg border p-3">
                            <div className="flex items-center space-x-2">
                              <Switch id="post-deal-toggle" checked={hasDeal} onCheckedChange={setHasDeal} />
                              <Label htmlFor="post-deal-toggle">Include post-specific deal</Label>
                            </div>
                            {hasDeal && (
                              <div className="grid grid-cols-3 gap-2">
                                <div className="space-y-2">
                                  <Label htmlFor="deal-code">Deal Code</Label>
                                  <Textarea id="deal-code" value={dealCode} onChange={(e) => setDealCode(e.target.value)} className="min-h-[40px]" />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor="deal-price">Deal Price</Label>
                                  <Textarea id="deal-price" value={dealPrice} onChange={(e) => setDealPrice(e.target.value)} className="min-h-[40px]" />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor="deal-duration">Deal Hours</Label>
                                  <Textarea id="deal-duration" value={dealDurationHours} onChange={(e) => setDealDurationHours(e.target.value)} className="min-h-[40px]" />
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                    </div>
                )}
                {/* Image preview with remove button */}
                {selectedImage && (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={selectedImage}
                      alt="Selected upload"
                      className="max-h-48 rounded-md border object-cover"
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-1 right-1 h-6 w-6 rounded-full"
                      onClick={handleRemoveImage}
                      aria-label="Remove image"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageSelect}
                />
                <div className="flex justify-between items-center">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    aria-label="Add image"
                  >
                    {isUploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="h-4 w-4" />
                    )}
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
                    <Button size="sm" onClick={handleSubmit} disabled={!content.trim() || isSubmitting}>
                      {isSubmitting ? "Posting..." : "Post"}
                    </Button>
                  </div>
                </div>
                <Dialog open={offeringComposerOpen} onOpenChange={setOfferingComposerOpen}>
                  {offeringComposerOpen ? (
                    <DialogContent
                      className="max-w-4xl max-h-[90vh] overflow-y-auto"
                      onInteractOutside={(event) => event.preventDefault()}
                      onEscapeKeyDown={(event) => event.preventDefault()}
                    >
                      <DialogHeader>
                        <DialogTitle>Configure Embedded Offering</DialogTitle>
                        <DialogDescription>
                          This offering will be created and attached when you publish the post. Visibility comes from the post scope.
                        </DialogDescription>
                      </DialogHeader>
                      <CreateOfferingForm
                        scopeMode="external"
                        submitLabel="Use in Post"
                        titleText="Embedded Offering"
                        initialValues={{
                          ...(draftOffering ?? {}),
                          offeringType: draftOffering?.offeringType ?? OfferingType.Product,
                        }}
                        onCancel={() => setOfferingComposerOpen(false)}
                        onSubmitPayload={(payload) => {
                          setDraftOffering(payload)
                          setOfferingComposerOpen(false)
                        }}
                      />
                    </DialogContent>
                  ) : null}
                </Dialog>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
