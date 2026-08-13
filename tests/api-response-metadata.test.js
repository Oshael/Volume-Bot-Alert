const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let readApiResponseMetadata;
let shouldEmitApiResponseDebug;

before(async () => {
  ({ readApiResponseMetadata, shouldEmitApiResponseDebug } = await import('../frontend/src/services/api/response-metadata.ts'));
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
      'Server-Timing': 'total;dur=120, query;dur=95, build;dur=5',
      'X-Perf-Label': 'catalog.sparklines',
      'X-Perf-Response-Bytes': '2048',
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
      serverTiming: 'total;dur=120, query;dur=95, build;dur=5',
      perfLabel: 'catalog.sparklines',
      perfResponseBytes: '2048',
    });
  });

  it('emits debug metadata only for failures, retry hints, or rate-limit headers', () => {
    assert.equal(shouldEmitApiResponseDebug({
      status: 200,
      ok: true,
      rateLimit: null,
      rateLimitPolicy: null,
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfter: null,
      serverTiming: null,
      perfLabel: null,
      perfResponseBytes: null,
    }), false);

    assert.equal(shouldEmitApiResponseDebug({
      status: 429,
      ok: false,
      rateLimit: null,
      rateLimitPolicy: null,
      rateLimitLimit: null,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfter: null,
      serverTiming: null,
      perfLabel: null,
      perfResponseBytes: null,
    }), true);

    assert.equal(shouldEmitApiResponseDebug({
      status: 200,
      ok: true,
      rateLimit: null,
      rateLimitPolicy: null,
      rateLimitLimit: null,
      rateLimitRemaining: '585',
      rateLimitReset: null,
      retryAfter: null,
      serverTiming: null,
      perfLabel: null,
      perfResponseBytes: null,
    }), true);
  });
});
