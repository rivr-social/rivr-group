import { Skeleton } from "@/components/ui/skeleton"

export default function TicketsLoading() {
  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-muted/30">
      {/* Left side - Event image */}
      <div className="w-full md:w-2/5 p-6 flex items-center justify-center">
        <Skeleton className="w-full max-w-md aspect-square rounded-xl" />
      </div>

      {/* Right side - Ticket form */}
      <div className="w-full md:w-3/5 bg-background p-8 md:p-12 min-h-screen">
        <div className="max-w-2xl space-y-8">
          <Skeleton className="h-5 w-32" />

          {/* Event header */}
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-lg" />
            </div>
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-40" />
          </div>

          {/* Ticket selection */}
          <div className="space-y-4">
            <Skeleton className="h-7 w-36" />
            <div className="rounded-lg border p-4">
              <div className="flex justify-between items-center">
                <div className="space-y-1">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <div className="space-y-2 text-right">
                  <Skeleton className="h-5 w-16" />
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <Skeleton className="h-5 w-6" />
                    <Skeleton className="h-8 w-8 rounded-full" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Payment method */}
          <div className="space-y-3">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-24" />
          </div>

          {/* Order summary */}
          <div className="border-t pt-4 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-12 w-full mt-4" />
          </div>
        </div>
      </div>
    </div>
  )
}
