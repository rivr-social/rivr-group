"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Image from "next/image"
import Link from "next/link"
import { ChevronDown, ChevronLeft, ChevronUp, Heart, MessageCircle, Pencil, Share2, Trash2, MoreHorizontal, EyeOff, UserMinus2 } from "lucide-react"
import { fetchReactionSummaries, toggleHiddenContent, type ReactionType } from "@/app/actions/interactions"
import { CommentFeed } from "@/components/comment-feed"
import { FollowButton } from "@/components/follow-button"
import { ThankModule } from "@/components/thank-module"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { MarketplaceListing, Post } from "@/lib/types"
import type { SerializedResource } from "@/lib/graph-serializers"
import { useUser } from "@/contexts/user-context"
import { useToast } from "@/components/ui/use-toast"
import { deleteResource, updateResource } from "@/app/actions/create-resources"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ImageUpload } from "@/components/image-upload"
import { ReactionButton } from "@/components/reaction-button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { RelativeTime } from "@/components/relative-time"

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

function parseListingPrice(price: string): number {
  return Number(String(price).replace(/[^0-9.]/g, "")) || 0
}

export function PostDetailClient({
  post,
  resource,
  linkedOffering,
}: {
  post: Post
  resource: SerializedResource
  linkedOffering?: MarketplaceListing | null
}) {
  const router = useRouter()
  const { currentUser } = useUser()
  const { toast } = useToast()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [editTitle, setEditTitle] = useState(post.title || post.content || "")
  const [editContent, setEditContent] = useState(post.content)
  const [editImageUrls, setEditImageUrls] = useState(post.images?.slice(0, 1) ?? [])
  const [isExpanded, setIsExpanded] = useState(false)
  const [displayContent, setDisplayContent] = useState(post.content)
  const [displayTitle, setDisplayTitle] = useState(post.title || "")
  const [displayImages, setDisplayImages] = useState(post.images ?? [])
  const [reactionSummary, setReactionSummary] = useState<
    { counts?: Partial<Record<ReactionType, number>>; totalCount?: number; currentUserReaction?: ReactionType | null } | undefined
  >(undefined)
  const offeringHref = linkedOffering ? buildOfferingHref(post, linkedOffering) : null
  const inlineDealPrice =
    typeof post.dealPriceCents === "number" && post.dealPriceCents > 0
      ? post.dealPriceCents / 100
      : typeof post.basePrice === "number" && post.basePrice > 0
        ? post.basePrice
        : null
  const originalListingPrice = linkedOffering ? parseListingPrice(linkedOffering.price) : null
  const isOwner = Boolean(currentUser?.id && currentUser.id === post.author.id)
  const hasLongBody = displayContent.length > 220

  useEffect(() => {
    let cancelled = false
    fetchReactionSummaries([post.id], "post")
      .then((summaries) => {
        if (!cancelled) setReactionSummary(summaries[post.id])
      })
      .catch(() => {
        if (!cancelled) setReactionSummary(undefined)
      })

    return () => {
      cancelled = true
    }
  }, [post.id])

  const handleDelete = async () => {
    setIsDeleting(true)
    const result = await deleteResource(post.id)
    setIsDeleting(false)
    if (!result.success) {
      toast({ title: "Could not delete post", description: result.message, variant: "destructive" })
      return
    }
    toast({ title: "Post removed", description: result.message })
    router.push("/")
  }

  const handleSaveEdit = async () => {
    setIsSaving(true)
    const result = await updateResource({
      resourceId: post.id,
      name: editTitle.trim() || resource.name || "Post",
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
    toast({ title: "Post hidden", description: "You won't see this post in your feed anymore." })
    router.push("/")
  }

  const handleHideAuthor = async () => {
    const result = await toggleHiddenContent(post.author.id, "person", "author")
    if (!result.success) {
      toast({ title: "Could not hide author", description: result.message, variant: "destructive" })
      return
    }
    toast({ title: "Author hidden", description: `You won't see posts from ${post.author.name} anymore.` })
    router.push("/")
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <Button variant="ghost" className="mb-4 pl-0" onClick={() => router.back()}>
        <ChevronLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <Card className="overflow-hidden border shadow-sm mb-6">
        <CardContent className="p-0">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-3">
                <Link href={`/profile/${post.author.username || post.author.id}`}>
                  <Avatar className="h-12 w-12 hover:ring-2 hover:ring-primary transition-all">
                    <AvatarImage src={post.author.avatar || "/placeholder.svg"} alt={post.author.name} />
                    <AvatarFallback>{post.author.name.substring(0, 2)}</AvatarFallback>
                  </Avatar>
                </Link>
                <div>
                  <Link href={`/profile/${post.author.username || post.author.id}`} className="font-medium hover:underline">
                    {post.author.name}
                  </Link>
                  <RelativeTime date={post.createdAt} className="text-xs text-muted-foreground" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!isOwner ? <FollowButton objectId={post.id} objectType="post" size="sm" /> : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
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
                          Hide posts from {post.author.name}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {displayTitle ? <h1 className="mb-2 text-2xl font-semibold leading-tight">{displayTitle}</h1> : null}
            <div className="mb-4">
              <p className={isExpanded ? "whitespace-pre-wrap text-lg" : "line-clamp-3 whitespace-pre-wrap text-lg"}>
                {displayContent}
              </p>
              {hasLongBody ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-auto px-0 text-sm text-muted-foreground"
                  onClick={() => setIsExpanded((value) => !value)}
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
              <div className="mb-4 flex w-full items-center justify-center rounded-lg bg-muted/40 p-4">
                <div className="relative h-[540px] w-full">
                  <Image
                    src={displayImages[0] || "/placeholder-event.jpg"}
                    alt="Post image"
                    fill
                    className="object-contain"
                    sizes="(max-width: 1024px) 100vw, 1024px"
                  />
                </div>
              </div>
            ) : null}

            {linkedOffering && offeringHref ? (
              <Link
                href={offeringHref}
                className="mb-3 block rounded-lg border bg-muted/30 p-3 transition-colors hover:border-primary hover:bg-muted/50"
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

        <CardFooter className="border-t bg-muted/15 p-0">
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
              onClick={() => document.getElementById(`comment-input-${post.id}`)?.focus()}
            >
              <MessageCircle className="h-5 w-5 mr-2" />
              Comment
            </Button>
            <ThankModule
              recipientId={post.author.id}
              recipientName={post.author.name}
              recipientAvatar={post.author.avatar}
              context="post"
              contextId={post.id}
              triggerButton={
                <Button variant="ghost" size="sm" type="button" className="h-12 w-full rounded-none justify-center text-muted-foreground">
                  <Heart className="h-5 w-5 mr-2" />
                  Thank
                </Button>
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-12 w-full rounded-none justify-center text-muted-foreground"
              onClick={() => navigator.clipboard.writeText(window.location.href)}
            >
              <Share2 className="h-5 w-5 mr-2" />
              Share
            </Button>
            </div>
            <div className="border-t bg-background/60 px-4 py-4">
              <CommentFeed postId={post.id} embedded />
            </div>
          </div>
        </CardFooter>
      </Card>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Post</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {(post.postType === "offer" || post.title) ? (
              <div className="space-y-2">
                <Label htmlFor={`detail-post-title-${post.id}`}>Title</Label>
                <Input
                  id={`detail-post-title-${post.id}`}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Post title"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={`detail-post-content-${post.id}`}>Body</Label>
              <Textarea
                id={`detail-post-content-${post.id}`}
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

    </div>
  )
}
