/**
 * NLP command parsing and execution for payment-style commands.
 *
 * This module validates and parses natural language commands (currently
 * `"pay [name] [amount]"`), resolves target agents, and dispatches value
 * transfers through the transaction engine.
 *
 * Key exports:
 * - `parseCommand`
 * - `isValidCommandFormat`
 * - `extractCommandComponents`
 * - `NLPError` and `ERROR_CODES`
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for agent lookup.
 * - `@/lib/engine` for transaction execution.
 * - `drizzle-orm` SQL utilities.
 * - `@/lib/sql-like` for LIKE wildcard escaping.
 */

import { db } from '@/db';
import { agents } from '@/db/schema';
import { processSentence, Verb } from '@/lib/engine';
import { sql } from 'drizzle-orm';
import { escapeLikePattern } from '@/lib/sql-like';

/**
 * Structured error type for parser and execution failures.
 */
export class NLPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'NLPError';
  }
}

/** Stable machine-readable codes used by parser and execution responses. */
export const ERROR_CODES = {
  INVALID_COMMAND_FORMAT: 'INVALID_COMMAND_FORMAT',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
} as const;

/**
 * Result contract returned by command parsing/execution.
 */
export interface ParseResult {
  success: boolean;
  message: string;
  data?: {
    targetAgent: string;
    amount: number;
    transactionId?: string;
  };
  error?: {
    code: string;
    details: string;
  };
}

/**
 * Command pattern for "pay [name] [amount]"
 * Supports variations like:
 * - "pay alice 10"
 * - "pay Bob 5"
 * - "pay charlie 100"
 */
const PAY_COMMAND_PATTERN = /^pay\s+([a-zA-Z0-9_-]+)\s+(\d+(?:\.\d+)?)$/i;

/**
 * Parse and execute a natural language command
 *
 * @param userId - The ID of the user issuing the command
 * @param text - The command text to parse
 * @returns A structured parse/execution result; errors are returned in-band.
 * @throws {NLPError} Internally for validation/DB/transaction failures (caught and converted to `ParseResult`).
 * @throws {Error} Unexpected runtime errors are caught and returned as `DATABASE_ERROR`.
 *
 * @example
 * const result = await parseCommand('user-123', 'pay alice 50');
 * if (result.success) {
 *   console.log(`Paid ${result.data?.amount} to ${result.data?.targetAgent}`);
 * }
 */
export async function parseCommand(
  userId: string,
  text: string
): Promise<ParseResult> {
  try {
    // Validate input
    if (!userId || typeof userId !== 'string') {
      throw new NLPError(
        'Invalid userId provided',
        ERROR_CODES.INVALID_COMMAND_FORMAT,
        { userId }
      );
    }

    if (!text || typeof text !== 'string') {
      throw new NLPError(
        'Invalid command text provided',
        ERROR_CODES.INVALID_COMMAND_FORMAT,
        { text }
      );
    }

    // Trim and normalize whitespace
    const normalizedText = text.trim().replace(/\s+/g, ' ');

    // Match against pay command pattern
    const match = normalizedText.match(PAY_COMMAND_PATTERN);

    if (!match) {
      throw new NLPError(
        `Command format not recognized. Expected: "pay [name] [amount]"`,
        ERROR_CODES.INVALID_COMMAND_FORMAT,
        { text: normalizedText }
      );
    }

    const [, targetName, amountStr] = match;

    // Parse and validate amount
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new NLPError(
        `Invalid amount: ${amountStr}. Amount must be a positive number.`,
        ERROR_CODES.INVALID_AMOUNT,
        { amountStr, parsedAmount: amount }
      );
    }

    // Resolve target agent by name with wildcard escaping to avoid LIKE pattern abuse.
    const targetAgent = await resolveAgentByName(targetName);

    if (!targetAgent) {
      throw new NLPError(
        `Agent not found: ${targetName}`,
        ERROR_CODES.AGENT_NOT_FOUND,
        { targetName }
      );
    }

    // Execute transaction through the engine to preserve centralized business rules.
    try {
      const transactionResult = await processSentence({
        subjectId: userId,
        verb: Verb.ENDORSED,
        object: targetAgent.id,
        delta: amount,
        metadata: {
          command: normalizedText,
          originalText: text,
          parsedAt: new Date().toISOString(),
          targetName,
          amount,
          source: 'nlp-parser',
        },
      });

      if (!transactionResult.success) {
        throw new Error(transactionResult.error || 'Transaction failed');
      }

      return {
        success: true,
        message: `Successfully paid ${amount} points to ${targetAgent.name}`,
        data: {
          targetAgent: targetAgent.name,
          amount,
          transactionId: transactionResult.ledgerId,
        },
      };
    } catch (error) {
      throw new NLPError(
        `Transaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ERROR_CODES.TRANSACTION_FAILED,
        {
          userId,
          targetAgentId: targetAgent.id,
          amount,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  } catch (error) {
    if (error instanceof NLPError) {
      return {
        success: false,
        message: error.message,
        error: {
          code: error.code,
          details: JSON.stringify(error.context || {}),
        },
      };
    }

    // Handle unexpected errors
    return {
      success: false,
      message: 'An unexpected error occurred while processing the command',
      error: {
        code: ERROR_CODES.DATABASE_ERROR,
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Resolve an agent by name (case-insensitive lookup)
 *
 * @param name - The agent name to search for
 * @returns The agent record or null if not found
 */
async function resolveAgentByName(
  name: string
): Promise<{ id: string; name: string } | null> {
  try {
    // Perform case-insensitive name lookup using ilike
    const result = await db
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(sql`${agents.name} ILIKE ${escapeLikePattern(name)} ESCAPE '\\'`)
      .limit(1);

    return result.length > 0 ? result[0] : null;
  } catch (error) {
    throw new NLPError(
      `Database error while resolving agent: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ERROR_CODES.DATABASE_ERROR,
      { name, error: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Validate command format without executing
 * Useful for input validation in UI
 *
 * @param text - The command text to validate
 * @returns `true` when text matches `"pay [name] [amount]"`, otherwise `false`.
 * @throws {Error} Does not intentionally throw; any unexpected runtime error propagates.
 * @example
 * isValidCommandFormat('pay alice 25'); // true
 */
export function isValidCommandFormat(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }

  const normalizedText = text.trim().replace(/\s+/g, ' ');
  return PAY_COMMAND_PATTERN.test(normalizedText);
}

/**
 * Extract command components without execution
 * Useful for previewing commands before execution
 *
 * @param text - The command text to parse
 * @returns Parsed `{ targetName, amount }` or `null` when invalid.
 * @throws {Error} Does not intentionally throw; any unexpected runtime error propagates.
 * @example
 * extractCommandComponents('pay bob 10'); // { targetName: 'bob', amount: 10 }
 */
export function extractCommandComponents(text: string): {
  targetName: string;
  amount: number;
} | null {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const normalizedText = text.trim().replace(/\s+/g, ' ');
  const match = normalizedText.match(PAY_COMMAND_PATTERN);

  if (!match) {
    return null;
  }

  const [, targetName, amountStr] = match;
  const amount = parseFloat(amountStr);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return { targetName, amount };
}
