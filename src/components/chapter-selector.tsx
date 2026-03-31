"use client"

/**
 * Chapter selection dropdown used in chapter navigation controls, including compact and prominent
 * variants for headers/toolbars.
 *
 * Used in: chapter filtering flows where users switch between all chapters and specific chapter scopes.
 *
 * Key props:
 * - `selectedChapter`: current chapter id (`"all"` means unfiltered/global)
 * - `onChapterChange`: callback fired when a user selects a chapter
 * - `variant`: visual presentation mode (`default`, `compact`, or `prominent`)
 */
import * as React from "react"
import { Check, ChevronDown, Globe, MapPin, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { fetchChapters } from "@/app/actions/graph"
import { Input } from "@/components/ui/input"
import type { Chapter } from "@/lib/types"

interface ChapterSelectorProps {
  selectedChapter: string
  onChapterChange: (chapter: string) => void
  variant?: "default" | "compact" | "prominent"
}

/**
 * Searchable chapter dropdown with recent-selection persistence via `localStorage`.
 *
 * @param props - Component props.
 * @param props.selectedChapter - Active chapter id, or `"all"` for global scope.
 * @param props.onChapterChange - Parent callback used to apply a new chapter selection.
 * @param props.variant - Visual style variant for trigger button rendering.
 */
export function ChapterSelector({ selectedChapter, onChapterChange, variant = "default" }: ChapterSelectorProps) {
  // Controls the dropdown menu open/closed state.
  const [open, setOpen] = React.useState(false)
  // Stores the current text used to filter chapters in the menu.
  const [searchQuery, setSearchQuery] = React.useState("")
  // Ref used for programmatic focus management when the menu opens or search resets.
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  // Chapter data loaded from the database.
  const [chapters, setChapters] = React.useState<Chapter[]>([])

  // Fetch chapter data from the database on mount.
  React.useEffect(() => {
    fetchChapters().then(setChapters).catch((err) => console.error("Failed to fetch chapters:", err))
  }, [])

  // Group chapters by region (first word of name).
  const chaptersByRegion = React.useMemo(
    () =>
      chapters.reduce(
        (acc, chapter) => {
          const region = chapter.name.split(" ")[0]
          if (!acc[region]) {
            acc[region] = []
          }
          acc[region].push(chapter)
          return acc
        },
        {} as Record<string, Chapter[]>,
      ),
    [chapters],
  )

  // Find the currently selected chapter
  const selectedChapterObj =
    selectedChapter === "all"
      ? { id: "all", name: "All Chapters", image: null }
      : chapters.find((c) => c.id === selectedChapter) || { id: "all", name: "All Chapters", image: null }

  // Track the five most recently selected chapter ids.
  const [recentChapters, setRecentChapters] = React.useState<string[]>([])

  // Side effect: hydrate recents from browser storage on first client render.
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("recentChapters")
      if (saved) {
        try {
          setRecentChapters(JSON.parse(saved))
        } catch (e) {
          // Side effect failure handling: malformed persisted JSON is ignored.
          console.error("Failed to parse recent chapters:", e)
        }
      }
    }
  }, [])

  // Side effect: persist recents after updates so selections survive refresh/navigation.
  React.useEffect(() => {
    if (typeof window !== "undefined" && recentChapters.length > 0) {
      localStorage.setItem("recentChapters", JSON.stringify(recentChapters))
    }
  }, [recentChapters])

  // Side effect: focus search when opening; clear query when closing.
  React.useEffect(() => {
    if (open && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus()
      }, 100)
    } else {
      // Reset filtering so the next open shows the full chapter list.
      setSearchQuery("")
    }
  }, [open])

  // Event handler: apply a chapter selection and update recents.
  const handleSelectChapter = (chapterId: string) => {
    // Prop callback side effect: notify parent state/store about selection change.
    onChapterChange(chapterId)
    setOpen(false)

    // Don't add "all" to recent chapters
    if (chapterId === "all") return

    // Add to recent chapters (if not already at the top)
    setRecentChapters((prev) => {
      const filtered = prev.filter((id) => id !== chapterId)
      return [chapterId, ...filtered].slice(0, 5) // Keep only the 5 most recent
    })
  }

  // Event handler: update query text as the user types.
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
    // Keep cursor focus anchored in the search field while the menu is open.
    e.currentTarget.focus()
  }

  // Event handler: clear the current query without closing/selecting within the dropdown.
  const handleClearSearch = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // Prevent event bubbling
    setSearchQuery("")
    // Refocus the input after clearing
    setTimeout(() => {
      searchInputRef.current?.focus()
    }, 0)
  }

  // Derive recent chapter objects for rendering the "Recent" section.
  const recentChapterObjs = recentChapters
    .map((id) => chapters.find((c) => c.id === id))
    .filter(Boolean) as Chapter[]

  // Filtering helper used by both grouped and search-result rendering paths.
  const filterChapters = (chaps: Chapter[]) => {
    if (!searchQuery) return chaps

    const query = searchQuery.toLowerCase()
    return chaps.filter(
      (chapter) =>
        chapter.name.toLowerCase().includes(query) || chapter.name.split(" ")[0].toLowerCase().includes(query), // Region (first word)
    )
  }

  // Filter chapters by region based on search query
  const filteredChaptersByRegion: Record<string, Chapter[]> = {}

  // Conditional derivation: build grouped search results only when a query is present.
  if (searchQuery) {
    // When searching, create a flat list of filtered chapters
    const allFilteredChapters = filterChapters(chapters)

    // Group filtered chapters by region
    allFilteredChapters.forEach((chapter) => {
      const region = chapter.name.split(" ")[0]
      if (!filteredChaptersByRegion[region]) {
        filteredChaptersByRegion[region] = []
      }
      filteredChaptersByRegion[region].push(chapter)
    })
  } else {
    // When not searching, use the original grouped chapters
    Object.assign(filteredChaptersByRegion, chaptersByRegion)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant === "prominent" ? "default" : "outline"}
          className={cn(
            "flex items-center gap-2",
            variant === "prominent"
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-background border-primary/20 hover:bg-primary/5 hover:border-primary/30",
            variant === "compact" ? "h-9 px-3" : "h-10 px-4",
          )}
        >
          {variant === "prominent" ? (
            <>
              <MapPin className="mr-2 h-4 w-4" />
              <span className="font-medium">{selectedChapterObj.name}</span>
            </>
          ) : (
            <>
              <Globe className="mr-2 h-4 w-4 text-primary" />
              <span
                className={cn("font-medium text-foreground", variant === "compact" ? "max-w-[100px] truncate" : "")}
              >
                {selectedChapterObj.name}
              </span>
            </>
          )}
          <ChevronDown className="ml-1 h-4 w-4 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        {/* Search input */}
        <div className="p-2 border-b" onClick={(e) => e.stopPropagation()}>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search chapters..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-8 h-9 focus-visible:ring-primary"
              onKeyDown={(e) => e.stopPropagation()} // Prevent dropdown keyboard shortcuts from interfering
            />
            {/* Conditional rendering: only show clear action when there is active query text. */}
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <DropdownMenuLabel>Current</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => handleSelectChapter("all")}
          className="flex items-center justify-between cursor-pointer"
          onSelect={(e) => e.preventDefault()} // Prevent auto-selection
        >
          <div className="flex items-center">
            <Globe className="mr-2 h-4 w-4 text-muted-foreground" />
            <span>All Chapters</span>
          </div>
          {selectedChapter === "all" && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>

        {recentChapterObjs.length > 0 && !searchQuery && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            <DropdownMenuGroup>
              {recentChapterObjs.map((chapter) => (
                <DropdownMenuItem
                  key={`recent-${chapter.id}`}
                  onClick={() => handleSelectChapter(chapter.id)}
                  className="flex items-center justify-between cursor-pointer"
                  onSelect={(e) => e.preventDefault()} // Prevent auto-selection
                >
                  <div className="flex items-center">
                    <MapPin className="mr-2 h-4 w-4 text-muted-foreground" />
                    <span>{chapter.name}</span>
                  </div>
                  {selectedChapter === chapter.id && <Check className="h-4 w-4 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {Object.entries(filteredChaptersByRegion).length > 0 ? (
          Object.entries(filteredChaptersByRegion).map(([region, regionChapters]) => (
            <React.Fragment key={region}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{region}</DropdownMenuLabel>
              <DropdownMenuGroup>
                {regionChapters.map((chapter) => (
                  <DropdownMenuItem
                    key={chapter.id}
                    onClick={() => handleSelectChapter(chapter.id)}
                    className="flex items-center justify-between cursor-pointer"
                    onSelect={(e) => e.preventDefault()} // Prevent auto-selection
                  >
                    <div className="flex items-center">
                      <MapPin className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span>{chapter.name}</span>
                    </div>
                    {selectedChapter === chapter.id && <Check className="h-4 w-4 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </React.Fragment>
          ))
        ) : (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">No chapters found</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
