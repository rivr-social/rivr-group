/**
 * Recursive query helpers for traversing the `agents` hierarchy.
 *
 * Purpose:
 * - Expose reusable lineage/tree traversal operations via recursive CTEs.
 * - Provide relationship utilities (ancestor, descendant, sibling) used by services.
 *
 * Key exports:
 * - `getAgentLineage`, `getAgentDescendants`, `getAgentTree`
 * - `findCommonAncestor`, `countDescendants`, `getAgentSiblings`
 * - `AgentTreeNode` type for tree query results.
 *
 * Dependencies:
 * - Shared Drizzle client and schema exports from `./index`.
 * - `drizzle-orm` SQL templating helpers.
 */
/**
 * Recursive queries for agent lineage traversal
 * Implements parent-child relationships using Common Table Expressions (CTEs)
 */

import { db, agents } from './index';
import { sql, eq } from 'drizzle-orm';

/**
 * Safety guard for recursive CTE depth.
 * Prevents accidental infinite traversal in cyclic or malformed hierarchy data.
 */
const MAX_RECURSION_DEPTH = 50;

/**
 * Recursively finds all parent agents up the lineage chain
 * Uses a recursive CTE to traverse from child to root
 *
 * @param childId - The agent ID to start from
 * @returns Array of agent IDs representing the complete lineage from child to root.
 * @throws {Error} Throws when the recursive query fails.
 * @example
 * ```ts
 * const lineage = await getAgentLineage('agent-uuid');
 * // ['child-id', 'parent-id', 'root-id']
 * ```
 */
