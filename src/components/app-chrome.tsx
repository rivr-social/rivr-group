"use client";

/**
 * AppChrome — the persistent mobile navigation chrome (bottom nav + command
 * palette launcher + palette), rendered ONCE in the root layout so it appears
 * on EVERY page, not just the `(main)` route group (C18, 2026-07-14).
 *
 * Previously this lived in `app/(main)/layout.tsx`, so sovereign surfaces
 * OUTSIDE that group — `/groups/[id]` (subgroups), `/jobs/[id]`, `/events`,
 * `/badges`, `/marketplace`, `/settings`, … — had no bottom nav, leaving no way
 * back to the containing instance home from a subgroup page. Hoisting it to the
 * root keeps coverage consistent.
 *
 * It hides itself on full-screen auth surfaces (`/login`, `/auth`) where the
 * app nav is out of context.
 */

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Slash } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { CommandBar } from "@/components/CommandBar";

/** Route prefixes that render full-screen without the app nav chrome. */
const CHROME_HIDDEN_PREFIXES = ["/login", "/auth"];

export function AppChrome() {
  const pathname = usePathname();
  const [commandBarOpen, setCommandBarOpen] = useState(false);

  const hidden = CHROME_HIDDEN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (hidden) return null;

  return (
    <>
      <div className="fixed bottom-20 left-0 right-0 z-40 flex justify-center pointer-events-none">
        <button
          onClick={() => setCommandBarOpen(true)}
          className="liquid-glass pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-transparent text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Open command palette"
        >
          <div className="liquid-glass-effect rounded-full" />
          <div className="liquid-glass-tint rounded-full" />
          <div className="liquid-glass-shine rounded-full" />
          <Slash className="h-4 w-4" />
        </button>
      </div>
      <CommandBar open={commandBarOpen} onOpenChange={setCommandBarOpen} />
      <BottomNav />
    </>
  );
}
