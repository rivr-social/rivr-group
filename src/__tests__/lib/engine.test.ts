/**
 * Tests for transaction engine
 * Validates Grammar of Value and Double Bottom Line implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  processSentence,
  processSentenceBatch,
  getAgentTransactionHistory,
  Verb,
  ResourceStatus,
  type Sentence,
} from '../../lib/engine';
import { db } from '../../db/index';

/** Transaction parameter type extracted from Drizzle's db.transaction callback */
type TxParam = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock transaction context that supports Drizzle's fluent query
 * builder API: select().from().where().limit(), insert().values().returning(),
 * update().set().where(), and execute().
 *
 * Responses are returned in FIFO order from the provided array, regardless of
 * which terminal method consumes them.
 */
function createMockTx(responses: unknown[]) {
  let idx = 0;
  const next = () => {
    const val = responses[idx++];
    return Promise.resolve(val);
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => next()),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => next()),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => next()),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => next()),
      })),
    })),
    execute: vi.fn(() => next()),
  };
}

/** Wraps createMockTx into a db.transaction mock implementation */
function mockTransaction(responses: unknown[]) {
  return vi.mocked(db.transaction).mockImplementation(async (callback) => {
    return await callback(createMockTx(responses) as unknown as TxParam);
  });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock database — include select chain for getAgentTransactionHistory
let dbSelectResponses: unknown[] = [];
let dbSelectIdx = 0;

vi.mock('../../db/index', () => {
  const dbSelectNext = () => {
    const val = dbSelectResponses[dbSelectIdx++];
    return Promise.resolve(val);
  };

  return {
    db: {
      transaction: vi.fn(),
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => dbSelectNext()),
            })),
            limit: vi.fn(() => dbSelectNext()),
          })),
        })),
      })),
    },
  };
});

// Mock permissions module (imported transitively by engine.ts)
vi.mock('../../lib/permissions', () => ({
  check: vi.fn().mockResolvedValue({ allowed: true, reason: 'mocked' }),
}));

