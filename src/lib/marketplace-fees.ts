import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { MARKETPLACE_FEE_BPS } from "@/lib/wallet-constants";

export const MIN_MARKETPLACE_FEE_BPS = 0;
export const MAX_MARKETPLACE_FEE_BPS = 5_000;

const GROUP_LIKE_AGENT_TYPES = new Set([
  "organization",
  "org",
  "ring",
  "family",
  "guild",
  "community",
  "domain",
]);

export type MarketplaceFeeSource =
  | "listing_override"
  | "owner_group_policy"
  | "instance_group_policy"
  | "default";

export type MarketplaceFeePolicy = {
  feeBps: number;
  source: MarketplaceFeeSource;
  policyAgentId: string | null;
};

export function normalizeMarketplaceFeeBps(value: unknown): number | null {
  if (!Number.isInteger(value)) return null;
  const parsed = Number(value);
  if (parsed < MIN_MARKETPLACE_FEE_BPS || parsed > MAX_MARKETPLACE_FEE_BPS) {
    return null;
  }
  return parsed;
}

function readMarketplaceFeeBpsFromMetadata(metadata: Record<string, unknown> | null | undefined): number | null {
  if (!metadata || typeof metadata !== "object") return null;

  const direct = normalizeMarketplaceFeeBps(metadata.marketplaceFeeBps);
  if (direct !== null) return direct;

  const marketplace = metadata.marketplace;
  if (marketplace && typeof marketplace === "object" && !Array.isArray(marketplace)) {
    const fromMarketplace =
      normalizeMarketplaceFeeBps((marketplace as Record<string, unknown>).feeBps) ??
      normalizeMarketplaceFeeBps((marketplace as Record<string, unknown>).marketplaceFeeBps);
    if (fromMarketplace !== null) return fromMarketplace;
  }

  const settings = metadata.marketplaceSettings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const fromSettings =
      normalizeMarketplaceFeeBps((settings as Record<string, unknown>).feeBps) ??
      normalizeMarketplaceFeeBps((settings as Record<string, unknown>).marketplaceFeeBps);
    if (fromSettings !== null) return fromSettings;
  }

  return null;
}

async function getGroupPolicyFeeBps(agentId: string): Promise<{ feeBps: number; agentId: string } | null> {
  const group = await db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), isNull(agents.deletedAt)),
    columns: {
      id: true,
      type: true,
      metadata: true,
    },
  });

  if (!group) return null;
  if (!GROUP_LIKE_AGENT_TYPES.has(group.type)) return null;

  const feeBps = readMarketplaceFeeBpsFromMetadata(
    group.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : null,
  );
  if (feeBps === null) return null;

  return { feeBps, agentId: group.id };
}

export async function resolveMarketplaceFeePolicy(params: {
  ownerAgentId: string;
  listingMetadata?: Record<string, unknown> | null;
}): Promise<MarketplaceFeePolicy> {
  const listingOverride = readMarketplaceFeeBpsFromMetadata(params.listingMetadata ?? null);
  if (listingOverride !== null) {
    return {
      feeBps: listingOverride,
      source: "listing_override",
      policyAgentId: params.ownerAgentId,
    };
  }

  const ownerPolicy = await getGroupPolicyFeeBps(params.ownerAgentId);
  if (ownerPolicy) {
    return {
      feeBps: ownerPolicy.feeBps,
      source: "owner_group_policy",
      policyAgentId: ownerPolicy.agentId,
    };
  }

  const config = getInstanceConfig();
  if (config.primaryAgentId && config.primaryAgentId !== params.ownerAgentId) {
    const instancePolicy = await getGroupPolicyFeeBps(config.primaryAgentId);
    if (instancePolicy) {
      return {
        feeBps: instancePolicy.feeBps,
        source: "instance_group_policy",
        policyAgentId: instancePolicy.agentId,
      };
    }
  }

  return {
    feeBps: MARKETPLACE_FEE_BPS,
    source: "default",
    policyAgentId: null,
  };
}
