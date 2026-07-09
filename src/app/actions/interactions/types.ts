export type ActionResult = {
  success: boolean;
  message: string;
  active?: boolean;
  resourceId?: string;
  linkedEventId?: string;
  linkedDocumentId?: string;
  reactionType?: ReactionType | null;
  /** True when the action created a pending-approval request rather than an
   * immediately-active grant (e.g. an approval-gated job claim). */
  pending?: boolean;
  /** Structured failure detail (e.g. a capability/subscription gate), mirroring
   * the resource-creation action result shape so the client can react uniformly. */
  error?: {
    code: string;
    details?: string;
    requiredTier?: string;
  };
};

export type HiddenContentPreferences = {
  hiddenPostIds: string[];
  hiddenAuthorIds: string[];
};

export type ReactionType = "like" | "love" | "laugh" | "wow" | "sad" | "angry";
export const REACTION_TYPES: ReactionType[] = ["like", "love", "laugh", "wow", "sad", "angry"];

export type TargetType =
  | "post"
  | "comment"
  | "group"
  | "ring"
  | "event"
  | "person"
  | "listing"
  | "resource";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string is a canonical UUID.
 *
 * Used before assigning `objectId` fields to keep typed UUID columns valid while
 * still supporting non-UUID external target IDs in metadata.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export type EventAttendee = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  status: string;
};

export type VoucherEscrowState = {
  voucherId: string;
  status: string;
  requiredThanks: number;
  availableThanks: number;
  hasEscrowClaim: boolean;
  canClaim: boolean;
  canRedeem: boolean;
  claimedAt?: string | null;
  claimedBookingDate?: string | null;
  claimedBookingSlot?: string | null;
  escrowedTokenCount: number;
  claimantId?: string | null;
  isOwner: boolean;
};
