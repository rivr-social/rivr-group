import { Skeleton } from "@/components/ui/skeleton"

export default function FinancialsLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 pb-20">
      <div className="flex items-center gap-4 mb-6">
        <Skeleton className="h-5 w-5" />
        <Skeleton className="h-8 w-48" />
      </div>

      {/* Summary card */}
      <div className="rounded-lg border p-6 mb-6 space-y-4">
        <div className="bg-muted/50 p-4 rounded-md space-y-3">
          <Skeleton className="h-6 w-24 mb-4" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex justify-between py-2 border-b last:border-0">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-36" />
        </div>
      </div>

      {/* Expenses section */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
        <Skeleton className="h-4 w-40 mx-auto" />
      </div>

      <Skeleton className="h-px w-full my-6" />

      {/* Payouts section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-9 w-32" />
        </div>
        <Skeleton className="h-3 w-80 mb-4" />
        <Skeleton className="h-4 w-32 mx-auto" />
      </div>
    </div>
  )
}
