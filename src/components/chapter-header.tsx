"use client"

/**
 * Chapter header used in chapter-scoped feed/listing pages to show the current chapter context
 * and provide a quick chapter-switch control.
 *
 * Used in: chapter-aware content views where the top bar remains sticky during scrolling.
 *
 * Key props:
 * - `selectedChapter`: active chapter id (`"all"` for global view)
 * - `onChapterChange`: callback invoked when a different chapter is selected
 */
import { useState, useEffect } from "react"
import { ChapterSelector } from "./chapter-selector"
import { fetchChapters } from "@/app/actions/graph"
import { Badge } from "@/components/ui/badge"
import type { Chapter } from "@/lib/types"

interface ChapterHeaderProps {
  selectedChapter: string
  onChapterChange: (chapter: string) => void
}

/**
 * Sticky chapter context header that auto-hides while scrolling down and reappears on upward scroll.
 *
 * @param props - Component props.
 * @param props.selectedChapter - The currently selected chapter id, or `"all"` for global view.
 * @param props.onChapterChange - Parent callback to update selected chapter state.
 */
export function ChapterHeader({ selectedChapter, onChapterChange }: ChapterHeaderProps) {
  // Tracks whether the sticky header should currently be rendered on-screen.
  const [isVisible, setIsVisible] = useState(true)
  // Stores the previous scroll position so direction changes can be detected.
  const [prevScrollPos, setPrevScrollPos] = useState(0)
  // Chapter data loaded from the database.
  const [chapters, setChapters] = useState<Chapter[]>([])

  // Fetch chapter data from the database on mount.
  useEffect(() => {
    fetchChapters().then(setChapters).catch((err) => console.error("Failed to fetch chapters:", err))
  }, [])

  // Side effect: subscribe to window scroll events to toggle header visibility by scroll direction.
  useEffect(() => {
    const handleScroll = () => {
      const currentScrollPos = window.scrollY
      // Show when scrolling up or near the page top; hide when actively scrolling down.
      setIsVisible(prevScrollPos > currentScrollPos || currentScrollPos < 10)
      setPrevScrollPos(currentScrollPos)
    }

    window.addEventListener("scroll", handleScroll)
    // Cleanup side effect on dependency change/unmount.
    return () => window.removeEventListener("scroll", handleScroll)
  }, [prevScrollPos])

  // Conditional data selection: resolve chapter metadata unless the global "all chapters" view is active.
  const currentChapter = selectedChapter === "all" ? null : chapters.find((c) => c.id === selectedChapter)

  return (
    <div
      className={`sticky z-40 w-full bg-background border-b transition-transform duration-300 ${
        isVisible ? "translate-y-0" : "-translate-y-full"
      }`}
      style={{ top: "104px" }} // Position below the top bar
    >
      <div className="container max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex-1">
          {/* Conditional rendering: chapter-specific details vs global "All Chapters" context. */}
          {currentChapter ? (
            <div>
              <h2 className="text-lg font-semibold">{currentChapter.name}</h2>
              <p className="text-sm text-muted-foreground">
                <Badge variant="outline" className="mr-2">
                  {currentChapter.memberCount} members
                </Badge>
                {currentChapter.location && <span className="text-xs">{currentChapter.location}</span>}
              </p>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-semibold">All Chapters</h2>
              <p className="text-sm text-muted-foreground">Viewing content from all chapters</p>
            </div>
          )}
        </div>
        <ChapterSelector selectedChapter={selectedChapter} onChapterChange={onChapterChange} variant="prominent" />
      </div>
    </div>
  )
}
