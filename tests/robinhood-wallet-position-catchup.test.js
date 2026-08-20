const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletPositionCatchup,
} = require('../src/services/robinhood-wallet-position-catchup');
const {
  CONFIRM_FLAG, buildRuntime, main, parseArgs,
} = require('../src/utils/catch-up-robinhood-wallet-positions');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const POOL = `0x${'4'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'d'.repeat(64)}`;
const BLOCK_HASH = `0x${'c'.repeat(64)}`;

function transfer(overrides = {}) {
  return {
    blockNumber: '90', blockTime: '2026-01-01T00:00:00.000Z',
    blockHash: BLOCK_HASH, transactionHash: HASH_A, transactionIndex: '0', logIndex: '1',
    tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw: '10', ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = {
    evidence: [], hydration: [], initialized: [], committed: [], resolved: [],
  };
  const transferCursor = {
    projectionVersion: 'rh_transfer_v1', stream: 'seed', originBlock: '90',
    nextBlock: '92', safeHead: '200', checkpointBlock: '91', checkpointHash: BLOCK_HASH,
    lifecycleState: 'running', version: 2, ...overrides.transferCursor,
  };
  const captured = {
    fromBlock: '90', toBlock: '91', nextBlock: '92', scopeTokens: 1,
    fromBlockTime: '2026-01-01T00:00:00.000Z',
    checkpoint: { number: '91', hash: BLOCK_HASH, blockTime: '2026-01-01T00:01:00.000Z' },
    transfers: [
      transfer(),
      transfer({
        blockNumber: '91', blockTime: '2026-01-01T00:01:00.000Z',
        transactionHash: HASH_B, transactionIndex: '1', logIndex: '2',
        fromWallet: POOL, toWallet: ALICE, amountRaw: '5',
      }),
    ],
    telemetry: { requests: 1 },
  };
  const deps = {
    transferProjection: { loadCursor: async () => transferCursor },
    positionProjection: {
      loadCursor: async (_version, stream) => (
        overrides.positionCursors
          ? (overrides.positionCursors[stream] || null)
          : (overrides.positionCursor || null)
      ),
      initCursor: async (input) => {
        calls.initialized.push(input);
        return { ...input, lifecycleState: 'pending', version: 0 };
      },
      readUnifiedRangeSwaps: async () => [{
        block_number: '91', transaction_hash: HASH_C, action_index: '3',
        token_address: TOKEN, wallet_address: ALICE, token_amount_raw: '5',
        side: 'buy', volume_usd: '10', market_cap_usd: '1000',
      }],
      loadPositions: async () => [],
      commitBatch: async (input) => {
        calls.committed.push(input);
        return { committed: true, cursor: { nextBlock: input.nextBlock } };
      },
    },
    transactionPositions: { resolveSwaps: async (swaps, input) => {
      calls.resolved.push({ swaps, input });
      return {
        swaps: swaps.map((swap) => ({ ...swap, transaction_index: '2' })),
        telemetry: { required: 1, resolved: 1, persisted: input.commit ? 1 : 0 },
      };
    } },
    source: {
      listTrackedTokenAddresses: async () => [TOKEN],
      loadBackfillRangeContext: async () => ({
        ready: true, poolAddresses: [POOL], routerAddresses: [],
        contractAddresses: [], walletAddresses: [ALICE, BOB], endpointRoleCoverage: {},
      }),
    },
    evidence: {
      matchesCheckpoint: async () => overrides.canonical !== false,
      readRange: async (input) => { calls.evidence.push(input); return captured; },
    },
    endpointRoles: { hydrate: async (input) => {
      calls.hydration.push(input);
      return { contractAddresses: [], walletAddresses: [], probes: 0, resolved: 0, persisted: 0 };
    } },
    classifierFactory: () => ({ classify: (event) => ({
      kind: event.transactionHash === HASH_A ? 'wallet_transfer' : 'dex_flow',
      classificationVersion: 'rh_transfer_v1',
    }) }),
  };
  return { calls, deps };
}

describe('Robinhood unified wallet-position catch-up', () => {
  it('previews the exact unprojected transfer frontier without writing', async () => {
    const test = harness();
    const result = await runRobinhoodWalletPositionCatchup(test.deps, { maxBlocks: 500 });
    assert.equal(result.status, 'dry-run');
    assert.deepEqual([result.fromBlock, result.toBlock, result.targetNextBlock], ['90', '91', '92']);
    assert.equal(result.swaps, 1);
    assert.deepEqual(test.calls.resolved[0].input, { commit: false });
    assert.equal(test.calls.hydration[0].commit, false);
    assert.equal(test.calls.initialized.length, 0);
    assert.equal(test.calls.committed.length, 0);
  });

  it('initializes the proven origin and commits only the financial cursor', async () => {
    const test = harness();
    const result = await runRobinhoodWalletPositionCatchup(test.deps, {
      maxBlocks: 500, commit: true,
    });
    assert.equal(result.status, 'caught-up');
    assert.equal(test.calls.hydration[0].commit, true);
    assert.deepEqual(test.calls.initialized[0], {
      projectionVersion: 'unified_transfer_v1', stream: 'seed', originBlock: '90',
      nextBlock: '90', nextBlockTime: '2026-01-01T00:00:00.000Z', safeHead: '200',
    });
    assert.equal(test.calls.committed[0].expectedVersion, 0);
    assert.equal(test.calls.committed[0].nextBlock, '92');
    assert.equal(test.calls.committed[0].positions.length, 2);
    assert.deepEqual(test.calls.resolved[0].input, { commit: true });
  });

  it('fails closed on missing position origin or a non-canonical transfer checkpoint', async () => {
    const missing = harness({ positionCursor: {
      originBlock: null, nextBlock: '90', safeHead: '200', lifecycleState: 'running', version: 0,
    } });
    assert.equal((await runRobinhoodWalletPositionCatchup(missing.deps)).reason,
      'position_origin_missing');
    const orphaned = harness({ canonical: false });
    assert.equal((await runRobinhoodWalletPositionCatchup(orphaned.deps)).reason,
      'transfer_checkpoint_mismatch');
    assert.equal(orphaned.calls.evidence.length, 0);
  });

  it('hands a complete seed off to the LIVE position cursor', async () => {
    const test = harness({
      transferCursor: { stream: 'live' },
      positionCursors: {
        seed: {
          originBlock: '1', nextBlock: '90', safeHead: '89',
          lifecycleState: 'complete', version: 5,
        },
      },
    });
    const result = await runRobinhoodWalletPositionCatchup(test.deps, {
      stream: 'live', maxBlocks: 500, commit: true,
    });

    assert.equal(result.status, 'caught-up');
    assert.equal(result.stream, 'live');
    assert.deepEqual(test.calls.initialized[0], {
      projectionVersion: 'unified_transfer_v1', stream: 'live', originBlock: '90',
      nextBlock: '90', nextBlockTime: '2026-01-01T00:00:00.000Z', safeHead: '200',
    });
    assert.equal(test.calls.committed[0].stream, 'live');
  });

  it('blocks a LIVE catch-up when the seed handoff is discontinuous', async () => {
    const test = harness({
      transferCursor: { stream: 'live', originBlock: '91' },
      positionCursors: {
        seed: {
          originBlock: '1', nextBlock: '90', safeHead: '89',
          lifecycleState: 'complete', version: 5,
        },
      },
    });
    const result = await runRobinhoodWalletPositionCatchup(test.deps, { stream: 'live' });

    assert.deepEqual(result, { status: 'blocked', reason: 'seed_live_handoff_mismatch' });
    assert.equal(test.calls.evidence.length, 0);
  });
});

describe('Robinhood unified wallet-position catch-up command', () => {
  it('requires Stage 137 and composes archive evidence with the position repository', async () => {
    const database = { query: async () => ({
      rows: [{ ready: true, transaction_positions: 'robinhood_transaction_positions' }],
    }) };
    const transferProjection = { loadCursor: async () => null };
    const positionProjection = { loadCursor: async () => null };
    const archiveRpcClient = { requestBatch: async () => [] };
    const transactionPositionRepository = { upsertPositions: async () => ({ persisted: 0 }) };
    const transactionPositions = { resolveSwaps: async () => ({ swaps: [], telemetry: {} }) };
    const runtime = await buildRuntime({}, {
      database,
      transferRuntimeFactory: async (_options, deps) => {
        assert.equal(deps.database, database);
        return {
          providerChainIds: { archive: '4663' },
          archiveRpcClient,
          tickDeps: { projection: transferProjection, evidence: { readRange: async () => null } },
        };
      },
      positionRepositoryFactory: (options) => {
        assert.equal(options.database, database);
        return positionProjection;
      },
      transactionPositionRepositoryFactory: (options) => {
        assert.equal(options.database, database);
        return transactionPositionRepository;
      },
      transactionPositionResolverFactory: (options) => {
        assert.deepEqual(options, {
          rpcClient: archiveRpcClient, repository: transactionPositionRepository,
        });
        return transactionPositions;
      },
    });
    assert.equal(runtime.catchupDeps.transferProjection, transferProjection);
    assert.equal(runtime.catchupDeps.positionProjection, positionProjection);
    assert.equal(runtime.catchupDeps.transactionPositions, transactionPositions);
    await assert.rejects(buildRuntime({}, {
      database: { query: async () => ({ rows: [{ ready: false }] }) },
    }), /Stage 137/);
    await assert.rejects(buildRuntime({}, {
      database: { query: async () => ({ rows: [{ ready: true, transaction_positions: null }] }) },
    }), /Stage 139/);
  });

  it('is dry-run-first and requires the long confirmation flag', async () => {
    assert.deepEqual(parseArgs(['--max-blocks=500']), {
      confirm: false, maxBlocks: 500, maxRanges: 1, stream: 'seed',
    });
    assert.deepEqual(parseArgs(['--stream=live']), {
      confirm: false, maxBlocks: 500, maxRanges: 1, stream: 'live',
    });
    assert.throws(() => parseArgs(['--stream=other']), /seed or live/);
    assert.throws(() => parseArgs(['--max-ranges=2']), /confirmation flag/);
    assert.throws(() => parseArgs(['--commit']), /unknown argument/);
    const calls = [];
    const deps = {
      runtime: { providerChainIds: { archive: '4663' }, catchupDeps: { marker: true } },
      runCatchup: async (_runtime, input) => { calls.push(input); return { status: 'ok' }; },
      logger: { log: () => {} },
    };
    assert.equal((await main([], deps)).mode, 'dry-run');
    const confirmed = await main([CONFIRM_FLAG, '--stream=live'], deps);
    assert.equal(confirmed.mode, 'commit-bounded-range');
    assert.equal(confirmed.stream, 'live');
    assert.deepEqual(calls, [
      { maxBlocks: 500, commit: false, stream: 'seed' },
      { maxBlocks: 500, commit: true, stream: 'live' },
    ]);
  });

  it('loops confirmed ranges until the LIVE gap is caught up', async () => {
    const statuses = ['projected', 'projected', 'caught-up'];
    const deps = {
      runtime: { providerChainIds: { archive: '4663' }, catchupDeps: {} },
      runCatchup: async () => ({ status: statuses.shift() }),
      logger: { log: () => {} },
    };
    const report = await main([
      CONFIRM_FLAG, '--stream=live', '--max-ranges=10',
    ], deps);

    assert.equal(report.rangesProcessed, 3);
    assert.equal(report.result.status, 'caught-up');
  });
});
