const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let readApiResponseMetadata;

before(async () => {
  ({ readApiResponseMetadata } = await import('../frontend/src/services/api/response-metadata.ts'));
});

describe('API response metadata', () => {
  it('captures standard rate-limit and retry headers', () => {
    const headers = new Headers({
      RateLimit: '"catalog-read";r=17;t=42',
      'RateLimit-Policy': '"catalog-read";q=600;w=900',
      'RateLimit-Limit': '600',
      'RateLimit-Remaining': '17',
      'RateLimit-Reset': '42',
      'Retry-After': '42',
    });

    assert.deepEqual(readApiResponseMetadata({ status: 429, ok: false, headers }), {
      status: 429,
      ok: false,
      rateLimit: '"catalog-read";r=17;t=42',
      rateLimitPolicy: '"catalog-read";q=600;w=900',
      rateLimitLimit: '600',
      rateLimitRemaining: '17',
      rateLimitReset: '42',
      retryAfter: '42',
    });
  });
});
