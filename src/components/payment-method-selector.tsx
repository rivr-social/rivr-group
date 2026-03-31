"use client"

/**
 * RadioGroup-based payment method selector supporting card, wallet,
 * Stripe Connect balance, and crypto (MetaMask on Base) payment options.
 *
 * Each option is conditionally rendered based on availability props.
 * Crypto requires: listing accepts USDC/ETH AND user has connected a wallet.
 *
 * @module components/payment-method-selector
 */

import { useEffect, useState } from "react"
import { CreditCard, Wallet, Coins, AlertCircle } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { isEthereumAvailable } from "@/lib/metamask"

export type PaymentMethod = "card" | "wallet" | "crypto"

interface PaymentMethodSelectorProps {
  selected: PaymentMethod
  onChange: (method: PaymentMethod) => void
  cardAvailable?: boolean
  cardUnavailableReason?: string
  walletBalanceCents?: number
  hasEthAddress?: boolean
  isAuthenticated: boolean
  disabled?: boolean
  /** When true, the listing accepts crypto (USDC or ETH). Crypto option only shows when this is set. */
  listingAcceptsCrypto?: boolean
  /** The specific crypto currency the listing accepts (shown in the label). */
  listingCurrency?: string
}

/**
 * Renders a radio group of available payment methods.
 *
 * - **Card** is always visible.
 * - **Wallet** appears when the user is authenticated and has a positive balance.
 * - **Connect Balance** appears when connect funds are available.
 * - **Crypto** appears only when the listing accepts USDC/ETH AND the user has a connected wallet.
 *   If the listing accepts crypto but no wallet is connected, a disabled hint is shown.
 */
export function PaymentMethodSelector({
  selected,
  onChange,
  cardAvailable = true,
  cardUnavailableReason,
  walletBalanceCents,
  hasEthAddress,
  isAuthenticated,
  disabled,
  listingAcceptsCrypto,
  listingCurrency,
}: PaymentMethodSelectorProps) {
  const [ethAvailable, setEthAvailable] = useState(false)

  useEffect(() => {
    setEthAvailable(isEthereumAvailable())
  }, [])

  const showWallet = isAuthenticated && typeof walletBalanceCents === "number" && walletBalanceCents > 0

  // Crypto requires: listing accepts it AND user has a connected wallet address
  const walletConnected = !!hasEthAddress
  const showCryptoEnabled = !!listingAcceptsCrypto && walletConnected && ethAvailable
  const showCryptoDisabled = !!listingAcceptsCrypto && !walletConnected

  const cryptoLabel = listingCurrency === "USDC"
    ? "Pay with USDC on Base"
    : listingCurrency === "ETH"
    ? "Pay with ETH on Base"
    : "Pay with crypto on Base"

  const formatCents = (cents: number): string => {
    return `$${(cents / 100).toFixed(2)}`
  }

  return (
    <RadioGroup
      value={selected}
      onValueChange={(value) => onChange(value as PaymentMethod)}
      disabled={disabled}
      className="space-y-3"
    >
      {/* Card */}
      {cardAvailable ? (
        <div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors">
          <RadioGroupItem value="card" id="pm-card" className="mt-0.5" />
          <Label htmlFor="pm-card" className="flex-1 cursor-pointer">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Credit or debit card</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Processed securely via Stripe</p>
          </Label>
        </div>
      ) : (
        <div className="flex items-start space-x-3 p-3 rounded-lg border border-dashed opacity-60">
          <div className="mt-1.5 h-4 w-4" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-muted-foreground">Credit or debit card</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {cardUnavailableReason || "Seller has not enabled card payments yet."}
            </p>
          </div>
        </div>
      )}

      {/* Wallet - authenticated with balance */}
      {showWallet && (
        <div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors">
          <RadioGroupItem value="wallet" id="pm-wallet" className="mt-0.5" />
          <Label htmlFor="pm-wallet" className="flex-1 cursor-pointer">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Rivr Wallet</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Balance: {formatCents(walletBalanceCents!)}
            </p>
          </Label>
        </div>
      )}

      {/* Crypto - enabled: wallet connected + listing accepts crypto */}
      {showCryptoEnabled && (
        <div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors">
          <RadioGroupItem value="crypto" id="pm-crypto" className="mt-0.5" />
          <Label htmlFor="pm-crypto" className="flex-1 cursor-pointer">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Crypto Wallet</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{cryptoLabel}</p>
          </Label>
        </div>
      )}

      {/* Crypto - disabled hint: listing accepts crypto but no wallet connected */}
      {showCryptoDisabled && (
        <div className="flex items-start space-x-3 p-3 rounded-lg border border-dashed opacity-60">
          <div className="mt-1.5 h-4 w-4" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-muted-foreground">Crypto Wallet</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              Connect a wallet on your profile to pay with {listingCurrency || "crypto"}
            </p>
          </div>
        </div>
      )}
    </RadioGroup>
  )
}
