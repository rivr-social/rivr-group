/**
 * Site builder page for `/builder` (Phase G / P-G4, sovereign group port).
 *
 * Purpose:
 * - Lets a first-class owner (a person OR a group the user administers) generate
 *   and publish a static site from their RIVR Resources.
 *
 * Owner targeting:
 * - Default: the signed-in user builds their OWN site.
 * - `?group=<groupId>`: the user builds THAT group's site, provided they have
 *   group-write access (admins). The requested group only NAMES the target; the
 *   authority is verified here server-side via `hasGroupWriteAccess` (and again
 *   in every `/api/builder/*` action via `resolveSiteOwnerSubject`), never
 *   trusted from the client. Unauthorized targets redirect to the group page.
 *
 * Rendering: Server Component. Resolves the target owner + current publication
 * state server-side, then delegates interaction to the thin `BuilderClient`.
 * Generation/publish run server-side (API routes under `/api/builder/*`) so the
 * client bundle stays light.
 *
 * Auth: Redirects unauthenticated visitors to `/auth/login?next=/builder`.
 *
 * Sovereign adaptation: unlike global, this group instance has no A7 DNS
 * connector lane, so custom-domain binding is not offered here — a published
 * site is served under the instance's OWN host at `/groups/<ownerId>/site`.
 *
 * @module builder/page
 */
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hasGroupWriteAccess } from "@/app/actions/resource-creation/helpers";
import {
  getSitePublication,
  listSiteVersions,
  type PublicSitePublication,
  type PublicSiteVersion,
} from "@/lib/builder/site-service";
import { SITE_SECTION_IDS, SITE_THEME_PRESETS } from "@/lib/builder/site-model";
import { BuilderClient } from "./builder-client";

export const dynamic = "force-dynamic";

export default async function BuilderPage(props: {
  searchParams: Promise<{ group?: string }>;
}) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    const { group } = await props.searchParams;
    const next = group ? `/builder?group=${encodeURIComponent(group)}` : "/builder";
    redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }

  const { group: requestedGroupId } = await props.searchParams;

  // Resolve the target owner. Building a group's site requires group-write
  // access; the requested id only names the target and is authorized here.
  let ownerId = userId!;
  let ownerLabel: string | null = null;
  let isGroupTarget = false;
  if (requestedGroupId && requestedGroupId !== userId) {
    const allowed = await hasGroupWriteAccess(userId!, requestedGroupId);
    if (!allowed) {
      redirect(`/groups/${requestedGroupId}`);
    }
    ownerId = requestedGroupId;
    isGroupTarget = true;
    const [row] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, requestedGroupId))
      .limit(1);
    ownerLabel = row?.name ?? null;
  }

  let publication: PublicSitePublication | null = null;
  let versions: PublicSiteVersion[] = [];
  try {
    [publication, versions] = await Promise.all([
      getSitePublication(ownerId),
      listSiteVersions(ownerId),
    ]);
  } catch (error) {
    console.error("[builder/page] failed to load site state:", error);
  }

  return (
    <BuilderClient
      ownerId={ownerId}
      targetAgentId={isGroupTarget ? ownerId : undefined}
      ownerLabel={ownerLabel}
      publishedSiteUrl={`/groups/${ownerId}/site`}
      initialPublication={publication}
      initialVersions={versions}
      sectionIds={[...SITE_SECTION_IDS]}
      themePresets={Object.keys(SITE_THEME_PRESETS)}
    />
  );
}
