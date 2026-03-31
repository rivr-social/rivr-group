import { Skeleton } from "@/components/ui/skeleton"

export default function RootLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 animate-in fade-in duration-200">
      {/* Nav placeholder */}
      <div className="flex items-center gap-3 mb-8">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-6 w-24" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>

      {/* Tab bar placeholder */}
      <Skeleton className="h-10 w-full rounded-md mb-6" />

      {/* Feed card placeholders */}
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-[140px] w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
