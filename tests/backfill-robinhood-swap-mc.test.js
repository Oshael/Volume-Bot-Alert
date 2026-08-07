const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  run,
  parseArgs,
  __private: { SELECT_BATCH_SQL, UPSERT_SQL, toPayload },
} = require('../src/utils/backfill-robinhood-swap-mc');

function obs(blockNumber, logIndex, overrides = {}) {
  return {
    chain: 'robinhood',
    transaction_hash: `0x${'a'.repeat(64)}`,
    log_index: String(logIndex),
    block_number: String(blockNumber),
    fdv_usd: '48000',
    token_total_supply_raw: '1000000000000000000000000',
    ...overrides,
  };
}

// Returns the queued SELECT batches in order; every UPSERT reports rowCount.
function fakeDb(batches) {
  const calls = [];
  const queue = [...batches];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^INSERT INTO robinhood_swap_mc/.test(sql.trim())) {
        return { rowCount: JSON.parse(params[0]).length };
      }
      return { rows: queue.shift() || [] };
    },
  };
}

describe('robinhood swap-mc backfill', () => {
  it('reads only accepted observations with an FDV, keyset-ordered', () => {
    assert.match(SELECT_BATCH_SQL, /status = 'accepted'/);
    assert.match(SELECT_BATCH_SQL, /fdv_usd IS NOT NULL/);
    assert.match(SELECT_BATCH_SQL, /\(block_number, log_index\) > \(\$1::bigint, \$2::bigint\)/);
    assert.match(SELECT_BATCH_SQL, /ORDER BY block_number, log_index/);
  });

  it('upserts refresh-safe: rewrites only when the value actually changed', () => {
    assert.match(UPSERT_SQL, /ON CONFLICT \(chain, transaction_hash, log_index\) DO UPDATE/);
    assert.match(UPSERT_SQL, /IS DISTINCT FROM \(EXCLUDED\.fdv_usd, EXCLUDED\.token_total_supply_raw\)/);
  });

  it('dry-run scans every batch but never writes, and stops on the empty batch', async () => {
    const database = fakeDb([[obs(100, 1), obs(100, 2)], [obs(101, 0)]]);
    const summary = await run({ database, options: { apply: false, batchSize: 2, sleepMs: 0, maxBatches: 0, checkpoint: null } });
    assert.equal(summary.scanned, 3);
    assert.equal(summary.upserted, 0);
    assert.equal(summary.batches, 2);
    assert.equal(database.calls.filter((c) => /^INSERT/.test(c.sql.trim())).length, 0);
    // second SELECT resumes past the first batch's last (block 100, log 2)
    assert.deepEqual(database.calls[1].params.slice(0, 2), ['100', '2']);
  });

  it('apply writes each batch, counts upserts, and advances the keyset cursor', async () => {
    const database = fakeDb([[obs(100, 1), obs(100, 2)], [obs(205, 7)]]);
    const summary = await run({ database, options: { apply: true, batchSize: 2, sleepMs: 0, maxBatches: 0, checkpoint: null } });
    assert.equal(summary.scanned, 3);
    assert.equal(summary.upserted, 3);
    assert.equal(summary.lastBlock, '205');
    const inserts = database.calls.filter((c) => /^INSERT/.test(c.sql.trim()));
    assert.equal(inserts.length, 2);
    // payload carries stringified values keyed for the sidecar
    assert.deepEqual(toPayload([obs(100, 1)])[0], {
      chain: 'robinhood', transaction_hash: `0x${'a'.repeat(64)}`, log_index: '1',
      fdv_usd: '48000', token_total_supply_raw: '1000000000000000000000000',
    });
  });

  it('respects --max-batches as a safety cap', async () => {
    const database = fakeDb([[obs(1, 0)], [obs(2, 0)], [obs(3, 0)]]);
    const summary = await run({ database, options: { apply: false, batchSize: 1, sleepMs: 0, maxBatches: 2, checkpoint: null } });
    assert.equal(summary.batches, 2);
    assert.equal(summary.scanned, 2);
  });

  it('validates args: --apply needs a checkpoint and bounds are enforced', () => {
    assert.throws(() => parseArgs(['--apply']), /--apply requires --checkpoint/);
    assert.throws(() => parseArgs(['--batch-size', '0']), /--batch-size/);
    assert.throws(() => parseArgs(['--sleep-ms', '-1']), /--sleep-ms/);
    const ok = parseArgs(['--apply', '--checkpoint', '.mc.json', '--sleep-ms', '50']);
    assert.equal(ok.apply, true);
    assert.equal(ok.checkpoint, '.mc.json');
    assert.equal(ok.sleepMs, 50);
  });
});
