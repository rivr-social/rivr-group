/**
 * Marketplace purchase page — thin server component wrapper.
 *
 * Resolves the dynamic `params` Promise server-side, then passes
 * the plain `{ id }` string to the client component. This avoids
 * React 19 `use()` + Suspense hook-ordering issues (#310).
 */

import { PurchasePageClient } from "./purchase-client"
import { getResource } from "@/lib/queries/resources"
import { redirectIfSovereignResource } from "@/lib/federation/sovereign-resource-redirect"

export default async function MarketplaceItemPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // UM source-routing: checkout for a federated MIRROR listing must run on the
  // source instance, so the authoritative price/inventory/fee config and Stripe
  // settlement live where the listing is sovereign-homed — never the mirror.
  const resource = await getResource(id).catch(() => null)
  await redirectIfSovereignResource(id, {
    metadata: resource?.metadata as Record<string, unknown> | null,
    subPath: "/purchase",
  })
  return <PurchasePageClient id={id} />
}
