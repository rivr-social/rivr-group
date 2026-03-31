/**
 * Tests for recursive query functions
 * Validates agent lineage and descendant traversal
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAgentLineage,
  getAgentDescendants,
  getAgentTree,
  findCommonAncestor,
  countDescendants,
} from '../../db/queries';
import { db } from '../../db/index';

// Mock database
vi.mock('../../db/index', () => ({
  db: {
    execute: vi.fn(),
  },
}));

describe('getAgentLineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return lineage from child to root', async () => {
    // Setup: child -> parent -> grandparent
    const mockRows = [
      { id: 'child-1' },
      { id: 'parent-1' },
      { id: 'root-1' },
    ];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentLineage('child-1');

    expect(result).toEqual(['child-1', 'parent-1', 'root-1']);
  });

  it('should return single agent for root with no parents', async () => {
    const mockRows = [{ id: 'root-1' }];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentLineage('root-1');

    expect(result).toEqual(['root-1']);
  });

  it('should throw error when agent not found', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(
      new Error('No agent found')
    );

    await expect(getAgentLineage('invalid-id')).rejects.toThrow(
      'Failed to retrieve agent lineage for childId=invalid-id'
    );
  });

  it('should handle deep lineage chains', async () => {
    // Test with 10 levels deep
    const mockRows = Array.from({ length: 10 }, (_, i) => ({
      id: `agent-${i}`,
    }));

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentLineage('agent-0');

    expect(result).toHaveLength(10);
    expect(result[0]).toBe('agent-0');
    expect(result[9]).toBe('agent-9');
  });
});

describe('getAgentDescendants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all descendants from root', async () => {
    // Setup: root -> [child1, child2] -> [grandchild1, grandchild2]
    const mockRows = [
      { id: 'child-1', depth: 1 },
      { id: 'child-2', depth: 1 },
      { id: 'grandchild-1', depth: 2 },
      { id: 'grandchild-2', depth: 2 },
    ];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentDescendants('root-1');

    expect(result).toEqual([
      'child-1',
      'child-2',
      'grandchild-1',
      'grandchild-2',
    ]);
  });

  it('should return empty array for leaf node with no children', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([] as Record<string, unknown>[]);

    const result = await getAgentDescendants('leaf-1');

    expect(result).toEqual([]);
  });

  it('should throw error when agent not found', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(
      new Error('No agent found')
    );

    await expect(getAgentDescendants('invalid-id')).rejects.toThrow(
      'Failed to retrieve agent descendants for rootId=invalid-id'
    );
  });

  it('should order descendants by depth', async () => {
    const mockRows = [
      { id: 'grandchild-1', depth: 2 },
      { id: 'child-1', depth: 1 },
      { id: 'great-grandchild-1', depth: 3 },
    ];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentDescendants('root-1');

    // Verify original depth ordering is preserved
    expect(result).toEqual([
      'grandchild-1',
      'child-1',
      'great-grandchild-1',
    ]);
  });
});

describe('getAgentTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return complete tree structure', async () => {
    const mockRows = [
      {
        id: 'root-1',
        parent_id: null,
        name: 'Root Agent',
        reputation: 100,
        depth: 0,
        path: 'root-1',
      },
      {
        id: 'child-1',
        parent_id: 'root-1',
        name: 'Child Agent 1',
        reputation: 50,
        depth: 1,
        path: 'root-1/child-1',
      },
      {
        id: 'child-2',
        parent_id: 'root-1',
        name: 'Child Agent 2',
        reputation: 75,
        depth: 1,
        path: 'root-1/child-2',
      },
    ];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentTree('root-1');

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('root-1');
    expect(result[0].depth).toBe(0);
    expect(result[1].parent_id).toBe('root-1');
  });

  it('should include reputation data in tree nodes', async () => {
    const mockRows = [
      {
        id: 'root-1',
        parent_id: null,
        name: 'Root',
        reputation: 500,
        depth: 0,
        path: 'root-1',
      },
    ];

    vi.mocked(db.execute).mockResolvedValueOnce(mockRows as Record<string, unknown>[]);

    const result = await getAgentTree('root-1');

    expect(result[0].reputation).toBe(500);
  });

  it('should throw error when root agent not found', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(
      new Error('Agent not found')
    );

    await expect(getAgentTree('invalid-id')).rejects.toThrow(
      'Failed to retrieve agent tree for rootId=invalid-id'
    );
  });
});

describe('findCommonAncestor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should find common ancestor for sibling agents', async () => {
    // First call for agent1 lineage
    vi.mocked(db.execute).mockResolvedValueOnce(
      [{ id: 'child-1' }, { id: 'parent-1' }, { id: 'root-1' }] as Record<string, unknown>[]
    );

    // Second call for agent2 lineage
    vi.mocked(db.execute).mockResolvedValueOnce(
      [{ id: 'child-2' }, { id: 'parent-1' }, { id: 'root-1' }] as Record<string, unknown>[]
    );

    const result = await findCommonAncestor('child-1', 'child-2');

    // First common element from lineage1 found in lineage2 is 'parent-1'
    expect(result).toBe('parent-1');
  });

  it('should return null when no common ancestor exists', async () => {
    // First call - lineage of agent1
    vi.mocked(db.execute).mockResolvedValueOnce(
      [{ id: 'child-1' }, { id: 'parent-1' }] as Record<string, unknown>[]
    );

    // Second call - lineage of agent2 (different tree)
    vi.mocked(db.execute).mockResolvedValueOnce(
      [{ id: 'child-2' }, { id: 'parent-2' }] as Record<string, unknown>[]
    );

    const result = await findCommonAncestor('child-1', 'child-2');

    expect(result).toBeNull();
  });

  it('should find root as common ancestor for distant cousins', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([
      { id: 'cousin-1' },
      { id: 'parent-1' },
      { id: 'grandparent-1' },
      { id: 'root-1' },
    ] as Record<string, unknown>[]);

    vi.mocked(db.execute).mockResolvedValueOnce([
      { id: 'cousin-2' },
      { id: 'parent-2' },
      { id: 'grandparent-2' },
      { id: 'root-1' },
    ] as Record<string, unknown>[]);

    const result = await findCommonAncestor('cousin-1', 'cousin-2');

    // root-1 is the only common element
    expect(result).toBe('root-1');
  });
});

describe('countDescendants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should count all descendants correctly', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([{ count: 5 }] as Record<string, unknown>[]);

    const result = await countDescendants('root-1');

    expect(result).toBe(5);
  });

  it('should return 0 for leaf node with no descendants', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce([{ count: 0 }] as Record<string, unknown>[]);

    const result = await countDescendants('leaf-1');

    expect(result).toBe(0);
  });

  it('should throw error when agent not found', async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(
      new Error('Agent not found')
    );

    await expect(countDescendants('invalid-id')).rejects.toThrow(
      'Failed to count descendants for rootId=invalid-id'
    );
  });
});
