import { Skeleton } from "@/components/ui/skeleton"

export default function EventsLoading() {
  return (
    <div className="container mx-auto px-4 py-6 flex items-center justify-center min-h-[50vh]">
      <Skeleton className="h-5 w-32" />
    </div>
  )
}
