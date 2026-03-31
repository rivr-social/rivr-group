'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { CreditCard, DollarSign, Loader2 } from 'lucide-react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

const PRESET_AMOUNTS = [500, 1000, 2500, 5000, 10000];
const STRIPE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = STRIPE_KEY ? loadStripe(STRIPE_KEY) : null;

interface WalletDepositDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function DepositPaymentForm({
  amountCents,
  clientSecret,
  onBack,
  onClose,
  onSuccess,
}: {
  amountCents: number;
  clientSecret: string;
  onBack: () => void;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    try {
      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        redirect: 'if_required',
      });

      if (confirmError) {
        setError(confirmError.message ?? 'Unable to confirm payment.');
        return;
      }

      toast({
        title: 'Deposit submitted',
        description:
          paymentIntent?.status === 'succeeded'
            ? `${formatDollars(amountCents)} was added to your wallet.`
            : `${formatDollars(amountCents)} is processing and will appear after confirmation.`,
      });

      onSuccess?.();
      onClose();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 py-2">
      <div className="rounded-lg bg-muted/50 p-3 text-center">
        <span className="text-2xl font-bold">{formatDollars(amountCents)}</span>
        <p className="mt-1 text-xs text-muted-foreground">will be added to your wallet</p>
      </div>

      <PaymentElement />

      {error && (
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack} disabled={submitting} className="flex-1">
          Back
        </Button>
        <Button onClick={handleConfirm} disabled={submitting || !stripe || !elements} className="flex-1">
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <CreditCard className="mr-2 h-4 w-4" />
              Confirm {formatDollars(amountCents)}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export default function WalletDepositDialog({
  open,
  onClose,
  onSuccess,
}: WalletDepositDialogProps) {
  const { toast } = useToast();
  const [amountCents, setAmountCents] = useState(1000);
  const [customAmount, setCustomAmount] = useState('');
  const [loadingIntent, setLoadingIntent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useCustom, setUseCustom] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  const effectiveAmountCents = useMemo(
    () => (useCustom ? Math.round(parseFloat(customAmount || '0') * 100) : amountCents),
    [amountCents, customAmount, useCustom],
  );

  const resetState = useCallback(() => {
    setAmountCents(1000);
    setCustomAmount('');
    setLoadingIntent(false);
    setError(null);
    setUseCustom(false);
    setClientSecret(null);
  }, []);

  const handlePresetSelect = useCallback((cents: number) => {
    setAmountCents(cents);
    setUseCustom(false);
    setError(null);
  }, []);

  const handleCustomChange = useCallback((value: string) => {
    setCustomAmount(value);
    setUseCustom(true);
    setError(null);
  }, []);

  const handleCreateIntent = async () => {
    if (effectiveAmountCents < 100) {
      setError('Minimum deposit is $1.00');
      return;
    }
    if (effectiveAmountCents > 100_000) {
      setError('Maximum deposit is $1,000.00');
      return;
    }

    setLoadingIntent(true);
    setError(null);

    try {
      const response = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents: effectiveAmountCents }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to create deposit');
        return;
      }

      if (!data.clientSecret) {
        setError('Stripe did not return a payment form.');
        return;
      }

      setClientSecret(data.clientSecret);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoadingIntent(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          resetState();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Add Money to Wallet
          </DialogTitle>
          <DialogDescription>
            Fund your wallet using a credit or debit card.
          </DialogDescription>
        </DialogHeader>

        {!STRIPE_KEY ? (
          <div className="space-y-4 py-2">
            <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Payment processing is not configured. Please contact support.
            </p>
          </div>
        ) : clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <DepositPaymentForm
              amountCents={effectiveAmountCents}
              clientSecret={clientSecret}
              onBack={() => {
                setClientSecret(null);
                setError(null);
              }}
              onClose={() => {
                resetState();
                onClose();
              }}
              onSuccess={onSuccess}
            />
          </Elements>
        ) : (
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm text-muted-foreground">Select amount</Label>
              <div className="mt-2 grid grid-cols-5 gap-2">
                {PRESET_AMOUNTS.map((cents) => (
                  <Button
                    key={cents}
                    variant={!useCustom && amountCents === cents ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handlePresetSelect(cents)}
                    className="text-sm"
                  >
                    ${cents / 100}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label htmlFor="custom-amount" className="text-sm text-muted-foreground">
                Or enter custom amount
              </Label>
              <div className="relative mt-1">
                <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="custom-amount"
                  type="number"
                  min="1"
                  max="1000"
                  step="0.01"
                  placeholder="0.00"
                  value={customAmount}
                  onChange={(e) => handleCustomChange(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>

            <div className="rounded-lg bg-muted/50 p-3 text-center">
              <span className="text-2xl font-bold">{formatDollars(effectiveAmountCents)}</span>
              <p className="mt-1 text-xs text-muted-foreground">ready for Stripe checkout</p>
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              onClick={handleCreateIntent}
              disabled={loadingIntent || effectiveAmountCents < 100}
              className="w-full"
            >
              {loadingIntent ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading payment form...
                </>
              ) : (
                <>
                  <CreditCard className="mr-2 h-4 w-4" />
                  Continue to Payment
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
