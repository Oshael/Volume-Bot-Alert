const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodTokenAttributionRepository } = require('../src/models/robinhood-token-attribution');
const {
  CONFIRM, parseArgs, run,
} = require('../src/utils/backfill-robinhood-launchpad-creators');
const { PONS_TOKEN_LAUNCHED_TOPIC } = require('../src/services/robinhood-launchpad-creator-adapter');

const FACTORY = '0x0c37a24f5d23a486fa692d1500881d698b1f77a4';
const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const HASH = `0x${'c'.repeat(64)}`;

function log(block = 100) {
  return {
    address: FACTORY,
    topics: [PONS_TOKEN_LAUNCHED_TOPIC, `0x${'0'.repeat(24)}${TOKEN.slice(2)}`,
      `0x${'0'.repeat(24)}${CREATOR.slice(2)}`, `0x${'d'.repeat(64)}`],
    data: `0x${'0'.repeat(448)}`,
    transactionHash: `0x${'e'.repeat(64)}`,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: HASH,
  };
}

const options = (overrides = {}) => ({
  apply: false, fromBlock: 100n, toBlock: 109n, confirmations: 0,
  rangeSize: 10, minRangeSize: 1, maxRanges: 1, ...overrides,
});

describe('Robinhood launchpad creator backfill', () => {
  it('is dry-run by default and scans without creating or advancing a cursor', async () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs([CONFIRM]).apply, true);
    const filters = [];
    const client = { request: async (method, params) => {
      if (method === 'eth_blockNumber') return '0x6d';
      filters.push(params[0]);
      return [log()];
    } };
    const repository = {
      loadLaunchpadBackfillCursor: async () => null,
      initializeLaunchpadBackfillCursor: async () => { throw new Error('dry-run wrote cursor'); },
      recordLaunchpadBackfillRange: async () => { throw new Error('dry-run wrote attribution'); },
    };
    const result = await run({ options: options(), client, repository, validateChainIds: async () => {} });
    assert.deepEqual([result.status, result.events, result.attributed, result.nextBlock], ['complete', 1, 0, '110']);
    assert.deepEqual([filters[0].fromBlock, filters[0].toBlock], ['0x64', '0x6d']);
  });

  it('shrinks a rejected range and persists its checkpoint for resume', async () => {
    let logRequests = 0;
    let persisted;
    const client = { request: async (method, params) => {
      if (method === 'eth_blockNumber') return '0x6d';
      if (method === 'eth_getLogs') {
        logRequests += 1;
        if (logRequests === 1) throw new Error('range too large');
        return [log()];
      }
      return { number: params[0], hash: HASH, timestamp: '0x1' };
    } };
    const repository = {
      loadLaunchpadBackfillCursor: async () => ({ next_block: '100', checkpoint_block: null }),
      recordLaunchpadBackfillRange: async (input) => {
        persisted = input;
        return { attributed: input.deployments.length };
      },
    };
    const result = await run({
      options: options({ apply: true }), client, repository, validateChainIds: async () => {},
    });
    assert.deepEqual([result.status, result.adaptiveSplits, result.nextBlock], ['limited', 1, '105']);
    assert.deepEqual([persisted.fromBlock, persisted.toBlock, persisted.deployments[0].creatorAddress],
      ['100', '104', CREATOR]);
  });

  it('commits range attribution and cursor advancement atomically', async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return sql.startsWith('UPDATE') ? { rowCount: 1, rows: [{}] } : { rows: [] };
      },
      release: () => {},
    };
    const repository = createRobinhoodTokenAttributionRepository({
      database: { getClient: async () => client },
    });
    await repository.recordLaunchpadBackfillRange({
      fromBlock: '100', toBlock: '104', safeHead: '109', checkpointHash: HASH,
      checkpointTimestamp: '2026-08-10T00:00:00.000Z', deployments: [{
        ...log(), tokenAddress: TOKEN, creatorAddress: CREATOR,
        factoryAddress: FACTORY, source: 'launchpad_event',
      }],
    });
    assert.deepEqual(calls.map(({ sql }) => sql.split(/\s+/)[0]), ['BEGIN', 'INSERT', 'UPDATE', 'COMMIT']);
    assert.match(calls[2].sql, /stream = 'launchpad_backfill'/);
    assert.equal(calls[1].params[5][0], '100');
  });
});
