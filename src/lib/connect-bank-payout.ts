import { eq } from "drizzle-orm";

import { db } from "@/db";
import { walletTransactions } from "@/db/schema";
import { createPayout, getConnectBalance } from "@/lib/stripe-connect";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Speed = "standard" | "instant";
interface Input { requestId: string; walletId: string; ownerId: string; connectAccountId: string; amountCents: number; speed: Speed }
interface Metadata { payoutRequestId?: string; stripePayoutId?: string; connectAccountId?: string; speed?: string; ownerId?: string; error?: string }

async function findRequest(id: string) {
  const [row] = await db.select({
    id: walletTransactions.id,
    fromWalletId: walletTransactions.fromWalletId,
    amountCents: walletTransactions.amountCents,
    metadata: walletTransactions.metadata,
  }).from(walletTransactions).where(eq(walletTransactions.id, id)).limit(1);
  return row;
}

function assertMatches(input: Input, row: NonNullable<Awaited<ReturnType<typeof findRequest>>>): Metadata {
  const metadata = (row.metadata ?? {}) as Metadata;
  if (row.fromWalletId !== input.walletId || row.amountCents !== input.amountCents ||
      metadata.connectAccountId !== input.connectAccountId || metadata.ownerId !== input.ownerId ||
      metadata.speed !== input.speed) {
    throw new Error("Payout request ID was already used for a different payout.");
  }
  return metadata;
}

export async function executeConnectBankPayout(input: Input): Promise<{ payoutId: string; replayed: boolean }> {
  if (!UUID_RE.test(input.requestId)) throw new Error("A valid payout request ID is required.");
  const existing = await findRequest(input.requestId);
  if (existing) {
    const metadata = assertMatches(input, existing);
    if (metadata.stripePayoutId) return { payoutId: metadata.stripePayoutId, replayed: true };
  } else {
    const balance = await getConnectBalance(input.connectAccountId);
    if (balance.availableCents < input.amountCents) throw new Error("Insufficient available balance for payout.");
    await db.insert(walletTransactions).values({
      id: input.requestId, type: "connect_payout", fromWalletId: input.walletId,
      amountCents: input.amountCents, feeCents: 0, currency: "usd",
      description: `Payout to bank (${input.speed})`, status: "submitting",
      referenceType: "payout_request", referenceId: input.requestId,
      metadata: { payoutRequestId: input.requestId, connectAccountId: input.connectAccountId, speed: input.speed, ownerId: input.ownerId },
    }).onConflictDoNothing();
  }
  const request = await findRequest(input.requestId);
  if (!request) throw new Error("Unable to persist payout request.");
  const metadata = assertMatches(input, request);
  if (metadata.stripePayoutId) return { payoutId: metadata.stripePayoutId, replayed: true };
  try {
    const payout = await createPayout(input.connectAccountId, input.amountCents, input.speed, {
      idempotencyKey: `connect-bank-payout:${input.requestId}`,
      metadata: { payoutRequestId: input.requestId, ownerId: input.ownerId, walletId: input.walletId },
    });
    await db.update(walletTransactions).set({ status: "pending", metadata: { ...metadata, stripePayoutId: payout.id, error: undefined } })
      .where(eq(walletTransactions.id, input.requestId));
    return { payoutId: payout.id, replayed: false };
  } catch (error) {
    await db.update(walletTransactions).set({ status: "failed", metadata: { ...metadata, error: error instanceof Error ? error.message : String(error) } })
      .where(eq(walletTransactions.id, input.requestId));
    throw error;
  }
}
