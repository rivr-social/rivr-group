'use server';

/**
 * Legacy local Connect-account backfill entry point.
 *
 * Global is the ecosystem's sole Stripe platform and owns connected-account
 * provisioning. Group retains the authorization gate so untrusted callers do
 * not learn operational details, then fails closed with the authoritative
 * routing requirement.
 *
 * Instance-admin gated: the caller must be a platform admin
 * (`metadata.siteRole === 'admin'`) or hold group manage access on the
 * PRIMARY group (`hasGroupManageAccess` — which also honors the delegated
 * controller of an MCP session, so the group agent can run this under an
 * admin's delegation via `rivr.payments.backfill_connect_accounts`).
 *
 */

import { getInstanceConfig } from '@/lib/federation/instance-config';
import {
  hasGroupManageAccess,
  resolveAuthenticatedUserId,
} from '@/app/actions/resource-creation/helpers';
import { getAgentRecord } from './helpers';

/** Retained for API compatibility; Group no longer runs a provisioning batch. */
export interface ConnectBackfillFailure {
  agentId: string;
  error: string;
}

export interface ConnectBackfillResult {
  success: boolean;
  /** Retained for consumers of the former local batch API. */
  created?: number;
  /** Retained for consumers of the former local batch API. */
  existing?: number;
  /** Retained for consumers of the former local batch API. */
  failed?: ConnectBackfillFailure[];
  error?: string;
}

/**
 * Reject local provisioning after authenticating and authorizing the caller.
 */
export async function backfillConnectAccountsAction(
  groupId?: string,
): Promise<ConnectBackfillResult> {
  const actorId = await resolveAuthenticatedUserId();
  if (!actorId) {
    return { success: false, error: 'You must be logged in.' };
  }

  const primaryGroupId = getInstanceConfig().primaryAgentId;
  const targetGroupId = groupId ?? primaryGroupId;
  if (!targetGroupId) {
    return { success: false, error: 'This instance has no primary group configured.' };
  }

  const actor = await getAgentRecord(actorId);
  const isPlatformAdmin = actor?.metadata?.siteRole === 'admin';
  const gateGroupId = primaryGroupId ?? targetGroupId;
  if (!isPlatformAdmin && !(await hasGroupManageAccess(actorId, gateGroupId))) {
    return {
      success: false,
      error: 'You are not allowed to run the payment-account backfill for this instance.',
    };
  }

  return {
    success: false,
    error:
      'Connected-account backfill is owned by Global. This Group instance cannot provision Stripe accounts.',
  };
}
