const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletTransferBackfillCommit,
  runRobinhoodWalletTransferBackfillDryRun,
  __private: { rangeForPlan, retentionCutoff, summarizeThroughDay },
} = require('../src/services/robinhood-wallet-transfer-backfill-tick');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function transfer(blockNumber, blockTime, logIndex) {
  return {
    blockNumber: String(blockNumber), blockHash: HASH, blockTime,
    transactionHash: `0x${String(logIndex).padStart(64, 'b')}`,
    transactionIndex: logIndex, logIndex, tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '10',
  };
}

function plan(overrides = {}) {
  return {
    ready: true, reason: null, status: 'uninitialized', fromBlock: '90',
    throughBlock: '200', nextBlock: '90', remainingBlocks: '111', seed: null,
    ...overrides,
  };
}

function captured() {
  return {
    fromBlock: '90', fromBlockTime: '2026-07-14T00:00:00.000Z',
    toBlock: '200', nextBlock: '201', scopeTokens: 1,
    checkpoint: { number: '200', hash: HASH, blockTime: '2026-08-14T12:00:00.000Z' },
    transfers: [
      transfer(100, '2026-07-14T12:00:00.000Z', 1),
      transfer(101, '2026-07-14T12:01:00.000Z', 3),
      transfer(200, '2026-08-14T12:00:00.000Z', 2),
    ],
    telemetry: { requests: 1, evidenceBatches: 1 },
  };
}

function dependencies(overrides = {}) {
  const calls = { evidence: [], contexts: [], initialized: [], raw: [], projected: [] };
  return {
    calls,
    source: {
      loadBackfillPlan: async () => overrides.plan || plan(),
      listTrackedTokenAddresses: async () => [TOKEN],
      loadBackfillRangeContext: async (input) => {
        calls.contexts.push(input);
        return overrides.context || {
          ready: true, swaps: [], swapCoverageComplete: true,
          poolAddresses: [], routerAddresses: [], contractAddresses: [],
          walletAddresses: [ALICE, BOB],
          endpointRoleCoverage: { requested: 2, persisted: 1, unpersisted: 1, probes: 0 },
        };
      },
    },
    evidence: {
      matchesCheckpoint: async () => overrides.canonical !== false,
      readRange: async (input) => { calls.evidence.push(input); return captured(); },
    },
    classifierFactory: overrides.classifierFactory,
    raw: {
      insertTransferEvents: async (events) => {
        calls.raw.push(events);
        return { inserted: events.length };
      },
    },
    projection: {
      initCursor: async (input) => {
        calls.initialized.push(input);
        return overrides.initialized || {
          projectionVersion: 'rh_transfer_v1', stream: 'seed', originBlock: '90',
          nextBlock: '90', nextBlockTime: captured().fromBlockTime, safeHead: '200',
          lifecycleState: 'pending', version: 0,
        };
      },
      commitBatch: async (input) => {
        calls.projected.push(input);
        return overrides.projected || {
          committed: true, edgeGroups: 1, evidenceCandidates: 3,
          cursor: { lifecycleState: 'complete' },
        };
      },
    },
  };
}

describe('Robinhood wallet-transfer backfill dry-run tick', () => {
  it('classifies one bounded range and reports raw versus summary-only writes', async () => {
    const deps = dependencies({ classifierFactory: () => ({
      classify: (event) => ({
        kind: event.logIndex === 1 ? 'unknown' : 'wallet_transfer',
        classificationVersion: 'rh_transfer_v1',
      }),
    }) });
    const result = await runRobinhoodWalletTransferBackfillDryRun(deps, {
      maxBlocks: 250, now: '2026-08-14T18:00:00Z',
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.completesSeed, true);
    assert.deepEqual(result.classifications, { unknown: 1, wallet_transfer: 2 });
    assert.equal(result.rawEligible, 1);
    assert.equal(result.summaryOnly, 1);
    assert.equal(result.classificationOnly, 1);
    assert.equal(result.edgeEligible, 2);
    assert.deepEqual(deps.calls.evidence[0], {
      tokenAddresses: [TOKEN], fromBlock: '90', toBlock: '200',
    });
    assert.equal(deps.calls.contexts[0].fromTime, '2026-07-14T00:00:00.000Z');
  });

  it('stops before RPC for blocked, complete or orphaned checkpoint plans', async () => {
    const blocked = dependencies({ plan: plan({ ready: false, reason: 'gap' }) });
    assert.equal((await runRobinhoodWalletTransferBackfillDryRun(blocked)).reason, 'gap');

    const complete = dependencies({ plan: plan({ status: 'complete' }) });
    assert.equal((await runRobinhoodWalletTransferBackfillDryRun(complete)).status, 'complete');

    const orphaned = dependencies({
      canonical: false,
      plan: plan({ seed: { checkpointBlock: '99', checkpointHash: HASH } }),
    });
    assert.equal((await runRobinhoodWalletTransferBackfillDryRun(orphaned)).reason,
      'checkpoint_mismatch');
    assert.equal(orphaned.calls.evidence.length, 0);
  });

  it('does not classify when historical swap context is unavailable', async () => {
    const deps = dependencies({ context: { ready: false, reason: 'swap_coverage_incomplete' } });
    const result = await runRobinhoodWalletTransferBackfillDryRun(deps);
    assert.equal(result.status, 'awaiting-context');
    assert.equal(result.reason, 'swap_coverage_incomplete');
    assert.equal(deps.calls.contexts.length, 1);
  });

  it('bounds ranges and retention by UTC days', () => {
    assert.deepEqual(rangeForPlan(plan(), 25), { fromBlock: '90', toBlock: '114' });
    assert.equal(retentionCutoff('2026-08-14T23:59:59Z').toISOString(),
      '2026-07-15T00:00:00.000Z');
    assert.equal(summarizeThroughDay(
      '2026-07-14T00:00:00Z', '2026-08-14T12:00:00Z'
    ), '2026-08-13');
  });

  it('writes only recent raw events and advances summaries from an exact seed origin', async () => {
    const deps = dependencies({ classifierFactory: () => ({
      classify: (event) => ({
        kind: event.logIndex === 1 ? 'unknown' : 'wallet_transfer',
        classificationVersion: 'rh_transfer_v1',
      }),
    }) });
    const result = await runRobinhoodWalletTransferBackfillCommit(deps, {
      now: '2026-08-14T18:00:00Z',
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.rawInserted, 1);
    assert.deepEqual(deps.calls.initialized[0], {
      projectionVersion: 'rh_transfer_v1', stream: 'seed', originBlock: '90',
      nextBlock: '90', nextBlockTime: '2026-07-14T00:00:00.000Z', safeHead: '200',
    });
    assert.equal(deps.calls.raw[0][0].logIndex, 2);
    assert.deepEqual(deps.calls.projected[0].events.map(({ logIndex }) => logIndex), [3, 2]);
    assert.equal(deps.calls.projected[0].summarizedThroughDay, '2026-08-13');
  });

  it('does not write raw when cursor initialization races with another seed writer', async () => {
    const deps = dependencies({ initialized: {
      stream: 'seed', originBlock: '90', nextBlock: '91',
      nextBlockTime: captured().fromBlockTime, safeHead: '200',
      lifecycleState: 'running', version: 1,
    } });
    const result = await runRobinhoodWalletTransferBackfillCommit(deps, {
      now: '2026-08-14T18:00:00Z',
    });
    assert.equal(result.status, 'cursor-conflict');
    assert.equal(deps.calls.raw.length, 0);
    assert.equal(deps.calls.projected.length, 0);
  });
});
