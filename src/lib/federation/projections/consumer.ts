import { db } from "@/db";
import { federationEvents } from "@/db/schema";
import { gt, eq, and } from "drizzle-orm";
import type { ProjectionHandler } from "./types";
import type { DomainEvent } from "../domain-events";

/**
 * Event consumer that polls federation_events and dispatches
 * to registered projection handlers.
 */
export class EventConsumer {
  private handlers: ProjectionHandler[] = [];
  private handlerMap: Map<string, ProjectionHandler[]> = new Map();

  register(handler: ProjectionHandler): void {
    this.handlers.push(handler);
    for (const eventType of handler.handles) {
      const existing = this.handlerMap.get(eventType) || [];
      existing.push(handler);
      this.handlerMap.set(eventType, existing);
    }
  }

  /**
   * Process events since the given sequence number.
   * Returns the new high-water mark sequence.
   */
  async processSince(sinceSequence: number, limit: number = 100): Promise<number> {
    const events = await db
      .select()
      .from(federationEvents)
      .where(
        and(
          gt(federationEvents.sequence, sinceSequence),
          eq(federationEvents.status, "queued")
        )
      )
      .orderBy(federationEvents.sequence)
      .limit(limit);

    if (events.length === 0) return sinceSequence;

    let highWater = sinceSequence;

    for (const event of events) {
      const domainEvent: DomainEvent = {
        id: event.id,
        sequence: event.sequence ?? undefined,
        instanceId: event.originNodeId,
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId || "",
        actorId: event.actorId || "",
        timestamp: event.createdAt?.toISOString() || new Date().toISOString(),
        version: event.eventVersion || 1,
        payload: (event.payload as Record<string, unknown>) || {},
        metadata: {
          correlationId: event.correlationId || undefined,
          causationId: event.causationId || undefined,
        },
        signature: event.signature || undefined,
      };

      const handlers = this.handlerMap.get(event.eventType) || [];
      for (const handler of handlers) {
        try {
          await handler.apply(domainEvent);
        } catch (error) {
          console.error(
            `Projection ${handler.name} failed on event ${event.id}:`,
            error
          );
          // Don't stop processing — log and continue
        }
      }

      if (event.sequence && event.sequence > highWater) {
        highWater = event.sequence;
      }
    }

    return highWater;
  }

  /** Get all registered handler names */
  getHandlerNames(): string[] {
    return this.handlers.map((h) => h.name);
  }
}

/** Singleton consumer with default projections registered */
export function createDefaultConsumer(): EventConsumer {
  const consumer = new EventConsumer();

  // Import and register projections
  // Using dynamic import to avoid circular deps
  return consumer;
}
