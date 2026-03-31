/**
 * Transaction Engine - Grammar of Value & Double Bottom Line
 * Implements the core value transfer and recording mechanism.
 *
 * This module validates sentence-shaped actions, records immutable ledger
 * entries, optionally enforces ReBAC permissions, and applies derived effects
 * such as resource status and reputation updates.
 *
 * Key exports:
 * - `Verb`, `ResourceStatus`
 * - `processSentence`, `processSentenceBatch`, `getAgentTransactionHistory`
 * - `Sentence`, `ProcessingResult`, `LedgerEntry`
 *
 * Dependencies:
 * - `drizzle-orm` with local tables (`agents`, `ledger`).
 * - `./permissions` for optional authorization checks.
 */

import { db } from '../db/index';
import { agents, ledger } from '../db/schema';
import type { VerbType } from '../db/schema';
import { eq, or, desc, sql } from 'drizzle-orm';
import { check } from './permissions';
import { evaluateRules } from './contract-engine';
import { engineVerbToSchema, ENGINE_VERB_TO_SCHEMA } from './verb-map';

/**
 * Verb types for the Grammar of Value
 */
export enum Verb {
  // CRUD / Core
  CREATED = 'created',
  COMPLETED = 'completed',
  VALIDATED = 'validated',
  TRANSFERRED = 'transferred',
  ENDORSED = 'endorsed',
  REVOKED = 'revoked',
  REQUESTED = 'requested',
  ALLOCATED = 'allocated',
  // Membership / Structural
  JOINED = 'joined',
  BELONGED = 'belonged',
  ASSIGNED = 'assigned',
  INVITED = 'invited',
  EMPLOYED = 'employed',
  CONTAINED = 'contained',
  MANAGED = 'managed',
  OWNED = 'owned',
  FOLLOWED = 'followed',
  LOCATED = 'located',
  // Economic
  BOUGHT = 'bought',
  SOLD = 'sold',
  TRADED = 'traded',
  GIFTED = 'gifted',
  EARNED = 'earned',
  REDEEMED = 'redeemed',
  FUNDED = 'funded',
  PLEDGED = 'pledged',
  TRANSACTED = 'transacted',
  // Work
  WORKED = 'worked',
  CLOCKED_IN = 'clocked_in',
  CLOCKED_OUT = 'clocked_out',
  PRODUCED = 'produced',
  CONSUMED = 'consumed',
  // Governance
  VOTED = 'voted',
  PROPOSED = 'proposed',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  // Lifecycle
  STARTED = 'started',
  CANCELLED = 'cancelled',
  ARCHIVED = 'archived',
  PUBLISHED = 'published',
  // Spatial / Temporal
  ATTENDED = 'attended',
  HOSTED = 'hosted',
  SCHEDULED = 'scheduled',
  // Social
  SHARED = 'shared',
  MENTIONED = 'mentioned',
  COMMENTED = 'commented',
  REACTED = 'reacted',
}

/**
 * Resource status values
 */
export enum ResourceStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  VALIDATED = 'validated',
  CANCELLED = 'cancelled',
}

/**
 * Sentence structure for value transactions
 * Follows the pattern: Subject [Verb] Object [Delta] [Metadata]
 */
export interface Sentence {
  /** Agent performing the action */
  subjectId: string;

  /** Action being performed */
  verb: Verb;

  /** Target of the action (agent ID, resource ID, etc.) */
  object: string;

  /** Numeric value change (economic or social) */
  delta: number;

  /** Additional context and data */
  metadata?: Record<string, unknown>;

  /** Optional object type override (defaults to 'agent' when not provided) */
  objectType?: string;
}

/**
 * Result of processing a sentence
 */
export interface ProcessingResult {
  success: boolean;
  ledgerId?: string;
  error?: string;
  updates?: {
    resourceStatus?: ResourceStatus;
    agentReputation?: number;
  };
}

/**
 * Configuration for reputation calculations.
 * Uses a purely additive model: endorsements add (delta * BOOST_MULTIPLIER),
 * revocations subtract (delta * DECAY_FACTOR), all other social verbs add delta.
 * Reputation is clamped to [MIN_REPUTATION, MAX_REPUTATION].
 */
