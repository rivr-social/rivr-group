import { getResource } from "@/lib/queries/resources"
import { redirectIfSovereignResource } from "@/lib/federation/sovereign-resource-redirect"
import { ReceiptDetailClient } from "./receipt-detail-client"

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string; receiptId: string }>
}) {
  const { id, receiptId } = await params
  // UM source-routing: a mirror's receipt belongs to the source instance, where
  // the authoritative purchase and settlement were recorded — never the mirror.
  const resource = await getResource(id).catch(() => null)
  await redirectIfSovereignResource(id, {
    metadata: resource?.metadata as Record<string, unknown> | null,
    subPath: `/receipt/${receiptId}`,
  })
  return <ReceiptDetailClient params={Promise.resolve({ id, receiptId })} />
}
