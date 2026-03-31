"use client"

/**
 * Modal dialog for editing group profile details (name, description, location,
 * tags, cover image). Calls the `updateGroupResource` server action on submit.
 */

import { useState, useRef, useCallback } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Camera, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { LocationAutocompleteInput, type LocationSuggestion } from "@/components/location-autocomplete-input"
import { TagEditor } from "@/components/tag-editor"
import { updateGroupResource } from "@/app/actions/create-resources"

/** Maximum commission percentage allowed for mart sales. */
const MAX_COMMISSION_PERCENT = 50

interface GroupEditModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  initialName: string
  initialDescription: string
  initialLocation: string
  initialTags: string[]
  initialCoverImage: string
  /** The group's type string (e.g. "organization", "basic", "ring"). */
  groupType?: string
  /** Current commission in basis points (e.g. 1000 = 10%). */
  initialCommissionBps?: number
}

export function GroupEditModal({
  open,
  onOpenChange,
  groupId,
  initialName,
  initialDescription,
  initialLocation,
  initialTags,
  initialCoverImage,
  groupType,
  initialCommissionBps,
}: GroupEditModalProps) {
  const router = useRouter()
  const { toast } = useToast()
  const coverInputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [locationText, setLocationText] = useState(initialLocation === "Location not provided" ? "" : initialLocation)
  const [locationData, setLocationData] = useState<LocationSuggestion | null>(null)
  const [tags, setTags] = useState<string[]>(initialTags)
  const [coverImage, setCoverImage] = useState(initialCoverImage)
  const [coverPreview, setCoverPreview] = useState(initialCoverImage)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [commissionPercent, setCommissionPercent] = useState(
    typeof initialCommissionBps === "number" ? Math.round(initialCommissionBps / 100) : 0
  )
  const [saving, setSaving] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)

  const isOrganization = groupType === "organization" || groupType === "org"

  const handleCoverSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCoverFile(file)
    const objectUrl = URL.createObjectURL(file)
    setCoverPreview(objectUrl)
    e.target.value = ""
  }, [])

  const handleLocationSelect = useCallback((suggestion: LocationSuggestion) => {
    setLocationText(suggestion.label)
    setLocationData(suggestion)
  }, [])

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Group name cannot be empty.", variant: "destructive" })
      return
    }

    setSaving(true)

    try {
      let finalCoverUrl = coverImage

      // Upload new cover image if one was selected
      if (coverFile) {
        setUploadingCover(true)
        const formData = new FormData()
        formData.append("file", coverFile)
        formData.append("bucket", "avatars")
        const uploadRes = await fetch("/api/upload", { method: "POST", body: formData })
        const uploadJson = await uploadRes.json()
        if (!uploadRes.ok || !uploadJson.results?.[0]?.url) {
          toast({ title: "Cover upload failed", description: uploadJson.error || "Could not upload image.", variant: "destructive" })
          setSaving(false)
          setUploadingCover(false)
          return
        }
        finalCoverUrl = uploadJson.results[0].url
        setUploadingCover(false)
      }

      // Build metadata patch
      const metadataPatch: Record<string, unknown> = {
        coverImage: finalCoverUrl,
        chapterTags: tags,
        tags,
      }

      // Store commission as basis points for organizations
      if (isOrganization) {
        const clampedPercent = Math.max(0, Math.min(MAX_COMMISSION_PERCENT, commissionPercent))
        metadataPatch.commissionBps = clampedPercent * 100
      }

      // Set location from suggestion data or text
      if (locationData) {
        metadataPatch.location = {
          name: locationData.label,
          city: locationData.locality ?? locationData.name ?? locationData.label,
          lat: locationData.lat,
          lng: locationData.lon,
        }
      } else if (locationText.trim()) {
        metadataPatch.location = locationText.trim()
      } else {
        metadataPatch.location = null
      }

      const result = await updateGroupResource({
        groupId,
        name: name.trim(),
        description: description.trim(),
        metadataPatch,
      })

      if (result.success) {
        toast({ title: "Group updated" })
        onOpenChange(false)
        router.refresh()
      } else {
        toast({ title: "Update failed", description: result.message, variant: "destructive" })
      }
    } catch {
      toast({ title: "Update failed", description: "Something went wrong.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }, [name, description, locationText, locationData, tags, coverImage, coverFile, groupId, toast, onOpenChange, router, isOrganization, commissionPercent])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Group</DialogTitle>
          <DialogDescription>Update your group&apos;s profile information.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Cover Image */}
          <div className="space-y-2">
            <Label>Cover Image</Label>
            <button
              type="button"
              className="relative w-full h-32 rounded-lg border bg-muted overflow-hidden group cursor-pointer"
              onClick={() => coverInputRef.current?.click()}
            >
              {coverPreview ? (
                <Image
                  src={coverPreview}
                  alt="Cover preview"
                  fill
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Click to upload cover image
                </div>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                <Camera className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              {uploadingCover && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <span className="text-white text-sm">Uploading...</span>
                </div>
              )}
            </button>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleCoverSelect}
            />
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Group name"
              maxLength={120}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="group-description">Description</Label>
            <Textarea
              id="group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your group..."
              rows={4}
              maxLength={2000}
            />
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label>Location</Label>
            <LocationAutocompleteInput
              value={locationText}
              onValueChange={setLocationText}
              onSelectSuggestion={handleLocationSelect}
              placeholder="Search for a location..."
            />
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label>Tags</Label>
            <TagEditor
              tags={tags}
              setTags={setTags}
              placeholder="Add tags and press Enter..."
            />
          </div>

          {/* Mart Commission - organizations only */}
          {isOrganization && (
            <div className="space-y-2">
              <Label htmlFor="commission-percent">Mart Commission (%)</Label>
              <Input
                id="commission-percent"
                type="number"
                min={0}
                max={MAX_COMMISSION_PERCENT}
                step={1}
                value={commissionPercent}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) {
                    setCommissionPercent(Math.max(0, Math.min(MAX_COMMISSION_PERCENT, val)))
                  } else {
                    setCommissionPercent(0)
                  }
                }}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                Percentage taken from member sales in your mart (0&ndash;{MAX_COMMISSION_PERCENT}%)
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
