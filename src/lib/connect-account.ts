/**
 * Sovereign-instance connected-account lookup guard.
 *
 * Global is the ecosystem's only Stripe platform and the only service allowed
 * to provision connected accounts. Group may reuse a globally-issued account
 * reference already mirrored onto a local settlement wallet, but it fails
 * closed when that reference is absent.
 *
 * Persistence contract: the account id lives on the owner's SETTLEMENT wallet
 * at `metadata.stripeConnectAccountId` — exactly where every existing reader
 * (seller actions, treasury-banking, checkout capability checks) looks.
 *
 * This deliberately performs no Stripe API calls.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { agents, wallets } from '@/db/schema';
import { isGroupAgentType } from '@/lib/agent-types';

export interface EnsureConnectAccountResult {
  /** The Stripe Connect account id now recorded on the settlement wallet. */
  connectAccountId: string;
  /** Always false on Group; only Global may create an account. */
  created: boolean;
}

export interface EnsureConnectAccountForWalletInput {
  /** The settlement wallet the account id persists on. */
  walletId: string;
  /** The agent that must own the settlement wallet. */
  ownerId: string;
  /** Retained for call-site compatibility; Group never sends it to Stripe. */
  ownerEmail?: string | null;
  /** Retained for call-site compatibility; Global owns country verification. */
  accountCountry?: string;
  /** The wallet type expected by the caller. */
  walletType: string;
  /** Retained for call-site compatibility; Group never sends it to Stripe. */
  accountMetadata?: Record<string, string>;
}

/**
 * Return a Global-issued account reference already mirrored on a settlement
 * wallet. Group never provisions an account or writes wallet metadata here.
 *
 * @throws {Error} When the wallet is missing, does not belong to the expected
 * owner/type, or has no Global-issued account reference.
 */
export async function ensureConnectAccountForWallet(
  input: EnsureConnectAccountForWalletInput,
): Promise<EnsureConnectAccountResult> {
  const [wallet] = await db
    .select({
      id: wallets.id,
      ownerId: wallets.ownerId,
      type: wallets.type,
      metadata: wallets.metadata,
    })
    .from(wallets)
    .where(eq(wallets.id, input.walletId))
    .limit(1);

  if (!wallet) {
    throw new Error('Treasury wallet not found.');
  }
  if (wallet.ownerId !== input.ownerId || wallet.type !== input.walletType) {
    throw new Error('Treasury wallet does not match the requested owner and type.');
  }

  const walletMeta = (wallet.metadata ?? {}) as Record<string, unknown>;
  const existingAccountId = walletMeta.stripeConnectAccountId;
  if (typeof existingAccountId === 'string' && existingAccountId.length > 0) {
    return { connectAccountId: existingAccountId, created: false };
  }
  throw new Error(
    'Connected accounts are provisioned by Global, the ecosystem Stripe authority. This Group instance cannot create one locally.',
  );
}

/**
 * Read `agentId`'s owner-scoped settlement wallet and return its mirrored
 * Global-issued account reference. This lookup never creates a wallet because
 * personal-wallet creation can create a Stripe Customer.
 *
 * @throws {Error} When the agent/wallet is missing or no Global-issued account
 * reference has been mirrored locally.
 */
export async function ensureConnectAccountForAgent(
  agentId: string,
): Promise<EnsureConnectAccountResult> {
  const [agent] = await db
    .select({ id: agents.id, type: agents.type, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent || agent.deletedAt) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const walletType = isGroupAgentType(agent.type) ? 'group' : 'personal';
  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(
      and(
        eq(wallets.ownerId, agentId),
        eq(wallets.type, walletType),
        isNull(wallets.resourceId),
      ),
    )
    .limit(1);

  if (!wallet) {
    throw new Error(
      'Connected accounts are provisioned by Global, the ecosystem Stripe authority. No mirrored payment account is available locally.',
    );
  }

  return ensureConnectAccountForWallet({
    walletId: wallet.id,
    ownerId: agentId,
    walletType,
  });
}
