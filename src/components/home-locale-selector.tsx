"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Basin, Chapter } from "@/lib/types";

interface HomeLocaleSelectorProps {
  chapters: Chapter[];
  basins: Basin[];
  selectedLocaleId?: string;
  onSelectLocale: (localeId: string) => void;
}

export function HomeLocaleSelector({
  chapters,
  basins,
  selectedLocaleId,
  onSelectLocale,
}: HomeLocaleSelectorProps) {
  const [expandedBasin, setExpandedBasin] = useState<string | null>(null);

  if (chapters.length === 0 && basins.length === 0) {
    return <p className="text-sm text-muted-foreground">No locales available.</p>;
  }

  const chaptersByBasin = new Map<string, Chapter[]>();
  const unaffiliated: Chapter[] = [];

  for (const chapter of chapters) {
    if (chapter.basinId) {
      const existing = chaptersByBasin.get(chapter.basinId) ?? [];
      existing.push(chapter);
      chaptersByBasin.set(chapter.basinId, existing);
    } else {
      unaffiliated.push(chapter);
    }
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3 w-3" />
        Visual locale picker
      </p>
      <div className="grid gap-2">
        {basins.map((basin) => {
          const basinChapters = chaptersByBasin.get(basin.id) ?? [];
          const isExpanded = expandedBasin === basin.id;

          return (
            <Card key={basin.id} className="cursor-pointer transition-colors hover:bg-muted/50">
              <CardContent
                className="px-3 py-2"
                onClick={() => setExpandedBasin(isExpanded ? null : basin.id)}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{basin.name}</p>
                  <Badge variant="outline" className="text-xs">
                    {basinChapters.length} locale{basinChapters.length !== 1 ? "s" : ""}
                  </Badge>
                </div>
              </CardContent>
              {isExpanded && basinChapters.length > 0 ? (
                <div className="space-y-1 border-t px-3 py-2">
                  {basinChapters.map((chapter) => (
                    <button
                      key={chapter.id}
                      type="button"
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        selectedLocaleId === chapter.id
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted"
                      }`}
                      onClick={() => onSelectLocale(chapter.id)}
                    >
                      {chapter.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </Card>
          );
        })}

        {unaffiliated.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Other locales</p>
            {unaffiliated.map((chapter) => (
              <button
                key={chapter.id}
                type="button"
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  selectedLocaleId === chapter.id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() => onSelectLocale(chapter.id)}
              >
                {chapter.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
