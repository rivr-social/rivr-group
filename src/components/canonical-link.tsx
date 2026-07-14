"use client";

/**
 * CanonicalLink — renders an entity link that may be local OR cross-origin.
 *
 * Entity hrefs are resolved to their canonical HOME by the graph adapters
 * (see `resolveEntityHref` in `@/lib/federation/entity-link`): a locally-homed
 * entity gets a local path (`/groups/<id>`, `/profile/<u>`), a remote-homed
 * federated projection gets an absolute URL on its sovereign home instance.
 *
 * A cross-origin href MUST NOT use the Next.js `<Link>` component — its
 * client-side RSC prefetch against another origin is the CSP-flash class this
 * routing fix exists to eliminate. So:
 *
 *   - absolute `http(s)://…` href → plain `<a target="_blank" rel="noopener">`
 *   - local path                 → Next.js `<Link>` (prefetch OK, same origin)
 *
 * Drop-in for the many `<Link href={\`/groups/\${id}\`}>` / `getGlobalUrl(...)`
 * call sites in list surfaces.
 */

import Link from "next/link";
import { forwardRef } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

interface CanonicalLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Resolved entity href — local path or absolute canonical-home URL. */
  href: string;
  children: ReactNode;
}

/** True when the href points at a different origin (absolute http/https URL). */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Minimal router surface — just the `push` used for local navigation. */
interface PushRouter {
  push: (href: string) => void;
}

/**
 * Imperatively navigate to an entity href. Cross-origin canonical-home URLs use
 * a full browser navigation (`window.location.assign`) — Next's client router
 * cannot route to another origin; local paths use `router.push`.
 */
export function navigateToHref(router: PushRouter, href: string): void {
  if (isExternalHref(href)) {
    if (typeof window !== "undefined") {
      window.location.assign(href);
    }
    return;
  }
  router.push(href);
}

/**
 * `forwardRef` so this works as the single child of `<Button asChild>` (Radix
 * Slot forwards a ref) exactly like the `next/link` it replaces.
 */
export const CanonicalLink = forwardRef<HTMLAnchorElement, CanonicalLinkProps>(
  function CanonicalLink({ href, children, ...rest }, ref) {
    if (isExternalHref(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" ref={ref} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <Link href={href} ref={ref} {...rest}>
        {children}
      </Link>
    );
  },
);
