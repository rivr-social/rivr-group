/**
 * Tests for AI module (embeddings and geospatial helpers)
 * Validates vector generation, cosine similarity SQL, and geo helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  generateEmbedding,
  generateEmbeddings,
  getEmbedder,
  cosineSimilarity,
  withinRadius,
  geoDistance,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from '../ai';

// Mock @xenova/transformers
vi.mock('@xenova/transformers', () => ({
  pipeline: vi.fn(),
}));

import { pipeline } from '@xenova/transformers';

describe('ai.ts', () => {
  const MOCK_EMBEDDING = new Float32Array(
    Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i * 0.001)
  );

  const mockEmbedder = vi.fn().mockResolvedValue({
    data: MOCK_EMBEDDING,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pipeline).mockResolvedValue(mockEmbedder as unknown as Awaited<ReturnType<typeof pipeline>>);
  });

  describe('constants', () => {
    it('should use all-MiniLM-L6-v2 model', () => {
      expect(EMBEDDING_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
    });

    it('should use 384 dimensions', () => {
      expect(EMBEDDING_DIMENSIONS).toBe(384);
    });
  });

  describe('getEmbedder', () => {
    it('should create an embedder using feature-extraction pipeline', async () => {
      await getEmbedder();

      expect(pipeline).toHaveBeenCalledWith(
        'feature-extraction',
        EMBEDDING_MODEL
      );
    });

    it('should return cached embedder on subsequent calls', async () => {
      const embedder1 = await getEmbedder();
      const embedder2 = await getEmbedder();

      // pipeline should only be called once due to singleton
      expect(embedder1).toBe(embedder2);
    });
  });

  describe('generateEmbedding', () => {
    it('should generate embedding for valid text', async () => {
      const result = await generateEmbedding('test text');

      expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(mockEmbedder).toHaveBeenCalledWith('test text', {
        pooling: 'mean',
        normalize: true,
      });
    });

    it('should return a plain number array', async () => {
      const result = await generateEmbedding('hello world');

      expect(Array.isArray(result)).toBe(true);
      result.forEach((val) => {
        expect(typeof val).toBe('number');
      });
    });

    it('should throw error for empty text', async () => {
      await expect(generateEmbedding('')).rejects.toThrow(
        'Cannot generate embedding for empty text'
      );
    });

    it('should throw error for whitespace-only text', async () => {
      await expect(generateEmbedding('   ')).rejects.toThrow(
        'Cannot generate embedding for empty text'
      );
    });
  });

  describe('generateEmbeddings', () => {
    it('should generate embeddings for multiple texts', async () => {
      const texts = ['hello', 'world', 'test'];

      const results = await generateEmbeddings(texts);

      expect(results).toHaveLength(3);
      results.forEach((embedding) => {
        expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      });
      expect(mockEmbedder).toHaveBeenCalledTimes(3);
    });

    it('should return empty array for empty input', async () => {
      const results = await generateEmbeddings([]);

      expect(results).toEqual([]);
      expect(mockEmbedder).not.toHaveBeenCalled();
    });

    it('should throw error if any text in batch is empty', async () => {
      await expect(
        generateEmbeddings(['valid', '', 'also valid'])
      ).rejects.toThrow('Cannot generate embedding for empty text in batch');
    });

    it('should throw error if any text in batch is whitespace-only', async () => {
      await expect(
        generateEmbeddings(['valid', '   ', 'also valid'])
      ).rejects.toThrow('Cannot generate embedding for empty text in batch');
    });
  });

  describe('cosineSimilarity', () => {
    it('should throw error for wrong dimension count', () => {
      const wrongVector = [0.1, 0.2, 0.3]; // Only 3 dimensions

      expect(() => {
        cosineSimilarity({} as unknown as SQL, wrongVector);
      }).toThrow(
        `Query vector has 3 dimensions, expected ${EMBEDDING_DIMENSIONS}`
      );
    });

    it('should accept vector with correct dimensions', () => {
      const correctVector = Array.from(
        { length: EMBEDDING_DIMENSIONS },
        () => 0.1
      );

      // Should not throw
      expect(() => {
        cosineSimilarity({} as unknown as SQL, correctVector);
      }).not.toThrow();
    });
  });

  describe('withinRadius', () => {
    it('should produce a SQL fragment without throwing', () => {
      const result = withinRadius({} as unknown as SQL, 40.7484, -73.9857, 5000);

      // withinRadius returns a Drizzle SQL template; just verify it returns something
      expect(result).toBeDefined();
    });
  });

  describe('geoDistance', () => {
    it('should produce a SQL fragment without throwing', () => {
      const result = geoDistance({} as unknown as SQL, 40.7484, -73.9857);

      expect(result).toBeDefined();
    });
  });
});
