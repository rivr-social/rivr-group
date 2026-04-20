"use client"

/**
 * Locale selector dropdown used in locale-aware navigation and filtering areas.
 * Used in: views where users switch between "All Locales" and basin-grouped locales.
 * Key props: `selectedLocale` for active selection and `onLocaleChange` for parent state updates.
 */
import * as React from "react"
import { Check, ChevronDown, Globe, Star } from "lucide-react"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  useGlobalLocales,
  globalLocaleHref,
  type GlobalLocaleEntry,
} from "@/lib/hooks/use-global-locales"

interface LocaleSwitcherProps {
  onLocaleChange: (localeId: string) => void
  selectedLocale: string
}

/**
 * Renders a searchable locale picker grouped by basin, with links to locale/basin pages.
 * @param {LocaleSwitcherProps} props Props containing the current locale selection and change handler.
 */
export function LocaleSwitcher({ onLocaleChange, selectedLocale }: LocaleSwitcherProps) {
  // Local UI state for popover visibility and in-dropdown search query.
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // Ticket #109: locale list now comes from GLOBAL's federation registry,
  // not the current instance's DB. The hook caches for 5 min.
  const { locales, state, error } = useGlobalLocales()

  // Filter locales by search text against locale name and basin name.
  const filteredLocales = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return locales
    return locales.filter((locale) => {
      const basinName = locale.basinName || ""
      return (
        locale.name.toLowerCase().includes(normalized) ||
        basinName.toLowerCase().includes(normalized) ||
        locale.slug.toLowerCase().includes(normalized)
      )
    })
  }, [locales, query])

  // Group filtered locales by basin so the menu can render sectioned results.
  const localesByBasin = React.useMemo(() => {
    const grouped: Array<{ basinId: string; basinName: string; locales: GlobalLocaleEntry[] }> = []
    const index = new Map<string, number>()

    for (const locale of filteredLocales) {
      const basinId = locale.basinId || "unscoped"
      const basinName = locale.basinName || (basinId === "unscoped" ? "Other Locales" : basinId)
      if (!index.has(basinId)) {
        index.set(basinId, grouped.length)
        grouped.push({ basinId, basinName, locales: [] })
      }
      grouped[index.get(basinId)!].locales.push(locale)
    }

    return grouped
  }, [filteredLocales])

  const normalizedSelectedLocale = selectedLocale.trim().toLowerCase()
  const selectedLocaleObj = locales.find((locale) => {
    return (
      locale.id === selectedLocale ||
      locale.slug === selectedLocale ||
      locale.name.toLowerCase() === normalizedSelectedLocale
    )
  })
  // Conditional rendering flag for global mode vs. a specific locale.
  const isAll = !selectedLocaleObj || selectedLocale === "all"

  // When a user picks a locale from the dropdown, we:
  //   1. Notify the parent (keeps in-app state in sync if we're on global)
  //   2. Navigate to the locale-scoped landing on GLOBAL — so that from a
  //      peer/home instance the user lands on the canonical global locale
  //      view, and from global itself we still pick up the ?locale= hint.
  const handleSelectLocale = (localeSlugOrId: string) => {
    onLocaleChange(localeSlugOrId)
    setOpen(false)
    if (typeof window !== "undefined") {
      window.location.href = globalLocaleHref(localeSlugOrId)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {!isAll && selectedLocaleObj ? (
        // Show current locale context and deep link to the global locale page.
        <a
          href={globalLocaleHref(selectedLocaleObj.slug || selectedLocaleObj.id)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          {selectedLocaleObj.image ? (
            <Image
              src={selectedLocaleObj.image}
              alt={selectedLocaleObj.name}
              width={32}
              height={32}
              className="h-8 w-8 rounded-full object-cover border"
            />
          ) : null}
          <span className="text-lg font-semibold text-foreground">{selectedLocaleObj.name}</span>
          {selectedLocaleObj.isCommons ? <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" /> : null}
        </a>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            role="combobox"
            aria-expanded={open}
            aria-label="Select locale"
            className="flex items-center gap-1 px-2 font-normal text-[#ddaa46]"
          >
            {isAll ? (
              <>
                <Globe className="h-5 w-5 mr-1" />
                <span className="text-lg font-semibold">All Locales</span>
              </>
            ) : null}
            <ChevronDown className="h-4 w-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="z-[1200] w-[340px] border bg-popover opacity-100 p-0 shadow-2xl" align="start">
          <div className="border-b p-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search locales..."
              className="h-9"
              aria-label="Search global locales"
            />
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1">
            <button
              type="button"
              onClick={() => handleSelectLocale("all")}
              className={cn(
                "w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                isAll ? "bg-accent" : "",
              )}
            >
              <span className="inline-flex items-center gap-2">
                <Check className={cn("h-4 w-4", isAll ? "opacity-100" : "opacity-0")} />
                <Globe className="h-4 w-4 text-muted-foreground" />
                All Locales
              </span>
            </button>

            {state === "loading" && locales.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">Loading locales…</p>
            ) : null}
            {state === "error" ? (
              <p className="p-3 text-sm text-destructive">
                Couldn&apos;t reach global: {error ?? "unknown error"}
              </p>
            ) : null}
            {state === "loaded" && localesByBasin.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No locales found.</p>
            ) : null}

            {localesByBasin.map((entry) => (
              <div key={entry.basinId} className="mt-1">
                <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {entry.basinName}
                </p>

                {entry.locales.map((locale) => (
                  <button
                    key={locale.id}
                    type="button"
                    onClick={() => handleSelectLocale(locale.slug || locale.id)}
                    className={cn(
                      "w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                      selectedLocaleObj?.id === locale.id ? "bg-accent" : "",
                    )}
                  >
                    <span className="inline-flex w-full items-center gap-2">
                      <Check
                        className={cn(
                          "h-4 w-4",
                          selectedLocaleObj?.id === locale.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {locale.image ? (
                        <Image
                          src={locale.image}
                          alt={locale.name}
                          width={20}
                          height={20}
                          className="h-5 w-5 rounded-full object-cover"
                        />
                      ) : null}
                      <span className="flex-1 truncate">{locale.name}</span>
                      {locale.isCommons ? (
                        <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
