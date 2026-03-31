import { Skeleton } from "@/components/ui/skeleton"

export default function PurchasesLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      <Skeleton className="h-5 w-32" />

      {/* Purchase history card */}
      <div className="rounded-lg border">
        <div className="p-6">
          <Skeleton className="h-7 w-40 mb-4" />
        </div>
        <div className="p-6 pt-0 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-md border p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-72" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </div>

      {/* All wallet transactions card */}
      <div className="rounded-lg border">
        <div className="p-6">
          <Skeleton className="h-7 w-52 mb-4" />
        </div>
        <div className="p-6 pt-0 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-md border p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
