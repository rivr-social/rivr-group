export interface SerializedGroupRelationship {
  id: string;
  sourceGroupId: string;
  targetGroupId: string;
  type: string;
  description: string | null;
  createdAt: string;
  createdBy: string;
}

export interface MemberInfo {
  id: string;
  name: string;
  username: string;
  avatar: string;
}

export interface SemanticSearchResult {
  id: string;
  name: string;
  description: string | null;
  type: string;
  table: "agents" | "resources";
  image: string | null;
  distance: number;
  metadata: Record<string, unknown>;
}

export interface LedgerQueryFilter {
  subjectId?: string;
  verb?: string;
  objectId?: string;
  startDate?: string;
  endDate?: string;
}

export interface LedgerQueryResult {
  id: string;
  verb: string;
  subjectId: string;
  subjectName: string;
  subjectType: string;
  objectId: string | null;
  objectName: string | null;
  objectType: string | null;
  resourceId: string | null;
  timestamp: string;
}

import type { Agent } from "@/db/schema";

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isAnonymousCrawlableVisibility(
  target: { visibility?: string | null; isPublic?: boolean | null }
): boolean {
  const visibility = target.visibility ?? (target.isPublic ? "public" : "private");
  return visibility === "public" || visibility === "locale";
}

export function dedupeAgentsById(items: Agent[]): Agent[] {
  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const item of items) {
    // Keep first occurrence to preserve query ordering while removing duplicates.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
