/**
 * @fileoverview PostActions - Edit/delete action buttons for posts.
 *
 * Displayed on post detail pages when the current user is the post author.
 * Provides edit mode with form fields and a delete confirmation, calling
 * updateResource and deleteResource server actions.
 */
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { updateResource, deleteResource } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

/**
 * Props for owner-only post edit/delete actions.
 */
interface PostActionsProps {
  postId: string
  postContent: string
  postTitle: string
  ownerId: string
}

/**
 * Renders owner-only post edit and delete controls.
 *
 * @param props - Post action identifiers and current post values.
 * @returns Action buttons and dialogs when current user owns the post; otherwise null.
 */
export function PostActions({ postId, postContent, postTitle, ownerId }: PostActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [draftTitle, setDraftTitle] = useState(postTitle)
  const [draftContent, setDraftContent] = useState(postContent)

  /**
   * Keeps form values synced with latest post data whenever edit dialog opens.
   */
  useEffect(() => {
    if (!isEditOpen) return
    setDraftTitle(postTitle)
    setDraftContent(postContent)
  }, [isEditOpen, postTitle, postContent])

  /**
   * Persists post title/content updates through shared resource action.
   */
  const handleUpdatePost = async () => {
    const trimmedTitle = draftTitle.trim()
    const trimmedContent = draftContent.trim()

    if (!trimmedTitle || !trimmedContent) {
      toast({
        title: "Missing required fields",
        description: "Post title and content are required.",
        variant: "destructive",
      })
      return
    }

    setIsUpdating(true)
    try {
      const result = await updateResource({
        resourceId: postId,
        name: trimmedTitle,
        content: trimmedContent,
        description: trimmedContent,
      })

      if (!result.success) {
        toast({
          title: "Failed to update post",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsEditOpen(false)
      toast({ title: "Post updated" })
      router.refresh()
    } catch {
      toast({
        title: "Failed to update post",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  /**
   * Soft-deletes the post through shared resource deletion action.
   */
  const handleDeletePost = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteResource(postId)

      if (!result.success) {
        toast({
          title: "Failed to delete post",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsDeleteOpen(false)
      toast({ title: "Post deleted" })
      router.refresh()
    } catch {
      toast({
        title: "Failed to delete post",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsDeleting(false)
    }
  }

  /**
   * Owner gate: only post owners can see mutation controls.
   */
  if (!currentUser?.id || currentUser.id !== ownerId) return null

  return (
    <div className="flex items-center gap-2">
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit post</DialogTitle>
            <DialogDescription>Update your post title and content.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`post-title-${postId}`}>Title</Label>
              <Input
                id={`post-title-${postId}`}
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Post title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`post-content-${postId}`}>Content</Label>
              <Textarea
                id={`post-content-${postId}`}
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                placeholder="Share your update..."
                className="min-h-[140px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdatePost()} disabled={isUpdating}>
              {isUpdating ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The post will be removed from active surfaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeletePost()} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete post"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
