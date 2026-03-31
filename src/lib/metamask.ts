/**
 * Client-side MetaMask / EIP-1193 interaction utilities for Base network.
 *
 * Supports:
 * - Detecting and connecting MetaMask
 * - Switching to Base mainnet (chain ID 8453)
 * - Sending native ETH payments on Base
 * - Sending USDC (ERC-20) payments on Base
 * - Split payments: seller receives net amount, platform receives fee
 *
 * @module lib/metamask
 */

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      isMetaMask?: boolean
      on?: (event: string, handler: (...args: unknown[]) => void) => void
    }
  }
}

// ─── Base Network Constants ──────────────────────────────────────────────────

/** Base mainnet chain ID */
export const BASE_CHAIN_ID = 8453
export const BASE_CHAIN_ID_HEX = "0x2105"

/** Base mainnet USDC contract (Circle bridged) */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

/** USDC uses 6 decimals on Base */
export const USDC_DECIMALS = 6

/** Platform safe wallet on Base */
export const PLATFORM_BASE_WALLET = "0x8C01957270a9ce581adEB3C8187EB187E1C94549"

/** ERC-20 transfer function selector: transfer(address,uint256) */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb"

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Checks whether the MetaMask browser extension is available.
 */
export function isMetaMaskAvailable(): boolean {
  if (typeof window === "undefined") return false
  return !!(window.ethereum && window.ethereum.isMetaMask)
}

/**
 * Checks whether any Ethereum provider is available (MetaMask or otherwise).
 */
export function isEthereumAvailable(): boolean {
  if (typeof window === "undefined") return false
  return !!window.ethereum
}

// ─── Connection ──────────────────────────────────────────────────────────────

/**
 * Requests MetaMask account access and returns the first connected address.
 *
 * @returns The connected Ethereum address (0x-prefixed, 42 chars).
 * @throws {Error} If MetaMask is not available or the user rejects the request.
 */
export async function connectMetaMask(): Promise<string> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[]

  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts returned from MetaMask. The user may have rejected the request.")
  }

  return accounts[0]
}

// ─── Network Switching ───────────────────────────────────────────────────────

/**
 * Ensures MetaMask is connected to Base mainnet (chain 8453).
 * If not on Base, prompts the user to switch. If Base isn't added, adds it.
 *
 * @throws {Error} If the user rejects the network switch.
 */
export async function ensureBaseNetwork(): Promise<void> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available.")
  }

  const currentChainId = (await window.ethereum.request({
    method: "eth_chainId",
  })) as string

  if (currentChainId === BASE_CHAIN_ID_HEX) return

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    })
  } catch (switchError: unknown) {
    const err = switchError as { code?: number }
    // Error 4902 = chain not added to MetaMask
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_CHAIN_ID_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      })
    } else {
      throw new Error("Please switch to Base network in MetaMask to continue.")
    }
  }
}

/**
 * Gets the current chain ID as a number.
 */
export async function getCurrentChainId(): Promise<number> {
  if (typeof window === "undefined" || !window.ethereum) return 0
  const hex = (await window.ethereum.request({ method: "eth_chainId" })) as string
  return parseInt(hex, 16)
}

// ─── ETH Payments (Base) ─────────────────────────────────────────────────────

/**
 * Sends native ETH on Base to a target address.
 *
 * @param toAddress - The recipient address.
 * @param amountWei - The amount in wei (decimal string or hex).
 * @returns The transaction hash.
 */
export async function sendEthPayment(toAddress: string, amountWei: string): Promise<string> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  await ensureBaseNetwork()

  const hexAmount = amountWei.startsWith("0x")
    ? amountWei
    : `0x${BigInt(amountWei).toString(16)}`

  const accounts = (await window.ethereum.request({
    method: "eth_accounts",
  })) as string[]

  if (!accounts || accounts.length === 0) {
    throw new Error("No connected MetaMask account. Please connect first.")
  }

  const txHash = (await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: accounts[0],
        to: toAddress,
        value: hexAmount,
      },
    ],
  })) as string

  return txHash
}

// ─── USDC Payments (Base) ────────────────────────────────────────────────────

/**
 * Encodes an ERC-20 transfer(address, uint256) call.
 */
function encodeErc20Transfer(toAddress: string, amount: bigint): string {
  // Pad address to 32 bytes (remove 0x prefix, left-pad to 64 hex chars)
  const paddedAddress = toAddress.slice(2).toLowerCase().padStart(64, "0")
  // Pad amount to 32 bytes
  const paddedAmount = amount.toString(16).padStart(64, "0")
  return `${ERC20_TRANSFER_SELECTOR}${paddedAddress}${paddedAmount}`
}

/**
 * Sends USDC on Base to a target address.
 *
 * @param toAddress - The recipient address.
 * @param amountUsdc - The amount in USDC (e.g. 10.50 for $10.50).
 * @returns The transaction hash.
 */
