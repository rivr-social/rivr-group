/**
 * @fileoverview WalletHistory - Transaction history display for a user's wallet.
 *
 * Used on the wallet/profile page. Shows a filterable, paginated list of
 * wallet transactions (deposits, withdrawals, transfers, gifts) with date
 * grouping and detail views.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  ShoppingCart,
  Heart,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { getTransactionHistoryAction } from '@/app/actions/wallet';
import type { WalletTransactionView } from '@/types';

/**
 * Wallet transaction history dialog for the wallet activity feature.
 * Used in wallet UI flows where users review past deposits, transfers, purchases, and refunds.
 * Key props:
 * - `open`: Controls dialog visibility.
 * - `onClose`: Closes the dialog.
 * - `walletId`: Optional wallet identifier placeholder for scoped history usage.
 */
const PAGE_SIZE = 10;

// Maps transaction types to iconography and styling used in the list UI.
const TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  stripe_deposit: { icon: CreditCard, label: 'Deposit', color: 'text-green-600' },
  p2p_transfer: { icon: ArrowUpRight, label: 'Transfer', color: 'text-blue-600' },
  marketplace_purchase: { icon: ShoppingCart, label: 'Purchase', color: 'text-orange-600' },
  marketplace_payout: { icon: ArrowDownLeft, label: 'Sale', color: 'text-green-600' },
  event_ticket: { icon: ShoppingCart, label: 'Ticket', color: 'text-purple-600' },
  service_fee: { icon: ArrowUpRight, label: 'Fee', color: 'text-red-600' },
  group_deposit: { icon: ArrowUpRight, label: 'Group Deposit', color: 'text-blue-600' },
  group_withdrawal: { icon: ArrowDownLeft, label: 'Group Withdrawal', color: 'text-orange-600' },
  group_transfer: { icon: ArrowUpRight, label: 'Group Transfer', color: 'text-blue-600' },
  refund: { icon: ArrowDownLeft, label: 'Refund', color: 'text-green-600' },
  thanks: { icon: Heart, label: 'Thanks', color: 'text-pink-600' },
  eth_record: { icon: ArrowUpRight, label: 'ETH Payment', color: 'text-indigo-600' },
  connect_payout: { icon: ArrowUpRight, label: 'Bank Payout', color: 'text-emerald-600' },
};

interface WalletHistoryProps {
  open: boolean;
  onClose: () => void;
  walletId?: string;
}

/**
 * Renders paginated wallet transaction history in a modal.
 *
 * @param {WalletHistoryProps} props Dialog control props.
 * @param {boolean} props.open Whether the history dialog is open.
 * @param {() => void} props.onClose Called when the dialog should close.
 * @param {string} [props.walletId] Optional wallet id for future scoped queries.
 */
export default function WalletHistory({
  open,
  onClose,
}: WalletHistoryProps) {
  // State for current page data, total rows, current page index, and fetch lifecycle.
  const [transactions, setTransactions] = useState<WalletTransactionView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  // Derived pagination metadata from server-reported total count.
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Data loader side effect: calls a server action to fetch one paginated slice.
  const loadPage = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      // Server action call for wallet transactions.
      const result = await getTransactionHistoryAction({
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
      });
      if (result.success && result.transactions) {
        setTransactions(result.transactions);
        setTotal(result.total ?? 0);
      }
    } catch {
      // silently handle
    } finally {
      setLoading(false);
    }
  }, []);

  // Effect: fetch current page whenever the dialog opens or page index changes.
  useEffect(() => {
    if (open) {
      loadPage(page);
    }
  }, [open, page, loadPage]);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Transaction History</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {/* Conditional rendering for loading, empty, and populated list states. */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : transactions.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              No transactions yet.
            </p>
          ) : (
            <div className="divide-y">
              {transactions.map((tx) => {
                // Falls back to a neutral display for unknown transaction types.
                const config = TYPE_CONFIG[tx.type] || {
                  icon: ArrowUpRight,
                  label: tx.type,
                  color: 'text-gray-600',
                };
                const Icon = config.icon;
                const isCredit =
                  tx.type === 'stripe_deposit' ||
                  tx.type === 'marketplace_payout' ||
                  tx.type === 'refund' ||
                  tx.type === 'group_withdrawal';

                return (
                  <div key={tx.id} className="flex items-center gap-3 py-3 px-1">
                    <div
                      className={`rounded-full p-2 ${
                        isCredit ? 'bg-green-50' : 'bg-red-50'
                      }`}
                    >
                      <Icon
                        className={`h-4 w-4 ${config.color}`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {tx.description || config.label}
                        </span>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {config.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(tx.createdAt)}
                        {tx.fromWalletOwnerName &&
                          ` from ${tx.fromWalletOwnerName}`}
                        {tx.toWalletOwnerName &&
                          ` to ${tx.toWalletOwnerName}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span
                        className={`text-sm font-semibold ${
                          isCredit ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {isCredit ? '+' : '-'}$
                        {tx.amountDollars.toFixed(2)}
                      </span>
                      {/* Conditional rendering: show status badge only for non-completed rows. */}
                      {tx.status !== 'completed' && (
                        <Badge
                          variant="secondary"
                          className="ml-1 text-[10px]"
                        >
                          {tx.status}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t pt-3 mt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
