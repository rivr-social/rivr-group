"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

interface AgentPageShellProps {
  /** Optional back-link target. When omitted, no back link is rendered. */
  backHref?: string
  /** Optional back-link label. Required (with `backHref`) to render the link. */
  backLabel?: string
  header: React.ReactNode
  children: React.ReactNode
  structuredDataJson?: string | null
  maxWidthClassName?: string
}

export function AgentPageShell({
  backHref,
  backLabel,
  header,
  children,
  structuredDataJson,
  maxWidthClassName = "max-w-5xl",
}: AgentPageShellProps) {
  return (
    <div className={`container ${maxWidthClassName} mx-auto space-y-4 px-4 py-6`}>
      {structuredDataJson ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: structuredDataJson }}
        />
      ) : null}
      {backHref && backLabel ? (
        <Link href={backHref} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Link>
      ) : null}
      {header}
      {children}
    </div>
  )
}
