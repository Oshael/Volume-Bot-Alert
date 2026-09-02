const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runLiveTick,
  __private: { calculateFrontiers },
} = require('../src/services/robinhood-wallet-swap-live-runner');

const BLOCK_HASH = `0x${'f'.repeat(64)}`;
const OTHER_HASH = `0x${'e'.repeat(64)}`;
const BLOCK_TIME = '2026-08-01T00:00:00.000Z';

function liveCursor(overrides = {}) {
  return {
    chain: 'robinhood', stream: 'live', nextBlock: '100', safeHead: null,
    checkpointBlock: null, checkpointHash: null, checkpointTimestamp: null,
    version: 0, ...overrides,
  };
}

function fakeCursor(initial, options = {}) {
  let state = initial ? { ...initial } : null;
  const advances = [];
  return {
    advances,
    loadCursor: async (stream) => {
      assert.equal(stream, 'live');
      return state ? { ...state } : null;
    },
    advanceLiveCursor: async (input) => {
      advances.push({ ...input });
      if (options.conflictAt === advances.length) return null;
      state = {
        ...state,
        nextBlock: input.nextBlock,
        safeHead: input.safeHead ?? state.safeHead,
        checkpointBlock: input.checkpointBlock ?? state.checkpointBlock,
        checkpointHash: input.checkpointHash ?? state.checkpointHash,
        checkpointTimestamp: input.checkpointTimestamp ?? state.checkpointTimestamp,
        version: state.version + 1,
      };
      return { ...state };
    },
  };
}

function group(blockNumber, count = 1) {
  return [String(blockNumber), Array.from({ length: count }, () => ({ transaction_hash: BLOCK_HASH }))];
}

function makeDeps(overrides = {}) {
  const calls = { reads: [], attributed: [], headers: [] };
  const cursor = overrides.cursor || fakeCursor(liveCursor());
  const marketCursor = Object.hasOwn(overrides, 'marketCursor')
    ? overrides.marketCursor
    : { nextBlock: '190' };
  return {
    calls,
    cursor,
    reorgDepth: overrides.reorgDepth ?? 12,
    maxBlocks: overrides.maxBlocks ?? 200,
    readNodeHead: async () => overrides.nodeHead ?? '200',
    loadMarketCursor: async () => marketCursor,
    fetchBlockHeader: async (blockNumber) => {
      calls.headers.push(String(blockNumber));
      return overrides.header ?? { number: String(blockNumber), hash: BLOCK_HASH };
    },
    reader: {
      readAcceptedBlockGroups: async (input) => {
        calls.reads.push(input);
        const groups = overrides.groups ?? [];
        return overrides.sourceResult ?? {
          groups,
          blockNumbers: groups.map(([blockNumber]) => String(blockNumber)),
        };
      },
    },
    attributor: {
      attributeGroups: async (groups) => {
        const totals = {
          blocks: 0, attributed: 0, inserted: 0, unresolved: 0, missing: 0,
          failedBlock: null, results: [],
        };
        for (const [blockNumber, observations] of groups) {
          calls.attributed.push({ blockNumber, observations });
          const attributed = overrides.attribute
            ? await overrides.attribute(blockNumber, observations)
            : {
              blockNumber, blockHash: BLOCK_HASH, blockTime: BLOCK_TIME,
              attributed: observations.length, inserted: observations.length,
              unresolved: 0, missing: 0,
            };
          if (attributed.unresolved || attributed.missing) {
            totals.unresolved = attributed.unresolved;
            totals.missing = attributed.missing;
            totals.failedBlock = String(blockNumber);
            break;
          }
          totals.blocks += 1;
          totals.attributed += attributed.attributed;
          totals.inserted += attributed.inserted;
          totals.results.push({
            blockNumber: String(blockNumber), blockHash: attributed.blockHash,
            blockTime: attributed.blockTime, attributed: attributed.attributed,
          });
        }
        return totals;
      },
    },
  };
}

