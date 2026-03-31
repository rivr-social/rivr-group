import { Skeleton } from "@/components/ui/skeleton"

export default function CreateLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <Skeleton className="h-8 w-40 mb-6" />
      <Skeleton className="h-10 w-full mb-6" />
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-32" />
      </div>
    </div>
  )
}
