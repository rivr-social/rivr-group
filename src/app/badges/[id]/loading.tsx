import { Skeleton } from "@/components/ui/skeleton"

export default function BadgeDetailLoading() {
  return (
    <div className="container max-w-2xl mx-auto px-4 py-6 space-y-6">
      {/* Back link */}
      <Skeleton className="h-5 w-24" />

      {/* Badge icon + title */}
      <div className="flex flex-col items-center gap-4">
        <Skeleton className="h-24 w-24 rounded-full" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>

      {/* Requirements */}
      <div className="rounded-lg border p-4 space-y-3">
        <Skeleton className="h-5 w-28" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-48" />
          </div>
        ))}
      </div>

      {/* Action button */}
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  )
}
