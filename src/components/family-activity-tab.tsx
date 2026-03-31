"use client";

/**
 * Family activity tab that fetches and displays activity feed entries
 * for a given family entity.
 *
 * Self-contained: fetches its own data via `fetchAgentFeed` server action.
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { fetchAgentFeed } from "@/app/actions/graph";

interface ActivityEntry {
  id: string;
  verb: string;
  timestamp: string;
}

interface FamilyActivityTabProps {
  familyId: string;
}

export function FamilyActivityTab({ familyId }: FamilyActivityTabProps) {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const feed = await fetchAgentFeed(familyId, 60);
        if (cancelled) return;
        setActivity(
          (feed as ActivityEntry[]).map((entry) => ({
            id: entry.id,
            verb: entry.verb,
            timestamp: entry.timestamp,
          }))
        );
      } catch {
        // Silently handle — the tab will show "no activity"
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [familyId]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading activity...</p>;
  }

  if (activity.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity found.</p>;
  }

  return (
    <div className="space-y-3">
      {activity.map((a) => (
        <Card key={a.id}>
          <CardContent className="py-3">
            <p className="font-medium">{a.verb}</p>
            <p className="text-xs text-muted-foreground">
              {new Date(a.timestamp).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
