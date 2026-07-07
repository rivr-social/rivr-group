/**
 * Stripe Connect account provisioning core — the single "make sure this
 * treasury has a connected account" primitive shared by the seller onboarding
 * flow (`actions/wallet/seller.ts` → `setupConnectAccountAction`), the
 * instance-wide backfill (`actions/wallet/connect-backfill.ts`), and the
 * `rivr.payments.backfill_connect_accounts` MCP tool.
 *
 * Account model (payments architecture doc §2): Custom controller-based
 * connected accounts (`createCustomConnectAccount`) when
 * STRIPE_CUSTOM_ACCOUNTS_ENABLED=true — the only type that can host
 * Treasury/Issuing + platform bank-balance reads — falling back to Express
 * (`createConnectAccount`) otherwise. Both paths stamp `metadata.agentId` on
 * the Stripe account.
 *
 * Persistence contract: the account id lives on the owner's SETTLEMENT wallet
 * at `metadata.stripeConnectAccountId` — exactly where every existing reader
 * (seller actions, treasury-banking, checkout capability checks) looks.
 *
 * Idempotency: the wallet row is re-read at call time; an existing
 * `stripeConnectAccountId` short-circuits without touching Stripe, so callers
 * (and batch re-runs) are safe to invoke unconditionally.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents, wallets } from '@/db/schema';
import { createConnectAccount } from '@/lib/stripe-connect';
import { createCustomConnectAccount, isCustomConnectEnabled } from '@/lib/stripe-treasury';
import { getSettlementWalletForAgent } from '@/lib/wallet';

export interface EnsureConnectAccountResult {
  /** The Stripe Connect account id now recorded on the settlement wallet. */
  connectAccountId: string;
  /** True when this call created the account; false when one already existed. */
  created: boolean;
}

export interface EnsureConnectAccountForWalletInput {
  /** The settlement wallet the account id persists on. */
  walletId: string;
  /** The agent the account belongs to (stamped as `metadata.agentId` on Stripe). */
  ownerId: string;
  /** Email to attach to the Stripe account, when known. */
  ownerEmail?: string | null;
  /** The wallet's type ('personal' | 'group' | 'project') — recorded on the Stripe account metadata. */
  walletType: string;
  /** Extra string metadata merged onto the Stripe account (e.g. an onboarding returnPath). */
  accountMetadata?: Record<string, string>;
}

/**
 * Ensure the given settlement wallet has a Stripe Connect account, creating
 * one when missing and persisting its id at `metadata.stripeConnectAccountId`.
 *
 * This is the account-creation core extracted from `setupConnectAccountAction`
 * — Custom (controller) account when {@link isCustomConnectEnabled}, Express
 * otherwise, with `agentId`/`walletId`/`ownerId`/`walletType` metadata on the
 * Stripe account.
 *
 * @throws {Error} When the wallet row does not exist or Stripe account creation fails.
 */
export async function ensureConnectAccountForWallet(
  input: EnsureConnectAccountForWalletInput,
): Promise<EnsureConnectAccountResult> {
  const [wallet] = await db
    .select({ id: wallets.id, metadata: wallets.metadata })
    .from(wallets)
    .where(eq(wallets.id, input.walletId))
    .limit(1);

  if (!wallet) {
    throw new Error('Treasury wallet not found.');
  }

  const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
  const existingAccountId = walletMeta.stripeConnectAccountId;
  if (typeof existingAccountId === 'string' && existingAccountId.length > 0) {
    return { connectAccountId: existingAccountId, created: false };
  }

  const accountMetadata: Record<string, string> = {
    walletId: wallet.id,
    ownerId: input.ownerId,
    walletType: input.walletType,
    ...(input.accountMetadata ?? {}),
  };

  // Default account type: Custom (controller-based) when enabled — the only
  // type that can host Treasury/Issuing + platform bank-balance reads.
  // Hosted Account-Links onboarding works for both, so downstream flows are shared.
  const account = isCustomConnectEnabled()
    ? await createCustomConnectAccount({
        agentId: input.ownerId,
        email: input.ownerEmail ?? undefined,
        metadata: accountMetadata,
      })
    : await createConnectAccount(input.ownerId, input.ownerEmail ?? undefined, accountMetadata);

  await db
    .update(wallets)
    .set({
      metadata: { ...walletMeta, stripeConnectAccountId: account.id },
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, wallet.id));

  return { connectAccountId: account.id, created: true };
}

/**
 * Ensure `agentId`'s settlement wallet has a Stripe Connect account — the
 * agent-addressed form of {@link ensureConnectAccountForWallet}. Resolves (or
 * creates) the agent's settlement wallet via {@link getSettlementWalletForAgent},
 * then delegates. Idempotent and safe to re-run.
 *
 * @throws {Error} When the agent does not exist (or is soft-deleted) or Stripe creation fails.
 */
export async function ensureConnectAccountForAgent(
  agentId: string,
): Promise<EnsureConnectAccountResult> {
  const [agent] = await db
    .select({ id: agents.id, email: agents.email, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent || agent.deletedAt) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const wallet = await getSettlementWalletForAgent(agentId);

  return ensureConnectAccountForWallet({
    walletId: wallet.id,
    ownerId: agentId,
    ownerEmail: agent.email,
    walletType: wallet.type,
  });
}
