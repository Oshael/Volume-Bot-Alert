'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detachCdpSession } = require('../src/services/fomo-cdp-session');

test('Fomo CDP cleanup bounds a detach that never settles', async () => {
  let timeoutCallback;
  const resultPromise = detachCdpSession({ detach: async () => new Promise(() => {}) }, {
    timeoutMs: 5_000,
    schedule: (callback) => { timeoutCallback = callback; return 1; },
    cancelSchedule: () => {},
  });

  await Promise.resolve();
  timeoutCallback();
  assert.deepEqual(await resultPromise, {
    ok: false,
    timedOut: true,
    errorCode: 'FOMO_BROWSER_DETACH_TIMEOUT',
  });
});

test('Fomo CDP cleanup converts detach rejection to a safe result', async () => {
  const result = await detachCdpSession({
    detach: async () => { throw Object.assign(new Error('raw CDP failure'), { code: 'TARGET_GONE' }); },
  });

  assert.deepEqual(result, { ok: false, timedOut: false, errorCode: 'TARGET_GONE' });
});
