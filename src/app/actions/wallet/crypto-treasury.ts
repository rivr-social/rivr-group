'use server';

/**
 * Org crypto treasury actions — Safe (USDC on Base) governance INSIDE RIVR.
 *
 * Officers never leave the app: proposals are stored as group-owned resource
 * rows (`metadata.resourceKind: 'safe_tx_proposal'` — no schema migration,
 * mirroring the treasury-funds pattern), each officer signs the SafeTx
 * EIP-712 payload with their own browser wallet, and the platform's gas-only
 * relayer executes at threshold. Authorization for signing IS the signature:
 * it only counts if it cryptographically recovers to a Safe owner.
 *
 * Budgets follow Cameron's governance model: directors approve a per-lead
 * spending limit once (Allowance Module); the lead then pays members within
 * it with a single signature and no director involvement; the internal
 * ledger records each settlement via the eth-payment audit rail.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { resources, wallets } from '@/db/schema';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  budgetSafeTxs,
  buildAllowanceTransferTypedData,
  buildSafeTxTypedData,
  deployOrgSafe,
  execSafeTransaction,
  isValidAddress,
  readAllowance,
  readDelegates,
  readSafeState,
  recoverSafeTxSigner,
  relayAllowanceTransfer,
  safeTxHash,
  type SafeSignature,
  type SafeTxData,
} from '@/lib/safe-treasury';
import { cryptoNetwork, splitterCheckoutEnabled } from '@/lib/crypto-splitter';
import { getAgentEthAddressAction } from './reads';
import { recordEthPaymentAction } from './ethereum';
import { getCurrentUserId, resolveManagedWalletTarget } from './helpers';
import { isUuid, isPositiveInteger } from './types';
import type { Address, Hex } from 'viem';

const PROPOSAL_KIND = 'safe_tx_proposal';
const PROPOSAL_KINDS = ['enable_module', 'add_delegate', 'set_allowance', 'usdc_transfer'] as const;
type ProposalKind = (typeof PROPOSAL_KINDS)[number];

interface ProposalMeta {
  resourceKind: typeof PROPOSAL_KIND;
  groupId: string;
  safeAddress: Address;
  kind: ProposalKind;
  txTo: Address;
  txData: Hex;
  nonce: number;
  safeTxHash: Hex;
  signatures: { signer: Address; signature: Hex }[];
  status: 'pending' | 'executed' | 'stale';
  executedTxHash?: Hex;
  summary: string;
  [key: string]: unknown;
}

function proposalTx(meta: ProposalMeta): SafeTxData {
  return { to: meta.txTo, value: 0n, data: meta.txData };
}

async function getGroupSafeAddress(groupId: string): Promise<Address | null> {
  const [wallet] = await db
    .select({ ethAddress: wallets.ethAddress })
    .from(wallets)
    .where(and(eq(wallets.ownerId, groupId), eq(wallets.type, 'group')))
    .limit(1);
  return wallet?.ethAddress && isValidAddress(wallet.ethAddress) ? (wallet.ethAddress as Address) : null;
}

async function loadProposal(proposalId: string) {
  const [row] = await db
    .select({ id: resources.id, ownerId: resources.ownerId, metadata: resources.metadata })
    .from(resources)
    .where(and(eq(resources.id, proposalId), sql`${resources.metadata}->>'resourceKind' = ${PROPOSAL_KIND}`))
    .limit(1);
  if (!row) throw new Error('Proposal not found.');
  return { id: row.id, groupId: row.ownerId, meta: row.metadata as unknown as ProposalMeta };
}

async function saveProposalMeta(proposalId: string, meta: ProposalMeta) {
  await db
    .update(resources)
    .set({ metadata: meta as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(resources.id, proposalId));
}

async function insertProposal(groupId: string, safe: Address, kind: ProposalKind, tx: SafeTxData, nonce: number, summary: string) {
  const meta: ProposalMeta = {
    resourceKind: PROPOSAL_KIND,
    groupId,
    safeAddress: safe,
    kind,
    txTo: tx.to,
    txData: tx.data,
    nonce,
    safeTxHash: safeTxHash(safe, tx, nonce),
    signatures: [],
    status: 'pending',
    summary,
  };
  const [row] = await db
    .insert(resources)
    .values({
      name: `Treasury proposal: ${summary}`,
      type: 'resource',
      description: summary,
      ownerId: groupId,
      isPublic: false,
      visibility: 'members',
      metadata: meta as unknown as Record<string, unknown>,
    })
    .returning({ id: resources.id });
  return { id: row.id, meta };
}

/** Overview for the Treasury tab card. */
export async function getCryptoTreasuryOverviewAction(groupId: string) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId)) return { success: false as const, error: 'Invalid group.' };

  const safeAddress = await getGroupSafeAddress(groupId);
  const network = cryptoNetwork();
  if (!safeAddress) {
    return { success: true as const, network, configured: false as const, oneSignatureCheckout: splitterCheckoutEnabled() };
  }
  const state = await readSafeState(safeAddress);
  const proposals = await db
    .select({ id: resources.id, metadata: resources.metadata, createdAt: resources.createdAt })
    .from(resources)
    .where(and(eq(resources.ownerId, groupId), sql`${resources.metadata}->>'resourceKind' = ${PROPOSAL_KIND}`))
    .orderBy(sql`${resources.createdAt} DESC`)
    .limit(20);

  let budgets: { delegate: Address; amountCents: number; spentCents: number; resetTimeMin: number }[] = [];
  if (state?.allowanceModuleEnabled) {
    const delegates = await readDelegates(safeAddress);
    budgets = await Promise.all(
      delegates.map(async (delegate) => {
        const a = await readAllowance(safeAddress, delegate);
        return { delegate, amountCents: a.amountCents, spentCents: a.spentCents, resetTimeMin: a.resetTimeMin };
      }),
    );
    budgets = budgets.filter((b) => b.amountCents > 0);
  }

  return {
    success: true as const,
    network,
    configured: true as const,
    oneSignatureCheckout: splitterCheckoutEnabled(),
    safeAddress,
    deployed: Boolean(state),
    owners: state?.owners ?? [],
    threshold: state?.threshold ?? 0,
    allowanceModuleEnabled: state?.allowanceModuleEnabled ?? false,
    usdcCents: state?.usdcCents ?? 0,
    budgets,
    proposals: proposals.map((p) => {
      const m = p.metadata as unknown as ProposalMeta;
      return {
        id: p.id,
        kind: m.kind,
        summary: m.summary,
        status: m.status,
        signatures: m.signatures.length,
        executedTxHash: m.executedTxHash ?? null,
        createdAt: p.createdAt,
      };
    }),
  };
}

