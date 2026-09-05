'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalLiquidityScanner,
} = require('../src/services/robinhood-canonical-liquidity-scanner');

const HASH = `0x${'1'.repeat(64)}`;

function fixture(overrides = {}, options = {}) {
  const calls = [];
  const range = overrides.range || {
    status: 'available', fromBlock: '100', toBlock: '109', safeHead: '150',
    logs: [{ address: `0x${'2'.repeat(40)}`, topics: [] }],
    checkpoint: { number: '109', hash: HASH, timestampMs: 1000 },
  };
  const pools = overrides.pools || [
    { protocol: 'uniswap-v3', marketKey: 'robinhood:uniswap-v3:pool' },
  ];
  const deps = {
    cursorRepository: {
      async loadCursor() {
        calls.push({ operation: 'loadCursor' });
        return overrides.cursor === undefined ? { nextBlock: '100' } : overrides.cursor;
      },
    },
    source: {
      async readNextRange(input) {
        calls.push({ operation: 'readNextRange', input });
        return range;
      },
    },
    poolRepository: {
      async listPoolsForLiquidityEvents(logs) {
        calls.push({ operation: 'listPoolsForLiquidityEvents', logs });
        return pools;
      },
    },
    refreshQueue: {
      async commitScannedRange(input) {
        calls.push({ operation: 'commitScannedRange', input });
        return { queued: pools.length, nextBlock: input.nextBlock };
      },
    },
  };
  return {
    calls,
    scanner: createRobinhoodCanonicalLiquidityScanner(deps, options),
  };
}

describe('Robinhood canonical liquidity scanner', () => {
  it('resolves affected pools and atomically commits the scanned range', async () => {
    const { calls, scanner } = fixture();
    assert.deepEqual(await scanner.scanNextRange(), {
      status: 'scanned', fromBlock: '100', toBlock: '109', nextBlock: '110',
      safeHead: '150', blocks: 10, logs: 1, affected: 1, queued: 1,
    });
    assert.deepEqual(calls.map(({ operation }) => operation), [
      'loadCursor', 'readNextRange', 'listPoolsForLiquidityEvents', 'commitScannedRange',
    ]);
    assert.deepEqual(calls[1].input, { fromBlock: '100', maxBlocks: 1000 });
    assert.deepEqual(calls[3].input, {
      fromBlock: '100', nextBlock: '110', safeHead: '150',
      checkpoint: { number: '109', hash: HASH, timestampMs: 1000 },
      pools: [{ protocol: 'uniswap-v3', marketKey: 'robinhood:uniswap-v3:pool' }],
    });
  });

  it('advances an empty journal range without queueing pools', async () => {
    const { calls, scanner } = fixture({ pools: [], range: {
      status: 'available', fromBlock: '100', toBlock: '104', safeHead: '150',
      logs: [], checkpoint: { number: '104', hash: HASH, timestampMs: null },
    } }, { maxBlocks: 5 });
    const result = await scanner.scanNextRange();
    assert.equal(result.nextBlock, '105');
    assert.equal(result.blocks, 5);
    assert.equal(result.queued, 0);
    assert.deepEqual(calls[1].input, { fromBlock: '100', maxBlocks: 5 });
    assert.equal(calls.at(-1).operation, 'commitScannedRange');
  });

  it('does not resolve or commit work after reaching the safe head', async () => {
    const { calls, scanner } = fixture({ range: {
      status: 'caught_up', fromBlock: '100', toBlock: null, safeHead: '99',
      logs: [], checkpoint: null,
    } });
    assert.deepEqual(await scanner.scanNextRange(), {
      status: 'caught_up', nextBlock: '100', safeHead: '99', blocks: 0,
      logs: 0, affected: 0, queued: 0,
    });
    assert.deepEqual(calls.map(({ operation }) => operation), ['loadCursor', 'readNextRange']);
  });

  it('fails closed without a cursor or on invalid configuration', async () => {
    const missing = fixture({ cursor: null });
    await assert.rejects(
      missing.scanner.scanNextRange(),
      (error) => error.code === 'liquidity_event_cursor_missing'
    );
    assert.throws(() => fixture({}, { maxBlocks: 1001 }), /maxBlocks/);
    assert.throws(() => createRobinhoodCanonicalLiquidityScanner(), /dependencies/);
  });
});
