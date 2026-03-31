import { Skeleton } from "@/components/ui/skeleton"

export default function JobDetailLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      <Skeleton className="h-5 w-20" />

      {/* Job header */}
      <div className="rounded-lg border">
        <div className="p-6 space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
          <div className="flex gap-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
        <div className="p-6 pt-0">
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      </div>

      {/* Tabs */}
      <Skeleton className="h-10 w-full" />

      {/* Tab content */}
      <div className="rounded-lg border p-6 space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  )
}