/** Admin: bind an existing officer Safe as the org treasury. */
export async function setOrgSafeAddressAction(groupId: string, safeAddress: string) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId)) return { success: false as const, error: 'Invalid group.' };
  if (!isValidAddress(safeAddress)) return { success: false as const, error: 'Invalid Safe address.' };
  try {
    const target = await resolveManagedWalletTarget(currentUserId, groupId);
    const state = await readSafeState(safeAddress as Address);
    if (!state) return { success: false as const, error: 'No Safe found at that address on the configured network.' };
    await db
      .update(wallets)
      .set({ ethAddress: safeAddress, updatedAt: new Date() })
      .where(eq(wallets.id, target.walletId));
    return { success: true as const, owners: state.owners, threshold: state.threshold };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to bind Safe.' };
  }
}

/** Admin: deploy a fresh officer-owned Safe (relayer pays gas; officers own it). */
export async function deployOrgSafeAction(groupId: string, officerAddresses: string[], threshold: number) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId)) return { success: false as const, error: 'Invalid group.' };
  const officers = (officerAddresses ?? []).filter(isValidAddress) as Address[];
  if (officers.length < 2 || new Set(officers.map((o) => o.toLowerCase())).size !== officers.length) {
    return { success: false as const, error: 'At least two distinct officer addresses are required.' };
  }
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > officers.length) {
    return { success: false as const, error: 'Threshold must be ≥2 and ≤ the number of officers.' };
  }
  const limiter = await rateLimit(`crypto-treasury:${currentUserId}`, RATE_LIMITS.WALLET.limit, RATE_LIMITS.WALLET.windowMs);
  if (!limiter.success) return { success: false as const, error: 'Rate limit exceeded.' };
  try {
    const target = await resolveManagedWalletTarget(currentUserId, groupId);
    // Salt derived from group id keeps redeploys deterministic per group while
    // avoiding cross-group address collisions.
    const salt = BigInt('0x' + groupId.replace(/-/g, '').slice(0, 16));
    const safe = await deployOrgSafe(officers, threshold, salt);
    await db.update(wallets).set({ ethAddress: safe, updatedAt: new Date() }).where(eq(wallets.id, target.walletId));
    return { success: true as const, safeAddress: safe };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Safe deployment failed.' };
  }
}

