/**
 * Job-payout release core — the ONE settle+stamp path a job-payout receipt
 * takes to the bank, shared by the two callers so they cannot drift:
 *
 *   - `attestJobPayoutAction` (org schedule = manual): admin attest releases
 *     immediately — today's behavior.
 *   - `/api/cron/payroll-release` (org schedule = daily/weekly/monthly):
 *     attest STAMPS receipts `scheduled`; this cron releases the batch on the
 *     org's payday.
 *
 * The transfer amount is ALWAYS `bankLegAmountCents` — the payroll-withheld
 * NET when the internal leg diverted a reserve, else the receipt amount —
 * so the bank transfer and the member's internal balance agree.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { resources } from '@/db/schema';
import {
  settleConnectPayout,
  type ConnectPayoutStatus,
} from '@/lib/connect-payout';
import { bankLegAmountCents } from '@/lib/payroll-withholding';

/** Receipt status while a payout waits for the org's scheduled release day. */
export const CONNECT_PAYOUT_SCHEDULED: ConnectPayoutStatus = 'scheduled';

export interface JobPayoutReceiptRow {
  id: string;
  owner_id: string;
  metadata: Record<string, unknown>;
}

export interface JobPayoutReleaseEntry {
  receiptId: string;
  payeeAgentId: string;
  amountCents: number;
  status: ConnectPayoutStatus;
  transferId?: string;
  detail?: string;
}

/**
 * Settle one job-payout receipt's real-money leg and record the verdict on the
 * receipt. Idempotent: the Stripe transfer is idempotency-keyed on the receipt
 * id, and already-`paid` receipts should be filtered by the caller.
 */
export async function releaseJobPayoutReceipt(
  row: JobPayoutReceiptRow,
  opts: {
    /** The admin whose attestation authorized this release. */
    attestedBy: string;
    /** 'attest' = direct admin release; 'schedule' = payday cron release. */
    via: 'attest' | 'schedule';
  },
): Promise<JobPayoutReleaseEntry | null> {
  const meta = row.metadata ?? {};
  const amountCents = bankLegAmountCents(meta);
  if (amountCents <= 0) return null;

  const jobId = typeof meta.jobId === 'string' ? meta.jobId : '';
  const result = await settleConnectPayout({
    payeeAgentId: row.owner_id,
    amountCents,
    idempotencyKey: row.id,
    metadata: {
      ...(jobId ? { jobId } : {}),
      ...(typeof meta.projectId === 'string' ? { projectId: meta.projectId } : {}),
      ...(typeof meta.payerGroupId === 'string' ? { payerGroupId: meta.payerGroupId } : {}),
      attestedBy: opts.attestedBy,
      releasedVia: opts.via,
    },
  });

  await db
    .update(resources)
    .set({
      metadata: sql`${resources.metadata} || ${JSON.stringify({
        connectPayoutStatus: result.status,
        ...(result.transferId ? { stripeTransferId: result.transferId } : {}),
        ...(result.connectAccountId ? { payeeConnectAccountId: result.connectAccountId } : {}),
        ...(result.detail ? { connectPayoutDetail: result.detail } : {}),
        ...(result.status === 'paid'
          ? {
              paymentMethod: 'stripe_connect',
              payoutAttestedBy: opts.attestedBy,
              payoutAttestedAt: new Date().toISOString(),
              payoutReleasedVia: opts.via,
            }
          : {}),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, row.id));

  return {
    receiptId: row.id,
    payeeAgentId: row.owner_id,
    amountCents,
    status: result.status,
    transferId: result.transferId,
    detail: result.detail,
  };
}

/** Every receipt currently parked `scheduled`, fleet-wide (the cron's worklist). */
export async function findScheduledJobPayoutReceipts(
  limit: number,
): Promise<JobPayoutReceiptRow[]> {
  const rows = (await db.execute(sql`
    SELECT id, owner_id, metadata
    FROM resources
    WHERE type = 'receipt'
      AND deleted_at IS NULL
      AND metadata->>'receiptKind' = 'job-payout'
      AND metadata->>'connectPayoutStatus' = ${CONNECT_PAYOUT_SCHEDULED}
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `)) as unknown as JobPayoutReceiptRow[];
  return rows;
}
