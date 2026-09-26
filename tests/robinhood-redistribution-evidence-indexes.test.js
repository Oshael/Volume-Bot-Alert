const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage252 = require('../src/utils/db-init-stage252');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const mountedFilesystem = { statSync(path) { return { dev: path === '/srv' ? 1 : 2 }; } };

it('defines the two redistribution lookup indexes on the second data volume', () => {
  const { childIndexSql, attachIndexSql } = stage252.__private;
  const child = 'robinhood_wallet_swaps_2026_09_17';
  const group = SCHEMA_GROUPS.find((item) =>
    item.key === 'stage252-robinhood-redistribution-evidence-indexes');

  assert.match(stage252.EDGE_SQL, /CREATE INDEX CONCURRENTLY/);
  assert.match(stage252.EDGE_SQL,
    /chain, classification_version, token_address, first_wallet_transfer_block/);
  assert.match(stage252.EDGE_SQL, /TABLESPACE trendscope_nvme2/);
  assert.match(stage252.PARENT_SQL, /ON ONLY public\.robinhood_wallet_swaps/);
  assert.match(stage252.PARENT_SQL,
    /chain, token_address, wallet_address, block_number/);
  assert.match(stage252.PARENT_SQL, /WHERE side = 'sell'/);
  assert.match(childIndexSql('public', child), /CREATE INDEX CONCURRENTLY/);
  assert.match(childIndexSql('public', child), /TABLESPACE trendscope_nvme2/);
  assert.match(attachIndexSql('public', child), /ATTACH PARTITION/);
  assert.equal(group.repair, 'node src/utils/db-init-stage252.js');
});

it('refuses to create indexes when the tablespace is outside the requested mount', async () => {
  const calls = [];
  const database = { async query(sql) {
    calls.push(sql);
    return { rows: [{ location: '/srv/trendscope-data/pg16-tablespace' }] };
  } };

  await assert.rejects(stage252.init({ database, closePool: false }),
    /must be located under \/srv\/trendscope-data-2\//);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /pg_tablespace_location/);
});

it('refuses to reuse a named index stored on another tablespace', async () => {
  const calls = [];
  const database = { async query(sql) {
    calls.push(sql);
    if (sql.includes('pg_tablespace_location')) return { rows: [{
      location: '/srv/trendscope-data-2/pg16-tablespace',
    }] };
    return { rows: [{ indisvalid: true, tablespace: 'trendscope_raw' }] };
  } };

  await assert.rejects(stage252.init({ database, filesystem: mountedFilesystem,
    closePool: false }),
    /outside trendscope_nvme2/);
  assert.equal(calls.some((sql) => sql.startsWith('CREATE INDEX')), false);
});

it('refuses the build if the tablespace path is no longer on a separate mount', async () => {
  const calls = [];
  const database = { async query(sql) {
    calls.push(sql);
    return { rows: [{ location: '/srv/trendscope-data-2/pg16-tablespace' }] };
  } };
  const unmountedFilesystem = { statSync() { return { dev: 1 }; } };

  await assert.rejects(stage252.init({ database, filesystem: unmountedFilesystem,
    closePool: false }), /not on a mounted/);
  assert.equal(calls.length, 1);
});

it('resumes concurrent builds, checks attached index placement and completes the parent', async () => {
  const calls = [];
  const states = new Map([
    ['public.idx_rh_transfer_edges_redis_window', { indisvalid: false,
      tablespace: 'trendscope_nvme2' }],
    ['public.idx_rh_wallet_swaps_redis_sell', { indisvalid: false,
      tablespace: 'trendscope_nvme2' }],
    ['public.existing_sell_index', { indisvalid: true,
      tablespace: 'trendscope_nvme2' }],
  ]);
  const database = { async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('pg_tablespace_location')) return { rows: [{
      location: '/srv/trendscope-data-2/pg16-tablespace',
    }] };
    if (sql.includes('FROM pg_index state')) {
      return { rows: states.has(params[0]) ? [states.get(params[0])] : [] };
    }
    if (sql.includes('FROM pg_inherits table_tree')) return { rows: [{
      schema_name: 'public', partition_name: 'robinhood_wallet_swaps_2026_09_16',
      attached_index_name: 'existing_sell_index',
    }, {
      schema_name: 'public', partition_name: 'robinhood_wallet_swaps_2026_09_17',
      attached_index_name: null,
    }] };
    if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
      states.delete('public.idx_rh_transfer_edges_redis_window');
    }
    if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
      const name = sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS\s+"?([a-z0-9_]+)"?/)[1];
      states.set(`public.${name}`, { indisvalid: true, tablespace: 'trendscope_nvme2' });
    }
    if (sql.includes('ATTACH PARTITION')) {
      states.get('public.idx_rh_wallet_swaps_redis_sell').indisvalid = true;
    }
    return { rows: [] };
  }, pool: { end: async () => {} } };

  await stage252.init({ database, filesystem: mountedFilesystem, closePool: false });

  assert.equal(calls.filter(({ sql }) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.startsWith('CREATE INDEX CONCURRENTLY')).length, 2);
  assert.equal(calls.filter(({ sql }) => sql.includes('ATTACH PARTITION')).length, 1);
  assert.equal(calls.some(({ sql }) => sql.includes('CREATE INDEX CONCURRENTLY')
    && sql.includes('2026_09_16')), false);
});
