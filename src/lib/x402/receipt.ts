/**
 * x402 receipt persistence.
 *
 * Purpose:
 * - Record a settled x402 payment as a first-class RIVR receipt and answer the
 *   two questions the gated endpoint needs:
 *     1. "Has this exact onchain settlement already unlocked something?"
 *        (replay protection — keyed on the settlement transaction hash)
 *     2. "Has this principal already paid for this resource?"
 *        (re-grant access without re-charging)
 *
 * Why a dedicated store (not wallet.ts):
 * - x402 settles a single transfer to one payTo with no fee-split / capital
 *   accounting. It is an access proof, not a treasury movement. Mixing it into
 *   wallet_transactions would imply RIVR custody it never has here.
 *
 * Dependencies:
 * - `@/db` (Drizzle) and the `x402_receipts` table.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { x402Receipts, type X402ReceiptRecord } from "@/db/schema";

/** Input for persisting a settled payment. */
export interface RecordX402ReceiptInput {
  resourceId: string;
  /** Local actor id when the payer authenticated; null for anonymous peer payers. */
  payerAgentId: string | null;
  payerAddress: string | null;
  /** Onchain settlement transaction hash — the replay-protection key. */
  settlementTx: string;
  network: string;
  asset: string;
  amountCents: number;
  payTo: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persists a settled x402 payment idempotently.
 *
 * The unique index on `settlement_tx` makes this safe under concurrent or
 * replayed calls: a second insert for the same settlement is dropped
 * (`onConflictDoNothing`) and the original receipt is returned, so the same
 * onchain transfer can never unlock twice.
 *
 * @param input The settled payment details.
 * @returns The persisted (or pre-existing) receipt record.
 */
export async function recordX402Receipt(
  input: RecordX402ReceiptInput,
): Promise<X402ReceiptRecord> {
  const [inserted] = await db
    .insert(x402Receipts)
    .values({
      resourceId: input.resourceId,
      payerAgentId: input.payerAgentId,
      payerAddress: input.payerAddress,
      settlementTx: input.settlementTx,
      network: input.network,
      asset: input.asset,
      amountCents: input.amountCents,
      payTo: input.payTo,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({ target: x402Receipts.settlementTx })
    .returning();

  if (inserted) return inserted;

  // Conflict path: the settlement was already recorded — return the original.
  const [existing] = await db
    .select()
    .from(x402Receipts)
    .where(eq(x402Receipts.settlementTx, input.settlementTx))
    .limit(1);
  return existing;
}

/**
 * Finds an existing paid receipt for a principal + resource pair, used to
 * re-grant access on later requests without charging again.
 *
 * @param resourceId The gated resource.
 * @param payerAgentId The authenticated principal id.
 * @returns The most recent matching receipt, or null when none exists.
 */
export async function findX402ReceiptForPrincipal(
  resourceId: string,
  payerAgentId: string,
): Promise<X402ReceiptRecord | null> {
  const [receipt] = await db
    .select()
    .from(x402Receipts)
    .where(
      and(
        eq(x402Receipts.resourceId, resourceId),
        eq(x402Receipts.payerAgentId, payerAgentId),
      ),
    )
    .orderBy(desc(x402Receipts.createdAt))
    .limit(1);
  return receipt ?? null;
}
