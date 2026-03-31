import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { ProjectionHandler } from "./types";
import type { DomainEvent } from "../domain-events";
import { EVENT_TYPES } from "../domain-events";

/**
 * Agent cards projection — maintains denormalized agent summaries
 * for cross-instance rendering (member lists, attribution, search results).
 *
 * For Phase 1-2, this operates on the local database since all agents
 * are on the global instance. In Phase 4+, this will maintain shadow
 * copies of remote agents.
 */
export const agentCardProjection: ProjectionHandler = {
  name: "agent_cards",
  handles: [
    EVENT_TYPES.AGENT_CREATED,
    EVENT_TYPES.AGENT_UPDATED,
    EVENT_TYPES.AGENT_DELETED,
    EVENT_TYPES.GROUP_CREATED,
    EVENT_TYPES.GROUP_UPDATED,
  ],
  schemaVersion: 1,

  async apply(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, any>;

    switch (event.eventType) {
      case EVENT_TYPES.AGENT_CREATED:
      case EVENT_TYPES.GROUP_CREATED:
        // Agent/group created — no projection needed yet (data is local)
        // In Phase 4+, this would upsert a shadow agent record
        break;

      case EVENT_TYPES.AGENT_UPDATED:
      case EVENT_TYPES.GROUP_UPDATED:
        // If we have fields to update in the projection
        if (payload.name || payload.image || payload.description) {
          const updateData: Record<string, any> = {};
          if (payload.name) updateData.name = payload.name;
          if (payload.image) updateData.image = payload.image;
          if (payload.description) updateData.description = payload.description;
          updateData.updatedAt = new Date();

          await db
            .update(agents)
            .set(updateData)
            .where(eq(agents.id, event.entityId))
            .catch(() => {
              // Agent may not exist locally — this is expected for remote agents
              // In Phase 4+, we'd upsert a shadow record here
            });
        }
        break;

      case EVENT_TYPES.AGENT_DELETED:
        // Soft-delete the projection
        await db
          .update(agents)
          .set({ deletedAt: new Date() })
          .where(eq(agents.id, event.entityId))
          .catch(() => {});
        break;
    }
  },

  async rebuild(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.apply(event);
    }
  },
};
