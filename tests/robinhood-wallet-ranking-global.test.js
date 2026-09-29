const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodWalletRankingGlobal,
} = require('../src/services/robinhood-wallet-ranking-global');

const AS_OF = '2026-09-27T12:00:00.000Z';
const VERSION = 'unified_transfer_v1';
const TRANSFER_VERSION = 'rh_transfer_v1';
const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const wallet = (number) => `0x${number.toString(16).padStart(40, '0')}`;

function position(number, tokenAddress = TOKEN_A) {
  return { tokenAddress, walletAddress: wallet(number), quantityRaw: '10',
    costBasisUsd: '10', quality: 'exact_swap_only', throughBlock: '100' };
}

function harness(positions, overrides = {}) {
  const database = { snapshot: true };
  const calls = [];
  let offset = 0;
  const service = createRobinhoodWalletRankingGlobal({
    snapshotRunner: { run: (read) => read(database) },
    positionsRepository: { async getGlobalOpenPositions(input) {
      assert.equal(input.projectionVersion, VERSION);
      assert.equal(input.limit, 100);
      const batch = positions.slice(offset, offset + 100);
      offset += batch.length;
      const hasMore = offset < positions.length || overrides.forceMore === true;
      calls.push({ source: 'positions', size: batch.length });
      return { positions: batch, hasMore, nextAfter: hasMore
        ? { tokenAddress: batch.at(-1).tokenAddress,
          walletAddress: batch.at(-1).walletAddress } : null };
    } },
    frontierRepository: { async inspectAsOf(input) {
      assert.equal(input.asOf.toISOString(), AS_OF);
      calls.push({ source: 'frontier' });
      return { frontierChecksPassed: true, frontierBlock: '100', reasons: [] };
    } },
    pricesRepository: { async getPrices(input) {
      calls.push({ source: 'prices', size: input.tokenAddresses.length });
      return input.tokenAddresses.map((tokenAddress) => ({ tokenAddress,
        currentPriceUsd: '3', windowStartPriceUsd: '2' }));
    } },
    decimalsRepository: { async getDecimals(input) {
      calls.push({ source: 'decimals', size: input.tokenAddresses.length });
      return input.tokenAddresses.filter((tokenAddress) => (
        !overrides.missingDecimals?.includes(tokenAddress)
      )).map((tokenAddress) => ({ tokenAddress, tokenDecimals: 0 }));
    } },
    readCoverage: async (scoped, input) => {
      assert.equal(scoped, database);
      assert.equal(input.classificationVersion, TRANSFER_VERSION);
      calls.push({ source: 'events', size: input.pairs.length });
      return input.pairs.filter((pair) => (
        !overrides.missingEvents?.includes(pair.walletAddress)
      )).map((pair) => ({ ...pair, events: [], eventsComplete: true }));
    },
  });
  return { service, calls };
}

function request(window = '24h') {
  return { window, asOf: AS_OF, projectionVersion: VERSION,
    classificationVersion: TRANSFER_VERSION };
}

describe('Robinhood global wallet ranking composition', () => {
  it('sums old bags by wallet and batches pair reads in one snapshot', async () => {
    const positions = [position(1), position(1, TOKEN_B),
      ...Array.from({ length: 19 }, (_, index) => position(index + 2))];
    const { service, calls } = harness(positions);
    const result = await service.getRanking({ ...request(), limit: 2 });
    assert.deepEqual(result.ranked.map(({ walletAddress, gainUsd }) => (
      [walletAddress, gainUsd]
    )), [[wallet(1), '20'], [wallet(2), '10']]);
    assert.equal(result.rankingReady, true);
    assert.equal(result.candidateWalletCount, 20);
    assert.equal(result.readSnapshotConsistent, true);
    assert.deepEqual(calls.filter((call) => call.source === 'events')
      .map((call) => call.size), [20, 1]);
  });

  it('keeps a capped universe partial and skips unused enrichment', async () => {
    const { service, calls } = harness(
      Array.from({ length: 1000 }, (_, index) => position(index + 1)),
      { forceMore: true },
    );
    const result = await service.getRanking(request());
    assert.equal(result.candidateUniverseComplete, false);
    assert.equal(result.rankingReady, false);
    assert.deepEqual(result.ranked, []);
    assert.equal(result.candidateWalletCount, 1000);
    assert.ok(result.reasons.includes('candidate_universe_limit_reached'));
    assert.deepEqual(calls.filter((call) => call.source === 'positions').length, 10);
    assert.equal(calls.some((call) => ['prices', 'decimals', 'events']
      .includes(call.source)), false);
  });

  it('excludes missing decimals and missing window evidence without losing known wallets', async () => {
    const { service } = harness([position(1), position(2, TOKEN_B), position(3)], {
      missingDecimals: [TOKEN_B], missingEvents: [wallet(3)],
    });
    const result = await service.getRanking(request());
    assert.deepEqual(result.ranked.map((item) => item.walletAddress), [wallet(1)]);
    assert.equal(result.excludedWalletCount, 2);
    assert.deepEqual(result.reasons,
      ['incomplete_history', 'token_decimals_unavailable', 'window_events_incomplete']);
    assert.equal(result.rankingReady, false);
  });

  it('uses remaining purchase cost for ALL without reading events', async () => {
    const { service, calls } = harness([position(1)]);
    const result = await service.getRanking(request('ALL'));
    assert.equal(result.ranked[0].gainUsd, '20');
    assert.equal(result.windowStart, null);
    assert.equal(calls.some((call) => call.source === 'events'), false);
    await assert.rejects(service.getRanking(request('overall')), /window is invalid/);
  });

  it('splits token enrichment at the 100-token repository limit', async () => {
    const positions = Array.from({ length: 101 }, (_, index) => (
      position(index + 1, wallet(index + 1))
    ));
    const { service, calls } = harness(positions);
    const result = await service.getRanking(request('ALL'));
    assert.equal(result.pageCount, 2);
    assert.equal(result.candidateUniverseComplete, true);
    assert.deepEqual(calls.filter((call) => call.source === 'prices')
      .map((call) => call.size), [100, 1]);
    assert.deepEqual(calls.filter((call) => call.source === 'decimals')
      .map((call) => call.size), [100, 1]);
  });
});
