import { Skeleton } from "@/components/ui/skeleton"

export default function ConfirmedLoading() {
  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 text-center space-y-6">
      {/* Success icon */}
      <Skeleton className="h-16 w-16 rounded-full mx-auto" />

      {/* Title + subtitle */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-56 mx-auto" />
        <Skeleton className="h-4 w-40 mx-auto" />
      </div>

      {/* Listing thumbnail */}
      <Skeleton className="h-24 w-24 rounded-lg mx-auto" />

      {/* Order number */}
      <Skeleton className="h-5 w-36 mx-auto" />

      {/* Action buttons */}
      <div className="flex flex-col gap-3 max-w-xs mx-auto">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </div>
  )
}
