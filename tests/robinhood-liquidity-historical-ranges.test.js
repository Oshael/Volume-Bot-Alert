const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createLiquidityHistoricalRangeRepository } = require('../src/models/robinhood-liquidity-historical-ranges');

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
  assert.match(calls[0].sql, /JOIN requested ON requested\.pool_id = delta\.pool_id/);
  assert.doesNotMatch(calls[0].sql, /LATERAL/);
  assert.equal((await repository.listHistoricalV4LiquidityRangesByPoolIds([], '20', '0')).size, 0);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(Array(51).fill(ids[0]), '20', '0'), /50/);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(['bad'], '20', '0'), /32 bytes/);
  await assert.rejects(repository.listHistoricalV4LiquidityRangesByPoolIds(ids, '-1', '0'), /blockNumber/);
  assert.equal(calls.length, 1);
});