const REPUTATION_CONFIG = {
  MIN_REPUTATION: 0,
  MAX_REPUTATION: 100,
  DECAY_FACTOR: 0.9,
  BOOST_MULTIPLIER: 1.1,
} as const;

/**
 * Maps verbs to the resource status they produce.
 * Only verbs that change resource status are included.
 */
const VERB_TO_STATUS: Partial<Record<Verb, ResourceStatus>> = {
  // Core lifecycle
  [Verb.CREATED]: ResourceStatus.PENDING,
  [Verb.STARTED]: ResourceStatus.IN_PROGRESS,
  [Verb.COMPLETED]: ResourceStatus.COMPLETED,
  [Verb.VALIDATED]: ResourceStatus.VALIDATED,
  [Verb.CANCELLED]: ResourceStatus.CANCELLED,
  [Verb.ARCHIVED]: ResourceStatus.COMPLETED,
  [Verb.PUBLISHED]: ResourceStatus.COMPLETED,
  // Value flow
  [Verb.TRANSFERRED]: ResourceStatus.COMPLETED,
  [Verb.ENDORSED]: ResourceStatus.VALIDATED,
  [Verb.REVOKED]: ResourceStatus.CANCELLED,
  [Verb.REQUESTED]: ResourceStatus.PENDING,
  [Verb.ALLOCATED]: ResourceStatus.IN_PROGRESS,
  [Verb.ASSIGNED]: ResourceStatus.IN_PROGRESS,
  [Verb.APPROVED]: ResourceStatus.VALIDATED,
  [Verb.REJECTED]: ResourceStatus.CANCELLED,
};

/**
 * Verbs that trigger resource status updates
 */
const WORK_COMPLETION_VERBS = new Set<Verb>([
  Verb.CREATED, Verb.STARTED, Verb.COMPLETED, Verb.VALIDATED,
  Verb.TRANSFERRED, Verb.ENDORSED, Verb.REVOKED,
  Verb.REQUESTED, Verb.ALLOCATED, Verb.ASSIGNED,
  Verb.CANCELLED, Verb.ARCHIVED, Verb.PUBLISHED,
  Verb.APPROVED, Verb.REJECTED,
]);

/**
 * Verbs that affect social value (reputation)
 */
const SOCIAL_VALUE_VERBS = new Set<Verb>([
  Verb.ENDORSED, Verb.VALIDATED, Verb.REVOKED,
  Verb.COMPLETED, Verb.APPROVED, Verb.REJECTED,
  Verb.VOTED, Verb.PROPOSED, Verb.MENTIONED,
]);

/**
 * Verbs that require object reference validation.
 * Any verb that logically acts on an existing agent or resource must be listed here
 * so we confirm the target exists (and is not soft-deleted) before writing to the ledger.
 */
const OBJECT_VALIDATION_VERBS = new Set<Verb>([
  // Structural / Membership
  Verb.TRANSFERRED, Verb.ENDORSED, Verb.VALIDATED, Verb.ALLOCATED,
  Verb.ASSIGNED, Verb.BELONGED, Verb.CONTAINED, Verb.INVITED,
  Verb.EMPLOYED, Verb.MANAGED, Verb.OWNED, Verb.FOLLOWED,
  // Spatial / Temporal
  Verb.ATTENDED, Verb.HOSTED, Verb.SCHEDULED,
  // Social
  Verb.MENTIONED, Verb.COMMENTED, Verb.REACTED, Verb.SHARED,
  // Economic
  Verb.BOUGHT, Verb.SOLD, Verb.TRADED, Verb.GIFTED,
  Verb.EARNED, Verb.REDEEMED, Verb.FUNDED, Verb.PLEDGED,
  // Governance
  Verb.VOTED, Verb.APPROVED, Verb.REJECTED, Verb.PROPOSED,
  // Work
  Verb.WORKED, Verb.PRODUCED, Verb.CONSUMED, Verb.CLOCKED_IN, Verb.CLOCKED_OUT,
  // Lifecycle
  Verb.PUBLISHED,
]);

/**
 * Maps engine Verb (past tense) to schema verb_type (present tense) for rule evaluation.
 * Contract rules store present-tense verbs matching the schema enum.
 */
