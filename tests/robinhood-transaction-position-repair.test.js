const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodTransactionPositionRepairRepository,
} = require('../src/models/robinhood-transaction-position-repair');
const {
  executeRepair, runPreflight,
} = require('../src/services/robinhood-transaction-position-repair');
const {
  parseArgs,
} = require('../src/utils/repair-robinhood-transaction-positions');

const TX = `0x${'a'.repeat(64)}`;

function row(range) {
  return { transaction_hash: TX, block_number: range.rangeStart.includes('T00:') ? '1' : '2' };
}

describe('Robinhood transaction-position repair', () => {
  it('selects bounded missing registered swaps from either side', async () => {
    const calls = [];
    const repository = createRobinhoodTransactionPositionRepairRepository({
      database: { queryWithStatementTimeout: async (...args) => {
        calls.push(args);
        return { rows: [{ transaction_hash: TX, block_number: 9 }] };
      } },
    });
    const result = await repository.listMissing({
      rangeStart: '2026-01-01T00:00:00Z', rangeEnd: '2026-01-01T01:00:00Z', limit: 50,
    });

    assert.deepEqual(result, [{
      transaction_hash: TX, block_number: '9', transaction_index: null,
    }]);
    assert.match(calls[0][0], /registry\.discovery_block <= swap\.block_number/);
    assert.match(calls[0][0], /position\.transaction_hash IS NULL/);
    assert.doesNotMatch(calls[0][0], /swap\.side\s*=\s*'buy'/);
    assert.deepEqual(calls[0][1], [
      'robinhood', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 50,
    ]);
  });

  it('preflights read-only and repairs every planned range idempotently', async () => {
    let clock = 0;
    const source = { listMissing: async (range) => [row(range)] };
    const dryResolver = { resolveSwaps: async (items, input) => {
      assert.notEqual(input.commit, true);
      return { telemetry: {
        required: items.length, rpcBlocks: 1, rpcBatches: 1, persisted: 0,
      } };
    } };
    const options = {
      sourceFrom: '2026-01-01T00:00:00Z', sourceThrough: '2026-01-01T02:00:00Z',
      rangeSeconds: 3600, sampleCount: 2, concurrency: 2, batchSize: 10, maxHours: 5,
    };
    const preflight = await runPreflight({
      source, resolver: dryResolver, now: () => { clock += 1000; return clock; },
    }, options);
    assert.equal(preflight.approved, true);
    assert.equal(preflight.sampleTransactions, 2);

    const repaired = new Set();
    const commitSource = { listMissing: async (range) => (
      repaired.has(range.rangeStart) ? [] : [row(range)]
    ) };
    const commitResolver = { resolveSwaps: async (items, input) => {
      assert.equal(input.commit, true);
      repaired.add(items[0].block_number === '1'
        ? '2026-01-01T00:00:00.000Z' : '2026-01-01T01:00:00.000Z');
      return { telemetry: {
        required: 1, rpcBlocks: 1, rpcBatches: 1, persisted: 1,
      } };
    } };
    const result = await executeRepair({
      source: commitSource, resolver: commitResolver, now: () => 0,
    }, { preflight, maxMinutes: 1 });

    assert.deepEqual(result, {
      status: 'completed', ranges: 2, transactions: 2, rpcBlocks: 2,
      persisted: 2, totalRanges: 2, resumeFrom: null,
    });
  });

  it('refuses a truncated sample and validates the CLI bounds', async () => {
    const source = { listMissing: async () => [{ transaction_hash: TX, block_number: '1' }] };
    const resolver = { resolveSwaps: async () => ({ telemetry: {
      required: 1, rpcBlocks: 1, rpcBatches: 1, persisted: 0,
    } }) };
    const preflight = await runPreflight({ source, resolver, now: () => 0 }, {
      sourceFrom: '2026-01-01T00:00:00Z', sourceThrough: '2026-01-01T01:00:00Z',
      rangeSeconds: 3600, sampleCount: 1, concurrency: 1, batchSize: 1, maxHours: 5,
    });
    assert.equal(preflight.truncatedSamples, 1);
    assert.equal(preflight.approved, false);
    assert.throws(() => parseArgs([]), /--from and --through are required/);
    assert.equal(parseArgs([
      '--from=2026-01-01T00:00:00Z', '--through=2026-01-02T00:00:00Z', '--apply',
    ]).apply, true);
  });
});
