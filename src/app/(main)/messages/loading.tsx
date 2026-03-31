import { Skeleton } from "@/components/ui/skeleton"

export default function MessagesLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 h-[calc(100vh-8rem)] flex flex-col md:flex-row">
      {/* Conversation list sidebar */}
      <div className="md:w-1/3 border-r flex flex-col gap-2 p-2">
        <Skeleton className="h-10 w-full mb-2" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-2">
            <Skeleton className="h-10 w-10 rounded-full shrink-0" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        ))}
      </div>

      {/* Chat panel */}
      <div className="hidden md:flex md:w-2/3 flex-col h-full items-center justify-center">
        <Skeleton className="h-5 w-64" />
      </div>
    </div>
  )
}
