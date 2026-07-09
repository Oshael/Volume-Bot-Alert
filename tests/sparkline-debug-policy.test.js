const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let evaluateSparklineDebugEvent;

before(async () => {
  ({ evaluateSparklineDebugEvent } = await import('../frontend/src/state/sparkline-debug-policy.ts'));
});

describe('sparkline debug policy', () => {
  const baseOptions = {
    now: 1_000,
    captureUntil: 0,
    lowRemainingThreshold: 80,
  };

  it('does not persist routine cache-hit events while armed', () => {
    assert.deepEqual(
      evaluateSparklineDebugEvent('metadata.cache-hit', {}, baseOptions),
      { persist: false, trigger: false },
    );
  });

  it('triggers capture on HTTP failures and retry hints', () => {
    assert.deepEqual(
      evaluateSparklineDebugEvent('http.response', { response: { status: 429 } }, baseOptions),
      { persist: true, trigger: true, reason: 'http-429' },
    );
    assert.deepEqual(
      evaluateSparklineDebugEvent('http.response', { response: { status: 200, retryAfter: '12' } }, baseOptions),
      { persist: true, trigger: true, reason: 'retry-after' },
    );
  });

  it('triggers capture before exhaustion when remaining budget is low', () => {
    assert.deepEqual(
      evaluateSparklineDebugEvent('http.response', {
        response: { status: 200, rateLimitRemaining: '80' },
      }, baseOptions),
      { persist: true, trigger: true, reason: 'rate-limit-low' },
    );
  });

  it('persists routine events only during an active capture window', () => {
    assert.deepEqual(
      evaluateSparklineDebugEvent('metadata.cache-hit', {}, { ...baseOptions, captureUntil: 2_000 }),
      { persist: true, trigger: false },
    );
  });
});
