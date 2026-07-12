/**
 * Local recorder for a crypto sale that has ALREADY settled on-chain.
 *
 * The RivrSplitter transfer is atomic and irreversible — seller + platform
 * fee land in one transaction. The RIVR-side receipt/ledger row is a LOCAL
 * artifact of that settlement, written on the instance that owns the listing,
 * exactly like the Stripe webhook writes receipts locally for federated
 * buyers. It must NOT route through the federation-forwarding facade
 * (`updateFacade.execute`), which tries to forward a federated buyer's write
 * to their home instance and fails in a server/relayer context with no
 * viewer token — the sale happened HERE, so the record belongs HERE.
 *
 * Because settlement is already final, this recorder is best-effort by
 * contract: the caller treats a throw as "recorded=false, money still moved",
 * never as a failed purchase.
 */
import { db } from '@/db';
import { resources } from '@/db/schema';
import { getOrCreateWallet, recordEthPayment } from '@/lib/wallet';
import { randomUUID } from 'crypto';

export interface CryptoPurchaseRecordInput {
  buyerAgentId: string;
  sellerAgentId: string;
  amountCents: number;
  txHash: string;
  listingId: string;
  description: string;
  platformFeeTxHash?: string;
}

/**
 * Writes the audit ledger row + buyer receipt for an on-chain crypto purchase.
 * Local-only writes (no federation facade). Returns the receipt id.
 */
export async function recordLocalCryptoPurchase(
  input: CryptoPurchaseRecordInput,
): Promise<{ receiptId: string }> {
  const buyerWallet = await getOrCreateWallet(input.buyerAgentId, 'personal');
  const sellerWallet = await getOrCreateWallet(input.sellerAgentId, 'personal');

  await recordEthPayment(
    buyerWallet.id,
    sellerWallet.id,
    input.amountCents,
    input.txHash,
    input.description,
  );

  const receiptId = randomUUID();
  await db.insert(resources).values({
    id: receiptId,
    name: `Receipt: ${input.listingId}`,
    type: 'receipt',
    ownerId: input.buyerAgentId,
    description: `Purchase receipt for listing ${input.listingId}`,
    metadata: {
      originalListingId: input.listingId,
      buyerAgentId: input.buyerAgentId,
      sellerAgentId: input.sellerAgentId,
      amount: input.amountCents,
      priceCents: input.amountCents,
      totalCents: input.amountCents,
      currency: 'crypto',
      txHash: input.txHash,
      platformFeeTxHash: input.platformFeeTxHash ?? null,
      purchasedAt: new Date().toISOString(),
      status: 'completed',
      paymentMethod: 'crypto',
    },
  });

  return { receiptId };
}
