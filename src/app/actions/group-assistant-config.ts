"use server";

/**
 * Admin-gated server actions for configuring a group's AI assistant.
 *
 * These let a group admin choose the assistant model, author the operator
 * "soul" prompt, pick KG scope ids, and toggle whether the assistant is
 * exposed to non-admin visitors. All settings persist via
 * `saveGroupAssistantSettings` onto the group's direct agent.
 *
 * Authorization: every action requires the caller to be a group admin
 * (`isGroupAdmin`). The fetch action additionally surfaces the resolved direct
 * agent so the admin UI knows whether a persona or the group agent is acting
 * as the assistant.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getAuthenticatedActorId } from "@/lib/server-auth";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { resolveGroupDirectAgent } from "@/lib/group-assistant";
import {
  saveGroupAssistantSettings,
  type GroupAssistantSettings,
} from "@/lib/group-assistant-settings";
import { SHARE_CLASS_GROUP_TYPE } from "./wallet/share-classes-types";
import { ALLOWED_ASSISTANT_MODELS } from "./group-assistant-config-types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_SOUL_MD_LENGTH = 8000;

const ALLOWED_MODEL_SET = new Set<string>(ALLOWED_ASSISTANT_MODELS);

export interface AssistantConfigResult {
  success: boolean;
  error?: string;
}

/** A knowledge-source scope the admin picker can toggle by name. */
export interface AssistantScopeOption {
  id: string;
  name: string;
}

export interface AssistantScopeOptionsResult extends AssistantConfigResult {
  options?: AssistantScopeOption[];
}

export interface AssistantConfigFetchResult extends AssistantConfigResult {
  config?: {
    directAgentId: string;
    isPersona: boolean;
    hasAutobotPersona: boolean;
    selectedModel: string;
    customSoulMd: string;
    includedKgScopeIds: string[];
    publicChatEnabled: boolean;
  };
}

async function requireAdmin(
  groupId: string,
): Promise<{ ok: true; actorId: string } | { ok: false; error: string }> {
  const actorId = await getAuthenticatedActorId();
  if (!actorId) return { ok: false, error: "Authentication required." };
  if (!groupId || !UUID_RE.test(groupId)) {
    return { ok: false, error: "Invalid group identifier." };
  }
  if (!(await isGroupAdmin(actorId, groupId))) {
    return { ok: false, error: "Only group admins can configure the assistant." };
  }
  return { ok: true, actorId };
}

/**
 * Load the current assistant configuration for the admin UI.
 */
export async function fetchGroupAssistantConfig(
  groupId: string,
): Promise<AssistantConfigFetchResult> {
  const auth = await requireAdmin(groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  const direct = await resolveGroupDirectAgent(groupId);
  return {
    success: true,
    config: {
      directAgentId: direct.directAgentId,
      isPersona: direct.isPersona,
      hasAutobotPersona: direct.hasAutobotPersona,
      selectedModel: direct.settings.selectedModel,
      customSoulMd: direct.settings.customSoulMd,
      includedKgScopeIds: direct.settings.includedKgScopeIds,
      publicChatEnabled: direct.settings.publicChatEnabled,
    },
  };
}

/**
 * List the knowledge-source scopes the admin picker can offer by name: the
 * group itself (first) plus its non-deleted DIRECT subgroups, excluding hidden
 * share-class subgroups. Gated exactly like {@link fetchGroupAssistantConfig}.
 */
export async function getAssistantScopeOptionsAction(
  groupId: string,
): Promise<AssistantScopeOptionsResult> {
  const auth = await requireAdmin(groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  const [group] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, groupId), sql`${agents.deletedAt} IS NULL`))
    .limit(1);
  if (!group) return { success: false, error: "Group not found." };

  const subgroups = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.parentId, groupId),
        sql`${agents.deletedAt} IS NULL`,
        sql`COALESCE(${agents.metadata} ->> 'groupType', '') <> ${SHARE_CLASS_GROUP_TYPE}`,
      ),
    )
    .orderBy(asc(agents.name));

  return {
    success: true,
    options: [{ id: group.id, name: group.name }, ...subgroups],
  };
}

/**
 * Persist an assistant configuration patch. Validates the model selector and
 * soul-prompt length before saving onto the resolved direct agent.
 */
export async function updateGroupAssistantConfig(input: {
  groupId: string;
  selectedModel?: string;
  customSoulMd?: string;
  includedKgScopeIds?: string[];
  publicChatEnabled?: boolean;
}): Promise<AssistantConfigResult> {
  const auth = await requireAdmin(input.groupId);
  if (!auth.ok) return { success: false, error: auth.error };

  const patch: Partial<GroupAssistantSettings> = {};

  if (input.selectedModel !== undefined) {
    if (!ALLOWED_MODEL_SET.has(input.selectedModel)) {
      return { success: false, error: "Unsupported assistant model." };
    }
    patch.selectedModel = input.selectedModel;
  }

  if (input.customSoulMd !== undefined) {
    if (input.customSoulMd.length > MAX_SOUL_MD_LENGTH) {
      return {
        success: false,
        error: `Operator instructions must be under ${MAX_SOUL_MD_LENGTH} characters.`,
      };
    }
    patch.customSoulMd = input.customSoulMd;
  }

  if (input.includedKgScopeIds !== undefined) {
    if (!Array.isArray(input.includedKgScopeIds)) {
      return { success: false, error: "Invalid KG scope selection." };
    }
    patch.includedKgScopeIds = input.includedKgScopeIds;
  }

  if (input.publicChatEnabled !== undefined) {
    patch.publicChatEnabled = input.publicChatEnabled === true;
  }

  // The patch targets the group's resolved direct agent so settings always
  // attach to whichever agent actually runs the assistant.
  const direct = await resolveGroupDirectAgent(input.groupId);
  await saveGroupAssistantSettings(direct.directAgentId, patch);

  return { success: true };
}
