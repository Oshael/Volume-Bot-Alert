const { before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let ApiRateLimitBackoffError;
let clearApiRateLimitBackoff;
let getApiRateLimitBackoffRemainingMs;
let getApiRateLimitResponseBackoffMs;
let isApiRateLimitBackoffError;
let noteApiRateLimitResponse;

before(async () => {
  ({
    ApiRateLimitBackoffError,
    clearApiRateLimitBackoff,
    getApiRateLimitBackoffRemainingMs,
    getApiRateLimitResponseBackoffMs,
    isApiRateLimitBackoffError,
    noteApiRateLimitResponse,
  } = await import('../frontend/src/services/api/rate-limit-backoff.ts'));
});

beforeEach(() => {
  clearApiRateLimitBackoff();
});

function metadata(overrides = {}) {
  return {
    status: 200,
    ok: true,
    rateLimit: null,
    rateLimitPolicy: null,
    rateLimitLimit: null,
    rateLimitRemaining: null,
    rateLimitReset: null,
    retryAfter: null,
    ...overrides,
  };
}

describe('API rate-limit backoff', () => {
  it('uses Retry-After seconds as the dashboard backoff window', () => {
    const now = 1_000;
    const backoffMs = noteApiRateLimitResponse('dashboard', metadata({
      status: 429,
      ok: false,
      retryAfter: '42',
    }), now);

    assert.equal(backoffMs, 42_000);
    assert.equal(getApiRateLimitBackoffRemainingMs('dashboard', now + 10_000), 32_000);
    assert.equal(getApiRateLimitBackoffRemainingMs('dashboard', now + 42_000), 0);
  });

  it('uses RateLimit-Reset when remaining budget reaches zero', () => {
    const now = 1_000;
    assert.equal(getApiRateLimitResponseBackoffMs(metadata({
      status: 200,
      rateLimitRemaining: '0',
      rateLimitReset: '15',
    }), now), 15_000);
  });

  it('does not back off while remaining budget is still positive', () => {
    assert.equal(getApiRateLimitResponseBackoffMs(metadata({
      status: 200,
      rateLimitRemaining: '1',
      rateLimitReset: '15',
    }), 1_000), 0);
  });

  it('identifies typed rate-limit backoff errors', () => {
    const error = new ApiRateLimitBackoffError('dashboard', 12_000);

    assert.equal(isApiRateLimitBackoffError(error), true);
    assert.equal(error.scope, 'dashboard');
    assert.equal(error.retryAfterMs, 12_000);
  });
});