/**
 * Admin: create the budget-approval proposals for a lead (enable module when
 * needed → add delegate → set allowance), consecutive nonces so officers can
 * sign all three in one sitting.
 */
export async function createBudgetProposalsAction(
  groupId: string,
  leadAddress: string,
  amountCents: number,
  resetTimeMin: number,
) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId)) return { success: false as const, error: 'Invalid group.' };
  if (!isValidAddress(leadAddress)) return { success: false as const, error: 'Invalid lead wallet address.' };
  if (!isPositiveInteger(amountCents)) return { success: false as const, error: 'Budget must be a positive amount.' };
  if (!Number.isInteger(resetTimeMin) || resetTimeMin < 0 || resetTimeMin > 64_800) {
    return { success: false as const, error: 'resetTimeMin must be 0 (depleting) or up to 45 days in minutes.' };
  }
  try {
    await resolveManagedWalletTarget(currentUserId, groupId);
    const safe = await getGroupSafeAddress(groupId);
    if (!safe) return { success: false as const, error: 'No treasury Safe configured for this group.' };
    const state = await readSafeState(safe);
    if (!state) return { success: false as const, error: 'Treasury Safe is not deployed on this network.' };

    const txs = budgetSafeTxs(safe);
    let nonce = state.nonce;
    const created: { id: string; summary: string }[] = [];
    if (!state.allowanceModuleEnabled) {
      const p = await insertProposal(groupId, safe, 'enable_module', txs.enableModule(), nonce++, 'Enable the budget (Allowance) module');
      created.push({ id: p.id, summary: p.meta.summary });
    }
    const dollars = (amountCents / 100).toFixed(2);
    const cadence = resetTimeMin === 0 ? 'depleting' : `refills every ${resetTimeMin} min`;
    const p2 = await insertProposal(groupId, safe, 'add_delegate', txs.addDelegate(leadAddress as Address), nonce++, `Register budget lead ${leadAddress}`);
    created.push({ id: p2.id, summary: p2.meta.summary });
    const p3 = await insertProposal(
      groupId, safe, 'set_allowance',
      txs.setAllowance(leadAddress as Address, amountCents, resetTimeMin), nonce++,
      `Set $${dollars} USDC budget (${cadence}) for ${leadAddress}`,
    );
    created.push({ id: p3.id, summary: p3.meta.summary });
    return { success: true as const, proposals: created };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to create budget proposals.' };
  }
}

/** Admin: propose a direct treasury USDC transfer (full 2-of-3). */
export async function createTransferProposalAction(groupId: string, toAddress: string, amountCents: number) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId) || !isValidAddress(toAddress) || !isPositiveInteger(amountCents)) {
    return { success: false as const, error: 'Invalid transfer parameters.' };
  }
  try {
    await resolveManagedWalletTarget(currentUserId, groupId);
    const safe = await getGroupSafeAddress(groupId);
    if (!safe) return { success: false as const, error: 'No treasury Safe configured for this group.' };
    const state = await readSafeState(safe);
    if (!state) return { success: false as const, error: 'Treasury Safe is not deployed on this network.' };
    const tx = budgetSafeTxs(safe).usdcTransfer(toAddress as Address, amountCents);
    const p = await insertProposal(
      groupId, safe, 'usdc_transfer', tx, state.nonce,
      `Transfer $${(amountCents / 100).toFixed(2)} USDC to ${toAddress}`,
    );
    return { success: true as const, proposalId: p.id };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to create transfer proposal.' };
  }
}

