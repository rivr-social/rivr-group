"use client";

/**
 * Reusable media gallery (grid + lightbox) for profiles and group pages.
 *
 * Design notes:
 * - Source-agnostic: consumers pass a pre-built `GalleryItem[]` (see
 *   `@/lib/gallery`). The same component serves BOTH user profiles and groups.
 * - Lightweight: the lightbox is a self-contained, portal-based overlay with
 *   keyboard navigation (no heavy third-party lightbox dependency, per the
 *   "heavy client bundle" constraint). The overlay markup is only mounted when
 *   an item is actually opened, so the closed gallery costs just the grid.
 * - Images use `next/image` with `unoptimized` to match the rest of the app's
 *   handling of user-uploaded/remote media.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { GalleryItem } from "@/lib/gallery";

/** Index value meaning "no item open". */
const CLOSED_INDEX = -1;

/**
 * Grid presentation:
 * - `"cards"` (default): captioned cards, 2–4 columns with gaps (the original
 *   profile/press gallery look).
 * - `"grid"`: Instagram-style — dense, gapless, square, caption-less tiles
 *   (3–5 columns). Same lightbox, just a tighter thumbnail wall for an
 *   "explore/photos" surface.
 */
export type MediaGalleryLayout = "cards" | "grid";

export interface MediaGalleryProps {
  /** Pre-built, ordered, de-duplicated gallery items. */
  items: GalleryItem[];
  /** Message shown when there are no items. */
  emptyMessage?: string;
  /** Thumbnail presentation. Defaults to `"cards"`. */
  layout?: MediaGalleryLayout;
}

/**
 * Renders a responsive media grid. Clicking an item opens a lightbox overlay
 * with previous/next navigation (mouse + keyboard).
 */
export function MediaGallery({ items, emptyMessage = "No media yet.", layout = "cards" }: MediaGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number>(CLOSED_INDEX);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const isOpen = openIndex >= 0 && openIndex < items.length;

  const close = useCallback(() => setOpenIndex(CLOSED_INDEX), []);
  const showPrev = useCallback(
    () => setOpenIndex((current) => (current <= 0 ? items.length - 1 : current - 1)),
    [items.length]
  );
  const showNext = useCallback(
    () => setOpenIndex((current) => (current >= items.length - 1 ? 0 : current + 1)),
    [items.length]
  );

  // Keyboard navigation + body scroll lock while the lightbox is open.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        showPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        showNext();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, close, showPrev, showNext]);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const active = isOpen ? items[openIndex] : null;

  // Shared lightbox overlay — identical for both layouts, only mounted when an
  // item is open.
  const lightbox =
    active && typeof document !== "undefined"
      ? createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={active.label}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
            onClick={close}
          >
            <button
              ref={closeButtonRef}
              type="button"
              className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              onClick={(event) => {
                event.stopPropagation();
                close();
              }}
              aria-label="Close gallery"
            >
              <X className="h-5 w-5" />
            </button>

            {items.length > 1 && (
              <button
                type="button"
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                onClick={(event) => {
                  event.stopPropagation();
                  showPrev();
                }}
                aria-label="Previous"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}

            <div
              className="flex max-h-full max-w-5xl flex-col items-center"
              onClick={(event) => event.stopPropagation()}
            >
              {active.kind === "video" ? (
                <video
                  src={active.src}
                  className="max-h-[80vh] max-w-full rounded-lg"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <Image
                  src={active.src}
                  alt={active.label}
                  width={1280}
                  height={960}
                  className="max-h-[80vh] w-auto rounded-lg object-contain"
                  unoptimized
                />
              )}
              <p className="mt-3 max-w-full truncate text-sm text-white/80">{active.label}</p>
              {items.length > 1 && (
                <p className="mt-1 text-xs text-white/50">
                  {openIndex + 1} / {items.length}
                </p>
              )}
            </div>

            {items.length > 1 && (
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                onClick={(event) => {
                  event.stopPropagation();
                  showNext();
                }}
                aria-label="Next"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>,
          document.body
        )
      : null;

  // Instagram-style wall: gapless square tiles, no card chrome or captions.
  if (layout === "grid") {
    return (
      <>
        <div className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 md:grid-cols-5">
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className="relative block aspect-square w-full overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              onClick={() => setOpenIndex(index)}
              aria-label={`Open ${item.label}`}
            >
              {item.kind === "video" ? (
                <>
                  <video
                    src={item.src}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <Play className="h-7 w-7 text-white" />
                  </span>
                </>
              ) : (
                <Image
                  src={item.src}
                  alt={item.label}
                  width={320}
                  height={320}
                  className="h-full w-full object-cover transition-opacity hover:opacity-90"
                  unoptimized
                  loading="lazy"
                />
              )}
            </button>
          ))}
        </div>
        {lightbox}
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {items.map((item, index) => (
          <Card key={item.key} className="overflow-hidden">
            <button
              type="button"
              className="relative block h-40 w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setOpenIndex(index)}
              aria-label={`Open ${item.label}`}
            >
              {item.kind === "video" ? (
                <>
                  <video
                    src={item.src}
                    className="h-40 w-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <Play className="h-8 w-8 text-white" />
                  </span>
                </>
              ) : (
                <Image
                  src={item.src}
                  alt={item.label}
                  width={420}
                  height={260}
                  className="h-40 w-full object-cover"
                  unoptimized
                  loading="lazy"
                />
              )}
            </button>
            <CardContent className="py-2">
              <p className="truncate text-xs text-muted-foreground">{item.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {lightbox}
    </>
  );
}
