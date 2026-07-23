const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodCatalogProjectionBatch,
  __private,
} = require('../src/services/robinhood-catalog-projection-batch');
const {
  createRobinhoodCatalogMetadataStore,
} = require('../src/services/robinhood-catalog-metadata-store');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_2 = `0x${'2'.repeat(40)}`;

function candidate(tokenAddress = TOKEN, overrides = {}) {
  return {
    tokenAddress, protocol: 'uniswap-v3', adminBlocked: false,
    lastFdvUsd: '500000',
    ...overrides,
  };
}

describe('Robinhood catalog projection batch', () => {
  it('projects active tokens without mutating lifecycle when activity becomes stale', async () => {
    const calls = { reads: [], projected: [], applied: [], enqueued: [] };
    const repository = {
      async listColdRepairCandidates(input) {
        calls.reads.push(input);
        return [candidate(), candidate(TOKEN_2)];
      },
    };
    const catalog = {
      async projectDashboardSnapshot(value) { calls.projected.push(value.tokenAddress); },
      async listMetadata() {
        return [{
          address: TOKEN,
          robinhood_blockscout_checked_at: new Date('2026-07-14T17:59:00Z'),
        }, {
          address: TOKEN_2, symbol: 'READY', name: 'Ready Token',
          last_image_url: 'https://cdn.example/ready.png',
          metadata_updated_at: new Date('2026-07-14T17:59:00Z'),
        }];
      },
      async applyMetadata(value) { calls.applied.push(value); },
      async demoteInactive() { throw new Error('inactivity must not mutate catalog lifecycle'); },
    };
    const metadataReader = {
      async getMetadata(address) {
        return { address, name: 'Token One', symbol: 'ONE', usable: true };
      },
    };
    const socialQueue = {
      enqueue(address) { calls.enqueued.push(address); return true; },
      async drainOnce() { return { status: 'processed', processed: 1 }; },
    };
    const batch = createRobinhoodCatalogProjectionBatch({
      repository, catalog, metadataReader, socialQueue,
      now: () => Date.parse('2026-07-14T18:00:00Z'),
    });

    const result = await batch.runOnce({ maxTokens: 10 });

    assert.equal(result.status, 'completed');
    assert.equal(result.candidates, 2);
    assert.equal(result.projected, 2);
    assert.equal(result.onchainResolved, 1);
    assert.equal(result.socialEnqueued, 1);
    assert.deepEqual(result.socialDrainStatuses, ['processed']);
    assert.equal(result.demoted, 0);
    assert.deepEqual(calls.projected, [TOKEN, TOKEN_2]);
    assert.equal(calls.reads[0].windowMs, 900000);
    assert.equal(calls.reads[0].limit, 10);
    assert.equal(calls.reads[0].alignToMinute, false);
    assert.deepEqual(calls.applied[0], {
      address: TOKEN, name: 'Token One', symbol: 'ONE',
    });
    assert.deepEqual(calls.enqueued, [TOKEN]);
  });

  it('enriches durable manual tokens even when they have no active market candidate', async () => {
    const applied = [];
    const catalog = {
      async listManualMetadataCandidates() { return [{ tokenAddress: TOKEN, volumeUsd: '0' }]; },
      async listMetadata() { return []; },
      async applyMetadata(value) { applied.push(value); },
    };
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: { async listActiveTokenCandidates() { return []; } },
      catalog,
      metadataReader: {
        async getMetadata(address) {
          return { address, name: 'Manual Token', symbol: 'MAN', usable: true };
        },
      },
    });

    const result = await batch.runOnce();

    assert.equal(result.candidates, 0);
    assert.equal(result.manualMetadataCandidates, 1);
    assert.equal(result.projected, 0);
    assert.equal(result.onchainResolved, 1);
    assert.deepEqual(applied, [{ address: TOKEN, name: 'Manual Token', symbol: 'MAN' }]);
  });

  it('contains per-token projection errors and reports a bounded candidate page', async () => {
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: {
        async listSignalDryRunCandidates() {
          return [candidate(), candidate(TOKEN_2)];
        },
      },
      catalog: {
        async projectDashboardSnapshot(value) {
          if (value.tokenAddress === TOKEN_2) throw new Error('write failed');
        },
        async listMetadata() { return []; },
      },
    });

    const result = await batch.runOnce({ maxTokens: 2 });
    assert.equal(result.status, 'completed-with-errors');
    assert.equal(result.projected, 1);
    assert.equal(result.projectionErrors, 1);
    assert.equal(result.candidateLimitReached, true);
  });

  it('reports contained on-chain metadata failures without failing the projection', async () => {
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: {
        async listSignalDryRunCandidates() { return [candidate()]; },
      },
      catalog: {
        async projectDashboardSnapshot() {},
        async listMetadata() { return []; },
      },
      metadataReader: {
        async getMetadata() { throw new Error('RPC unavailable'); },
      },
    });

    const result = await batch.runOnce();

    assert.equal(result.status, 'completed-with-errors');
    assert.equal(result.projected, 1);
    assert.equal(result.onchainErrors, 1);
  });

  it('bounds Blockscout enrichment and persists image-missing checks', async () => {
    const checked = [];
    const recorded = [];
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: {
        async listActiveTokenCandidates() { return [candidate(), candidate(TOKEN_2)]; },
      },
      catalog: {
        async projectDashboardSnapshot() {},
        async listMetadata() { return []; },
        async recordBlockscoutMetadata(value) { recorded.push(value); },
      },
      blockscoutReader: {
        async getTokenMetadata(address) {
          checked.push(address);
          return { available: true, symbol: 'TKN', name: 'Token', imageUrl: null };
        },
      },
      now: () => Date.parse('2026-07-14T18:00:00Z'),
    });

    const result = await batch.runOnce({ blockscoutBatchSize: 1 });

    assert.deepEqual(checked, [TOKEN]);
    assert.equal(result.blockscoutChecked, 1);
    assert.equal(result.blockscoutImagesResolved, 0);
    assert.equal(result.blockscoutUnavailable, 1);
    assert.equal(recorded[0].address, TOKEN);
  });

  it('excludes admin-blocked identities before catalog writes', async () => {
    const projected = [];
    const third = `0x${'3'.repeat(40)}`;
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: {
        async listSignalDryRunCandidates() {
          return [candidate(), { ...candidate(TOKEN_2), adminBlocked: true }, candidate(third)];
        },
      },
      catalog: {
        async projectDashboardSnapshot(value) { projected.push(value.tokenAddress); },
        async listMetadata() { return []; },
      },
    });
    const result = await batch.runOnce({ maxTokens: 10 });

    assert.deepEqual(projected, [TOKEN, third]);
    assert.equal(result.candidates, 2);
    assert.equal(result.excludedBlocked, 1);
  });

  it('excludes FDV-capped identities before projection and metadata work', async () => {
    const projected = [];
    const batch = createRobinhoodCatalogProjectionBatch({
      repository: {
        async listSignalDryRunCandidates() {
          return [candidate(), candidate(TOKEN_2, { lastFdvUsd: '30000000000' })];
        },
      },
      catalog: {
        async projectDashboardSnapshot(value) { projected.push(value.tokenAddress); },
        async listMetadata() { return []; },
      },
    });

    const result = await batch.runOnce();

    assert.deepEqual(projected, [TOKEN]);
    assert.equal(result.candidates, 1);
    assert.equal(result.excludedFdvCap, 1);
  });

  it('uses persistent social metadata only while it remains fresh', async () => {
    let current = Date.parse('2026-07-14T18:00:00Z');
    const updatedAt = new Date(current - 1000);
    const writes = [];
    const catalog = {
      async listMetadata() {
        return [{
          address: TOKEN,
          last_image_url: 'https://cdn.example/token.png',
          robinhood_dexscreener_checked_at: updatedAt,
        }];
      },
      async recordDexscreenerMetadata(value) { writes.push(value); return value; },
    };
    const store = createRobinhoodCatalogMetadataStore({
      catalog, now: () => current, ttlMs: 60000,
    });

    assert.equal((await store.get(TOKEN)).imageUrl, 'https://cdn.example/token.png');
    current += 61000;
    assert.equal(await store.get(TOKEN), null);
    await store.set(TOKEN, { imageUrl: 'https://cdn.example/new.png' });
    assert.equal(writes[0].address, TOKEN);
  });

  it('bounds concurrency and candidate controls', async () => {
    const results = await __private.mapWithConcurrency([1, 2, 3], 2, async (value) => value * 2);
    assert.deepEqual(results.map((result) => result.value), [2, 4, 6]);
    assert.equal(__private.boundedInteger(9999, 10, 1, 100), 100);
  });
});
