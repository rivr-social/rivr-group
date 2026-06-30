// src/lib/federation/kg-scope-authz.ts

import { isGroupMember } from "@/lib/permissions";
import {
  canPostToGroup,
  hasGroupWriteAccess,
} from "@/app/actions/resource-creation/helpers";

/**
 * GRP-SEC-001 — verified-principal authorization for federated KG scopes.
 *
 * The federated KG handlers (`kg_push_doc`, `kg_query` in
 * `src/app/api/federation/mutations/route.ts`) previously trusted the
 * caller-supplied `scope_id`: a peer-authenticated actor could push documents
 * into — or read triples out of — an ARBITRARY group/agent scope it has no
 * relationship to, simply by naming that scope in the request payload. The
 * autobot KG token-server has no notion of RIVR group membership, so the
 * scope check is this instance's responsibility.
 *
 * This applies the verified-principal model: the scope is authorized against
 * the cryptographically-verified principal (`actorId` — proven by the
 * federated assertion in `handleFederatedInteraction`), never the ambient
 * `scope_id` claim.
 *
 * Rules:
 * - **Self scope** (`scopeId === actorId`): always allowed — the principal
 *   acting on its own id (e.g. a person-scoped KG keyed by the actor).
 * - **Group scope**: WRITE requires content-post authorization on that group
 *   (`canPostToGroup` — an active membership edge with the post capability, or
 *   manage access); READ requires an active membership edge or manage access.
 *   A federated actor that never joined the group is rejected.
 * - **Any other scope type** addressed at an id other than the principal's own
 *   is rejected — a shared peer channel never authorizes acting on a third
 *   party's non-group scope.
 */

/** KG `scope_type` value for a group-owned knowledge graph. */
export const KG_SCOPE_TYPE_GROUP = "group";

/** Read vs write intent — sets the authorization bar for group scopes. */
export type KgScopeMode = "read" | "write";

/** Outcome of a KG scope authorization check. */
export interface KgScopeAuthzResult {
  /** True when the verified principal is entitled to the requested scope. */
  ok: boolean;
  /** Human-readable denial reason; present only when `ok` is false. */
  reason?: string;
}

/**
 * Authorize a verified principal against a requested KG scope.
 *
 * @param actorId   The verified principal (assertion-proven federated actor).
 * @param scopeType The KG `scope_type` (e.g. `"group"`, `"person"`).
 * @param scopeId   The KG `scope_id` being written/read.
 * @param mode      `"write"` for ingestion, `"read"` for queries.
 * @returns `{ ok: true }` when entitled; `{ ok: false, reason }` otherwise.
 */
export async function authorizeKgScope(
  actorId: string,
  scopeType: string,
  scopeId: string,
  mode: KgScopeMode,
): Promise<KgScopeAuthzResult> {
  // The principal acting on its own id is always entitled.
  if (scopeId === actorId) {
    return { ok: true };
  }

  if (scopeType === KG_SCOPE_TYPE_GROUP) {
    if (mode === "write") {
      const allowed = await canPostToGroup(actorId, scopeId);
      return allowed
        ? { ok: true }
        : {
            ok: false,
            reason:
              "Principal is not authorized to write to this group's knowledge graph",
          };
    }

    const membership = await isGroupMember(actorId, scopeId);
    if (membership.isMember || (await hasGroupWriteAccess(actorId, scopeId))) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        "Principal is not a member of this group's knowledge graph scope",
    };
  }

  return {
    ok: false,
    reason: `Principal is not authorized for scope_type='${scopeType}' scope_id='${scopeId}'`,
  };
}