export async function sendUsdcPayment(toAddress: string, amountUsdc: number): Promise<string> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  await ensureBaseNetwork()

  const accounts = (await window.ethereum.request({
    method: "eth_accounts",
  })) as string[]

  if (!accounts || accounts.length === 0) {
    throw new Error("No connected MetaMask account. Please connect first.")
  }

  // Convert dollar amount to USDC smallest unit (6 decimals)
  const usdcAmount = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS))
  const data = encodeErc20Transfer(toAddress, usdcAmount)

  const txHash = (await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: accounts[0],
        to: BASE_USDC_ADDRESS,
        data,
        value: "0x0",
      },
    ],
  })) as string

  return txHash
}

// ─── Split Payments ──────────────────────────────────────────────────────────

/** Result of a split crypto payment (seller + platform fee). */
export interface CryptoPaymentResult {
  sellerTxHash: string
  platformFeeTxHash: string
  currency: "ETH" | "USDC"
  network: "base"
  sellerAmountFormatted: string
  platformFeeFormatted: string
}

/**
 * Executes a split crypto payment on Base: sends the seller their net amount
 * and sends the platform fee to the Rivr safe wallet.
 *
 * For USDC: amounts are in dollars (converted to 6-decimal USDC).
 * For ETH: amounts are in ETH (converted to wei). Caller must provide the
 * ETH equivalent of the USD amounts via a price feed.
 *
 * @param currency - "USDC" or "ETH"
 * @param sellerAddress - The seller's Base wallet address.
 * @param sellerAmountUsd - Net amount to seller in USD.
 * @param platformFeeUsd - Platform fee in USD.
 * @param ethPriceUsd - Current ETH price in USD (required when currency is ETH).
 * @returns Transaction hashes for both payments.
 */
export async function executeSplitCryptoPayment(
  currency: "USDC" | "ETH",
  sellerAddress: string,
  sellerAmountUsd: number,
  platformFeeUsd: number,
  ethPriceUsd?: number
): Promise<CryptoPaymentResult> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  await ensureBaseNetwork()

  if (currency === "USDC") {
    // USDC is 1:1 with USD
    const sellerTxHash = await sendUsdcPayment(sellerAddress, sellerAmountUsd)
    const platformFeeTxHash = await sendUsdcPayment(PLATFORM_BASE_WALLET, platformFeeUsd)

    return {
      sellerTxHash,
      platformFeeTxHash,
      currency: "USDC",
      network: "base",
      sellerAmountFormatted: `${sellerAmountUsd.toFixed(2)} USDC`,
      platformFeeFormatted: `${platformFeeUsd.toFixed(2)} USDC`,
    }
  }

  // ETH path
  if (!ethPriceUsd || ethPriceUsd <= 0) {
    throw new Error("ETH price is required for ETH payments.")
  }

  const sellerEth = sellerAmountUsd / ethPriceUsd
  const platformFeeEth = platformFeeUsd / ethPriceUsd

  // Convert to wei (18 decimals)
  const sellerWei = BigInt(Math.round(sellerEth * 1e18)).toString()
  const platformFeeWei = BigInt(Math.round(platformFeeEth * 1e18)).toString()

  const sellerTxHash = await sendEthPayment(sellerAddress, sellerWei)
  const platformFeeTxHash = await sendEthPayment(PLATFORM_BASE_WALLET, platformFeeWei)

  return {
    sellerTxHash,
    platformFeeTxHash,
    currency: "ETH",
    network: "base",
    sellerAmountFormatted: `${sellerEth.toFixed(6)} ETH`,
    platformFeeFormatted: `${platformFeeEth.toFixed(6)} ETH`,
  }
}

// ─── Balance Queries ─────────────────────────────────────────────────────────

/**
 * Retrieves the native ETH balance on Base for the given address.
 *
 * @param address - The address to query.
 * @returns The balance in wei as a decimal string.
 */
export async function getEthBalance(address: string): Promise<string> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  const hexBalance = (await window.ethereum.request({
    method: "eth_getBalance",
    params: [address, "latest"],
  })) as string

  return BigInt(hexBalance).toString()
}

/**
 * Retrieves the USDC balance on Base for the given address.
 *
 * @param address - The address to query.
 * @returns The balance in USDC (human-readable, e.g. "125.50").
 */
export async function getUsdcBalance(address: string): Promise<string> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not available in this browser.")
  }

  // balanceOf(address) selector = 0x70a08231
  const paddedAddress = address.slice(2).toLowerCase().padStart(64, "0")
  const data = `0x70a08231${paddedAddress}`

  const result = (await window.ethereum.request({
    method: "eth_call",
    params: [{ to: BASE_USDC_ADDRESS, data }, "latest"],
  })) as string

  const balance = BigInt(result)
  const whole = balance / BigInt(10 ** USDC_DECIMALS)
  const fractional = balance % BigInt(10 ** USDC_DECIMALS)
  return `${whole}.${fractional.toString().padStart(USDC_DECIMALS, "0")}`
}
