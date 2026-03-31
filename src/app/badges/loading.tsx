import { Skeleton } from "@/components/ui/skeleton"

export default function BadgesLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Title */}
      <Skeleton className="h-8 w-32" />

      {/* Tab bar */}
      <Skeleton className="h-10 w-full rounded-md" />

      {/* Badge grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-4 flex flex-col items-center gap-3">
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}
