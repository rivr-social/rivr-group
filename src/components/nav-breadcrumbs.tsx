"use client";

/**
 * NavBreadcrumbs — the single reusable hierarchical breadcrumb for nested
 * surfaces (group → subgroup → project → job).
 *
 * Deliberately NOT a bare slash-separated path (Cameron, 2026-07-14): small,
 * muted, chevron-separated crumbs in the shadcn/Tailwind idiom, with per-label
 * truncation on narrow screens and a collapsing ellipsis (dropdown) when the
 * containment chain gets deep. Consumers pass a ROOT-FIRST node list whose LAST
 * entry is the current page (no href).
 *
 * Pure chain math (build + collapse) lives in `@/lib/breadcrumbs` so it stays
 * unit-tested; this file only renders it.
 */

import { Fragment } from "react";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  collapseBreadcrumbs,
  DEFAULT_MAX_VISIBLE,
  type BreadcrumbNode,
} from "@/lib/breadcrumbs";

export interface NavBreadcrumbsProps {
  /** Root-first breadcrumb nodes; the LAST entry is the current page. */
  items: BreadcrumbNode[];
  /** Max crumbs before the middle collapses to an ellipsis dropdown. */
  maxVisible?: number;
  /** Extra classes for the <nav> wrapper. */
  className?: string;
}

/** Truncation shared by links + the current page label (mobile-friendly). */
const LABEL_CLASS = "inline-block max-w-[7.5rem] truncate align-bottom sm:max-w-[14rem]";

/**
 * Renders a compact, chevron-separated breadcrumb. Returns `null` when there is
 * nothing meaningful to show (0 or 1 node — a top-level page needs no trail).
 */
export function NavBreadcrumbs({ items, maxVisible = DEFAULT_MAX_VISIBLE, className }: NavBreadcrumbsProps) {
  if (items.length < 2) return null;

  const slots = collapseBreadcrumbs(items, maxVisible);

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {slots.map((slot, index) => {
          const isLast = index === slots.length - 1;
          const separator = !isLast ? <BreadcrumbSeparator /> : null;

          if (slot.kind === "ellipsis") {
            return (
              <Fragment key={`ellipsis-${index}`}>
                <BreadcrumbItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="flex items-center rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Show hidden breadcrumbs"
                    >
                      <BreadcrumbEllipsis className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {slot.nodes.map((node) => (
                        <DropdownMenuItem key={node.id ?? node.label} asChild>
                          {node.href ? (
                            <Link href={node.href}>{node.label}</Link>
                          ) : (
                            <span>{node.label}</span>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
                {separator}
              </Fragment>
            );
          }

          const { node } = slot;
          return (
            <Fragment key={node.id ?? `${node.label}-${index}`}>
              <BreadcrumbItem>
                {isLast || !node.href ? (
                  <BreadcrumbPage className={LABEL_CLASS} title={node.label}>
                    {node.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={node.href} className={LABEL_CLASS} title={node.label}>
                      {node.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {separator}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
