'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Send, Loader2, DollarSign } from 'lucide-react';
import { sendMoneyAction } from '@/app/actions/wallet';

/**
 * Send money dialog for peer-to-peer wallet transfers.
 * Used in wallet transfer flows where users send funds directly to another user.
 * Key props:
 * - `open`: Controls dialog visibility.
 * - `onClose`: Closes the dialog.
 * - `recipientId` / `recipientName`: Optional prefilled recipient context.
 * - `onSuccess`: Optional callback invoked after a successful transfer.
 */
interface SendMoneyDialogProps {
  open: boolean;
  onClose: () => void;
  recipientId?: string;
  recipientName?: string;
  onSuccess?: () => void;
}

/**
 * Renders a transfer modal with recipient, amount, and optional message inputs.
 *
 * @param {SendMoneyDialogProps} props Dialog control and transfer context.
 * @param {boolean} props.open Whether the dialog is open.
 * @param {() => void} props.onClose Called when the dialog should close.
 * @param {string} [props.recipientId] Optional prefilled recipient id.
 * @param {string} [props.recipientName] Optional prefilled recipient display name.
 * @param {() => void} [props.onSuccess] Optional callback after successful transfer.
 */
export default function SendMoneyDialog({
  open,
  onClose,
  recipientId: initialRecipientId,
  recipientName: initialRecipientName,
  onSuccess,
}: SendMoneyDialogProps) {
  const { toast } = useToast();
  // State tracks transfer inputs and request lifecycle.
  const [recipientId, setRecipientId] = useState(initialRecipientId || '');
  const [recipientName] = useState(initialRecipientName || '');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form state when dialog closes.
  useEffect(() => {
    if (!open) {
      setRecipientId(initialRecipientId || '');
      setAmount('');
      setMessage('');
      setError(null);
      setLoading(false);
    }
  }, [open, initialRecipientId]);

  // Convert user-entered dollars to integer cents for server action input.
  const amountCents = Math.round(parseFloat(amount || '0') * 100);

  // Event handler: validates inputs, calls transfer action, and updates dialog state.
  const handleSend = async () => {
    // Client-side validation before making the transfer request.
    if (!recipientId.trim()) {
      setError('Please select a recipient.');
      return;
    }
    if (amountCents < 1) {
      setError('Amount must be at least $0.01');
      return;
    }
    if (amountCents > 50_000) {
      setError('Maximum transfer is $500.00');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Server action side effect: submit a wallet-to-wallet transfer.
      const result = await sendMoneyAction(
        recipientId,
        amountCents,
        message || undefined
      );

      if (!result.success) {
        setError(result.error || 'Transfer failed.');
        return;
      }

      toast({
        title: 'Money sent',
        description: `$${(amountCents / 100).toFixed(2)} sent${recipientName ? ` to ${recipientName}` : ''}.`,
      });

      setAmount('');
      setMessage('');
      onSuccess?.();
      onClose();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            Send Money
          </DialogTitle>
          <DialogDescription>
            Transfer funds from your wallet to another user.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Recipient */}
          {/* Conditional rendering: show read-only recipient name when prefilled, else editable recipient ID field. */}
          {recipientName ? (
            <div>
              <Label className="text-sm text-muted-foreground">To</Label>
              <p className="text-sm font-medium mt-1">{recipientName}</p>
            </div>
          ) : (
            <div>
              <Label htmlFor="recipient" className="text-sm text-muted-foreground">
                Recipient ID
              </Label>
              <Input
                id="recipient"
                placeholder="User ID"
                value={recipientId}
                onChange={(e) => {
                  setRecipientId(e.target.value);
                  setError(null);
                }}
                className="mt-1"
              />
            </div>
          )}

          {/* Amount */}
          <div>
            <Label htmlFor="send-amount" className="text-sm text-muted-foreground">
              Amount
            </Label>
            <div className="relative mt-1">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="send-amount"
                type="number"
                min="0.01"
                max="500"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
                className="pl-8"
              />
            </div>
          </div>

          {/* Message */}
          <div>
            <Label htmlFor="send-message" className="text-sm text-muted-foreground">
              Message (optional)
            </Label>
            <Textarea
              id="send-message"
              placeholder="What's this for?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="mt-1 resize-none"
              rows={2}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md p-2">
              {error}
            </p>
          )}

          <Button
            onClick={handleSend}
            disabled={loading || amountCents < 1 || !recipientId.trim()}
            className="w-full"
          >
            {/* Conditional rendering: swap button content while transfer is in progress. */}
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Send ${(amountCents / 100).toFixed(2)}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
