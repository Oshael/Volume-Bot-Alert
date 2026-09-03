const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  runRepair,
  __private,
} = require('../src/utils/repair-robinhood-v3-pruned-captures');

function options(overrides = {}) {
  return {
    mode: 'write', rpcUrl: 'http://127.0.0.1:18547',
    fromBlock: '100', toBlock: '200', batchSize: 2,
    rpcConcurrency: 1, maxBatches: 0, sleepMs: 0,
    ...overrides,
  };
}

function row(number) {
  return {
    transaction_hash: `0x${String(number).padStart(64, '0')}`,
    log_index: '1', block_number: String(number), block_hash: `0x${'a'.repeat(64)}`,
    transaction_index: '0', address: `0x${'b'.repeat(40)}`, topics: ['0xtopic'],
    data: '0x', protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:pool',
    registry_market_key: 'robinhood:uniswap-v3:pool',
    pool_address: `0x${'b'.repeat(40)}`, pool_id: null, origin_address: null,
    token_address: `0x${'c'.repeat(40)}`, quote_address: `0x${'d'.repeat(40)}`,
    currency0: `0x${'c'.repeat(40)}`, currency1: `0x${'d'.repeat(40)}`,
    fee: 3000, tick_spacing: 60, metadata: { quoteIndex: 1 },
  };
}

