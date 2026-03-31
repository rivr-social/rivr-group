/**
 * @fileoverview TagSelector - Searchable tag picker with autocomplete.
 *
 * Used within TagEditor and other forms. Provides a search input that filters
 * available tags, displays suggestions, and allows selection/deselection.
 */
"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Check, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { fetchChapters, fetchGroups } from "@/app/actions/graph"
import { getChapterName } from "@/lib/utils"

interface TagSelectorProps {
  type: "chapter" | "group"
  selectedTags: string[]
  onChange: (tags: string[]) => void
  maxTags?: number
  label?: string
}

/**
 * TagSelector component allows users to select multiple tags
 * It can be used for both chapter tags and group tags
 */
export function TagSelector({
  type,
  selectedTags,
  onChange,
  maxTags = 5,
  label = type === "chapter" ? "Select Chapters" : "Select Groups",
}: TagSelectorProps) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [availableTags, setAvailableTags] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    async function loadTags() {
      if (type === "chapter") {
        const chapters = await fetchChapters()
        setAvailableTags(chapters.map((c) => ({ id: c.id, name: c.name })))
      } else {
        const groups = await fetchGroups()
        setAvailableTags(groups.map((g) => ({ id: g.id, name: g.name })))
      }
    }
    loadTags()
  }, [type])

  // Filter tags based on search query
  const filteredTags = searchQuery
    ? availableTags.filter(
        (tag) =>
          tag.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          tag.id.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : availableTags

  // Handle tag selection
  const toggleTag = (tagId: string) => {
    if (selectedTags.includes(tagId)) {
      onChange(selectedTags.filter((id) => id !== tagId))
    } else if (selectedTags.length < maxTags) {
      onChange([...selectedTags, tagId])
    }
  }

  // Remove a tag
  const removeTag = (tagId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(selectedTags.filter((id) => id !== tagId))
  }

  // Get tag name
  const getTagName = (tagId: string) => {
    if (type === "chapter") {
      // Try local cache first, then fall back to util
      const cached = availableTags.find((t) => t.id === tagId)
      if (cached) return cached.name
      return getChapterName(tagId)
    }
    const group = availableTags.find((g) => g.id === tagId)
    return group ? group.name : tagId
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 mb-2">
        {selectedTags.map((tagId) => (
          <Badge key={tagId} variant="secondary" className="flex items-center gap-1">
            {getTagName(tagId)}
            <button onClick={(e) => removeTag(tagId, e)} className="ml-1 hover:text-destructive">
              <X className="h-3 w-3" />
              <span className="sr-only">Remove</span>
            </button>
          </Badge>
        ))}

        {selectedTags.length < maxTags && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1">
                <Plus className="h-3.5 w-3.5" />
                <span>{label}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0">
              <Command>
                <CommandInput
                  placeholder={`Search ${type}s...`}
                  className="h-9"
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                />
                <CommandList>
                  <CommandEmpty>No {type}s found</CommandEmpty>
                  <CommandGroup>
                    {filteredTags.map((tag) => (
                      <CommandItem
                        key={tag.id}
                        value={tag.id}
                        onSelect={() => {
                          toggleTag(tag.id)
                          setSearchQuery("")
                        }}
                      >
                        <span>{tag.name}</span>
                        {selectedTags.includes(tag.id) && <Check className="ml-auto h-4 w-4" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {selectedTags.length >= maxTags && (
        <p className="text-xs text-muted-foreground">
          Maximum of {maxTags} {type}s reached
        </p>
      )}
    </div>
  )
}
