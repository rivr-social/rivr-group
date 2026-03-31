import { Skeleton } from "@/components/ui/skeleton"

export default function RegisteredLoading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md w-full bg-card rounded-lg shadow-lg overflow-hidden">
        <div className="p-8 text-center space-y-6">
          <Skeleton className="h-16 w-16 rounded-full mx-auto" />
          <Skeleton className="h-7 w-48 mx-auto" />
          <Skeleton className="h-4 w-64 mx-auto" />

          <div className="bg-gray-50 p-4 rounded-lg space-y-2">
            <Skeleton className="h-5 w-40 mx-auto" />
            <Skeleton className="h-4 w-56 mx-auto" />
            <Skeleton className="h-4 w-36 mx-auto" />
          </div>

          <Skeleton className="h-4 w-72 mx-auto" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  )
}
