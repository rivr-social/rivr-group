// components/top-bar.tsx
"use client"

/**
 * TopBar component for the app-wide top navigation/header.
 * Used in the global shell/header area to expose locale selection, quick actions,
 * and account controls across primary authenticated product pages.
 * Key props:
 * - `selectedLocale`: currently active locale/chapter id for the locale switcher.
 * - `onLocaleChange`: callback to update the selected locale/chapter in app state.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { Bell, Drama, LogIn, MessageSquare, Moon, Plus, Search, Sun, X } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { LocaleSwitcher } from "@/components/locale-switcher" // Renamed
import { UserMenu } from "@/components/user-menu"
import { SearchBar } from "@/components/search-bar"
import { useUser } from "@/contexts/user-context"
import { useSession } from "next-auth/react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getActivePersonaInfo } from "@/app/actions/personas"
import type { SerializedAgent } from "@/lib/graph-serializers"

interface TopBarProps {
  selectedLocale: string
  onLocaleChange: (localeId: string) => void
}

/**
 * Renders the fixed top navigation bar with locale controls and user actions.
 *
 * @param props - Component props.
 * @param props.selectedLocale - Active locale/chapter id shown in `LocaleSwitcher`.
 * @param props.onLocaleChange - Handler invoked when a user selects a new locale/chapter.
 */
export function TopBar({ selectedLocale, onLocaleChange }: TopBarProps) {
  // Local UI state controlling whether the user menu popover is open.
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  // Controls whether the inline search bar dropdown is expanded.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchContainerRef = useRef<HTMLDivElement>(null)

  // Close the search dropdown when clicking outside its container.
  useEffect(() => {
    if (!searchOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [searchOpen])
  const { theme, setTheme } = useTheme()
  // Context-backed user profile data used as an avatar/session fallback.
  const { currentUser } = useUser()
  // Session hook provides auth state; status is checked to avoid flashing the
  // Login button while the session is still being resolved on the client.
  const { data: session, status } = useSession()

  // Active persona tracking for avatar overlay indicator
  const [activePersona, setActivePersona] = useState<SerializedAgent | null>(null)
  const checkPersona = useCallback(async () => {
    try {
      const info = await getActivePersonaInfo()
      setActivePersona(info.active && info.persona ? info.persona : null)
    } catch {
      setActivePersona(null)
    }
  }, [])
  useEffect(() => {
    if (session) checkPersona()
  }, [session, checkPersona])

  // When operating as a persona, show the persona's avatar instead of the user's
  const displayName = activePersona?.name || session?.user?.name || currentUser?.name
  const displayImage = activePersona?.image || session?.user?.image || currentUser?.avatar

  return (
    <header className="fixed top-0 left-0 right-0 z-50 w-full border-b bg-background">
      <div className="flex h-14 items-center px-2 sm:px-4">
        <div className="flex items-center gap-1.5 shrink-0">
          <Link href="/" className="flex items-center gap-1.5">
            <Image src="/rivr-emoji.png" alt="Rivr" width={32} height={32} className="h-8 w-8" />
            <div className="hidden sm:flex flex-col items-center">
              <button
                onClick={(e) => { e.preventDefault(); setTheme(theme === "dark" ? "light" : "dark"); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
              </button>
              <Image src="/wordmark.png" alt="RIVR Wordmark" width={80} height={24} className="h-7 w-auto" />
            </div>
          </Link>
        </div>
        <div className="flex-1 ml-2 sm:ml-4 flex items-center min-w-0">
          <LocaleSwitcher selectedLocale={selectedLocale} onLocaleChange={onLocaleChange} />
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1.5 ml-1 shrink-0">
          <div ref={searchContainerRef} className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:h-9 sm:w-9"
              aria-label={searchOpen ? "Close search" : "Open search"}
              onClick={() => setSearchOpen((prev) => !prev)}
            >
              {searchOpen ? (
                <X className="h-4 w-4 sm:h-5 sm:w-5" />
              ) : (
                <Search className="h-4 w-4 sm:h-5 sm:w-5" />
              )}
            </Button>
            {searchOpen && (
              <div className="absolute right-0 top-full mt-2 w-[min(90vw,360px)] z-50">
                <SearchBar placeholder="Search people, groups, events..." />
              </div>
            )}
          </div>
          {session ? (
            <>
              <Link href="/notifications" className="hidden sm:inline-flex">
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-9 sm:w-9" aria-label="Notifications">
                  <Bell className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </Link>
              <Link href="/messages" className="hidden sm:inline-flex">
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-9 sm:w-9" aria-label="Messages">
                  <MessageSquare className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </Link>
              <Link href="/create">
                <Button size="icon" className="h-8 w-8 sm:h-9 sm:w-9" aria-label="Create">
                  <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setUserMenuOpen(true)}
                className="rounded-full relative"
                aria-label="Open user menu"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src={displayImage || undefined} alt={displayName || "User"} />
                  <AvatarFallback>{displayName?.substring(0, 2).toUpperCase() || 'U'}</AvatarFallback>
                </Avatar>
                {activePersona && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Drama className="h-2.5 w-2.5" />
                  </span>
                )}
              </Button>
              <UserMenu open={userMenuOpen} onClose={() => setUserMenuOpen(false)} />
            </>
          ) : status !== "loading" ? (
            <Link href="/auth/login">
              <Button variant="default" size="sm" className="gap-2">
                <LogIn className="h-4 w-4" />
                Login
              </Button>
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  )
}
