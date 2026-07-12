/**
 * Org treasury on a Safe (USDC on Base) — server-side primitives.
 *
 * The org's real money lives in a Safe multisig its officers control (RIVR
 * never holds a key). Officers sign Safe transactions IN THE APP with their
 * own browser wallets (EIP-712 `SafeTx` typed data — no Safe Transaction
 * Service, no trip to app.safe.global); the platform's gas-only relayer
 * executes once the threshold is met. Budgets use the canonical Safe
 * Allowance Module: directors approve a per-lead spending limit once, then
 * the lead pays members within it with a single signature and ZERO director
 * involvement (`executeAllowanceTransfer`, relayed).
 *
 * Canonical addresses (Safe v1.4.1 suite + Allowance Module v0.1.1) are the
 * same on Base and Base Sepolia; the Allowance Module address is hardcoded
 * because the safe-modules-deployments registry omits 84532.
 */
import {
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  hashTypedData,
  recoverTypedDataAddress,
  isAddress,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { chainConfig, cryptoPublicClient, relayerAccount } from '@/lib/crypto-splitter';

export const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address;
export const SAFE_SINGLETON_141 = '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address;
export const SAFE_TO_L2_SETUP = '0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54' as Address;
export const SAFE_L2_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as Address;
export const SAFE_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as Address;
export const ALLOWANCE_MODULE = '0xAA46724893dedD72658219405185Fb0Fc91e091C' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const SAFE_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function enableModule(address module)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);

const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);

const ALLOWANCE_ABI = parseAbi([
  'function addDelegate(address delegate)',
  'function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)',
  'function executeAllowanceTransfer(address safe, address token, address payable to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)',
]);

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

export interface SafeTxData {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface SafeSignature {
  signer: Address;
  signature: Hex;
}

function requireRelayerWallet() {
  const account = relayerAccount();
  if (!account) throw new Error('CRYPTO_RELAYER_PRIVATE_KEY is not configured');
  const cfg = chainConfig();
  return createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
}

/** Reads live Safe state (owners, threshold, nonce, module, USDC balance). */
export async function readSafeState(safe: Address) {
  const client = cryptoPublicClient();
  const cfg = chainConfig();
  const code = await client.getCode({ address: safe });
  if (!code || code === '0x') return null;
  const [owners, threshold, nonce, moduleEnabled, usdcUnits] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [ALLOWANCE_MODULE] }),
    client.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }),
  ]);
  return {
    owners: owners as readonly Address[],
    threshold: Number(threshold),
    nonce: Number(nonce),
    allowanceModuleEnabled: moduleEnabled as boolean,
    usdcCents: Number((usdcUnits as bigint) / 10_000n),
  };
}

/**
 * Deploys a fresh officer-owned Safe (chain-aware v1.4.1 web-app-equivalent
 * setup: the SafeToL2Setup delegatecall switches to the L2 singleton on L2
 * chains, so the deployment replays identically across Base networks). The
 * relayer pays gas; the officers own the result.
 */
export async function deployOrgSafe(owners: Address[], threshold: number, saltNonce: bigint): Promise<Address> {
  if (owners.length < 1 || owners.length > 5) throw new Error('1–5 officer addresses required');
  if (threshold < 1 || threshold > owners.length) throw new Error('Invalid threshold');
  const initializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [
      owners,
      BigInt(threshold),
      SAFE_TO_L2_SETUP,
      encodeFunctionData({
        abi: parseAbi(['function setupToL2(address l2Singleton)']),
        functionName: 'setupToL2',
        args: [SAFE_L2_SINGLETON],
      }),
      SAFE_FALLBACK_HANDLER,
      ZERO,
      0n,
      ZERO,
    ],
  });
  const wallet = requireRelayerWallet();
  const client = cryptoPublicClient();
  const hash = await wallet.writeContract({
    address: SAFE_PROXY_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_SINGLETON_141, initializer, saltNonce],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Safe deployment reverted: ${hash}`);
  // ProxyCreation(address indexed proxy, address singleton) — first log from the factory.
  const created = receipt.logs.find(
    (l: (typeof receipt.logs)[number]) => l.address.toLowerCase() === SAFE_PROXY_FACTORY.toLowerCase(),
  );
  if (!created?.topics?.[1]) throw new Error(`Safe deployed (${hash}) but proxy address not found in logs`);
  return getAddress('0x' + created.topics[1].slice(-40));
}

/** EIP-712 typed data an OFFICER signs for a Safe transaction (v1.4.1 SafeTx). */
export function buildSafeTxTypedData(safe: Address, tx: SafeTxData, nonce: number) {
  const cfg = chainConfig();
  return {
    domain: { chainId: cfg.chain.id, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx' as const,
    message: {
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: '0',
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: String(nonce),
    },
  };
}

export function safeTxHash(safe: Address, tx: SafeTxData, nonce: number): Hex {
  const t = buildSafeTxTypedData(safe, tx, nonce);
  return hashTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: {
      to: t.message.to,
      value: BigInt(t.message.value),
      data: t.message.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: BigInt(t.message.nonce),
    },
  });
}

/** Recovers the signer of an officer's SafeTx signature. */
export async function recoverSafeTxSigner(
  safe: Address,
  tx: SafeTxData,
  nonce: number,
  signature: Hex,
): Promise<Address> {
  const t = buildSafeTxTypedData(safe, tx, nonce);
  return recoverTypedDataAddress({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: {
      to: t.message.to,
      value: BigInt(t.message.value),
      data: t.message.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: BigInt(t.message.nonce),
    },
    signature,
  });
}

/**
 * Executes a fully-signed Safe transaction: signatures packed r||s||v sorted
 * ascending by signer address (the Safe contract's requirement); the relayer
 * (not an owner) submits and pays gas.
 */
export async function execSafeTransaction(
  safe: Address,
  tx: SafeTxData,
  signatures: SafeSignature[],
): Promise<Hex> {
  const sorted = [...signatures].sort((a, b) =>
    a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1,
  );
  const packed = ('0x' + sorted.map((s) => s.signature.slice(2)).join('')) as Hex;
  const wallet = requireRelayerWallet();
  const client = cryptoPublicClient();
  const hash = await wallet.writeContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [tx.to, tx.value, tx.data, 0, 0n, 0n, 0n, ZERO, ZERO, packed],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Safe execution reverted: ${hash}`);
  return hash;
}

