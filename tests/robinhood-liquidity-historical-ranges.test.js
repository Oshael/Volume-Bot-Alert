const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createLiquidityHistoricalRangeRepository } = require('../src/models/robinhood-liquidity-historical-ranges');
const stage198 = require('../src/utils/db-init-stage198');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('bounds historical range reads and preserves unavailable versus empty pools', async () => {
  const ids = ['a', 'b', 'c'].map((char) => `0x${char.repeat(64)}`);
  const calls = [];
  const row = { tick_lower: -60, tick_upper: 60, liquidity_gross: '90071992547409930000' };
  const repository = createLiquidityHistoricalRangeRepository({ database: { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [
      { pool_id: ids[0], available: true, ...row },
      { pool_id: ids[1], available: true, tick_lower: null },
      { pool_id: ids[2], available: false, tick_lower: null },
    ] };
  } } });
  const result = await repository.listHistoricalV4LiquidityRangesByPoolIds([...ids, ids[0]], '0x14', '1');
  assert.deepEqual([...result], [[ids[0], [row]], [ids[1], []], [ids[2], null]]);
  assert.deepEqual(calls[0].params, [ids, '20', '1']);
  assert.match(calls[0].sql, /robinhood_v4_liquidity_ranges/);
  assert.match(calls[0].sql, /COALESCE\(current_ranges\.liquidity_gross, 0\)/);
  assert.match(calls[0].sql, /\(deltas\.block_number, deltas\.log_index\) >=/);
  assert.equal((await repository.listHistoricalV4LiquidityRangesByPoolIds([], '20', '0')).size, 0);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(Array(101).fill(ids[0]), '20', '0'), /100/);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(['bad'], '20', '0'), /32 bytes/);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(ids, '-1', '0'), /blockNumber/);
  assert.equal(calls.length, 1);
  const fullBatch = [...ids, ...Array.from({ length: 97 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`)];
  assert.equal((await repository.listHistoricalV4LiquidityRangesByPoolIds(fullBatch, '20', '0')).size, 100);
  assert.equal(calls.at(-1).params[0].length, 100);
});

it('reconstructs many historical positions from one ordered V4 delta read', async () => {
  const availablePool = `0x${'a'.repeat(64)}`;
  const unavailablePool = `0x${'b'.repeat(64)}`;
  const calls = [];
  const repository = createLiquidityHistoricalRangeRepository({ database: { async query(sql, params) {
    calls.push({ sql, params });
    return { rows: [
      { row_kind: 'availability', pool_id: availablePool, available: true },
      { row_kind: 'availability', pool_id: unavailablePool, available: false },
      {
        row_kind: 'delta', pool_id: availablePool, available: true,
        block_number: '5', log_index: '1', tick_lower: -60, tick_upper: 60,
        liquidity_delta: '10',
      },
      {
        row_kind: 'delta', pool_id: availablePool, available: true,
        block_number: '8', log_index: '1', tick_lower: -60, tick_upper: 60,
        liquidity_delta: '-3',
      },
    ] };
  } } });
  const result = await repository.listHistoricalV4LiquidityRangesAtPositions([
    { id: 'later', poolId: availablePool, blockNumber: '9', logIndex: '0' },
    { id: 'earlier', poolId: availablePool, blockNumber: '7', logIndex: '0' },
    { id: 'missing', poolId: unavailablePool, blockNumber: '9', logIndex: '0' },
  ]);

  assert.deepEqual(result.get('earlier'), [
    { tick_lower: -60, tick_upper: 60, liquidity_gross: '10' },
  ]);
  assert.deepEqual(result.get('later'), [
    { tick_lower: -60, tick_upper: 60, liquidity_gross: '7' },
  ]);
  assert.equal(result.get('missing'), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /jsonb_to_recordset/);
  assert.match(calls[0].sql, /JOIN maxima USING \(pool_id\)/);
  assert.equal(JSON.parse(calls[0].params[0]).length, 3);
  assert.deepEqual(JSON.parse(calls[0].params[1]), []);
});

it('reuses the prior V4 range state and reads only the next delta tail', async () => {
  const id = `0x${'c'.repeat(64)}`;
  const calls = [];
  const batches = [[
    { row_kind: 'availability', pool_id: id, available: true },
    {
      row_kind: 'delta', pool_id: id, available: true,
      block_number: '5', log_index: '1', tick_lower: -60, tick_upper: 60,
      liquidity_delta: '10',
    },
  ], [
    { row_kind: 'availability', pool_id: id, available: true },
    {
      row_kind: 'delta', pool_id: id, available: true,
      block_number: '8', log_index: '1', tick_lower: -60, tick_upper: 60,
      liquidity_delta: '-3',
    },
  ], [
    { row_kind: 'availability', pool_id: id, available: true },
    {
      row_kind: 'delta', pool_id: id, available: true,
      block_number: '5', log_index: '1', tick_lower: -60, tick_upper: 60,
      liquidity_delta: '10',
    },
  ]];
  const repository = createLiquidityHistoricalRangeRepository({
    maxPositionCachePools: 1,
    database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: batches.shift() };
      },
    },
  });

  assert.equal((await repository.listHistoricalV4LiquidityRangesAtPositions([
    { id: 'first', poolId: id, blockNumber: '7', logIndex: '0' },
  ])).get('first')[0].liquidity_gross, '10');
  assert.equal((await repository.listHistoricalV4LiquidityRangesAtPositions([
    { id: 'second', poolId: id, blockNumber: '9', logIndex: '0' },
  ])).get('second')[0].liquidity_gross, '7');

  assert.deepEqual(JSON.parse(calls[1].params[1]), [{
    pool_id: id, block_number: '7', log_index: '0',
  }]);
  assert.match(calls[1].sql, />= \(baseline\.block_number, baseline\.log_index\)/);

  assert.equal((await repository.listHistoricalV4LiquidityRangesAtPositions([
    { id: 'earlier', poolId: id, blockNumber: '6', logIndex: '0' },
  ])).get('earlier')[0].liquidity_gross, '10');
  assert.deepEqual(JSON.parse(calls[2].params[1]), []);
});

it('registers a covering index for bounded V4 tail reads', () => {
  const sql = stage198.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage198-robinhood-v4-liquidity-tail-index'
  ));
  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(sql, /\(chain, pool_id, block_number, log_index\)/);
  assert.match(sql, /INCLUDE \(tick_lower, tick_upper, liquidity_delta\)/);
  assert.equal(group.repair, 'node src/utils/db-init-stage198.js');
});
