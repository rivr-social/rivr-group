/**
 * Tests for the pure cross-platform reshare logic (EPIC J9): platform/type
 * narrowing, stable idempotency keys, platform-clamped payload building, and the
 * credential gate that decides whether an adapter can actually deliver. DB-free.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_RESHARE_PLATFORMS,
  normalizeResharePlatform,
  isReshareableResourceType,
  reshareIdempotencyKey,
  buildResharePayload,
  connectorCanDeliver,
  type ReshareSource,
} from '@/lib/reshare';

describe('normalizeResharePlatform', () => {
  it('passes through every supported platform', () => {
    for (const p of SUPPORTED_RESHARE_PLATFORMS) {
      expect(normalizeResharePlatform(p)).toBe(p);
    }
  });

  it('returns null for unsupported/non-string values', () => {
    expect(normalizeResharePlatform('myspace')).toBeNull();
    expect(normalizeResharePlatform(42)).toBeNull();
    expect(normalizeResharePlatform(null)).toBeNull();
  });
});

describe('isReshareableResourceType', () => {
  it('accepts reshareable types and rejects others', () => {
    expect(isReshareableResourceType('offering')).toBe(true);
    expect(isReshareableResourceType('listing')).toBe(true);
    expect(isReshareableResourceType('post')).toBe(true);
    expect(isReshareableResourceType('event')).toBe(true);
    expect(isReshareableResourceType('task')).toBe(false);
    expect(isReshareableResourceType('badge')).toBe(false);
    expect(isReshareableResourceType(123)).toBe(false);
  });
});

describe('reshareIdempotencyKey', () => {
  it('is stable for the same (group, platform, resource) triple', () => {
    const a = reshareIdempotencyKey('g1', 'discord', 'r1');
    const b = reshareIdempotencyKey('g1', 'discord', 'r1');
    expect(a).toBe(b);
    expect(a).toBe('reshare:g1:discord:r1');
  });

  it('differs across platform or resource', () => {
    expect(reshareIdempotencyKey('g1', 'discord', 'r1')).not.toBe(
      reshareIdempotencyKey('g1', 'slack', 'r1'),
    );
    expect(reshareIdempotencyKey('g1', 'discord', 'r1')).not.toBe(
      reshareIdempotencyKey('g1', 'discord', 'r2'),
    );
  });
});

describe('buildResharePayload', () => {
  const source: ReshareSource = {
    resourceId: 'r1',
    resourceType: 'offering',
    title: 'Hand-carved spoons',
    description: 'A set of three locally crafted spoons.',
    url: 'https://group.example/marketplace/r1',
  };

  it('combines title and description, carries url + idempotency key', () => {
    const payload = buildResharePayload('g1', 'discord', source);
    expect(payload.platform).toBe('discord');
    expect(payload.title).toBe('Hand-carved spoons');
    expect(payload.body).toBe(
      'Hand-carved spoons — A set of three locally crafted spoons.',
    );
    expect(payload.url).toBe('https://group.example/marketplace/r1');
    expect(payload.idempotencyKey).toBe('reshare:g1:discord:r1');
  });

  it('falls back to title-only when there is no description', () => {
    const payload = buildResharePayload('g1', 'slack', {
      ...source,
      description: null,
    });
    expect(payload.body).toBe('Hand-carved spoons');
  });

  it('clamps the body to the platform character limit with an ellipsis', () => {
    const longDescription = 'x'.repeat(500);
    const payload = buildResharePayload('g1', 'twitter', {
      ...source,
      description: longDescription,
    });
    // twitter limit is 240
    expect(payload.body.length).toBeLessThanOrEqual(240);
    expect(payload.body.endsWith('…')).toBe(true);
  });

  it('does not truncate content within the platform limit', () => {
    const payload = buildResharePayload('g1', 'webhook', source);
    expect(payload.body.endsWith('…')).toBe(false);
  });
});

describe('connectorCanDeliver', () => {
  it('webhook-style platforms require a webhookUrl', () => {
    expect(connectorCanDeliver('discord', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('slack', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('webhook', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('discord', {})).toBe(false);
    expect(connectorCanDeliver('slack', { webhookUrl: '' })).toBe(false);
  });

  it('api platforms require an accessToken', () => {
    expect(connectorCanDeliver('twitter', { accessToken: 'tok' })).toBe(true);
    expect(connectorCanDeliver('mastodon', { accessToken: 'tok' })).toBe(true);
    expect(connectorCanDeliver('twitter', {})).toBe(false);
    expect(connectorCanDeliver('mastodon', { accessToken: '' })).toBe(false);
  });
});
