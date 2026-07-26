import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { capitalEntries, wallets, walletTransactions } from '@/db/schema';
import { withTestTransaction } from '@/test/db';
import { createTestAgent, createTestWallet } from '@/test/fixtures';

vi.mock('@/db', async () => {
  const { getTestDbModule } = await import('@/test/db');
  return getTestDbModule();
});

import {
  clawbackChargeback,
  clawbackRefund,
  reverseChargebackClawback,
} from '@/lib/chargeback';

async function seedCredit(
  testDb: Parameters<Parameters<typeof withTestTransaction>[0]>[0],
  walletId: string,
  amountCents: number,
  paymentIntentId: string,
  type: 'marketplace_payout' | 'service_fee' = 'marketplace_payout',
) {
  await testDb
    .update(wallets)
    .set({ balanceCents: amountCents })
    .where(eq(wallets.id, walletId));
  const [credit] = await testDb
    .insert(walletTransactions)
    .values({
      type,
      toWalletId: walletId,
      amountCents,
      feeCents: 0,
      currency: 'usd',
      status: 'completed',
      metadata: { paymentIntentId },
    })
    .returning({ id: walletTransactions.id });
  await testDb.insert(capitalEntries).values({
    walletId,
    sourceTransactionId: credit.id,
    amountCents,
    remainingCents: amountCents,
    settlementStatus: 'pending',
    sourceType: 'test_settlement',
    metadata: { paymentIntentId },
  });
}

describe('Group refund and dispute recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverses every split credit once for a tax-inclusive full refund', () =>
    withTestTransaction(async (testDb) => {
      const seller = await createTestAgent(testDb);
      const org = await createTestAgent(testDb);
      const platform = await createTestAgent(testDb);
      const sellerWallet = await createTestWallet(testDb, seller.id);
      const orgWallet = await createTestWallet(testDb, org.id);
      const platformWallet = await createTestWallet(testDb, platform.id);

      await seedCredit(testDb, sellerWallet.id, 600, 'pi_refund');
      await seedCredit(testDb, orgWallet.id, 200, 'pi_refund');
      await seedCredit(testDb, platformWallet.id, 200, 'pi_refund', 'service_fee');

      const first = await clawbackRefund({
        eventId: 'evt_refund_1',
        paymentIntentId: 'pi_refund',
        chargeAmountCents: 1100,
        totalRefundedCents: 1100,
      });
      expect(first.recovered).toBe(true);

      const balancesAfter = await testDb
        .select({ id: wallets.id, balanceCents: wallets.balanceCents })
        .from(wallets);
      const relevantBalances = balancesAfter
        .filter((row) =>
          [sellerWallet.id, orgWallet.id, platformWallet.id].includes(row.id),
        )
        .reduce((sum, row) => sum + row.balanceCents, 0);
      expect(relevantBalances).toBe(-62);

      const remaining = await testDb
        .select()
        .from(capitalEntries);
      expect(
        remaining
          .filter((entry) =>
            [sellerWallet.id, orgWallet.id, platformWallet.id].includes(entry.walletId),
          )
          .every((entry) => entry.remainingCents === 0),
      ).toBe(true);

      const duplicate = await clawbackRefund({
        eventId: 'evt_refund_1',
        paymentIntentId: 'pi_refund',
        chargeAmountCents: 1100,
        totalRefundedCents: 1100,
      });
      expect(duplicate).toEqual({ recovered: false, reason: 'already-processed' });
    }));

  it('reverses and reinstates every dispute allocation idempotently', () =>
    withTestTransaction(async (testDb) => {
      const seller = await createTestAgent(testDb);
      const platform = await createTestAgent(testDb);
      const sellerWallet = await createTestWallet(testDb, seller.id);
      const platformWallet = await createTestWallet(testDb, platform.id);
      await seedCredit(testDb, sellerWallet.id, 700, 'pi_dispute');
      await seedCredit(testDb, platformWallet.id, 300, 'pi_dispute', 'service_fee');

      const recovered = await clawbackChargeback({
        eventId: 'evt_dispute_1',
        paymentIntentId: 'pi_dispute',
        disputeId: 'dp_1',
        chargeAmountCents: 1000,
        disputeAmountCents: 1000,
      });
      expect(recovered).toEqual({ recovered: true, debitedCents: 2500 });

      const reversed = await reverseChargebackClawback({
        eventId: 'evt_dispute_reinstated_1',
        paymentIntentId: 'pi_dispute',
        disputeId: 'dp_1',
      });
      expect(reversed).toEqual({ reversed: true });

      const [sellerAfter] = await testDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, sellerWallet.id));
      const [platformAfter] = await testDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, platformWallet.id));
      expect(sellerAfter.balanceCents).toBe(700);
      expect(platformAfter.balanceCents).toBe(300);

      const duplicate = await reverseChargebackClawback({
        eventId: 'evt_dispute_reinstated_1',
        paymentIntentId: 'pi_dispute',
        disputeId: 'dp_1',
      });
      expect(duplicate).toEqual({ reversed: false, reason: 'already-processed' });
    }));
});
