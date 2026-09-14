const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const v3 = require('../src/services/uniswap-v3-decoder');
const {
  runRepair,
  __private: { parseArgs },
} = require('../src/utils/repair-robinhood-backfill-staging');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;

function range(overrides = {}) {
  return {
    id: '7', from_block: '100', to_block: '109', raw_log_count: 1,
    tracked_log_count: 1, checkpoint_hash: HASH,
    checkpoint_timestamp: new Date('2026-01-01T00:00:00.000Z'),
    staging_count: 0, total_broken: 1, ...overrides,
  };
}

function rawLog() {
  return {
    transactionHash: TX, logIndex: '0x1', blockNumber: '0x65', blockHash: HASH,
    transactionIndex: '0x0', address: ADDRESS, topics: [v3.TOPICS.swap], data: '0x',
  };
}

function dependencies(overrides = {}) {
  const sourceRange = range(overrides.range);
  return {
    repository: {
      listBrokenRanges: async () => [sourceRange],
      listPoolsForLogs: async () => [{
        protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:test',
        pool_address: ADDRESS,
      }],
    },
    rpc: {
      requestProvider: async (_provider, method) => {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getLogs') return [rawLog()];
        return { number: '0x6d', hash: HASH, timestamp: '0x6955b900' };
      },
    },
  };
}

describe('Robinhood backfill staging repair', () => {
  it('requires an explicit apply flag and the archive URL contract', () => {
    assert.deepEqual(parseArgs([], {}), { apply: false, rpcUrl: '', maxRanges: 100 });
    assert.deepEqual(parseArgs(['--apply'], { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive' }), {
      apply: true, rpcUrl: 'http://archive', maxRanges: 100,
    });
    assert.throws(() => parseArgs(['--apply=false'], {}), /does not accept a value/);
  });

  it('validates the complete archive evidence without writing in dry-run', async () => {
    let written = false;
    const deps = dependencies();
    deps.capture = { restoreCapturedMarketRanges: async () => { written = true; } };

    const result = await runRepair({ apply: false, rpcUrl: 'http://archive', maxRanges: 100 }, deps);

    assert.deepEqual(result, {
      mode: 'dry-run', ranges: 1, logs: 1, firstBlock: '100', lastBlock: '109',
    });
    assert.equal(written, false);
  });

  it('writes only after validation and forwards the original manifest identity', async () => {
    const deps = dependencies();
    let received;
    deps.capture = {
      restoreCapturedMarketRanges: async (repairs) => {
        received = repairs;
        return { ranges: 1, insertedLogs: 1 };
      },
    };
    const result = await runRepair({ apply: true, rpcUrl: 'http://archive', maxRanges: 100 }, deps);

    assert.equal(received[0].rangeId, '7');
    assert.equal(received[0].logs[0].marketKey, 'robinhood:uniswap-v3:test');
    assert.equal(result.insertedLogs, 1);
  });

  it('fails closed before writing when tracked counts differ', async () => {
    const deps = dependencies({ range: { tracked_log_count: 2 } });
    let written = false;
    deps.capture = { restoreCapturedMarketRanges: async () => { written = true; } };

    await assert.rejects(
      runRepair({ apply: true, rpcUrl: 'http://archive', maxRanges: 100 }, deps),
      /tracked log count does not match/
    );
    assert.equal(written, false);
  });
});
