const assert = require('node:assert/strict');
const { it } = require('node:test');

const {
  createRobinhoodHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing');
const stage186 = require('../src/utils/db-init-stage186');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function explainPlan(...indexNames) {
  return { rows: [{ 'QUERY PLAN': [{
    Plan: { Plans: indexNames.map((name) => ({ 'Index Name': name })) },
  }] }] };
}

it('uses bounded locked branches for the market claim', async () => {
  const calls = [];
  const repository = createRobinhoodHeadProcessingRepository({
    database: { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('EXPLAIN')) {
        return explainPlan('idx_rh_head_captures_v4_active_frontier');
      }
      return { rows: [] };
    } },
  });

  await repository.claimCaptures({
    owner: 'worker-a', limit: 2000, leaseMs: 60_000, stream: 'market',
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /^EXPLAIN \(FORMAT JSON\)/);
  assert.deepEqual(calls[1].params, ['worker-a', 2000, 60_000]);
  assert.match(calls[1].sql, /WITH RECURSIVE first_v4_by_pool/);
  assert.match(calls[1].sql, /CROSS JOIN LATERAL/);
  assert.match(calls[1].sql, /v4_claimable AS MATERIALIZED/);
  assert.match(calls[1].sql, /independent_claimable AS MATERIALIZED/);
  assert.equal((calls[1].sql.match(/FOR UPDATE OF capture SKIP LOCKED/g) || []).length, 2);
  assert.doesNotMatch(calls[1].sql, /LEFT JOIN first_v4_by_pool/);
  assert.doesNotMatch(calls[1].sql, /DISTINCT ON \(market_key\)/);
});

it('refreshes stale statistics before a large V4 claim can use the wrong plan', async () => {
  const calls = [];
  const clientCalls = [];
  let explains = 0;
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('EXPLAIN')) {
        explains += 1;
        return explains === 1
          ? explainPlan('idx_robinhood_head_captures_processing_frontier')
          : explainPlan('idx_rh_head_captures_v4_active_frontier');
      }
      if (sql.includes('COUNT(*)::int AS active')) {
        return { rows: [{ active: 1000 }] };
      }
      return { rows: [] };
    },
    async getClient() {
      return {
        async query(sql) { clientCalls.push(sql); return { rows: [] }; },
        release() { clientCalls.push('release'); },
      };
    },
  };
  const warnings = [];
  const repository = createRobinhoodHeadProcessingRepository({
    database, logger: { warn: (message) => warnings.push(message) },
  });

  await repository.claimCaptures({
    owner: 'worker-a', limit: 2000, leaseMs: 60_000, stream: 'market',
  });

  assert.equal(explains, 2);
  assert.deepEqual(clientCalls.slice(0, 3), [
    'BEGIN', "SET LOCAL lock_timeout = '1s'", "SET LOCAL statement_timeout = '60s'",
  ]);
  assert.match(clientCalls[3], /^ANALYZE robinhood_head_captures/);
  assert.deepEqual(clientCalls.slice(4), ['COMMIT', 'release']);
  assert.equal(warnings.length, 1);
  assert.match(calls.at(-1).sql, /^WITH RECURSIVE first_v4_by_pool/);
});

it('fails closed when fresh statistics still produce an unsafe V4 claim plan', async () => {
  const calls = [];
  const database = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('EXPLAIN')) {
        return explainPlan('idx_robinhood_head_captures_processing_frontier');
      }
      if (sql.includes('COUNT(*)::int AS active')) return { rows: [{ active: 1000 }] };
      return { rows: [] };
    },
    async getClient() {
      return {
        async query() { return { rows: [] }; },
        release() {},
      };
    },
  };
  const repository = createRobinhoodHeadProcessingRepository({
    database, logger: { warn() {} },
  });

  await assert.rejects(
    repository.claimCaptures({
      owner: 'worker-a', limit: 2000, leaseMs: 60_000, stream: 'market',
    }),
    { code: 'robinhood_market_claim_plan_unsafe' }
  );
  assert.equal(calls.filter((sql) => sql.startsWith('WITH RECURSIVE')).length, 0);
});

it('seeks one indexed frontier for every requested V4 continuation pool', async () => {
  const calls = [];
  const repository = createRobinhoodHeadProcessingRepository({
    database: { async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    } },
  });

  await repository.claimV4Continuations({
    owner: 'worker-a', marketKeys: ['pool-a', 'pool-b'], limit: 2000,
    perPoolLimit: 512, leaseMs: 60_000,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [
    'worker-a', 2000, 60_000, ['pool-a', 'pool-b'], 512,
  ]);
  assert.match(calls[0].sql, /FROM unnest\(\$4::text\[\]\)/);
  assert.match(calls[0].sql, /CROSS JOIN LATERAL/);
  assert.match(calls[0].sql, /capture\.market_key = requested\.market_key/);
  assert.match(calls[0].sql, /ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW/);
  assert.match(calls[0].sql, /WHERE NOT blocked_prefix/);
  assert.doesNotMatch(calls[0].sql, /delta_seen|swap_seen/);
  assert.doesNotMatch(calls[0].sql, /market_key = ANY/);
  assert.doesNotMatch(calls[0].sql, /DISTINCT ON/);
});

it('registers resumable partial indexes for both market claim branches', () => {
  const sql = stage186.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage186-robinhood-market-claim-indexes'
  ));

  assert.match(sql, /market_key, block_number, transaction_index, log_index/);
  assert.match(sql, /processing_status IN \('pending', 'leased', 'blocked'\)/);
  assert.match(sql, /protocol IS DISTINCT FROM 'uniswap-v4'/);
  assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 2);
  assert.equal(group.repair, 'node src/utils/db-init-stage186.js');
  assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage186.INDEX_NAMES);
});

it('rebuilds an interrupted claim index before validating both indexes', async () => {
  const calls = [];
  const database = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('SELECT indisvalid')) {
      return { rows: [{ indisvalid: params[0] !== stage186.INDEX_NAMES[0] }] };
    }
    if (sql.includes('ANY($1::regclass[])')) {
      return { rows: stage186.INDEX_NAMES.map((index_name) => ({
        index_name, indisvalid: true, indisready: true,
      })) };
    }
    return { rows: [] };
  } };

  await stage186.init({ database, closePool: false });

  assert.equal(calls.filter(({ sql }) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.startsWith('CREATE INDEX CONCURRENTLY')).length, 2);
});
