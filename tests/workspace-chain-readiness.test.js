const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildWorkspaceChainReadiness,
  createWorkspaceChainReadinessProvider,
} = require('../src/services/workspace-chain-readiness');
const { isRobinhoodTokenChainConfigured } = require('../src/utils/token-chain-availability');

const NOW_MS = Date.parse('2026-07-14T20:00:00.000Z');

function healthySplitLeases() {
  return [
    {
      key: 'robinhood-head-capture-worker',
      leaseUntil: new Date(NOW_MS + 60_000).toISOString(),
      metadata: { telemetry: {
        version: 1,
        capturedAt: new Date(NOW_MS - 1000).toISOString(),
        worker: { running: true },
        coverage: { caughtUp: true, unexplainedGaps: 0 },
      } },
    },
    {
      key: 'robinhood-processing-worker',
      leaseUntil: new Date(NOW_MS + 60_000).toISOString(),
      metadata: { telemetry: {
        running: true,
        lastTickAt: new Date(NOW_MS - 1000).toISOString(),
        lastBlocked: 0,
        lastError: null,
      } },
    },
    {
      key: 'robinhood-ingestion-worker',
      leaseUntil: new Date(NOW_MS - 60_000).toISOString(),
      metadata: { telemetry: {
        version: 1,
        coverage: { caughtUp: true, unexplainedGaps: 0 },
      } },
    },
  ];
}

function healthyCanonicalLeases() {
  return [
    {
      key: 'robinhood-chain-capture-worker',
      leaseUntil: new Date(NOW_MS + 60_000).toISOString(),
      metadata: {
        running: true, lagBlocks: 0, lastError: null,
        nodeHeadObservedAt: new Date(NOW_MS - 1000).toISOString(),
      },
    },
    {
      key: 'robinhood-canonical-head-worker',
      heartbeatAt: new Date(NOW_MS - 1000).toISOString(),
      leaseUntil: new Date(NOW_MS + 60_000).toISOString(),
      metadata: {
        mode: 'canonical_publish', running: true, lastError: null,
        lastTickAt: new Date(NOW_MS - 1000).toISOString(),
        canonicalRuntime: { rpcGuard: { forbiddenAttempts: 0 } },
      },
    },
    healthySplitLeases()[1],
  ];
}

function runtimeConfig(overrides = {}) {
  return {
    mockTrading: { enabled: true },
    robinhoodUserVisibility: { enabled: true },
    robinhoodIngestionWorker: { enabled: true },
    robinhoodRollout: {
      transport: { enabled: true },
      persistence: { enabled: true },
      alerts: { requested: true },
    },
    robinhoodSignalDryRun: {
      enabled: true,
      protocols: ['uniswap-v2'],
      windowMs: 300_000,
      minLiquidityUsd: '3000',
      minVolumeUsd: '1000',
      minTransactions: 10,
      maxAgeMs: 300_000,
    },
    ...overrides,
  };
}

