"use client"

/**
 * MetaMask connect/disconnect button for the profile wallet tab.
 *
 * Detects MetaMask availability, allows the user to connect their wallet,
 * and persists the ETH address via the `setEthAddressAction` server action.
 *
 * @module components/metamask-connect-button
 */

import { useCallback, useEffect, useState } from "react"
import { Loader2, Unplug, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { isMetaMaskAvailable, connectMetaMask } from "@/lib/metamask"
import { setEthAddressAction } from "@/app/actions/wallet"

interface MetaMaskConnectButtonProps {
  currentEthAddress?: string | null
}

/**
 * Truncates an Ethereum address for display (e.g. 0x1234...5678).
 */
function truncateAddress(address: string): string {
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/**
 * Button component for connecting/disconnecting MetaMask.
 *
 * States:
 * - No MetaMask detected: disabled button with informational text
 * - Not connected: clickable "Connect MetaMask" button
 * - Connecting: spinner state
 * - Connected: shows truncated address with disconnect option
 */
export function MetaMaskConnectButton({
  currentEthAddress,
}: MetaMaskConnectButtonProps) {
  const { toast } = useToast()
  const [metamaskDetected, setMetamaskDetected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [ethAddress, setEthAddress] = useState<string | null>(currentEthAddress ?? null)

  useEffect(() => {
    setMetamaskDetected(isMetaMaskAvailable())
  }, [])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    try {
      const address = await connectMetaMask()
      const result = await setEthAddressAction(address)

      if (!result.success) {
        toast({
          title: "Failed to save address",
          description: result.error ?? "Could not persist your ETH address. Please try again.",
          variant: "destructive",
        })
        setConnecting(false)
        return
      }

      setEthAddress(address)
      toast({
        title: "MetaMask connected",
        description: `Linked address ${truncateAddress(address)}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred."
      toast({
        title: "Connection failed",
        description: message,
        variant: "destructive",
      })
    } finally {
      setConnecting(false)
    }
  }, [toast])

  const handleDisconnect = useCallback(async () => {
    setConnecting(true)
    try {
      // Clear the stored ETH address by setting it to an empty string
      // The server action validates format, so we pass a sentinel value
      // that the backend interprets as "remove". For now, we clear local state.
      const result = await setEthAddressAction("")
      if (result.success) {
        setEthAddress(null)
        toast({ title: "MetaMask disconnected", description: "Your ETH address has been removed." })
      } else {
        // If the server rejects empty string, just clear locally
        setEthAddress(null)
        toast({ title: "MetaMask disconnected", description: "Your ETH address has been removed locally." })
      }
    } catch {
      setEthAddress(null)
      toast({ title: "MetaMask disconnected", description: "Your ETH address has been removed locally." })
    } finally {
      setConnecting(false)
    }
  }, [toast])

  // MetaMask not installed
  if (!metamaskDetected) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Wallet className="h-4 w-4 mr-2" />
        MetaMask not detected
      </Button>
    )
  }

  // Currently connecting
  if (connecting) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Connecting...
      </Button>
    )
  }

  // Connected state
  if (ethAddress) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono text-muted-foreground">
          {truncateAddress(ethAddress)}
        </span>
        <Button variant="ghost" size="sm" onClick={handleDisconnect}>
          <Unplug className="h-4 w-4 mr-1" />
          Disconnect
        </Button>
      </div>
    )
  }

  // Not connected
  return (
    <Button variant="outline" size="sm" onClick={handleConnect}>
      <Wallet className="h-4 w-4 mr-2" />
      Connect MetaMask
    </Button>
  )
}
