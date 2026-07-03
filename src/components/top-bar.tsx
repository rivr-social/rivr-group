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
import { GLOBAL_BASE_URL, isOnGlobalInstance } from "@/lib/global-base-url"
import { Button } from "@/components/ui/button"
import { LocaleSwitcher } from "@/components/locale-switcher" // Renamed
import { UserMenu } from "@/components/user-menu"
import { SearchBar } from "@/components/search-bar"
import { useUser } from "@/contexts/user-context"
import { useSession } from "next-auth/react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getActivePersonaInfo } from "@/app/actions/personas"
import type { SerializedAgent } from "@/lib/graph-serializers"
import { useRemoteViewer } from "@/contexts/remote-viewer-context"

interface TopBarProps {
  selectedLocale: string
  onLocaleChange: (localeId: string) => void
}

/**
 * Returns whether the current instance is the global app, deferred until
 * after mount. Uses the shared GLOBAL_HOSTNAMES set from global-base-url.ts
 * so there is one canonical list. Returning `null` on the server and first
 * client render keeps SSR output identical to the initial client render,
 * avoiding React #418 hydration mismatches.
 */
function useIsGlobalInstance(): { isGlobal: boolean | null } {
  const [isGlobal, setIsGlobal] = useState<boolean | null>(null);
  useEffect(() => {
    queueMicrotask(() => setIsGlobal(isOnGlobalInstance()));
  }, []);
  return { isGlobal };
}

/**
 * Renders the fixed top navigation bar with locale controls and user actions.
 *
 * @param props - Component props.
 * @param props.selectedLocale - Active locale/chapter id shown in `LocaleSwitcher`.
 * @param props.onLocaleChange - Handler invoked when a user selects a new locale/chapter.
 */
export function TopBar({ selectedLocale, onLocaleChange }: TopBarProps) {
  const { isGlobal: isGlobalInstance } = useIsGlobalInstance();
  // Ticket #109: clicking the top-left logo navigates to GLOBAL on every
  // instance (peer, home, global alike). On the global instance that
  // resolves to `/` relative; otherwise an absolute cross-origin link.
  // During the SSR / pre-mount phase `isGlobalInstance` is `null`; we fall
  // back to the absolute global URL so the server-rendered HTML matches
  // the first client render exactly (fixes React #418 hydration mismatch).
  const globalHomeHref = `${GLOBAL_BASE_URL}/`;
  const logoHref = isGlobalInstance === true ? "/" : globalHomeHref;
  // Local UI state controlling whether the user menu popover is open.
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  // Controls whether the inline search bar dropdown is expanded. This
  // sovereign instance has no local /explore results surface (drift fix #3),
  // so the header search icon opens an inline SearchBar instead of linking
  // to a local explore route.
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
  // next-themes resolves `theme` only on the client; rendering a theme-aware
  // icon on SSR would mismatch the client pass. Track mount state and defer
  // the sun/moon choice to a post-mount render to prevent React #418.
  const [themeMounted, setThemeMounted] = useState(false)
  useEffect(() => { queueMicrotask(() => setThemeMounted(true)) }, [])
  // Context-backed user profile data used as an avatar/session fallback.
  const { currentUser } = useUser()
  // Session hook provides auth state; status is checked to avoid flashing the
  // Login button while the session is still being resolved on the client.
  const { data: session, status } = useSession()
  // Federated SSO visitors carry a remote-viewer cookie instead of a local
  // session; treat them as authenticated for header affordances.
  const { isAuthenticated: remoteAuthenticated } = useRemoteViewer()

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
    queueMicrotask(() => { if (session) checkPersona() })
  }, [session, checkPersona])

  // When operating as a persona, show the persona's avatar instead of the user's
  const displayName = activePersona?.name || session?.user?.name || currentUser?.name
  const displayImage = activePersona?.image || session?.user?.image || currentUser?.avatar
  const authenticated = Boolean(session || remoteAuthenticated)

  return (
    <header className="liquid-glass liquid-glass-shell fixed top-0 left-0 right-0 z-[100] w-full border-b border-white/10">
      <div className="liquid-glass-effect-shell" />
      <div className="liquid-glass-tint" />
      <div className="liquid-glass-shine" />
      <div className="flex h-14 items-center px-2 sm:px-4">
        <div className="flex items-center gap-1.5 shrink-0">
          {/*
            Logo always links to GLOBAL home. On the global instance this
            stays same-origin (`/`) so next/link-style nav still works;
            on peer/home/sovereign instances it is an absolute
            cross-origin link, so we use a plain <a>.
          */}
          <a
            href={logoHref}
            className="relative flex items-center"
            aria-label="RIVR — go to global home"
          >
            {/*
              R mark acts as the top-left logo. The theme toggle is absolutely
              positioned as a yellow-gold sun/moon glyph that sits above the
              tail of the R — matching the sun/moon sparkle on the canonical
              mark artwork.
            */}
            {/*
              `unoptimized`: the brand mark is a fixed 48px chrome asset whose
              2750×2750 source PNGs make sharp's WebP/AVIF encoder hang on the
              `/_next/image` path (every real browser negotiates WebP/AVIF), so
              the optimized request never returns and the logo renders blank.
              Serving the raw PNG sidesteps the optimizer entirely; a logo gains
              nothing from on-the-fly optimization.
            */}
            {/* Light-mode logo (hidden in dark mode) */}
            <Image
              src="/rivr-logo-light.png"
              alt="RIVR"
              width={48}
              height={48}
              className="h-12 w-12 block dark:hidden"
              priority
              unoptimized
            />
            {/* Dark-mode logo (hidden in light mode) */}
            <Image
              src="/rivr-logo-dark.png"
              alt="RIVR"
              width={48}
              height={48}
              className="h-12 w-12 hidden dark:block"
              priority
              unoptimized
            />
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTheme(theme === "dark" ? "light" : "dark"); }}
              className="absolute -top-0.5 -right-1 text-amber-400 hover:text-amber-300 transition-colors"
              aria-label="Toggle theme"
              suppressHydrationWarning
            >
              {themeMounted
                ? theme === "dark"
                  ? <Sun className="h-3.5 w-3.5" />
                  : <Moon className="h-3.5 w-3.5" />
                : <span className="inline-block h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          </a>
        </div>
        <div className="flex-1 ml-2 sm:ml-4 flex items-center min-w-0">
          {/*
            While `isGlobalInstance` is `null` (SSR + first client render)
            we render an empty slot. The decision branches in after the
            mount effect resolves the real hostname. Rendering identical
            output on the server and on the first client pass is what
            prevents React #418 hydration mismatches.

            The locale switcher renders on BOTH global and sovereign
            instances. Its locale list is always projected from global's
            registry (useGlobalLocales), and selecting a locale routes via
            globalLocaleHref: on global it stays same-origin and filters the
            local home feed; on a sovereign group/locale/person host it
            navigates to `${GLOBAL_BASE_URL}/?locale=<slug>` — i.e. the global
            instance with that locale filtered in the main feed. (This
            replaces the old "Browse Rivr" link on sovereign instances.)
          */}
          {isGlobalInstance === null ? null : (
            <LocaleSwitcher selectedLocale={selectedLocale} onLocaleChange={onLocaleChange} />
          )}
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1.5 ml-1 shrink-0">
          {/* No local /explore results surface on this sovereign instance
              (drift fix #3) — the search icon toggles an inline SearchBar
              dropdown that searches local entities instead. */}
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
          {authenticated ? (
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
