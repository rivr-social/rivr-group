"use client"

import { use, useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Image from "next/image"
import Link from "next/link"
import { ChevronLeft, Receipt, AlertCircle, CheckCircle, Clock, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { fetchMyReceipts } from "@/app/actions/graph"
import { requestRefundAction } from "@/app/actions/refund"
import { getPrimaryListingImage } from "@/lib/listing-images"

export default function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string; receiptId: string }>
}) {
  const { receiptId } = use(params)
  const router = useRouter()
  const [receipt, setReceipt] = useState<{
    id: string
    metadata: Record<string, unknown>
    createdAt: string
    listing: { id: string; name: string; description: string | null; metadata: Record<string, unknown> } | null
    seller: { id: string; name: string; username: string | null; image: string | null } | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refundPending, setRefundPending] = useState(false)
  const [refundError, setRefundError] = useState<string | null>(null)

  useEffect(() => {
    fetchMyReceipts().then(({ receipts }) => {
      const found = receipts.find((r) => r.id === receiptId)
      setReceipt(found || null)
      setLoading(false)
    })
  }, [receiptId])

  const handleRefund = async () => {
    setRefundPending(true)
    setRefundError(null)
    const result = await requestRefundAction(receiptId)
    if (result.success) {
      const { receipts } = await fetchMyReceipts()
      const updated = receipts.find((r) => r.id === receiptId)
      setReceipt(updated || receipt)
    } else {
      setRefundError(result.error || "Refund failed")
    }
    setRefundPending(false)
  }

  if (loading) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <p className="text-muted-foreground">Loading receipt...</p>
      </div>
    )
  }

  if (!receipt) {
    return (
      <div className="container max-w-3xl mx-auto px-4 py-8">
        <Button variant="ghost" className="mb-4" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5 mr-1" />Back
        </Button>
        <p className="text-muted-foreground">Receipt not found.</p>
      </div>
    )
  }

  const meta = receipt.metadata
  const listingMeta = (receipt.listing?.metadata ?? {}) as Record<string, unknown>
  const images = (listingMeta.images as string[]) || []
  const imageUrl = typeof listingMeta.imageUrl === "string" ? listingMeta.imageUrl : undefined
  const status = (meta.status as string) || "completed"
  const priceCents = (meta.priceCents as number) || 0
  const feeCents = (meta.feeCents as number) || 0
  const totalCents = (meta.totalCents as number) || priceCents
  const purchasedAt = (meta.purchasedAt as string) || receipt.createdAt
  const bookingDate = typeof meta.bookingDate === "string" ? meta.bookingDate : null
  const bookingSlot = typeof meta.bookingSlot === "string" ? meta.bookingSlot : null

  const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`

  const StatusIcon = status === "completed" ? CheckCircle
    : status === "refunded" ? RefreshCw
    : Clock

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 pb-20">
      <Button variant="ghost" className="mb-4 -ml-2" onClick={() => router.back()}>
        <ChevronLeft className="h-5 w-5 mr-1" />Back to Purchases
      </Button>

      {/* Listing preview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="relative aspect-square rounded-lg overflow-hidden border">
          <Image
            src={getPrimaryListingImage({ imageUrl, images })}
            alt={receipt.listing?.name || "Item"}
            fill
            className="object-cover"
          />
        </div>
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-bold">{receipt.listing?.name || "Unknown Item"}</h1>
            <Badge variant={
              (listingMeta.listingType as string) === "service" ? "secondary" : "default"
            } className="mt-1">
              {(listingMeta.listingType as string) === "service" ? "Service" : "Product"}
            </Badge>
          </div>
          <p className="text-muted-foreground">{receipt.listing?.description || ""}</p>
          {receipt.seller && (
            <div className="flex items-center pt-2">
              <Link href={`/profile/${receipt.seller.username || receipt.seller.id}`} className="flex items-center">
                <Avatar className="h-8 w-8 mr-2">
                  <AvatarImage src={receipt.seller.image || "/placeholder.svg"} alt={receipt.seller.name} />
                  <AvatarFallback>{receipt.seller.name.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{receipt.seller.name}</span>
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Receipt details card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Receipt Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={status === "completed" ? "default" : status === "refunded" ? "destructive" : "secondary"}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {status === "refund_requested" ? "Refund Pending" : status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Date</span>
            <span>{new Date(purchasedAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          {bookingDate && bookingSlot ? (
            <>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Booked Window</span>
                <span>{new Date(`${bookingDate}T00:00:00`).toLocaleDateString()} · {bookingSlot}</span>
              </div>
            </>
          ) : null}
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCents(priceCents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fees</span>
            <span>{formatCents(feeCents)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-bold text-lg">
            <span>Total</span>
            <span>{formatCents(totalCents)}</span>
          </div>
          {typeof meta.stripePaymentIntentId === "string" && (
            <>
              <Separator />
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Payment ID</span>
                <span className="font-mono text-muted-foreground">{meta.stripePaymentIntentId}</span>
              </div>
            </>
          )}
          {typeof meta.customerEmail === "string" && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Email</span>
              <span>{meta.customerEmail}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Refund section — only for Stripe card purchases */}
      {status === "completed" && typeof meta.stripePaymentIntentId === "string" && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">Need a refund?</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Request a refund for this purchase. The seller will be notified and the refund will be processed through Stripe.
                </p>
                {refundError && (
                  <p className="text-sm text-destructive mt-2">{refundError}</p>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  className="mt-3"
                  onClick={handleRefund}
                  disabled={refundPending}
                >
                  {refundPending ? "Processing..." : "Request Refund"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {status === "refund_requested" && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="font-medium">Refund Requested</p>
                <p className="text-sm text-muted-foreground">Your refund is being processed. You&apos;ll receive your money back soon.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {status === "refunded" && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="font-medium">Refunded</p>
                <p className="text-sm text-muted-foreground">
                  This purchase was refunded on {meta.refundedAt ? new Date(meta.refundedAt as string).toLocaleDateString() : "N/A"}.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
