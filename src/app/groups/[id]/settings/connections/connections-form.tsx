"use client";

/**
 * Client form for the per-group Connections settings page.
 *
 * Renders either:
 * - A "Connect Google Workspace" CTA when no connection exists, OR
 * - The connected-state panel with toggles, optional from-address /
 *   calendar id inputs, and a Disconnect action.
 *
 * Server interactions:
 * - Connect: anchored to `GET /api/group/[groupId]/connections/google/connect`.
 * - Save:    `updateGroupGoogleConnectionConfigAction`.
 * - Disconnect: `disconnectGroupGoogleAction`.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Link2Off,
  Mail,
  CalendarDays,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import {
  disconnectGroupGoogleAction,
  updateGroupGoogleConnectionConfigAction,
  type GoogleConnectionConfigPatch,
} from "./actions";

/** Shape of the connection summary passed in from the server component. */
export interface GroupGoogleConnectionSummary {
  accountEmail: string;
  scope: string | null;
  expiresAt: string | null;
  config: {
    smtpEnabled: boolean;
    calendarSyncEnabled: boolean;
    fromAddress?: string;
    calendarId?: string;
  };
  /** Most recent successful calendar sync timestamp (ISO), or null. */
  lastCalendarSyncedAt: string | null;
}

export interface ConnectionsFormProps {
  groupId: string;
  connection: GroupGoogleConnectionSummary | null;
  initialError: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "Group connections are not configured on this server. Contact admin.",
  state_misconfigured:
    "Group connections are not configured on this server. Contact admin.",
  forbidden: "You must be a group admin to manage connections.",
  state_mismatch: "OAuth state mismatch. Please try connecting again.",
  state_missing: "OAuth state cookie was missing. Please try connecting again.",
  code_missing: "Google did not return an authorization code.",
  token_exchange_failed:
    "Google rejected the authorization code. Please try connecting again.",
  no_access_token: "Google did not return an access token.",
  userinfo_failed: "Could not read account email from Google.",
  provider_error: "Google reported an error during consent.",
  invalid_group: "Invalid group identifier.",
  unauthenticated: "You must sign in to sync.",
  not_linked: "No Google Workspace connection is linked.",
  disabled: "Calendar sync is turned off. Enable the toggle and save first.",
};

/**
 * Render a human-readable "X ago" string for a sync timestamp.
 *
 * Inlined (rather than pulling in `date-fns/formatDistanceToNow`) because
 * the precision we need here is coarse and we want zero new dependencies
 * for one tiny label.
 */