describe('targeted Robinhood V3 pruned-capture repair', () => {
  it('defaults to a bounded dry-run and validates write controls', () => {
    assert.deepEqual(__private.parseArgs([], {}), {
      mode: 'dry-run', rpcUrl: '', fromBlock: '0', toBlock: '9223372036854775807',
      batchSize: 100, rpcConcurrency: 2, maxBatches: 1, sleepMs: 100,
    });
    assert.throws(() => __private.parseArgs(['--batch-size=501'], {}), /between 1 and 500/);
    assert.throws(() => __private.parseArgs(['--rpc-concurrency=9'], {}), /between 1 and 8/);
    assert.throws(() => __private.parseArgs(['--mode=erase'], {}), /dry-run or write/);
  });

  it('commits observations before marking only the repaired captures complete', async () => {
    const calls = [];
    const batches = [[row(100), row(101)], []];
    const candidates = {
      summarize: async () => ({ candidates: '2', first_block: '100', last_block: '101' }),
      list: async () => batches.shift(),
      withLock: async (callback) => { calls.push('lock'); return callback(); },
      markRepaired: async (rows) => { calls.push(`mark:${rows.length}`); return rows.length; },
    };
    const entries = [
      { observation: { accepted: true } },
      { observation: { accepted: false } },
    ];
    const result = await runRepair(options(), {
      candidates,
      rpcClient: { request: async () => '0x1237' },
      enrichBatch: async () => { calls.push('archive'); return { entries, rpc: { batches: 1 } }; },
      persistence: {
        commitHeadProcessingBatch: async ({ entries: committed }) => {
          calls.push(`commit:${committed.length}`);
          return { insertedObservations: 1 };
        },
      },
    });

    assert.deepEqual(calls, ['lock', 'archive', 'commit:2', 'mark:2']);
    assert.deepEqual(
      [result.repaired, result.accepted, result.rejected, result.batches],
      [2, 1, 1, 1]
    );
  });

  it('never marks a capture when persistence fails', async () => {
    let marked = false;
    const candidates = {
      summarize: async () => ({ candidates: '1', first_block: '100', last_block: '100' }),
      list: async () => [row(100)],
      withLock: async (callback) => callback(),
      markRepaired: async () => { marked = true; },
    };
    await assert.rejects(runRepair(options({ maxBatches: 1 }), {
      candidates,
      rpcClient: { request: async () => '0x1237' },
      enrichBatch: async () => ({ entries: [{ observation: { accepted: true } }], rpc: {} }),
      persistence: { commitHeadProcessingBatch: async () => { throw new Error('db failed'); } },
    }), /db failed/);
    assert.equal(marked, false);
  });

  it('persists valid entries and dead-letters only non-retryable build failures', async () => {
    const calls = [];
    const good = row(100);
    const bad = row(101);
    const candidates = {
      summarize: async () => ({ candidates: '2', first_block: '100', last_block: '101' }),
      list: async () => (calls.includes('listed') ? [] : (calls.push('listed'), [good, bad])),
      withLock: async (callback) => callback(),
      markRepaired: async (rows) => { calls.push(`repaired:${rows.length}`); },
      markBlocked: async (failures) => { calls.push(`blocked:${failures.length}`); },
    };
    const entry = { observation: { accepted: true } };
    const result = await runRepair(options(), {
      candidates,
      rpcClient: { request: async () => '0x1237' },
      enrichBatch: async () => ({
        entries: [entry], repairedRows: [good],
        failures: [{ row: bad, error: new Error('tokenBalance is invalid') }],
        rpc: { batches: 1 },
      }),
      persistence: {
        commitHeadProcessingBatch: async ({ entries }) => {
          calls.push(`commit:${entries.length}`);
          return { insertedObservations: entries.length };
        },
      },
    });

    assert.deepEqual(calls, ['listed', 'commit:1', 'repaired:1', 'blocked:1']);
    assert.deepEqual(
      [result.repaired, result.blocked, result.accepted, result.batches,
        result.remaining, result.progressPct],
      [1, 1, 1, 1, 0, 100]
    );
    assert.equal(result.lastFailures[0].error, 'tokenBalance is invalid');
  });

  it('isolates a non-retryable entry build error without hiding retryable failures', async () => {
    const good = row(100);
    const bad = row(101);
    const prepared = [
      { id: 'good', row: good, context: { id: 'good' } },
      { id: 'bad', row: bad, context: { id: 'bad' } },
    ];
    const adapter = {
      buildEntry: async ({ context }) => {
        if (context.id === 'bad') throw new Error('tokenBalance is invalid');
        return { observation: { accepted: true } };
      },
    };
    const isolated = await __private.buildPreparedEntries(
      prepared, new Map([['good', {}], ['bad', {}]]), adapter, 2
    );

    assert.equal(isolated.entries.length, 1);
    assert.deepEqual(isolated.repairedRows, [good]);
    assert.equal(isolated.failures[0].row, bad);
    const retryable = Object.assign(new Error('archive timeout'), { retryable: true });
    await assert.rejects(__private.buildPreparedEntries(
      [prepared[0]], new Map([['good', {}]]),
      { buildEntry: async () => { throw retryable; } }, 1
    ), /archive timeout/);
  });

  it('persists archive dead letters and excludes them from future candidate scans', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('UPDATE robinhood_head_captures')) {
          return { rowCount: 1, rows: [{ transaction_hash: row(101).transaction_hash }] };
        }
        return { rows: [{ candidates: '0', first_block: null, last_block: null }] };
      },
    };
    const repository = __private.createCandidateRepository(database);
    await repository.markBlocked([{
      row: row(101), error: new Error('tokenBalance is invalid'),
    }]);
    await repository.summarize('100', '200');

    assert.match(calls[0].sql, /'status', 'blocked'/);
    assert.match(calls[0].sql, /V3 archive repair blocked/);
    assert.match(calls[1].sql, /archiveRepair,status/);
    assert.match(calls[1].sql, /<> 'blocked'/);
  });

  it('refuses to silently skip a capture whose pool registry entry is missing', () => {
    const candidate = row(100);
    candidate.registry_market_key = null;
    assert.throws(() => __private.poolSeeds([candidate]), /Pool registry missing/);
  });

  it('does not contact the archive or mutate data during dry-run', async () => {
    let touched = false;
    const result = await runRepair(options({ mode: 'dry-run' }), {
      candidates: {
        summarize: async () => ({ candidates: '266781', first_block: '51997980', last_block: '52789648' }),
        list: async () => { touched = true; },
      },
      rpcClient: { request: async () => { touched = true; } },
    });
    assert.equal(result.candidates, 266781);
    assert.equal(touched, false);
  });
});
