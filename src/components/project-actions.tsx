/**
 * @fileoverview ProjectActions - Edit/delete actions for project detail pages.
 *
 * Displayed when the current user is the project owner. Provides inline editing
 * and delete confirmation using `updateResource` and `deleteResource` server actions.
 */
"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { updateResource, deleteResource } from "@/app/actions/create-resources"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { useUser } from "@/contexts/user-context"
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
 * Props for owner-only project edit/delete actions.
 */
interface ProjectActionsProps {
  projectId: string
  projectName: string
  projectDescription?: string | null
  ownerId?: string | null
}

/**
 * Renders owner-only project mutation controls.
 *
 * @param props - Project identifiers and existing editable values.
 * @returns Edit/delete controls when current user owns the project; otherwise null.
 */
export function ProjectActions({ projectId, projectName, projectDescription, ownerId }: ProjectActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [draftName, setDraftName] = useState(projectName)
  const [draftDescription, setDraftDescription] = useState(projectDescription ?? "")

  /**
   * Syncs draft fields from latest server values when edit dialog opens.
   */
  useEffect(() => {
    if (!isEditOpen) return
    setDraftName(projectName)
    setDraftDescription(projectDescription ?? "")
  }, [isEditOpen, projectName, projectDescription])

  /**
   * Updates project name/description through shared resource action.
   */
  const handleUpdateProject = async () => {
    const trimmedName = draftName.trim()
    const trimmedDescription = draftDescription.trim()

    if (!trimmedName) {
      toast({
        title: "Missing project name",
        description: "Project name is required.",
        variant: "destructive",
      })
      return
    }

    setIsUpdating(true)
    try {
      const result = await updateResource({
        resourceId: projectId,
        name: trimmedName,
        description: trimmedDescription || null,
        content: trimmedDescription || null,
      })

      if (!result.success) {
        toast({
          title: "Failed to update project",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsEditOpen(false)
      toast({ title: "Project updated" })
      router.refresh()
    } catch {
      toast({
        title: "Failed to update project",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  /**
   * Soft-deletes the project through shared resource deletion action.
   */
  const handleDeleteProject = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteResource(projectId)

      if (!result.success) {
        toast({
          title: "Failed to delete project",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsDeleteOpen(false)
      toast({ title: "Project deleted" })
      router.push("/")
      router.refresh()
    } catch {
      toast({
        title: "Failed to delete project",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsDeleting(false)
    }
  }

  /**
   * Owner gate: only project owners can mutate project content.
   */
  if (!ownerId || !currentUser?.id || currentUser.id !== ownerId) return null

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
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>Update your project name and description.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`project-name-${projectId}`}>Name</Label>
              <Input
                id={`project-name-${projectId}`}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Project name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`project-description-${projectId}`}>Description</Label>
              <Textarea
                id={`project-description-${projectId}`}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Describe your project..."
                className="min-h-[140px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdateProject()} disabled={isUpdating}>
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
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The project and its detail page will be removed from active surfaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteProject()} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