/** Prebuilt Safe transactions for the budget lifecycle. */
export function budgetSafeTxs(safe: Address) {
  const cfg = chainConfig();
  return {
    enableModule: (): SafeTxData => ({
      to: safe,
      value: 0n,
      data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [ALLOWANCE_MODULE] }),
    }),
    addDelegate: (lead: Address): SafeTxData => ({
      to: ALLOWANCE_MODULE,
      value: 0n,
      data: encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: 'addDelegate', args: [lead] }),
    }),
    setAllowance: (lead: Address, amountCents: number, resetTimeMin: number): SafeTxData => ({
      to: ALLOWANCE_MODULE,
      value: 0n,
      data: encodeFunctionData({
        abi: ALLOWANCE_ABI,
        functionName: 'setAllowance',
        args: [lead, cfg.usdc, BigInt(amountCents) * 10_000n, resetTimeMin, 0],
      }),
    }),
    usdcTransfer: (to: Address, amountCents: number): SafeTxData => ({
      to: cfg.usdc,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [to, BigInt(amountCents) * 10_000n],
      }),
    }),
  };
}

/** Reads a lead's budget: [amountCents, spentCents, resetTimeMin, lastResetMin, nonce]. */
export async function readAllowance(safe: Address, delegate: Address) {
  const cfg = chainConfig();
  const client = cryptoPublicClient();
  const [amount, spent, resetTimeMin, lastResetMin, nonce] = (await client.readContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_ABI,
    functionName: 'getTokenAllowance',
    args: [safe, delegate, cfg.usdc],
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return {
    amountCents: Number(amount / 10_000n),
    spentCents: Number(spent / 10_000n),
    resetTimeMin: Number(resetTimeMin),
    lastResetMin: Number(lastResetMin),
    nonce: Number(nonce),
  };
}

export async function readDelegates(safe: Address): Promise<Address[]> {
  const client = cryptoPublicClient();
  const [results] = (await client.readContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_ABI,
    functionName: 'getDelegates',
    args: [safe, 0, 20],
  })) as readonly [readonly Address[], number];
  return [...results];
}

/**
 * EIP-712 typed data a LEAD signs to pay from their budget. The module's
 * domain is ONLY {chainId, verifyingContract}; field order fixed by
 * ALLOWANCE_TRANSFER_TYPEHASH; nonce comes from getTokenAllowance.
 */
export function buildAllowanceTransferTypedData(
  safe: Address,
  to: Address,
  amountCents: number,
  nonce: number,
) {
  const cfg = chainConfig();
  return {
    domain: { chainId: cfg.chain.id, verifyingContract: ALLOWANCE_MODULE },
    types: {
      AllowanceTransfer: [
        { name: 'safe', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint96' },
        { name: 'paymentToken', type: 'address' },
        { name: 'payment', type: 'uint96' },
        { name: 'nonce', type: 'uint16' },
      ],
    },
    primaryType: 'AllowanceTransfer' as const,
    message: {
      safe,
      token: cfg.usdc,
      to,
      amount: (BigInt(amountCents) * 10_000n).toString(),
      paymentToken: ZERO,
      payment: '0',
      nonce: String(nonce),
    },
  };
}

/** Relays a lead-signed budget payout; returns the tx hash on success. */
export async function relayAllowanceTransfer(params: {
  safe: Address;
  delegate: Address;
  to: Address;
  amountCents: number;
  signature: Hex;
}): Promise<Hex> {
  const cfg = chainConfig();
  const wallet = requireRelayerWallet();
  const client = cryptoPublicClient();
  const hash = await wallet.writeContract({
    address: ALLOWANCE_MODULE,
    abi: ALLOWANCE_ABI,
    functionName: 'executeAllowanceTransfer',
    args: [
      params.safe,
      cfg.usdc,
      params.to,
      BigInt(params.amountCents) * 10_000n,
      ZERO,
      0n,
      params.delegate,
      params.signature,
    ],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Budget payout reverted: ${hash}`);
  return hash;
}

export function isValidAddress(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value);
}