describe('Robinhood wallet-swap LIVE runner', () => {
  it('computes the processable frontier from node safety and committed market progress', () => {
    assert.deepEqual(calculateFrontiers(200n, { nextBlock: '180' }, 12), {
      nodeHead: 200n, nodeSafeHead: 188n, sourceSafeHead: 179n, processableThrough: 179n,
    });
    assert.equal(calculateFrontiers(5n, { nextBlock: '180' }, 12).processableThrough, null);
    assert.equal(calculateFrontiers(200n, null, 12).processableThrough, null);
  });

  it('waits for explicit bootstrap instead of failing when the live cursor is absent', async () => {
    const deps = makeDeps({ cursor: fakeCursor(null) });
    const result = await runLiveTick(deps);
    assert.equal(result.status, 'awaiting-bootstrap');
    assert.equal(result.processableThrough, '188');
    assert.equal(deps.calls.reads.length, 0);
  });

  it('waits when the node or source has no safe block yet', async () => {
    const waitingHead = await runLiveTick(makeDeps({ nodeHead: '5' }));
    assert.equal(waitingHead.status, 'waiting-head');

    const waitingSource = await runLiveTick(makeDeps({ marketCursor: null }));
    assert.equal(waitingSource.status, 'waiting-source');
  });

  it('advances an empty committed range directly through the safe frontier', async () => {
    const deps = makeDeps({ marketCursor: { nextBlock: '105' } });
    const result = await runLiveTick(deps);

    assert.equal(result.status, 'advanced-empty');
    assert.equal(result.processableThrough, '104');
    assert.equal(result.nextBlock, '105');
    assert.deepEqual(deps.calls.reads[0], { fromBlock: '100', toBlock: '104', maxBlocks: 200 });
    assert.equal(deps.cursor.advances.length, 1);
  });

  it('never treats a malformed source response as an empty range', async () => {
    const deps = makeDeps({ sourceResult: { groups: [] } });
    await assert.rejects(
      () => runLiveTick(deps),
      (error) => error.code === 'source_contract_error'
    );
    assert.equal(deps.cursor.advances.length, 0);
  });

  it('processes groups in order, checkpoints once and skips the proven empty tail', async () => {
    const deps = makeDeps({ groups: [group(101, 2), group(110)], maxBlocks: 3 });
    const result = await runLiveTick(deps);

    assert.equal(result.status, 'advanced');
    assert.equal(result.processedBlocks, 2);
    assert.equal(result.attributed, 3);
    assert.equal(result.nextBlock, '189');
    assert.equal(result.checkpointBlock, '110');
    assert.equal(deps.cursor.advances.length, 1);
    assert.equal(deps.cursor.advances[0].checkpointHash, BLOCK_HASH);
    assert.equal(deps.cursor.advances[0].checkpointBlock, '110');
    assert.equal(deps.cursor.advances[0].nextBlock, '189');
  });

  it('does not skip beyond a full source page', async () => {
    const deps = makeDeps({ groups: [group(101), group(110)], maxBlocks: 2 });
    const result = await runLiveTick(deps);
    assert.equal(result.nextBlock, '111');
    assert.equal(deps.cursor.advances.length, 1);
  });

  it('fails closed without advancing the unresolved block', async () => {
    const deps = makeDeps({
      groups: [group(101)],
      attribute: async (blockNumber) => ({
        blockNumber, blockHash: BLOCK_HASH, blockTime: BLOCK_TIME,
        attributed: 0, inserted: 0, unresolved: 1, missing: 1,
      }),
    });
    const result = await runLiveTick(deps);
    assert.equal(result.status, 'blocked-unresolved');
    assert.equal(result.failedBlock, '101');
    assert.equal(result.nextBlock, '100');
    assert.equal(deps.cursor.advances.length, 0);
  });

  it('commits one cursor advance for the successful prefix before an unresolved block', async () => {
    const deps = makeDeps({
      groups: [group(101), group(102), group(103)],
      attribute: async (blockNumber) => ({
        blockNumber, blockHash: BLOCK_HASH, blockTime: BLOCK_TIME,
        attributed: blockNumber === '102' ? 0 : 1,
        inserted: blockNumber === '102' ? 0 : 1,
        unresolved: blockNumber === '102' ? 1 : 0,
        missing: blockNumber === '102' ? 1 : 0,
      }),
    });
    const result = await runLiveTick(deps);

    assert.equal(result.status, 'blocked-unresolved');
    assert.equal(result.failedBlock, '102');
    assert.equal(result.processedBlocks, 1);
    assert.equal(result.nextBlock, '102');
    assert.equal(deps.calls.attributed.length, 2);
    assert.equal(deps.cursor.advances.length, 1);
    assert.equal(deps.cursor.advances[0].checkpointBlock, '101');
  });

  it('stops the tick on an optimistic cursor conflict', async () => {
    const cursor = fakeCursor(liveCursor(), { conflictAt: 1 });
    const result = await runLiveTick(makeDeps({ cursor, groups: [group(101)] }));
    assert.equal(result.status, 'conflict');
    assert.equal(result.nextBlock, '100');
  });

  it('revalidates a checkpoint even when already caught up', async () => {
    const state = liveCursor({
      nextBlock: '189', safeHead: '188', checkpointBlock: '180',
      checkpointHash: BLOCK_HASH, checkpointTimestamp: BLOCK_TIME,
    });
    const deps = makeDeps({ cursor: fakeCursor(state) });
    const result = await runLiveTick(deps);
    assert.equal(result.status, 'caught-up');
    assert.deepEqual(deps.calls.headers, ['180']);
    assert.equal(deps.calls.reads.length, 0);
  });

  it('halts on checkpoint or safe-frontier regression', async () => {
    const checkpoint = liveCursor({
      checkpointBlock: '99', checkpointHash: BLOCK_HASH, checkpointTimestamp: BLOCK_TIME,
    });
    await assert.rejects(
      () => runLiveTick(makeDeps({ cursor: fakeCursor(checkpoint), header: { number: '99', hash: OTHER_HASH } })),
      (error) => error.code === 'persistent_reorg' && error.fatal === true
    );

    await assert.rejects(
      () => runLiveTick(makeDeps({ cursor: fakeCursor(liveCursor({ safeHead: '189' })) })),
      (error) => error.code === 'persistent_reorg' && error.fatal === true
    );
  });
});
