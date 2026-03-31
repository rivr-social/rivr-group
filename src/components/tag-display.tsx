/**
 * @fileoverview TagDisplay - Renders a set of tags as linked badges.
 *
 * Used throughout the app to display tags (locales, categories, etc.) as
 * clickable badge components that link to filtered views.
 */
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { getChapterName } from "@/lib/utils"

interface TagDisplayProps {
  tags: string[]
  type: "chapter" | "group"
  maxDisplay?: number
  className?: string
}

/**
 * TagDisplay component shows a list of tags with proper styling
 * It can be used for both chapter tags and group tags
 */
export function TagDisplay({ tags, type, maxDisplay = 2, className = "" }: TagDisplayProps) {
  if (!tags || tags.length === 0) return null

  const displayTags = tags.slice(0, maxDisplay)
  const remainingCount = tags.length - maxDisplay

  const getTagName = (tagId: string) => {
    if (type === "chapter") {
      return getChapterName(tagId)
    }
    return tagId // For group tags, we'd need a similar helper function
  }

  const getTagUrl = (tagId: string) => {
    if (type === "chapter") {
      return `/chapters/${tagId}`
    }
    return `/search?group=${tagId}` // For group tags
  }

  const getTagStyle = () => {
    if (type === "chapter") {
      return "bg-blue-50 text-blue-700 hover:bg-blue-100"
    }
    return "bg-green-50 text-green-700 hover:bg-green-100" // For group tags
  }

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {displayTags.map((tagId) => (
        <Link key={tagId} href={getTagUrl(tagId)}>
          <Badge variant="outline" className={getTagStyle()}>
            {getTagName(tagId)}
          </Badge>
        </Link>
      ))}
      {remainingCount > 0 && (
        <Badge variant="outline" className={getTagStyle()}>
          +{remainingCount} more
        </Badge>
      )}
    </div>
  )
}
