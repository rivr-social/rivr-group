/**
 * Shared job pay-label formatting (2026-07-14).
 *
 * Every surface that shows a job — the project-page job cards, the group
 * Jobs-board cards, the job detail admin panel — must describe its
 * compensation the same way: "Fixed $X", "Hourly $X/hr", "N points", or
 * "Volunteer (Thanks)". This is the single source of that mapping so the label
 * never drifts between surfaces.
 */

/** The pay/points inputs read off a job's metadata. */
export interface JobPayFields {
  payKind?: string | null;
  payAmountCents?: number | null;
  hourlyRateCents?: number | null;
  /** Job-level point pool (task-less jobs). */
  points?: number | null;
  /** Precomputed total points (e.g. summed task points). */
  totalPoints?: number | null;
}

/** Visual tone bucket for the badge (cash vs points vs volunteer). */
export type JobPayTone = "cash" | "points" | "volunteer";

export interface JobPayLabel {
  label: string;
  tone: JobPayTone;
}

/** Formats integer cents as a plain dollar string, dropping a whole-dollar `.00`. */
export function formatCentsShort(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2)}`;
}

/**
 * Resolves a job's compensation into a display label + tone. Fixed/hourly cash
 * take precedence when a positive amount is set; volunteer is explicit; every
 * other job is points (using the job pool or precomputed total when present).
 */
export function describeJobPay(fields: JobPayFields): JobPayLabel {
  const kind = fields.payKind;
  const payAmountCents =
    typeof fields.payAmountCents === "number" && fields.payAmountCents > 0 ? fields.payAmountCents : null;
  const hourlyRateCents =
    typeof fields.hourlyRateCents === "number" && fields.hourlyRateCents > 0 ? fields.hourlyRateCents : null;

  if (kind === "fixed" && payAmountCents !== null) {
    return { label: `Fixed ${formatCentsShort(payAmountCents)}`, tone: "cash" };
  }
  if (kind === "hourly" && hourlyRateCents !== null) {
    return { label: `Hourly ${formatCentsShort(hourlyRateCents)}/hr`, tone: "cash" };
  }
  if (kind === "volunteer") {
    return { label: "Volunteer (Thanks)", tone: "volunteer" };
  }

  const points =
    typeof fields.points === "number" && fields.points > 0
      ? fields.points
      : typeof fields.totalPoints === "number" && fields.totalPoints > 0
        ? fields.totalPoints
        : 0;
  return { label: points > 0 ? `${points} points` : "Points", tone: "points" };
}

/** Tailwind classes for a pay badge by tone (works in light + dark). */
export const JOB_PAY_TONE_CLASS: Record<JobPayTone, string> = {
  cash: "bg-green-100 text-green-800 border-green-200",
  points: "bg-yellow-100 text-yellow-800 border-yellow-200",
  volunteer: "bg-purple-100 text-purple-800 border-purple-200",
};
