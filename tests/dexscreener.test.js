const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const dexscreener = require('../src/services/dexscreener');

describe('dexscreener rate-limit helpers', () => {
  beforeEach(() => {
    dexscreener.__private.resetRateLimitState();
  });

  it('parses Retry-After seconds responses', () => {
    assert.equal(dexscreener.__private.parseRetryAfterMs('12'), 12000);
  });

  it('parses Retry-After HTTP dates', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const retryAt = new Date(now + 30000).toUTCString();
    assert.equal(dexscreener.__private.parseRetryAfterMs(retryAt, now), 30000);
  });

  it('uses Retry-After directly when the upstream provides it', () => {
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(45000, 3, 0.4), 45000);
  });

  it('falls back to exponential backoff with jitter when Retry-After is absent', () => {
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(null, 1, 0), 5000);
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(null, 3, 0), 20000);
  });

  it('preserves batch delay when options are passed as an object', () => {
    const resolved = dexscreener.__private.resolveBatchOptions({
      chain: 'solana',
      delayMs: 175,
      priorityByAddress: new Map(),
    });

    assert.equal(resolved.delayMs, 175);
    assert.equal(resolved.options.chain, 'solana');
    assert.equal(resolved.options.priorityByAddress instanceof Map, true);
    assert.equal(Object.prototype.hasOwnProperty.call(resolved.options, 'delayMs'), false);
  });

  it('activates global cooldown only after the 10th consecutive 429', () => {
    const response = { headers: { get: () => null } };

    for (let index = 0; index < 9; index += 1) {
      const result = dexscreener.__private.noteRateLimit(response, `batch-${index}`);
      assert.equal(result.activatedCooldown, false);
    }

    assert.equal(dexscreener.getThrottleState().mode, 'normal');

    const activation = dexscreener.__private.noteRateLimit(response, 'batch-10');
    assert.equal(activation.activatedCooldown, true);
    assert.equal(dexscreener.getThrottleState().mode, 'cooldown');
  });

  it('walks recovery phases after cooldown ends', () => {
    const response = { headers: { get: () => null } };

    for (let index = 0; index < 10; index += 1) {
      dexscreener.__private.noteRateLimit(response, `batch-${index}`);
    }

    dexscreener.__private.getThrottleState(Date.now() + (11 * 60 * 1000));
    assert.equal(dexscreener.getThrottleState().mode, 'recovery');
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'high-manual');

    for (let index = 0; index < 5; index += 1) {
      dexscreener.__private.completeRecoveryCycle();
    }
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'normal');

    for (let index = 0; index < 5; index += 1) {
      dexscreener.__private.completeRecoveryCycle();
    }
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'low-near');
  });
});