export async function getAgentLineage(childId: string): Promise<string[]> {
  try {
    // Security note: interpolated values in Drizzle `sql` templates are parameterized.
    const result = await db.execute(sql`
      WITH RECURSIVE lineage AS (
        -- Base case: Start with the specified child agent
        SELECT
          id,
          parent_id,
          0 as depth
        FROM agents
        WHERE id = ${childId}

        UNION ALL

        -- Recursive case: Find parent of current agent (depth-guarded)
        SELECT
          a.id,
          a.parent_id,
          l.depth + 1 as depth
        FROM agents a
        INNER JOIN lineage l ON a.id = l.parent_id
        WHERE l.parent_id IS NOT NULL
          AND l.depth < ${MAX_RECURSION_DEPTH}
      )
      SELECT id
      FROM lineage
      ORDER BY depth ASC
    `);

    // Extract agent IDs from result rows
    const agentIds = result.map((row: Record<string, unknown>) => row.id as string);

    return agentIds;
  } catch (error) {
    throw new Error(
      `Failed to retrieve agent lineage for childId=${childId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Recursively finds all descendant agents down the tree
 * Uses a recursive CTE to traverse from root to all leaves
 *
 * @param rootId - The agent ID to start from
 * @returns Array of agent IDs representing all descendants in the tree.
 * @throws {Error} Throws when the recursive query fails.
 * @example
 * ```ts
 * const descendants = await getAgentDescendants('root-agent-uuid');
 * ```
 */
export async function getAgentDescendants(rootId: string): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        -- Base case: Start with the specified root agent
        SELECT
          id,
          parent_id,
          0 as depth
        FROM agents
        WHERE id = ${rootId}

        UNION ALL

        -- Recursive case: Find all children of current level (depth-guarded)
        SELECT
          a.id,
          a.parent_id,
          d.depth + 1 as depth
        FROM agents a
        INNER JOIN descendants d ON a.parent_id = d.id
        WHERE d.depth < ${MAX_RECURSION_DEPTH}
      )
      SELECT id, depth
      FROM descendants
      WHERE id != ${rootId}
      ORDER BY depth ASC
    `);

    // Extract agent IDs from result rows (excluding root itself)
    const agentIds = result.map((row: Record<string, unknown>) => row.id as string);

    return agentIds;
  } catch (error) {
    throw new Error(
      `Failed to retrieve agent descendants for rootId=${rootId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Retrieves the complete agent tree structure
 * Useful for visualization and analysis
 *
 * @param rootId - The root agent ID
 * @returns Ordered tree nodes with path metadata suitable for deterministic rendering.
 * @throws {Error} Throws when the recursive query fails.
 * @example
 * ```ts
 * const tree = await getAgentTree('root-agent-uuid');
 * ```
 */
export async function getAgentTree(rootId: string): Promise<AgentTreeNode[]> {
  try {
    const result = await db.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT
          id,
          parent_id,
          name,
          0 as depth,
          CAST(id AS TEXT) as path
        FROM agents
        WHERE id = ${rootId}

        UNION ALL

        SELECT
          a.id,
          a.parent_id,
          a.name,
          t.depth + 1 as depth,
          t.path || '/' || a.id as path
        FROM agents a
        INNER JOIN tree t ON a.parent_id = t.id
        WHERE t.depth < ${MAX_RECURSION_DEPTH}
      )
      SELECT
        id,
        parent_id,
        name,
        depth,
        path
      FROM tree
      ORDER BY path
    `);

    return result as unknown as AgentTreeNode[];
  } catch (error) {
    throw new Error(
      `Failed to retrieve agent tree for rootId=${rootId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Finds the common ancestor between two agents
 * Useful for determining relationship distance
 *
 * @param agentId1 - First agent ID
 * @param agentId2 - Second agent ID
 * @returns The first shared ancestor in lineage order, or `null` if none exists.
 * @throws {Error} Propagates lineage lookup errors from `getAgentLineage`.
 * @example
 * ```ts
 * const ancestor = await findCommonAncestor('agent-a', 'agent-b');
 * ```
 */
export async function findCommonAncestor(
  agentId1: string,
  agentId2: string
): Promise<string | null> {
  const lineage1 = await getAgentLineage(agentId1);
  const lineage2 = await getAgentLineage(agentId2);

  // Find first common agent in both lineages
  for (const ancestor of lineage1) {
    if (lineage2.includes(ancestor)) {
      return ancestor;
    }
  }

  return null;
}

/**
 * Counts total descendants for an agent
 * Useful for metrics and validation
 *
 * @param rootId - The root agent ID
 * @returns Count of all descendants, excluding the root node itself.
 * @throws {Error} Throws when the recursive count query fails.
 * @example
 * ```ts
 * const total = await countDescendants('root-agent-uuid');
 * ```
 */
export async function countDescendants(rootId: string): Promise<number> {
  try {
    const result = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id, 0 as depth
        FROM agents
        WHERE id = ${rootId}

        UNION ALL

        SELECT a.id, d.depth + 1 as depth
        FROM agents a
        INNER JOIN descendants d ON a.parent_id = d.id
        WHERE d.depth < ${MAX_RECURSION_DEPTH}
      )
      SELECT COUNT(*) - 1 as count
      FROM descendants
    `);

    return Number((result[0] as Record<string, unknown>).count);
  } catch (error) {
    throw new Error(
      `Failed to count descendants for rootId=${rootId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Retrieves all sibling agents (agents with the same parent)
 * Excludes the agent itself from the result
 *
 * @param agentId - The agent whose siblings to find
 * @returns Array of sibling records sorted by name.
 * @throws {Error} Throws when the agent does not exist or the query fails.
 * @example
 * ```ts
 * const siblings = await getAgentSiblings('agent-uuid');
 * ```
 */
export async function getAgentSiblings(agentId: string) {
  try {
    // First, get the parent of this agent
    const agent = await db
      .select({ parentId: agents.parentId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (agent.length === 0) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const parentId = agent[0].parentId;

    if (!parentId) {
      // Business rule: root nodes are treated as top-level containers with no sibling set.
      return [];
    }

    const result = await db.execute(sql`
      SELECT id, name, type, parent_id, depth, created_at
      FROM agents
      WHERE parent_id = ${parentId}
        AND id != ${agentId}
        AND deleted_at IS NULL
      ORDER BY name ASC
    `);

    return result as unknown as Array<{
      id: string;
      name: string;
      type: string;
      parent_id: string;
      depth: number;
      created_at: Date;
    }>;
  } catch (error) {
    throw new Error(
      `Failed to retrieve siblings for agentId=${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Type definitions
 */
export interface AgentTreeNode {
  id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  path: string;
}
