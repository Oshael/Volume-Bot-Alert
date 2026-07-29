const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodBackfillFinalizer,
  __private: { planAdvancement, telemetry },
} = require('../src/services/robinhood-backfill-finalizer');

function range(fromBlock, toBlock, overrides = {}) {
  return {
    id: overrides.id || String(fromBlock),
    from_block: String(fromBlock),
    to_block: String(toBlock),
    status: overrides.status || 'captured',
    tracked_log_count: overrides.tracked ?? 1,
    staging_count: overrides.staged ?? overrides.tracked ?? 1,
    terminal_count: overrides.terminal ?? overrides.staged ?? overrides.tracked ?? 1,
    blocked_count: overrides.blocked ?? 0,
    checkpoint_block: String(toBlock),
    checkpoint_hash: `0x${String(toBlock).padStart(64, '0')}`,
    checkpoint_timestamp: new Date(Number(toBlock) * 1000),
  };
}

function plan(ranges, overrides = {}) {
  return planAdvancement({
    nextBlock: overrides.nextBlock || '100',
    marketScanNextBlock: overrides.marketScanNextBlock || '300',
    ranges,
    limit: overrides.limit || 100,
  });
}

function watermark(name, nextBlock, overrides = {}) {
  return {
    frontier: name,
    next_block: String(nextBlock),
    checkpoint_block: overrides.checkpointBlock ?? null,
    checkpoint_hash: overrides.checkpointHash ?? null,
    checkpoint_timestamp: overrides.checkpointTimestamp ?? null,
    last_range_id: overrides.lastRangeId ?? null,
    version: String(overrides.version || 0),
  };
}

describe('Robinhood backfill finalizer', () => {
  it('advances contiguous complete ranges including an empty range', () => {
    const result = plan([
      range(100, 199, { tracked: 0, staged: 0, terminal: 0 }),
      range(200, 299),
    ]);

    assert.equal(result.nextBlock, '300');
    assert.equal(result.advancedBlocks, '200');
    assert.equal(result.advancedRanges, 2);
    assert.equal(result.caughtUp, true);
    assert.equal(result.blocker, null);
    assert.equal(result.lastRange.id, '200');
  });

  it('does not skip an out-of-order manifest or a missing range', () => {
    const outOfOrder = plan([range(200, 299)]);
    const missing = plan([], { marketScanNextBlock: '200' });

    assert.equal(outOfOrder.nextBlock, '100');
    assert.equal(outOfOrder.blocker.reason, 'manifest_gap');
    assert.equal(outOfOrder.blocker.rangeFromBlock, '200');
    assert.equal(missing.blocker.reason, 'manifest_gap');
    assert.equal(missing.blocker.expectedBlock, '100');
  });

  it('distinguishes pending work from a blocked dead letter', () => {
    const pending = plan([
      range(100, 199, { tracked: 2, staged: 2, terminal: 1 }),
    ]);
    const blocked = plan([
      range(100, 199, { tracked: 2, staged: 2, terminal: 1, blocked: 1 }),
    ]);

    assert.equal(pending.blocker.reason, 'enrichment_pending');
    assert.equal(blocked.blocker.reason, 'dead_letter');
    assert.equal(pending.nextBlock, '100');
    assert.equal(blocked.nextBlock, '100');
  });

  it('fails closed when captured counts cannot reconcile', () => {
    const result = plan([
      range(100, 199, { tracked: 2, staged: 1, terminal: 1 }),
    ]);
    const incomplete = plan([{
      ...range(100, 199),
      checkpoint_timestamp: null,
    }]);

    assert.equal(result.blocker.reason, 'staging_count_mismatch');
    assert.equal(incomplete.blocker.reason, 'manifest_incomplete');
    assert.equal(result.advancedRanges, 0);
  });

  it('resumes from the same frontier after the blocking item becomes terminal', () => {
    const blocked = plan([
      range(100, 199, { tracked: 1, staged: 1, terminal: 0, blocked: 1 }),
    ]);
    const resumed = plan([
      range(100, 199, { tracked: 1, staged: 1, terminal: 1, blocked: 0 }),
      range(200, 299),
    ]);

    assert.equal(blocked.nextBlock, '100');
    assert.equal(resumed.nextBlock, '300');
    assert.equal(resumed.advancedRanges, 2);
  });

  it('reports frontier lag and ETA only after a positive rate sample', () => {
    const state = { sampleAt: null, nextBlock: null, blocksPerSecond: null };
    const frontiers = new Map([
      ['discovery_scan', {
        name: 'discovery_scan', nextBlock: '500',
      }],
      ['market_scan', {
        name: 'market_scan', nextBlock: '400',
      }],
      ['market_enriched', {
        name: 'market_enriched', nextBlock: '100',
      }],
    ]);
    const first = telemetry(state, frontiers, 1000);
    frontiers.get('market_enriched').nextBlock = '200';
    const second = telemetry(state, frontiers, 3000);

    assert.deepEqual(first.lagBlocks, {
      discoveryToMarket: 100,
      marketToEnriched: 300,
    });
    assert.equal(first.etaSeconds, null);
    assert.equal(second.blocksPerSecond, 50);
    assert.equal(second.etaSeconds, 4);
  });

  it('locks, initializes and advances market_enriched atomically', async () => {
    const queries = [];
    const rows = [
      watermark('discovery_scan', 300),
      watermark('market_scan', 200),
    ];
    const client = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
        if (String(sql).startsWith('SET LOCAL ')) return { rows: [], rowCount: 0 };
        if (String(sql).includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
        if (String(sql).includes('FOR UPDATE')) return { rows, rowCount: rows.length };
        if (String(sql).includes('MIN(from_block)')) {
          return { rows: [{ start_block: '100' }], rowCount: 1 };
        }
        if (String(sql).startsWith('INSERT INTO robinhood_backfill_watermarks')) {
          return { rows: [watermark('market_enriched', 100)], rowCount: 1 };
        }
        if (String(sql).includes('COUNT(staging.transaction_hash)')) {
          return { rows: [range(100, 199)], rowCount: 1 };
        }
        if (String(sql).startsWith('UPDATE robinhood_backfill_watermarks')) {
          return {
            rows: [watermark('market_enriched', 200, {
              checkpointBlock: '199',
              checkpointHash: range(100, 199).checkpoint_hash,
              lastRangeId: '100',
              version: 1,
            })],
            rowCount: 1,
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {
        queries.push({ sql: 'RELEASE' });
      },
    };
    const finalizer = createRobinhoodBackfillFinalizer({
      database: { getClient: async () => client },
      now: () => Date.parse('2026-07-24T12:00:00Z'),
    });
    const result = await finalizer.runOnce({
      statementTimeoutMs: 12_345,
      lockTimeoutMs: 2345,
    });

    assert.equal(result.status, 'caught_up');
    assert.equal(result.advancedBlocks, '100');
    assert.equal(result.frontiers.marketEnriched.nextBlock, '200');
    assert.deepEqual(
      queries.filter(({ sql }) => sql.startsWith('SET LOCAL '))
        .map(({ sql }) => sql),
      [
        "SET LOCAL statement_timeout = '12345ms'",
        "SET LOCAL lock_timeout = '2345ms'",
      ]
    );
    assert.deepEqual(
      queries.filter(({ sql }) => ['BEGIN', 'COMMIT', 'RELEASE'].includes(sql))
        .map(({ sql }) => sql),
      ['BEGIN', 'COMMIT', 'RELEASE']
    );
  });
});
