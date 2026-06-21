/**
 * Shared agent-type classifications.
 *
 * `GROUP_AGENT_TYPES` is the canonical allowlist of agent types that represent
 * a collective an individual can be a member, admin, or creator of (as opposed
 * to people, events, places, or system agents). It mirrors the `agent_type`
 * enum's group-like members in `@/db/schema`.
 *
 * Use this everywhere a "is this agent a group?" decision is made — group
 * membership lookups, group-wallet visibility, settlement routing, group
 * pickers — so the set stays consistent across the codebase.
 */
import type { AgentType } from "@/db/schema";

export const GROUP_AGENT_TYPES = [
  "organization",
  "org",
  "ring",
  "family",
  "guild",
  "community",
] as const satisfies readonly AgentType[];

export type GroupAgentType = (typeof GROUP_AGENT_TYPES)[number];

/**
 * Returns true when the given agent type string is a group-like type.
 * Case-insensitive; tolerant of null/undefined.
 */
export function isGroupAgentType(
  agentType: string | null | undefined,
): agentType is GroupAgentType {
  return (GROUP_AGENT_TYPES as readonly string[]).includes(
    (agentType ?? "").toLowerCase(),
  );
}