/** Officer signing payload (EIP-712) for a pending proposal. */
export async function getProposalSigningPayloadAction(proposalId: string) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(proposalId)) return { success: false as const, error: 'Invalid proposal.' };
  try {
    const { meta } = await loadProposal(proposalId);
    if (meta.status !== 'pending') return { success: false as const, error: `Proposal is ${meta.status}.` };
    return {
      success: true as const,
      typedData: buildSafeTxTypedData(meta.safeAddress, proposalTx(meta), meta.nonce),
      signatures: meta.signatures.map((s) => s.signer),
      summary: meta.summary,
    };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to load proposal.' };
  }
}

/** Records an officer's signature — valid only if it recovers to a Safe owner. */
export async function signSafeProposalAction(proposalId: string, signature: string) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(proposalId)) return { success: false as const, error: 'Invalid proposal.' };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { success: false as const, error: 'Malformed signature.' };
  }
  try {
    const { id, meta } = await loadProposal(proposalId);
    if (meta.status !== 'pending') return { success: false as const, error: `Proposal is ${meta.status}.` };
    const state = await readSafeState(meta.safeAddress);
    if (!state) return { success: false as const, error: 'Safe not found on this network.' };
    if (state.nonce > meta.nonce) {
      meta.status = 'stale';
      await saveProposalMeta(id, meta);
      return { success: false as const, error: 'Proposal is stale (the Safe nonce moved past it) — recreate it.' };
    }
    const signer = await recoverSafeTxSigner(meta.safeAddress, proposalTx(meta), meta.nonce, signature as Hex);
    if (!state.owners.some((o) => o.toLowerCase() === signer.toLowerCase())) {
      return { success: false as const, error: 'Signature does not recover to a Safe officer.' };
    }
    if (meta.signatures.some((s) => s.signer.toLowerCase() === signer.toLowerCase())) {
      return { success: false as const, error: 'This officer already signed.' };
    }
    meta.signatures = [...meta.signatures, { signer, signature: signature as Hex }];
    await saveProposalMeta(id, meta);
    return {
      success: true as const,
      signer,
      signatures: meta.signatures.length,
      threshold: state.threshold,
      executable: meta.signatures.length >= state.threshold,
    };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to record signature.' };
  }
}

/** Executes a threshold-signed proposal via the gas-only relayer. */
export async function executeSafeProposalAction(proposalId: string) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(proposalId)) return { success: false as const, error: 'Invalid proposal.' };
  try {
    const { id, meta } = await loadProposal(proposalId);
    if (meta.status !== 'pending') return { success: false as const, error: `Proposal is ${meta.status}.` };
    const state = await readSafeState(meta.safeAddress);
    if (!state) return { success: false as const, error: 'Safe not found on this network.' };
    if (meta.signatures.length < state.threshold) {
      return { success: false as const, error: `Needs ${state.threshold} officer signatures (has ${meta.signatures.length}).` };
    }
    const txHash = await execSafeTransaction(meta.safeAddress, proposalTx(meta), meta.signatures as SafeSignature[]);
    meta.status = 'executed';
    meta.executedTxHash = txHash;
    await saveProposalMeta(id, meta);
    return { success: true as const, txHash };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Execution failed.' };
  }
}

