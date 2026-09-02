const assert = require('node:assert/strict');
const { it } = require('node:test');

const {
  createRobinhoodHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing');
const stage186 = require('../src/utils/db-init-stage186');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('uses bounded locked branches for the market claim', async () => {
  const calls = [];
  const repository = createRobinhoodHeadProcessingRepository({
    database: { async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    } },
  });

  await repository.claimCaptures({
    owner: 'worker-a', limit: 2000, leaseMs: 60_000, stream: 'market',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['worker-a', 2000, 60_000]);
  assert.match(calls[0].sql, /WITH RECURSIVE first_v4_by_pool/);
  assert.match(calls[0].sql, /CROSS JOIN LATERAL/);
  assert.match(calls[0].sql, /v4_claimable AS MATERIALIZED/);
  assert.match(calls[0].sql, /independent_claimable AS MATERIALIZED/);
  assert.equal((calls[0].sql.match(/FOR UPDATE OF capture SKIP LOCKED/g) || []).length, 2);
  assert.doesNotMatch(calls[0].sql, /LEFT JOIN first_v4_by_pool/);
  assert.doesNotMatch(calls[0].sql, /DISTINCT ON \(market_key\)/);
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
  assert.match(calls[0].sql, /jsonb_typeof\(capture\.evidence -> 'event'\)/);
  assert.match(calls[0].sql, /ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/);
  assert.match(calls[0].sql, /pool_position = 1/);
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
