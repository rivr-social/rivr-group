/**
 * @fileoverview PurchaseHistory - Marketplace purchase transaction history.
 *
 * Displays a filtered list of purchase-related wallet transactions
 * (marketplace_purchase, stripe_checkout, event_ticket) for the profile
 * wallet tab. Follows the same styling patterns as `wallet-history.tsx`.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ShoppingCart,
  CreditCard,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Ticket,
} from 'lucide-react';
import { getTransactionHistoryAction } from '@/app/actions/wallet';
import type { WalletTransactionView } from '@/types';

/** Transaction types that count as purchases. */
const PURCHASE_TYPES = new Set([
  'marketplace_purchase',
  'stripe_checkout',
  'event_ticket',
]);

/** Icon and label mapping for purchase transaction types. */
const PURCHASE_TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  marketplace_purchase: { icon: ShoppingCart, label: 'Marketplace', color: 'text-orange-600' },
  stripe_checkout: { icon: CreditCard, label: 'Card Purchase', color: 'text-blue-600' },
  event_ticket: { icon: Ticket, label: 'Ticket', color: 'text-purple-600' },
};

const PAGE_SIZE = 10;

interface PurchaseHistoryProps {
  walletId: string;
}

/**
 * Renders a paginated list of the user's purchase transactions.
 *
 * Fetches all transaction history and filters client-side for purchase types,
 * since the server action does not currently expose type filtering.
 *
 * @param props.walletId - The wallet ID (currently unused; transactions are
 *   fetched for the authenticated user's personal wallet via server action).
 */
export function PurchaseHistory({ walletId }: PurchaseHistoryProps) {
  // walletId is accepted for API consistency; the server action resolves the wallet internally.
  void walletId;

  const [allPurchases, setAllPurchases] = useState<WalletTransactionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(allPurchases.length / PAGE_SIZE));
  const paginatedPurchases = allPurchases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const loadPurchases = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch a large batch and filter client-side for purchase types.
      const result = await getTransactionHistoryAction({ limit: 200, offset: 0 });
      if (result.success && result.transactions) {
        const filtered = result.transactions.filter((tx) => PURCHASE_TYPES.has(tx.type));
        setAllPurchases(filtered);
      }
    } catch {
      // Silently handle fetch errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPurchases();
  }, [loadPurchases]);

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

  const getStatusVariant = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'completed':
        return 'default';
      case 'pending':
        return 'secondary';
      case 'failed':
        return 'destructive';
      default:
        return 'outline';
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Purchase History</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : allPurchases.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">
            No purchases yet.
          </p>
        ) : (
          <>
            <div className="divide-y">
              {paginatedPurchases.map((tx) => {
                const config = PURCHASE_TYPE_CONFIG[tx.type] || {
                  icon: ShoppingCart,
                  label: tx.type,
                  color: 'text-muted-foreground',
                };
                const Icon = config.icon;

                return (
                  <div key={tx.id} className="flex items-center gap-3 py-3 px-1">
                    <div className="rounded-full p-2 bg-orange-50">
                      <Icon className={`h-4 w-4 ${config.color}`} />
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
                        {tx.toWalletOwnerName && ` to ${tx.toWalletOwnerName}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-sm font-semibold text-red-600">
                        -${tx.amountDollars.toFixed(2)}
                      </span>
                      {tx.status !== 'completed' && (
                        <Badge
                          variant={getStatusVariant(tx.status)}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
