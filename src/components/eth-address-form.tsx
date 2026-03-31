'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Copy, Check, Pencil, Wallet } from 'lucide-react';
import { setEthAddressAction } from '@/app/actions/wallet';

/**
 * ETH address management form used in wallet/profile settings to view, edit, and persist
 * a member's Ethereum payout address.
 * Key props:
 * - `currentAddress`: the currently saved ETH address to prefill and display.
 * - `onUpdate`: optional callback invoked after a successful save.
 */
interface EthAddressFormProps {
  currentAddress?: string;
  onUpdate?: (address: string) => void;
}

/**
 * Renders a compact ETH address editor with copy-to-clipboard and save controls.
 *
 * @param {EthAddressFormProps} props - Component props.
 * @param {string} [props.currentAddress] - Existing address to display/edit.
 * @param {(address: string) => void} [props.onUpdate] - Callback fired after a successful save.
 */
export default function EthAddressForm({
  currentAddress,
  onUpdate,
}: EthAddressFormProps) {
  const { toast } = useToast();
  // Local form state tracks the input value and UI state for edit/save/copy flows.
  const [address, setAddress] = useState(currentAddress || '');
  const [editing, setEditing] = useState(!currentAddress);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Keep local state in sync when the parent provides a new saved address.
    if (currentAddress) {
      setAddress(currentAddress);
      setEditing(false);
    }
  }, [currentAddress]);

  const handleSave = async () => {
    // Client-side guard to prevent empty submissions before calling the server action.
    if (!address.trim()) {
      setError('Please enter an Ethereum address.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Server action side effect: persists the address in backend storage.
      const result = await setEthAddressAction(address.trim());

      if (!result.success) {
        setError(result.error || 'Failed to save address.');
        return;
      }

      toast({
        title: 'ETH address saved',
        description: 'Your Ethereum address has been updated.',
      });

      // Exit edit mode and notify parent consumers of the newly saved value.
      setEditing(false);
      onUpdate?.(address.trim());
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!address) return;
    // Browser side effect: writes address text to the system clipboard.
    await navigator.clipboard.writeText(address);
    setCopied(true);
    // Resets the temporary copied indicator after a short delay.
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Copied', description: 'ETH address copied to clipboard.' });
  };

  const formatAddress = (addr: string) => {
    // Shortens long wallet addresses for compact, readable display.
    if (addr.length <= 14) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  };

  // Conditional render: read-only display mode when an address exists and editing is off.
  if (!editing && address) {
    return (
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground flex items-center gap-1">
          <Wallet className="h-3.5 w-3.5" />
          ETH Address
        </Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm bg-muted/50 rounded-md px-3 py-2 font-mono truncate">
            {formatAddress(address)}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="eth-address" className="text-sm text-muted-foreground flex items-center gap-1">
        <Wallet className="h-3.5 w-3.5" />
        ETH Address
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="eth-address"
          type="text"
          placeholder="0x..."
          value={address}
          onChange={(e) => {
            // Keep input state and clear previous error as the user corrects the value.
            setAddress(e.target.value);
            setError(null);
          }}
          className="font-mono text-sm"
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={loading || !address.trim()}
        >
          {loading ? 'Saving...' : 'Save'}
        </Button>
        {currentAddress && (
          // Conditional render: only show cancel when there is an existing saved value.
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Revert unsaved edits back to the last persisted address.
              setAddress(currentAddress);
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {/* Conditional render: validation or save error feedback. */}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
