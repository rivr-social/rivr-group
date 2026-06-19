"use client";

/**
 * Owner form for `/settings/visitor-access`.
 *
 * Lets the instance owner control how cross-instance SSO visitors are treated
 * when they land here:
 *   - whether visitor auto-sign-in is enabled at all,
 *   - which capabilities beyond the implicit `read` baseline they hold,
 *   - their session length,
 *   - whether landings are recorded.
 *
 * It also shows the most recent recorded landings (referral path, home,
 * granted scope) so the owner can see who has been visiting.
 *
 * Consumes:
 *   GET  /api/admin/visitor-access  — render current state (loaded server-side)
 *   POST /api/admin/visitor-access  — save
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Eye, Loader2, Users } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";

export interface VisitorAccessConfig {
  enabled: boolean;
  /** Extra capabilities beyond the implicit baseline `read`. */
  allowedCapabilities: string[];
  sessionTtlMinutes: number;
  recordVisits: boolean;
}

export interface VisitorVisitRow {
  id: string;
  visitorActorId: string;
  isOwner: boolean;
  homeBaseUrl: string | null;
  globalIssuerBaseUrl: string | null;
  landingPath: string | null;
  referrer: string | null;
  visitorName: string | null;
  grantedScope: string[];
  createdAt: string;
}

export interface VisitorAccessInitial {
  instanceType: string;
  instanceSlug: string;
  baselineCapability: string;
  allCapabilities: string[];
  config: VisitorAccessConfig;
  recentVisits: VisitorVisitRow[];
}

const BACK_LABEL = "Back to settings";

/** Short human descriptions for each capability shown next to its toggle. */
const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  read: "Browse public content (always on).",
  react: "Add reactions to posts and content.",
  comment: "Write comments on posts and content.",
  rsvp: "RSVP to events.",
  message: "Start direct message threads.",
};

export function VisitorAccessForm({
  initial,
}: {
  initial: VisitorAccessInitial;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(initial.config.enabled);
  const [recordVisits, setRecordVisits] = useState(initial.config.recordVisits);
  const [ttl, setTtl] = useState<number>(initial.config.sessionTtlMinutes);
  const [extras, setExtras] = useState<Set<string>>(
    new Set(initial.config.allowedCapabilities),
  );
  const [isSaving, setIsSaving] = useState(false);

  const grantableCapabilities = initial.allCapabilities.filter(
    (cap) => cap !== initial.baselineCapability,
  );

  function toggleCapability(cap: string, checked: boolean) {
    setExtras((prev) => {
      const next = new Set(prev);
      if (checked) next.add(cap);
      else next.delete(cap);
      return next;
    });
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/visitor-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          allowedCapabilities: Array.from(extras),
          sessionTtlMinutes: Number(ttl),
          recordVisits,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${response.status}`);
      }
      toast({
        title: "Visitor access saved",
        description:
          "New visitors will be admitted under the updated policy immediately.",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Could not save",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          className="p-0"
          onClick={() => router.push("/settings")}
          aria-label={BACK_LABEL}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-2xl font-bold">Visitor access</h1>
      </div>

      <Alert className="mb-6">
        <Eye className="h-4 w-4" />
        <AlertTitle>What this controls</AlertTitle>
        <AlertDescription>
          When someone from another RIVR instance follows a link here, they are
          auto-signed-in as a <em>visitor</em> with a limited, read-only-by-default
          scope you set below. You (the owner) are never limited by this policy.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Federated visitor policy
          </CardTitle>
          <CardDescription>
            Instance: <code>{initial.instanceSlug}</code> ({initial.instanceType})
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label className="text-base">Auto-sign-in visitors</Label>
              <p className="text-sm text-muted-foreground">
                When off, visitors from other instances are not signed in and
                must log in normally to interact.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-3">
            <Label className="text-base">Visitor capabilities</Label>
            <p className="text-sm text-muted-foreground">
              The <code>{initial.baselineCapability}</code> baseline is always
              granted. Enable any additional capabilities visitors should have.
            </p>
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center gap-3 opacity-70">
                <Checkbox checked disabled aria-label="read (baseline)" />
                <div className="space-y-0.5">
                  <span className="text-sm font-medium">
                    {initial.baselineCapability}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {CAPABILITY_DESCRIPTIONS[initial.baselineCapability] ??
                      "Baseline capability."}
                  </p>
                </div>
              </div>
              {grantableCapabilities.map((cap) => (
                <div key={cap} className="flex items-center gap-3">
                  <Checkbox
                    id={`cap-${cap}`}
                    checked={extras.has(cap)}
                    disabled={!enabled}
                    onCheckedChange={(checked) =>
                      toggleCapability(cap, checked === true)
                    }
                    aria-label={cap}
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor={`cap-${cap}`} className="text-sm font-medium">
                      {cap}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {CAPABILITY_DESCRIPTIONS[cap] ?? "Additional capability."}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="visitor-ttl">Session length (minutes)</Label>
            <Input
              id="visitor-ttl"
              type="number"
              min={1}
              max={1440}
              value={ttl}
              disabled={!enabled}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="max-w-[12rem]"
            />
            <p className="text-sm text-muted-foreground">
              How long a visitor stays signed in before their session expires
              (1–1440 minutes).
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label className="text-base">Record visits</Label>
              <p className="text-sm text-muted-foreground">
                Log each visitor landing — their referral path, home instance,
                and granted scope — so you can see who has been browsing.
              </p>
            </div>
            <Switch checked={recordVisits} onCheckedChange={setRecordVisits} />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save policy
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Recent visitor landings</CardTitle>
          <CardDescription>
            The {initial.recentVisits.length} most recent recorded landings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {initial.recentVisits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No visits recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Visitor</TableHead>
                    <TableHead>Home</TableHead>
                    <TableHead>Landed on</TableHead>
                    <TableHead>Referrer</TableHead>
                    <TableHead>Scope</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {initial.recentVisits.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(v.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-medium">
                          {v.visitorName ?? v.visitorActorId.slice(0, 8)}
                        </span>
                        {v.isOwner && (
                          <Badge variant="secondary" className="ml-2">
                            owner
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.homeBaseUrl ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.landingPath ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate text-xs">
                        {v.referrer ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.grantedScope.length > 0
                          ? v.grantedScope.join(", ")
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
