// src/lib/federation/domain-events.ts

import { db } from "@/db";
import { federationEvents, nodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getInstanceConfig } from "./instance-config";

/**
 * Domain event envelope — the standard format for all events emitted
 * by a Rivr instance.
 */
export interface DomainEvent {
  id: string;
  sequence?: number;
  instanceId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorId: string;
  timestamp: string;
  version: number;
  payload: Record<string, unknown>;
  metadata: {
    causationId?: string;
    correlationId?: string;
    idempotencyKey?: string;
  };
  signature?: string;
}

/**
 * Event types catalog — all recognized domain events.
 */
export const EVENT_TYPES = {
  // Agent events
  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_DELETED: 'agent.deleted',

  // Group events
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  GROUP_MEMBER_JOINED: 'group.member_joined',
  GROUP_MEMBER_LEFT: 'group.member_left',
  GROUP_MEMBER_ROLE_CHANGED: 'group.member_role_changed',
  GROUP_SETTINGS_UPDATED: 'group.settings_updated',

  // Resource events
  RESOURCE_CREATED: 'resource.created',
  RESOURCE_UPDATED: 'resource.updated',
  RESOURCE_DELETED: 'resource.deleted',

  // Post events
  POST_CREATED: 'post.created',
  POST_UPDATED: 'post.updated',
  POST_DELETED: 'post.deleted',
  POST_COMMENTED: 'post.commented',

  // Event events
  EVENT_CREATED: 'event.created',
  EVENT_UPDATED: 'event.updated',
  EVENT_CANCELLED: 'event.cancelled',
  EVENT_RSVP_CHANGED: 'event.rsvp_changed',

  // Marketplace events
  LISTING_CREATED: 'listing.created',
  LISTING_UPDATED: 'listing.updated',
  LISTING_PURCHASED: 'listing.purchased',

  // Wallet events
  WALLET_TRANSFER: 'wallet.transfer',
  WALLET_DEPOSIT: 'wallet.deposit',
  WALLET_PAYOUT: 'wallet.payout',

  // Subscription events
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_UPDATED: 'subscription.updated',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',

  // Permission events
  PERMISSION_GRANTED: 'permission.granted',
  PERMISSION_REVOKED: 'permission.revoked',
  ROLE_ASSIGNED: 'role.assigned',
  ROLE_REMOVED: 'role.removed',

  // Social events
  FOLLOW_CREATED: 'follow.created',
  FOLLOW_REMOVED: 'follow.removed',
  REACTION_TOGGLED: 'reaction.toggled',

  // Contract events
  CONTRACT_RULE_CREATED: 'contract_rule.created',
  CONTRACT_RULE_FIRED: 'contract_rule.fired',

  // Federation events
  INSTANCE_REGISTERED: 'instance.registered',
  INSTANCE_MIGRATING: 'instance.migrating',
  FEE_COLLECTED: 'fee.collected',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

/**
 * Emit a domain event to the federation_events table.
 * Signs the event with the instance's Ed25519 key if available.
 */
export async function emitDomainEvent(params: {
  eventType: EventType | string;
  entityType: string;
  entityId: string;
  actorId: string;
  payload: Record<string, unknown>;
  visibility?: 'public' | 'locale' | 'members' | 'private';
  correlationId?: string;
  causationId?: string;
  targetNodeId?: string;
}): Promise<DomainEvent> {
  const config = getInstanceConfig();
  const eventId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const timestamp = new Date();

  // Try to sign if we have crypto available
  let signature: string | undefined;
  try {
    const { signPayload } = await import('@/lib/federation-crypto');
    // signPayload needs the node's private key — fetch from nodes table
    const localNode = await db
      .select({ privateKey: nodes.privateKey })
      .from(nodes)
      .where(eq(nodes.id, config.instanceId))
      .limit(1);

    if (localNode.length > 0 && localNode[0].privateKey) {
      signature = signPayload(params.payload, localNode[0].privateKey);
    }
  } catch {
    // Signing unavailable — proceed without signature
  }

  // Insert into federation_events
  const [inserted] = await db
    .insert(federationEvents)
    .values({
      id: eventId,
      originNodeId: config.instanceId,
      targetNodeId: params.targetNodeId || null,
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      visibility: params.visibility || 'public',
      payload: params.payload,
      signature: signature || null,
      nonce,
      eventVersion: 1,
      status: 'queued',
      actorId: params.actorId,
      correlationId: params.correlationId || null,
      causationId: params.causationId || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();

  const domainEvent: DomainEvent = {
    id: eventId,
    sequence: inserted.sequence ?? undefined,
    instanceId: config.instanceId,
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId,
    actorId: params.actorId,
    timestamp: timestamp.toISOString(),
    version: 1,
    payload: params.payload as Record<string, unknown>,
    metadata: {
      correlationId: params.correlationId,
      causationId: params.causationId,
    },
    signature,
  };

  return domainEvent;
}
