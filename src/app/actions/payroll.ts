"use server";

/**
 * Payroll-withholding + payout-schedule org settings actions (ported from
 * global 2026-08-05, group admin idiom: hasGroupWriteAccess). An org admin
 * sets the withholding rate diverted into the org's reserve at member payout,
 * and the cadence on which attested payouts release. Ships dormant
 * (withholding off, cadence manual).
 */
import { auth } from "@/auth";
import {
  getPayrollWithholdingConfig,
  setPayrollWithholdingConfig,
  getPayoutScheduleConfig,
  setPayoutScheduleConfig,
  type PayrollWithholdingConfig,
  type PayoutScheduleConfig,
} from "@/lib/payroll-withholding-config";
import { getPayrollWithholdingReserveCents } from "@/lib/payroll-withholding-run";
import { hasGroupWriteAccess } from "@/app/actions/create-resources";

type Result<T> = { success: true; config: T } | { success: false; message: string };

async function authorizedAdmin(orgAgentId: string): Promise<string | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const authorized = userId === orgAgentId || (await hasGroupWriteAccess(userId, orgAgentId));
  return authorized ? userId : null;
}

/** Read an org's payroll settings + reserve balance (admin-gated). */
export async function getPayrollSettingsAction(orgAgentId: string): Promise<
  | {
      success: true;
      withholding: PayrollWithholdingConfig;
      schedule: PayoutScheduleConfig;
      reserveCents: number;
    }
  | { success: false; message: string }
> {
  if (!(await authorizedAdmin(orgAgentId))) {
    return { success: false, message: "Admins only." };
  }
  const [withholding, schedule, reserveCents] = await Promise.all([
    getPayrollWithholdingConfig(orgAgentId),
    getPayoutScheduleConfig(orgAgentId),
    getPayrollWithholdingReserveCents(orgAgentId),
  ]);
  return { success: true, withholding, schedule, reserveCents };
}

/** Set an org's payroll-withholding config (admin-gated; clamped to ≤50%). */
export async function setPayrollWithholdingConfigAction(
  orgAgentId: string,
  next: PayrollWithholdingConfig,
): Promise<Result<PayrollWithholdingConfig>> {
  if (!(await authorizedAdmin(orgAgentId))) {
    return { success: false, message: "Admins only." };
  }
  try {
    return { success: true, config: await setPayrollWithholdingConfig(orgAgentId, next) };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Could not save." };
  }
}

/** Set an org's payout schedule (admin-gated; normalized). */
export async function setPayoutScheduleConfigAction(
  orgAgentId: string,
  next: PayoutScheduleConfig,
): Promise<Result<PayoutScheduleConfig>> {
  if (!(await authorizedAdmin(orgAgentId))) {
    return { success: false, message: "Admins only." };
  }
  try {
    return { success: true, config: await setPayoutScheduleConfig(orgAgentId, next) };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Could not save." };
  }
}
