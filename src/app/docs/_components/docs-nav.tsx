"use client";

/**
 * Client navigation chrome for the /docs site: the top Wiki|API tab bar and the
 * per-tab sidebar. Both derive their active state from `usePathname`, so the
 * current section/page is highlighted as the user moves around.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { NavLink, NavSection } from "../_content/nav";

/** Top-level Wiki | API tab switcher. */
export function DocsTabs({ tabs }: { tabs: NavLink[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="flex items-center gap-1" aria-label="Documentation sections">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Per-tab left sidebar rendered from a section manifest. */
export function DocsSidebar({ sections, ariaLabel }: { sections: NavSection[]; ariaLabel: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label={ariaLabel}
      className="w-full shrink-0 md:w-60 md:border-r md:border-border/60 md:pr-4"
    >
      <div className="space-y-5 md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto md:pb-8">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>
            <ul className="space-y-0.5">
              {section.links.map((link) => {
                const active = pathname === link.href;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className={cn(
                        "block rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
