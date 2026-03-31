"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { deleteGroupResource, updateGroupResource } from "@/app/actions/create-resources"
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

interface EntityActionsProps {
  entityId: string
  entityName: string
  entityDescription?: string | null
  ownerId?: string
  entityLabel: string
  redirectPath: string
}

export function EntityActions({
  entityId,
  entityName,
  entityDescription,
  ownerId,
  entityLabel,
  redirectPath,
}: EntityActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [draftName, setDraftName] = useState(entityName)
  const [draftDescription, setDraftDescription] = useState(entityDescription ?? "")

  useEffect(() => {
    if (!isEditOpen) return
    setDraftName(entityName)
    setDraftDescription(entityDescription ?? "")
  }, [entityDescription, entityName, isEditOpen])

  const handleUpdate = async () => {
    const trimmedName = draftName.trim()
    const trimmedDescription = draftDescription.trim()

    if (!trimmedName) {
      toast({
        title: `Missing ${entityLabel} name`,
        description: `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} name is required.`,
        variant: "destructive",
      })
      return
    }

    setIsUpdating(true)
    try {
      const result = await updateGroupResource({
        groupId: entityId,
        name: trimmedName,
        description: trimmedDescription,
      })

      if (!result.success) {
        toast({
          title: `Failed to update ${entityLabel}`,
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsEditOpen(false)
      toast({ title: `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} updated` })
      router.refresh()
    } catch {
      toast({
        title: `Failed to update ${entityLabel}`,
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteGroupResource(entityId)

      if (!result.success) {
        toast({
          title: `Failed to delete ${entityLabel}`,
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsDeleteOpen(false)
      toast({ title: `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} deleted` })
      router.push(redirectPath)
      router.refresh()
    } catch {
      toast({
        title: `Failed to delete ${entityLabel}`,
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsDeleting(false)
    }
  }

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
            <DialogTitle>Edit {entityLabel}</DialogTitle>
            <DialogDescription>
              Update your {entityLabel} name and description.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${entityLabel}-name-${entityId}`}>Name</Label>
              <Input
                id={`${entityLabel}-name-${entityId}`}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder={`${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} name`}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${entityLabel}-description-${entityId}`}>Description</Label>
              <Textarea
                id={`${entityLabel}-description-${entityId}`}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder={`Describe your ${entityLabel}...`}
                className="min-h-[140px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdate()} disabled={isUpdating}>
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
            <AlertDialogTitle>Delete this {entityLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The {entityLabel} and its detail page will be removed from active surfaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? `Deleting ${entityLabel}...` : `Delete ${entityLabel}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
