"use client"

import { useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { ChevronDown, ChevronUp, EyeOff, Heart, MessageCircle, MoreHorizontal, Pencil, Radio, Share2, Trash2, UserMinus2 } from "lucide-react"
import { ThankModule } from "@/components/thank-module"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import type { MarketplaceListing, Post, User, Group, Event } from "@/lib/types"
import { PostType, OfferingType } from "@/lib/types"
import { JoinType } from "@/lib/types"
import { EftMiniChart } from "@/components/eft-picker"
import { useMarketplace } from "@/lib/hooks/use-graph-data"
import { useUser } from "@/contexts/user-context"
import { useToast } from "@/components/ui/use-toast"
import { deleteResource, updateResource } from "@/app/actions/create-resources"
import { fetchHiddenContentPreferences, fetchReactionSummaries, toggleHiddenContent, type ReactionType } from "@/app/actions/interactions"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ImageUpload } from "@/components/image-upload"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { CommentFeed } from "@/components/comment-feed"
import { ReactionButton } from "@/components/reaction-button"
import { RelativeTime } from "@/components/relative-time"

const STABLE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z"

/**
 * Unified social feed renderer used by feed/home-style pages to display posts, plus optional
 * event and group cards in one stream.
 * Key props:
 * - `posts`, `events`, `groups`: source collections for feed items.
 * - `getUser`, `getGroup`, `getEventCreator`: entity resolvers for display data.
 * - `onLike`, `onComment`, `onShare`, `onRsvp`, `onJoinGroup`: interaction callbacks.
 * - `includeAllTypes`, `query`, `chapterId`: controls feed composition and filtering.
 */

// Helper function to filter posts based on query and chapterId
function filterPosts(posts: Post[], query?: string, chapterId?: string) {
  let filtered = [...posts]

  // Filter by chapter if specified
  if (chapterId && chapterId !== "all") {
    filtered = filtered.filter((post) => (post.chapterTags ?? []).includes(chapterId))
  }

  // Filter by query if specified
  if (query && query.trim() !== "") {
    const normalizedQuery = query.toLowerCase().trim()
    filtered = filtered.filter((post) => post.content.toLowerCase().includes(normalizedQuery))
  }

  return filtered
}

// Default getter functions
const defaultGetUser = (userId: string): User => {
  return ({
    id: userId,
    name: "Unknown User",
    username: "unknown",
    avatar: "",
    chapterTags: [],
    groupTags: [],
    followers: 0,
    following: 0,
  } as User)
}

const defaultGetGroup = (groupId: string): Group => {
  return ({
    id: groupId,
    name: "Unknown Group",
    description: "",
    image: "",
    avatar: undefined,
    memberCount: 0,
    createdAt: STABLE_FALLBACK_TIMESTAMP,
    chapterTags: [],
    groupTags: [],
  } as Group)
}

const defaultGetEventCreator = (_eventId: string): User => {
  return defaultGetUser("")
}

function parseListingPrice(price: string): number {
  return Number(String(price).replace(/[^0-9.]/g, "")) || 0
}

function buildOfferingHref(post: Post, listing: MarketplaceListing): string {
  const postDealCents =
    typeof post.basePrice === "number" && post.basePrice > 0
      ? Math.round(post.basePrice * 100)
      : null

  if (!postDealCents) {
    return `/marketplace/${listing.id}`
  }

  return `/marketplace/${listing.id}?dealPostId=${encodeURIComponent(post.id)}&dealPriceCents=${postDealCents}`
}

function requiresJoinFlowPage(group: Group): boolean {
  return Boolean(
    group.joinSettings?.passwordRequired ||
    (group.joinSettings?.questions?.length ?? 0) > 0 ||
    group.joinSettings?.joinType === JoinType.ApprovalRequired ||
    group.joinSettings?.joinType === JoinType.InviteOnly ||
    group.joinSettings?.joinType === JoinType.InviteAndApply
  )
}

