const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletRankingCandidateSnapshot,
} = require('../src/services/robinhood-wallet-ranking-candidate-snapshot');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const AS_OF = '2026-09-27T12:00:00.000Z';
const POSITION_VERSION = 'unified_transfer_v1';
const TRANSFER_VERSION = 'rh_transfer_v1';

function harness(frontier = { frontierChecksPassed: true, frontierBlock: '105', reasons: [] }) {
  const database = { snapshot: true };
  const calls = [];
  const service = createRobinhoodWalletRankingCandidateSnapshot({
    snapshotRunner: { run: (read) => read(database) },
    positionsRepository: { async getOpenPositions(input) {
      calls.push({ source: 'positions', input });
      return { projectionVersion: POSITION_VERSION, hasMore: true,
        positions: [TOKEN_A, TOKEN_B].map((tokenAddress) => ({
          tokenAddress, walletAddress: WALLET, quantityRaw: '10', throughBlock: '105',
        })) };
    } },
    frontierRepository: { async inspectAsOf(input) {
      calls.push({ source: 'frontier', input });
      return frontier;
    } },
    pricesRepository: { async getPrices(input) {
      calls.push({ source: 'prices', input });
      return [{ tokenAddress: TOKEN_A, currentPriceUsd: '2', coverage: 'complete' }];
    } },
    readCoverage: async (scopedDatabase, input) => {
      assert.equal(scopedDatabase, database);
      calls.push({ source: 'events', input });
      return [{ tokenAddress: TOKEN_A, walletAddress: WALLET,
        eventsComplete: false, coverageReasons: ['source_coverage_unverified'] }];
    },
  });
  return { service, calls };
}

describe('Robinhood ranking candidate snapshot', () => {
  it('joins bounded positions, prices and window events in one read snapshot', async () => {
    const { service, calls } = harness();
    const result = await service.getCandidates({
      tokenAddresses: [TOKEN_A, TOKEN_B], projectionVersion: POSITION_VERSION,
      classificationVersion: TRANSFER_VERSION, window: '24h', asOf: AS_OF,
    });
    assert.deepEqual(calls.map((call) => call.source),
      ['positions', 'frontier', 'prices', 'events']);
    assert.equal(calls[0].input.limit, 20);
    assert.equal(calls[1].input.asOf.toISOString(), AS_OF);
    assert.deepEqual(calls[2].input.tokenAddresses, [TOKEN_A, TOKEN_B]);
    assert.equal(calls[3].input.windowStart.toISOString(), '2026-09-26T12:00:00.000Z');
    assert.equal(result.candidates[0].price.currentPriceUsd, '2');
    assert.equal(result.candidates[0].windowEvents.eventsComplete, false);
    assert.equal(result.candidates[1].price, null);
    assert.equal(result.candidates[1].windowEvents, null);
    assert.equal(result.hasMorePositions, true);
    assert.equal(result.readSnapshotConsistent, true);
    assert.equal(result.candidateUniverseComplete, false);
    assert.equal(result.rankingReady, false);
    assert.equal(result.candidates[0].projectionAligned, true);
    assert.deepEqual(result.reasons, ['candidate_universe_incomplete']);
  });

  it('skips window events for ALL and rejects invalid periods before reading', async () => {
    const { service, calls } = harness();
    const result = await service.getCandidates({
      tokenAddresses: [TOKEN_A], projectionVersion: POSITION_VERSION,
      window: 'ALL', asOf: AS_OF,
    });
    assert.equal(result.windowStart, null);
    assert.deepEqual(calls.map((call) => call.source), ['positions', 'frontier', 'prices']);
    await assert.rejects(service.getCandidates({ window: 'overall', asOf: AS_OF }),
      /window is invalid/);
    await assert.rejects(service.getCandidates({ window: '24h', asOf: 'bad' }),
      /asOf is invalid/);
  });

  it('keeps candidates unaligned when the cursor audit fails', async () => {
    const { service } = harness({ frontierChecksPassed: false, frontierBlock: null,
      reasons: ['position_as_of_mismatch'] });
    const result = await service.getCandidates({ tokenAddresses: [TOKEN_A],
      projectionVersion: POSITION_VERSION, window: 'ALL', asOf: AS_OF });
    assert.equal(result.candidates[0].projectionAligned, false);
    assert.deepEqual(result.reasons,
      ['candidate_universe_incomplete', 'position_as_of_mismatch']);
  });

  it('does not align a position beyond the audited frontier', async () => {
    const { service } = harness({ frontierChecksPassed: true, frontierBlock: '104',
      reasons: [] });
    const result = await service.getCandidates({ tokenAddresses: [TOKEN_A],
      projectionVersion: POSITION_VERSION, window: 'ALL', asOf: AS_OF });
    assert.equal(result.candidates[0].projectionAligned, false);
    assert.deepEqual(result.reasons,
      ['candidate_universe_incomplete', 'position_outside_frontier']);
  });
});
