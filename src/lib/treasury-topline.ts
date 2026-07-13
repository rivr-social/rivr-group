import type { WalletBalance } from "@/types"

/**
 * Group treasury topline: unallocated (main settlement wallet) + every fund
 * wallet's balance + Connect available balance. Previously the topline
 * showed only unallocated + Connect, so money parked in a fund vanished
 * from "Current Balance" (open-issues 2026-07-07/07-08).
 */
export function computeTreasuryTopline(
  walletBalance: Pick<WalletBalance, "balanceDollars" | "hasConnectAccount" | "connectAvailableCents">,
  fundsTotalCents: number,
  formatCurrency: (amount: number) => string
): { totalDollars: number; breakdown: string[] } {
  const fundsTotalDollars = fundsTotalCents / 100
  const connectAvailableDollars = walletBalance.hasConnectAccount
    ? (walletBalance.connectAvailableCents ?? 0) / 100
    : 0
  const totalDollars = walletBalance.balanceDollars + fundsTotalDollars + connectAvailableDollars
  const breakdown = [
    `Treasury: ${formatCurrency(walletBalance.balanceDollars)}`,
    fundsTotalCents > 0 ? `Funds: ${formatCurrency(fundsTotalDollars)}` : null,
    walletBalance.hasConnectAccount ? `Sales: ${formatCurrency(connectAvailableDollars)}` : null,
  ].filter((part): part is string => part !== null)

  return { totalDollars, breakdown }
}
