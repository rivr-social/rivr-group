"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight, Globe, Star } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLocalesAndBasins } from "@/lib/hooks/use-graph-data";

interface LocaleSwitcherProps {
  onLocaleChange: (localeId: string) => void;
  selectedLocale: string;
}

export function LocaleSwitcher({ onLocaleChange, selectedLocale }: LocaleSwitcherProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const {
    data: { basins, locales },
  } = useLocalesAndBasins();

  const basinById = React.useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const basin of basins) map.set(basin.id, basin);
    return map;
  }, [basins]);

  const filteredLocales = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return locales;
    return locales.filter((locale) => {
      const basinName = basinById.get(locale.basinId)?.name || "";
      return (
        locale.name.toLowerCase().includes(normalized) ||
        (locale.description || "").toLowerCase().includes(normalized) ||
        basinName.toLowerCase().includes(normalized)
      );
    });
  }, [locales, query, basinById]);

  const localesByBasin = React.useMemo(() => {
    const grouped: Array<{ basinId: string; basinName: string; locales: typeof locales }> = [];
    const index = new Map<string, number>();

    for (const locale of filteredLocales) {
      const basinId = locale.basinId || "unscoped";
      const basinName = basinById.get(basinId)?.name || "Other Locales";
      if (!index.has(basinId)) {
        index.set(basinId, grouped.length);
        grouped.push({ basinId, basinName, locales: [] as typeof locales });
      }
      grouped[index.get(basinId)!].locales.push(locale);
    }

    return grouped;
  }, [filteredLocales, basinById, locales]);

  const normalizedSelectedLocale = selectedLocale.trim().toLowerCase();
  const selectedLocaleObj = locales.find((locale) => {
    return (
      locale.id === selectedLocale ||
      locale.slug === selectedLocale ||
      locale.name.toLowerCase() === normalizedSelectedLocale
    );
  });
  const isAll = !selectedLocaleObj || selectedLocale === "all";

  return (
    <div className="flex items-center gap-2">
      {!isAll && selectedLocaleObj ? (
        <Link
          href={`/locales/${selectedLocaleObj.id}`}
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
        >
          {selectedLocaleObj.image ? (
            <Image
              src={selectedLocaleObj.image}
              alt={selectedLocaleObj.name}
              width={32}
              height={32}
              className="h-8 w-8 rounded-full border object-cover"
            />
          ) : null}
          <span className="text-lg font-semibold text-foreground">{selectedLocaleObj.name}</span>
          {selectedLocaleObj.isCommons ? <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" /> : null}
        </Link>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            role="combobox"
            aria-expanded={open}
            className="flex items-center gap-1 px-2 font-normal text-[#ddaa46]"
          >
            {isAll ? (
              <>
                <Globe className="mr-1 h-5 w-5" />
                <span className="text-lg font-semibold">All Locales</span>
              </>
            ) : null}
            <ChevronDown className="h-4 w-4 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="z-[1200] w-[340px] border bg-popover p-0 opacity-100 shadow-2xl" align="start">
          <div className="border-b p-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search locales..." className="h-9" />
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1">
            <button
              type="button"
              onClick={() => {
                onLocaleChange("all");
                setOpen(false);
              }}
              className={cn(
                "w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                isAll ? "bg-accent" : ""
              )}
            >
              <span className="inline-flex items-center gap-2">
                <Check className={cn("h-4 w-4", isAll ? "opacity-100" : "opacity-0")} />
                <Globe className="h-4 w-4 text-muted-foreground" />
                All Locales
              </span>
            </button>

            {localesByBasin.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No locales found.</p> : null}

            {localesByBasin.map((entry) => (
              <div key={entry.basinId} className="mt-1">
                {entry.basinId !== "unscoped" ? (
                  <Link
                    href={`/basins/${entry.basinId}`}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <span>{entry.basinName}</span>
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                ) : (
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{entry.basinName}</p>
                )}

                {entry.locales.map((locale) => (
                  <button
                    key={locale.id}
                    type="button"
                    onClick={() => {
                      onLocaleChange(locale.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                      selectedLocaleObj?.id === locale.id ? "bg-accent" : ""
                    )}
                  >
                    <span className="inline-flex w-full items-center gap-2">
                      <Check className={cn("h-4 w-4", selectedLocaleObj?.id === locale.id ? "opacity-100" : "opacity-0")} />
                      {locale.image ? (
                        <Image
                          src={locale.image}
                          alt={locale.name}
                          width={20}
                          height={20}
                          className="h-5 w-5 rounded-full object-cover"
                        />
                      ) : null}
                      <span className="flex-1 truncate">{locale.name}</span>
                      {locale.isCommons ? <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" /> : null}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
