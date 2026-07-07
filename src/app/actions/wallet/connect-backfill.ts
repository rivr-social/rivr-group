'use server';

/**
 * Connect-account backfill — the "every subscribing member gets a Stripe
 * Connect account" lane. Connected accounts are NOT provisioned for every
 * agent: they are created when an agent becomes a SUBSCRIBING MEMBER (a
 * cooperative membership subscription on the `subscriptions` rail — tiers
 * basic/host/seller/organizer/steward, kept `active`/`trialing` by the Stripe
 * webhook's `handleSubscriptionUpsert`).
 *
 * Going forward the webhook provisions the account at activation time (see
 * `api/stripe/webhook/route.ts`); this action backfills agents who subscribed
 * BEFORE that wiring existed, plus retries any activation-time failures. The
 * batch targets: every local agent holding an active/trialing membership
 * subscription, PLUS the instance's group agent itself (the sovereign group —
 * e.g. Spirit — is an Organization-grade subscriber of the platform).
 *
 * Provisioning goes through the shared core (`@/lib/connect-account`, the
 * same path seller onboarding uses), so ids land on settlement-wallet
 * metadata exactly where every existing reader looks.
 *
 * Instance-admin gated: the caller must be a platform admin
 * (`metadata.siteRole === 'admin'`) or hold group manage access on the
 * PRIMARY group (`hasGroupManageAccess` — which also honors the delegated
 * controller of an MCP session, so the group agent can run this under an
 * admin's delegation via `rivr.payments.backfill_connect_accounts`).
 *
 * Resumable/idempotent: agents that already have an account count as
 * `existing` (no Stripe call), each agent runs under its own try/catch so one
 * failure never aborts the batch, and a re-run simply converts prior
 * successes into `existing`.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { agents, subscriptions } from '@/db/schema';
import { updateFacade, emitDomainEvent, EVENT_TYPES } from '@/lib/federation';
import { getInstanceConfig } from '@/lib/federation/instance-config';
import { ensureConnectAccountForAgent } from '@/lib/connect-account';
import {
  hasGroupManageAccess,
  resolveAuthenticatedUserId,
} from '@/app/actions/resource-creation/helpers';
import { GROUP_LIKE_OWNER_AGENT_TYPES } from '@/app/actions/resource-creation/types';
import { getAgentRecord } from './helpers';

/** How many agents are provisioned against Stripe at once. */
const BACKFILL_CONCURRENCY = 3;

/**
 * Subscription statuses that count as an active membership — the same pair
 * `getActiveSubscription` / `hasEntitlement` (lib/billing.ts) treat as live.
 */
const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing'] as const;

export interface ConnectBackfillFailure {
  agentId: string;
  error: string;
}

export interface ConnectBackfillResult {
  success: boolean;
  /** Accounts created by this run. */
  created?: number;
  /** Agents that already had an account (no Stripe call). */
  existing?: number;
  /** Per-agent failures; the rest of the batch still ran. */
  failed?: ConnectBackfillFailure[];
  error?: string;
}

/** A minimal agent row for local-agent filtering. */
interface CandidateAgentRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * True for agents that live on THIS instance — federated projections carry
 * `metadata.sourceNodeId` (and placeholders `metadata.federatedPlaceholder`),
 * and their payment accounts belong to their home instance, not this one.
 */
function isLocalAgent(row: CandidateAgentRow): boolean {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (metadata.federatedPlaceholder === true) return false;
  if (typeof metadata.sourceNodeId === 'string' && metadata.sourceNodeId.length > 0) return false;
  return true;
}

/**
 * Validate the instance's group agent (the group treasury the batch always
 * includes) — it must exist locally, be group-like, and not be deleted.
 */
async function resolveTargetGroupAgentId(groupId: string): Promise<string> {
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.id, groupId),
        inArray(agents.type, [...GROUP_LIKE_OWNER_AGENT_TYPES]),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!group || !isLocalAgent(group)) {
    throw new Error('Backfill target group not found on this instance.');
  }

  return group.id;
}

/**
 * Collect local agents holding an active/trialing membership subscription —
 * the subscribing members the Connect-account entitlement belongs to.
 */
async function collectActiveSubscriberAgentIds(): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(subscriptions)
    .innerJoin(agents, eq(subscriptions.agentId, agents.id))
    .where(
      and(
        inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
        isNull(agents.deletedAt),
      ),
    );

  const uniqueLocalIds = new Set<string>();
  for (const row of rows) {
    if (isLocalAgent(row)) uniqueLocalIds.add(row.id);
  }
  return Array.from(uniqueLocalIds);
}

/**
 * Run `worker` over `items` with at most `limit` in flight. The worker is
 * responsible for its own error handling (the backfill catches per agent).
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Ensure every subscribing member has a Stripe Connect account.
 *
 * Population: every local agent with an active/trialing membership
 * subscription, plus the instance's group agent (`groupId` when given, else
 * the primary group).
 *
 * Gating: platform admin (`metadata.siteRole === 'admin'`) OR group manage
 * access on the PRIMARY group. Idempotent and re-run safe.
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

  const result = await updateFacade.execute(
    {
      type: 'backfillConnectAccountsAction',
      actorId,
      targetAgentId: targetGroupId,
      payload: { groupId: targetGroupId },
    },
    async () => {
      const [groupAgentId, subscriberAgentIds] = await Promise.all([
        resolveTargetGroupAgentId(targetGroupId),
        collectActiveSubscriberAgentIds(),
      ]);

      // The group agent leads the batch; dedupe in case the group itself also
      // holds a subscription row.
      const targetAgentIds = Array.from(new Set([groupAgentId, ...subscriberAgentIds]));

      let created = 0;
      let existing = 0;
      const failed: ConnectBackfillFailure[] = [];

      await runWithConcurrency(targetAgentIds, BACKFILL_CONCURRENCY, async (agentId) => {
        try {
          const ensured = await ensureConnectAccountForAgent(agentId);
          if (ensured.created) created += 1;
          else existing += 1;
        } catch (error) {
          // Failure isolation: record and continue — a single bad agent must
          // never abort the batch, and a re-run picks it up again.
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error(`backfillConnectAccountsAction failed for agent ${agentId}:`, error);
          failed.push({ agentId, error: message });
        }
      });

      return { success: true, created, existing, failed } as ConnectBackfillResult;
    },
  );

  if (!result.success) {
    console.error('backfillConnectAccountsAction failed:', result.error);
    return {
      success: false,
      error: result.error ?? 'Unable to run the payment-account backfill.',
    };
  }

  emitDomainEvent({
    eventType: EVENT_TYPES.WALLET_PAYOUT,
    entityType: 'wallet',
    entityId: targetGroupId,
    actorId,
    payload: {
      action: 'backfill_connect_accounts',
      groupId: targetGroupId,
      created: result.data?.created,
      existing: result.data?.existing,
      failedCount: result.data?.failed?.length ?? 0,
    },
  }).catch(() => {});

  return result.data ?? { success: true };
}
