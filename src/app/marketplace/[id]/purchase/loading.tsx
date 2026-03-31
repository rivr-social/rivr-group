import { Skeleton } from "@/components/ui/skeleton"

export default function PurchaseLoading() {
  return (
    <div className="container max-w-2xl mx-auto px-4 py-6 space-y-6">
      {/* Back button */}
      <Skeleton className="h-5 w-32" />

      {/* Title */}
      <Skeleton className="h-7 w-48" />

      {/* Product summary card */}
      <div className="rounded-lg border p-4 flex gap-4">
        <Skeleton className="h-20 w-20 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>

      {/* Quantity selector */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-10 w-10 rounded-md" />
        <Skeleton className="h-6 w-8" />
        <Skeleton className="h-10 w-10 rounded-md" />
      </div>

      {/* Payment method */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
      </div>

      {/* Order summary */}
      <div className="rounded-lg border p-4 space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="flex justify-between">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>

      {/* Checkout button */}
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  )
}