function formatSyncedAgo(iso: string | null): string {
  if (!iso) return "Never synced";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Never synced";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "Last synced just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last synced ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last synced ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Last synced ${days} day${days === 1 ? "" : "s"} ago`;
}

export function ConnectionsForm({
  groupId,
  connection,
  initialError,
}: ConnectionsFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [smtpEnabled, setSmtpEnabled] = useState(
    connection?.config.smtpEnabled ?? false,
  );
  const [calendarSyncEnabled, setCalendarSyncEnabled] = useState(
    connection?.config.calendarSyncEnabled ?? false,
  );
  const [fromAddress, setFromAddress] = useState(
    connection?.config.fromAddress ?? "",
  );
  const [calendarId, setCalendarId] = useState(
    connection?.config.calendarId ?? "",
  );

  const connectHref = `/api/group/${groupId}/connections/google/connect`;

  const onSave = () => {
    if (!connection) return;
    const patch: GoogleConnectionConfigPatch = {
      smtpEnabled,
      calendarSyncEnabled,
      fromAddress: fromAddress.trim() ? fromAddress.trim() : null,
      calendarId: calendarId.trim() ? calendarId.trim() : null,
    };

    startTransition(async () => {
      const result = await updateGroupGoogleConnectionConfigAction(
        groupId,
        patch,
      );
      if (!result.success) {
        toast({
          title: "Could not save settings",
          description: result.error ?? "Unknown error",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Connection settings saved" });
      router.refresh();
    });
  };

  const onDisconnect = () => {
    if (!connection) return;
    startTransition(async () => {
      const result = await disconnectGroupGoogleAction(groupId);
      if (!result.success) {
        toast({
          title: "Could not disconnect",
          description: result.error ?? "Unknown error",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Google Workspace disconnected" });
      router.refresh();
    });
  };

  const onSyncNow = () => {
    if (!connection) return;
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/group/${groupId}/connections/google/sync-now`,
          { method: "POST" },
        );
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; result?: { applied?: number; skipped?: number; errors?: number } }
          | null;
        if (!response.ok || !payload?.ok) {
          const code = payload?.error ?? "provider_error";
          toast({
            title: "Sync failed",
            description: ERROR_MESSAGES[code] ?? `Error: ${code}`,
            variant: "destructive",
          });
          return;
        }
        const result = payload.result ?? {};
        toast({
          title: "Calendar synced",
          description:
            `Applied ${result.applied ?? 0} change(s); ` +
            `skipped ${result.skipped ?? 0}; errors ${result.errors ?? 0}.`,
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Sync failed",
          description:
            error instanceof Error ? error.message : "Unknown error",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      {initialError ? (
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-row items-center gap-2">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <CardTitle className="text-base text-destructive">
              Connection error
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {ERROR_MESSAGES[initialError] ?? `Error code: ${initialError}`}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" /> Google Workspace
          </CardTitle>
          <CardDescription>
            Link a Google Workspace account so this group can send broadcasts
            from its own Gmail address and (later) sync its calendar.
          </CardDescription>
        </CardHeader>

        {connection ? (
          <>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Connected as{" "}
                <span className="font-medium">{connection.accountEmail}</span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-md border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="smtp-enabled" className="flex items-center gap-2">
                      <Mail className="h-4 w-4" /> Use for group email
                    </Label>
                    <Switch
                      id="smtp-enabled"
                      checked={smtpEnabled}
                      onCheckedChange={setSmtpEnabled}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    When enabled, group broadcasts are sent via this Workspace
                    account using XOAUTH2.
                  </p>
                </div>

                <div className="rounded-md border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor="calendar-sync-enabled"
                      className="flex items-center gap-2"
                    >
                      <CalendarDays className="h-4 w-4" /> Calendar sync
                    </Label>
                    <Switch
                      id="calendar-sync-enabled"
                      checked={calendarSyncEnabled}
                      onCheckedChange={setCalendarSyncEnabled}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Two-way sync with Google Calendar. Group events created
                    here are pushed to the configured calendar; changes in
                    Google flow back on the next poll.
                  </p>
                  {connection.config.calendarSyncEnabled ? (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <p className="text-xs text-muted-foreground">
                        {formatSyncedAgo(connection.lastCalendarSyncedAt)}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onSyncNow}
                        disabled={isPending}
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 mr-1.5 ${isPending ? "animate-spin" : ""}`}
                        />
                        Sync now
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="from-address">From address (optional)</Label>
                <Input
                  id="from-address"
                  value={fromAddress}
                  onChange={(event) => setFromAddress(event.target.value)}
                  placeholder={connection.accountEmail}
                />
                <p className="text-xs text-muted-foreground">
                  Defaults to the linked account email when blank. The Workspace
                  account must be authorized to send from this address.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="calendar-id">Calendar ID (optional)</Label>
                <Input
                  id="calendar-id"
                  value={calendarId}
                  onChange={(event) => setCalendarId(event.target.value)}
                  placeholder="primary"
                />
                <p className="text-xs text-muted-foreground">
                  Free text for now; a calendar picker arrives in PR2. Leave
                  blank to use the primary calendar of the linked account.
                </p>
              </div>
            </CardContent>

            <CardFooter className="justify-between">
              <Button
                variant="destructive"
                onClick={onDisconnect}
                disabled={isPending}
              >
                <Link2Off className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
              <Button onClick={onSave} disabled={isPending}>
                {isPending ? "Saving..." : "Save settings"}
              </Button>
            </CardFooter>
          </>
        ) : (
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              No Google Workspace account linked yet. Connecting requires
              admin/moderator privileges on this group and the consent of the
              Workspace user.
            </p>
            <Button asChild disabled={isPending}>
              <a href={connectHref}>Connect Google Workspace</a>
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
