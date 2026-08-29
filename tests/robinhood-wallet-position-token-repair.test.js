const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRobinhoodWalletPositionTokenRepairRepository,
} = require('../src/models/robinhood-wallet-position-token-repair');

test('initializes only published transfer repairs added after the position seed began', async () => {
  let captured;
  const repository = createRobinhoodWalletPositionTokenRepairRepository({
    database: { async query(sql, params) {
      captured = { sql, params };
      return { rowCount: 391, rows: [] };
    } },
  });
  assert.deepEqual(await repository.initialize(), { inserted: 391 });
  assert.match(captured.sql, /transfer\.published_at IS NOT NULL/);
  assert.match(captured.sql, /state\.created_at > seed\.created_at/);
  assert.match(captured.sql, /ON CONFLICT .* DO NOTHING/s);
  assert.deepEqual(captured.params, [
    'robinhood', 'unified_transfer_v1',
    'unified_transfer_token_repair_v1', 'rh_transfer_v1',
  ]);
});
