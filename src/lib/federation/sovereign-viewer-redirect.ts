/**
 * Universal Manifest source-routing guard for the viewer's own identity pages.
 *
 * The sibling {@link ./sovereign-resource-redirect.redirectIfSovereignResource}
 * keeps a federated *resource* on its source instance. This guard does the same
 * for a federated *viewer*: a person whose canonical identity is homed on
 * another instance must view and edit their OWN profile on their home, never on
 * a local mirror of their identity.
 *
 * Without this, a cross-instance SSO visitor landing on a sovereign peer's
 * `/profile` (a self-view route) hits a client component that only reads the
 * local NextAuth session. A federated viewer authenticates via the signed
 * `rivr_remote_viewer` cookie instead, so that client never sees their identity
 * and renders the empty "Your Profile / @user" placeholder. The correct UM
 * behavior is to bounce them to their home instance, where their real profile
 * (name, avatar, content) is authoritative.
 *
 * Local NextAuth users — including this instance's owner — are never federated
 * viewers, so this is a no-op for them and is safe to call unconditionally at
 * the top of any self-identity page.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/get-session";
import { getInstanceConfig } from "@/lib/federation/instance-config";

function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

/**
 * Redirects a federated viewer (homed on another instance) to the same path on
 * their home instance. No-op for local NextAuth sessions and anonymous viewers.
 *
 * @param subPath - Path to open on the home instance, e.g. `"/profile"`. Joined
 *   with exactly one slash. Defaults to `"/profile"`.
 */
export async function redirectFederatedViewerHome(
  subPath = "/profile",
): Promise<void> {
  const session = await getSession();
  if (!session || session.user.authMethod !== "federated") return;

  const homeBaseUrl = session.user.homeBaseUrl;
  const homeHost = hostOf(homeBaseUrl);
  if (!homeHost) return;

  // Defensive: if the cookie's home somehow points back at this instance, do
  // not redirect (would loop).
  const localHost = hostOf(getInstanceConfig().baseUrl);
  if (homeHost === localHost) return;

  const target = `${homeBaseUrl!.replace(/\/+$/, "")}/${subPath.replace(/^\/+/, "")}`;
  redirect(target);
}
