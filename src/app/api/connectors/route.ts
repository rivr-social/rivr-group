import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { db } from "@/db";
import { agents, userConnectors } from "@/db/schema";
import { isGroupAgentType } from "@/lib/agent-types";
import { CONNECTOR_CATALOG, getConnectorDefinition } from "@/lib/connectors/catalog";
import { runConnectorSync, SYNCABLE_CONNECTOR_PROVIDERS } from "@/lib/connectors/notion-sync";
import { runConnectorItemSave, ITEM_SAVE_PROVIDERS } from "@/lib/connectors/gmail-save";
import { runConnectorEventPublish, EVENT_PUBLISH_PROVIDERS } from "@/lib/connectors/luma-publish";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";

export const dynamic = "force-dynamic";

/**
 * Resolve the agent whose connectors a request targets, enforcing authorization.
 *
 * When `requested` names a different agent than the session actor, that agent
 * must be a group-like type AND the actor must be a group admin. Connectors
 * store provider credentials, so this gate is intentionally admin-only
 * (`isGroupAdmin`) rather than the broader member-level `hasGroupWriteAccess`.
 */
async function resolveSubject(request: Request, requested?: string) {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) return { error: "Unauthorized", status: 401 } as const;
  const targetAgentId = requested?.trim() || actorId;
  if (targetAgentId !== actorId) {
    const [target] = await db.select({ type: agents.type }).from(agents).where(eq(agents.id, targetAgentId)).limit(1);
    if (!target || !isGroupAgentType(target.type) || !(await isGroupAdmin(actorId, targetAgentId))) {
      return { error: "You must be a group admin to manage these connectors.", status: 403 } as const;
    }
  }
  return { actorId, targetAgentId } as const;
}

function targetFromUrl(request: Request) {
  return new URL(request.url).searchParams.get("targetAgentId") ?? undefined;
}

function buildTestUrl(provider: string, template: string, token: string, account: string) {
  if (provider === "signal") {
    throw new Error("Signal bridge testing is unavailable until an instance allow-list is configured.");
  }
  if (provider === "substack") {
    const publication = new URL(account);
    if (publication.protocol !== "https:" || !(publication.hostname === "substack.com" || publication.hostname.endsWith(".substack.com"))) {
      throw new Error("Substack publication must be an https://*.substack.com URL.");
    }
    return `${publication.origin}/feed`;
  }
  return template
    .replace("{token}", encodeURIComponent(token))
    .replace("{account}", encodeURIComponent(account.replace(/\/+$/, "")));
}

