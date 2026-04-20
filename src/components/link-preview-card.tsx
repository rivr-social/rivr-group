"use client"

/**
 * LinkPreviewCard — renders a rich OpenGraph-style card for a URL attached
 * to a post, comment, or other content surface.
 *
 * Purpose:
 * - Visually unfurl external links with title, description, image, site, and
 *   favicon, matching the "preview" pattern users expect from other apps.
 * - Render internal RIVR links with a distinct, RIVR-native style so they
 *   don't look like generic outbound links.
 *
 * Key props:
 * - `preview`: the `ResourceEmbed` (from `@/db/schema`) to render. Minimum
 *   required field is `url`; every other field is best-effort.
 * - `compact`: optional flag — collapses to a single-line row (used in some
 *   dense list contexts).
 *
 * Dependencies:
 * - `next/image` for optimized thumbnails.
 * - `@/components/ui/card` for consistent surface styling.
 * - `lucide-react` for the external-link indicator.
 */

import type { ReactElement } from "react"
import Image from "next/image"
import Link from "next/link"
import { ExternalLink, Link2 } from "lucide-react"
import type { ResourceEmbed } from "@/db/schema"

/** Maximum description length before truncation — matches common OG viewer behavior. */
const DESCRIPTION_MAX_CHARS = 160

/** Truncate a description to the configured character cap with an ellipsis. */
function truncate(input: string | undefined | null, max: number = DESCRIPTION_MAX_CHARS): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/** Extract a human-friendly host label (strips leading `www.`) for display. */
function hostLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.replace(/^www\./, "")
  } catch {
    return url
  }
}

export interface LinkPreviewCardProps {
  preview: ResourceEmbed
  /** Dense single-row variant. Defaults to false (full card). */
  compact?: boolean
  /** Hook for the parent to clear a preview attached in the composer. */
  onRemove?: () => void
}

/**
 * Renders a single link preview card.
 *
 * Two visual variants:
 * - `kind === 'internal'`: RIVR-native badge (no "external" chrome, branded
 *   site label). Used for `/rings/`, `/groups/`, `/profile/`, etc.
 * - all other kinds: generic OG card with thumbnail, title, description, host.
 *
 * The card is clickable — whole surface links to `preview.url`. External
 * links open in a new tab with `rel="noopener noreferrer"`. Internal links
 * stay in the current tab and use Next's `<Link>` for client navigation.
 */
export function LinkPreviewCard({ preview, compact = false, onRemove }: LinkPreviewCardProps): ReactElement {
  const isInternal = preview.kind === "internal"
  const title = preview.ogTitle?.trim() || hostLabel(preview.url)
  const description = truncate(preview.ogDescription)
  const site = preview.siteName || (isInternal ? "RIVR" : hostLabel(preview.url))
  const image = preview.ogImage
  const favicon = preview.favicon

  // Wrap the card body so both internal and external variants share structure.
  const content = (
    <div
      className={
        isInternal
          ? "flex items-stretch gap-3 overflow-hidden rounded-lg border border-primary/30 bg-primary/5 transition-colors hover:border-primary/60"
          : "flex items-stretch gap-3 overflow-hidden rounded-lg border border-border bg-muted/40 transition-colors hover:border-primary/40 hover:bg-muted/60"
      }
    >
      {image ? (
        <div
          className={
            compact
              ? "relative h-16 w-16 shrink-0 overflow-hidden bg-muted"
              : "relative h-32 w-32 shrink-0 overflow-hidden bg-muted sm:h-36 sm:w-36"
          }
        >
          <Image
            src={image}
            alt=""
            fill
            sizes="(max-width: 640px) 128px, 144px"
            className="object-cover"
            // Unoptimized: OG image URLs are arbitrary third-party hosts; we
            // don't want to force them through next/image's optimizer by
            // default. Keeping them direct also prevents build-time domain
            // allowlist friction.
            unoptimized
          />
        </div>
      ) : (
        <div
          className={
            compact
              ? "flex h-16 w-16 shrink-0 items-center justify-center bg-muted text-muted-foreground"
              : "flex h-32 w-32 shrink-0 items-center justify-center bg-muted text-muted-foreground sm:h-36 sm:w-36"
          }
          aria-hidden="true"
        >
          <Link2 className="h-6 w-6" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {favicon ? (
            // Favicons are tiny; a plain img tag keeps bundle size down and
            // avoids next/image config for one-off external hosts.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={favicon} alt="" width={14} height={14} className="h-3.5 w-3.5 rounded-sm" />
          ) : null}
          <span className="truncate">{site}</span>
          {!isInternal ? <ExternalLink className="ml-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> : null}
        </div>
        <div className="truncate text-sm font-semibold leading-snug">{title}</div>
        {description && !compact ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove()
          }}
          className="self-start p-2 text-muted-foreground hover:text-foreground"
          aria-label="Remove link preview"
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  )

  if (isInternal) {
    return (
      <Link href={preview.url} className="block" prefetch={false}>
        {content}
      </Link>
    )
  }
  return (
    <a href={preview.url} target="_blank" rel="noopener noreferrer" className="block">
      {content}
    </a>
  )
}
