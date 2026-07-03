"use client"

/**
 * Group profile header with editable avatar and cover image.
 * Admin users can click on the avatar or cover to upload new images,
 * matching the user profile page pattern.
 */

import { useState, useRef, useCallback } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Camera, MapPin, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { updateGroupImageAction } from "@/app/actions/settings"

/** UUID pattern used to keep opaque place-agent ids out of the rendered chips. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface GroupProfileHeaderProps {
  groupId: string
  name: string
  description: string
  avatar: string
  coverImage: string
  location: string
  memberCount: number
  /**
   * Raw chapter/locale association tags. These are persisted verbatim (often
   * place-agent UUIDs) and are passed unchanged to the edit modal so saves
   * round-trip the real ids. For *display*, see `tagLabels` and the UUID guard
   * in the badge list — raw UUIDs are never shown to the user.
   */
  tags: string[]
  /**
   * Optional map of raw tag id → human-readable label (e.g. a resolved locale
   * /chapter name). When a tag is a raw UUID with no entry here it is omitted
   * from the rendered badges rather than leaked as an opaque identifier.
   */
  tagLabels?: Record<string, string>
  isAdmin: boolean
  children?: React.ReactNode
}

export function GroupProfileHeader({
  groupId,
  name,
  description,
  avatar,
  coverImage,
  location,
  memberCount,
  tags,
  tagLabels,
  isAdmin,
  children,
}: GroupProfileHeaderProps) {
  const router = useRouter()
  const { toast } = useToast()
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)

  // Resolve each raw tag to a human label, dropping any opaque UUID that has no
  // resolved name so place-agent identifiers never leak into the chip row.
  const displayTags = tags.flatMap((tag) => {
    const label = tagLabels?.[tag]
    if (label && label.trim().length > 0) return [{ tag, label: label.trim() }]
    if (UUID_RE.test(tag)) return []
    return [{ tag, label: tag }]
  })

  const handleImageUpload = useCallback(async (field: "avatar" | "coverImage", file: File) => {
    const setLoading = field === "avatar" ? setUploadingAvatar : setUploadingCover
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("bucket", "avatars")
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData })
      const uploadJson = await uploadRes.json()
      if (!uploadRes.ok || !uploadJson.results?.[0]?.url) {
        toast({ title: "Upload failed", description: uploadJson.error || "Could not upload image.", variant: "destructive" })
        return
      }
      const result = await updateGroupImageAction(groupId, field, uploadJson.results[0].url)
      if (result.success) {
        toast({ title: field === "avatar" ? "Group avatar updated" : "Cover image updated" })
        router.refresh()
      } else {
        toast({ title: "Update failed", description: result.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Upload failed", description: "Something went wrong.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [groupId, toast, router])

  return (
    <div className="liquid-glass rounded-xl border overflow-hidden bg-card">
      <div className="liquid-glass-effect rounded-xl" />
      <div className="liquid-glass-tint rounded-xl" />
      <div className="liquid-glass-shine rounded-xl" />
      {/* Cover image */}
      {isAdmin ? (
        <button
          type="button"
          className="relative h-40 md:h-52 bg-cover bg-center w-full group cursor-pointer"
          style={{ backgroundImage: `url(${coverImage})` }}
          onClick={() => coverInputRef.current?.click()}
          disabled={uploadingCover}
        >
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <Camera className="h-8 w-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          {uploadingCover && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <span className="text-white text-sm">Uploading...</span>
            </div>
          )}
        </button>
      ) : (
        <div
          className="relative h-40 md:h-52 bg-cover bg-center w-full"
          style={{ backgroundImage: `url(${coverImage})` }}
        />
      )}
      {isAdmin && (
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload("coverImage", f); e.target.value = ""; }}
        />
      )}

      <div className="px-4 md:px-6 pb-4">
        <div className="relative z-10 flex flex-col sm:flex-row items-start sm:justify-between gap-3 -mt-12 md:-mt-14">
          {/* Avatar */}
          {isAdmin ? (
            <button
              type="button"
              className="relative h-24 w-24 md:h-28 md:w-28 rounded-full border-4 border-background bg-muted overflow-hidden group cursor-pointer"
              onClick={() => avatarInputRef.current?.click()}
              disabled={uploadingAvatar}
            >
              <Image
                src={avatar}
                alt={name}
                width={112}
                height={112}
                className="h-full w-full object-cover"
                unoptimized
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center rounded-full">
                <Camera className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              {uploadingAvatar && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-full">
                  <span className="text-white text-xs">...</span>
                </div>
              )}
            </button>
          ) : (
            <div className="h-24 w-24 md:h-28 md:w-28 rounded-full border-4 border-background bg-muted overflow-hidden">
              <Image
                src={avatar}
                alt={name}
                width={112}
                height={112}
                className="h-full w-full object-cover"
                unoptimized
              />
            </div>
          )}
          {isAdmin && (
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload("avatar", f); e.target.value = ""; }}
            />
          )}

          {/* Action buttons */}
          {children}
        </div>

        <div className="mt-3 space-y-2">
          <h1 className="text-2xl font-bold leading-tight">{name}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}

          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Users className="h-4 w-4" />
              {memberCount} member{memberCount !== 1 ? "s" : ""}
            </span>
            {location && location !== "Location not provided" && (
              <span className="inline-flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                {location}
              </span>
            )}
          </div>

          {displayTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {displayTags.map(({ tag, label }) => (
                <Badge key={tag} variant="secondary" className="text-xs">{label}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
