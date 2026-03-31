"use server";

import { auth } from "@/auth";
import type { Agent, Resource } from "@/db/schema";
import { check } from "@/lib/permissions";
import { getAgent } from "@/lib/queries/agents";
import { isAnonymousCrawlableVisibility } from "./types";

export async function requireActorId(): Promise<string> {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) {
    // Fail closed for all authenticated-only actions.
    throw new Error("Unauthorized");
  }
  return actorId;
}

export async function tryActorId(): Promise<string | null> {
  try {
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function canViewAgent(actorId: string, agentId: string): Promise<boolean> {
  const actor = await getAgent(actorId);
  // Defensive existence check prevents permission checks for deleted/invalid principals.
  if (!actor) return false;
  const result = await check(actorId, "view", agentId, "agent");
  return result.allowed;
}

export async function canViewResource(actorId: string, resourceId: string): Promise<boolean> {
  const actor = await getAgent(actorId);
  if (!actor) return false;
  const result = await check(actorId, "view", resourceId, "resource");
  return result.allowed;
}

export async function filterViewableAgents(actorId: string, agents: Agent[]): Promise<Agent[]> {
  const permissions = await Promise.all(agents.map((agent) => canViewAgent(actorId, agent.id)));
  return agents.filter((_, i) => permissions[i]);
}

export async function filterViewableResources(actorId: string, resources: Resource[]): Promise<Resource[]> {
  const permissions = await Promise.all(resources.map((resource) => canViewResource(actorId, resource.id)));
  return resources.filter((_, i) => permissions[i]);
}

export async function filterPubliclyCrawlableAgents(items: Agent[]): Promise<Agent[]> {
  return items.filter((item) => isAnonymousCrawlableVisibility(item));
}

export async function filterPubliclyCrawlableResources(items: Resource[]): Promise<Resource[]> {
  return items.filter((item) => isAnonymousCrawlableVisibility(item));
}
