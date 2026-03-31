/**
 * @fileoverview ImageUpload - Multi-file image uploader with preview and validation.
 *
 * Used in forms (create post, create listing, profile editing) for uploading images
 * to the server. Validates file type and size client-side, uploads via `/api/upload`,
 * and provides image previews with remove capability.
 *
 * Key props: onImageUploaded, value, onChange, maxFiles, bucket
 */
"use client"

import { useState, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Upload, X, AlertCircle, Loader2 } from "lucide-react"
import Image from "next/image"

const MAX_FILE_SIZE_MB = 10
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"]
const ACCEPT_STRING = ACCEPTED_IMAGE_TYPES.join(",")

interface ImageUploadProps {
  onImageUploaded?: (url: string) => void
  value?: string[]
  onChange?: (urls: string[]) => void
  maxFiles?: number
  bucket?: "uploads" | "avatars" | "exports"
}

/**
 * Renders an image upload area with file validation, upload progress, previews, and remove buttons.
 *
 * @param {ImageUploadProps} props
 * @param {(url: string) => void} [props.onImageUploaded] - Legacy callback per uploaded URL
 * @param {string[]} [props.value] - Array of currently uploaded image URLs
 * @param {(urls: string[]) => void} [props.onChange] - Controlled value callback with full URL array
 * @param {number} [props.maxFiles=1] - Maximum number of images allowed
 * @param {string} [props.bucket="uploads"] - Storage bucket for the upload API
 */
export function ImageUpload({
  onImageUploaded,
  value = [],
  onChange,
  maxFiles = 1,
  bucket = "uploads",
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [isDragActive, setIsDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const remainingSlots = maxFiles - value.length

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files)
      if (fileArray.length === 0) return
      setError(null)

      // Validate number of files
      if (fileArray.length > remainingSlots) {
        setError(`You can only upload ${remainingSlots} more image${remainingSlots !== 1 ? "s" : ""}`)
        return
      }

      // Client-side validation
      for (const file of fileArray) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          setError(`"${file.name}" is not a supported image type. Use JPEG, PNG, GIF, or WebP.`)
          return
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          setError(`"${file.name}" exceeds the ${MAX_FILE_SIZE_MB}MB size limit.`)
          return
        }
      }

      setIsUploading(true)
      setProgress(0)

      const formData = new FormData()
      for (const file of fileArray) {
        formData.append("file", file)
      }
      formData.append("bucket", bucket)

      try {
        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        })

        const data = await response.json()

        if (!response.ok) {
          const errorMessage = data.error || "Upload failed"
          setError(errorMessage)
          return
        }

        const uploadedUrls: string[] = data.results.map((r: { url: string }) => r.url)
        setProgress(100)

        // Notify parent via both callback patterns
        if (onImageUploaded) {
          for (const url of uploadedUrls) {
            onImageUploaded(url)
          }
        }
        if (onChange) {
          onChange([...value, ...uploadedUrls])
        }
      } catch {
        setError("Failed to upload. Please check your connection and try again.")
      } finally {
        setIsUploading(false)
        // Reset the file input so the same file can be re-selected
        if (fileInputRef.current) {
          fileInputRef.current.value = ""
        }
      }
    },
    [bucket, onChange, onImageUploaded, remainingSlots, value]
  )

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files || files.length === 0) return
      await uploadFiles(files)
    },
    [uploadFiles]
  )

  const handleRemove = useCallback(
    (index: number) => {
      if (onChange) {
        const updated = value.filter((_, i) => i !== index)
        onChange(updated)
      }
    },
    [onChange, value]
  )

  const handleClick = () => {
    fileInputRef.current?.click()
  }

  const handleDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setIsDragActive(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragActive(false)
    }
  }, [])

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLButtonElement>) => {
      event.preventDefault()
      setIsDragActive(false)
      const files = event.dataTransfer.files
      if (!files || files.length === 0) return
      await uploadFiles(files)
    },
    [uploadFiles]
  )

  return (
    <div className="space-y-3">
      {/* Image previews */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((url, index) => (
            <div key={url} className="relative group">
              <Image
                src={url}
                alt={`Upload ${index + 1}`}
                width={80}
                height={80}
                className="h-20 w-20 rounded-md object-cover border"
              />
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload button */}
      {remainingSlots > 0 && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_STRING}
            multiple={remainingSlots > 1}
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleClick}
            disabled={isUploading}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`w-full h-24 flex flex-col items-center justify-center gap-1 border-dashed transition-colors ${
              isDragActive ? "border-primary bg-primary/5" : ""
            }`}
          >
            {isUploading ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-sm">Uploading... {progress > 0 ? `${progress}%` : ""}</span>
              </>
            ) : (
              <>
                <Upload className="h-6 w-6" />
                <span className="text-sm">
                  {value.length === 0 ? "Upload Image" : `Add Image (${remainingSlots} remaining)`}
                </span>
                <span className="text-xs text-muted-foreground">
                  Drag and drop or click to upload. JPEG, PNG, GIF, WebP up to {MAX_FILE_SIZE_MB}MB
                </span>
              </>
            )}
          </Button>
        </>
      )}

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
