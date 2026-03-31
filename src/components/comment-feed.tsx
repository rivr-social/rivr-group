"use client"

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent } from "@/components/ui/card"
import { Gift, Heart, MessageCircle, MoreHorizontal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import Link from "next/link"
import { RelativeTime } from "@/components/relative-time"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
import { fetchReactionSummaries, type ReactionType } from "@/app/actions/interactions"
import { ReactionButton } from "@/components/reaction-button"
import {
  postCommentAction,
  fetchCommentsAction,
  type CommentData,
} from "@/app/actions/create-resources"

interface CommentWithReplies extends CommentData {
  replies: CommentWithReplies[]
}

interface CommentFeedProps {
  postId?: string
  eventId?: string
  embedded?: boolean
}

/** Organizes a flat comment list into a nested tree by parentCommentId. */
function buildCommentTree(comments: CommentData[]): CommentWithReplies[] {
  const map = new Map<string, CommentWithReplies>()
  for (const c of comments) {
    map.set(c.id, { ...c, replies: [] })
  }

  const roots: CommentWithReplies[] = []
  for (const c of comments) {
    const node = map.get(c.id)!
    if (c.parentCommentId) {
      const parent = map.get(c.parentCommentId)
      if (parent) {
        parent.replies.push(node)
      } else {
        roots.push(node)
      }
    } else {
      roots.push(node)
    }
  }

  // Sort replies within each thread: newest first
  function sortReplies(nodes: CommentWithReplies[]) {
    for (const node of nodes) {
      if (node.replies.length > 0) {
        node.replies.sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        sortReplies(node.replies)
      }
    }
  }

  roots.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )
  sortReplies(roots)
  return roots
}

/**
 * Comment thread feed for event/post discussion pages.
 * Persists comments to the ledger via server actions and fetches on mount.
 */
