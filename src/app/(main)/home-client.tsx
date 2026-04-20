"use client"

import { useState, useMemo, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PostFeed } from "@/components/post-feed"
import { GroupFeed } from "@/components/group-feed"
import { PeopleFeed } from "@/components/people-feed"
import { EventFeed } from "@/components/event-feed"
import type { Group, Ring, Family, Post, User, MarketplaceListing, Basin, Chapter } from "@/lib/types"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useRouter } from "next/navigation"
import { Search, ChevronRight } from "lucide-react"
import Link from "next/link"
import { MarketplaceFeed } from "@/components/marketplace-feed"
import { GigsFeed } from "@/components/gigs-feed"
import { useToast } from "@/components/ui/use-toast"
import { useAppContext } from "@/contexts/app-context"
import { useUser } from "@/contexts/user-context"
import {
  setEventRsvp,
  toggleFollowAgent,
  toggleJoinGroup,
  toggleLikeOnTarget,
  toggleSaveListing,
} from "@/app/actions/interactions"

/**
 * Client-side home feed UI used by the main home route (`/`).
 *
 * Route usage: Rendered by `src/app/(main)/page.tsx` for `/`.
 * Rendering: Client Component (`"use client"`), hydrated with server-provided initial data.
 * Data requirements:
 * - Initial people/groups/events/places/marketplace/basins/locales from the server page component.
 * - Live posts via `usePosts`.
 *
 * Metadata: This file does not export `metadata` or `generateMetadata`.
 */
type GraphEvent = ReturnType<typeof import("@/lib/graph-adapters").agentToEvent>
type GraphPlace = ReturnType<typeof import("@/lib/graph-adapters").agentToPlace>
interface HomeClientProps {
  initialPeople: User[]
  initialGroups: Group[]
  initialEvents: GraphEvent[]
  initialPlaces: GraphPlace[]
  initialMarketplace: MarketplaceListing[]
  initialPosts: Post[]
  initialBasins: Basin[]
  initialLocales: Chapter[]
}

/**
 * Renders the interactive home experience, including feed tabs and authenticated actions.
 *
 * @param props Initial, server-fetched datasets used to hydrate client state.
 * @returns Home page client UI with tabbed feeds and scoped filtering.
 */