// Mock schema exports (needed for Drizzle function arguments)
vi.mock('../../db/schema', () => ({
  agents: { id: 'id', metadata: 'metadata', updatedAt: 'updated_at' },
  ledger: {
    id: 'id',
    subjectId: 'subject_id',
    verb: 'verb',
    objectId: 'object_id',
    metadata: 'metadata',
    timestamp: 'timestamp',
    $inferInsert: {},
  },
  resources: {},
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processSentence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully process a valid sentence with economic value', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.COMPLETED,
      object: 'resource-1',
      delta: 10,
      metadata: { description: 'Completed task successfully' },
    };

    // COMPLETED: not in OBJECT_VALIDATION_VERBS
    // Flow: validate(select subject) → writeLedger(insert) → updateStatus(execute) → updateRep(select meta, update)
    mockTransaction([
      [{ id: 'agent-1' }],                       // 1. select subject
      [{ id: 'ledger-1' }],                      // 2. insert ledger
      undefined,                                   // 3. execute: update resource status
      [{ metadata: { reputation: 50 } }],         // 4. select agent metadata
      undefined,                                   // 5. update agent reputation
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    expect(result.ledgerId).toBe('ledger-1');
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.COMPLETED);
    // Reputation: 50 + 10 = 60 (additive, clamped to 0-100)
    expect(result.updates?.agentReputation).toBe(60);

    console.log('✓ Valid sentence processed with economic and social value');
  });

  it('should handle endorsement verb with reputation boost', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.ENDORSED,
      object: 'agent-2',
      delta: 10,
      metadata: { reason: 'Excellent work quality' },
    };

    // ENDORSED: in OBJECT_VALIDATION_VERBS → needs execute for object check
    // Flow: validate(select subject, execute object) → writeLedger(insert) → updateStatus(execute) → updateRep(select meta, update)
    mockTransaction([
      [{ id: 'agent-1' }],                       // 1. select subject
      [{ id: 'agent-2' }],                       // 2. execute: object validation
      [{ id: 'ledger-2' }],                      // 3. insert ledger
      undefined,                                   // 4. execute: update resource status
      [{ metadata: { reputation: 40 } }],         // 5. select agent metadata
      undefined,                                   // 6. update agent reputation
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    // Reputation boosted (additive): 40 + (10 * 1.1) = 51
    expect(result.updates?.agentReputation).toBeCloseTo(51, 0);

    console.log('✓ Endorsement processed with reputation boost multiplier');
  });

  it('should handle revocation with reputation decay', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.REVOKED,
      object: 'resource-1',
      delta: -20,
      metadata: { reason: 'Invalid completion' },
    };

    // REVOKED: not in OBJECT_VALIDATION_VERBS
    // Flow: validate(select subject) → writeLedger(insert) → updateStatus(execute) → updateRep(select meta, update)
    mockTransaction([
      [{ id: 'agent-1' }],                       // 1. select subject
      [{ id: 'ledger-3' }],                      // 2. insert ledger
      undefined,                                   // 3. execute: update resource status
      [{ metadata: { reputation: 50 } }],         // 4. select agent metadata
      undefined,                                   // 5. update agent reputation
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    // Reputation (additive): 50 + (-20 * 0.9) = 50 - 18 = 32
    expect(result.updates?.agentReputation).toBeCloseTo(32, 0);
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.CANCELLED);

    console.log('✓ Revocation processed with reputation decay');
  });

  it('should enforce minimum reputation bound', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.REVOKED,
      object: 'resource-1',
      delta: -200,
    };

    mockTransaction([
      [{ id: 'agent-1' }],
      [{ id: 'ledger-4' }],
      undefined,
      [{ metadata: { reputation: 10 } }],
      undefined,
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    // 10 + (-200 * 0.9) = 10 - 180 = -170 → clamped to 0
    expect(result.updates?.agentReputation).toBe(0);

    console.log('✓ Reputation clamped to minimum bound (0)');
  });

  it('should enforce maximum reputation bound', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.ENDORSED,
      object: 'agent-2',
      delta: 50,
    };

    // ENDORSED: in OBJECT_VALIDATION_VERBS
    mockTransaction([
      [{ id: 'agent-1' }],
      [{ id: 'agent-2' }],                       // object validation
      [{ id: 'ledger-5' }],
      undefined,
      [{ metadata: { reputation: 80 } }],
      undefined,
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    // 80 + (50 * 1.1) = 135 → clamped to 100
    expect(result.updates?.agentReputation).toBe(100);

    console.log('✓ Reputation clamped to maximum bound (100)');
  });

  it('should fail validation when subject agent not found', async () => {
    const sentence: Sentence = {
      subjectId: 'invalid-agent',
      verb: Verb.COMPLETED,
      object: 'resource-1',
      delta: 100,
    };

    mockTransaction([
      [],  // empty result → subject not found
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Subject agent not found');

    console.log('✓ Subject validation correctly rejects missing agent');
  });

  it('should fail validation when verb is invalid', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: 'INVALID_VERB' as Verb,
      object: 'resource-1',
      delta: 100,
    };

    mockTransaction([
      [{ id: 'agent-1' }],  // subject found, then verb check fails
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid verb');

    console.log('✓ Invalid verb correctly rejected');
  });

  it('should fail validation when delta is not a number', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.COMPLETED,
      object: 'resource-1',
      delta: NaN,
    };

    mockTransaction([
      [{ id: 'agent-1' }],  // subject found, then delta check fails
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid delta value');

    console.log('✓ NaN delta correctly rejected');
  });

  it('should write metadata to ledger entry', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.CREATED,
      object: 'resource-1',
      delta: 0,
      metadata: {
        type: 'task',
        priority: 'high',
        tags: ['urgent', 'backend'],
        estimatedHours: 5,
      },
    };

    // CREATED: not in OBJECT_VALIDATION_VERBS, in WORK_COMPLETION_VERBS, not in SOCIAL_VALUE_VERBS
    mockTransaction([
      [{ id: 'agent-1' }],       // 1. select subject
      [{ id: 'ledger-6' }],      // 2. insert ledger
      undefined,                   // 3. execute: update resource status
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    expect(result.ledgerId).toBe('ledger-6');
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.PENDING);

    console.log('✓ Metadata written to ledger with CREATED verb');
  });
});