export function CommentFeed({ postId, eventId, embedded = false }: CommentFeedProps) {
  const { toast } = useToast()
  const { currentUser } = useUser()
  const resourceId = eventId ?? postId ?? ""

  const [comments, setComments] = useState<CommentWithReplies[]>([])
  const [newComment, setNewComment] = useState("")
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [reactionSummaries, setReactionSummaries] = useState<
    Record<string, { counts?: Partial<Record<ReactionType, number>>; totalCount?: number; currentUserReaction?: ReactionType | null }>
  >({})
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const replyInputRef = useRef<HTMLTextAreaElement>(null)

  const loadComments = useCallback(async () => {
    if (!resourceId) return
    const result = await fetchCommentsAction(resourceId)
    if (result.success) {
      setComments(buildCommentTree(result.comments))
    }
    setIsLoading(false)
  }, [resourceId])

  useEffect(() => {
    void loadComments()
  }, [loadComments])

  useEffect(() => {
    let cancelled = false

    const allCommentIds: string[] = []
    const collectIds = (nodes: CommentWithReplies[]) => {
      for (const node of nodes) {
        allCommentIds.push(node.id)
        if (node.replies.length > 0) collectIds(node.replies)
      }
    }

    collectIds(comments)

    if (allCommentIds.length === 0) {
      setReactionSummaries({})
      return
    }

    fetchReactionSummaries(allCommentIds, "comment")
      .then((summaries) => {
        if (!cancelled) setReactionSummaries(summaries)
      })
      .catch(() => {
        if (!cancelled) setReactionSummaries({})
      })

    return () => {
      cancelled = true
    }
  }, [comments])

  const handlePostComment = async () => {
    if (!newComment.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      const result = await postCommentAction(resourceId, newComment.trim())
      if (!result.success) {
        toast({ title: "Failed to post comment", description: result.message, variant: "destructive" })
        return
      }
      setNewComment("")
      toast({ title: "Comment posted" })
      await loadComments()
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePostReply = async (parentId: string) => {
    if (!replyContent.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      const result = await postCommentAction(resourceId, replyContent.trim(), parentId)
      if (!result.success) {
        toast({ title: "Failed to post reply", description: result.message, variant: "destructive" })
        return
      }
      setReplyContent("")
      setReplyingTo(null)
      toast({ title: "Reply posted" })
      await loadComments()
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, isReply = false, parentId?: string) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (isReply && parentId) {
        void handlePostReply(parentId)
      } else {
        void handlePostComment()
      }
    }
  }

  const currentUserAvatar = currentUser?.avatar ?? "/placeholder.svg"
  const currentUserInitials = (currentUser?.name ?? "U").substring(0, 2).toUpperCase()

  const renderComment = (comment: CommentWithReplies, depth = 0) => {
    const initials = (comment.authorName ?? "U").substring(0, 2).toUpperCase()
    const isGiftComment = comment.isGift === true

    return (
      <div key={comment.id} className="mb-4">
        <Card className={
          isGiftComment
            ? "border border-primary/30 bg-primary/5 shadow-sm"
            : embedded
              ? "border-0 bg-transparent shadow-none"
              : "border shadow-sm"
        }>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Link href={`/profile/${comment.authorId}`}>
                <Avatar className="h-10 w-10">
                  <AvatarImage src={comment.authorImage ?? "/placeholder.svg"} alt={comment.authorName} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </Link>

              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link href={`/profile/${comment.authorId}`} className="font-medium hover:underline">
                      {comment.authorName}
                    </Link>
                    {isGiftComment && (
                      <Badge variant="secondary" className="text-xs gap-1">
                        {comment.giftType === "voucher" ? (
                          <><Gift className="h-3 w-3" /> Voucher Gift</>
                        ) : (
                          <><Heart className="h-3 w-3" /> Thanks</>
                        )}
                      </Badge>
                    )}
                    <RelativeTime date={comment.timestamp} className="text-xs text-muted-foreground" />
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Comment actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </div>

                {isGiftComment && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-primary">
                    {comment.giftType === "voucher" && comment.voucherName && (
                      <span className="font-medium">Gifted: {comment.voucherName}</span>
                    )}
                    {comment.giftType === "thanks" && comment.thanksTokenCount && (
                      <span className="font-medium">
                        Sent {comment.thanksTokenCount} thanks token{comment.thanksTokenCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                )}

                {comment.giftMessage ? (
                  <p className="mt-2 whitespace-pre-wrap italic text-muted-foreground">&ldquo;{comment.giftMessage}&rdquo;</p>
                ) : !isGiftComment ? (
                  <p className="mt-2 whitespace-pre-wrap">{comment.content}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <ReactionButton
                    targetId={comment.id}
                    targetType="comment"
                    summary={reactionSummaries[comment.id]}
                    className="h-8 px-2 text-muted-foreground"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-muted-foreground px-2"
                    onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                  >
                    <MessageCircle className="h-4 w-4 mr-2" />
                    Reply
                  </Button>
                </div>

                {replyingTo === comment.id && (
                  <div className="mt-3">
                    <div className="flex gap-2">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={currentUserAvatar} alt="You" />
                        <AvatarFallback>{currentUserInitials}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <Textarea
                          ref={replyInputRef}
                          value={replyContent}
                          onChange={(e) => setReplyContent(e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, true, comment.id)}
                          placeholder={`Reply to ${comment.authorName}...`}
                          className="min-h-[60px] p-2 text-sm"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setReplyingTo(null); setReplyContent("") }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void handlePostReply(comment.id)}
                            disabled={!replyContent.trim() || isSubmitting}
                          >
                            {isSubmitting ? "Posting..." : "Reply"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {comment.replies.length > 0 && (
                  <div className="mt-3 border-l-2 border-border/60 pl-4">
                    {comment.replies.map((reply) => renderComment(reply, depth + 1))}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <Card className={embedded ? "border-0 bg-transparent shadow-none" : "border shadow-sm"}>
          <CardContent className="p-4">
            <div className="flex gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage src={currentUserAvatar} alt="You" />
                <AvatarFallback>{currentUserInitials}</AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <Textarea
                  id={`comment-input-${resourceId}`}
                  ref={commentInputRef}
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e)}
                  placeholder="Write a comment..."
                  className="min-h-[80px] resize-none"
                />
                <div className="flex justify-end mt-2">
                  <Button onClick={() => void handlePostComment()} disabled={!newComment.trim() || isSubmitting}>
                    {isSubmitting ? "Posting..." : "Post"}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground py-4">Loading comments...</p>
        ) : comments.length > 0 ? (
          comments.map((comment) => renderComment(comment))
        ) : (
          <Card className={embedded ? "border-0 bg-transparent p-4 shadow-none" : "p-8"}>
            <p className="text-center text-muted-foreground">No comments yet. Be the first to start the conversation!</p>
          </Card>
        )}
      </div>
    </div>
  )
}
