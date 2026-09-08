const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderGlobalBackfillScanner,
} = require('../src/services/robinhood-holder-global-backfill-scanner');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function runState(nextBlock = '100') {
  return {
    id: '1', status: 'scanning', nextBlock, barrierBlock: null,
  };
}

function range(fromBlock, toBlock, overrides = {}) {
  return {
    fromBlock: String(fromBlock), toBlock: String(toBlock),
    nextBlock: String(BigInt(toBlock) + 1n),
    checkpoint: { number: String(toBlock), hash: HASH },
    transfers: [], telemetry: { requests: 1, splits: 0 }, ...overrides,
  };
}

function adaptiveFixture({ rangeSize = 8, prefetch = 1, read, now } = {}) {
  let nextBlock = '100';
  const commits = [];
  const reads = [];
  const scanner = createRobinhoodHolderGlobalBackfillScanner({
    lifecycleRepository: {
      getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
    },
    commitRepository: {
      commitRange: async (input) => {
        assert.equal(input.fromBlock, nextBlock, 'commits must form a contiguous prefix');
        commits.push(input); nextBlock = input.nextBlock;
        return { status: 'committed', ...input };
      },
      excludeToken: async () => { throw new Error('unexpected exclusion'); },
    },
    reader: {
      getSafeHead: async () => ({ safeHead: '9999' }),
      readReceiptRange: async () => { throw new Error('unexpected receipts'); },
      readGlobalRange: async (input) => {
        reads.push(input);
        return read ? read(input) : range(input.fromBlock, input.toBlock);
      },
    },
    options: { rangeSize, prefetch }, now,
  });
  return { scanner, commits, reads, cursor: () => nextBlock };
}

