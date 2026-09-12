const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  normalizeTokenViewRequest,
} = require('../src/services/token-view-contract');
const {
  rankTrendingTokens,
} = require('../src/services/trending-token-score');
const {
  createDashboardTokenViewReader,
  createRobinhoodLifecycleAdapter,
  createRobinhoodTrendingAdapter,
} = require('../src/services/dashboard-token-view-reader');
const {
  rankLifecycleTokens,
} = require('../src/services/lifecycle-token-ranking');
const {
  createTokenLaunchpadLifecycleRepository,
} = require('../src/models/token-launchpad-lifecycle');

const AS_OF = '2026-09-12T12:00:00.000Z';

function token(index, overrides = {}) {
  const address = `0x${index.toString(16).padStart(40, '0')}`;
  return {
    identity: { chain: 'robinhood', address, key: `robinhood:${address}` },
    symbol: `RH${index}`,
    valuation: { type: 'fdv', usd: 100_000, observedAt: AS_OF, freshness: 'fresh' },
    liquidityUsd: null,
    volume5mUsd: 10_000,
    volume1hUsd: 100_000,
    volume6hUsd: 300_000,
    volume24hUsd: 1_000_000,
    priceChange1hPct: 20,
    priceChange6hPct: 40,
    coverage: { '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    lastActivityAt: AS_OF,
    windowEnd: AS_OF,
    ...overrides,
  };
}

function lifecycle(index, status, overrides = {}) {
  const row = token(index);
  return {
    lifecycle: {
      chain: 'robinhood', tokenAddress: row.identity.address, launchpadId: 'pons-v2', status,
      bondProgressBps: status === 'pre_bonded' ? 5000 : null,
      createdAt: '2026-09-10T00:00:00.000Z',
      migratedAt: status === 'migrated' ? '2026-09-12T11:00:00.000Z' : null,
      lastEventAt: '2026-09-12T11:00:00.000Z', evidenceSource: 'canonical_event',
      evidenceBlockNumber: '100', evidenceBlockHash: `0x${'a'.repeat(64)}`,
      evidenceTransactionHash: `0x${'b'.repeat(64)}`, evidenceLogIndex: 1, version: '2',
      ...overrides.lifecycle,
    },
    row: { ...row, ...overrides.row },
  };
}

describe('token view contract', () => {
  it('defaults to the Robinhood 40-token contract and rejects unavailable chains', () => {
    assert.deepEqual(normalizeTokenViewRequest({ view: 'trending', asOf: AS_OF }), {
      view: 'trending', chains: ['robinhood'], limit: 40, asOf: AS_OF,
    });
    assert.throws(() => normalizeTokenViewRequest({ view: 'best_performance' }), /unsupported/);
    assert.throws(() => normalizeTokenViewRequest({ view: 'trending', chains: 'solana' }), /unavailable/);
    assert.throws(() => normalizeTokenViewRequest({ view: 'trending', limit: 41 }), /between 1 and 40/);
  });
});

describe('Trending score v1', () => {
  it('keeps a high-volume moderate pump above a capped low-volume outlier', () => {
    const highVolume = token(1);
    const lowVolumePump = token(2, {
      volume5mUsd: 1_000, volume1hUsd: 100, volume24hUsd: 1_000,
      priceChange1hPct: 50_000, priceChange6hPct: 50_000,
    });
    const partial = token(3, { coverage: { ...highVolume.coverage, '1h': 'partial' } });
    const ranked = rankTrendingTokens([lowVolumePump, partial, highVolume], {
      asOf: AS_OF, limit: 40,
    });

    assert.deepEqual(ranked.map((item) => item.identity.address), [
      highVolume.identity.address, lowVolumePump.identity.address,
    ]);
    assert.ok(ranked[0].score > ranked[1].score);
    assert.deepEqual(Object.keys(ranked[0].components), [
      'volume24hPercentile', 'acceleration5mPercentile',
      'priceChange1hPercentile', 'priceChange6hPercentile',
    ]);
  });

  it('accepts proven creation-to-now coverage and caps deterministic output at 40', () => {
    const createdAt = new Date(AS_OF).getTime() - (2 * 60 * 60 * 1000);
    const rows = Array.from({ length: 45 }, (_, index) => token(index + 1));
    rows[44] = token(45, {
      tokenCreatedAt: createdAt,
      coverage: { ...rows[44].coverage, '24h': 'partial' },
      coverageProvenance: {
        caughtUp: true, startAt: new Date(createdAt - 1).toISOString(), endAt: AS_OF,
      },
    });
    const ranked = rankTrendingTokens(rows, { asOf: AS_OF, limit: 40 });
    assert.equal(ranked.length, 40);
    assert.deepEqual(ranked.map((item) => item.identity.address),
      rows.slice(0, 40).map((row) => row.identity.address));
  });
});

describe('Robinhood Trending adapter and coordinator', () => {
  it('loads one bounded canonical prefix and forwards user exclusions', async () => {
    let captured;
    const adapter = createRobinhoodTrendingAdapter({ tokenReader: {
      async listMonitoredPrefix(input) { captured = input; return { rows: [token(1)] }; },
    } });
    const rows = await adapter.listTrending({ asOf: AS_OF, excludedIdentities: [
      { chain: 'robinhood', address: token(2).identity.address },
      { chain: 'solana', address: 'ignored' },
    ] });
    assert.equal(rows.length, 1);
    assert.deepEqual(captured, {
      asOf: AS_OF, page: 4, perPage: 100,
      sorts: [{ mode: 'vol', window: '24h' }],
      minFdv: 30_000, maxFdv: 30_000_000_000,
      excludedAddresses: [token(2).identity.address],
    });
  });

  it('returns explicit readiness and explainable ranked API tokens', async () => {
    const adapter = { async listTrending() { return [token(1)]; } };
    const ready = createDashboardTokenViewReader({
      adapters: { robinhood: adapter },
      userBlocklist: { async getAllForChains() { return []; } },
      workspaceChainReadiness: { async getWorkspaceChainReadiness() {
        return { robinhood: { status: 'ready', capabilities: { monitored: true } } };
      } },
    });
    const payload = await ready.listTokenView({
      view: 'trending', userId: 7, asOf: AS_OF,
    });
    assert.equal(payload.status, 'ready');
    assert.equal(payload.scoreVersion, 'trending-v1');
    assert.equal(payload.tokens[0].trendingRank, 1);
    assert.equal(payload.tokens[0].chain, 'robinhood');

    const syncing = createDashboardTokenViewReader({
      adapters: { robinhood: adapter },
      workspaceChainReadiness: { async getWorkspaceChainReadiness() {
        return { robinhood: { status: 'syncing', capabilities: { monitored: false } } };
      } },
    });
    assert.equal((await syncing.listTokenView({ view: 'trending', asOf: AS_OF })).status,
      'syncing');
    assert.equal((await ready.listTokenView({ view: 'migrated', asOf: AS_OF })).status,
      'unsupported');
  });
});

describe('launchpad lifecycle views', () => {
  it('normalizes the bounded chain-neutral lifecycle query', async () => {
    const calls = [];
    const repository = createTokenLaunchpadLifecycleRepository({ database: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{
          chain: 'robinhood', token_address: token(1).identity.address,
          launchpad_id: 'pons-v2', status: 'migrated', bond_progress_bps: null,
          curve_address: token(2).identity.address, created_at: AS_OF, migrated_at: AS_OF,
          last_event_at: AS_OF, evidence_source: 'canonical_event',
          evidence_block_number: '10', evidence_block_hash: `0x${'a'.repeat(64)}`,
          evidence_transaction_hash: `0x${'b'.repeat(64)}`,
          evidence_log_index: 2, version: '3',
        }] };
      },
    } });
    const [row] = await repository.listCandidates({
      chain: 'robinhood', status: 'migrated', limit: 40,
    });
    assert.equal(row.tokenAddress, token(1).identity.address);
    assert.equal(row.evidenceBlockNumber, '10');
    assert.deepEqual(calls[0].params, ['robinhood', 'migrated', 40]);
    assert.match(calls[0].sql, /LIMIT \$3/);
  });

  it('deduplicates migrations and keeps migration time ahead of volume', () => {
    const newest = lifecycle(1, 'migrated', { row: { volume5mUsd: 1 } });
    const olderHighVolume = lifecycle(2, 'migrated', {
      lifecycle: { migratedAt: '2026-09-12T10:00:00.000Z', lastEventAt: '2026-09-12T10:00:00.000Z' },
      row: { volume5mUsd: 1_000_000 },
    });
    const duplicate = lifecycle(1, 'migrated', {
      lifecycle: { evidenceBlockNumber: '99', version: '1' }, row: { volume5mUsd: 9_000_000 },
    });
    const ranked = rankLifecycleTokens([olderHighVolume, duplicate, newest], {
      view: 'migrated', asOf: AS_OF, limit: 40,
    });
    assert.deepEqual(ranked.map((item) => item.identity.address), [
      newest.row.identity.address, olderHighVolume.row.identity.address,
    ]);
    assert.equal(ranked[0].row.volume5mUsd, 1);
  });

  it('orders pre-bonded by progress then acceleration and rejects future evidence', () => {
    const faster = lifecycle(1, 'pre_bonded', {
      row: { volume5mUsd: 120, volume1hUsd: 120 },
    });
    const slower = lifecycle(2, 'pre_bonded', {
      row: { volume5mUsd: 120, volume1hUsd: 1200 },
    });
    const ahead = lifecycle(3, 'pre_bonded', {
      lifecycle: { bondProgressBps: 6000 }, row: { volume5mUsd: 1, volume1hUsd: 1 },
    });
    const future = lifecycle(4, 'pre_bonded', {
      lifecycle: { lastEventAt: '2026-09-12T13:00:00.000Z' },
    });
    const ranked = rankLifecycleTokens([slower, future, faster, ahead], {
      view: 'pre_bonded', asOf: AS_OF, limit: 40,
    });
    assert.deepEqual(ranked.map((item) => item.identity.address), [
      ahead.row.identity.address, faster.row.identity.address, slower.row.identity.address,
    ]);
    assert.equal(rankLifecycleTokens(
      Array.from({ length: 45 }, (_, index) => lifecycle(index + 1, 'pre_bonded')),
      { view: 'pre_bonded', asOf: AS_OF, limit: 40 }
    ).length, 40);
  });

  it('hydrates supported lifecycle identities and returns explicit ready-zero/syncing states', async () => {
    const requested = [];
    const adapter = createRobinhoodLifecycleAdapter({
      lifecycleRepository: { async listCandidates() {
        return [lifecycle(1, 'migrated').lifecycle, lifecycle(2, 'migrated').lifecycle];
      } },
      tokenReader: { async getTokensByAddresses(input) {
        requested.push(...input.addresses); return [token(1)];
      } },
    });
    const candidates = await adapter.listMigrated({ asOf: AS_OF, excludedIdentities: [
      { chain: 'robinhood', address: token(2).identity.address },
    ] });
    assert.deepEqual(requested, [token(1).identity.address]);
    assert.equal(candidates.length, 1);

    const reader = createDashboardTokenViewReader({
      adapters: { robinhood: adapter },
      userBlocklist: { async getAllForChains() { return []; } },
      workspaceChainReadiness: { async getWorkspaceChainReadiness() {
        return { robinhood: { status: 'ready', capabilities: { launchpadLifecycle: true } } };
      } },
    });
    const payload = await reader.listTokenView({ view: 'migrated', asOf: AS_OF });
    assert.equal(payload.status, 'ready');
    assert.equal(payload.count, 1);
    assert.equal(payload.tokens[0].lifecycleRank, 1);

    const empty = createDashboardTokenViewReader({
      adapters: { robinhood: { async listPreBonded() { return []; } } },
      userBlocklist: { async getAllForChains() { return []; } },
      workspaceChainReadiness: { async getWorkspaceChainReadiness() {
        return { robinhood: { status: 'ready', capabilities: { launchpadLifecycle: true } } };
      } },
    });
    assert.deepEqual(
      [(await empty.listTokenView({ view: 'pre_bonded', asOf: AS_OF })).status,
        (await empty.listTokenView({ view: 'pre_bonded', asOf: AS_OF })).count],
      ['ready', 0]
    );

    const syncing = createDashboardTokenViewReader({
      adapters: { robinhood: { async listMigrated() { throw new Error('must not read'); } } },
      workspaceChainReadiness: { async getWorkspaceChainReadiness() {
        return { robinhood: { status: 'syncing', capabilities: { launchpadLifecycle: false } } };
      } },
    });
    assert.equal((await syncing.listTokenView({ view: 'migrated', asOf: AS_OF })).status,
      'syncing');
  });
});
