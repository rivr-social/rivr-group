export default function EventDetailLoading() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-6 space-y-4">
      <div className="h-5 w-32 bg-muted rounded animate-pulse" />
      <div className="rounded-lg border p-6 space-y-4">
        <div className="h-8 w-1/2 bg-muted rounded animate-pulse" />
        <div className="h-4 w-2/3 bg-muted rounded animate-pulse" />
        <div className="h-4 w-1/3 bg-muted rounded animate-pulse" />
      </div>
    </div>
  );
}
