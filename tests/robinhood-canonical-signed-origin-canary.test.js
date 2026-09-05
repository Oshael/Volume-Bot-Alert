'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalSignedOriginSource,
} = require('../src/models/robinhood-canonical-signed-origin-source');
const {
  compareRows, createRobinhoodCanonicalSignedOriginCanary,
} = require('../src/services/robinhood-canonical-signed-origin-canary');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-signed-origin-canary');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'c'.repeat(40)}`;
const TIME = '2026-09-05T20:00:00.000Z';

function readiness(ready = true) {
  return { async inspect() { return {
    ready, blockers: ready ? [] : [{ code: 'capture_lag_exceeded' }],
    signed_origin: { checkpoint_block: '200', origin_block: '50' },
    handoff: { journal_start_block: '100' },
  }; } };
}

function source(overrides = {}) {
  return { async readBlocks() { return {
    blocks: [
      { number: '199', hash: HASH, blockTime: TIME, transactionCount: 1 },
      { number: '200', hash: HASH, blockTime: TIME, transactionCount: 0 },
    ],
    origins: [{
      walletAddress: WALLET, transactionHash: TX, transactionIndex: '0', nonce: '7',
      blockNumber: '199', blockHash: HASH, blockTime: TIME,
      coverageOriginBlock: '50', sourceStream: 'live', observedAt: TIME,
    }],
    metrics: { transactionsScanned: 1 }, ...overrides,
  }; } };
}

describe('Robinhood canonical signed-origin canary', () => {
  it('approves matching canonical signed-origin evidence', async () => {
    const canary = createRobinhoodCanonicalSignedOriginCanary({
      readiness: readiness(), legacySource: source(), canonicalSource: source(),
    });
    const report = await canary.inspect({ blocks: 2, minTransactions: 1 });
    assert.equal(report.approved, true);
    assert.deepEqual(report.range, { from_block: '199', to_block: '200', blocks: 2 });
    assert.equal(report.parity.blocks.matched, 2);
    assert.equal(report.parity.origins.matched, 1);
  });

  it('reports missing and divergent evidence by stable identity', async () => {
    const differing = source({
      blocks: [{ number: '199', hash: HASH, blockTime: TIME, transactionCount: 2 }],
      origins: [{
        walletAddress: WALLET, transactionHash: TX, transactionIndex: '0', nonce: '8',
        blockNumber: '199', blockHash: HASH, blockTime: TIME,
        coverageOriginBlock: '50', sourceStream: 'live',
      }],
      metrics: { transactionsScanned: 2 },
    });
    const canary = createRobinhoodCanonicalSignedOriginCanary({
      readiness: readiness(), legacySource: source(), canonicalSource: differing,
    });
    const report = await canary.inspect({ blocks: 2, minTransactions: 1 });
    assert.deepEqual(report.blockers.map(({ code }) => code), [
      'canonical_blocks_missing', 'block_fields_divergent', 'origin_fields_divergent',
    ]);
    assert.deepEqual(report.parity.origins.samples.divergent[0].fields, ['nonce']);
    assert.equal(compareRows([], [], ['hash'], (row) => row.hash).matched, 0);
  });

  it('does not read either source when preflight is blocked', async () => {
    let reads = 0;
    const blocked = { async readBlocks() { reads += 1; } };
    const canary = createRobinhoodCanonicalSignedOriginCanary({
      readiness: readiness(false), legacySource: blocked, canonicalSource: blocked,
    });
    const report = await canary.inspect();
    assert.equal(report.blockers[0].code, 'preflight_not_ready');
    assert.equal(reads, 0);
  });

  it('loads complete canonical blocks in a repeatable read-only snapshot', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('LEFT JOIN robinhood_chain_transactions')) return { rows: [
          { block_number: '199', block_hash: HASH, block_timestamp: TIME,
            transaction_hash: TX, transaction_index: 0, from_address: WALLET, nonce: '7' },
          { block_number: '200', block_hash: HASH, block_timestamp: TIME,
            transaction_hash: null, transaction_index: null, from_address: null, nonce: null },
        ] };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const canonical = createRobinhoodCanonicalSignedOriginSource({
      database: { async getClient() { return client; } }, now: () => 1000,
    });
    const result = await canonical.readBlocks({
      blockNumbers: ['199', '200'], coverageOriginBlock: '50', safeHead: '200', stream: 'live',
    });
    assert.deepEqual(result.blocks.map(({ number, transactionCount }) => (
      { number, transactionCount }
    )), [{ number: '199', transactionCount: 1 }, { number: '200', transactionCount: 0 }]);
    assert.equal(result.origins[0].nonce, '7');
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[1].params, ['robinhood', '199', '200']);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('fails closed on canonical transaction gaps or missing nonce', async () => {
    const makeDatabase = (row) => ({ async getClient() { return {
      async query(sql) {
        if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
        return { rows: [row] };
      }, release() {},
    }; } });
    const base = { block_number: '199', block_hash: HASH, block_timestamp: TIME,
      transaction_hash: TX, from_address: WALLET, nonce: '7' };
    await assert.rejects(() => createRobinhoodCanonicalSignedOriginSource({
      database: makeDatabase({ ...base, transaction_index: 1 }),
    }).readBlocks({ blockNumbers: ['199'], coverageOriginBlock: '50', safeHead: '199',
      stream: 'live' }), /transaction gap/);
    await assert.rejects(() => createRobinhoodCanonicalSignedOriginSource({
      database: makeDatabase({ ...base, transaction_index: 0, nonce: null }),
    }).readBlocks({ blockNumbers: ['199'], coverageOriginBlock: '50', safeHead: '199',
      stream: 'live' }), /nonce is missing/);
  });

  it('parses bounded CLI options and prints the report', async () => {
    assert.deepEqual(parseArgs(['--blocks=100', '--min-transactions=2']), {
      blocks: 100, minTransactions: 2,
    });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      options: {}, canary: { async inspect() { return { approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