function testHeaders(provider: string, token: string): Record<string, string> {
  if (!token || provider === "telegram" || provider === "substack" || provider === "signal") return {};
  if (provider === "notion") return { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" };
  if (provider === "luma") return { "x-luma-api-key": token };
  return { Authorization: `Bearer ${token}` };
}

export async function GET(request: Request) {
  const subject = await resolveSubject(request, targetFromUrl(request));
  if ("error" in subject) return NextResponse.json({ error: subject.error }, { status: subject.status });
  const rows = await db.select({
    provider: userConnectors.provider,
    accountEmail: userConnectors.accountEmail,
    tokenExpiresAt: userConnectors.tokenExpiresAt,
    metadata: userConnectors.metadata,
    lastSyncedAt: userConnectors.lastSyncedAt,
    lastSyncError: userConnectors.lastSyncError,
    accessToken: userConnectors.accessToken,
  }).from(userConnectors).where(eq(userConnectors.userAgentId, subject.targetAgentId));
  return NextResponse.json({
    targetAgentId: subject.targetAgentId,
    definitions: CONNECTOR_CATALOG,
    connections: rows.map(({ accessToken, ...row }) => ({ ...row, hasCredential: Boolean(accessToken) })),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as null | {
    targetAgentId?: string; provider?: string; accountLabel?: string; credential?: string; refreshCredential?: string; itemId?: string; resourceId?: string; action?: "save" | "test" | "sync" | "saveItem" | "publishEvent";
  };
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const subject = await resolveSubject(request, body.targetAgentId);
  if ("error" in subject) return NextResponse.json({ error: subject.error }, { status: subject.status });
  const definition = getConnectorDefinition(body.provider ?? "");
  if (!definition) return NextResponse.json({ error: "Unknown connector provider" }, { status: 400 });

  // On-demand import: pull the stored connector's provider items into Resources.
  // Operates on the already-saved credential, so it skips the account/credential
  // input validation that `save`/`test` require.
  if (body.action === "sync") {
    if (!(SYNCABLE_CONNECTOR_PROVIDERS as readonly string[]).includes(definition.id)) {
      return NextResponse.json({ error: `Sync is not supported for ${definition.label}.` }, { status: 400 });
    }
    try {
      const result = await runConnectorSync(subject.targetAgentId, definition.id);
      await db.update(userConnectors).set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connector sync failed.";
      await db.update(userConnectors).set({ lastSyncError: message, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // On-demand single-item save (Gmail): mirror one provider item by id into a
  // Resource. Operates on the stored credential, so it also skips save/test
  // input validation.
  if (body.action === "saveItem") {
    if (!(ITEM_SAVE_PROVIDERS as readonly string[]).includes(definition.id)) {
      return NextResponse.json({ error: `Single-item save is not supported for ${definition.label}.` }, { status: 400 });
    }
    const itemId = body.itemId?.trim() ?? "";
    if (!itemId) return NextResponse.json({ error: "An item id is required." }, { status: 400 });
    try {
      const result = await runConnectorItemSave(subject.targetAgentId, definition.id, itemId);
      await db.update(userConnectors).set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connector item save failed.";
      await db.update(userConnectors).set({ lastSyncError: message, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  // On-demand event publish (Luma): push a RIVR event resource OUT to the
  // provider. Operates on the stored credential, so it also skips save/test
  // input validation.
  if (body.action === "publishEvent") {
    if (!(EVENT_PUBLISH_PROVIDERS as readonly string[]).includes(definition.id)) {
      return NextResponse.json({ error: `Event publish is not supported for ${definition.label}.` }, { status: 400 });
    }
    const resourceId = body.resourceId?.trim() ?? "";
    if (!resourceId) return NextResponse.json({ error: "An event resource id is required." }, { status: 400 });
    try {
      const result = await runConnectorEventPublish(subject.targetAgentId, definition.id, resourceId);
      await db.update(userConnectors).set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Event publish failed.";
      await db.update(userConnectors).set({ lastSyncError: message, updatedAt: new Date() }).where(and(
        eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
      ));
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const accountLabel = body.accountLabel?.trim() ?? "";
  const credential = body.credential?.trim() ?? "";
  const refreshCredential = body.refreshCredential?.trim() ?? "";
  if (!accountLabel) return NextResponse.json({ error: `${definition.accountLabel} is required.` }, { status: 400 });

  const [existing] = await db.select().from(userConnectors).where(and(
    eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
  )).limit(1);
  // `existing.accessToken` is stored encrypted; decrypt it (legacy plaintext
  // passes through unchanged) so the test fetch and presence check see the real
  // credential. Freshly-typed `credential` is already plaintext.
  const effectiveCredential = credential || decryptSecret(existing?.accessToken) || "";
  if (definition.credentialLabel && !effectiveCredential) {
    return NextResponse.json({ error: `${definition.credentialLabel} is required.` }, { status: 400 });
  }

  if (body.action === "test") {
    let testUrl: string;
    try {
      testUrl = buildTestUrl(definition.id, definition.testUrl, effectiveCredential, accountLabel);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid connector configuration." }, { status: 400 });
    }
    const response = await fetch(testUrl, {
      headers: testHeaders(definition.id, effectiveCredential), cache: "no-store", signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) return NextResponse.json({ error: `Provider returned ${response?.status ?? "a connection error"}.` }, { status: 502 });
    await db.update(userConnectors).set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() }).where(and(
      eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
    ));
    return NextResponse.json({ success: true });
  }

  // Encrypt-at-rest: never persist OAuth tokens / API keys as plaintext.
  const encryptedAccess = encryptSecret(effectiveCredential || null);
  const encryptedRefresh = encryptSecret(refreshCredential || null);
  await db.insert(userConnectors).values({
    userAgentId: subject.targetAgentId, provider: definition.id, accountEmail: accountLabel,
    accessToken: encryptedAccess, metadata: { connectionType: "credential" }, updatedAt: new Date(),
    refreshToken: encryptedRefresh,
    tokenExpiresAt: definition.id.startsWith("google_") || definition.id === "gmail" ? new Date(Date.now() + 55 * 60 * 1000) : null,
  }).onConflictDoUpdate({
    target: [userConnectors.userAgentId, userConnectors.provider],
    set: { accountEmail: accountLabel, ...(credential ? { accessToken: encryptSecret(credential) } : {}), ...(refreshCredential ? { refreshToken: encryptSecret(refreshCredential) } : {}), ...(credential && (definition.id.startsWith("google_") || definition.id === "gmail") ? { tokenExpiresAt: new Date(Date.now() + 55 * 60 * 1000) } : {}), updatedAt: new Date(), lastSyncError: null },
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => null) as null | { targetAgentId?: string; provider?: string };
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const subject = await resolveSubject(request, body.targetAgentId);
  if ("error" in subject) return NextResponse.json({ error: subject.error }, { status: subject.status });
  const definition = getConnectorDefinition(body.provider ?? "");
  if (!definition) return NextResponse.json({ error: "Unknown connector provider" }, { status: 400 });
  await db.delete(userConnectors).where(and(
    eq(userConnectors.userAgentId, subject.targetAgentId), eq(userConnectors.provider, definition.id),
  ));
  return NextResponse.json({ success: true });
}
