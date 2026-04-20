/**
 * Admin settings page for configuring the current Rivr instance's
 * outgoing transactional SMTP credentials (ticket #106).
 *
 * Lives at `/settings/outgoing-email`. Only instance admins can reach
 * it — the page performs the admin-metadata check server-side and
 * redirects non-admins back to the main settings page.
 *
 * The page renders a client component that calls the admin API:
 *   GET    /api/admin/smtp-config         — initial load
 *   POST   /api/admin/smtp-config         — save
 *   POST   /api/admin/smtp-config/test    — send test email
 *   DELETE /api/admin/smtp-config         — remove + fall back to relay
 *
 * Federated-auth email routing is NOT exposed here — it is pinned by
 * the mailer and cannot be overridden by peer admins. The UI explains
 * this in plain language alongside the SMTP form.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, peerSmtpConfig } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { OutgoingEmailForm, type OutgoingEmailInitial } from "./outgoing-email-form";

export default async function OutgoingEmailSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  const metadata =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  if (metadata.siteRole !== "admin") {
    // Non-admins don't get a 403 page — they're quietly redirected
    // back to the main settings page. The UI shell doesn't link to
    // /settings/outgoing-email for non-admins either.
    redirect("/settings");
  }

  const { instanceId, instanceType, instanceSlug } = getInstanceConfig();

  const [row] = await db
    .select()
    .from(peerSmtpConfig)
    .where(eq(peerSmtpConfig.instanceId, instanceId))
    .limit(1);

  const initial: OutgoingEmailInitial = {
    instanceId,
    instanceType,
    instanceSlug,
    config: row
      ? {
          enabled: row.enabled,
          host: row.host,
          port: row.port,
          secure: row.secure,
          username: row.username,
          fromAddress: row.fromAddress,
          passwordSecretRef: row.passwordSecretRef,
          lastTestAt:
            row.lastTestAt instanceof Date
              ? row.lastTestAt.toISOString()
              : row.lastTestAt ?? null,
          lastTestStatus: row.lastTestStatus,
          lastTestError: row.lastTestError,
        }
      : null,
  };

  return <OutgoingEmailForm initial={initial} />;
}