interface PostFeedProps {
  posts?: Post[]
  events?: Event[]
  groups?: Group[]
  getUser?: (userId: string) => User
  getGroup?: (groupId: string) => Group
  getEventCreator?: (eventId: string) => User
  onLike?: (postId: string) => void
  onComment?: (postId: string) => void
  onShare?: (postId: string) => void
  onThank?: (postId: string) => void
  onRsvp?: (eventId: string, status: "going" | "interested" | "maybe" | "none") => void
  onJoinGroup?: (groupId: string) => void
  /** Pre-loaded marketplace listings for resolving linkedOfferingId on posts. */
  listings?: MarketplaceListing[]
  includeAllTypes?: boolean
  initialLikedPosts?: string[]
  query?: string
  chapterId?: string
  resolveChapterName?: (chapterId: string) => string
}

function getEventFeedTimestamp(event: Event): string {
  return event.startDate || event.timeframe?.start || event.date || ""
}

function getGroupFeedTimestamp(group: Group): string {
  return group.createdAt || ""
}

/**
 * Renders a timeline feed of posts and optional event/group cards with interactive actions.
 *
 * @param props Component props for feed data sources, lookup functions, and action handlers.
 */
export function PostFeed({
  posts: providedPosts,
  events = [],
  groups = [],
  getUser = defaultGetUser,
  getGroup = defaultGetGroup,
  getEventCreator = defaultGetEventCreator,
  onLike,
  onComment,
  onShare,
  onThank,
  onRsvp,
  onJoinGroup,
  listings: providedListings,
  includeAllTypes = false,
  query,
  chapterId,
  resolveChapterName,
}: PostFeedProps) {
  // Local state tracks optimistic-like toggles and RSVP selections.
  const [rsvpStatuses, setRsvpStatuses] = useState<Record<string, "going" | "interested" | "maybe" | "none">>({})
  const [hiddenPostIds, setHiddenPostIds] = useState<string[]>([])
  const [hiddenAuthorIds, setHiddenAuthorIds] = useState<string[]>([])
  const [reactionSummaries, setReactionSummaries] = useState<
    Record<string, { counts?: Partial<Record<ReactionType, number>>; totalCount?: number; currentUserReaction?: ReactionType | null }>
  >({})
  const { listings: hookListings } = useMarketplace(providedListings ? 0 : 1000)
  const listings = providedListings ?? hookListings
  const { currentUser } = useUser()

  useEffect(() => {
    let cancelled = false
    if (!currentUser?.id) {
      setHiddenPostIds([])
      setHiddenAuthorIds([])
      return
    }

    fetchHiddenContentPreferences()
      .then((preferences) => {
        if (cancelled) return
        setHiddenPostIds(preferences.hiddenPostIds)
        setHiddenAuthorIds(preferences.hiddenAuthorIds)
      })
      .catch(() => {
        if (cancelled) return
        setHiddenPostIds([])
        setHiddenAuthorIds([])
      })

    return () => {
      cancelled = true
    }
  }, [currentUser?.id])

  // Use provided posts only (no mock fallbacks)
  const posts = useMemo(
    () =>
      filterPosts(providedPosts || [], query, chapterId).filter(
        (post) => !hiddenPostIds.includes(post.id) && !hiddenAuthorIds.includes(post.author.id)
      ),
    [providedPosts, query, chapterId, hiddenPostIds, hiddenAuthorIds]
  )

  // Sort posts by timestamp, newest first
  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime()),
    [posts]
  )
  const listingById = useMemo(
    () => new Map(listings.map((listing) => [listing.id, listing])),
    [listings]
  )

  useEffect(() => {
    let cancelled = false
    const postIds = posts.map((post) => post.id)

    if (postIds.length === 0) {
      setReactionSummaries({})
      return
    }

    fetchReactionSummaries(postIds, "post")
      .then((summaries) => {
        if (!cancelled) setReactionSummaries(summaries)
      })
      .catch(() => {
        if (!cancelled) setReactionSummaries({})
      })

    return () => {
      cancelled = true
    }
  }, [posts])

  const feedItems = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- feedItems is a heterogeneous array mixing Post, event, and group wrapper objects
    const items: any[] = [...sortedPosts]

    if (includeAllTypes && events.length > 0) {
      const eventItems = events.slice(0, 2).map((event) => ({
        id: `event-${event.id}`,
        type: "event",
        content: event.description,
        images: event.image ? [event.image] : [],
        timestamp: getEventFeedTimestamp(event),
        name: event.title || event.name,
        eventData: event,
        chapterTags: event.chapterTags || [],
        groupTags: event.groupTags || [],
      }))

      items.push(...eventItems)
    }

    if (includeAllTypes && groups.length > 0) {
      const groupItems = groups.slice(0, 2).map((group) => ({
        id: `group-${group.id}`,
        type: "group",
        content: "Group description",
        timestamp: getGroupFeedTimestamp(group),
        name: group.name,
        groupData: group,
        chapterTags: group.chapterTags,
        groupTags: group.groupTags,
      }))

      items.push(...groupItems)
    }

    return items.sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())
  }, [sortedPosts, includeAllTypes, events, groups])

  // Event handler: updates local RSVP state and notifies parent callback.
  const handleRsvp = (eventId: string, status: "going" | "interested" | "maybe" | "none") => {
    setRsvpStatuses((prev) => ({
      ...prev,
      [eventId]: status,
    }))

    if (onRsvp) {
      onRsvp(eventId, status)
    }
  }

  // Helper function to get chapter name from ID, hiding raw UUIDs
  const getChapterName = (chapterId: string) => {
    if (resolveChapterName) {
      const resolved = resolveChapterName(chapterId)
      if (resolved && resolved !== chapterId) return resolved
    }
    // Hide raw UUIDs — only display human-readable names
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (uuidPattern.test(chapterId)) return ""
    return chapterId
  }

  return (
    <div className="space-y-4 mt-4">
      {feedItems.map((item) => {
        // Conditional rendering picks the correct card component for each heterogeneous feed item.
        if (item.type === "event") {
          return (
            <EventPostCard
              key={item.id}
              event={item}
              getGroup={getGroup}
              getEventCreator={getEventCreator}
              rsvpStatus={rsvpStatuses[item.id.replace("event-", "")] || "none"}
              onRsvp={(status) => handleRsvp(item.id.replace("event-", ""), status)}
              getChapterName={getChapterName}
            />
          )
        } else if (item.type === "group") {
          return (
            <GroupPostCard
              key={item.id}
              group={item}
              onJoin={() => onJoinGroup && onJoinGroup(item.id.replace("group-", ""))}
              getChapterName={getChapterName}
            />
          )
        } else {
          return (
            <PostCard
              key={item.id}
              post={item}
              user={getUser(typeof item.author === 'string' ? item.author : item.author?.id || '')}
              linkedOffering={item.linkedOfferingId ? listingById.get(item.linkedOfferingId) : undefined}
              currentUserId={currentUser?.id}
              reactionSummary={reactionSummaries[item.id]}
              onShare={() => onShare && onShare(item.id)}
              onThank={() => onThank && onThank(item.id)}
              getChapterName={getChapterName}
              onHidePost={(postId) => setHiddenPostIds((prev) => (prev.includes(postId) ? prev : [...prev, postId]))}
              onHideAuthor={(authorId) => setHiddenAuthorIds((prev) => (prev.includes(authorId) ? prev : [...prev, authorId]))}
            />
          )
        }
      })}

      {feedItems.length === 0 && <div className="text-center py-8 text-muted-foreground">No posts found</div>}
    </div>
  )
}