function verbToSchemaVerb(verb: Verb): string {
  return engineVerbToSchema(verb);
}

/**
 * Options for processSentence
 */
export interface ProcessSentenceOptions {
  /** When true, verify ReBAC permissions before writing to the ledger */
  checkPermissions?: boolean;
}

/**
 * Structural verbs that require permission checks when checkPermissions is enabled.
 * These verbs affect group membership, ownership, and management hierarchy.
 */
const PERMISSION_CHECK_VERBS = new Set<Verb>([
  Verb.JOINED, Verb.BELONGED, Verb.ASSIGNED, Verb.INVITED,
  Verb.EMPLOYED, Verb.MANAGED, Verb.OWNED, Verb.CONTAINED,
  Verb.TRANSFERRED, Verb.ALLOCATED, Verb.ENDORSED, Verb.VALIDATED,
  Verb.REVOKED, Verb.APPROVED, Verb.REJECTED,
]);

/**
 * Maps engine verbs (past tense) to ReBAC VerbType (present tense) for permission checks.
 */
const ENGINE_TO_REBAC_VERB: Partial<Record<Verb, VerbType>> = {
  [Verb.JOINED]: 'join',
  [Verb.BELONGED]: 'belong',
  [Verb.ASSIGNED]: 'assign',
  [Verb.INVITED]: 'invite',
  [Verb.EMPLOYED]: 'employ',
  [Verb.MANAGED]: 'manage',
  [Verb.OWNED]: 'own',
  [Verb.CONTAINED]: 'contain',
  [Verb.TRANSFERRED]: 'transfer',
  [Verb.ALLOCATED]: 'assign',
  [Verb.ENDORSED]: 'endorse',
  [Verb.VALIDATED]: 'approve',
  [Verb.REVOKED]: 'delete',
  [Verb.APPROVED]: 'approve',
  [Verb.REJECTED]: 'reject',
};

/**
 * Processes a sentence through the transaction engine
 * Implements the Double Bottom Line by recording both economic and social value
 *
 * @param sentence - The value transaction to process
 * @param options - Optional configuration (e.g., checkPermissions)
 * @returns Processing result with transaction details.
 * @throws {Error} Internal validation/DB errors are caught and returned as `success: false`.
 * @example
 * const result = await processSentence({
 *   subjectId: "agent-a",
 *   verb: Verb.ENDORSED,
 *   object: "agent-b",
 *   delta: 5,
 * });
 */
