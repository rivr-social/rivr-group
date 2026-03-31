import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { getMyTicketPurchasesAction, getTransactionHistoryAction } from "@/app/actions/wallet";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WalletTransactionView } from "@/types";

/**
 * Formats an ISO date string into a readable timestamp for purchase and transaction rows.
 *
 * @param isoDate Raw ISO-like date string.
 * @returns Formatted date string (fallbacks to original input if parsing fails).
 */
function formatHistoryDate(isoDate: string): string {
  try {
    return format(new Date(isoDate), "MMM d, yyyy 'at' h:mm a");
  } catch {
    return isoDate;
  }
}

/**
 * Maps wallet transaction statuses to badge variants so visual tone matches state.
 *
 * @param status Wallet transaction status value.
 * @returns Badge variant name.
 */
function getStatusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status.toLowerCase()) {
    case "completed":
      return "secondary";
    case "failed":
      return "destructive";
    case "pending":
      return "outline";
    default:
      return "default";
  }
}

/**
 * Produces a human-readable title for a transaction row.
 *
 * @param transaction Wallet transaction record.
 * @returns Best-available transaction display title.
 */
function getTransactionTitle(transaction: WalletTransactionView): string {
  return transaction.description ?? transaction.type.replace(/_/g, " ");
}

/**
 * Profile Purchases page.
 *
 * Route: `/profile/purchases`
 * Purpose: Shows the authenticated user's ticket purchase history in a dedicated view linked from the profile wallet tab.
 * Data requirements: Requires ticket purchase records from `getMyTicketPurchasesAction()`.
 *
 * Rendering: Server Component (no `"use client"` directive), so data is fetched on the server before HTML is streamed.
 * Metadata: This file does not export `metadata` or `generateMetadata`; route metadata is inherited from parent layouts.
 */
/**
 * Renders a read-only purchase history for ticket transactions.
 *
 * @returns Server-rendered purchase history UI for the current user.
 */
export default async function ProfilePurchasesPage() {
  // Fetch purchases + general transactions on the server; failures are represented by `success: false`.
  const [purchasesResult, transactionsResult] = await Promise.all([
    getMyTicketPurchasesAction(),
    getTransactionHistoryAction({ limit: 30, offset: 0 }),
  ]);
  // Normalize to an empty list so rendering logic stays simple.
  const purchases = purchasesResult.success && purchasesResult.purchases ? purchasesResult.purchases : [];
  const transactions =
    transactionsResult.success && transactionsResult.transactions ? transactionsResult.transactions : [];

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      <Link href="/profile" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to profile
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Purchase History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Conditional empty state when no purchases are available. */}
          {purchases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No ticket purchases yet. When you buy event tickets, they will appear here.
            </p>
          ) : null}

          {/* Render each purchase record as a summary card. */}
          {purchases.map((purchase) => (
            <div key={purchase.transactionId} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{purchase.ticketProductName}</p>
                <Badge variant="secondary">Completed</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {purchase.eventName ? `${purchase.eventName} · ` : ""}
                {formatHistoryDate(purchase.purchasedAt)}
              </p>
              <p className="text-sm text-muted-foreground">
                Amount: ${(purchase.amountCents / 100).toFixed(2)} · Fee: ${(purchase.feeCents / 100).toFixed(2)} · Total: ${purchase.totalDollars.toFixed(2)}
              </p>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Paid with {purchase.paymentMethod}
              </p>
              {/* Show event deep-link only when the purchase is associated with an event ID. */}
              {purchase.eventId ? (
                <Link href={`/events/${purchase.eventId}`} className="text-sm text-primary hover:underline">
                  View event
                </Link>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Wallet Transactions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No wallet transactions yet. Deposits, transfers, and purchases will appear here.
            </p>
          ) : null}

          {transactions.map((transaction) => (
            <div key={transaction.id} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium capitalize">{getTransactionTitle(transaction)}</p>
                <Badge variant={getStatusBadgeVariant(transaction.status)}>{transaction.status}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{formatHistoryDate(transaction.createdAt)}</p>
              <p className="text-sm text-muted-foreground">Amount: ${transaction.amountDollars.toFixed(2)}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