describe('Robinhood holder global backfill scanner', () => {
  it('commits a valid prefix, halves a timed-out range and resumes without skipping prefetched blocks', async () => {
    let fail = true;
    const fixture = adaptiveFixture({ prefetch: 3, read: (input) => {
      if (fail && input.fromBlock === '108') {
        throw Object.assign(new Error('timeout'), { code: 'timeout' });
      }
      return range(input.fromBlock, input.toBlock);
    } });
    const reduced = await fixture.scanner.runOnce();
    assert.equal(reduced.status, 'range-reduced');
    assert.equal(reduced.rangeSize, 4);
    assert.equal(reduced.committedRanges, 1);
    assert.equal(fixture.cursor(), '108');
    assert.equal(fixture.scanner.getStatus().totals.discardedPrefetch, 1);
    fail = false;
    await fixture.scanner.runOnce();
    assert.equal(fixture.reads[3].fromBlock, '108');
    assert.equal(fixture.reads[3].toBlock, '111');
    assert.equal(fixture.reads[3].deferRangeAdaptation, true);
    assert.equal(fixture.cursor(), '116');
  });

  it('grows after five fast committed ticks, holds after slow reads, and respects the configured ceiling', async () => {
    let clock = 0;
    let fail = true;
    let slow = false;
    const fixture = adaptiveFixture({ now: () => clock, read: (input) => {
      if (fail) throw Object.assign(new Error('timeout'), { code: 'timeout' });
      clock += slow ? 5001 : 100;
      return range(input.fromBlock, input.toBlock);
    } });
    await fixture.scanner.runOnce();
    assert.equal(fixture.cursor(), '100');
    fail = false;
    for (let index = 0; index < 4; index += 1) await fixture.scanner.runOnce();
    assert.equal(fixture.scanner.getStatus().rangeSize, 4);
    slow = true;
    await fixture.scanner.runOnce();
    assert.equal(fixture.scanner.getStatus().healthyRangeBatches, 0);
    slow = false;
    for (let index = 0; index < 5; index += 1) await fixture.scanner.runOnce();
    assert.equal(fixture.scanner.getStatus().rangeSize, 5);
    for (let index = 0; index < 20; index += 1) await fixture.scanner.runOnce();
    assert.equal(fixture.scanner.getStatus().rangeSize, 8);
  });

  it('keeps a failing single block retryable and does not shrink on rate limits or transport errors', async () => {
    for (const [rangeSize, code, method] of [
      [1, 'timeout'], [8, 'rate_limited'], [8, 'transport_error'],
      [8, 'timeout', 'eth_getBlockByNumber'],
    ]) {
      const error = Object.assign(new Error(code), { code, method });
      const fixture = adaptiveFixture({ rangeSize, read: () => { throw error; } });
      await assert.rejects(fixture.scanner.runOnce(), (actual) => actual === error);
      assert.equal(fixture.cursor(), '100');
      assert.equal(fixture.scanner.getStatus().rangeSize, rangeSize);
      assert.equal(fixture.commits.length, 0);
    }
  });

  it('learns from a short failing tail and drains outstanding prefetch before another tick', async () => {
    let release;
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const fixture = adaptiveFixture({ prefetch: 2, read: (input) => {
      if (input.fromBlock === '100') throw Object.assign(new Error('limit'), { code: 'log_range_error' });
      started();
      return new Promise((resolve) => { release = () => resolve(range(input.fromBlock, input.toBlock)); });
    } });
    let settled = false;
    const pending = fixture.scanner.runOnce().then((value) => { settled = true; return value; });
    await waiting;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(fixture.reads.length, 2);
    release();
    await pending;
    assert.equal(fixture.cursor(), '100');
    const tail = adaptiveFixture({ read: () => {
      throw Object.assign(new Error('limit'), { code: 'http_error', httpStatus: 413 });
    } });
    assert.equal((await tail.scanner.runOnce({ throughBlock: 102 })).rangeSize, 1);
  });
  it('prefetches concurrently, commits one atomic batch and resumes from its cursor', async () => {
    let nextBlock = '100';
    const releases = new Map();
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock),
        loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push(input.fromBlock);
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input, runId: '1' };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '129' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: ({ fromBlock, toBlock }) => new Promise((resolve) => {
          releases.set(fromBlock, () => resolve(range(fromBlock, toBlock, {
            telemetry: {
              requests: 1, splits: fromBlock === '110' ? 1 : 0,
              addressSplits: fromBlock === '120' ? 2 : 0,
            },
          })));
        }),
      },
      options: { rangeSize: 10, prefetch: 3 },
    });
    const pending = scanner.runOnce({ throughBlock: 129 });
    await new Promise((resolve) => setImmediate(resolve));
    releases.get('120')();
    releases.get('110')();
    releases.get('100')();
    const result = await pending;

    assert.deepEqual(commits, ['100']);
    assert.equal(result.nextBlock, '130');
    assert.equal(scanner.getStatus().prefetch, 2);
    assert.equal(scanner.getStatus().totals.addressSplits, 2);
    assert.deepEqual(await scanner.runOnce({ throughBlock: 129 }), {
      status: 'caught-up', runId: '1', nextBlock: '130', throughBlock: '129', prefetch: 2,
    });
  });

  it('uses sixteen prefetched ranges while bounding each consolidated commit', async () => {
    let nextBlock = '100';
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push([input.fromBlock, input.toBlock]);
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '80099' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ fromBlock, toBlock }) => range(fromBlock, toBlock),
      },
      options: { rangeSize: 5000, prefetch: 16 },
    });

    const result = await scanner.runOnce({ throughBlock: 80099 });

    assert.deepEqual(commits, [['100', '40099'], ['40100', '80099']]);
    assert.equal(result.ranges, 16);
    assert.equal(result.nextBlock, '80100');
  });

  it('adds cohort tokens to the RPC scope only from their deployment block', async () => {
    const futureToken = `0x${'2'.repeat(40)}`;
    const scopes = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'),
        loadCohort: async () => { throw new Error('unexpected legacy cohort load'); },
        loadCohortSchedule: async () => [
          { tokenAddress: TOKEN, deploymentBlock: '100' },
          { tokenAddress: futureToken, deploymentBlock: '115' },
        ],
      },
      commitRepository: {
        async commitRange(input) { return { status: 'committed', ...input }; },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '119' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ tokenAddresses, fromBlock, toBlock }) => {
          scopes.push({ fromBlock, tokenAddresses });
          return range(fromBlock, toBlock);
        },
      },
      options: { rangeSize: 10, prefetch: 2 },
    });

    await scanner.runOnce({ throughBlock: 119 });

    assert.deepEqual(scopes, [
      { fromBlock: '100', tokenAddresses: [TOKEN] },
      { fromBlock: '110', tokenAddresses: [TOKEN, futureToken] },
    ]);
  });

  it('separates RPC wait from commit time in the last batch telemetry', async () => {
    let clock = 0;
    let releaseFetch;
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          clock += 10;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '109' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: () => new Promise((resolve) => { releaseFetch = resolve; }),
      },
      options: { rangeSize: 10, prefetch: 1 }, now: () => clock,
    });

    const pending = scanner.runOnce({ throughBlock: 109 });
    await new Promise((resolve) => setImmediate(resolve));
    clock += 40;
    releaseFetch(range(100, 109, {
      transfers: [{ tokenAddress: TOKEN }],
      telemetry: { requests: 7, observedLogs: 11, splits: 0 },
    }));
    await pending;

    assert.deepEqual(scanner.getStatus().lastBatch, {
      durationMs: 50, rpcWaitMs: 40, rpcRangeDurationMs: 40,
      maxRpcRangeDurationMs: 40, commitDurationMs: 10, commitPerRangeMs: 10,
      overheadMs: 0,
      rangesPlanned: 1, rangesCommitted: 1, committedBlocks: 10,
      blocksPerSecond: 200, rpcRequests: 7, observedLogs: 11,
      acceptedTransfers: 1,
    });
  });

  it('evaluates commit pressure per range and tolerates marginal timing noise', async () => {
    let clock = 0;
    let nextBlock = '100';
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          clock += 2050;
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '20099' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ fromBlock, toBlock }) => range(fromBlock, toBlock),
      },
      options: { rangeSize: 5000, prefetch: 4, maxCommitMs: 2000 }, now: () => clock,
    });

    await scanner.runOnce({ throughBlock: 20099 });

    assert.equal(scanner.getStatus().prefetch, 4);
    assert.equal(scanner.getStatus().lastBatch.commitDurationMs, 2050);
    assert.equal(scanner.getStatus().lastBatch.commitPerRangeMs, 512.5);
  });

  it('excludes malformed cohort logs without advancing the cursor', async () => {
    const exclusions = [];
    const invalid = new Error('bad topics');
    invalid.code = 'holder_transfer_invalid_log';
    invalid.tokenAddress = TOKEN;
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange() { throw new Error('unexpected commit'); },
        async excludeToken(input) {
          exclusions.push(input);
          return { status: 'excluded', tokenAddress: input.tokenAddress, deletedBalances: 2 };
        },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async () => { throw invalid; },
      },
      options: { prefetch: 1 },
    });
    const result = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(result.status, 'excluded');
    assert.equal(result.committedRanges, 0);
    assert.deepEqual(exclusions, [{
      runId: '1', tokenAddress: TOKEN, reason: 'malformed_transfer_log',
    }]);
  });

  it('keeps a committed prefix and discards prefetch after a middle failure', async () => {
    let nextBlock = '100';
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push(input.fromBlock);
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '129' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ fromBlock, toBlock }) => {
          if (fromBlock === '110') throw new Error('middle fetch failed');
          return range(fromBlock, toBlock);
        },
      },
      options: { rangeSize: 10, prefetch: 3 },
    });
    await assert.rejects(scanner.runOnce({ throughBlock: 129 }), /middle fetch failed/);
    assert.deepEqual(commits, ['100']);
    assert.equal(nextBlock, '110');
    assert.equal(scanner.getStatus().totals.discardedPrefetch, 1);
  });

  it('ramps prefetch while high live lag improves and backs off when it worsens', async () => {
    let nextBlock = '100';
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '1000' }),
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
        readGlobalRange: async ({ fromBlock, toBlock }) => range(fromBlock, toBlock),
      },
      options: { rangeSize: 10, prefetch: 4 },
    });

    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 1000 });
    assert.deepEqual({
      prefetch: scanner.getStatus().prefetch, trend: scanner.getStatus().liveLagTrend,
    }, { prefetch: 1, trend: 'observing' });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 900 });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 800 });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 700 });
    assert.deepEqual({
      prefetch: scanner.getStatus().prefetch,
      stableBatches: scanner.getStatus().stableBatches,
      delta: scanner.getStatus().liveLagDeltaBlocks,
      trend: scanner.getStatus().liveLagTrend,
    }, { prefetch: 2, stableBatches: 0, delta: '-100', trend: 'improving' });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 750 });
    assert.deepEqual({
      prefetch: scanner.getStatus().prefetch, trend: scanner.getStatus().liveLagTrend,
    }, { prefetch: 1, trend: 'worsening' });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 760 });
    assert.deepEqual({
      prefetch: scanner.getStatus().prefetch,
      stableBatches: scanner.getStatus().stableBatches,
      trend: scanner.getStatus().liveLagTrend,
    }, { prefetch: 1, stableBatches: 0, trend: 'steady' });
    await scanner.runOnce({ throughBlock: 1000, liveLagBlocks: 50 });
    assert.deepEqual({
      prefetch: scanner.getStatus().prefetch,
      floor: scanner.getStatus().healthyPrefetchFloor,
      trend: scanner.getStatus().liveLagTrend,
    }, { prefetch: 2, floor: 2, trend: 'healthy' });
  });

  it('falls back to individual ranges when an atomic batch needs receipt repair', async () => {
    let nextBlock = '100';
    const commits = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits.push(`${input.fromBlock}-${input.toBlock}`);
          if (commits.length <= 2) {
            throw Object.assign(new Error('negative'), {
              code: 'holder_negative_balance', tokenAddress: TOKEN,
              failedBlock: '100', fingerprint: `${HASH}:tx:0`,
            });
          }
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input, runId: '1' };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '119' }),
        readGlobalRange: async ({ fromBlock, toBlock }) => range(fromBlock, toBlock, {
          transfers: fromBlock === '100' ? [{ tokenAddress: TOKEN, blockNumber: '100' }] : [],
        }),
        readReceiptRange: async () => ({
          checkpoint: { number: '100', hash: HASH },
          transfers: [{ tokenAddress: TOKEN, blockNumber: '100' }],
        }),
      },
      options: { rangeSize: 10, prefetch: 2 },
    });

    const result = await scanner.runOnce({ throughBlock: 119 });

    assert.equal(result.nextBlock, '120');
    assert.equal(scanner.getStatus().totals.receiptRecoveries, 1);
    assert.deepEqual(commits, ['100-119', '100-109', '100-109', '110-119']);
  });

  it('replaces the suspect token prefix with receipt evidence before committing', async () => {
    const receiptTransfer = { tokenAddress: TOKEN, blockNumber: '100' };
    const calls = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          calls.push(input);
          if (calls.length === 1) {
            const error = new Error('negative');
            error.code = 'holder_negative_balance';
            error.tokenAddress = TOKEN;
            error.failedBlock = '100';
            error.fingerprint = `${HASH}:tx:0`;
            throw error;
          }
          return {
            status: 'committed', fromBlock: input.fromBlock,
            toBlock: input.toBlock, nextBlock: input.nextBlock,
          };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readGlobalRange: async () => range(100, 100, {
          transfers: [{ tokenAddress: TOKEN, blockNumber: '100' }],
        }),
        readReceiptRange: async () => ({
          checkpoint: { number: '100', hash: HASH }, transfers: [receiptTransfer],
        }),
      },
      options: { prefetch: 1 },
    });
    const result = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(result.status, 'committed');
    assert.equal(scanner.getStatus().totals.receiptRecoveries, 1);
    assert.deepEqual(calls[1].transfers, [receiptTransfer]);
  });

  it('chunks receipt verification when a wide scan range finds a late deficit', async () => {
    const receiptRanges = [];
    let commits = 0;
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState('100'), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commits += 1;
          if (commits === 1) {
            throw Object.assign(new Error('negative'), {
              code: 'holder_negative_balance', tokenAddress: TOKEN,
              failedBlock: '4203', fingerprint: `${HASH}:tx:0`,
            });
          }
          return { status: 'committed', ...input };
        },
        async excludeToken() { throw new Error('unexpected exclusion'); },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '5099' }),
        readGlobalRange: async () => range(100, 5099),
        async readReceiptRange(input) {
          receiptRanges.push([input.fromBlock, input.toBlock]);
          assert.ok(BigInt(input.toBlock) - BigInt(input.fromBlock) + 1n <= 1000n);
          return {
            checkpoint: { number: input.toBlock, hash: HASH },
            transfers: [{ tokenAddress: TOKEN, blockNumber: input.toBlock }],
          };
        },
      },
      options: { rangeSize: 5000, prefetch: 1 },
    });

    const result = await scanner.runOnce({ throughBlock: 5099 });

    assert.equal(result.status, 'committed');
    assert.deepEqual(receiptRanges, [
      ['100', '1099'], ['1100', '2099'], ['2100', '3099'],
      ['3100', '4099'], ['4100', '4203'],
    ]);
    assert.equal(scanner.getStatus().totals.receiptRecoveries, 1);
  });

  it('excludes a token that remains negative under canonical receipts', async () => {
    let nextBlock = '100';
    let commitAttempts = 0;
    const exclusions = [];
    const scopes = [];
    const negativeBalance = () => Object.assign(new Error('negative'), {
      code: 'holder_negative_balance', tokenAddress: TOKEN,
      failedBlock: '100', fingerprint: `${HASH}:tx:0`,
    });
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          commitAttempts += 1;
          if (commitAttempts <= 2) throw negativeBalance();
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input, runId: '1' };
        },
        async excludeToken(input) {
          exclusions.push(input);
          return { status: 'excluded', tokenAddress: input.tokenAddress, deletedBalances: 3 };
        },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readGlobalRange: async ({ tokenAddresses }) => {
          scopes.push(tokenAddresses);
          return range(100, 100, {
            transfers: tokenAddresses.includes(TOKEN)
              ? [{ tokenAddress: TOKEN, blockNumber: '100' }] : [],
          });
        },
        readReceiptRange: async () => ({
          checkpoint: { number: '100', hash: HASH },
          transfers: [{ tokenAddress: TOKEN, blockNumber: '100' }],
        }),
      },
      options: { prefetch: 1 },
    });

    const excluded = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(excluded.status, 'excluded');
    assert.equal(excluded.reason, 'receipt_replay_still_negative');
    assert.equal(nextBlock, '100');
    assert.deepEqual(exclusions, [{
      runId: '1', tokenAddress: TOKEN, reason: 'receipt_replay_still_negative',
    }]);

    const resumed = await scanner.runOnce({ throughBlock: 100 });
    assert.equal(resumed.status, 'committed');
    assert.equal(nextBlock, '101');
    assert.deepEqual(scopes, [[TOKEN], []]);
    assert.equal(scanner.getStatus().totals.exclusions, 1);
  });

  it('excludes a uint256 balance overflow without attempting receipt repair', async () => {
    let nextBlock = '100';
    const exclusions = [];
    const scopes = [];
    const scanner = createRobinhoodHolderGlobalBackfillScanner({
      lifecycleRepository: {
        getActiveRun: async () => runState(nextBlock), loadCohort: async () => [TOKEN],
      },
      commitRepository: {
        async commitRange(input) {
          if (input.transfers.length) {
            throw Object.assign(new Error('overflow'), {
              code: 'holder_balance_overflow', tokenAddress: TOKEN,
            });
          }
          nextBlock = input.nextBlock;
          return { status: 'committed', ...input, runId: '1' };
        },
        async excludeToken(input) {
          exclusions.push(input);
          return { status: 'excluded', tokenAddress: input.tokenAddress };
        },
      },
      reader: {
        getSafeHead: async () => ({ safeHead: '100' }),
        readGlobalRange: async ({ tokenAddresses }) => {
          scopes.push(tokenAddresses);
          return range(100, 100, {
            transfers: tokenAddresses.includes(TOKEN) ? [{ tokenAddress: TOKEN }] : [],
          });
        },
        readReceiptRange: async () => { throw new Error('unexpected receipts'); },
      },
      options: { prefetch: 1 },
    });

    assert.equal((await scanner.runOnce({ throughBlock: 100 })).status, 'excluded');
    assert.deepEqual(exclusions, [{
      runId: '1', tokenAddress: TOKEN, reason: 'balance_overflow',
    }]);
    assert.equal((await scanner.runOnce({ throughBlock: 100 })).status, 'committed');
    assert.deepEqual(scopes, [[TOKEN], []]);
  });
});
