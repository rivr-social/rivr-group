/**
 * Tests for the pure cross-platform reshare logic (EPIC J9): platform/type
 * narrowing, delivery-mode classification, share-intent URL building, stable
 * idempotency keys, payload building (which ALWAYS carries the canonical
 * backlink and rejects a missing one), and the credential gate that only allows
 * server push for API-mode platforms. DB-free.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_RESHARE_PLATFORMS,
  PLATFORM_DELIVERY_MODE,
  normalizeResharePlatform,
  isReshareableResourceType,
  reshareDeliveryMode,
  reshareIdempotencyKey,
  buildResharePayload,
  buildShareIntentUrl,
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

describe('reshareDeliveryMode', () => {
  it('classifies webhook/API platforms as api', () => {
    expect(reshareDeliveryMode('discord')).toBe('api');
    expect(reshareDeliveryMode('slack')).toBe('api');
    expect(reshareDeliveryMode('webhook')).toBe('api');
  });

  it('classifies consumer platforms as user-completed share-intent', () => {
    expect(reshareDeliveryMode('twitter')).toBe('share-intent');
    expect(reshareDeliveryMode('mastodon')).toBe('share-intent');
  });

  it('declares a mode for every supported platform', () => {
    for (const p of SUPPORTED_RESHARE_PLATFORMS) {
      expect(PLATFORM_DELIVERY_MODE[p]).toBeDefined();
    }
  });
});

describe('buildShareIntentUrl', () => {
  it('builds a twitter intent URL carrying the text and backlink', () => {
    const url = buildShareIntentUrl('twitter', 'Hello', 'https://group.example/posts/r1');
    expect(url.startsWith('https://twitter.com/intent/tweet?')).toBe(true);
    expect(url).toContain('text=Hello');
    expect(url).toContain(encodeURIComponent('https://group.example/posts/r1'));
  });

  it('builds a mastodon share URL combining text + backlink', () => {
    const url = buildShareIntentUrl('mastodon', 'Hello', 'https://group.example/posts/r1');
    expect(url.startsWith('https://mastodon.social/share?')).toBe(true);
    expect(url).toContain(encodeURIComponent('https://group.example/posts/r1'));
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

  it('combines title and description and ALWAYS ends with the backlink url', () => {
    const payload = buildResharePayload('g1', 'discord', source);
    expect(payload.platform).toBe('discord');
    expect(payload.deliveryMode).toBe('api');
    expect(payload.title).toBe('Hand-carved spoons');
    expect(payload.body).toContain('Hand-carved spoons — A set of three locally crafted spoons.');
    // The mandatory clickable backlink is embedded at the END of the body.
    expect(payload.body.endsWith('https://group.example/marketplace/r1')).toBe(true);
    expect(payload.url).toBe('https://group.example/marketplace/r1');
    expect(payload.idempotencyKey).toBe('reshare:g1:discord:r1');
  });

  it('always includes the backlink even with no description', () => {
    const payload = buildResharePayload('g1', 'slack', { ...source, description: null });
    expect(payload.body).toContain('Hand-carved spoons');
    expect(payload.body.endsWith('https://group.example/marketplace/r1')).toBe(true);
  });

  it('THROWS when there is no canonical backlink url', () => {
    expect(() => buildResharePayload('g1', 'discord', { ...source, url: '' })).toThrow(
      /backlink/,
    );
    expect(() => buildResharePayload('g1', 'discord', { ...source, url: '   ' })).toThrow(
      /backlink/,
    );
  });

  it('clamps to the platform limit while PRESERVING the whole backlink', () => {
    const longDescription = 'x'.repeat(500);
    const payload = buildResharePayload('g1', 'twitter', {
      ...source,
      description: longDescription,
    });
    // twitter limit is 240
    expect(payload.body.length).toBeLessThanOrEqual(240);
    // The backlink is never truncated away — it remains intact at the end.
    expect(payload.body.endsWith('https://group.example/marketplace/r1')).toBe(true);
  });

  it('returns a share-intent URL for share-intent platforms only', () => {
    const tw = buildResharePayload('g1', 'twitter', source);
    expect(tw.deliveryMode).toBe('share-intent');
    expect(tw.shareIntentUrl).toBeDefined();
    expect(tw.shareIntentUrl).toContain('twitter.com/intent/tweet');

    const dc = buildResharePayload('g1', 'discord', source);
    expect(dc.deliveryMode).toBe('api');
    expect(dc.shareIntentUrl).toBeUndefined();
  });
});

describe('connectorCanDeliver', () => {
  it('webhook-style api platforms require a webhookUrl', () => {
    expect(connectorCanDeliver('discord', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('slack', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('webhook', { webhookUrl: 'https://x' })).toBe(true);
    expect(connectorCanDeliver('discord', {})).toBe(false);
    expect(connectorCanDeliver('slack', { webhookUrl: '' })).toBe(false);
  });

  it('NEVER server-delivers share-intent platforms, even with credentials', () => {
    // These are user-completed; the server must never silently push them.
    expect(connectorCanDeliver('twitter', { accessToken: 'tok' })).toBe(false);
    expect(connectorCanDeliver('mastodon', { accessToken: 'tok' })).toBe(false);
  });
});
