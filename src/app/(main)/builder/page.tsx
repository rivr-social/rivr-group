/**
 * Site builder page for `/builder` (Phase G / P-G4, sovereign group port).
 *
 * Purpose:
 * - Lets a first-class owner (a person OR a group the user administers) generate
 *   and publish a static site from their RIVR Resources.
 *
 * Rendering: Server Component. Resolves the session owner and the current
 * publication state server-side, then delegates interaction to the thin
 * `BuilderClient` component. Generation/publish run server-side (API routes under
 * `/api/builder/*`) so the client bundle stays light.
 *
 * Auth: Redirects unauthenticated visitors to `/auth/login?next=/builder`.
 *
 * Sovereign adaptation: unlike global, this group instance has no A7 DNS
 * connector lane, so custom-domain binding is not offered here — this is a
 * focused generate/publish surface only.
 *
 * @module builder/page
 */
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import {
  getSitePublication,
  listSiteVersions,
  type PublicSitePublication,
  type PublicSiteVersion,
} from "@/lib/builder/site-service";
import { SITE_SECTION_IDS, SITE_THEME_PRESETS } from "@/lib/builder/site-model";
import { BuilderClient } from "./builder-client";

export const dynamic = "force-dynamic";

export default async function BuilderPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) {
    redirect("/auth/login?next=/builder");
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
      initialPublication={publication}
      initialVersions={versions}
      sectionIds={[...SITE_SECTION_IDS]}
      themePresets={Object.keys(SITE_THEME_PRESETS)}
    />
  );
}
