"use client"

/**
 * GlobalHeader component that conditionally renders the shared top header.
 * Used in the app shell to hide header chrome on auth routes and wire locale
 * selection from `TopBar` into global app context.
 * Key props:
 * - None (route and app state are read from hooks/context).
 */

import { TopBar } from "@/components/top-bar"
import { usePathname } from "next/navigation"
import { useAppContext } from "@/contexts/app-context"

/**
 * Renders the top header for non-auth routes and connects locale changes to app context.
 *
 * @param _props - Unused props object (this component currently accepts no props).
 */
export function GlobalHeader() {
  // Route hook drives conditional header visibility.
  const pathname = usePathname()
  // App context provides the selected chapter and setter used by TopBar locale changes.
  const { state, setSelectedChapter } = useAppContext()

  // Conditional rendering flag: hide global header for auth pages.
  const showHeader = !pathname?.startsWith("/auth")

  // Event handler passed to TopBar; updates global selected chapter/locale state.
  const handleLocaleChange = (localeId: string) => {
    setSelectedChapter(localeId)
  }

  // Conditional branch prevents rendering header UI on excluded routes.
  if (!showHeader) {
    return null
  }

  // Forward current chapter and locale-change handler into the top-bar feature component.
  return <TopBar selectedLocale={state.selectedChapter} onLocaleChange={handleLocaleChange} />
}
