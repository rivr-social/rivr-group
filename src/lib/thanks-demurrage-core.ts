const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MIN_TOKEN_AGE_WEEKS = 1;
const BASE_WEEKLY_BURN_RATE = 0.0175;
const AGE_CURVE_MULTIPLIER = 0.04;
const AGE_CURVE_EXPONENT = 1.2;
const DEMURRAGE_CYCLE_MS = MS_PER_WEEK;

export interface ThanksTokenDemurrageSnapshot {
  id: string;
  ownerId: string;
  enteredAccountAt: Date | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface ThanksTokenDemurrageSummary {
  ownerId: string;
  cycleKey: string;
  tokenCount: number;
  eligibleTokenCount: number;
  totalContribution: number;
  remainderBefore: number;
  remainderAfter: number;
  burnCount: number;
  burnedTokenIds: string[];
}

function getDemurrageCycleStart(now: Date): Date {
  const cycleIndex = Math.floor(now.getTime() / DEMURRAGE_CYCLE_MS);
  return new Date(cycleIndex * DEMURRAGE_CYCLE_MS);
}

export function getThanksDemurrageCycleKey(now: Date): string {
  return getDemurrageCycleStart(now).toISOString();
}

export function toTokenEntryDate(
  token: Pick<ThanksTokenDemurrageSnapshot, "enteredAccountAt" | "createdAt">,
): Date {
  return token.enteredAccountAt ?? token.createdAt;
}

export function calculateThanksTokenAgeWeeks(
  enteredAccountAt: Date,
  now: Date = new Date(),
): number {
  return Math.max(0, (now.getTime() - enteredAccountAt.getTime()) / MS_PER_WEEK);
}

export function calculateThanksTokenWeeklyContribution(ageWeeks: number): number {
  if (!Number.isFinite(ageWeeks) || ageWeeks < MIN_TOKEN_AGE_WEEKS) {
    return 0;
  }

  return (
    BASE_WEEKLY_BURN_RATE *
    (1 + AGE_CURVE_MULTIPLIER * Math.pow(ageWeeks - 1, AGE_CURVE_EXPONENT))
  );
}

export function summarizeThanksTokenDemurrage(
  ownerId: string,
  tokens: ThanksTokenDemurrageSnapshot[],
  hiddenBurnRemainder: number,
  now: Date = new Date(),
): ThanksTokenDemurrageSummary {
  const orderedTokens = [...tokens].sort((a, b) => {
    const enteredDiff =
      toTokenEntryDate(a).getTime() - toTokenEntryDate(b).getTime();
    if (enteredDiff !== 0) return enteredDiff;
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });

  let eligibleTokenCount = 0;
  let totalContribution = 0;

  for (const token of orderedTokens) {
    const contribution = calculateThanksTokenWeeklyContribution(
      calculateThanksTokenAgeWeeks(toTokenEntryDate(token), now),
    );
    if (contribution > 0) {
      eligibleTokenCount += 1;
      totalContribution += contribution;
    }
  }

  const remainderBefore = Number.isFinite(hiddenBurnRemainder) ? hiddenBurnRemainder : 0;
  const totalWithRemainder = remainderBefore + totalContribution;
  const burnCount = Math.min(orderedTokens.length, Math.floor(totalWithRemainder));
  const remainderAfter = totalWithRemainder - burnCount;
  const burnedTokenIds = orderedTokens.slice(0, burnCount).map((token) => token.id);

  return {
    ownerId,
    cycleKey: getThanksDemurrageCycleKey(now),
    tokenCount: orderedTokens.length,
    eligibleTokenCount,
    totalContribution,
    remainderBefore,
    remainderAfter,
    burnCount,
    burnedTokenIds,
  };
}