describe('processSentenceBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process multiple sentences in single transaction', async () => {
    const sentences: Sentence[] = [
      { subjectId: 'agent-1', verb: Verb.CREATED, object: 'resource-1', delta: 0 },
      { subjectId: 'agent-1', verb: Verb.COMPLETED, object: 'resource-1', delta: 100 },
      { subjectId: 'agent-2', verb: Verb.VALIDATED, object: 'resource-1', delta: 50 },
    ];

    // Sentence 1 (CREATED): select subject, insert ledger, execute status
    // Sentence 2 (COMPLETED): select subject, insert ledger, execute status, select rep, update rep
    // Sentence 3 (VALIDATED): select subject, execute object check, insert ledger, execute status, select rep, update rep
    mockTransaction([
      // Sentence 1: CREATED (no object val, no reputation)
      [{ id: 'agent-1' }],       // select subject
      [{ id: 'ledger-1' }],      // insert ledger
      undefined,                   // execute: status update
      // Sentence 2: COMPLETED (no object val, has reputation)
      [{ id: 'agent-1' }],       // select subject
      [{ id: 'ledger-2' }],      // insert ledger
      undefined,                   // execute: status update
      [{ metadata: { reputation: 50 } }],  // select rep
      undefined,                   // update rep
      // Sentence 3: VALIDATED (has object val, has reputation)
      [{ id: 'agent-2' }],       // select subject
      [{ id: 'resource-1' }],    // execute: object validation
      [{ id: 'ledger-3' }],      // insert ledger
      undefined,                   // execute: status update
      [{ metadata: { reputation: 30 } }],  // select rep
      undefined,                   // update rep
    ]);

    const results = await processSentenceBatch(sentences);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results[0].ledgerId).toBe('ledger-1');
    expect(results[1].ledgerId).toBe('ledger-2');
    expect(results[2].ledgerId).toBe('ledger-3');

    console.log('✓ Batch of 3 sentences processed successfully');
  });

  it('should rollback all on transaction failure', async () => {
    const sentences: Sentence[] = [
      { subjectId: 'agent-1', verb: Verb.CREATED, object: 'resource-1', delta: 0 },
      { subjectId: 'invalid-agent', verb: Verb.COMPLETED, object: 'resource-1', delta: 100 },
    ];

    vi.mocked(db.transaction).mockRejectedValueOnce(
      new Error('Transaction failed')
    );

    const results = await processSentenceBatch(sentences);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results[0].error).toContain('Batch transaction failed');

    console.log('✓ Full batch rollback on transaction failure');
  });

  it('should rollback entire batch when any sentence fails (no partial commits)', async () => {
    const sentences: Sentence[] = [
      { subjectId: 'agent-1', verb: Verb.CREATED, object: 'resource-1', delta: 0 },
      { subjectId: 'invalid-agent', verb: Verb.COMPLETED, object: 'resource-1', delta: 100 },
    ];

    // The inner loop no longer catches errors, so the second sentence's
    // validation failure causes the transaction callback to throw,
    // which triggers db.transaction to reject → outer catch returns all-failed.
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      const tx = createMockTx([
        // Sentence 1: CREATED succeeds
        [{ id: 'agent-1' }],
        [{ id: 'ledger-1' }],
        undefined,
        // Sentence 2: COMPLETED fails at subject validation
        [],
      ]);
      return await callback(tx as unknown as TxParam);
    });

    const results = await processSentenceBatch(sentences);

    // All sentences should fail because the entire transaction rolled back
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results[0].error).toContain('Batch transaction failed');
    expect(results[1].error).toContain('Batch transaction failed');

    console.log('✓ Entire batch rolled back when any sentence fails');
  });
});

