const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage148 = require('../src/utils/db-init-stage148');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../src/models/robinhood-pool-liquidity-event-cursor');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const HASH = `0x${'a'.repeat(64)}`;

describe('Robinhood pool liquidity event cursor', () => {
  it('defines explicit coverage and checkpoint invariants in the runtime schema', () => {
    const sql = stage148.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage148-robinhood-pool-liquidity-event-cursor'
    ));
    assert.match(sql, /coverage_start_block >= 0 AND next_block >= coverage_start_block/);
    assert.match(sql, /checkpoint_block = next_block - 1/);
    assert.equal(group.repair, 'node src/utils/db-init-stage148.js');
  });

  it('initializes once and maps the durable cursor', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquidityEventCursorRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [{
          coverage_start_block: '100', next_block: '100', safe_head: null,
          checkpoint_block: null, checkpoint_hash: null,
          checkpoint_timestamp: null, version: '0',
        }] };
      },
    } });
    const cursor = await repository.initializeCursor({ startBlock: '100' });
    assert.equal(cursor.nextBlock, '100');
    assert.deepEqual(calls[0].params, ['robinhood', '100']);
    assert.match(calls[0].sql, /ON CONFLICT \(chain\) DO NOTHING/);
  });

  it('commits only a contiguous range with an exact checkpoint', async () => {
    const calls = [];
    const repository = createRobinhoodPoolLiquidityEventCursorRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [{
          coverage_start_block: '100', next_block: '111', safe_head: '120',
          checkpoint_block: '110', checkpoint_hash: HASH,
          checkpoint_timestamp: new Date('2026-08-22T12:00:00Z'), version: '1',
        }] };
      },
    } });
    const cursor = await repository.commitRange({
      fromBlock: '100', nextBlock: '111', safeHead: '120',
      checkpoint: { number: '110', hash: HASH, timestampMs: 1787400000000 },
    });
    assert.equal(cursor.checkpoint.number, '110');
    assert.match(calls[0].sql, /next_block = \$2/);
    await assert.rejects(repository.commitRange({
      fromBlock: '111', nextBlock: '120', safeHead: '120',
      checkpoint: { number: '118', hash: HASH },
    }), /checkpoint must be immediately before nextBlock/);
  });

  it('rewinds explicitly and stops before unfinished discovery', async () => {
    let call = 0;
    const repository = createRobinhoodPoolLiquidityEventCursorRepository({ database: {
      async query(sql) {
        call += 1;
        if (call === 1) return { rowCount: 1, rows: [{
          coverage_start_block: '100', next_block: '105', safe_head: null,
          checkpoint_block: null, checkpoint_hash: null,
          checkpoint_timestamp: null, version: '2',
        }] };
        assert.match(sql, /processing_status IN \('pending', 'leased', 'blocked'\)/);
        return { rows: [{ checkpoint_block: '200', pending_block: '151' }] };
      },
    } });
    assert.equal((await repository.rewindCursor({ rewindBlock: '105' })).nextBlock, '105');
    assert.equal(await repository.resolveDiscoveryFrontier(), '150');
  });
});
