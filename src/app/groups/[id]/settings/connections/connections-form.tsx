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
};

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
                    Reserved for the next release. Leave on so the next deploy
                    can begin syncing immediately.
                  </p>
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