interface PostCardProps {
  post: Post
  user: User
  linkedOffering?: MarketplaceListing
  currentUserId?: string
  reactionSummary?: { counts?: Partial<Record<ReactionType, number>>; totalCount?: number; currentUserReaction?: ReactionType | null }
  onShare: () => void
  onThank: () => void
  getChapterName: (chapterId: string) => string
  onHidePost: (postId: string) => void
  onHideAuthor: (authorId: string) => void
}

// Helper function to get the appropriate color for an offering type
function getOfferingTypeColor(type: OfferingType) {
  switch (type) {
    case OfferingType.Service: return "border border-blue-300/50 bg-blue-500/12 text-blue-200"
    case OfferingType.Product: return "border border-emerald-300/50 bg-emerald-500/12 text-emerald-200"
    case OfferingType.Resource: return "border border-yellow-300/50 bg-yellow-500/12 text-yellow-100"
    case OfferingType.Trip: return "border border-violet-300/50 bg-violet-500/12 text-violet-200"
    case OfferingType.Ticket: return "border border-pink-300/50 bg-pink-500/12 text-pink-200"
    case OfferingType.Voucher: return "border border-rose-300/50 bg-rose-500/12 text-rose-200"
    case OfferingType.Data: return "border border-slate-300/50 bg-slate-400/10 text-slate-200"
    case OfferingType.Gift: return "border border-teal-300/50 bg-teal-500/12 text-teal-200"
    case OfferingType.Bounty: return "border border-amber-300/50 bg-amber-500/12 text-amber-100"
    default: return "border border-slate-300/50 bg-slate-400/10 text-slate-200"
  }
}

