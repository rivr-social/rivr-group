"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

interface AgentPageShellProps {
  backHref: string
  backLabel: string
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
      <Link href={backHref} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>
      {header}
      {children}
    </div>
  )
}
