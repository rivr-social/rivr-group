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
import { getSession } from "@/lib/auth/get-session"
import { resolveLocalActorId } from "@/lib/federation/resolution"
import { cryptoNetwork, splitterCheckoutEnabled } from "@/lib/crypto-splitter"

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
  // Server-computed viewer: the client's NextAuth useSession() cannot see a
  // federated remote-viewer cookie, so a logged-in federated member was shown
  // the "Sign in to complete your purchase" modal (toybox verification,
  // 2026-07-11). The unified session is resolved HERE and passed down —
  // identity still never comes from the client.
  const session = await getSession()
  const serverViewerId = session?.user?.id
    ? session.user.authMethod === "federated"
      ? await resolveLocalActorId(session.user.id)
      : session.user.id
    : null
  // Crypto checkout network selection is SERVER policy (per-instance env),
  // threaded down as props — the fleet is on test rails (Base Sepolia) until
  // real-money cutover, mirroring the Stripe test-keys posture. ONE resolver
  // (`cryptoNetwork`) decides it for both the client checkout and the
  // server-side splitter rail, and it fails safe to the testnet when
  // CRYPTO_NETWORK is unset — never re-derive the network inline here.
  const network = cryptoNetwork()
  const cryptoPlatformWallet = process.env.CRYPTO_PLATFORM_WALLET || null
  return (
    <PurchasePageClient
      id={id}
      serverViewerId={serverViewerId}
      cryptoNetwork={network}
      cryptoPlatformWallet={cryptoPlatformWallet}
      cryptoOneSignature={splitterCheckoutEnabled()}
    />
  )
}
