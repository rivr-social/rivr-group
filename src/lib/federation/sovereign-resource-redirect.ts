/**
 * Universal Manifest source-routing guard for federated resource pages.
 *
 * When a resource (e.g. a marketplace listing) is a local MIRROR of a resource
 * that is sovereign-homed on another instance, the buyer-facing flow for that
 * resource — its detail page and, critically, its checkout pages — must run on
 * the SOURCE instance (the manifest's `canonicalUrl`), never the local mirror.
 * This keeps the authoritative price, inventory, fee config, and settlement on
 * the instance that actually owns the resource.
 *
 * `redirectIfSovereignResource` resolves the active manifest pointer for a
 * resource id and, if its canonical host differs from this instance, performs a
 * Next.js `redirect()` to the canonical URL (optionally with a sub-path such as
 * `/purchase` or `/confirmed`). For locally-homed resources it is a no-op, so it
 * is safe to call unconditionally at the top of any resource-scoped page.
 */
import { redirect } from "next/navigation";
import {
  getResourceReferenceKey,
  resolveActiveResourcePointer,
} from "@/lib/federation/manifest-references";
import { getInstanceConfig } from "@/lib/federation/instance-config";

function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

/**
 * Redirects to the resource's sovereign source instance when it is a federated
 * mirror, preserving an optional sub-path on the canonical URL.
 *
 * @param resourceId - The local resource id from the route params.
 * @param options.metadata - Resource metadata (carries `externalEntityId` for
 *   federated mirrors); pass it when available so the manifest key resolves.
 * @param options.subPath - Sub-path appended to the canonical URL, e.g.
 *   `"/purchase"` or `"/confirmed"`. Joined with exactly one slash.
 */
export async function redirectIfSovereignResource(
  resourceId: string,
  options?: {
    metadata?: Record<string, unknown> | null;
    subPath?: string;
  },
): Promise<void> {
  const pointer = await resolveActiveResourcePointer(
    getResourceReferenceKey(resourceId, options?.metadata),
  ).catch(() => null);
  if (!pointer) return;

  const localHost = hostOf(getInstanceConfig().baseUrl);
  const canonicalHost = hostOf(pointer.canonicalUrl);
  if (!canonicalHost || canonicalHost === localHost) return;

  const target = options?.subPath
    ? `${pointer.canonicalUrl.replace(/\/+$/, "")}/${options.subPath.replace(/^\/+/, "")}`
    : pointer.canonicalUrl;
  redirect(target);
}