function formatOfferingTypeLabel(type: OfferingType) {
  const raw = String(type)
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * Card renderer for standard post entries.
 *
 * @param props Post display data, derived UI state, and card-level action handlers.
 */
function PostCard({
  post,
  user,
  linkedOffering,
  currentUserId,
  reactionSummary,
  onShare,
  onThank: _onThank,
  getChapterName,
  onHidePost,
  onHideAuthor,
}: PostCardProps) {
  const { toast } = useToast()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [editTitle, setEditTitle] = useState(post.title || "")
  const [editContent, setEditContent] = useState(post.content)
  const [editImageUrls, setEditImageUrls] = useState(post.images?.slice(0, 1) ?? [])
  const [isExpanded, setIsExpanded] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)
  const [displayContent, setDisplayContent] = useState(post.content)
  const [displayTitle, setDisplayTitle] = useState(post.title || "")
  const [displayImages, setDisplayImages] = useState(post.images ?? [])
  const resolvedLocales = (post.chapterTags ?? [])
    .map((id) => getChapterName(id))
    .filter((name) => name.length > 0)

  if (isDeleted) return null

  const offeringHref = linkedOffering ? buildOfferingHref(post, linkedOffering) : null
  const inlineDealPrice =
    typeof post.dealPriceCents === "number" && post.dealPriceCents > 0
      ? post.dealPriceCents / 100
      : typeof post.basePrice === "number" && post.basePrice > 0
        ? post.basePrice
        : null
  const originalListingPrice = linkedOffering ? parseListingPrice(linkedOffering.price) : null
  const isOwner = Boolean(currentUserId && currentUserId === post.author.id)
  const hasLongBody = displayContent.length > 220

  const handleDelete = async () => {
    setIsDeleting(true)
    const result = await deleteResource(post.id)
    setIsDeleting(false)
    if (!result.success) {
      toast({ title: "Could not delete post", description: result.message, variant: "destructive" })
      return
    }
    toast({ title: "Post removed", description: result.message })
    setIsDeleted(true)
  }

  const handleSaveEdit = async () => {
    setIsSaving(true)
    const result = await updateResource({
      resourceId: post.id,
      name: editTitle.trim() || post.title || "Post",
      description: editContent.trim(),
      content: editContent.trim(),
      metadataPatch: {
        title: editTitle.trim() || null,
        imageUrl: editImageUrls[0] ?? null,
        images: editImageUrls,
      },
    })
    setIsSaving(false)

    if (!result.success) {
      toast({ title: "Could not update post", description: result.message, variant: "destructive" })
      return
    }

    toast({ title: "Post updated", description: result.message })
    setIsEditOpen(false)
    setDisplayContent(editContent.trim())
    setDisplayTitle(editTitle.trim())
    setDisplayImages(editImageUrls)
  }

  const handleHidePost = async () => {
    const result = await toggleHiddenContent(post.id, "post", "post")
    if (!result.success) {
      toast({ title: "Could not hide post", description: result.message, variant: "destructive" })
      return
    }
    onHidePost(post.id)
    toast({ title: "Post hidden", description: "You won't see this post in your feed anymore." })
  }

  const handleHideAuthor = async () => {
    const result = await toggleHiddenContent(post.author.id, "person", "author")
    if (!result.success) {
      toast({ title: "Could not hide author", description: result.message, variant: "destructive" })
      return
    }
    onHideAuthor(post.author.id)
    toast({ title: "Author hidden", description: `You won't see posts from ${user.name} anymore.` })
  }

  return (
    <>
      <Card
        className="overflow-hidden border shadow-sm hover:shadow-md transition-shadow"
      >
        <CardContent className="p-0">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-3">
              <Link href={`/profile/${user?.username || user?.id || post.author.id}`} onClick={(e) => e.stopPropagation()}>
                <Avatar className="hover:ring-2 hover:ring-primary transition-all">
                  <AvatarImage src={user?.avatar || "/placeholder.svg"} alt={user?.name} />
                  <AvatarFallback>{user?.name?.substring(0, 2) || "UN"}</AvatarFallback>
                </Avatar>
              </Link>
              <div>
                <Link
                  href={`/profile/${user?.username || user?.id || post.author.id}`}
                  className="font-medium hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {user?.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  <RelativeTime date={post.createdAt} />
                  {resolvedLocales.length > 0 ? ` · ${resolvedLocales.join(", ")}` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {post.eftValues && <EftMiniChart values={post.eftValues} capitalValues={post.capitalValues} auditValues={post.auditValues} />}
              {post.isLiveInvitation && (
                <Badge variant="outline" className="text-xs border-red-400/40 bg-red-500/12 text-red-200 flex items-center gap-1">
                  <Radio className="h-3 w-3" />
                  Live Invite
                </Badge>
              )}
              {/* Conditional badge logic for offers vs standard post/request content. */}
              {post.postType === PostType.Offer && post.offeringType ? (
                <div className="flex items-center gap-1">
                  <Badge className={`text-xs ${getOfferingTypeColor(post.offeringType)}`}>
                    {formatOfferingTypeLabel(post.offeringType)} Offer
                  </Badge>
                </div>
              ) : post.postType === PostType.Request ? (
                <Badge variant="outline" className="text-xs">Request</Badge>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  {isOwner ? (
                    <>
                      <DropdownMenuItem onClick={() => setIsEditOpen(true)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit post
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void handleDelete()}
                        disabled={isDeleting}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {isDeleting ? "Deleting..." : "Delete post"}
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      <DropdownMenuItem onClick={() => void handleHidePost()}>
                        <EyeOff className="mr-2 h-4 w-4" />
                        Hide this post
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void handleHideAuthor()}>
                        <UserMinus2 className="mr-2 h-4 w-4" />
                        Hide posts from {user.name}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {displayTitle ? (
            <Link
              href={`/posts/${post.id}`}
              className="mb-2 block text-lg font-semibold leading-tight hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {displayTitle}
            </Link>
          ) : null}

          <div className="mb-3">
            <p className={isExpanded ? "whitespace-pre-wrap" : "line-clamp-3 whitespace-pre-wrap"}>{displayContent}</p>
            {hasLongBody ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-auto px-0 text-sm text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsExpanded((value) => !value)
                }}
              >
                {isExpanded ? (
                  <>
                    Show less
                    <ChevronUp className="ml-1 h-4 w-4" />
                  </>
                ) : (
                  <>
                    Show more
                    <ChevronDown className="ml-1 h-4 w-4" />
                  </>
                )}
              </Button>
            ) : null}
          </div>

          {displayImages && displayImages.length > 0 ? (
            <Link
              href={`/posts/${post.id}`}
              className="relative mb-3 block rounded-lg bg-muted/40 p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative h-[420px] w-full">
                <Image
                  src={displayImages[0] || "/placeholder-event.jpg"}
                  alt="Post image"
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 768px"
                />
              </div>
            </Link>
          ) : null}

          {linkedOffering && offeringHref ? (
            <Link
              href={offeringHref}
              className="mb-3 block rounded-lg border bg-muted/30 p-3 transition-colors hover:border-primary hover:bg-muted/50"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                {linkedOffering.images && linkedOffering.images.length > 0 ? (
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-muted/40">
                    <Image
                      src={linkedOffering.images[0] || "/placeholder-event.jpg"}
                      alt={linkedOffering.title}
                      fill
                      className="object-cover"
                      sizes="64px"
                    />
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Linked Offering</p>
                  <h4 className="truncate font-semibold">{linkedOffering.title}</h4>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{linkedOffering.description}</p>
                </div>
                <div className="shrink-0 text-right">
                  {inlineDealPrice ? (
                    <>
                      {originalListingPrice && originalListingPrice !== inlineDealPrice ? (
                        <p className="text-xs text-muted-foreground line-through">${originalListingPrice.toFixed(2)}</p>
                      ) : null}
                      <p className="font-semibold text-foreground">${inlineDealPrice.toFixed(2)}</p>
                    </>
                  ) : (
                    <p className="font-semibold text-foreground">
                      {typeof linkedOffering.thanksValue === "number" && linkedOffering.thanksValue > 0 ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Heart className="h-4 w-4 text-pink-500" />
                          <span>{linkedOffering.thanksValue} Thanks</span>
                        </span>
                      ) : (
                        linkedOffering.price
                      )}
                    </p>
                  )}
                  {post.dealCode ? (
                    <Badge variant="secondary" className="mt-2 border border-emerald-400/40 bg-emerald-500/12 text-emerald-200">
                      Code {post.dealCode}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </Link>
          ) : null}

          </div>
        </CardContent>
        <CardFooter className="p-0 border-t">
          <div className="w-full">
            <div className="grid grid-cols-4 w-full">
              <ReactionButton
                targetId={post.id}
                targetType="post"
                summary={reactionSummary}
                className="h-12 w-full rounded-none justify-center text-muted-foreground"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-12 w-full rounded-none justify-center text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowComments((value) => !value)
                }}
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Comment
              </Button>
              <ThankModule
                recipientId={user.id}
                recipientName={user.name}
                recipientAvatar={user.avatar}
                context="post"
                contextId={post.id}
                triggerButton={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-12 w-full rounded-none justify-center text-muted-foreground"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                    }}
                  >
                    <Heart className="h-4 w-4 mr-2" />
                    Thank
                  </Button>
                }
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-12 w-full rounded-none justify-center text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onShare()
                }}
              >
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
            </div>
            {showComments ? (
              <div className="border-t bg-muted/20 px-4 py-4">
                <CommentFeed postId={post.id} embedded />
              </div>
            ) : null}
          </div>
        </CardFooter>
      </Card>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Post</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {post.postType === PostType.Offer ? (
              <div className="space-y-2">
                <Label htmlFor={`post-title-${post.id}`}>Title</Label>
                <Input
                  id={`post-title-${post.id}`}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Post title"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={`post-content-${post.id}`}>Body</Label>
              <Textarea
                id={`post-content-${post.id}`}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="min-h-[160px]"
              />
            </div>
            <div className="space-y-2">
              <Label>Image</Label>
              <ImageUpload value={editImageUrls} onChange={setEditImageUrls} maxFiles={1} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={() => void handleSaveEdit()} disabled={isSaving}>
                {isSaving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface EventPostCardProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event is a heterogeneous feed item wrapper, not a strict Event type
  event: any
  getGroup: (groupId: string) => Group
  getEventCreator: (eventId: string) => User
  rsvpStatus: "going" | "interested" | "maybe" | "none"
  onRsvp: (status: "going" | "interested" | "maybe" | "none") => void
  getChapterName: (chapterId: string) => string
}

/**
 * Card renderer for event feed wrappers, including RSVP toggles.
 *
 * @param props Event wrapper data and supporting resolver/callback functions.
 */
function EventPostCard({ event, getGroup, getEventCreator, rsvpStatus, onRsvp, getChapterName }: EventPostCardProps) {
  const router = useRouter()
  // Get the group that organized the event
  const organizer = getGroup(event.eventData?.organizer || "unknown")

  // Get the event creator
  const creator = getEventCreator(event.eventData?.id || event.id?.replace("event-", "") || "unknown")

  const handleCardClick = () => {
    // Extract the event ID safely, handling the case where eventData might be undefined
    const eventId = event.eventData?.id || event.id?.replace("event-", "") || "unknown"
    // Navigates to event detail on card click.
    router.push(`/events/${eventId}`)
  }

  return (
    <Card
      className="overflow-hidden border shadow-sm hover:shadow-md transition-shadow cursor-pointer"
      onClick={handleCardClick}
    >
      <CardContent className="p-0">
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-3">
              <Link href={`/profile/${creator?.username || creator?.id || event.creatorId || event.id}`} onClick={(e) => e.stopPropagation()}>
                <Avatar className="hover:ring-2 hover:ring-primary transition-all">
                  <AvatarImage src={creator?.avatar || "/placeholder.svg"} alt={creator?.name} />
                  <AvatarFallback>{creator?.name?.substring(0, 2) || "UN"}</AvatarFallback>
                </Avatar>
              </Link>
              <div>
                <div className="font-medium">
                  <Link
                    href={`/groups/${organizer?.id}`}
                    className="text-sm hover:underline block"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {organizer?.name || "Unknown Group"}
                  </Link>
                  <Link
                    href={`/profile/${creator?.username || creator?.id || event.creatorId || event.id}`}
                    className="hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {creator?.name}
                  </Link>
                </div>
                <RelativeTime date={event.timestamp || event.eventData?.startDate || STABLE_FALLBACK_TIMESTAMP} className="text-xs text-muted-foreground" />
              </div>
            </div>
            <div className="text-xs bg-muted px-2 py-1 rounded">Event</div>
          </div>
          <p className="mb-3">{event.content}</p>

          {/* Display chapter tags (skip unresolved UUIDs) */}
          {(() => {
            const resolved = (event.chapterTags ?? []).map((id: string) => ({ id, name: getChapterName(id) })).filter((t: { name: string }) => t.name.length > 0)
            return resolved.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-3">
                {resolved.slice(0, 2).map((tag: { id: string; name: string }) => (
                  <Link key={tag.id} href={`/search?chapter=${tag.id}`} onClick={(e) => e.stopPropagation()}>
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 hover:bg-blue-100">
                      {tag.name}
                    </Badge>
                  </Link>
                ))}
                {resolved.length > 2 && (
                  <Badge variant="outline" className="bg-blue-50 text-blue-700">
                    +{resolved.length - 2} more
                  </Badge>
                )}
              </div>
            ) : null
          })()}
        </div>
        {event.images && event.images.length > 0 && (
          <div className="relative w-full h-64">
            <Image src={event.images[0] || "/placeholder-event.jpg"} alt="Event image" fill className="object-cover" />
          </div>
        )}
        <div className="p-4 bg-muted">
          <h3 className="text-lg font-bold mb-1">
            {event.name || event.eventData?.title || event.eventData?.name || "Untitled Event"}
          </h3>
          <RelativeTime date={event.timestamp || event.eventData?.startDate || STABLE_FALLBACK_TIMESTAMP} className="text-sm text-muted-foreground mb-2" />
        </div>
      </CardContent>
      <CardFooter className="p-0 border-t">
        <div className="grid grid-cols-2 w-full">
          {/* Conditional toggle behavior switches between the selected RSVP state and "none". */}
          <Button
            variant="ghost"
            size="sm"
            className={`rounded-none h-12 ${rsvpStatus === "maybe" ? "text-primary" : "text-muted-foreground"}`}
            onClick={(e) => {
              e.stopPropagation()
              onRsvp(rsvpStatus === "maybe" ? "none" : "maybe")
            }}
          >
            Maybe
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`rounded-none h-12 ${rsvpStatus === "going" ? "text-primary" : "text-muted-foreground"}`}
            onClick={(e) => {
              e.stopPropagation()
              onRsvp(rsvpStatus === "going" ? "none" : "going")
            }}
          >
            Going
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

interface GroupPostCardProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- group is a heterogeneous feed item wrapper, not a strict Group type
  group: any
  onJoin: () => void
  getChapterName: (chapterId: string) => string
}

/**
 * Card renderer for group feed wrappers, including join CTA.
 *
 * @param props Group wrapper data, join handler, and chapter name resolver.
 */
function GroupPostCard({ group, onJoin, getChapterName }: GroupPostCardProps) {
  const router = useRouter()
  const routeGroupId =
    typeof group.groupData?.id === "string" && group.groupData.id.length > 0
      ? group.groupData.id
      : group.id
  const groupHref = `/groups/${routeGroupId}`

  const handleCardClick = () => {
    // Navigates to group detail on card click.
    router.push(groupHref)
  }

  return (
    <Card
      className="overflow-hidden border shadow-sm hover:shadow-md transition-shadow cursor-pointer"
      onClick={handleCardClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={group.groupData?.avatar || "/placeholder.svg"} alt={group.name} />
              <AvatarFallback>{group.name.substring(0, 2)}</AvatarFallback>
            </Avatar>
            <div>
              <Link
                href={groupHref}
                className="text-lg font-bold hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {group.name}
              </Link>
              <p className="text-xs text-muted-foreground">Group</p>
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mb-4">{group.content}</p>

        {/* Display chapter tags (skip unresolved UUIDs) */}
        {(() => {
          const resolved = (group.chapterTags ?? []).map((id: string) => ({ id, name: getChapterName(id) })).filter((t: { name: string }) => t.name.length > 0)
          return resolved.length > 0 ? (
            <div className="flex flex-wrap gap-1 mb-3">
              {resolved.slice(0, 2).map((tag: { id: string; name: string }) => (
                <Link key={tag.id} href={`/search?chapter=${tag.id}`} onClick={(e) => e.stopPropagation()}>
                  <Badge variant="outline" className="bg-blue-50 text-blue-700 hover:bg-blue-100">
                    {tag.name}
                  </Badge>
                </Link>
              ))}
              {resolved.length > 2 && (
                <Badge variant="outline" className="bg-blue-50 text-blue-700">
                  +{resolved.length - 2} more
                </Badge>
              )}
            </div>
          ) : null
        })()}
      </CardContent>
      <CardFooter className="p-0 border-t">
        {requiresJoinFlowPage(group) ? (
          <Button asChild className="w-full rounded-none h-12 bg-primary hover:bg-primary/90">
            <Link href={`/groups/${group.id}`}>View Group</Link>
          </Button>
        ) : (
          <Button
            className="w-full rounded-none h-12 bg-primary hover:bg-primary/90"
            onClick={(e) => {
              e.stopPropagation()
              onJoin()
            }}
          >
            Join Group
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