/** Lead payout, step 1: the typed data the LEAD signs (nonce from chain). */
export async function getBudgetPayoutTypedDataAction(groupId: string, recipient: string, amountCents: number) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId) || !isPositiveInteger(amountCents)) {
    return { success: false as const, error: 'Invalid payout parameters.' };
  }
  try {
    const safe = await getGroupSafeAddress(groupId);
    if (!safe) return { success: false as const, error: 'No treasury Safe configured for this group.' };
    let toAddress: Address | null = isValidAddress(recipient) ? (recipient as Address) : null;
    let recipientAgentId: string | null = null;
    if (!toAddress && isUuid(recipient)) {
      const { ethAddress } = await getAgentEthAddressAction(recipient);
      if (ethAddress && isValidAddress(ethAddress)) {
        toAddress = ethAddress as Address;
        recipientAgentId = recipient;
      }
    }
    if (!toAddress) return { success: false as const, error: 'Recipient has no wallet address.' };
    // The DELEGATE (lead) is whoever signs — their wallet address is read
    // client-side; the allowance nonce belongs to (safe, delegate), so the
    // client passes the delegate back on submit and the signature is the authz.
    return { success: true as const, safe, toAddress, recipientAgentId, amountCents };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Failed to prepare payout.' };
  }
}

export async function buildBudgetPayoutTypedDataAction(
  groupId: string,
  delegateAddress: string,
  toAddress: string,
  amountCents: number,
) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  if (!isUuid(groupId) || !isValidAddress(delegateAddress) || !isValidAddress(toAddress) || !isPositiveInteger(amountCents)) {
    return { success: false as const, error: 'Invalid payout parameters.' };
  }
  const safe = await getGroupSafeAddress(groupId);
  if (!safe) return { success: false as const, error: 'No treasury Safe configured.' };
  const allowance = await readAllowance(safe, delegateAddress as Address);
  if (allowance.amountCents <= 0) return { success: false as const, error: 'This wallet holds no budget on the treasury.' };
  if (allowance.amountCents - allowance.spentCents < amountCents) {
    return { success: false as const, error: 'Amount exceeds the remaining budget.' };
  }
  return {
    success: true as const,
    typedData: buildAllowanceTransferTypedData(safe, toAddress as Address, amountCents, allowance.nonce),
    remainingCents: allowance.amountCents - allowance.spentCents,
  };
}

export async function submitBudgetPayoutAction(params: {
  groupId: string;
  delegateAddress: string;
  toAddress: string;
  amountCents: number;
  signature: string;
  recipientAgentId?: string;
  memo?: string;
}) {
  const currentUserId = await getCurrentUserId();
  if (!currentUserId) return { success: false as const, error: 'Authentication required.' };
  const { groupId, delegateAddress, toAddress, amountCents, signature, recipientAgentId, memo } = params;
  if (!isUuid(groupId) || !isValidAddress(delegateAddress) || !isValidAddress(toAddress) || !isPositiveInteger(amountCents)) {
    return { success: false as const, error: 'Invalid payout parameters.' };
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { success: false as const, error: 'Malformed signature.' };
  }
  const limiter = await rateLimit(`crypto-payout:${currentUserId}`, RATE_LIMITS.WALLET.limit, RATE_LIMITS.WALLET.windowMs);
  if (!limiter.success) return { success: false as const, error: 'Rate limit exceeded.' };
  try {
    const safe = await getGroupSafeAddress(groupId);
    if (!safe) return { success: false as const, error: 'No treasury Safe configured.' };
    const txHash = await relayAllowanceTransfer({
      safe,
      delegate: delegateAddress as Address,
      to: toAddress as Address,
      amountCents,
      signature: signature as Hex,
    });
    // Settle the internal ledger: the treasury paid out on-chain; record it
    // against the recipient (falls back to the group itself when the
    // recipient isn't a local agent) on the eth audit rail.
    const record = await recordEthPaymentAction(
      recipientAgentId && isUuid(recipientAgentId) ? recipientAgentId : groupId,
      amountCents,
      txHash,
      memo?.trim() ||
        `Treasury budget payout: $${(amountCents / 100).toFixed(2)} USDC from ${safe} to ${toAddress} (lead ${delegateAddress})`,
    );
    return { success: true as const, txHash, receiptId: record.success ? record.receiptId ?? null : null };
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : 'Payout failed.' };
  }
}
