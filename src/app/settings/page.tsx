/**
 * Settings page for `/settings`.
 *
 * Purpose:
 * - Loads the current user's profile data (name, username, email, bio, phone, image)
 *   and renders a client-side `SettingsForm` for editing.
 *
 * Rendering: Server Component (no `"use client"` directive).
 * Data requirements:
 * - Authenticated session via `auth()`.
 * - User agent row from the database (`agents` table) queried by session user ID.
 *
 * Auth: Redirects to `/auth/login` if no session or no matching user exists.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module settings/page
 */
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { SettingsForm, type SettingsInitialData } from "./settings-form";
import { buildFederationIdentityStatus, type FederationIdentityStatus } from "@/lib/federation-identities";
import { buildAppReleaseStatus, type AppReleaseStatus } from "@/lib/app-release";

/**
 * Generates a URL-safe fallback username from the user's display name.
 * @param name - The user's display name.
 * @returns A lowercased, hyphenated string, or "user" if the name is empty.
 */
function fallbackUsername(name: string): string {
  const base = name.trim().toLowerCase().replace(/\s+/g, "-");
  return base || "user";
}

/**
 * Server-rendered settings page that fetches user data and delegates to `SettingsForm`.
 *
 * @returns The `SettingsForm` client component hydrated with the user's current data.
 */
export default async function SettingsPage() {
  // Auth check: redirect unauthenticated visitors to login.
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  // Fetch the user's agent row from the database.
  const [currentUser] = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      image: agents.image,
      description: agents.description,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  // If the agent row is missing (orphaned session), redirect to login.
  if (!currentUser) {
    redirect("/auth/login");
  }

  // Safely extract metadata as a record for field lookups.
  const metadata =
    currentUser.metadata && typeof currentUser.metadata === "object"
      ? (currentUser.metadata as Record<string, unknown>)
      : {};

  // Assemble initial form data with fallbacks for missing fields.
  const initialData: SettingsInitialData = {
    name: currentUser.name,
    username:
      typeof metadata.username === "string" && metadata.username
        ? metadata.username
        : fallbackUsername(currentUser.name),
    email: currentUser.email ?? "",
    bio:
      currentUser.description ??
      (typeof metadata.bio === "string" ? metadata.bio : ""),
    tagline: typeof metadata.tagline === "string" ? metadata.tagline : "",
    phone: typeof metadata.phone === "string" ? metadata.phone : "",
    image: currentUser.image ?? "",
    skills: Array.isArray(metadata.skills) ? (metadata.skills as string[]) : [],
    geneKeys: typeof metadata.geneKeys === "string" ? metadata.geneKeys : "",
    humanDesign: typeof metadata.humanDesign === "string" ? metadata.humanDesign : "",
    westernAstrology: typeof metadata.westernAstrology === "string" ? metadata.westernAstrology : "",
    vedicAstrology: typeof metadata.vedicAstrology === "string" ? metadata.vedicAstrology : "",
    ocean: typeof metadata.ocean === "string" ? metadata.ocean : "",
    myersBriggs: typeof metadata.myersBriggs === "string" ? metadata.myersBriggs : "",
    enneagram: typeof metadata.enneagram === "string" ? metadata.enneagram : "",
    homeLocale: typeof metadata.homeLocale === "string" ? metadata.homeLocale : "",
    murmurationsPublishing: metadata.murmurationsPublishing === true,
    socialLinks: typeof metadata.socialLinks === 'object' && metadata.socialLinks !== null && !Array.isArray(metadata.socialLinks)
      ? metadata.socialLinks as Record<string, string>
      : Array.isArray(metadata.socialLinks)
        ? Object.fromEntries((metadata.socialLinks as {platform: string; url: string}[]).map(l => [l.platform, l.url]))
        : {},
    profilePhotos: Array.isArray(metadata.profilePhotos)
      ? metadata.profilePhotos.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
    privacySettings: metadata.privacySettings && typeof metadata.privacySettings === "object" && !Array.isArray(metadata.privacySettings)
      ? metadata.privacySettings as SettingsInitialData["privacySettings"]
      : {},
    notificationSettings: metadata.notificationSettings && typeof metadata.notificationSettings === "object" && !Array.isArray(metadata.notificationSettings)
      ? metadata.notificationSettings as SettingsInitialData["notificationSettings"]
      : { pushNotifications: false, emailNotifications: true, eventReminders: true, newMessages: true },
  };

  let initialFederationStatus: FederationIdentityStatus | null = null;
  try {
    initialFederationStatus = await buildFederationIdentityStatus(currentUser.id);
  } catch {
    initialFederationStatus = null;
  }

  let initialAppReleaseStatus: AppReleaseStatus | null = null;
  try {
    initialAppReleaseStatus = await buildAppReleaseStatus({
      appName: "rivr-group",
      defaultVersion: "0.1.0",
      defaultUpstreamRepo: "rivr-social/rivr-group",
    });
  } catch {
    initialAppReleaseStatus = null;
  }

  return (
    <SettingsForm
      initialData={initialData}
      initialFederationStatus={initialFederationStatus}
      initialAppReleaseStatus={initialAppReleaseStatus}
    />
  );
}
