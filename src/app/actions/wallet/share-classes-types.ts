/**
 * Non-server constants + types for share classes.
 *
 * These live OUTSIDE the `"use server"` `share-classes.ts` module because a
 * server-action file may only export async functions — exporting a const/object
 * from it breaks the Next build (tsc does not catch this). See
 * `share-classes.ts` for the actions.
 */

/** metadata.groupType discriminator for a share-class subgroup. */
export const SHARE_CLASS_GROUP_TYPE = 'share_class';

/** Canonical hidden class display names tied to the hidden membership tiers. */
export const CANONICAL_SHARE_CLASSES: Record<'steward' | 'worker', string> = {
  steward: 'Stewards',
  worker: 'Workers',
};

export interface ShareClassRow {
  id: string;
  name: string;
  shareCount: number;
  netBps: number;
  /** Governance P3 (decision #1): the class's VOTING pie share, independent of netBps. */
  voteBps: number;
  hidden: boolean;
  tierKey: string | null;
}

export interface ShareHolder {
  memberId: string;
  shares: number;
}
