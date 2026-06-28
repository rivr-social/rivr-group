"use client";

/**
 * Thin client surface for the site builder (Phase G / P-G4, sovereign group port).
 *
 * Intentionally light: it holds only form state and calls the server APIs that
 * do the heavy lifting (`/api/builder/site`, `/api/builder/publish`). No site
 * generation happens here — the user flagged heavy client bundles, so generation
 * is entirely server-side.
 *
 * Sovereign adaptation: no custom-domain DNS-write card (this group instance has
 * no A7 DNS connector lane).
 */
import { useCallback, useState } from "react";
import { Loader2, Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import type { PublicSitePublication, PublicSiteVersion } from "@/lib/builder/site-service";

interface BuilderClientProps {
  ownerId: string;
  initialPublication: PublicSitePublication | null;
  initialVersions: PublicSiteVersion[];
  sectionIds: string[];
  themePresets: string[];
}

export function BuilderClient({
  ownerId,
  initialPublication,
  initialVersions,
  sectionIds,
  themePresets,
}: BuilderClientProps) {
  const { toast } = useToast();
  const [publication, setPublication] = useState(initialPublication);
  const [versions, setVersions] = useState(initialVersions);
  const [theme, setTheme] = useState(initialPublication?.theme ?? themePresets[0] ?? "default");
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set(sectionIds));
  const [publishing, setPublishing] = useState(false);

  const toggleSection = useCallback((id: string) => {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const publish = useCallback(async () => {
    setPublishing(true);
    try {
      const response = await fetch("/api/builder/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme,
          sections: sectionIds.filter((id) => selectedSections.has(id)),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Publish failed");
      setPublication(data.publication);
      setVersions((prev) => [data.version, ...prev]);
      toast({ title: "Published", description: `Version ${data.version.versionNumber} is now live.` });
    } catch (error) {
      toast({ title: "Publish failed", description: String(error), variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  }, [theme, sectionIds, selectedSections, toast]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-semibold">Site Builder</h1>
        <p className="text-sm text-muted-foreground">
          Generate and publish a static site from your RIVR content.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" /> Publish
          </CardTitle>
          <CardDescription>
            Choose sections and a theme, then publish. Your site is generated on the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Sections</Label>
            <div className="flex flex-wrap gap-2">
              {sectionIds.map((id) => {
                const active = selectedSections.has(id);
                return (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => toggleSection(id)}
                  >
                    {id}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="theme">Theme</Label>
            <select
              id="theme"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              {themePresets.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </div>

          <Button onClick={publish} disabled={publishing}>
            {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
            Publish site
          </Button>

          {publication?.publishedVersionNumber != null && (
            <p className="text-sm text-muted-foreground">
              Live: version {publication.publishedVersionNumber}
              {publication.publishedAt ? ` (published ${new Date(publication.publishedAt).toLocaleString()})` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Version history</CardTitle>
          <CardDescription>{versions.length} snapshot(s) for this site.</CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions yet. Publish to create one.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {versions.map((version) => (
                <li key={version.id} className="flex justify-between border-b pb-1">
                  <span>
                    v{version.versionNumber} &middot; {version.trigger} &middot; {version.fileCount} files
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(version.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="sr-only">Owner: {ownerId}</p>
    </div>
  );
}