describe('workspace chain readiness', () => {
  it('keeps an ingesting Robinhood workspace hidden without public visibility', () => {
    const config = {
      robinhoodUserVisibility: { enabled: false },
      robinhoodIngestionWorker: { enabled: true },
      robinhoodRollout: {
        transport: { enabled: true },
        persistence: { enabled: true },
        alerts: { requested: true },
      },
    };

    assert.equal(isRobinhoodTokenChainConfigured(config), true);
    assert.deepEqual(Object.keys(buildWorkspaceChainReadiness({ config, nowMs: NOW_MS })), ['solana']);
  });

  it('keeps user-owned Robinhood collections ready while market data is syncing', () => {
    const readiness = buildWorkspaceChainReadiness({
      config: runtimeConfig(),
      ingestionStatus: {
        running: true,
        lastSnapshot: { coverage: { caughtUp: false, unexplainedGaps: 0 } },
      },
      nowMs: NOW_MS,
    }).robinhood;

    assert.equal(readiness.status, 'syncing');
    assert.equal(readiness.publicationReady, false);
    assert.equal(readiness.workspaceReady, false);
    assert.equal(readiness.capabilities.monitored, false);
    assert.equal(readiness.capabilities.manualTokens, true);
    assert.equal(readiness.capabilities.starred, true);
    assert.equal(readiness.capabilities.blocklist, true);
    assert.equal(readiness.capabilities.history, false);
  });

  it('enables market panels and native chart history after market coverage is ready', () => {
    const readiness = buildWorkspaceChainReadiness({
      config: runtimeConfig(),
      ingestionStatus: {
        running: true,
        lastSnapshot: { coverage: { caughtUp: true, unexplainedGaps: 0 } },
      },
      nowMs: NOW_MS,
    }).robinhood;

    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.publicationReady, true);
    assert.equal(readiness.capabilities.alertFeed, true);
    assert.equal(readiness.workspaceReady, false);
    assert.equal(readiness.capabilities.history, true);
    assert.equal(readiness.capabilities.charts, true);
    assert.equal(readiness.capabilities.monitored, true);
    assert.equal(readiness.capabilities.topPerformers, true);
    assert.equal(readiness.capabilities.manualTokens, true);
    assert.equal(readiness.capabilities.starred, true);
    assert.equal(readiness.capabilities.blocklist, true);
  });

  it('keeps market panels independent from Robinhood alert publication', () => {
    const readiness = buildWorkspaceChainReadiness({
      config: runtimeConfig({
        robinhoodRollout: {
          transport: { enabled: true },
          persistence: { enabled: true },
          alerts: { requested: false },
        },
      }),
      ingestionStatus: {
        running: true,
        lastSnapshot: { coverage: { caughtUp: true, unexplainedGaps: 0 } },
      },
      nowMs: NOW_MS,
    }).robinhood;

    assert.equal(readiness.publicationReady, false);
    assert.equal(readiness.capabilities.alertFeed, false);
    assert.equal(readiness.capabilities.monitored, true);
    assert.equal(readiness.capabilities.topPerformers, true);
  });

  it('refreshes a cached syncing snapshot after the readiness TTL', async () => {
    let nowMs = NOW_MS;
    let caughtUp = false;
    const provider = createWorkspaceChainReadinessProvider({
      config: runtimeConfig(),
      leaseStore: { list: async () => [] },
      ingestionWorker: {
        getStatus: () => ({
          running: true,
          lastSnapshot: { coverage: { caughtUp, unexplainedGaps: 0 } },
        }),
      },
      now: () => nowMs,
    });

    assert.equal((await provider()).robinhood.status, 'syncing');
    caughtUp = true;
    assert.equal((await provider()).robinhood.status, 'syncing');
    nowMs += 5001;
    assert.equal((await provider()).robinhood.status, 'ready');
  });

  it('uses the split head and processing leases after the monolith stops', async () => {
    const provider = createWorkspaceChainReadinessProvider({
      config: runtimeConfig(),
      leaseStore: { list: async () => healthySplitLeases() },
      ingestionWorker: { getStatus: () => ({ running: false }) },
      now: () => NOW_MS,
    });

    const readiness = (await provider()).robinhood;
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.publicationReady, true);
    assert.equal(readiness.capabilities.monitored, true);
    assert.equal(readiness.capabilities.history, true);
    assert.equal(readiness.blockers.includes('worker_not_active'), false);
  });

  it('uses the canonical publisher as the split runtime authority', async () => {
    const provider = createWorkspaceChainReadinessProvider({
      config: runtimeConfig(),
      leaseStore: { list: async () => healthyCanonicalLeases() },
      ingestionWorker: { getStatus: () => ({ running: false }) },
      now: () => NOW_MS,
    });

    const readiness = (await provider()).robinhood;
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.publicationReady, true);
    assert.equal(readiness.blockers.includes('head_lease_inactive'), false);
  });

  it('fails split workspace readiness closed when processing is unavailable', async () => {
    const leases = healthySplitLeases().filter(
      (lease) => lease.key !== 'robinhood-processing-worker'
    );
    const provider = createWorkspaceChainReadinessProvider({
      config: runtimeConfig(),
      leaseStore: { list: async () => leases },
      ingestionWorker: { getStatus: () => ({ running: false }) },
      now: () => NOW_MS,
    });

    const readiness = (await provider()).robinhood;
    assert.equal(readiness.status, 'syncing');
    assert.equal(readiness.publicationReady, false);
    assert.equal(readiness.capabilities.monitored, false);
    assert.equal(readiness.blockers.includes('processing_lease_inactive'), true);
  });

  it('falls back to an active monolith lease while split processing is unavailable', async () => {
    const leases = healthySplitLeases().filter(
      (lease) => lease.key !== 'robinhood-processing-worker'
    );
    const monolith = leases.find((lease) => lease.key === 'robinhood-ingestion-worker');
    monolith.leaseUntil = new Date(NOW_MS + 60_000).toISOString();
    const provider = createWorkspaceChainReadinessProvider({
      config: runtimeConfig(),
      leaseStore: { list: async () => leases },
      ingestionWorker: { getStatus: () => ({ running: false }) },
      now: () => NOW_MS,
    });

    const readiness = (await provider()).robinhood;
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.publicationReady, true);
    assert.equal(readiness.blockers.includes('processing_lease_inactive'), false);
  });
});
