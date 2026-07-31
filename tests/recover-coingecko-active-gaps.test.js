const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const recovery = require('../src/utils/recover-coingecko-active-gaps');

const TOKEN_A = {
  address: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump',
  symbol: 'BIG',
  last_mcap: '200000',
  last_price: '0.0002',
};
const TOKEN_B = {
  address: 'Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump',
  symbol: 'SMALL',
  last_mcap: '100000',
  last_price: '0.0001',
};

describe('CoinGecko active-token gap recovery', () => {
  it('targets exactly the last 720 completed one-minute buckets', () => {
    const window = recovery.resolveWindow(new Date('2026-07-30T21:51:35.000Z'));

    assert.deepEqual(window, {
      from: '2026-07-30T09:51:00.000Z',
      to: '2026-07-30T21:50:00.000Z',
    });
    assert.equal((Date.parse(window.to) - Date.parse(window.from)) / 60000 + 1, 720);
  });

  it('selects only active eligible non-dormant unblocked Solana tokens by market cap', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [TOKEN_A] };
      },
    };

    const rows = await recovery.listActiveTokens({ limit: 10 }, database);

    assert.deepEqual(rows, [TOKEN_A]);
    assert.match(calls[0].sql, /tc\.chain = 'solana'/);
    assert.match(calls[0].sql, /tc\.eligible_for_monitoring = TRUE/);
    assert.match(calls[0].sql, /COALESCE\(tc\.last_mcap, 0\) >= \$1::numeric/);
    assert.match(calls[0].sql, /tc\.is_active_monitor_candidate = TRUE/);
    assert.match(calls[0].sql, /tc\.monitor_priority IN \('high', 'normal', 'low'\)/);
    assert.match(calls[0].sql, /NOT EXISTS[\s\S]*admin_blocked_tokens/);
    assert.match(calls[0].sql, /ORDER BY tc\.last_mcap DESC NULLS LAST/);
    assert.deepEqual(calls[0].params, [recovery.MIN_MARKET_CAP, 10]);
  });

  it('anchors market-cap conversion to the matching catalog price', () => {
    assert.equal(recovery.resolveMcapMultiplier(TOKEN_A), 1_000_000_000);
    assert.equal(recovery.resolveMcapMultiplier({ last_mcap: 100, last_price: null }), null);
  });

  it('fills each token right after auditing it, before touching the next token', async () => {
    const events = [];
    const preparedByAddress = new Map([
      [TOKEN_A.address, {
        plan: { token: { address: TOKEN_A.address } },
        buckets: [{ bucketTs: '2026-07-30T20:00:00.000Z' }],
        report: {
          address: TOKEN_A.address,
          marketCap: 200000,
          missingBuckets: 1,
          status: 'ready',
        },
      }],
      [TOKEN_B.address, {
        plan: { token: { address: TOKEN_B.address } },
        buckets: [],
        report: {
          address: TOKEN_B.address,
          marketCap: 100000,
          missingBuckets: 0,
          status: 'complete',
        },
      }],
    ]);
    const result = await recovery.runRecovery(
      { confirmFill: true, delayMs: 0 },
      {
        db: {},
        now: () => new Date('2026-07-30T21:51:35.000Z'),
        listActiveTokens: async () => [TOKEN_A, TOKEN_B],
        prepareToken: async (token) => {
          events.push(`fetch:${token.symbol}`);
          return preparedByAddress.get(token.address);
        },
        safeWrite: {
          executeFillMissing: async ({ plan }) => {
            events.push(`write:${plan.token.address === TOKEN_A.address ? 'BIG' : 'SMALL'}`);
            return { inserted: 1 };
          },
        },
        sleep: async () => {},
        logger: {
          log: (message) => {
            const payload = JSON.parse(message);
            if (payload.token) events.push(`log:${payload.token.status}`);
            else events.push(payload.report ? 'report' : 'restitution');
          },
        },
      }
    );

    assert.deepEqual(events, [
      'fetch:BIG',
      'write:BIG',
      'log:filled',
      'fetch:SMALL',
      'log:complete',
      'report',
      'restitution',
    ]);
    assert.equal(result.report.tokenCount, 2);
    assert.equal(result.report.missingBuckets, 1);
    assert.equal(result.restitution.insertedBuckets, 1);
    assert.equal(result.restitution.filledTokens, 1);
  });

  it('never writes without --confirm-fill', async () => {
    const result = await recovery.runRecovery(
      { confirmFill: false, delayMs: 0 },
      {
        db: {},
        now: () => new Date('2026-07-30T21:51:35.000Z'),
        listActiveTokens: async () => [TOKEN_A],
        prepareToken: async () => ({
          plan: { token: { address: TOKEN_A.address } },
          buckets: [{ bucketTs: '2026-07-30T20:00:00.000Z' }],
          report: { address: TOKEN_A.address, missingBuckets: 1, status: 'ready' },
        }),
        safeWrite: {
          executeFillMissing: async () => {
            throw new Error('dry-run must not write');
          },
        },
        sleep: async () => {},
        logger: { log: () => {} },
      }
    );

    assert.equal(result.restitution, null);
    assert.equal(result.report.missingBuckets, 1);
  });

  it('keeps recovering later tokens after one token fails to write', async () => {
    const written = [];
    const result = await recovery.runRecovery(
      { confirmFill: true, delayMs: 0 },
      {
        db: {},
        now: () => new Date('2026-07-30T21:51:35.000Z'),
        listActiveTokens: async () => [TOKEN_A, TOKEN_B],
        prepareToken: async (token) => ({
          plan: { token: { address: token.address } },
          buckets: [{ bucketTs: '2026-07-30T20:00:00.000Z' }],
          report: { address: token.address, missingBuckets: 1, status: 'ready' },
        }),
        safeWrite: {
          executeFillMissing: async ({ plan }) => {
            if (plan.token.address === TOKEN_A.address) throw new Error('deadlock');
            written.push(plan.token.address);
            return { inserted: 3 };
          },
        },
        sleep: async () => {},
        logger: { log: () => {} },
      }
    );

    assert.deepEqual(written, [TOKEN_B.address]);
    assert.equal(result.restitution.failedTokens, 1);
    assert.equal(result.restitution.filledTokens, 1);
    assert.equal(result.restitution.insertedBuckets, 3);
  });
});
