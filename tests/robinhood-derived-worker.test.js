const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-derived-worker');
const {
  createRobinhoodDerivedShadowAuditor,
} = require('../src/services/robinhood-derived-shadow-auditor');

const RESULT = { reclaimed: 1, claimed: 4, delivered: 3, retried: 1, blocked: 0 };

function fakeRunner() {
  const calls = { count: 0 };
  return { _calls: calls, runOnce: async () => { calls.count += 1; return RESULT; } };
}

function fakeRepo() {
  const calls = { prune: 0 };
  return { _calls: calls, pruneBlocked: async () => { calls.prune += 1; return 2; } };
}

function bucketPayload(overrides = {}) {
  return {
    type: 'market:bucket', chain: 'robinhood',
    address: '0x1111111111111111111111111111111111111111',
    bucketTs: '2026-07-13T00:00:00.000Z',
    ordering: { lastBlockNumber: '100', lastLogIndex: '7' },
    activity: { volumeUsd: '450.25', swaps: 3, buys: 2, sells: 1, transactions: 3 },
    valuation: { priceUsd: 0.12, fdvUsd: 120000, observedAt: '2026-07-13T00:00:20.000Z' },
    candle: {
      openPrice: 0.10, highPrice: 0.14, lowPrice: 0.09, closePrice: 0.12,
      openFdvUsd: 100000, highFdvUsd: 140000, lowFdvUsd: 90000,
      closeFdvUsd: 120000, sampleCount: 3,
    },
    ...overrides,
  };
}

function canonicalBucket(overrides = {}) {
  return {
    open_price_usd: '0.1', high_price_usd: '0.14', low_price_usd: '0.09',
    close_price_usd: '0.12', open_fdv_usd: '100000', high_fdv_usd: '140000',
    low_fdv_usd: '90000', close_fdv_usd: '120000', volume_usd: '450.2500',
    swaps: '3', buys: '2', sells: '1', transactions: '3',
    last_observed_at: new Date('2026-07-13T00:00:20.000Z'),
    last_block_number: '100', last_log_index: '7',
    ...overrides,
  };
}

describe('robinhood derived worker', () => {
  it('bounds its runtime options and honours the enabled flag', () => {
    const bounded = worker.__private.normalizeOptions({ intervalMs: 5, pruneIntervalMs: 10 });
    assert.equal(bounded.intervalMs, 50); // clamped up to the floor
    assert.equal(bounded.pruneIntervalMs, 30_000); // clamped up to the floor
    assert.equal(bounded.enabled, true);
    assert.equal(worker.__private.normalizeOptions({ enabled: false }).enabled, false);
    assert.equal(worker.__private.normalizeOptions({ shadowAuditOnly: true }).shadowAuditOnly, true);
  });

  // Runs first so the module-level prune clock is still at its initial zero.
  it('runs a tick, aggregates counts into status, and prunes when the window is due', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({});
    worker.__private.build(normalized, { runner: fakeRunner(), repository });

    const result = await worker.runOnce(normalized);

    assert.deepEqual(result, RESULT);
    const status = worker.getStatus();
    assert.equal(status.lastDelivered, 3);
    assert.equal(status.totalDelivered, 3);
    assert.equal(repository._calls.prune, 1);
    assert.equal(status.lastPrunedRows, 2);
  });

  it('does not prune again while still inside the retention window', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({ pruneIntervalMs: 3_600_000 });
    worker.__private.build(normalized, { runner: fakeRunner(), repository });

    await worker.runOnce(normalized);

    assert.equal(repository._calls.prune, 0);
  });

  it('ignores a notification on a foreign channel', () => {
    const before = worker.getStatus().totalNotifies;
    worker.__private.handleNotification({ channel: 'something_else' });
    assert.equal(worker.getStatus().totalNotifies, before);
  });

  it('uses only the shadow auditor as the outbox sink in audit-only mode', async () => {
    let audits = 0;
    let deliveries = 0;
    let claimed = false;
    const repository = {
      reclaimExpiredLeases: async () => 0,
      claimOutbox: async () => {
        if (claimed) return [];
        claimed = true;
        return [{ id: 1, attemptCount: 1, payload: bucketPayload() }];
      },
      settleOutbox: async ({ delivered, retry }) => ({
        delivered: delivered.length, retried: retry.length, blocked: 0,
      }),
      pruneBlocked: async () => 0,
    };
    const normalized = worker.__private.normalizeOptions({ shadowAuditOnly: true });
    worker.__private.build(normalized, {
      repository,
      shadowAuditor: {
        consume: async () => { audits += 1; },
        getStatus: () => ({ matched: audits }),
      },
      fanout: async () => { deliveries += 1; },
    });

    const result = await worker.runOnce(normalized);

    assert.equal(result.delivered, 1);
    assert.equal(audits, 1);
    assert.equal(deliveries, 0);
    assert.equal(worker.getStatus().mode, 'shadow-audit-only');
    assert.equal(worker.getStatus().shadowAudit.matched, 1);
  });
});

describe('robinhood derived shadow auditor', () => {
  it('matches equivalent canonical numerics and uses the bounded query timeout', async () => {
    const calls = [];
    const auditor = createRobinhoodDerivedShadowAuditor({
      database: {
        query: async () => ({ rows: [] }),
        queryWithStatementTimeout: async (sql, params, timeout) => {
          calls.push({ sql, params, timeout });
          return { rows: [canonicalBucket({ close_price_usd: '0.0000001' })] };
        },
      },
      statementTimeoutMs: 1,
    });

    const payload = bucketPayload({
      valuation: { priceUsd: 1e-7, fdvUsd: 120000, observedAt: '2026-07-13T00:00:20.000Z' },
      candle: { ...bucketPayload().candle, closePrice: 1e-7 },
    });
    const result = await auditor.consume(payload);

    assert.equal(result.outcome, 'matched');
    assert.equal(calls[0].timeout, 100);
    assert.equal(auditor.getStatus().matched, 1);
  });

  it('classifies a newer canonical bucket as superseded instead of divergent', async () => {
    const auditor = createRobinhoodDerivedShadowAuditor({
      database: { query: async () => ({ rows: [canonicalBucket({ last_log_index: '8' })] }) },
    });

    const result = await auditor.consume(bucketPayload());

    assert.equal(result.outcome, 'superseded');
    assert.equal(auditor.getStatus().mismatched, 0);
  });

  it('throws query failures so the durable outbox row is retried', async () => {
    const auditor = createRobinhoodDerivedShadowAuditor({
      database: { query: async () => { throw new Error('audit timeout'); } },
    });

    await assert.rejects(auditor.consume(bucketPayload()), /audit timeout/);
    assert.equal(auditor.getStatus().errors, 1);
  });
});
