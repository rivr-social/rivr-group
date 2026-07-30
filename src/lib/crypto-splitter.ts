/**
 * Server-side rail for the one-signature USDC checkout (RivrSplitter).
 *
 * Purpose:
 * The buyer signs ONE EIP-3009 `receiveWithAuthorization` naming the splitter
 * contract as recipient of the full checkout total, with the EIP-3009 nonce
 * committing to the exact payout fan-out (nonce = keccak256(abi.encode(salt,
 * payouts))). This module builds that typed data server-side (the split is
 * NEVER client-authored) and submits the signed authorization through the
 * platform's gas-only relayer key. Settlement is atomic: seller leg +
 * platform fee land in one transaction or not at all — the fee cannot be
 * skipped and the seller cannot be paid without it.
 *
 * Keys: `CRYPTO_RELAYER_PRIVATE_KEY` pays gas and can never touch USDC (the
 * plan's gas-only key allowance). No user key ever reaches the server.
 *
 * Network: selected per instance via `CRYPTO_NETWORK` (base | base-sepolia),
 * same policy switch as the client checkout; `SPLITTER_ADDRESS` is the
 * deployed RivrSplitter for that network. The selection FAILS SAFE to the
 * TESTNET — see {@link cryptoNetwork}.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeAbiParameters,
  keccak256,
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

export type CryptoNetwork = 'base' | 'base-sepolia';

const NETWORKS = {
  base: {
    chain: base,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    rpcUrl: 'https://mainnet.base.org',
  },
  'base-sepolia': {
    chain: baseSepolia,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    rpcUrl: 'https://sepolia.base.org',
  },
} as const;

const SPLITTER_ABI = parseAbi([
  'function splitWithAuthorization(address from, uint256 total, uint256 validAfter, uint256 validBefore, bytes32 salt, (address to, uint256 amount)[] payouts, uint8 v, bytes32 r, bytes32 s)',
]);

const USDC_META_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface SplitPayout {
  to: Address;
  amount: bigint;
}

/** The network used when `CRYPTO_NETWORK` is unset/unrecognized (fail-safe). */
export const DEFAULT_CRYPTO_NETWORK: CryptoNetwork = 'base-sepolia';

/** Values that opt an instance INTO real-money Base mainnet. Explicit only. */
const MAINNET_OPT_IN_VALUES = new Set(['base', 'mainnet', 'base-mainnet']);

/** Values that name the testnet explicitly (no warning — a deliberate choice). */
const TESTNET_VALUES = new Set(['base-sepolia', 'sepolia', 'testnet']);

/** Warn at most once per process per distinct bad/absent value — no log spam. */
const warnedNetworkValues = new Set<string>();

function warnNetworkDefault(raw: string | undefined): void {
  const key = raw ?? '';
  if (warnedNetworkValues.has(key)) return;
  warnedNetworkValues.add(key);
  console.warn(
    raw
      ? `[crypto] CRYPTO_NETWORK="${raw}" is not a recognized network — falling back to ` +
          `${DEFAULT_CRYPTO_NETWORK} (testnet). Set CRYPTO_NETWORK=base to use Base mainnet.`
      : `[crypto] CRYPTO_NETWORK is not set — defaulting to ${DEFAULT_CRYPTO_NETWORK} ` +
          `(testnet). Set CRYPTO_NETWORK=base to move REAL USDC on Base mainnet.`,
  );
}

/**
 * The Base network this instance transacts on.
 *
 * MONEY-SAFETY: an unset or unrecognized `CRYPTO_NETWORK` resolves to the
 * TESTNET. Mainnet moves REAL USDC, so it must be an explicit, deliberate
 * opt-in (`CRYPTO_NETWORK=base`) — a missing env var on a box that happens to
 * carry `SPLITTER_ADDRESS` + `CRYPTO_RELAYER_PRIVATE_KEY` must never silently
 * point the rail at real money. Defaulting logs a warning (once per value).
 */
export function cryptoNetwork(): CryptoNetwork {
  const raw = process.env.CRYPTO_NETWORK?.trim();
  const normalized = raw?.toLowerCase();
  if (normalized && MAINNET_OPT_IN_VALUES.has(normalized)) return 'base';
  if (normalized && TESTNET_VALUES.has(normalized)) return 'base-sepolia';
  warnNetworkDefault(raw);
  return DEFAULT_CRYPTO_NETWORK;
}

export function splitterAddress(): Address | null {
  const a = process.env.SPLITTER_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null;
}

/** One-signature checkout is available when the splitter + relayer are configured. */
export function splitterCheckoutEnabled(): boolean {
  return Boolean(splitterAddress() && process.env.CRYPTO_RELAYER_PRIVATE_KEY);
}

/** The platform's gas-only relayer account, or null when unconfigured. */
export function relayerAccount() {
  const pk = process.env.CRYPTO_RELAYER_PRIVATE_KEY;
  if (!pk) return null;
  return privateKeyToAccount((pk.startsWith('0x') ? pk : '0x' + pk) as Hex);
}

