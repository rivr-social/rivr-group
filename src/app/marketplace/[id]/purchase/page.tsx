/**
 * Marketplace purchase page — thin server component wrapper.
 *
 * Resolves the dynamic `params` Promise server-side, then passes
 * the plain `{ id }` string to the client component. This avoids
 * React 19 `use()` + Suspense hook-ordering issues (#310).
 */

import { PurchasePageClient } from "./purchase-client"

export default async function MarketplaceItemPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <PurchasePageClient id={id} />
}
