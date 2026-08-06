/**
 * Org payroll-withholding + payout-schedule configuration — stored on the org
 * agent's metadata, the established home for per-org money knobs
 * (`patronageRetention`, `taxReserve`, `netBps`). Merge-writes only; both
 * default OFF so every org ships byte-identical to today.
 *
 * Both keys are REDACTED from public agent views (lib/agent-public-view.ts).
 */
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  clampPayrollWithholdingBps,
  normalizePayoutSchedule,
  type PayoutScheduleConfig,
} from "@/lib/payroll-withholding";

export type PayrollWithholdingConfig = {
  enabled: boolean;
  /** Withholding rate in bps, clamped to [0, 5000] (0–50%). */
  rateBps: number;
};

export const DEFAULT_PAYROLL_WITHHOLDING_CONFIG: PayrollWithholdingConfig = {
  enabled: false,
  rateBps: 0,
};

// Pure schedule types/helpers live in lib/payroll-withholding.ts; re-exported
// here so config consumers have one import site.
export {
  DEFAULT_PAYOUT_SCHEDULE_CONFIG,
  isReleaseDue,
  normalizePayoutSchedule,
  type PayoutCadence,
  type PayoutScheduleConfig,
} from "@/lib/payroll-withholding";

async function readOrgMetadata(orgAgentId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, orgAgentId))
    .limit(1);
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

/** Read an org's payroll-withholding config (defaults to disabled/0%). */
export async function getPayrollWithholdingConfig(
  orgAgentId: string,
): Promise<PayrollWithholdingConfig> {
  const meta = await readOrgMetadata(orgAgentId);
  const cfg = (meta.payrollWithholding ?? {}) as Record<string, unknown>;
  return {
    enabled: cfg.enabled === true,
    rateBps: typeof cfg.rateBps === "number" ? clampPayrollWithholdingBps(cfg.rateBps) : 0,
  };
}

/** Persist an org's payroll-withholding config (merge, non-destructive). */
export async function setPayrollWithholdingConfig(
  orgAgentId: string,
  next: PayrollWithholdingConfig,
): Promise<PayrollWithholdingConfig> {
  const meta = await readOrgMetadata(orgAgentId);
  if (Object.keys(meta).length === 0) {
    const [exists] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, orgAgentId))
      .limit(1);
    if (!exists) throw new Error(`Org agent not found: ${orgAgentId}`);
  }
  const normalized: PayrollWithholdingConfig = {
    enabled: next.enabled === true,
    rateBps: clampPayrollWithholdingBps(next.rateBps),
  };
  await db
    .update(agents)
    .set({ metadata: { ...meta, payrollWithholding: normalized } })
    .where(eq(agents.id, orgAgentId));
  return normalized;
}

/** Read an org's payout schedule (defaults to manual — attest releases immediately). */
export async function getPayoutScheduleConfig(orgAgentId: string): Promise<PayoutScheduleConfig> {
  const meta = await readOrgMetadata(orgAgentId);
  return normalizePayoutSchedule(meta.payoutSchedule);
}

/** Persist an org's payout schedule (merge, non-destructive). */
export async function setPayoutScheduleConfig(
  orgAgentId: string,
  next: PayoutScheduleConfig,
): Promise<PayoutScheduleConfig> {
  const meta = await readOrgMetadata(orgAgentId);
  const normalized = normalizePayoutSchedule(next);
  await db
    .update(agents)
    .set({ metadata: { ...meta, payoutSchedule: normalized } })
    .where(eq(agents.id, orgAgentId));
  return normalized;
}

