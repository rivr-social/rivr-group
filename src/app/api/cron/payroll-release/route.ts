/**
 * POST /api/cron/payroll-release — the payday runner.
 *
 * Releases job payouts that admins have ATTESTED but whose paying org runs a
 * non-manual payout schedule (receipts parked `scheduled` by
 * `attestJobPayoutAction`). For each parked receipt, the paying org's schedule
 * is checked against today (`isReleaseDue`) and due receipts settle through
 * the SAME release core the attest path uses (`releaseJobPayoutReceipt`) —
 * amounts are the payroll-withheld NET when stamps exist.
 *
 * Auth + shape mirror /api/cron/tax-tasks (the operationally-proven external
 * money-cron pattern): POST only, NODE_ADMIN_KEY (env or
 * /run/secrets/rivr_federation_admin_key), bounded batch per invocation.
 * Externally driven — deliberately NOT registered in cron-scheduler.ts.
 */
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import {
  findScheduledJobPayoutReceipts,
  releaseJobPayoutReceipt,
  type JobPayoutReleaseEntry,
} from '@/lib/job-payout-release';
import {
  getPayoutScheduleConfig,
  isReleaseDue,
} from '@/lib/payroll-withholding-config';
import { STATUS_INTERNAL_ERROR, STATUS_UNAUTHORIZED } from '@/lib/http-status';

export const dynamic = 'force-dynamic';

/** Max receipts attempted per run — keeps one invocation inside its time budget. */
const RELEASE_BATCH_LIMIT = 50;

function getConfiguredAdminKey(): string | null {
  const envKey = process.env.NODE_ADMIN_KEY?.trim();
  if (envKey) return envKey;
  try {
    const secretKey = readFileSync('/run/secrets/rivr_federation_admin_key', 'utf8').trim();
    return secretKey || null;
  } catch {
    return null;
  }
}

function isAuthorized(request: Request): boolean {
  const configuredKey = getConfiguredAdminKey();
  if (!configuredKey) return false;

  const authHeader = request.headers.get('authorization');
  const headerKey = request.headers.get('x-node-admin-key');
  const bearerKey =
    authHeader && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice('bearer '.length).trim()
      : null;

  return headerKey === configuredKey || bearerKey === configuredKey;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: STATUS_UNAUTHORIZED });
  }

  try {
    const now = new Date();
    const parked = await findScheduledJobPayoutReceipts(RELEASE_BATCH_LIMIT);

    // One schedule read per org, not per receipt.
    const dueByOrg = new Map<string, boolean>();
    const released: JobPayoutReleaseEntry[] = [];
    let skippedNotDue = 0;

    for (const row of parked) {
      const meta = row.metadata ?? {};
      const orgId = typeof meta.payerGroupId === 'string' ? meta.payerGroupId : null;
      if (!orgId) {
        skippedNotDue += 1;
        continue;
      }
      let due = dueByOrg.get(orgId);
      if (due === undefined) {
        due = isReleaseDue(await getPayoutScheduleConfig(orgId), now);
        dueByOrg.set(orgId, due);
      }
      if (!due) {
        skippedNotDue += 1;
        continue;
      }

      const attestedBy =
        typeof meta.payoutScheduledBy === 'string' ? meta.payoutScheduledBy : 'schedule';
      const entry = await releaseJobPayoutReceipt(row, { attestedBy, via: 'schedule' });
      if (entry) released.push(entry);
    }

    const paid = released.filter((e) => e.status === 'paid').length;
    const failed = released.filter((e) => e.status === 'error').length;
    if (failed > 0) {
      console.error(`[payroll-release] ${failed} scheduled payout(s) errored this run`);
    }

    return NextResponse.json({
      scanned: parked.length,
      released: released.length,
      paid,
      failed,
      skippedNotDue,
    });
  } catch (error) {
    console.error('[payroll-release] run failed:', error);
    return NextResponse.json(
      { error: 'Payroll release run failed.' },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
