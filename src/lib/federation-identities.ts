import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getFederationStatus, getHostedNodeForOwner } from "@/lib/federation";

export type FederationIdentityStatus = {
  node: {
    enabled: boolean;
    slug?: string;
    baseUrl?: string;
    trustedPeers?: number;
    queuedEvents?: number;
    exportedEvents?: number;
  };
  peermesh: {
    linked: boolean;
    handle: string | null;
    did: string | null;
    publicKey: string | null;
    manifestId: string | null;
    manifestUrl: string | null;
    linkedAt: string | null;
  };
  atproto: {
    linked: boolean;
    handle: string | null;
    did: string | null;
    linkedAt: string | null;
  };
};

export async function buildFederationIdentityStatus(userId: string): Promise<FederationIdentityStatus> {
  const [agent] = await db
    .select({
      peermeshHandle: agents.peermeshHandle,
      peermeshDid: agents.peermeshDid,
      peermeshPublicKey: agents.peermeshPublicKey,
      peermeshManifestId: agents.peermeshManifestId,
      peermeshManifestUrl: agents.peermeshManifestUrl,
      peermeshLinkedAt: agents.peermeshLinkedAt,
      atprotoHandle: agents.atprotoHandle,
      atprotoDid: agents.atprotoDid,
      atprotoLinkedAt: agents.atprotoLinkedAt,
    })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  if (!agent) {
    throw new Error("Your profile could not be loaded.");
  }

  const node = await getHostedNodeForOwner(userId);
  const metrics = node ? await getFederationStatus(node.id) : null;

  return {
    node: {
      enabled: !!node,
      slug: node?.slug,
      baseUrl: node?.baseUrl,
      trustedPeers: metrics?.trustedPeers,
      queuedEvents: metrics?.queuedEvents,
      exportedEvents: metrics?.exportedEvents,
    },
    peermesh: {
      linked: !!agent.peermeshLinkedAt,
      handle: agent.peermeshHandle,
      did: agent.peermeshDid,
      publicKey: agent.peermeshPublicKey,
      manifestId: agent.peermeshManifestId,
      manifestUrl: agent.peermeshManifestUrl,
      linkedAt: agent.peermeshLinkedAt?.toISOString() ?? null,
    },
    atproto: {
      linked: !!agent.atprotoLinkedAt,
      handle: agent.atprotoHandle,
      did: agent.atprotoDid,
      linkedAt: agent.atprotoLinkedAt?.toISOString() ?? null,
    },
  };
}
