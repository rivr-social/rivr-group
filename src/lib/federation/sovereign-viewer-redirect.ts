/**
 * Universal Manifest "one home per user" guard for self-identity pages.
 *
 * INVARIANT: every identity has exactly ONE canonical home instance. No other
 * instance may render that identity's profile page — it must redirect to the
 * home. A peer keeps at most a thin projected `agents` row (name + avatar +
 * `metadata.homeBaseUrl`) for display inside aggregated content; that row must
 * NEVER masquerade as the home profile.
 *
 * This guard runs at the top of the self `/profile` route on every instance and
 * bounces a viewer to their home whenever this instance is NOT their home,
 * regardless of how they are authenticated:
 *
 *  - **Federated cookie viewer** (`rivr_remote_viewer`): home is carried on the
 *    signed session (`session.user.homeBaseUrl`).
 *  - **Local NextAuth session on a projected mirror row**: a peer may hold a
 *    full `agents` row for a remote identity (even with a local password), so a
 *    local login looks "native". The projected row's `metadata.homeBaseUrl`
 *    (or `metadata.canonicalUrl`) names the real home; if it points elsewhere,
 *    redirect.
 *
 * The instance OWNER (`PRIMARY_AGENT_ID`) is home by definition and is never
 * redirected. A locally-homed identity (no remote `homeBaseUrl`, or one whose
 * host equals this instance) is also a no-op, so this is safe to call
 * unconditionally at the top of any self-identity page.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/get-session";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { getAgent } from "@/lib/queries/agents";

function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the canonical home base URL for a locally-authenticated viewer from
 * their projected `agents` row. Returns null for a locally-homed identity.
 */
async function localViewerHome(agentId: string): Promise<string | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const metadata = agent.metadata as Record<string, unknown> | null;
  return (
    metadataString(metadata, "homeBaseUrl") ??
    metadataString(metadata, "canonicalUrl")
  );
}

/**
 * Redirects a viewer whose canonical home is a different instance to the same
 * path on that home. No-op for the instance owner, locally-homed identities,
 * and anonymous viewers.
 *
 * @param subPath - Path to open on the home instance, e.g. `"/profile"`. Joined
 *   with exactly one slash. Defaults to `"/profile"`.
 */
export async function redirectFederatedViewerHome(
  subPath = "/profile",
): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const config = getInstanceConfig();
  const localHost = hostOf(config.baseUrl);

  // The instance owner is home by definition — never bounce them.
  if (config.primaryAgentId && session.user.id === config.primaryAgentId) {
    return;
  }

  const homeBaseUrl =
    session.user.authMethod === "federated"
      ? session.user.homeBaseUrl
      : await localViewerHome(session.user.id);

  const homeHost = hostOf(homeBaseUrl);
  // No remote home, unparseable home, or home == this instance → stay put.
  if (!homeHost || homeHost === localHost) return;

  const target = `${homeBaseUrl!.replace(/\/+$/, "")}/${subPath.replace(/^\/+/, "")}`;
  redirect(target);
}
