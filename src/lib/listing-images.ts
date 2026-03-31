export type ListingImageSource = {
  imageUrl?: string | null | undefined
  images?: string[] | null | undefined
}

export function getPrimaryListingImage(
  listing: ListingImageSource | null | undefined,
  fallback = "/placeholder-event.jpg",
): string {
  if (!listing) return fallback

  if (typeof listing.imageUrl === "string" && listing.imageUrl.trim().length > 0) {
    return listing.imageUrl
  }

  if (Array.isArray(listing.images)) {
    const firstImage = listing.images.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    if (firstImage) return firstImage
  }

  return fallback
}
