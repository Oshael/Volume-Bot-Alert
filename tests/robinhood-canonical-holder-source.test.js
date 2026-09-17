'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../src/models/robinhood-canonical-holder-source');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodHolderTransferReader,
} = require('../src/services/robinhood-holder-transfer-reader');

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

function fixture(events = [event()], frontier = {}, options = {}) {
  const calls = [];
  const state = {
    checkpoint_block: '110', node_head: '120', journal_start_block: '100', ...frontier,
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes("set_config('statement_timeout'")) return { rows: [] };
      if (sql.includes('cursor.checkpoint_block')) return { rowCount: 1, rows: [state] };
      if (sql.includes('SELECT block_hash FROM')) {
        if (options.checkpointMissing) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ block_hash: BLOCK_HASH }] };
      }
      if (sql.includes('FROM robinhood_chain_events')) {
        return { rows: params.length === 5
          ? events.filter(({ address }) => address === params[4]) : events };
      }
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
  return {
    calls,
    source: createRobinhoodCanonicalHolderSource({
      database, statementTimeoutMs: options.statementTimeoutMs,
    }),
  };
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
    assert.deepEqual({
      rawTransfersObserved: result.telemetry.rawTransfersObserved,
      trackedTransfers: result.telemetry.trackedTransfers,
      legacyExtraTransfers: result.telemetry.legacyExtraTransfers,
      scopeTokens: result.telemetry.scopeTokens,
    }, {
      rawTransfersObserved: 2, trackedTransfers: 1,
      legacyExtraTransfers: 1, scopeTokens: 1,
    });
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

  it('reads one token in SQL with payload parity and idempotent identity', async () => {
    const { calls, source } = fixture([event()], {}, { statementTimeoutMs: 2000 });
    const input = { tokenAddress: TOKEN, fromBlock: '100', toBlock: '104' };
    const canonical = await source.readRange(input);
    const repeated = await source.readRange(input);
    const rpc = createRobinhoodHolderTransferReader({
      rpcClient: {
        async request(method) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_getLogs') return [logFromEvent(event())];
          if (method === 'eth_getBlockByNumber') {
            return { number: '0x68', hash: BLOCK_HASH };
          }
          throw new Error(`unexpected RPC method: ${method}`);
        },
      },
    });
    const rpcRange = await rpc.readRange(input);

    assert.deepEqual(canonical.transfers, rpcRange.transfers);
    assert.deepEqual(repeated, canonical);
    assert.deepEqual(await source.getCoverage(), {
      floorBlock: '100', frontierBlock: '110', nodeHead: '120',
    });
    const eventCall = calls.find(({ sql, params }) => (
      sql.includes('FROM robinhood_chain_events') && params.length === 5
    ));
    assert.match(eventCall.sql, /event\.address=\$5/);
    assert.equal(eventCall.params[4], TOKEN);
    assert.deepEqual(
      calls.find(({ sql }) => sql.includes("set_config('statement_timeout'"))?.params,
      ['2000ms']
    );
  });

  it('reports the exact raw coverage gap at retention boundaries', async () => {
    const { source } = fixture();
    for (const [fromBlock, toBlock, reason] of [
      ['90', '99', 'below-floor'],
      ['99', '100', 'partial-coverage'],
      ['109', '111', 'partial-coverage'],
      ['111', '112', 'above-frontier'],
    ]) {
      await assert.rejects(
        source.readRange({ tokenAddress: TOKEN, fromBlock, toBlock }),
        (error) => error.code === 'canonical_holder_source_gap'
          && error.reason === reason
          && error.coverage.floorBlock === '100'
      );
    }
    await assert.rejects(
      fixture([], { journal_start_block: '111' }).source.getCoverage(),
      (error) => error.code === 'canonical_holder_source_gap'
        && error.reason === 'coverage-inconsistent'
    );
  });

  it('fails closed for malformed token logs and missing canonical checkpoints', async () => {
    const malformed = fixture([event(TOKEN, {
      topics: [TRANSFER_TOPIC, topicAddress(FROM), topicAddress(TO), topicAddress(FROM)],
    })]).source;
    await assert.rejects(
      malformed.readRange({ tokenAddress: TOKEN, fromBlock: '100', toBlock: '104' }),
      (error) => error.code === 'holder_transfer_invalid_log' && error.tokenAddress === TOKEN
    );
    const missing = fixture([], {}, { checkpointMissing: true }).source;
    await assert.rejects(
      missing.readRange({ tokenAddress: TOKEN, fromBlock: '100', toBlock: '104' }),
      (error) => error.code === 'canonical_holder_source_gap'
        && error.reason === 'checkpoint-missing'
    );
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

function logFromEvent(row) {
  return {
    blockNumber: `0x${BigInt(row.block_number).toString(16)}`,
    blockHash: row.block_hash, transactionHash: row.transaction_hash,
    transactionIndex: `0x${BigInt(row.transaction_index).toString(16)}`,
    logIndex: `0x${BigInt(row.log_index).toString(16)}`,
    address: row.address, topics: row.topics, data: row.data, removed: false,
  };
}
