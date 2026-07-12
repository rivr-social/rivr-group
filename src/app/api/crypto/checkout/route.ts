/**
 * POST /api/crypto/checkout — one-signature USDC checkout (RivrSplitter).
 *
 * Two actions:
 * - `quote`: server computes the split for a listing (price, platform fee,
 *   seller address — all server-derived; the client NEVER authors amounts or
 *   recipients) and returns the EIP-3009 typed data for the buyer to sign,
 *   plus the salt binding the signature to this exact split.
 * - `submit`: server RECOMPUTES the same split from the listing (rejecting
 *   any drift), relays the signed authorization through the splitter, and on
 *   on-chain success records the purchase (receipt + ledger) against the
 *   unified-session principal.
 *
 * Auth: unified session (local OR federated remote-viewer) with first-contact
 * projection — a crypto purchase is actor-keyed exactly like a card purchase.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/get-session';
import { resolveLocalActorId } from '@/lib/federation/resolution';
import { ensureLocalActorAgent } from '@/lib/federation/actor-projection';
import { getResource } from '@/lib/queries/resources';
import { getAgentEthAddressAction } from '@/app/actions/wallet/reads';
import { recordLocalCryptoPurchase } from '@/lib/crypto-settlement';
import { MARKETPLACE_FEE_BPS, BPS_DIVISOR } from '@/lib/wallet-constants';
import {
  buildAuthorizationTypedData,
  computeSplitNonce,
  cryptoNetwork,
  relaySplit,
  splitterAddress,
  splitterCheckoutEnabled,
  type SplitPayout,
} from '@/lib/crypto-splitter';
import { rateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_INTERNAL_ERROR,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_NOT_FOUND,
} from '@/lib/http-status';
import { randomBytes } from 'crypto';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SALT_RE = /^0x[0-9a-fA-F]{64}$/;
const QUOTE_VALIDITY_SECONDS = 15 * 60;

/**
 * Server-derived split for a listing purchase: seller net + platform fee in
 * 6-decimal USDC units. Mirrors the client crypto path's fee math (flat
 * MARKETPLACE_FEE_BPS on the listing total — no card-processing gross-up on
 * the crypto rail; the relayer's gas is the platform's cost of goods).
 */
async function computeListingSplit(listingId: string, quantity: number) {
  const resource = await getResource(listingId);
  if (!resource || resource.type !== 'listing') return null;
  const meta = (resource.metadata ?? {}) as Record<string, unknown>;
  if ((meta.currency as string) !== 'USDC') return null;

  const numericPrice = Number(String(meta.price ?? '').replace(/[^0-9.]/g, '')) || 0;
  const unitCents = Math.round(numericPrice * 100);
  if (unitCents <= 0) return null;

  const totalCents = unitCents * quantity;
  const platformFeeCents = Math.round((totalCents * MARKETPLACE_FEE_BPS) / BPS_DIVISOR);
  const buyerTotalCents = totalCents + platformFeeCents;

  const sellerId = resource.ownerId;
  const { ethAddress: sellerAddress } = await getAgentEthAddressAction(sellerId);
  if (!sellerAddress || !ADDRESS_RE.test(sellerAddress)) return null;

  const platformWallet = process.env.CRYPTO_PLATFORM_WALLET;
  if (!platformWallet || !ADDRESS_RE.test(platformWallet)) return null;

  // Cents → 6-decimal USDC units (1 cent = 10_000 units).
  const payouts: SplitPayout[] = [
    { to: sellerAddress as SplitPayout['to'], amount: BigInt(totalCents) * 10_000n },
    { to: platformWallet as SplitPayout['to'], amount: BigInt(platformFeeCents) * 10_000n },
  ].filter((p) => p.amount > 0n);

  return {
    resource,
    sellerId,
    listingTitle: resource.name,
    totalCents,
    platformFeeCents,
    buyerTotalCents,
    totalUnits: BigInt(buyerTotalCents) * 10_000n,
    payouts,
  };
}

