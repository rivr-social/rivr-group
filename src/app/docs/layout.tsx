/**
 * Public /docs shell — the two-tab (Wiki | API) documentation site.
 *
 * Rendering: Server Component nested under the app root layout, so it inherits
 * the global header + theme. Auth: public — `/docs` is listed in
 * `PUBLIC_PAGE_PREFIXES` (src/lib/route-access.ts), so middleware + AuthGuard
 * let anonymous visitors and agents read it. The nested `wiki/` and `api/`
 * layouts add the per-tab sidebar.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { DocsTabs } from "./_components/docs-nav";
import { DOCS_TABS } from "./_content/nav";

export const metadata: Metadata = {
  title: {
    default: "RIVR Docs",
    template: "%s · RIVR Docs",
  },
  description:
    "RIVR platform documentation — a feature/interaction wiki and a developer API reference (REST, MCP tools, and federation protocol).",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-md liquid-glass-shell">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/docs" className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight text-foreground">RIVR</span>
            <span className="text-sm font-medium text-muted-foreground">Docs</span>
          </Link>
          <DocsTabs tabs={DOCS_TABS} />
          <div className="ml-auto text-xs text-muted-foreground">
            <Link href="/" className="hover:text-foreground hover:underline">
              ← Back to app
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>
    </div>
  );
}
