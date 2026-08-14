const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletTransferLiveTick,
} = require('../src/services/robinhood-wallet-transfer-live-tick');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const TIME = '2099-01-01T00:00:00.000Z';

function cursor(overrides = {}) {
  return {
    projectionVersion: 'rh_transfer_v1', stream: 'live', nextBlock: '100',
    nextBlockTime: TIME, safeHead: '100', checkpointBlock: null,
    checkpointHash: null, lifecycleState: 'running', version: 0, ...overrides,
  };
}

function captured() {
  return {
    fromBlock: '100', toBlock: '100', nextBlock: '101', scopeTokens: 1,
    checkpoint: { number: '100', hash: HASH, blockTime: TIME },
    transfers: [{
      blockNumber: '100', blockHash: HASH, blockTime: TIME,
      transactionHash: TX, transactionIndex: 1, logIndex: 2,
      tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw: '25',
    }],
    telemetry: { requests: 1, evidenceBatches: 1 },
  };
}

function dependencies(overrides = {}) {
  const calls = { contexts: [], evidence: [], initialized: [], raw: [], projected: [] };
  const currentCursor = overrides.cursor === undefined ? cursor() : overrides.cursor;
  return {
    calls,
    source: {
      loadSwapFrontier: async () => overrides.frontier || ({
        ready: true, completeThroughBlock: '100', reason: null,
      }),
      listTrackedTokenAddresses: async () => [TOKEN],
      loadRangeContext: async (input) => {
        calls.contexts.push(input);
        return overrides.context || {
          ready: true, swapCoverageComplete: true, swaps: [], poolAddresses: [],
          routerAddresses: [], walletAddresses: [ALICE, BOB],
        };
      },
    },
    evidence: {
      matchesCheckpoint: async () => overrides.canonical !== false,
      readRange: async (input) => { calls.evidence.push(input); return captured(); },
    },
    projection: {
      loadCursor: async () => currentCursor,
      initCursor: async (input) => { calls.initialized.push(input); return cursor(); },
      commitBatch: async (input) => {
        calls.projected.push(input);
        return overrides.projected || { committed: true, edgeGroups: 1, evidenceCandidates: 3 };
      },
    },
    raw: {
      insertTransferEvents: async (events) => { calls.raw.push(events); return { inserted: events.length }; },
    },
  };
}

describe('Robinhood wallet transfer LIVE tick', () => {
  it('classifies, persists raw evidence and atomically advances edge projection', async () => {
    const deps = dependencies();
    const result = await runRobinhoodWalletTransferLiveTick(deps, { maxBlocks: 25 });

    assert.equal(result.status, 'projected');
    assert.deepEqual(result.classifications, { wallet_transfer: 1 });
    assert.equal(result.rawInserted, 1);
    assert.equal(deps.calls.raw[0][0].transferKind, 'wallet_transfer');
    assert.equal(deps.calls.projected[0].events.length, 1);
    assert.deepEqual(deps.calls.evidence[0], {
      tokenAddresses: [TOKEN], fromBlock: '100', toBlock: '100',
    });
    assert.deepEqual(deps.calls.contexts[0], {
      fromBlock: '100', toBlock: '100', fromTime: TIME, toTime: TIME,
      transactionHashes: [TX], endpointAddresses: [ALICE, BOB],
    });
  });

  it('bootstraps at one proven source block instead of inventing historical coverage', async () => {
    const deps = dependencies({ cursor: null });
    const result = await runRobinhoodWalletTransferLiveTick(deps, { maxBlocks: 250 });

    assert.equal(result.status, 'projected');
    assert.equal(deps.calls.initialized.length, 1);
    assert.deepEqual(deps.calls.initialized[0], {
      projectionVersion: 'rh_transfer_v1', stream: 'live', nextBlock: '100',
      nextBlockTime: TIME, safeHead: '100',
    });
    assert.equal(deps.calls.evidence[0].fromBlock, '100');
    assert.equal(deps.calls.evidence[0].toBlock, '100');
  });

  it('blocks on a non-canonical checkpoint before reading or writing a range', async () => {
    const deps = dependencies({
      canonical: false,
      cursor: cursor({ checkpointBlock: '99', checkpointHash: HASH }),
    });
    const result = await runRobinhoodWalletTransferLiveTick(deps);

    assert.deepEqual(result, { status: 'blocked', reason: 'checkpoint_mismatch' });
    assert.equal(deps.calls.evidence.length, 0);
    assert.equal(deps.calls.raw.length, 0);
  });

  it('stores insufficient endpoint evidence as unknown without creating an edge', async () => {
    const deps = dependencies({ context: {
      ready: true, swapCoverageComplete: true, swaps: [], poolAddresses: [],
      routerAddresses: [], walletAddresses: [ALICE],
    } });
    const result = await runRobinhoodWalletTransferLiveTick(deps);

    assert.deepEqual(result.classifications, { unknown: 1 });
    assert.equal(deps.calls.raw[0][0].transferKind, 'unknown');
    assert.deepEqual(deps.calls.projected[0].events, []);
  });

  it('waits without side effects for source or classification coverage', async () => {
    const unavailable = dependencies({ frontier: { ready: false, reason: 'swap_live_missing' } });
    assert.deepEqual(await runRobinhoodWalletTransferLiveTick(unavailable), {
      status: 'awaiting-source', reason: 'swap_live_missing',
    });
    const uncovered = dependencies({ context: {
      ready: false, reason: 'swap_coverage_incomplete', completeThroughBlock: '99',
    } });
    assert.deepEqual(await runRobinhoodWalletTransferLiveTick(uncovered), {
      status: 'awaiting-context', reason: 'swap_coverage_incomplete', completeThroughBlock: '99',
    });
    assert.equal(uncovered.calls.raw.length, 0);
  });

  it('rejects a projection cursor ahead of the durable source', async () => {
    const deps = dependencies({ cursor: cursor({ nextBlock: '102' }) });
    await assert.rejects(
      runRobinhoodWalletTransferLiveTick(deps),
      (error) => error.code === 'transfer_source_frontier_regressed'
    );
  });
});