export async function POST(request: NextRequest) {
  if (!splitterCheckoutEnabled()) {
    return NextResponse.json(
      { error: 'One-signature crypto checkout is not enabled on this instance.' },
      { status: STATUS_BAD_REQUEST },
    );
  }

  // Unified session (local OR federated) + first-contact projection — the
  // recording path writes actor-keyed rows.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: STATUS_UNAUTHORIZED });
  }
  const actorId =
    session.user.authMethod === 'federated'
      ? await resolveLocalActorId(session.user.id)
      : session.user.id;
  if (session.user.authMethod === 'federated') {
    await ensureLocalActorAgent(actorId);
  }

  const clientIp = getClientIp(request.headers);
  const limiter = await rateLimit(
    `crypto-checkout:${clientIp}:${actorId}`,
    RATE_LIMITS.WALLET.limit,
    RATE_LIMITS.WALLET.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: STATUS_TOO_MANY_REQUESTS },
    );
  }

  let body: {
    action?: string;
    listingId?: string;
    quantity?: number;
    buyerAddress?: string;
    salt?: string;
    validBefore?: number;
    signature?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: STATUS_BAD_REQUEST });
  }

  const { action, listingId, buyerAddress } = body;
  const quantity = Number.isInteger(body.quantity) && (body.quantity as number) > 0 ? (body.quantity as number) : 1;

  if (!listingId || typeof listingId !== 'string') {
    return NextResponse.json({ error: 'listingId is required' }, { status: STATUS_BAD_REQUEST });
  }
  if (!buyerAddress || !ADDRESS_RE.test(buyerAddress)) {
    return NextResponse.json({ error: 'buyerAddress is required' }, { status: STATUS_BAD_REQUEST });
  }

  const split = await computeListingSplit(listingId, quantity);
  if (!split) {
    return NextResponse.json(
      { error: 'Listing not found, not USDC-priced, or seller has no crypto address.' },
      { status: STATUS_NOT_FOUND },
    );
  }

  try {
    if (action === 'quote') {
      const salt = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`;
      const validBeforeUnix = Math.floor(Date.now() / 1000) + QUOTE_VALIDITY_SECONDS;
      const typedData = await buildAuthorizationTypedData({
        buyer: buyerAddress as `0x${string}`,
        totalUnits: split.totalUnits,
        salt,
        payouts: split.payouts,
        validBeforeUnix,
      });
      return NextResponse.json({
        typedData,
        salt,
        validBefore: validBeforeUnix,
        network: cryptoNetwork(),
        splitter: splitterAddress(),
        buyerTotalCents: split.buyerTotalCents,
        breakdown: {
          listingTotalCents: split.totalCents,
          platformFeeCents: split.platformFeeCents,
        },
      });
    }

    if (action === 'submit') {
      const { salt, signature } = body;
      const validBefore = Number(body.validBefore);
      if (!salt || !SALT_RE.test(salt)) {
        return NextResponse.json({ error: 'salt is required' }, { status: STATUS_BAD_REQUEST });
      }
      if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return NextResponse.json({ error: 'signature is required' }, { status: STATUS_BAD_REQUEST });
      }
      if (!Number.isInteger(validBefore) || validBefore < Math.floor(Date.now() / 1000)) {
        return NextResponse.json({ error: 'Quote expired — request a new one.' }, { status: STATUS_BAD_REQUEST });
      }

      // The split was recomputed above from the LISTING — the signature only
      // matches if the buyer signed exactly this fan-out (nonce commitment).
      const txHash = await relaySplit({
        buyer: buyerAddress as `0x${string}`,
        totalUnits: split.totalUnits,
        salt: salt as `0x${string}`,
        payouts: split.payouts,
        validBeforeUnix: validBefore,
        signature: signature as `0x${string}`,
      });

      const nonce = computeSplitNonce(salt as `0x${string}`, split.payouts);
      // Settlement is FINAL on-chain (atomic split). The receipt is a local
      // artifact of a sale that happened on THIS instance — recorded locally,
      // never through the federation-forwarding facade (which fails for a
      // federated buyer in this relayer context). A record failure must NOT
      // lose the money linkage: return success + txHash so the buyer has proof
      // and the settlement can be reconciled.
      let receiptId: string | null = null;
      try {
        const record = await recordLocalCryptoPurchase({
          buyerAgentId: actorId,
          sellerAgentId: split.sellerId,
          amountCents: split.buyerTotalCents,
          txHash,
          listingId,
          description:
            `Mart purchase (one-signature USDC split): ${split.listingTitle} ` +
            `($${(split.totalCents / 100).toFixed(2)} seller, $${(split.platformFeeCents / 100).toFixed(2)} platform fee) [nonce ${nonce}]`,
          platformFeeTxHash: txHash,
        });
        receiptId = record.receiptId;
      } catch (recErr) {
        console.error('[crypto-checkout] settled on-chain but local record failed:', txHash, recErr);
      }
      return NextResponse.json({ txHash, receiptId, recorded: receiptId !== null });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: STATUS_BAD_REQUEST });
  } catch (err) {
    console.error('[crypto-checkout] failed:', err);
    const message = err instanceof Error ? err.message : 'Crypto checkout failed.';
    return NextResponse.json({ error: message }, { status: STATUS_INTERNAL_ERROR });
  }
}
