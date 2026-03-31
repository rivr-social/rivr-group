"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Check, MapPin } from "lucide-react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { fetchChapters } from "@/app/actions/graph"
import { useRouter } from "next/navigation"
import type { Chapter } from "@/lib/types"

/**
 * Searchable chapter selector used in chapter-filter controls and header/context switchers.
 *
 * This component presents a popover command menu with an "All Chapters" option and
 * chapter-specific options fetched from the database.
 *
 * Key props:
 * - `selectedChapter`: currently selected chapter id.
 * - `onChapterChange`: callback invoked when selection changes.
 * - `triggerElement`: optional custom trigger UI; defaults to an outline button.
 */
interface ChapterDropdownProps {
  selectedChapter: string
  onChapterChange: (chapter: string) => void
  triggerElement?: React.ReactNode
}

/**
 * Renders a chapter picker with local search/filter and controlled selection updates.
 *
 * @param props - Component props.
 * @param props.selectedChapter - The active chapter id.
 * @param props.onChapterChange - Called with the selected chapter id.
 * @param props.triggerElement - Optional trigger element replacing the default button.
 */
export function ChapterDropdown({ selectedChapter, onChapterChange, triggerElement }: ChapterDropdownProps) {
  // Local UI state for popover visibility and in-menu search text.
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [chapters, setChapters] = useState<Chapter[]>([])
  const _router = useRouter()

  // Fetch chapter data from the database on mount.
  useEffect(() => {
    fetchChapters().then(setChapters).catch((err) => console.error("Failed to fetch chapters:", err))
  }, [])

  // Add "All Chapters" option to the list.
  const allChapters = [{ id: "all", name: "All Chapters", memberCount: 0, image: "/placeholder.svg" }, ...chapters]

  // Resolve the selected chapter object for trigger display text.
  const selectedChapterObj = allChapters.find((chapter) => chapter.id === selectedChapter)

  // Filter chapters in-memory based on the current search query.
  const filteredChapters = searchQuery
    ? allChapters.filter(
        (chapter) =>
          chapter.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          chapter.id.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : allChapters

  // Event handler: propagate selection to parent and reset local popover/search state.
  const handleSelect = (chapterId: string) => {
    onChapterChange(chapterId)
    setOpen(false)
    setSearchQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {triggerElement || (
          <Button variant="outline" role="combobox" aria-expanded={open} className="justify-between min-w-[150px]">
            <MapPin className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedChapterObj?.name || "Select Chapter"}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Search chapters..." value={searchQuery} onValueChange={setSearchQuery} />
          <CommandList className="max-h-[300px] overflow-auto">
            <CommandEmpty>No chapter found.</CommandEmpty>
            <CommandGroup>
              {filteredChapters.map((chapter) => (
                <CommandItem
                  key={chapter.id}
                  value={chapter.name}
                  onSelect={() => handleSelect(chapter.id)}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center">
                    <Avatar className="h-6 w-6 mr-2">
                      <AvatarImage src={chapter.image || "/placeholder.svg"} alt={chapter.name} />
                      <AvatarFallback>{chapter.name.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <span>{chapter.name}</span>
                      {/* Conditional rendering: member counts are hidden for synthetic "all" option. */}
                      {chapter.id !== "all" && (
                        <span className="ml-2 text-xs text-muted-foreground">({chapter.memberCount} members)</span>
                      )}
                    </div>
                  </div>
                  {/* Conditional rendering: checkmark only appears for current selection. */}
                  <Check className={`ml-2 h-4 w-4 ${selectedChapter === chapter.id ? "opacity-100" : "opacity-0"}`} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
