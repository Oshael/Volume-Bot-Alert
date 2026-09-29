const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletRankingGlobalCandidates,
} = require('../src/services/robinhood-wallet-ranking-global-candidates');

const TOKEN = `0x${'a'.repeat(40)}`;
const VERSION = 'unified_transfer_v1';
const AS_OF = '2026-09-27T12:00:00.000Z';

function position(index) {
  return { tokenAddress: TOKEN, walletAddress: `0x${index.toString(16).padStart(40, '0')}`,
    quantityRaw: '1', throughBlock: String(index) };
}

function frontierRepository(frontierBlock = '1000', checksPassed = true) {
  return { async inspectAsOf(input) {
    assert.equal(input.projectionVersion, VERSION);
    assert.equal(input.asOf.toISOString(), AS_OF);
    return { frontierChecksPassed: checksPassed,
      frontierBlock: checksPassed ? frontierBlock : null,
      reasons: checksPassed ? [] : ['position_checkpoint_unproven'] };
  } };
}

function page(first, count, hasMore) {
  const positions = Array.from({ length: count }, (_, offset) => position(first + offset));
  const last = positions.at(-1);
  return { projectionVersion: VERSION, positions, hasMore,
    nextAfter: hasMore ? { tokenAddress: last.tokenAddress,
      walletAddress: last.walletAddress } : null };
}

describe('Robinhood ranking global candidate traversal', () => {
  it('finishes multiple ordered pages in one snapshot', async () => {
    const connection = {};
    let reads = 0;
    const service = createRobinhoodWalletRankingGlobalCandidates({
      snapshotRunner: { run: (read) => read(connection) },
      frontierRepository: frontierRepository(),
      positionsRepository: { async getGlobalOpenPositions(input) {
        reads += 1;
        assert.equal(input.limit, 100);
        assert.equal(input.projectionVersion, VERSION);
        if (reads === 1) {
          assert.equal(input.after, null);
          return page(1, 100, true);
        }
        assert.deepEqual(input.after, { tokenAddress: TOKEN,
          walletAddress: position(100).walletAddress });
        return page(101, 1, false);
      } },
    });
    const result = await service.read({ projectionVersion: VERSION, asOf: AS_OF });
    assert.equal(result.positions.length, 101);
    assert.equal(result.positions[100].walletAddress, position(101).walletAddress);
    assert.equal(result.pageCount, 2);
    assert.equal(result.candidateUniverseComplete, true);
    assert.equal(result.readSnapshotConsistent, true);
    assert.equal(result.positions[100].projectionAligned, true);
    assert.equal(result.positionFrontier.frontierBlock, '1000');
    assert.equal(result.nextAfter, null);
  });

  it('stops at the cap and never claims a complete universe', async () => {
    let reads = 0;
    const service = createRobinhoodWalletRankingGlobalCandidates({
      snapshotRunner: { run: (read) => read({}) },
      frontierRepository: frontierRepository(),
      positionsRepository: { async getGlobalOpenPositions() {
        const result = page(reads * 100 + 1, 100, true);
        reads += 1;
        return result;
      } },
    });
    const result = await service.read({ projectionVersion: VERSION, asOf: AS_OF });
    assert.equal(reads, 10);
    assert.equal(result.positions.length, 1000);
    assert.equal(result.candidateUniverseComplete, false);
    assert.deepEqual(result.reasons, ['candidate_universe_limit_reached']);
    assert.deepEqual(result.nextAfter, { tokenAddress: TOKEN,
      walletAddress: position(1000).walletAddress });
  });

  it('rejects a non-advancing cursor', async () => {
    const service = createRobinhoodWalletRankingGlobalCandidates({
      snapshotRunner: { run: (read) => read({}) },
      frontierRepository: frontierRepository(),
      positionsRepository: { async getGlobalOpenPositions(input) {
        return input.after ? page(1, 1, true) : page(1, 100, true);
      } },
    });
    await assert.rejects(service.read({ projectionVersion: VERSION, asOf: AS_OF }),
      /cursor did not advance/);
  });

  it('marks positions beyond the frontier without claiming an aligned projection', async () => {
    const service = createRobinhoodWalletRankingGlobalCandidates({
      snapshotRunner: { run: (read) => read({}) },
      frontierRepository: frontierRepository('100'),
      positionsRepository: { async getGlobalOpenPositions() {
        return page(100, 2, false);
      } },
    });
    const result = await service.read({ projectionVersion: VERSION, asOf: AS_OF });
    assert.deepEqual(result.positions.map((item) => item.projectionAligned), [true, false]);
    assert.equal(result.candidateUniverseComplete, true);
    assert.deepEqual(result.reasons, ['position_outside_frontier']);
  });

  it('keeps the global snapshot unaligned when the cursor audit fails', async () => {
    const service = createRobinhoodWalletRankingGlobalCandidates({
      snapshotRunner: { run: (read) => read({}) },
      frontierRepository: frontierRepository('1000', false),
      positionsRepository: { async getGlobalOpenPositions() {
        return page(1, 1, false);
      } },
    });
    const result = await service.read({ projectionVersion: VERSION, asOf: AS_OF });
    assert.equal(result.positions[0].projectionAligned, false);
    assert.deepEqual(result.reasons, ['position_checkpoint_unproven']);
    await assert.rejects(service.read({ projectionVersion: VERSION, asOf: 'bad' }),
      /asOf is invalid/);
    await assert.rejects(service.read({ projectionVersion: VERSION }),
      /asOf is invalid/);
  });
});
