import type { DomainEvent } from "../domain-events";

/**
 * A projection handler consumes domain events and maintains
 * a materialized read model (projection).
 */
export interface ProjectionHandler {
  /** Human-readable name for logging */
  name: string;
  /** Event types this projection consumes */
  handles: string[];
  /** Schema version — bump to trigger rebuild */
  schemaVersion: number;
  /** Apply a single event to update the projection */
  apply(event: DomainEvent): Promise<void>;
  /** Rebuild the entire projection from a stream of events */
  rebuild(events: DomainEvent[]): Promise<void>;
}
