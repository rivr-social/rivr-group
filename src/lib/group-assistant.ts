/**
 * Canonical group direct-agent resolver.
 *
 * The "direct agent" is the ONE agent identity the group's AI assistant runs
 * as. This is the group-app analogue of the person app's
 * `resolve-direct-agent`: a single resolution path so the assistant chat, any
 * builder surface, and future tooling all agree on (1) WHICH agent id is the
 * group's assistant, and (2) WHICH `autobotSettings` blob drives it.
 *
 * Resolution order (delegated to `findGroupAutobotPersona`):
 *   - the group's autobot-enabled child persona, if any; otherwise
 *   - the group agent's own row (when the flag is set directly on it).
 *
 * When neither carries the flag we fall back to the group agent id itself so
 * callers always have a valid identity to key settings off of (the group owns
 * the wallet + MCP authority).
 */

import { findGroupAutobotPersona } from "@/app/actions/group-personas";
import {
  getGroupAssistantSettings,
  type GroupAssistantSettings,
} from "@/lib/group-assistant-settings";

/** The resolved group direct agent + its assistant settings. */
export interface ResolvedGroupDirectAgent {
  /** Agent id the assistant runs as (persona or the group agent itself). */
  directAgentId: string;
  /** The controlling group agent id. */
  groupId: string;
  /** Whether the resolved direct agent is a child persona (vs. the group). */
  isPersona: boolean;
  /** Whether an autobot-enabled persona/self was actually found. */
  hasAutobotPersona: boolean;
  /** The direct agent's assistant settings (model, soul prompt, MCP token). */
  settings: GroupAssistantSettings;
}

/**
 * Resolve the canonical direct-agent for a group and load its assistant
 * settings. This is the ONE path the assistant + any builder share.
 *
 * @param groupId - The group agent id. Must be non-empty.
 * @returns The resolved direct agent id + its assistant settings.
 * @throws {Error} When `groupId` is empty.
 */
export async function resolveGroupDirectAgent(
  groupId: string,
): Promise<ResolvedGroupDirectAgent> {
  if (!groupId) {
    throw new Error("resolveGroupDirectAgent: groupId is required.");
  }

  const persona = await findGroupAutobotPersona(groupId);
  const hasAutobotPersona = persona !== null;
  const directAgentId = persona?.id ?? groupId;
  const isPersona = directAgentId !== groupId;

  const settings = await getGroupAssistantSettings(directAgentId);

  return {
    directAgentId,
    groupId,
    isPersona,
    hasAutobotPersona,
    settings,
  };
}
