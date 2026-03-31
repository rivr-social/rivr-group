import { Skeleton } from "@/components/ui/skeleton"

export default function MainLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <Skeleton className="h-8 w-40 mb-6" />
      <Skeleton className="h-12 w-full mb-4" />
      <div className="space-y-4">
        <Skeleton className="h-[200px] w-full rounded-lg" />
        <Skeleton className="h-[200px] w-full rounded-lg" />
        <Skeleton className="h-[200px] w-full rounded-lg" />
      </div>
    </div>
  )
}
