'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../src/models/robinhood-canonical-holder-source');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const OTHER_TOKEN = `0x${'2'.repeat(40)}`;
const FROM = `0x${'3'.repeat(40)}`;
const TO = `0x${'4'.repeat(40)}`;
const topicAddress = (value) => `0x${'0'.repeat(24)}${value.slice(2)}`;

function event(address = TOKEN, overrides = {}) {
  return {
    block_number: '102', block_hash: BLOCK_HASH, transaction_hash: TX_HASH,
    transaction_index: 3, log_index: 7, address,
    topics: [TRANSFER_TOPIC, topicAddress(FROM), topicAddress(TO)],
    data: `0x${'0'.repeat(63)}5`, ...overrides,
  };
}

function fixture(events = [event()], frontier = {}) {
  const calls = [];
  const state = {
    checkpoint_block: '110', node_head: '120', journal_start_block: '100', ...frontier,
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('cursor.checkpoint_block')) return { rowCount: 1, rows: [state] };
      if (sql.includes('SELECT block_hash FROM')) {
        return { rowCount: 1, rows: [{ block_hash: BLOCK_HASH }] };
      }
      if (sql.includes('FROM robinhood_chain_events')) return { rows: events };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const database = {
    async getClient() { return client; },
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('cursor.checkpoint_block')) return { rowCount: 1, rows: [state] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ matches: true }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { calls, source: createRobinhoodCanonicalHolderSource({ database }) };
}

describe('Robinhood canonical holder source', () => {
  it('derives a confirmed head bounded by continuous canonical capture', async () => {
    const { source } = fixture([], { checkpoint_block: '110', node_head: '125' });
    assert.deepEqual(await source.getSafeHead(12), {
      head: '125', safeHead: '110', confirmations: 12,
    });
    assert.equal(await source.assertChain(), '4663');
  });

  it('reads the canonical Transfer journal in the existing holder format', async () => {
    const { calls, source } = fixture([event(), event(OTHER_TOKEN, {
      transaction_hash: `0x${'c'.repeat(64)}`, log_index: 8,
    })]);
    const result = await source.readGlobalRange({
      tokenAddresses: [TOKEN], captureAllTransfers: true, fromBlock: '100', toBlock: '104',
    });
    assert.equal(result.transfers.length, 2);
    assert.deepEqual(result.transfers[0], {
      blockNumber: '102', blockHash: BLOCK_HASH, transactionHash: TX_HASH,
      transactionIndex: 3, logIndex: 7, tokenAddress: TOKEN,
      fromWallet: FROM, toWallet: TO, amountRaw: '5',
    });
    assert.equal(result.telemetry.filterMode, 'canonical-journal-buffered');
    assert.equal(result.telemetry.bufferedTokenAddresses, 1);
    const eventCall = calls.find(({ sql }) => sql.includes('FROM robinhood_chain_events'));
    assert.deepEqual(eventCall.params, ['robinhood', '100', '104', TRANSFER_TOPIC]);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('filters drift-repair reads to one token without RPC', async () => {
    const { source } = fixture([event(), event(OTHER_TOKEN, {
      transaction_hash: `0x${'c'.repeat(64)}`, log_index: 8,
    })]);
    const result = await source.readReceiptRange({
      tokenAddress: TOKEN, fromBlock: '100', toBlock: '104', batchSize: 25,
    });
    assert.equal(result.transfers.length, 1);
    assert.equal(result.transfers[0].tokenAddress, TOKEN);
    assert.equal(result.telemetry.source, 'canonical-journal');
    assert.equal(result.telemetry.requests, 0);
  });

  it('fails closed outside journal coverage and checks canonical checkpoints', async () => {
    const { source } = fixture();
    await assert.rejects(
      source.readGlobalRange({ tokenAddresses: [], fromBlock: '99', toBlock: '100' }),
      (error) => error.code === 'canonical_holder_source_gap'
    );
    assert.equal(await source.matchesCheckpoint({ number: '102', hash: BLOCK_HASH }), true);
  });
});