export function chainConfig() {
  return NETWORKS[cryptoNetwork()];
}

const config = chainConfig;

export function cryptoPublicClient() {
  return publicClient();
}

function publicClient() {
  const cfg = config();
  return createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
}

/**
 * The EIP-3009 nonce commits the buyer's signature to the exact payout list —
 * MUST mirror RivrSplitter.computeNonce (keccak256(abi.encode(salt, payouts))).
 */
export function computeSplitNonce(salt: Hex, payouts: SplitPayout[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        {
          type: 'tuple[]',
          components: [
            { type: 'address', name: 'to' },
            { type: 'uint256', name: 'amount' },
          ],
        },
      ],
      [salt, payouts],
    ),
  );
}

let cachedDomain: { name: string; version: string; network: CryptoNetwork } | null = null;

/**
 * Builds the EIP-712 typed data the BUYER signs. Domain name/version are read
 * from the token contract (they differ between mainnet and testnet USDC).
 */
export async function buildAuthorizationTypedData(params: {
  buyer: Address;
  totalUnits: bigint;
  salt: Hex;
  payouts: SplitPayout[];
  validBeforeUnix: number;
}) {
  const cfg = config();
  const net = cryptoNetwork();
  if (!cachedDomain || cachedDomain.network !== net) {
    const client = publicClient();
    const [name, version] = await Promise.all([
      client.readContract({ address: cfg.usdc, abi: USDC_META_ABI, functionName: 'name' }),
      client.readContract({ address: cfg.usdc, abi: USDC_META_ABI, functionName: 'version' }),
    ]);
    cachedDomain = { name, version, network: net };
  }
  const splitter = splitterAddress();
  if (!splitter) throw new Error('SPLITTER_ADDRESS is not configured');

  return {
    domain: {
      name: cachedDomain.name,
      version: cachedDomain.version,
      chainId: cfg.chain.id,
      verifyingContract: cfg.usdc,
    },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization' as const,
    message: {
      from: params.buyer,
      to: splitter,
      value: params.totalUnits.toString(),
      validAfter: '0',
      validBefore: String(params.validBeforeUnix),
      nonce: computeSplitNonce(params.salt, params.payouts),
    },
  };
}

/**
 * Relays the buyer-signed authorization through the splitter and verifies the
 * atomic fan-out by decoding the Transfer events in the receipt.
 *
 * @returns The transaction hash after on-chain success.
 * @throws {Error} When the relayer key is missing, the transaction reverts,
 *   or the expected payout legs are absent from the receipt.
 */
export async function relaySplit(params: {
  buyer: Address;
  totalUnits: bigint;
  salt: Hex;
  payouts: SplitPayout[];
  validBeforeUnix: number;
  signature: Hex;
}): Promise<Hex> {
  const relayerPk = process.env.CRYPTO_RELAYER_PRIVATE_KEY;
  if (!relayerPk) throw new Error('CRYPTO_RELAYER_PRIVATE_KEY is not configured');
  const splitter = splitterAddress();
  if (!splitter) throw new Error('SPLITTER_ADDRESS is not configured');

  const sig = params.signature;
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('Malformed signature');
  const r = sig.slice(0, 66) as Hex;
  const s = ('0x' + sig.slice(66, 130)) as Hex;
  const v = parseInt(sig.slice(130, 132), 16);

  const cfg = config();
  const account = privateKeyToAccount(
    (relayerPk.startsWith('0x') ? relayerPk : '0x' + relayerPk) as Hex,
  );
  const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const client = publicClient();

  const hash = await wallet.writeContract({
    address: splitter,
    abi: SPLITTER_ABI,
    functionName: 'splitWithAuthorization',
    args: [
      params.buyer,
      params.totalUnits,
      0n,
      BigInt(params.validBeforeUnix),
      params.salt,
      params.payouts,
      v,
      r,
      s,
    ],
  });

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    throw new Error(`Split transaction reverted: ${hash}`);
  }

  // Belt over suspenders: every payout leg must appear as a Transfer from the
  // splitter in this receipt (the contract enforces it; this catches ABI or
  // deployment mismatches loudly instead of recording a phantom sale).
  const legs = new Map<string, bigint>();
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      if ((ev.args.from as string).toLowerCase() === splitter.toLowerCase()) {
        const key = (ev.args.to as string).toLowerCase();
        legs.set(key, (legs.get(key) ?? 0n) + (ev.args.value as bigint));
      }
    } catch {
      // non-Transfer log
    }
  }
  for (const payout of params.payouts) {
    if ((legs.get(payout.to.toLowerCase()) ?? 0n) < payout.amount) {
      throw new Error(`Payout leg missing in receipt for ${payout.to}`);
    }
  }

  return hash;
}
