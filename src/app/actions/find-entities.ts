"use server";

/**
 * Server action utilities for entity-name lookup across `agents` and `resources`.
 *
 * Purpose:
 * - Resolve user-provided names against existing records before creating new entities.
 *
 * Key exports:
 * - `findExistingEntitiesByNames`: Performs authenticated fuzzy/exact lookup and returns
 *   best-match entities keyed by normalized input name.
 *
 * Dependencies:
 * - `auth` from `@/auth` for authentication gating.
 * - `db` plus `agents`/`resources` schema tables for persistence.
 * - Drizzle `ilike`/`or` operators for case-insensitive matching.
 * - `toContainsLikePattern` to safely escape `%`/`_` wildcard characters in user input.
 *
 * Auth and error handling:
 * - Requires an authenticated user session; throws `"Unauthorized"` when missing.
 * - Query failures are logged and swallowed, returning partial/empty results.
 *
 * Rate limiting:
 * - No action-local limiter is implemented; each name triggers up to two bounded queries
 *   (`limit(3)`), so callers should cap input size upstream.
 */
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, resources } from "@/db/schema";
import { or, ilike } from "drizzle-orm";
import { toContainsLikePattern } from "@/lib/sql-like";

/**
 * Finds existing agent/resource entities for a set of names and returns best matches.
 *
 * Matching behavior:
 * - Searches `agents` first, then falls back to `resources` only when no agent matches.
 * - Uses escaped `ILIKE %name%` + direct `ILIKE name` checks per input value.
 * - Picks an exact case-insensitive name match when available; otherwise the first result.
 *
 * @param names List of raw entity names to resolve.
 * @returns A map keyed by lowercased input name containing the selected existing entity payload.
 * @throws {Error} Throws `"Unauthorized"` when no authenticated session/user is present.
 * @example
 * ```ts
 * const existing = await findExistingEntitiesByNames(["River Keepers", "Tool Library"]);
 * const group = existing.get("river keepers");
 * if (group?.isExisting) {
 *   console.log(group.id, group.targetTable);
 * }
 * ```
 */
export async function findExistingEntitiesByNames(
  names: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const existingMap = new Map();

  if (names.length === 0) return existingMap;

  // Cap input to prevent excessive DB queries from unbounded arrays.
  const MAX_ENTITY_NAMES = 50;
  const cappedNames = names.slice(0, MAX_ENTITY_NAMES);

  try {
    for (const name of cappedNames) {
      // Escape wildcard characters in user-controlled input to prevent broad unintended matches.
      const escapedContainsName = toContainsLikePattern(name);
      const results = await db
        .select({
          id: agents.id,
          name: agents.name,
          type: agents.type,
          description: agents.description,
          image: agents.image,
          metadata: agents.metadata,
          parentId: agents.parentId,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(
          or(
            // Contains-style lookup for user-friendly matching.
            ilike(agents.name, escapedContainsName),
            // Direct lookup is kept for compatibility with existing query behavior.
            ilike(agents.name, name)
          )
        )
        .limit(3);

      if (results.length === 0) {
        // Fallback to resources only when no agent match exists for this input name.
        const resourceResults = await db
          .select({
            id: resources.id,
            name: resources.name,
            type: resources.type,
            description: resources.description,
            metadata: resources.metadata,
            createdAt: resources.createdAt,
            updatedAt: resources.updatedAt,
          })
          .from(resources)
          .where(
            or(
              ilike(resources.name, escapedContainsName),
              ilike(resources.name, name)
            )
          )
          .limit(3);

        if (resourceResults.length > 0) {
          // Prefer exact case-insensitive match to reduce false positives.
          const exactMatch = resourceResults.find(r =>
            r.name.toLowerCase() === name.toLowerCase()
          );
          const bestMatch = exactMatch || resourceResults[0];
          existingMap.set(name.toLowerCase(), {
            ...bestMatch,
            targetTable: "resources",
            isExisting: true
          });
        }
        continue;
      }

      // Find best match (exact match or contains)
      const exactMatch = results.find(r =>
        r.name.toLowerCase() === name.toLowerCase()
      );
      const bestMatch = exactMatch || results[0];

      existingMap.set(name.toLowerCase(), {
        ...bestMatch,
        targetTable: "agents",
        isExisting: true
      });
    }
  } catch (error) {
    // Non-fatal strategy: log and return whatever has been accumulated so far.
    console.error("Error finding existing entities:", error);
  }

  return existingMap;
}
