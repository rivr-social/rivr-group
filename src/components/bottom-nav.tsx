"use client"

/**
 * BottomNav component for primary mobile-friendly app navigation.
 * Used in the persistent bottom navigation area across core app pages.
 * Key props:
 * - None (route state is derived from Next.js navigation hooks).
 */

import { Home, Map, PlusSquare, Search, User } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

/**
 * Renders fixed bottom navigation links with active-route highlighting.
 *
 * @param _props - Unused props object (this component currently accepts no props).
 */
export function BottomNav() {
  // Reads the current route pathname to compute active nav state.
  const pathname = usePathname()

  // Navigation model with per-item active conditions derived from the current route.
  const navItems = [
    { name: "Home", href: "/", icon: Home, active: pathname === "/" },
    { name: "Explore", href: "/explore", icon: Search, active: pathname === "/explore" },
    { name: "Create", href: "/create", icon: PlusSquare, active: pathname.startsWith("/create") },
    { name: "Map", href: "/map", icon: Map, active: pathname === "/map" },
    { name: "Profile", href: "/profile", icon: User, active: pathname.startsWith("/profile") },
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t">
      <div className="flex justify-around items-center h-16">
        {/* Conditional class application highlights whichever route is currently active. */}
        {navItems.map((item) => (
          <Link
            key={item.name}
            href={item.href}
            className={cn(
              "flex flex-col items-center justify-center w-full h-full text-xs transition-colors",
              item.active ? "text-primary font-medium" : "text-muted-foreground hover:text-primary",
            )}
          >
            <item.icon className="h-6 w-6 mb-1" />
            <span className="sr-only">{item.name}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
