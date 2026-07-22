/**
 * Server-side resolver for referral fee/split recipients on a marketplace sale.
 *
 * Purpose:
 * Given the seller, the listing, and an optional referrer captured from the
 * share link (`?ref=<agentId>&refType=group|locale`), resolve the set of
 * activation-gated referral fee recipients — group, locale, and global — whose
 * bps are grossed into the buyer total and paid out at settlement.
 *
 * This is the authoritative source for the bps/amount of each split. The
 * referrer id/type may originate from the client URL, but every bps here is
 * read from server-side agent metadata or env config and is never client-
 * trusted. The route layer is responsible only for validating that a claimed
 * referrer is a real agent of the claimed type before calling in.
 *
 * Config sources (see docs/active/referral-fee-split-spec-2026-06-15.md):
 * - group:  group agent `metadata.referralCommissionBps` (> 0), and the sale
 *           was referred via that group's link (`refType === 'group'`).
 * - locale: locale agent `metadata.feeActivated === true` AND
 *           `metadata.referralCommissionBps > 0`.
 * - global: env `GLOBAL_REFERRAL_FEE_BPS` (> 0); recipient is the platform
 *           treasury (sentinel id `GLOBAL_REFERRAL_RECIPIENT_ID`).
 */
import { db } from '@/db';
import { agents, ledger } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  MAX_REFERRAL_SPLIT_BPS,
  GLOBAL_REFERRAL_RECIPIENT_ID,
} from '@/lib/wallet-constants';
import type { ReferralSplitInput } from '@/lib/checkout-fees';

export type ReferrerType = 'group' | 'locale';

export interface ResolveReferralSplitsParams {
  /** Seller agent id — used to drop self-referral and resolve a fallback locale. */
  sellerId: string;
  /** Listing metadata — may carry an explicit `localeId` scope. */
  listingMeta: Record<string, unknown>;
  /** Buyer agent id, when known — used to drop self-referral. */
  buyerId?: string | null;
  /** Validated referrer agent id from the share link, when present. */
  referrerId?: string | null;
  /** Validated referrer type from the share link, when present. */
  referrerType?: ReferrerType | null;
}

/** Reads a non-negative integer bps from an agent metadata bag, else 0. */
function readReferralBps(metadata: Record<string, unknown> | null | undefined): number {
  const raw = (metadata ?? {})['referralCommissionBps'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : 0;
}

/** A locale agent is an organization carrying a place-type of chapter/locale. */
function isLocaleAgent(metadata: Record<string, unknown> | null | undefined): boolean {
  const placeType = (metadata ?? {})['placeType'];
  return placeType === 'chapter' || placeType === 'locale';
}

/** Reads the global referral fee bps from env, clamped to >= 0. */
function readGlobalReferralBps(): number {
  const raw = Number.parseInt(process.env.GLOBAL_REFERRAL_FEE_BPS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Resolves the active locale id for a sale: an explicit locale referrer wins,
 * then the listing's `localeId`, then the seller's active `belong` locale.
 */
async function resolveLocaleId(
  params: ResolveReferralSplitsParams,
): Promise<string | null> {
  if (params.referrerType === 'locale' && params.referrerId) {
    return params.referrerId;
  }
  const listingLocaleId = params.listingMeta['localeId'];
  if (typeof listingLocaleId === 'string' && listingLocaleId.length > 0) {
    return listingLocaleId;
  }
  // Fall back to the seller's active `belong` edge into a place-type agent.
  const belongEdges = await db
    .select({ objectId: ledger.objectId, metadata: agents.metadata })
    .from(ledger)
    .innerJoin(agents, eq(ledger.objectId, agents.id))
    .where(
      and(
        eq(ledger.subjectId, params.sellerId),
        eq(ledger.verb, 'belong'),
        eq(ledger.isActive, true),
      ),
    );
  for (const edge of belongEdges) {
    if (edge.objectId && isLocaleAgent(edge.metadata as Record<string, unknown>)) {
      return edge.objectId;
    }
  }
  return null;
}

/**
 * Resolves the ordered list of activation-gated referral splits for a sale.
 *
 * Returns `ReferralSplitInput[]` (recipientId, recipientType, bps). Each entry
 * is deduped by recipientId, self-referral (recipient === seller or buyer) is
 * dropped, and the SUM of all bps is clamped to `MAX_REFERRAL_SPLIT_BPS` by
 * proportionally trimming the lowest-priority recipients (global, then locale,
 * then group) so the highest-trust recipient is preserved.
 */
export async function resolveReferralSplits(
  params: ResolveReferralSplitsParams,
): Promise<ReferralSplitInput[]> {
  const splits: ReferralSplitInput[] = [];
  const seen = new Set<string>();
  const excluded = new Set<string>(
    [params.sellerId, params.buyerId ?? ''].filter((id) => id.length > 0),
  );

  const pushSplit = (
    recipientId: string,
    recipientType: ReferralSplitInput['recipientType'],
    bps: number,
  ): void => {
    if (bps <= 0) return;
    if (excluded.has(recipientId)) return;
    if (seen.has(recipientId)) return;
    seen.add(recipientId);
    splits.push({ recipientId, recipientType, bps });
  };

  // 1. GROUP — only when the sale was referred via that group's link and the
  //    group has set a referral fee. A locale referrer never triggers a group
  //    fee (it is resolved through the locale branch instead).
  if (params.referrerType === 'group' && params.referrerId) {
    const [groupAgent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, params.referrerId))
      .limit(1);
    // A real group is an organization WITHOUT a place-type; a place-type agent
    // referred as a "group" is a misattribution and is ignored here.
    const groupMeta = (groupAgent?.metadata ?? {}) as Record<string, unknown>;
    if (groupAgent && !isLocaleAgent(groupMeta)) {
      pushSplit(params.referrerId, 'group', readReferralBps(groupMeta));
    }
  }

  // 2. LOCALE — resolved locale (referrer/listing/seller-belong) must have
  //    activated its fee and set a positive bps.
  const localeId = await resolveLocaleId(params);
  if (localeId) {
    const [localeAgent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, localeId))
      .limit(1);
    const localeMeta = (localeAgent?.metadata ?? {}) as Record<string, unknown>;
    if (localeAgent && isLocaleAgent(localeMeta) && localeMeta['feeActivated'] === true) {
      pushSplit(localeId, 'locale', readReferralBps(localeMeta));
    }
  }

  // 3. GLOBAL — platform-wide activation gate via env; recipient is the
  //    platform treasury sentinel, settled into the platform wallet.
  pushSplit(GLOBAL_REFERRAL_RECIPIENT_ID, 'global', readGlobalReferralBps());

  return clampTotalBps(splits);
}

/**
 * Clamps the SUM of split bps to `MAX_REFERRAL_SPLIT_BPS`. Recipients are
 * trimmed from the lowest priority (end of the list — global, then locale)
 * upward so the highest-trust recipient (group) keeps its full bps. A recipient
 * whose remaining headroom is zero is dropped entirely.
 */
function clampTotalBps(splits: ReferralSplitInput[]): ReferralSplitInput[] {
  const total = splits.reduce((sum, s) => sum + s.bps, 0);
  if (total <= MAX_REFERRAL_SPLIT_BPS) return splits;

  let budget = MAX_REFERRAL_SPLIT_BPS;
  const kept: ReferralSplitInput[] = [];
  for (const split of splits) {
    if (budget <= 0) break;
    const allowed = Math.min(split.bps, budget);
    if (allowed > 0) {
      kept.push({ ...split, bps: allowed });
      budget -= allowed;
    }
  }
  return kept;
}
