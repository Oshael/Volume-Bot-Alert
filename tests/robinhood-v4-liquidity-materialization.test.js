const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage101 = require('../src/utils/db-init-stage101');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  LOCK_KEY,
  createRobinhoodV4LiquidityMaterialization,
} = require('../src/models/robinhood-v4-liquidity-materialization');

function fakeDatabase(options = {}) {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (/SELECT \* FROM robinhood_v4_liquidity_replay_state/.test(sql)) return {
      rowCount: 1,
      rows: [{
        start_block: 7000000, target_block: 25000000,
        checkpoint_hash: `0x${'a'.repeat(64)}`, status: options.status || 'completed',
      }],
    };
    if (/HAVING SUM\(liquidity_delta\) < 0/.test(sql)) {
      return options.negative
        ? { rowCount: 1, rows: [{ pool_id: 'pool', tick_lower: -60, tick_upper: 60 }] }
        : { rowCount: 0, rows: [] };
    }
    if (/INSERT INTO robinhood_v4_liquidity_ranges/.test(sql)) return { rowCount: 3, rows: [{}, {}, {}] };
    return { rowCount: 1, rows: [{}] };
  }, release() {} };
  return { database: { getClient: async () => client }, calls };
}

describe('Robinhood V4 liquidity materialization', () => {
  it('registers durable ranges and cutover state in Stage 101', () => {
    const sql = stage101.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage101-robinhood-v4-liquidity-ranges');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_ranges/);
    assert.match(sql, /liquidity_gross >= 0/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_materialization_state/);
    assert.equal(group.repair, 'node src/utils/db-init-stage101.js');
  });

  it('rebuilds positive ranges and publishes readiness under one lock', async () => {
    const fake = fakeDatabase();
    const result = await createRobinhoodV4LiquidityMaterialization(fake).materialize();

    assert.deepEqual(result, { ranges: 3, replayTargetBlock: '25000000' });
    assert.equal(fake.calls[0].sql, 'BEGIN');
    assert.deepEqual(fake.calls[1].params, [LOCK_KEY]);
    assert.match(fake.calls.at(-2).sql, /liquidity_materialization_state/);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  });

  it('rolls back instead of publishing a negative reconstructed range', async () => {
    const fake = fakeDatabase({ negative: true });
    await assert.rejects(
      createRobinhoodV4LiquidityMaterialization(fake).materialize(),
      /Invalid V4 liquidity/
    );
    assert.equal(fake.calls.some(({ sql }) => /DELETE FROM robinhood_v4_liquidity_ranges/.test(sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('refuses materialization before the replay is complete', async () => {
    const fake = fakeDatabase({ status: 'running' });
    await assert.rejects(
      createRobinhoodV4LiquidityMaterialization(fake).materialize(),
      /replay must be completed/
    );
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });
});