export default function HomeClient({
  initialPeople,
  initialGroups,
  initialEvents,
  initialPlaces: _initialPlaces,
  initialMarketplace,
  initialPosts,
  initialBasins,
  initialLocales,
}: HomeClientProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { state: appState } = useAppContext()
  const { currentUser } = useUser()
  const isAuthenticated = !!currentUser
  const selectedLocale = appState.selectedChapter || "all"
  const [activeTab, setActiveTab] = useState("posts")
  const [groupTypeFilter, setGroupTypeFilter] = useState<string>("all")
  const [groupSearchQuery, setGroupSearchQuery] = useState("")
  const [savedListings, setSavedListings] = useState<string[]>([])
  const [rsvpStatuses, setRsvpStatuses] = useState<Record<string, "going" | "interested" | "none">>({})

  // Use server-rendered data directly. No client-side re-fetch on mount — the server
  // page component already provides fresh data, and re-fetching causes visible flashing
  // as React reconciles the two data sources with different object references.
  const activePeople = initialPeople
  const activeGroups = initialGroups as Group[]
  const activeEvents = initialEvents
  const activeMarketplace = initialMarketplace
  const activePosts = initialPosts
  const localeData = {
    basins: initialBasins,
    locales: initialLocales,
  }

  /** Navigates to the create route and preselects the post composer tab. */
  const handleCreatePost = () => {
    router.push("/create?tab=post")
  }

  /**
   * Toggles like state for a post and surfaces the server action result.
   *
   * @param postId Post identifier to like or unlike.
   */
  const handleLike = async (postId: string) => {
    const result = await toggleLikeOnTarget(postId, "post")
    toast({
      title: result.success ? (result.active ? "Liked" : "Unliked") : "Could not like post",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    })
  }

  /**
   * Redirects to the post detail page with comments focused.
   *
   * @param postId Post identifier used in the destination URL.
   */
  const handleComment = (postId: string) => {
    router.push(`/posts/${postId}?focus=comments`)
  }

  /**
   * Shares a post URL using Web Share when available, otherwise clipboard fallback.
   *
   * @param postId Post identifier to build a canonical share URL.
   */
  const handleShare = async (postId: string) => {
    const shareUrl = `${window.location.origin}/posts/${postId}`
    if (navigator.share) {
      await navigator.share({ title: "Post", url: shareUrl })
      return
    }
    await navigator.clipboard.writeText(shareUrl)
    toast({
      title: "Link copied",
      description: "Post link copied to clipboard.",
    })
  }

  /**
   * Toggles membership for a group and displays the result.
   *
   * @param groupId Group identifier to join or leave.
   */
  const handleJoin = async (groupId: string) => {
    const result = await toggleJoinGroup(groupId, "group")
    toast({
      title: result.success ? (result.active ? "Joined group" : "Left group") : "Could not join group",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    })
  }

  /**
   * Toggles follow/connection state with another user.
   *
   * @param userId User identifier to follow or unfollow.
   */
  const handleConnect = async (userId: string) => {
    const result = await toggleFollowAgent(userId)
    toast({
      title: result.success ? (result.active ? "Connected" : "Disconnected") : "Could not connect",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    })
  }

  /**
   * Updates RSVP status for an event and stores the local status map for immediate UI feedback.
   *
   * @param eventId Event identifier being updated.
   * @param status RSVP status selected by the user.
   */
  const handleEventRsvp = async (eventId: string, status: "going" | "interested" | "maybe" | "none") => {
    const normalizedStatus = status === "maybe" ? "interested" : status
    const result = await setEventRsvp(eventId, normalizedStatus)
    if (!result.success) {
      toast({
        title: "Could not update RSVP",
        description: result.message,
        variant: "destructive",
      })
      return
    }
    setRsvpStatuses((prev) => ({ ...prev, [eventId]: normalizedStatus }))
    toast({
      title: "RSVP updated",
      description: result.message,
    })
  }

  /**
   * Toggles marketplace listing saved state and mirrors it in local UI state.
   *
   * @param listingId Marketplace listing identifier.
   */
  const handleSaveMarketplace = async (listingId: string) => {
    const result = await toggleSaveListing(listingId)
    if (!result.success) {
      toast({
        title: "Could not save listing",
        description: result.message,
        variant: "destructive",
      })
      return
    }
    setSavedListings((prev) => (
      result.active ? [...prev, listingId] : prev.filter((id) => id !== listingId)
    ))
    toast({
      title: result.active ? "Listing saved" : "Listing removed",
      description: result.message,
    })
  }

  /**
   * Redirects to messaging with the selected listing prefilled.
   *
   * @param listingId Marketplace listing identifier passed in query params.
   */
  const handleContactMarketplace = (listingId: string) => {
    const listing = activeMarketplace.find((item) => item.id === listingId)
    const sellerId = listing?.seller?.id

    router.push(sellerId ? `/messages?user=${sellerId}` : `/messages?listing=${listingId}`)
  }

  /**
   * Shares a marketplace listing URL using Web Share or clipboard fallback.
   *
   * @param listingId Marketplace listing identifier to share.
   */
  const handleShareListing = async (listingId: string) => {
    const shareUrl = `${window.location.origin}/marketplace/${listingId}`
    if (navigator.share) {
      await navigator.share({ title: "Mart listing", url: shareUrl })
      return
    }
    await navigator.clipboard.writeText(shareUrl)
    toast({
      title: "Link copied",
      description: "Listing link copied to clipboard.",
    })
  }

  // Build locale/basin lookup sets used by scope-aware filtering (memoized to prevent re-renders).
  const basinIds = useMemo(() => new Set(localeData.basins.map((basin) => basin.id)), [localeData.basins])
  const selectedLocaleRecord = useMemo(
    () => localeData.locales.find((locale) => locale.id === selectedLocale),
    [localeData.locales, selectedLocale]
  )
  const selectedScopeAliases = useMemo(
    () => new Set([selectedLocale, selectedLocaleRecord?.slug].filter((value): value is string => !!value)),
    [selectedLocale, selectedLocaleRecord?.slug]
  )
  const selectedBasinLocaleIds = useMemo(
    () =>
      selectedLocale !== "all" && basinIds.has(selectedLocale)
        ? new Set(
            localeData.locales
              .filter((locale) => locale.basinId === selectedLocale)
              .flatMap((locale) => [locale.id, locale.slug].filter((value): value is string => !!value))
          )
        : null,
    [selectedLocale, basinIds, localeData.locales]
  )

  /**
   * Determines whether an entity's tags match the currently selected locale or basin scope.
   */
  const matchesScope = useCallback(
    (tags: string[] | undefined) =>
      selectedLocale === "all" ||
      !!tags?.some((tag) => selectedScopeAliases.has(tag)) ||
      !!(selectedBasinLocaleIds && tags?.some((tag) => selectedBasinLocaleIds.has(tag))),
    [selectedLocale, selectedScopeAliases, selectedBasinLocaleIds]
  )

  // Filter posts by selected locale
  const filteredPosts = useMemo(
    () => selectedLocale === "all"
      ? activePosts
      : activePosts.filter((post) =>
        matchesScope(post.tags) ||
        matchesScope(post.groupTags) ||
        matchesScope(post.chapterTags)
      ),
    [activePosts, selectedLocale, matchesScope]
  )

  // Filter events by selected locale
  const filteredEvents = useMemo(
    () => activeEvents.filter((event) =>
      matchesScope((event as { chapterTags?: string[] }).chapterTags)
    ),
    [activeEvents, matchesScope]
  )

  // Filter groups by selected locale, type, and search query
  const filteredGroups = useMemo(
    () => activeGroups.filter((group) => {
      const g = group as Group & { type?: string; tags?: string[] }
      const localeMatch = matchesScope(g.tags) || matchesScope(g.chapterTags)
      const groupType = g.type as string | undefined
      const typeMatch = groupTypeFilter === "all" ||
        (groupTypeFilter === "org" && (!groupType || groupType === "org" || groupType === "group" || groupType === "organization")) ||
        (groupTypeFilter === "ring" && groupType === "ring") ||
        (groupTypeFilter === "basic" && groupType === "basic")
      const searchMatch = !groupSearchQuery ||
        g.name.toLowerCase().includes(groupSearchQuery.toLowerCase()) ||
        g.description?.toLowerCase().includes(groupSearchQuery.toLowerCase())
      const isFamilyType = groupType === "family"
      return localeMatch && typeMatch && searchMatch && !isFamilyType
    }),
    [activeGroups, matchesScope, groupTypeFilter, groupSearchQuery]
  )

  // Filter users by selected locale
  const filteredPeople = useMemo(
    () => activePeople.filter((user) =>
      matchesScope(user.chapterTags)
    ),
    [activePeople, matchesScope]
  )

  // Filter marketplace by selected locale
  const filteredMarketplace = useMemo(
    () => activeMarketplace.filter((listing) =>
      matchesScope(listing.tags)
    ),
    [activeMarketplace, matchesScope]
  )

  /** Resolves a chapter/locale ID to its display name. Returns the raw id if not found. */
  const localeNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const locale of initialLocales) {
      map.set(locale.id, locale.name)
      if (locale.slug) map.set(locale.slug, locale.name)
    }
    for (const basin of initialBasins) {
      map.set(basin.id, basin.name)
    }
    return map
  }, [initialLocales, initialBasins])

  const resolveChapterName = useCallback(
    (id: string) => localeNameMap.get(id) || id,
    [localeNameMap]
  )

  // Get current chapter name
  const currentLocaleName =
    selectedLocale === "all" ? "All Locales" : localeData.locales.find((l) => l.id === selectedLocale)?.name || "All Locales"

  const fallbackUser: User = {
    id: "",
    name: "Unknown User",
    username: "unknown",
    avatar: "/placeholder-user.jpg",
    followers: 0,
    following: 0,
  }

  /**
   * Resolves a user by id with deterministic fallbacks for missing data.
   *
   * @param userId Target user identifier.
   * @returns Found user, first available user, or fallback placeholder user.
   */
  const getUser = (userId: string) => {
    return activePeople.find((user) => user.id === userId) || activePeople[0] || fallbackUser
  }

  /**
   * Resolves a group by id with fallback placeholder data.
   *
   * @param groupId Target group identifier.
   * @returns Found group, first available group, or fallback placeholder group.
   */
  const getGroup = (groupId: string) => {
    return activeGroups.find((group) => group.id === groupId) || activeGroups[0] || ({
      id: "",
      name: "Unknown Group",
      description: "",
      image: "",
      memberCount: 0,
      createdAt: "1970-01-01T00:00:00.000Z",
    } as Group)
  }

  /** @param groupId Group identifier. @returns Group display name. */
  const getGroupName = (groupId: string) => getGroup(groupId).name
  /** @param groupId Group identifier. @returns Same identifier for feed API compatibility. */
  const getGroupId = (groupId: string) => groupId

  /**
   * Resolves an event creator from event creator/organizer references.
   *
   * @param eventId Event identifier used to locate creator fields.
   * @returns Matching user or fallback placeholder user.
   */
  const getEventCreator = (eventId: string) => {
    const event = activeEvents.find((e) => e.id === eventId)
    const creatorId = event?.creator || (typeof event?.organizer === "string" ? event.organizer : "")
    if (creatorId) {
      const found = activePeople.find((p) => p.id === creatorId)
      if (found) return found
    }
    return fallbackUser
  }

  /** @param eventId Event identifier. @returns Event creator display name. */
  const getCreatorName = (eventId: string) => getEventCreator(eventId).name
  /** @param eventId Event identifier. @returns Event creator username. */
  const getCreatorUsername = (eventId: string) => getEventCreator(eventId).username

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="mb-4">
        {selectedLocale !== "all" ? (
          <Link href={`/locales/${selectedLocale}`} className="inline-flex items-center gap-2 group">
            {localeData.locales.find((l) => l.id === selectedLocale)?.image && (
              <Image
                src={localeData.locales.find((l) => l.id === selectedLocale)!.image}
                alt={currentLocaleName}
                width={36}
                height={36}
                className="h-9 w-9 rounded-full object-cover border"
              />
            )}
            <h2 className="text-xl font-bold group-hover:text-primary transition-colors">{currentLocaleName}</h2>
            <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
          </Link>
        ) : (
          <h2 className="text-xl font-bold">{currentLocaleName}</h2>
        )}
      </div>

      {/*
        Ticket #109: the sticky "Boulder"-style ChapterHeader pill bar has
        been removed. The locale heading above and the top-bar
        LocaleSwitcher already convey this context.
      */}

      {/* Post input box (auth required) */}
      {/* Auth-gated redirect entrypoint into `/create?tab=post`. */}
      {isAuthenticated && (
        <div className="mb-6 p-4">
          <div className="flex gap-3">
            <Avatar className="h-10 w-10">
              <AvatarImage src={currentUser?.avatar} alt={currentUser?.name || "Your profile"} />
              <AvatarFallback>{currentUser?.name?.substring(0, 2).toUpperCase() || "U"}</AvatarFallback>
            </Avatar>
            <Input
              placeholder="What's happening in your community?"
              className="bg-muted border-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-base cursor-pointer"
              onClick={handleCreatePost}
              readOnly
            />
          </div>
        </div>
      )}

      <Tabs defaultValue="posts" value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex w-full mb-4 gap-0">
          <TabsTrigger value="posts" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">Posts</TabsTrigger>
          <TabsTrigger value="events" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">Events</TabsTrigger>
          <TabsTrigger value="groups" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">Groups</TabsTrigger>
          <TabsTrigger value="people" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">People</TabsTrigger>
          <TabsTrigger value="gigs" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">Gigs</TabsTrigger>
          <TabsTrigger value="marketplace" className="flex-1 px-1 text-xs sm:text-sm sm:px-3">Mart</TabsTrigger>
        </TabsList>
        <TabsContent value="posts" className="mt-0">
          <PostFeed
            posts={filteredPosts as Post[]}
            events={[]}
            groups={[]}
            listings={activeMarketplace}
            getUser={getUser}
            getGroup={getGroup}
            onLike={handleLike}
            onComment={handleComment}
            onShare={handleShare}
            onRsvp={handleEventRsvp}
            includeAllTypes={false}
            resolveChapterName={resolveChapterName}
          />
        </TabsContent>
        <TabsContent value="events" className="mt-0">
          <EventFeed
            events={filteredEvents}
            getGroupName={getGroupName}
            getGroupId={getGroupId}
            getCreatorName={getCreatorName}
            getCreatorUsername={getCreatorUsername}
            onRsvpChange={handleEventRsvp}
            initialRsvpStatuses={rsvpStatuses}
          />
        </TabsContent>
        <TabsContent value="groups" className="mt-0">
          {/* Conditional filtering controls update `groupTypeFilter` and `groupSearchQuery`. */}
          <div className="mb-4 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search groups..."
                value={groupSearchQuery}
                onChange={(e) => setGroupSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex gap-2">
              <Button variant={groupTypeFilter === "all" ? "default" : "outline"} size="sm" onClick={() => setGroupTypeFilter("all")}>All</Button>
              <Button variant={groupTypeFilter === "org" ? "default" : "outline"} size="sm" onClick={() => setGroupTypeFilter("org")}>Organizations</Button>
              <Button variant={groupTypeFilter === "ring" ? "default" : "outline"} size="sm" onClick={() => setGroupTypeFilter("ring")}>Rings</Button>
              <Button variant={groupTypeFilter === "basic" ? "default" : "outline"} size="sm" onClick={() => setGroupTypeFilter("basic")}>Basic</Button>
            </div>
          </div>
          <GroupFeed
            groups={filteredGroups}
            onJoinGroup={handleJoin}
            chapterId={selectedLocale}
            includeAllTypes={true}
            resolveLocationName={resolveChapterName}
          />
        </TabsContent>
        <TabsContent value="people" className="mt-0">
          <PeopleFeed people={filteredPeople} onConnect={handleConnect} />
        </TabsContent>
        <TabsContent value="gigs" className="mt-0">
          <GigsFeed selectedLocale={selectedLocale} />
        </TabsContent>
        <TabsContent value="marketplace" className="mt-0">
          <MarketplaceFeed
            listings={filteredMarketplace}
            getSeller={getUser}
            onSave={handleSaveMarketplace}
            onContact={handleContactMarketplace}
            onShare={handleShareListing}
            savedListings={savedListings}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
