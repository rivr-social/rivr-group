/**
 * Group settings — Connections tab (server component).
 *
 * Resolves the current group, verifies admin access, and loads the linked
 * Google Workspace connection (if any) before handing control to the
 * client form. Renders an access-denied card when the caller is not a
 * group admin/moderator.
 */

import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, groupConnections } from "@/db/schema";
import { isGroupAdmin } from "@/app/actions/group-admin";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GOOGLE_WORKSPACE_PROVIDER } from "@/lib/google/constants";
import {
  ConnectionsForm,
  type GroupGoogleConnectionSummary,
} from "./connections-form";

export const dynamic = "force-dynamic";

interface ConnectionsPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string }>;
}

/** Default config when a row exists but `config` was somehow null. */
const DEFAULT_CONFIG = {
  smtpEnabled: false,
  calendarSyncEnabled: false,
} as const;

export default async function GroupConnectionsSettingsPage(
  props: ConnectionsPageProps,
) {
  const { id: groupId } = await props.params;
  const search = props.searchParams ? await props.searchParams : undefined;
  const initialError = search?.error ?? null;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/groups/${groupId}/settings/connections`);
  }

  const [group] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return (
      <div className="container max-w-3xl mx-auto p-4 space-y-4">
        <Button asChild variant="ghost" className="w-fit">
          <Link href="/">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Group not found</CardTitle>
            <CardDescription>
              The group you tried to access could not be found or has been
              removed.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const admin = await isGroupAdmin(session.user.id, groupId);
  if (!admin) {
    return (
      <div className="container max-w-3xl mx-auto p-4 space-y-4">
        <Button asChild variant="ghost" className="w-fit">
          <Link href={`/groups/${groupId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to group
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>
              Only group admins and moderators can manage connections.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/groups/${groupId}`}>Return to group</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const [row] = await db
    .select({
      accountEmail: groupConnections.accountEmail,
      scope: groupConnections.scope,
      expiresAt: groupConnections.expiresAt,
      config: groupConnections.config,
    })
    .from(groupConnections)
    .where(
      and(
        eq(groupConnections.groupId, groupId),
        eq(groupConnections.provider, GOOGLE_WORKSPACE_PROVIDER),
      ),
    )
    .limit(1);

  const summary: GroupGoogleConnectionSummary | null = row
    ? {
        accountEmail: row.accountEmail,
        scope: row.scope,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        config: {
          smtpEnabled: row.config?.smtpEnabled ?? DEFAULT_CONFIG.smtpEnabled,
          calendarSyncEnabled:
            row.config?.calendarSyncEnabled ?? DEFAULT_CONFIG.calendarSyncEnabled,
          fromAddress: row.config?.fromAddress,
          calendarId: row.config?.calendarId,
        },
      }
    : null;

  return (
    <div className="container max-w-3xl mx-auto p-4 pb-16 space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to settings">
          <Link href={`/groups/${groupId}/settings`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">{group.name} — Connections</h1>
      </div>

      <ConnectionsForm
        groupId={groupId}
        connection={summary}
        initialError={initialError}
      />
    </div>
  );
}
