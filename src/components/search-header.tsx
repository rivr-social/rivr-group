/**
 * @fileoverview SearchHeader - Full-width search bar for the search results page.
 *
 * Displayed at the top of the search page. Provides real-time filtering with
 * debounced input, search suggestions, and clear functionality.
 *
 * Data is sourced from the semantic graph via `useHomeFeed` and `useLocalesAndBasins`
 * hooks rather than static mock arrays.
 */
"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ChapterSelector } from "@/components/chapter-selector"
import { useRouter } from "next/navigation"
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { useHomeFeed, usePosts, useLocalesAndBasins } from "@/lib/hooks/use-graph-data"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { getInitials } from "@/lib/utils"

type SearchResult = {
  id: string
  type: "post" | "group" | "user" | "event" | "chapter"
  title: string
  subtitle?: string
  image?: string
  chapter: string | string[]
}

interface SearchHeaderProps {
  selectedChapter: string
  onChapterChange: (chapter: string) => void
}

/**
 * Renders a search header with real-time suggestions from the semantic graph.
 *
 * @param props - Chapter filter state and change handler.
 */
export function SearchHeader({ selectedChapter, onChapterChange }: SearchHeaderProps) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState("")
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchEnabled = isSearchOpen || searchQuery.trim().length > 0

  /** Fetch live data from the semantic graph only while search is active. */
  const { data: graphData } = useHomeFeed(20, undefined, { enabled: searchEnabled })
  const { posts: activePosts } = usePosts(50, undefined, { enabled: searchEnabled })
  const { data: localeData } = useLocalesAndBasins({ enabled: searchEnabled })
  const locales = localeData.locales

  const people = graphData.people
  const groups = graphData.groups
  const events = graphData.events

  /** Handle clicks outside the search dropdown. */
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  /** Generate search results based on query and selected chapter. */
  const searchResults = useMemo<SearchResult[]>(() => {
    if (!searchQuery.trim()) {
      return []
    }

    const query = searchQuery.toLowerCase()
    const results: SearchResult[] = []

    /** Search chapters/locales. */
    locales.forEach((locale) => {
      if (locale.name.toLowerCase().includes(query) || locale.id.toLowerCase().includes(query)) {
        results.push({
          id: locale.id,
          type: "chapter",
          title: locale.name,
          subtitle: `${locale.memberCount} members`,
          image: locale.image,
          chapter: locale.id,
        })
      }
    })

    /** Search posts. */
    activePosts.forEach((post) => {
      if (
        (selectedChapter === "all" || (post.chapterTags ?? []).includes(selectedChapter)) &&
        post.content.toLowerCase().includes(query)
      ) {
        results.push({
          id: post.id,
          type: "post",
          title: post.content.substring(0, 60) + (post.content.length > 60 ? "..." : ""),
          subtitle: "",
          image: undefined,
          chapter: post.chapterTags ?? [],
        })
      }
    })

    /** Search groups. */
    groups.forEach((group) => {
      if (
        (selectedChapter === "all" || (group.chapterTags ?? []).includes(selectedChapter)) &&
        (group.name.toLowerCase().includes(query) || (group.description || "").toLowerCase().includes(query))
      ) {
        results.push({
          id: group.id,
          type: "group",
          title: group.name,
          subtitle: (group.description || "").substring(0, 60) + ((group.description || "").length > 60 ? "..." : ""),
          image: group.image,
          chapter: group.chapterTags || [],
        })
      }
    })

    /** Search people. */
    people.forEach((user) => {
      if (
        (selectedChapter === "all" || (user.chapterTags ?? []).includes(selectedChapter)) &&
        (user.name.toLowerCase().includes(query) ||
          (user.username || "").toLowerCase().includes(query) ||
          (user.bio || "").toLowerCase().includes(query))
      ) {
        results.push({
          id: user.id,
          type: "user",
          title: user.name,
          subtitle: user.bio ? user.bio.substring(0, 60) + (user.bio.length > 60 ? "..." : "") : "",
          image: user.avatar,
          chapter: user.chapterTags || [],
        })
      }
    })

    /** Search events. */
    events.forEach((event) => {
      if (
        (selectedChapter === "all" || (event.chapterTags ?? []).includes(selectedChapter)) &&
        ((event.name || "").toLowerCase().includes(query) || (event.description || "").toLowerCase().includes(query))
      ) {
        results.push({
          id: event.id,
          type: "event",
          title: event.name || "Untitled Event",
          subtitle: (event.description || "").substring(0, 60) + ((event.description || "").length > 60 ? "..." : ""),
          image: undefined,
          chapter: event.chapterTags || [],
        })
      }
    })

    return results
  }, [searchQuery, selectedChapter, locales, activePosts, groups, people, events])

  const handleSelectResult = (result: SearchResult) => {
    setIsSearchOpen(false)
    setSearchQuery("")

    switch (result.type) {
      case "post":
        router.push(`/posts/${result.id}`)
        break
      case "group":
        router.push(`/groups/${result.id}`)
        break
      case "user": {
        const user = people.find((u) => u.id === result.id)
        if (user) router.push(`/profile/${user.username || user.id}`)
        break
      }
      case "event":
        router.push(`/events/${result.id}`)
        break
      case "chapter":
        onChapterChange(result.id)
        break
    }
  }

  const handleClearSearch = () => {
    setSearchQuery("")
  }

  return (
    <div className="w-full flex items-center gap-2">
      <div className="flex-1 relative" ref={searchRef}>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search chapters, posts, people..."
            className="pl-9 pr-8 h-10 bg-muted/30"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setIsSearchOpen(true)}
          />
          {searchQuery && (
            <button className="absolute right-3 top-2.5" onClick={handleClearSearch} aria-label="Clear search">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          )}
        </div>

        {isSearchOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-md shadow-lg z-50 max-h-[70vh] overflow-auto">
            <Command>
              <CommandList>
                {searchResults.length === 0 && searchQuery && <CommandEmpty>No results found</CommandEmpty>}

                {searchResults.filter((r) => r.type === "chapter").length > 0 && (
                  <CommandGroup heading="Chapters">
                    {searchResults
                      .filter((result) => result.type === "chapter")
                      .map((result) => (
                        <CommandItem
                          key={`chapter-${result.id}`}
                          onSelect={() => handleSelectResult(result)}
                          className="flex items-center gap-2 py-2"
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={result.image || "/placeholder.svg"} alt={result.title} />
                            <AvatarFallback>{getInitials(result.title)}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                            )}
                          </div>
                          <Badge variant="outline">Chapter</Badge>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {searchResults.filter((r) => r.type === "post").length > 0 && (
                  <CommandGroup heading="Posts">
                    {searchResults
                      .filter((result) => result.type === "post")
                      .slice(0, 3)
                      .map((result) => (
                        <CommandItem
                          key={`post-${result.id}`}
                          onSelect={() => handleSelectResult(result)}
                          className="flex items-center gap-2 py-2"
                        >
                          {result.image && (
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={result.image || "/placeholder.svg"} alt="" />
                              <AvatarFallback>{result.title.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                          )}
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                            )}
                          </div>
                          <Badge variant="outline">Post</Badge>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {searchResults.filter((r) => r.type === "group").length > 0 && (
                  <CommandGroup heading="Groups">
                    {searchResults
                      .filter((result) => result.type === "group")
                      .slice(0, 3)
                      .map((result) => (
                        <CommandItem
                          key={`group-${result.id}`}
                          onSelect={() => handleSelectResult(result)}
                          className="flex items-center gap-2 py-2"
                        >
                          {result.image && (
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={result.image || "/placeholder.svg"} alt="" />
                              <AvatarFallback>{result.title.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                          )}
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                            )}
                          </div>
                          <Badge variant="outline">Group</Badge>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {searchResults.filter((r) => r.type === "user").length > 0 && (
                  <CommandGroup heading="People">
                    {searchResults
                      .filter((result) => result.type === "user")
                      .slice(0, 3)
                      .map((result) => (
                        <CommandItem
                          key={`user-${result.id}`}
                          onSelect={() => handleSelectResult(result)}
                          className="flex items-center gap-2 py-2"
                        >
                          {result.image && (
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={result.image || "/placeholder.svg"} alt="" />
                              <AvatarFallback>{result.title.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                          )}
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                            )}
                          </div>
                          <Badge variant="outline">Person</Badge>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {searchResults.filter((r) => r.type === "event").length > 0 && (
                  <CommandGroup heading="Events">
                    {searchResults
                      .filter((result) => result.type === "event")
                      .slice(0, 3)
                      .map((result) => (
                        <CommandItem
                          key={`event-${result.id}`}
                          onSelect={() => handleSelectResult(result)}
                          className="flex items-center gap-2 py-2"
                        >
                          {result.image && (
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={result.image || "/placeholder.svg"} alt="" />
                              <AvatarFallback>{result.title.substring(0, 2)}</AvatarFallback>
                            </Avatar>
                          )}
                          <div className="flex-1 overflow-hidden">
                            <p className="truncate">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                            )}
                          </div>
                          <Badge variant="outline">Event</Badge>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {searchResults.length > 0 && searchQuery && (
                  <div className="p-2 border-t">
                    <button
                      className="w-full text-center text-sm text-primary hover:underline"
                      onClick={() => {
                        router.push(`/explore?q=${encodeURIComponent(searchQuery)}&chapter=${selectedChapter}`)
                        setIsSearchOpen(false)
                      }}
                    >
                      See all results
                    </button>
                  </div>
                )}
              </CommandList>
            </Command>
          </div>
        )}
      </div>
      <ChapterSelector selectedChapter={selectedChapter} onChapterChange={onChapterChange} variant="compact" />
    </div>
  )
}
