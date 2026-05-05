const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const schedulerModule = require('../src/services/gmgn-discovery-scheduler');
const gmgn = require('../src/services/gmgn-client');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('gmgn discovery scheduler', () => {
  it('plans five volume trending requests across a two-second window', () => {
    const plan = schedulerModule.__private.buildTrendingRequestPlan({
      chain: 'sol',
      requestsPerWindow: 5,
      requestWindowMs: 2000,
      trendingLimit: 30,
      intervals: ['1m', '5m', '1h', '6h', '24h'],
    });

    assert.deepEqual(plan, [
      { chain: 'sol', interval: '1m', limit: 30, offsetMs: 0 },
      { chain: 'sol', interval: '5m', limit: 30, offsetMs: 400 },
      { chain: 'sol', interval: '1h', limit: 30, offsetMs: 800 },
      { chain: 'sol', interval: '6h', limit: 30, offsetMs: 1200 },
      { chain: 'sol', interval: '24h', limit: 30, offsetMs: 1600 },
    ]);
  });

  it('de-dupes normalized tokens by address while merging interval fields', () => {
    const tokens = schedulerModule.__private.dedupeTrendingTokens([
      { address: TOKEN_A, gmgnInterval: '1m', vol1m: 100 },
      { address: TOKEN_B, gmgnInterval: '1m' },
      { address: TOKEN_A, gmgnInterval: '5m', vol5m: 500 },
    ]);

    assert.deepEqual(tokens, [
      { address: TOKEN_A, gmgnInterval: '1m', vol1m: 100, gmgnIntervals: ['1m', '5m'], vol5m: 500 },
      { address: TOKEN_B, gmgnInterval: '1m', gmgnIntervals: ['1m'] },
    ]);
  });

  it('runs one scheduled cycle with five spaced requests and de-duped output', async () => {
    const calls = [];
    const sleeps = [];
    const scheduler = schedulerModule.createGmgnDiscoveryScheduler({
      chain: 'sol',
      requestsPerWindow: 5,
      requestWindowMs: 2000,
      trendingLimit: 30,
      sleepImpl: async (ms) => sleeps.push(ms),
      client: {
        fetchTrending: async (request) => {
          calls.push(request);
          return [
            { address: TOKEN_A, gmgnInterval: request.interval },
            { address: `${TOKEN_B}${request.interval}`.slice(0, TOKEN_B.length), gmgnInterval: request.interval },
          ];
        },
      },
    });

    const result = await scheduler.runOnce();

    assert.equal(result.skipped, false);
    assert.equal(result.rateLimited, false);
    assert.equal(result.requests, 5);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((call) => call.interval), ['1m', '5m', '1h', '6h', '24h']);
    assert.deepEqual(sleeps, [400, 400, 400, 400]);
    assert.equal(result.tokens.length, 10);
    assert.equal(result.uniqueTokens.length, 2);
    assert.equal(result.uniqueTokens[0].gmgnInterval, '1m');
    assert.deepEqual(result.uniqueTokens[0].gmgnIntervals, ['1m', '5m', '1h', '6h', '24h']);
  });

  it('backs off on GMGN rate limits without throwing', async () => {
    let now = 100000;
    const errors = [];
    const scheduler = schedulerModule.createGmgnDiscoveryScheduler({
      now: () => now,
      sleepImpl: async () => {},
      backoffMinMs: 5000,
      backoffMaxMs: 60000,
      client: {
        fetchTrending: async () => {
          const error = new gmgn.GmgnRateLimitError('limited', { resetAt: 105 });
          errors.push(error);
          throw error;
        },
      },
    });

    const first = await scheduler.runOnce();
    const second = await scheduler.runOnce();

    assert.equal(errors.length, 1);
    assert.equal(first.rateLimited, true);
    assert.equal(first.errors.length, 1);
    assert.equal(first.backoffRemainingMs, 5000);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'gmgn-backoff');
    assert.equal(second.backoffRemainingMs, 5000);

    now = 105001;
    const third = await scheduler.runOnce();
    assert.equal(third.rateLimited, true);
    assert.equal(errors.length, 2);
  });
});
