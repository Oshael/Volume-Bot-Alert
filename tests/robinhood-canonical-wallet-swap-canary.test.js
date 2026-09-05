'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalBlockSource,
  __private: { buildBlock },
} = require('../src/models/robinhood-canonical-block-source');
const {
  compareGroup, createRobinhoodCanonicalWalletSwapCanary,
} = require('../src/services/robinhood-canonical-wallet-swap-canary');
const {
  main, parseArgs,
} = require('../src/utils/audit-robinhood-canonical-wallet-swap-canary');

const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const TX_HASH = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'c'.repeat(40)}`;

function block(overrides = {}) {
  return {
    number: '0x64', hash: BLOCK_HASH, timestamp: '0x60000000',
    transactions: [{ hash: TX_HASH, from: WALLET, transactionIndex: '0x0' }],
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    block_number: '100', transaction_hash: TX_HASH, log_index: '7', ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    ready: true, blockers: [], capture: { safe_head: '100' },
    processing: { processable_through_block: '100' },
    wallet: { checkpoint_block: '100' },
    handoff: { journal_start_block: '50' },
    ...overrides,
  };
}

describe('Robinhood canonical wallet-swap canary', () => {
  it('adapts a canonical block and its ordered transactions to the RPC contract', () => {
    const built = buildBlock([{
      block_number: '100', block_hash: BLOCK_HASH,
      block_timestamp: '2021-01-14T08:25:36.000Z',
      transaction_hash: TX_HASH, transaction_index: 0, from_address: WALLET,
    }]);
    assert.deepEqual(built, block());
  });

  it('loads only the requested canonical block in transaction order', async () => {
    const queries = [];
    const source = createRobinhoodCanonicalBlockSource({
      database: {
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [{
            block_number: '100', block_hash: BLOCK_HASH,
            block_timestamp: '2021-01-14T08:25:36.000Z',
            transaction_hash: TX_HASH, transaction_index: 0, from_address: WALLET,
          }] };
        },
      },
    });
    assert.deepEqual(await source.loadBlock('100'), block());
    assert.deepEqual(queries[0].params, ['robinhood', '100']);
    assert.match(queries[0].sql, /canonical=TRUE/);
    assert.match(queries[0].sql, /ORDER BY transaction\.transaction_index/);
  });

  it('compares sender, transaction position and canonical block identity', () => {
    assert.deepEqual(compareGroup([observation()], block(), block()), [{
      identity: `${TX_HASH}:7`, missing_legacy: false, missing_canonical: false, fields: [],
    }]);
    const changed = compareGroup([observation()], block(), block({
      transactions: [{ hash: TX_HASH, from: `0x${'d'.repeat(40)}`, transactionIndex: '0x0' }],
    }));
    assert.deepEqual(changed[0].fields, ['wallet']);
  });

  it('approves matching recent observations without writing', async () => {
    const reads = [];
    const canary = createRobinhoodCanonicalWalletSwapCanary({
      readiness: { async inspect() { return preflight(); } },
      reader: {
        async readAcceptedBlockGroups(input) {
          reads.push(input);
          return { groups: [['100', [observation()]]], blockNumbers: ['100'] };
        },
      },
      canonicalSource: { async loadBlock() { return block(); } },
      fetchLegacyBlock: async () => block(),
    });
    const report = await canary.inspect({ blocks: 64, minObservations: 1 });
    assert.equal(report.approved, true);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(reads, [{ fromBlock: '50', toBlock: '100', maxBlocks: 64 }]);
    assert.deepEqual(report.parity, {
      observations: 1, matched: 1, missing_legacy: 0, missing_canonical: 0,
      divergent: 0, source_errors: 0,
      samples: {
        missing_legacy: [], missing_canonical: [], divergent: [], source_errors: [],
      },
    });
  });

  it('blocks divergence, source errors and an unready preflight', async () => {
    const divergent = createRobinhoodCanonicalWalletSwapCanary({
      readiness: { async inspect() { return preflight(); } },
      reader: {
        async readAcceptedBlockGroups() {
          return { groups: [['100', [observation()]]], blockNumbers: ['100'] };
        },
      },
      canonicalSource: { async loadBlock() { return block({ hash: `0x${'d'.repeat(64)}` }); } },
      fetchLegacyBlock: async () => block(),
    });
    assert.deepEqual((await divergent.inspect({ minObservations: 1 })).blockers, [
      { code: 'transaction_context_divergent', detail: 1 },
    ]);

    const unavailable = createRobinhoodCanonicalWalletSwapCanary({
      readiness: { async inspect() { return preflight({ ready: false, blockers: ['lag'] }); } },
      reader: { async readAcceptedBlockGroups() { throw new Error('must not read'); } },
      canonicalSource: { async loadBlock() {} }, fetchLegacyBlock: async () => {},
    });
    assert.equal((await unavailable.inspect()).blockers[0].code, 'preflight_not_ready');
  });

  it('parses CLI bounds and prints its report', async () => {
    assert.deepEqual(parseArgs([]), { blocks: 64, minObservations: 25 });
    assert.deepEqual(parseArgs(['--blocks=8', '--min-observations=2']), {
      blocks: 8, minObservations: 2,
    });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      options: { blocks: 8, minObservations: 2 },
      canary: { async inspect() { return { approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
