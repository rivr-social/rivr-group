export default function GroupDetailLoading() {
  return (
    <div className="container max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="h-5 w-40 bg-muted rounded animate-pulse" />
      <div className="rounded-lg border p-6 space-y-4">
        <div className="h-8 w-1/2 bg-muted rounded animate-pulse" />
        <div className="h-4 w-2/3 bg-muted rounded animate-pulse" />
      </div>
      <div className="rounded-lg border p-6 h-64 bg-muted/30 animate-pulse" />
    </div>
  );
}
