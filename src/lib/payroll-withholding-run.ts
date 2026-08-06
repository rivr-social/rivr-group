/**
 * Payroll-withholding execution — the gated post-credit divert. Twin of
 * `applyPatronageRetention` (lib/patronage-run.ts): the member is credited
 * their GROSS job pay by the existing rail, then (only when the paying org has
 * withholding enabled) the withheld share moves from the member's settlement
 * wallet into the ORG's `payroll_withholding` reserve wallet — same sorted
 * FOR-UPDATE locks, cleared-only capital consume, typed audit row.
 *
 * Disabled path: early-returns withheld=0 and moves NO money — an org with
 * withholding off sees byte-identical behavior.
 *
 * The caller (payAssignee, job-completion.ts) stamps the receipt with the
 * returned split; the bank leg then pays the stamped NET
 * (lib/payroll-withholding.ts `bankLegAmountCents`), so the member's internal
 * balance and their eventual bank transfer agree by construction.
 */
import { db } from "@/db";
import { wallets, walletTransactions } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  getSettlementWalletForAgent,
  getOrCreateWallet,
  consumeWalletCapital,
} from "@/lib/wallet";
import { getPayrollWithholdingConfig } from "@/lib/payroll-withholding-config";
import {
  computePayrollWithholding,
  type PayrollWithholdingSplit,
} from "@/lib/payroll-withholding";

export type PayrollWithholdingOutcome = {
  applied: boolean;
  split: PayrollWithholdingSplit;
};

/**
 * Apply the paying org's withholding to a member's just-credited job pay.
 * Moves the withheld share from the member's settlement wallet into the ORG's
 * `payroll_withholding` reserve. Idempotency is the caller's responsibility
 * (call once per payout, keyed by the receipt).
 */
export async function applyPayrollWithholding(input: {
  orgAgentId: string;
  memberAgentId: string;
  grossCents: number;
  /** Audit linkage: the job + receipt this withholding belongs to. */
  jobId: string;
  receiptId: string;
}): Promise<PayrollWithholdingOutcome> {
  const passThrough: PayrollWithholdingSplit = {
    grossCents: input.grossCents,
    withheldCents: 0,
    netCents: input.grossCents,
    effectiveRateBps: 0,
  };
  if (!Number.isInteger(input.grossCents) || input.grossCents <= 0) {
    return { applied: false, split: passThrough };
  }

  const config = await getPayrollWithholdingConfig(input.orgAgentId);
  if (!config.enabled || config.rateBps <= 0) {
    return { applied: false, split: passThrough };
  }

  const split = computePayrollWithholding(input.grossCents, config.rateBps);
  if (split.withheldCents <= 0) {
    return { applied: false, split: passThrough };
  }

  const settlement = await getSettlementWalletForAgent(input.memberAgentId);
  const reserve = await getOrCreateWallet(input.orgAgentId, "payroll_withholding");

  await db.transaction(async (tx) => {
    const [firstId, secondId] = [settlement.id, reserve.id].sort();
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${firstId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${secondId} FOR UPDATE`);

    const [src] = await tx.select().from(wallets).where(eq(wallets.id, settlement.id)).limit(1);
    if (!src || src.balanceCents < split.withheldCents) {
      throw new Error("Insufficient cleared balance to withhold payroll reserve.");
    }

    await consumeWalletCapital(tx, settlement.id, src.balanceCents, split.withheldCents, {
      clearedOnly: true,
    });
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} - ${split.withheldCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, settlement.id));
    await tx
      .update(wallets)
      .set({
        balanceCents: sql`${wallets.balanceCents} + ${split.withheldCents}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, reserve.id));

    await tx.insert(walletTransactions).values({
      type: "payroll_withholding",
      fromWalletId: settlement.id,
      toWalletId: reserve.id,
      amountCents: split.withheldCents,
      description: "Payroll withholding reserved by paying organization",
      referenceType: "payroll_withholding",
      referenceId: input.receiptId,
      status: "completed",
      metadata: {
        orgAgentId: input.orgAgentId,
        memberAgentId: input.memberAgentId,
        jobId: input.jobId,
        receiptId: input.receiptId,
        grossCents: split.grossCents,
        rateBps: split.effectiveRateBps,
        netCents: split.netCents,
      },
    });
  });

  return { applied: true, split };
}

/** The org's current payroll-withholding reserve balance (Treasury-tab readout). */
export async function getPayrollWithholdingReserveCents(orgAgentId: string): Promise<number> {
  const [row] = await db
    .select({ balanceCents: wallets.balanceCents })
    .from(wallets)
    .where(and(eq(wallets.ownerId, orgAgentId), eq(wallets.type, "payroll_withholding")))
    .limit(1);
  return row?.balanceCents ?? 0;
}