describe('getAgentTransactionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectIdx = 0;
  });

  it('should retrieve transaction history for agent', async () => {
    const mockRows = [
      {
        id: 'ledger-1',
        subjectId: 'agent-1',
        verb: 'complete',
        objectId: 'resource-1',
        metadata: { engineVerb: 'completed', delta: 100, description: 'Task completed' },
        timestamp: new Date('2024-01-01T00:00:00Z'),
      },
      {
        id: 'ledger-2',
        subjectId: 'agent-2',
        verb: 'endorse',
        objectId: 'agent-1',
        metadata: { engineVerb: 'endorsed', delta: 50, reason: 'Great work' },
        timestamp: new Date('2024-01-02T00:00:00Z'),
      },
    ];

    dbSelectResponses = [mockRows];
    dbSelectIdx = 0;

    const result = await getAgentTransactionHistory('agent-1', 10);

    expect(result).toHaveLength(2);
    expect(result[0].subjectId).toBe('agent-1');
    expect(result[0].verb).toBe(Verb.COMPLETED);
    expect(result[0].metadata.description).toBe('Task completed');
    expect(result[1].object).toBe('agent-1');

    console.log('✓ Transaction history retrieved with correct data mapping');
  });

  it('should return empty array when no history exists', async () => {
    dbSelectResponses = [[]];
    dbSelectIdx = 0;

    const result = await getAgentTransactionHistory('agent-1', 50);

    expect(result).toHaveLength(0);

    console.log('✓ Empty history returned for agent with no transactions');
  });

  it('should throw error on database failure', async () => {
    dbSelectResponses = [];
    dbSelectIdx = 0;

    // Override the select chain to throw
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.reject(new Error('Database connection failed'))),
          })),
        })),
      })),
    }) as unknown as ReturnType<typeof db.select>);

    await expect(
      getAgentTransactionHistory('agent-1')
    ).rejects.toThrow(
      'Failed to retrieve transaction history for agentId=agent-1'
    );

    console.log('✓ Database failure properly wrapped in descriptive error');
  });

  it('should parse metadata correctly', async () => {
    const mockRows = [
      {
        id: 'ledger-1',
        subjectId: 'agent-1',
        verb: 'create',
        objectId: 'resource-1',
        metadata: { engineVerb: 'created', delta: 0, type: 'task', tags: ['urgent', 'backend'] },
        timestamp: new Date('2024-01-01T00:00:00Z'),
      },
    ];

    dbSelectResponses = [mockRows];
    dbSelectIdx = 0;

    const result = await getAgentTransactionHistory('agent-1');

    expect(result[0].metadata.type).toBe('task');
    expect(result[0].metadata.tags).toEqual(['urgent', 'backend']);

    console.log('✓ Metadata parsed correctly from ledger entries');
  });

  it('should handle null metadata', async () => {
    const mockRows = [
      {
        id: 'ledger-1',
        subjectId: 'agent-1',
        verb: 'create',
        objectId: 'resource-1',
        metadata: null,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      },
    ];

    dbSelectResponses = [mockRows];
    dbSelectIdx = 0;

    const result = await getAgentTransactionHistory('agent-1');

    expect(result[0].metadata).toEqual({});

    console.log('✓ Null metadata handled gracefully');
  });
});

describe('Resource Status Updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update resource to PENDING on CREATED', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.CREATED,
      object: 'resource-1',
      delta: 0,
    };

    // CREATED: no object val, resource update, no reputation
    mockTransaction([
      [{ id: 'agent-1' }],
      [{ id: 'ledger-1' }],
      undefined,
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.PENDING);

    console.log('✓ CREATED → PENDING status');
  });

  it('should update resource to IN_PROGRESS on ALLOCATED', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.ALLOCATED,
      object: 'resource-1',
      delta: 0,
    };

    // ALLOCATED: in OBJECT_VALIDATION_VERBS, resource update, no reputation
    mockTransaction([
      [{ id: 'agent-1' }],       // select subject
      [{ id: 'resource-1' }],    // execute: object validation
      [{ id: 'ledger-1' }],      // insert ledger
      undefined,                   // execute: status update
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.IN_PROGRESS);

    console.log('✓ ALLOCATED → IN_PROGRESS status');
  });

  it('should update resource to VALIDATED on VALIDATED', async () => {
    const sentence: Sentence = {
      subjectId: 'agent-1',
      verb: Verb.VALIDATED,
      object: 'resource-1',
      delta: 25,
    };

    // VALIDATED: in OBJECT_VALIDATION_VERBS, resource update, has reputation
    mockTransaction([
      [{ id: 'agent-1' }],                       // select subject
      [{ id: 'resource-1' }],                    // execute: object validation
      [{ id: 'ledger-1' }],                      // insert ledger
      undefined,                                   // execute: status update
      [{ metadata: { reputation: 50 } }],         // select rep
      undefined,                                   // update rep
    ]);

    const result = await processSentence(sentence);

    expect(result.success).toBe(true);
    expect(result.updates?.resourceStatus).toBe(ResourceStatus.VALIDATED);

    console.log('✓ VALIDATED → VALIDATED status');
  });
});
