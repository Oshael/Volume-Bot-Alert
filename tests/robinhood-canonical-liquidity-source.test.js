'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalLiquiditySource,
} = require('../src/models/robinhood-canonical-liquidity-source');
const { LIQUIDITY_EVENT_TOPICS } = require('../src/services/robinhood-pool-liquidity-events');

const HASH = `0x${'1'.repeat(64)}`;
const TX = `0x${'2'.repeat(64)}`;

function clientFor(state, events = []) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('WITH processing AS')) return { rows: state ? [state] : [] };
      if (sql.includes('FROM robinhood_chain_events')) return { rows: events };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, client };
}

function sourceWith(state, events) {
  const fixture = clientFor(state, events);
  return {
    ...fixture,
    source: createRobinhoodCanonicalLiquiditySource({
      database: { async getClient() { return fixture.client; } },
    }),
  };
}

describe('Robinhood canonical liquidity journal source', () => {
  it('returns an ordered RPC-compatible range without making RPC calls', async () => {
    const fixture = sourceWith({
      journal_start_block: '100', journal_through: '200', safe_head: '180',
      to_block: '109', checkpoint_hash: HASH,
      checkpoint_timestamp: '2026-09-05T06:00:00.000Z',
    }, [{
      block_number: '102', block_hash: HASH, transaction_hash: TX,
      transaction_index: 3, log_index: 7, address: `0x${'3'.repeat(40)}`,
      topics: [LIQUIDITY_EVENT_TOPICS[0]], data: '0x01',
    }]);
    const range = await fixture.source.readNextRange({ fromBlock: '100', maxBlocks: 10 });
    assert.equal(range.status, 'available');
    assert.deepEqual(range.checkpoint, {
      number: '109', hash: HASH, timestampMs: Date.parse('2026-09-05T06:00:00.000Z'),
    });
    assert.deepEqual(range.logs[0], {
      blockNumber: '102', blockHash: HASH, transactionHash: TX,
      transactionIndex: '3', logIndex: '7', address: `0x${'3'.repeat(40)}`,
      topics: [LIQUIDITY_EVENT_TOPICS[0]], data: '0x01', removed: false,
    });
    assert.match(fixture.calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(fixture.calls[2].params, [
      'robinhood', '100', '109', LIQUIDITY_EVENT_TOPICS,
    ]);
    assert.equal(fixture.calls.at(-2).sql, 'ROLLBACK');
    assert.equal(fixture.calls.at(-1).sql, 'RELEASE');
  });

  it('advances empty ranges using the canonical checkpoint', async () => {
    const fixture = sourceWith({
      journal_start_block: '100', journal_through: '200', safe_head: '180',
      to_block: '104', checkpoint_hash: HASH, checkpoint_timestamp: null,
    });
    const range = await fixture.source.readNextRange({ fromBlock: '100', maxBlocks: 5 });
    assert.equal(range.status, 'available');
    assert.equal(range.toBlock, '104');
    assert.deepEqual(range.logs, []);
  });

  it('reports caught-up state without querying events', async () => {
    const fixture = sourceWith({
      journal_start_block: '100', journal_through: '200', safe_head: '149',
      to_block: null, checkpoint_hash: null, checkpoint_timestamp: null,
    });
    const range = await fixture.source.readNextRange({ fromBlock: '150', maxBlocks: 10 });
    assert.deepEqual(range, {
      status: 'caught_up', fromBlock: '150', toBlock: null, safeHead: '149',
      logs: [], checkpoint: null,
    });
    assert.equal(fixture.calls.some(({ sql }) => sql.includes('FROM robinhood_chain_events')), false);
  });

  it('fails closed before journal coverage or on a missing checkpoint', async () => {
    const before = sourceWith({
      journal_start_block: '100', journal_through: '200', safe_head: '180',
      to_block: '99', checkpoint_hash: HASH, checkpoint_timestamp: null,
    });
    await assert.rejects(
      before.source.readNextRange({ fromBlock: '99', maxBlocks: 1 }),
      (error) => error.code === 'canonical_liquidity_source_gap'
    );
    assert.equal(before.calls.at(-2).sql, 'ROLLBACK');

    const missing = sourceWith({
      journal_start_block: '100', journal_through: '200', safe_head: '180',
      to_block: '100', checkpoint_hash: null, checkpoint_timestamp: null,
    });
    await assert.rejects(
      missing.source.readNextRange({ fromBlock: '100', maxBlocks: 1 }),
      (error) => error.code === 'canonical_liquidity_source_gap'
    );
  });

  it('bounds requested ranges', async () => {
    const source = createRobinhoodCanonicalLiquiditySource({ database: {} });
    await assert.rejects(source.readNextRange({ fromBlock: '-1', maxBlocks: 1 }), /fromBlock/);
    await assert.rejects(source.readNextRange({ fromBlock: '1', maxBlocks: 1001 }), /maxBlocks/);
  });
});
