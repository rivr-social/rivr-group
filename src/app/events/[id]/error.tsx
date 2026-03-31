"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { reportError } from "@/lib/monitoring";

export default function EventError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Event page error:", error);
    void reportError(error, { boundary: "app/events/[id]", digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">Could not load this event</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        Something went wrong while loading the event page.
      </p>
      <div className="flex gap-3">
        <Button onClick={reset} variant="outline">Try again</Button>
      </div>
    </div>
  );
}