export async function processSentence(
  sentence: Sentence,
  options?: ProcessSentenceOptions
): Promise<ProcessingResult> {
  const { subjectId, verb, object, delta, metadata = {} } = sentence;

  try {
    // Security gate: block unauthorized structural/economic actions before writes.
    if (options?.checkPermissions && PERMISSION_CHECK_VERBS.has(verb)) {
      const rebacVerb = ENGINE_TO_REBAC_VERB[verb];
      if (rebacVerb) {
        const permResult = await check(subjectId, rebacVerb, object, "agent");
        if (!permResult.allowed) {
          return {
            success: false,
            error: `Permission denied: ${permResult.reason} (actor=${subjectId}, verb=${rebacVerb}, target=${object})`,
          };
        }
      }
    }

    // Atomic transaction ensures ledger + derived updates commit/rollback together.
    const result = await db.transaction(async (tx) => {
      // Step 1: Validate the sentence
      await validateSentence(sentence, tx);

      // Step 2: Persist canonical immutable ledger record.
      const ledgerEntry = await writeLedgerEntry(
        { subjectId, verb, object, delta, metadata },
        tx
      );

      // Step 3: Apply resource status projection for lifecycle/value verbs.
      let resourceStatus: ResourceStatus | undefined;
      if (WORK_COMPLETION_VERBS.has(verb)) {
        resourceStatus = await updateResourceStatus(object, verb, tx);
      }

      // Step 4: Apply social-value projection (reputation) for qualifying verbs.
      let agentReputation: number | undefined;
      if (SOCIAL_VALUE_VERBS.has(verb)) {
        const reputationTargetId =
          verb === Verb.ENDORSED || verb === Verb.REVOKED ? object : subjectId;
        agentReputation = await updateAgentReputation(
          reputationTargetId,
          delta,
          verb,
          tx
        );
      }

      return {
        ledgerId: ledgerEntry.id,
        resourceStatus,
        agentReputation,
      };
    });

    // Fire-and-forget rule evaluation after transaction commits.
    // Failures in rule evaluation must not break the original ledger write.
    evaluateRules({
      subjectId,
      verb: verbToSchemaVerb(verb) ?? verb,
      objectId: object,
      delta,
      metadata,
    }).catch((err) =>
      console.error('[contract-engine] Rule evaluation failed:', err)
    );

    return {
      success: true,
      ledgerId: result.ledgerId,
      updates: {
        resourceStatus: result.resourceStatus,
        agentReputation: result.agentReputation,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to process sentence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Validates a sentence before processing
 * Ensures all required data is present and valid
 */
async function validateSentence(
  sentence: Sentence,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<void> {
  const { subjectId, verb, object, delta } = sentence;

  // Validate subject exists
  const subjectResult = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, subjectId))
    .limit(1);

  if (subjectResult.length === 0) {
    throw new Error(`Subject agent not found: ${subjectId}`);
  }

  // Validate verb is valid
  if (!Object.values(Verb).includes(verb)) {
    throw new Error(`Invalid verb: ${verb}`);
  }

  // Validate delta is a number
  if (typeof delta !== 'number' || !isFinite(delta)) {
    throw new Error(`Invalid delta value: ${delta}`);
  }

  // Validate object exists and is not soft-deleted (if it's an agent or resource reference)
  if (OBJECT_VALIDATION_VERBS.has(verb)) {
    const objectResult = await tx.execute(sql`
      SELECT id FROM agents WHERE id = ${object} AND deleted_at IS NULL
      UNION
      SELECT id FROM resources WHERE id = ${object} AND deleted_at IS NULL
    `);

    if ((objectResult as unknown[]).length === 0) {
      throw new Error(`Object not found: ${object}`);
    }
  }
}

/**
 * Writes an entry to the ledger table
 * This is the permanent, immutable record of the transaction
 */
async function writeLedgerEntry(
  entry: Sentence,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<{ id: string }> {
  const { subjectId, verb, object, delta, metadata, objectType } = entry;

  // Map engine verb (past tense) to schema verb_type enum (present tense)
  const schemaVerb = ENGINE_VERB_TO_SCHEMA[verb as keyof typeof ENGINE_VERB_TO_SCHEMA] ?? 'create';

  const [inserted] = await tx
    .insert(ledger)
    .values({
      subjectId,
      verb: schemaVerb,
      objectId: object,
      objectType: objectType ?? 'agent',
      metadata: { ...metadata, engineVerb: verb, delta },
    } as typeof ledger.$inferInsert)
    .returning({ id: ledger.id });

  return { id: inserted.id };
}

/**
 * Updates resource status based on work completion verbs
 */
async function updateResourceStatus(
  resourceId: string,
  verb: Verb,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<ResourceStatus> {
  const newStatus = VERB_TO_STATUS[verb];
  if (!newStatus) {
    throw new Error(`No status mapping for verb: ${verb}`);
  }

  // Update resource metadata with status
  await tx.execute(sql`
    UPDATE resources
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{status}',
      ${JSON.stringify(newStatus)}::jsonb
    ),
    updated_at = NOW()
    WHERE id = ${resourceId}
  `);

  return newStatus;
}

/**
 * Updates agent reputation based on social delta
 * Implements reputation bounds and decay mechanics
 */
async function updateAgentReputation(
  agentId: string,
  delta: number,
  verb: Verb,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<number> {
  // Retrieve current reputation from metadata
  const agentResult = await tx
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (agentResult.length === 0) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const currentMetadata = (agentResult[0].metadata ?? {}) as Record<string, unknown>;
  const currentReputation = (typeof currentMetadata.reputation === 'number')
    ? currentMetadata.reputation
    : 0;

  // Calculate new reputation with purely additive verb-specific modifiers.
  // Endorsement: add (delta * BOOST_MULTIPLIER).
  // Revocation: subtract (delta * DECAY_FACTOR) — delta is typically negative.
  // All others: add delta as-is.
  let newReputation: number;

  if (verb === Verb.ENDORSED) {
    newReputation = currentReputation + delta * REPUTATION_CONFIG.BOOST_MULTIPLIER;
  } else if (verb === Verb.REVOKED) {
    newReputation = currentReputation + delta * REPUTATION_CONFIG.DECAY_FACTOR;
  } else {
    newReputation = currentReputation + delta;
  }

  // Enforce reputation bounds
  newReputation = Math.max(
    REPUTATION_CONFIG.MIN_REPUTATION,
    Math.min(REPUTATION_CONFIG.MAX_REPUTATION, newReputation)
  );

  // Update agent reputation in metadata
  await tx
    .update(agents)
    .set({
      metadata: { ...currentMetadata, reputation: newReputation },
      updatedAt: new Date(),
    } as Partial<typeof agents.$inferSelect>)
    .where(eq(agents.id, agentId));

  return newReputation;
}

/**
 * Batch processes multiple sentences in a single transaction
 * Useful for complex multi-step operations
 *
 * @param sentences - Array of sentences to process
 * @returns Processing results in input order; all fail if any statement fails.
 * @throws {Error} Internal transaction errors are caught and converted to failed results.
 * @example
 * const batch = await processSentenceBatch([sentenceA, sentenceB]);
 */
export async function processSentenceBatch(
  sentences: Sentence[]
): Promise<ProcessingResult[]> {
  try {
    // All sentences are processed inside a single transaction.
    // If ANY sentence fails, the entire transaction rolls back — no partial commits.
    const results = await db.transaction(async (tx) => {
      const batchResults: ProcessingResult[] = [];

      for (const sentence of sentences) {
        await validateSentence(sentence, tx);

        const ledgerEntry = await writeLedgerEntry(sentence, tx);

        let resourceStatus: ResourceStatus | undefined;
        if (WORK_COMPLETION_VERBS.has(sentence.verb)) {
          resourceStatus = await updateResourceStatus(
            sentence.object,
            sentence.verb,
            tx
          );
        }

        let agentReputation: number | undefined;
        if (SOCIAL_VALUE_VERBS.has(sentence.verb)) {
          const reputationTargetId =
            sentence.verb === Verb.ENDORSED || sentence.verb === Verb.REVOKED
              ? sentence.object
              : sentence.subjectId;
          agentReputation = await updateAgentReputation(
            reputationTargetId,
            sentence.delta,
            sentence.verb,
            tx
          );
        }

        batchResults.push({
          success: true,
          ledgerId: ledgerEntry.id,
          updates: {
            resourceStatus,
            agentReputation,
          },
        });
      }

      return batchResults;
    });

    return results;
  } catch (error) {
    return sentences.map(() => ({
      success: false,
      error: `Batch transaction failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }));
  }
}

/**
 * Retrieves transaction history for an agent
 *
 * @param agentId - The agent ID
 * @param limit - Maximum number of entries to return
 * @returns Ledger-like entries ordered from newest to oldest.
 * @throws {Error} If the database query fails.
 * @example
 * const history = await getAgentTransactionHistory("agent-123", 50);
 */
export async function getAgentTransactionHistory(
  agentId: string,
  limit: number = 100
): Promise<LedgerEntry[]> {
  try {
    const rows = await db
      .select({
        id: ledger.id,
        subjectId: ledger.subjectId,
        verb: ledger.verb,
        objectId: ledger.objectId,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
      })
      .from(ledger)
      .where(
        or(
          eq(ledger.subjectId, agentId),
          eq(ledger.objectId, agentId)
        )
      )
      .orderBy(desc(ledger.timestamp))
      .limit(limit);

    return rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        subjectId: row.subjectId,
        verb: (meta.engineVerb as Verb) ?? (row.verb as unknown as Verb),
        object: row.objectId ?? '',
        delta: (typeof meta.delta === 'number') ? meta.delta : 0,
        metadata: meta,
        timestamp: row.timestamp.toISOString(),
      };
    });
  } catch (error) {
    throw new Error(
      `Failed to retrieve transaction history for agentId=${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Ledger entry type
 */
export interface LedgerEntry {
  id: string;
  subjectId: string;
  verb: Verb;
  object: string;
  delta: number;
  metadata: Record<string, unknown>;
  timestamp: string;
}
