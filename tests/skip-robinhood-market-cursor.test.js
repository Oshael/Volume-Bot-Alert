const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CONFIRM_FLAG,
  assertSkipIsSafe,
  inspectMarketSkip,
  main,
  resolveTargetBlock,
  skipMarketCursor,
} = require('../src/utils/skip-robinhood-market-cursor');

function safeRow(overrides = {}) {
  return {
    live_worker: false,
    market_next_block: '1081041',
    market_version: '412',
    discovery_next_block: '18324464',
    pools: 3853,
    ...overrides,
  };
}

describe('Robinhood market cursor skip', () => {
  it('builds a dry-run plan without mutating cursor state', async () => {
    let calls = 0;
    const database = { query: async () => { calls += 1; return { rows: [safeRow()] }; } };
    const plan = await inspectMarketSkip(database);

    assert.equal(calls, 1);
    assert.deepEqual(plan, {
      liveWorker: false,
      marketNextBlock: '1081041',
      marketVersion: '412',
      discoveryNextBlock: '18324464',
      pools: 3853,
    });
  });

  it('defaults the target to the discovery cursor and bounds explicit targets', () => {
    const plan = {
      marketNextBlock: '1081041',
      discoveryNextBlock: '18324464',
    };
    assert.equal(resolveTargetBlock(plan), 18324464n);
    assert.equal(resolveTargetBlock(plan, '6113362'), 6113362n);
    assert.throws(() => resolveTargetBlock(plan, '18324465'), /pass the discovery cursor/);
    assert.throws(() => resolveTargetBlock(plan, '1081041'), /does not advance/);
    assert.throws(() => resolveTargetBlock(plan, '981041'), /does not advance/);
    assert.throws(() => resolveTargetBlock(plan, 'abc'), /non-negative integer/);
    assert.throws(
      () => resolveTargetBlock({ ...plan, marketNextBlock: null }),
      /market cursor is absent/
    );
    assert.throws(
      () => resolveTargetBlock({ ...plan, discoveryNextBlock: null }),
      /discovery cursor is absent/
    );
  });

  it('refuses active workers and an empty pool registry', () => {
    assert.throws(() => assertSkipIsSafe({ liveWorker: true, pools: 10 }), /still active/);
    assert.throws(() => assertSkipIsSafe({ liveWorker: false, pools: 0 }), /registry is empty/);
    assert.doesNotThrow(() => assertSkipIsSafe({ liveWorker: false, pools: 10 }));
  });

  it('skips only after transactional preflight and clears checkpoint and coverage', async () => {
    const statements = [];
    const client = {
      query: async (sql, params) => {
        statements.push({ sql, params });
        if (sql.includes('AS live_worker')) return { rows: [safeRow()] };
        if (sql.includes('UPDATE robinhood_ingestion_cursors')) {
          assert.deepEqual(params, ['18324464']);
          return { rows: [{ next_block: '18324464', version: '413' }] };
        }
        return { rows: [] };
      },
      release() { statements.push({ sql: 'RELEASE' }); },
    };
    const result = await skipMarketCursor({ getClient: async () => client });

    assert.equal(result.skip.targetBlock, '18324464');
    assert.equal(result.skip.cursor.next_block, '18324464');
    const sqls = statements.map((entry) => entry.sql);
    assert.deepEqual(sqls.slice(0, 2), ['BEGIN', "SET LOCAL statement_timeout = '30s'"]);
    assert.equal(sqls[3].includes('FOR UPDATE'), true);
    const update = statements.find(
      (entry) => entry.sql.includes('UPDATE robinhood_ingestion_cursors')
    );
    assert.equal(update.sql.includes('checkpoint_hash = NULL'), true);
    assert.equal(update.sql.includes('safe_head = NULL'), true);
    assert.equal(update.sql.includes('coverage_start_block = NULL'), true);
    assert.equal(update.sql.includes('coverage_start_timestamp = NULL'), true);
    assert.deepEqual(sqls.slice(-2), ['COMMIT', 'RELEASE']);
  });

  it('rolls back when the preflight rejects an active lease', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('AS live_worker')) return { rows: [safeRow({ live_worker: true })] };
        return { rows: [] };
      },
      release() { statements.push('RELEASE'); },
    };

    await assert.rejects(
      skipMarketCursor({ getClient: async () => client }),
      /still active/
    );
    assert.equal(statements.some((sql) => sql === 'ROLLBACK'), true);
    assert.equal(statements.includes('COMMIT'), false);
  });

  it('dry-run resolves the target without opening a transaction', async () => {
    const statements = [];
    const database = {
      query: async (sql) => { statements.push(sql); return { rows: [safeRow()] }; },
      getClient: async () => { throw new Error('dry-run must not open a client'); },
    };
    const result = await main([], database);

    assert.equal(result.skip.targetBlock, '18324464');
    assert.equal(result.skip.cursor, null);
    assert.equal(statements.length, 1);
  });

  it('dry-run still reports the plan while the live worker holds its lease', async () => {
    const database = {
      query: async () => ({ rows: [safeRow({ live_worker: true })] }),
      getClient: async () => { throw new Error('dry-run must not open a client'); },
    };
    const result = await main([], database);

    assert.equal(result.liveWorker, true);
    assert.equal(result.skip.targetBlock, '18324464');
    assert.equal(result.skip.cursor, null);
  });

  it('passes an explicit target through the confirmed path', async () => {
    const client = {
      query: async (sql, params) => {
        if (sql.includes('AS live_worker')) return { rows: [safeRow()] };
        if (sql.includes('UPDATE robinhood_ingestion_cursors')) {
          assert.deepEqual(params, ['6113362']);
          return { rows: [{ next_block: '6113362', version: '413' }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const result = await main(
      [CONFIRM_FLAG, '--target-block=6113362'],
      { getClient: async () => client }
    );
    assert.equal(result.skip.cursor.next_block, '6113362');
  });
});
