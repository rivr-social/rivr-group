/**
 * @fileoverview ListingActions - Edit/delete action buttons for marketplace listings.
 *
 * Displayed on listing detail pages when the current user is the listing owner.
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
 * Props for owner-only marketplace listing edit/delete actions.
 */
interface ListingActionsProps {
  listingId: string
  listingTitle: string
  listingDescription: string
  listingPrice: string | number | null | undefined
  ownerId: string
}

/**
 * Normalizes a listing price value into a numeric form input string.
 *
 * @param price - Existing listing price from listing metadata.
 * @returns Sanitized numeric string for editing.
 */
function toPriceInputValue(price: ListingActionsProps["listingPrice"]): string {
  if (typeof price === "number" && Number.isFinite(price)) return String(price)
  if (typeof price === "string") return price.replace(/[^0-9.]/g, "")
  return ""
}

/**
 * Renders owner-only listing edit and delete controls.
 *
 * @param props - Listing identifiers and editable values.
 * @returns Action controls when current user owns the listing; otherwise null.
 */
export function ListingActions({
  listingId,
  listingTitle,
  listingDescription,
  listingPrice,
  ownerId,
}: ListingActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useUser()
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [draftTitle, setDraftTitle] = useState(listingTitle)
  const [draftDescription, setDraftDescription] = useState(listingDescription)
  const [draftPrice, setDraftPrice] = useState(toPriceInputValue(listingPrice))

  /**
   * Keeps form values aligned with latest listing data when the edit dialog opens.
   */
  useEffect(() => {
    if (!isEditOpen) return
    setDraftTitle(listingTitle)
    setDraftDescription(listingDescription)
    setDraftPrice(toPriceInputValue(listingPrice))
  }, [isEditOpen, listingTitle, listingDescription, listingPrice])

  /**
   * Persists listing title/description/price edits through shared update action.
   */
  const handleUpdateListing = async () => {
    const trimmedTitle = draftTitle.trim()
    const trimmedDescription = draftDescription.trim()
    const parsedPrice = Number.parseFloat(draftPrice.trim())

    if (!trimmedTitle || !trimmedDescription) {
      toast({
        title: "Missing required fields",
        description: "Listing title and description are required.",
        variant: "destructive",
      })
      return
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      toast({
        title: "Invalid price",
        description: "Price must be a non-negative number.",
        variant: "destructive",
      })
      return
    }

    setIsUpdating(true)
    try {
      const result = await updateResource({
        resourceId: listingId,
        name: trimmedTitle,
        description: trimmedDescription,
        content: trimmedDescription,
        metadataPatch: {
          price: parsedPrice,
        },
      })

      if (!result.success) {
        toast({
          title: "Failed to update listing",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsEditOpen(false)
      toast({ title: "Listing updated" })
      router.refresh()
    } catch {
      toast({
        title: "Failed to update listing",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  /**
   * Soft-deletes the listing through shared deletion action.
   */
  const handleDeleteListing = async () => {
    setIsDeleting(true)
    try {
      const result = await deleteResource(listingId)

      if (!result.success) {
        toast({
          title: "Failed to delete listing",
          description: result.message,
          variant: "destructive",
        })
        return
      }

      setIsDeleteOpen(false)
      toast({ title: "Listing deleted" })
      router.push("/")
      router.refresh()
    } catch {
      toast({
        title: "Failed to delete listing",
        description: "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsDeleting(false)
    }
  }

  /**
   * Owner gate: only listing owners can mutate listings.
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
            <DialogTitle>Edit listing</DialogTitle>
            <DialogDescription>Update your listing details and price.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`listing-title-${listingId}`}>Title</Label>
              <Input
                id={`listing-title-${listingId}`}
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Listing title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`listing-description-${listingId}`}>Description</Label>
              <Textarea
                id={`listing-description-${listingId}`}
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Describe what you're offering..."
                className="min-h-[140px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`listing-price-${listingId}`}>Price</Label>
              <Input
                id={`listing-price-${listingId}`}
                type="number"
                min="0"
                step="0.01"
                value={draftPrice}
                onChange={(event) => setDraftPrice(event.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={() => void handleUpdateListing()} disabled={isUpdating}>
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
            <AlertDialogTitle>Delete this listing?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The listing will be removed from the marketplace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteListing()} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Delete listing"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
