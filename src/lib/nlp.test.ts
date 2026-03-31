/**
 * Tests for NLP parser
 * Comprehensive test coverage for command parsing and execution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseCommand,
  isValidCommandFormat,
  extractCommandComponents,
  ERROR_CODES,
} from './nlp';

// Mock dependencies
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('@/db/schema', () => ({
  agents: {
    id: 'id',
    name: 'name',
  },
}));

vi.mock('@/lib/engine', () => ({
  processSentence: vi.fn(),
  Verb: {
    CREATED: 'created',
    COMPLETED: 'completed',
    VALIDATED: 'validated',
    TRANSFERRED: 'transferred',
    ENDORSED: 'endorsed',
    REVOKED: 'revoked',
    REQUESTED: 'requested',
    ALLOCATED: 'allocated',
  },
}));

import { db } from '@/db';
import { processSentence } from '@/lib/engine';

describe('NLP Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidCommandFormat', () => {
    it('should validate correct pay command format', () => {
      expect(isValidCommandFormat('pay alice 10')).toBe(true);
      expect(isValidCommandFormat('pay Bob 50')).toBe(true);
      expect(isValidCommandFormat('PAY charlie 100')).toBe(true);
      expect(isValidCommandFormat('pay user_name 25')).toBe(true);
      expect(isValidCommandFormat('pay user-name 25')).toBe(true);
    });

    it('should validate commands with decimal amounts', () => {
      expect(isValidCommandFormat('pay alice 10.5')).toBe(true);
      expect(isValidCommandFormat('pay bob 99.99')).toBe(true);
    });

    it('should handle extra whitespace correctly', () => {
      expect(isValidCommandFormat('pay  alice  10')).toBe(true);
      expect(isValidCommandFormat('  pay alice 10  ')).toBe(true);
      expect(isValidCommandFormat('pay\talice\t10')).toBe(true);
    });

    it('should reject invalid command formats', () => {
      expect(isValidCommandFormat('')).toBe(false);
      expect(isValidCommandFormat('send alice 10')).toBe(false);
      expect(isValidCommandFormat('pay alice')).toBe(false);
      expect(isValidCommandFormat('pay 10')).toBe(false);
      expect(isValidCommandFormat('pay alice -10')).toBe(false);
      expect(isValidCommandFormat('pay alice abc')).toBe(false);
      expect(isValidCommandFormat('alice 10')).toBe(false);
    });

    it('should reject invalid input types', () => {
      expect(isValidCommandFormat(null as unknown as string)).toBe(false);
      expect(isValidCommandFormat(undefined as unknown as string)).toBe(false);
      expect(isValidCommandFormat(123 as unknown as string)).toBe(false);
    });
  });

  describe('extractCommandComponents', () => {
    it('should extract target name and amount from valid commands', () => {
      const result1 = extractCommandComponents('pay alice 10');
      expect(result1).toEqual({ targetName: 'alice', amount: 10 });

      const result2 = extractCommandComponents('pay Bob 50');
      expect(result2).toEqual({ targetName: 'Bob', amount: 50 });

      const result3 = extractCommandComponents('PAY charlie 100');
      expect(result3).toEqual({ targetName: 'charlie', amount: 100 });
    });

    it('should extract decimal amounts correctly', () => {
      const result = extractCommandComponents('pay alice 10.5');
      expect(result).toEqual({ targetName: 'alice', amount: 10.5 });
    });

    it('should handle whitespace correctly', () => {
      const result = extractCommandComponents('  pay  alice  10  ');
      expect(result).toEqual({ targetName: 'alice', amount: 10 });
    });

    it('should return null for invalid formats', () => {
      expect(extractCommandComponents('')).toBeNull();
      expect(extractCommandComponents('send alice 10')).toBeNull();
      expect(extractCommandComponents('pay alice')).toBeNull();
      expect(extractCommandComponents('pay alice -10')).toBeNull();
      expect(extractCommandComponents('pay alice abc')).toBeNull();
    });

    it('should return null for invalid input types', () => {
      expect(extractCommandComponents(null as unknown as string)).toBeNull();
      expect(extractCommandComponents(undefined as unknown as string)).toBeNull();
    });
  });

  describe('parseCommand', () => {
    const mockUserId = 'user-123';
    const mockAgentId = 'agent-456';
    const mockTransactionId = 'tx-789';

    beforeEach(() => {
      // Setup default mocks
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: mockAgentId, name: 'alice' },
            ]),
          }),
        }),
      });

      vi.mocked(processSentence).mockResolvedValue({
        success: true,
        ledgerId: mockTransactionId,
        updates: {
          agentReputation: 100,
        },
      });
    });

    describe('Happy Path', () => {
      it('should successfully parse and execute valid pay command', async () => {
        const result = await parseCommand(mockUserId, 'pay alice 50');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Successfully paid');
        expect(result.message).toContain('50');
        expect(result.message).toContain('alice');
        expect(result.data).toEqual({
          targetAgent: 'alice',
          amount: 50,
          transactionId: mockTransactionId,
        });
      });

      it('should handle case-insensitive agent names', async () => {
        const result = await parseCommand(mockUserId, 'pay ALICE 25');

        expect(result.success).toBe(true);
        expect(result.data?.targetAgent).toBe('alice');
      });

      it('should handle decimal amounts', async () => {
        const result = await parseCommand(mockUserId, 'pay alice 10.5');

        expect(result.success).toBe(true);
        expect(result.data?.amount).toBe(10.5);
      });

      it('should call processSentence with correct parameters', async () => {
        await parseCommand(mockUserId, 'pay alice 50');

        expect(processSentence).toHaveBeenCalledWith({
          subjectId: mockUserId,
          verb: 'endorsed',
          object: mockAgentId,
          delta: 50,
          metadata: expect.objectContaining({
            command: 'pay alice 50',
            targetName: 'alice',
            amount: 50,
            source: 'nlp-parser',
          }),
        });
      });

      it('should include metadata with original command and timestamp', async () => {
        await parseCommand(mockUserId, '  pay  alice  50  ');

        expect(processSentence).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              command: 'pay alice 50',
              originalText: '  pay  alice  50  ',
              parsedAt: expect.any(String),
            }),
          })
        );
      });
    });

    describe('Error Handling - Invalid Input', () => {
      it('should reject invalid userId', async () => {
        const result = await parseCommand('', 'pay alice 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.INVALID_COMMAND_FORMAT);
        expect(result.message).toContain('Invalid userId');
      });

      it('should reject invalid command text', async () => {
        const result = await parseCommand(mockUserId, '');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.INVALID_COMMAND_FORMAT);
        expect(result.message).toContain('Invalid command text');
      });

      it('should reject unrecognized command format', async () => {
        const result = await parseCommand(mockUserId, 'send alice 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.INVALID_COMMAND_FORMAT);
        expect(result.message).toContain('Command format not recognized');
      });
    });

    describe('Error Handling - Invalid Amount', () => {
      it('should reject negative amounts', async () => {
        const result = await parseCommand(mockUserId, 'pay alice -50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.INVALID_COMMAND_FORMAT);
      });

      it('should reject zero amount', async () => {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: mockAgentId, name: 'alice' },
              ]),
            }),
          }),
        });

        // This will fail at pattern matching stage since "0" is technically valid in regex
        // but our validation checks for amount <= 0
        const result = await parseCommand(mockUserId, 'pay alice 0');

        // The pattern will match but validation will fail
        expect(result.success).toBe(false);
      });

      it('should reject non-numeric amounts', async () => {
        const result = await parseCommand(mockUserId, 'pay alice abc');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.INVALID_COMMAND_FORMAT);
      });
    });

    describe('Error Handling - Agent Not Found', () => {
      it('should handle agent not found error', async () => {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await parseCommand(mockUserId, 'pay unknown 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.AGENT_NOT_FOUND);
        expect(result.message).toContain('Agent not found');
        expect(result.message).toContain('unknown');
      });
    });

    describe('Error Handling - Transaction Failure', () => {
      it('should handle processSentence errors gracefully', async () => {
        vi.mocked(processSentence).mockRejectedValue(
          new Error('Insufficient balance')
        );

        const result = await parseCommand(mockUserId, 'pay alice 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.TRANSACTION_FAILED);
        expect(result.message).toContain('Transaction failed');
        expect(result.message).toContain('Insufficient balance');
      });

      it('should handle processSentence returning success: false', async () => {
        vi.mocked(processSentence).mockResolvedValue({
          success: false,
          error: 'Agent reputation cannot go below 0',
        });

        const result = await parseCommand(mockUserId, 'pay alice 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.TRANSACTION_FAILED);
        expect(result.message).toContain('Transaction failed');
        expect(result.message).toContain('Agent reputation cannot go below 0');
      });
    });

    describe('Error Handling - Database Errors', () => {
      it('should handle database query errors', async () => {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockRejectedValue(new Error('DB connection failed')),
            }),
          }),
        });

        const result = await parseCommand(mockUserId, 'pay alice 50');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(ERROR_CODES.DATABASE_ERROR);
      });

      it('should handle unexpected errors gracefully', async () => {
        vi.mocked(db.select).mockImplementation(() => {
          throw new Error('Unexpected error');
        });

        const result = await parseCommand(mockUserId, 'pay alice 50');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Unexpected error');
      });
    });

    describe('Edge Cases', () => {
      it('should handle very large amounts', async () => {
        const result = await parseCommand(mockUserId, 'pay alice 999999999');

        expect(result.success).toBe(true);
        expect(result.data?.amount).toBe(999999999);
      });

      it('should handle agent names with special characters', async () => {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: mockAgentId, name: 'user-name_123' },
              ]),
            }),
          }),
        });

        const result = await parseCommand(mockUserId, 'pay user-name_123 50');

        expect(result.success).toBe(true);
        expect(result.data?.targetAgent).toBe('user-name_123');
      });

      it('should normalize multiple spaces in command', async () => {
        const result = await parseCommand(mockUserId, 'pay    alice    50');

        expect(result.success).toBe(true);
        expect(processSentence).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              command: 'pay alice 50',
            }),
          })
        );
      });
    });
  });
});
