const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userAlertMatcher = require('../src/services/user-alert-matcher');

const TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';

function createClient(log) {
  return {
    async query(sql) {
      log.push(String(sql).trim());
      return { rows: [] };
    },
    release() {
      log.push('RELEASE');
    },
  };
}

function createDeps(overrides = {}) {
  const stateByRule = overrides.stateByRule || {};
  const transactionLog = [];
  const eventWrites = [];
  const triggeredWrites = [];
  const rearmWrites = [];
  const getStateImpl = overrides.getState;

  return {
    deps: {
      db: {
        async getClient() {
          return createClient(transactionLog);
        },
      },
      tokenMarketVolumeBucket1m: {
        async listCurrentAndBaselineByAddresses() {
          return overrides.volumeRows || [];
        },
      },
      tokenMarketBucket1m: {
        async listCurrentAndBaselineByAddresses() {
          return overrides.mcapRows || [];
        },
      },
      tokenMeteoraState: {
        async listSummaryByAddresses() {
          return overrides.meteoraRows || [];
        },
      },
      userAlertProfileCache: {
        async listActiveProfiles() {
          return overrides.profiles || [];
        },
      },
      userAlertRuleState: {
        async getState(userId, ruleKey, tokenAddress) {
          if (typeof getStateImpl === 'function') {
            return getStateImpl(userId, ruleKey, tokenAddress);
          }
          return stateByRule[ruleKey] || null;
        },
        async markTriggered(payload) {
          triggeredWrites.push(payload);
          return payload;
        },
        async markRearmed(payload) {
          rearmWrites.push(payload);
          return payload;
        },
      },
      userAlertEvent: {
        async createEvent(payload) {
          eventWrites.push(payload);
          return {
            id: overrides.nextEventId || 11,
            userId: payload.userId,
            ruleKey: payload.ruleKey,
            kind: payload.kind,
            tokenAddress: payload.tokenAddress,
            payload: payload.payload,
            triggeredAt: payload.triggeredAt,
          };
        },
      },
      backendAlertPublisher: {
        async publishEventSafe(event) {
          return { payload: { id: event.id }, delivered: true };
        },
      },
      alertTickerPeers: {
        async buildTickerPeerSnapshotForAlert() {
          return overrides.tickerPeers || null;
        },
      },
      tokenAlertSignalBuilder: overrides.tokenAlertSignalBuilder,
    },
    eventWrites,
    rearmWrites,
    stateByRule,
    transactionLog,
    triggeredWrites,
  };
}

describe('user alert matcher', () => {
  it('emits a monitored-vol event for active users who match the backend signal', async () => {
    const profile = {
      userId: 15,
      ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
      thresholdPct: 50,
      minVol: 8000,
      minMcap: 30000,
      maxMcap: 0,
    };
    const context = createDeps({
      profiles: [profile],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 10000,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 250000,
        last_vol_5m: 12000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        last_pair_address: 'So11111111111111111111111111111111111111112',
        last_vol_5m: 18000,
        last_vol_1h: 50000,
        last_vol_6h: 120000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.evaluatedProfiles, 1);
    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'monitored-vol');
    assert.equal(context.eventWrites[0].payload.label, 'VOL');
    assert.equal(context.eventWrites[0].payload.prevVolume5m, 10000);
    assert.equal(context.eventWrites[0].payload.volume5m, 18000);
    assert.equal(context.eventWrites[0].payload.mcap, 300000);
    assert.equal(context.triggeredWrites.length, 1);
    assert.equal(context.triggeredWrites[0].lastAlertedPct, 80);
    assert.deepEqual(context.transactionLog, ['BEGIN', 'COMMIT', 'RELEASE']);
  });

  it('persists ticker peer snapshots with emitted backend alerts', async () => {
    const profile = {
      userId: 17,
      ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
      thresholdPct: 50,
      minVol: 8000,
      minMcap: 30000,
      maxMcap: 0,
    };
    const context = createDeps({
      profiles: [profile],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 10000,
      }],
      tickerPeers: {
        sourceSymbol: 'WSOL',
        normalizedSymbol: 'WSOL',
        count: 2,
        hasSubtickerMatch: false,
        items: [
          {
            address: TOKEN_ADDRESS,
            symbol: 'WSOL',
            mcap: 300000,
            ageMsAtAlert: 3600000,
            matchType: 'exact',
          },
          {
            address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
            symbol: 'WSOL',
            mcap: 120000,
            ageMsAtAlert: 7200000,
            matchType: 'exact',
          },
        ],
      },
    });

    await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 250000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_5m: 18000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].payload.tickerPeers?.count, 2);
    assert.equal(context.eventWrites[0].payload.tickerPeers?.items?.[1]?.address, '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb');
  });

  it('suppresses monitored-vol retriggers until the next alert beats the last alerted volume by the user threshold', async () => {
    const context = createDeps({
      profiles: [{
        userId: 8,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 50,
        minVol: 8000,
        minMcap: 30000,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 10000,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedPct: 80,
          lastAlertedValue: 18000,
          cooldownUntil: '2026-04-16T11:58:00.000Z',
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 250000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 20000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
    assert.equal(context.transactionLog.length, 0);
  });

  it('suppresses monitored-vol repeats when the current 5m volume did not advance and only the rolling baseline shrank', async () => {
    const context = createDeps({
      profiles: [{
        userId: 44,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 50,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 201,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 5150.05,
          lastAlertedValue: 16000,
          cooldownUntil: '2026-04-16T11:59:57.000Z',
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 309000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 16000,
        last_vol_24h: 136000,
        last_mcap: 317000,
      },
    }, { now: '2026-04-17T03:00:58.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses monitored-vol repeats when the absolute 5m volume only advances a little after cooldown', async () => {
    const context = createDeps({
      profiles: [{
        userId: 45,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 50,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 26000,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 243.26,
          lastAlertedValue: 57000,
          cooldownUntil: '2026-04-17T03:06:12.000Z',
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 613000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 63000,
        last_vol_24h: 1130000,
        last_mcap: 613000,
      },
    }, { now: '2026-04-17T03:06:15.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('requires monitored-vol repeats to beat the last alerted volume by the user threshold, not just the rolling 5m baseline', async () => {
    const context = createDeps({
      profiles: [{
        userId: 46,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 100,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 7000,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 128.57,
          lastAlertedValue: 16000,
          cooldownUntil: '2026-04-17T18:16:15.000Z',
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 36000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 24000,
        last_vol_24h: 24000,
        last_mcap: 38000,
      },
    }, { now: '2026-04-17T18:17:24.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('emits monitored-vol repeats against the last alerted volume and renders that anchored comparison in the payload', async () => {
    const context = createDeps({
      profiles: [{
        userId: 47,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 100,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 7000,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 128.57,
          lastAlertedValue: 16000,
          cooldownUntil: '2026-04-17T18:16:15.000Z',
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 36000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 32000,
        last_vol_24h: 32000,
        last_mcap: 38000,
      },
    }, { now: '2026-04-17T18:17:24.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].payload.prevVolume5m, 16000);
    assert.equal(context.eventWrites[0].payload.volume5m, 32000);
    assert.equal(context.eventWrites[0].payload.pct, 100);
  });

  it('preserves monitored-vol cooldown on rearm so a fast re-crossing cannot alert again within 60s', async () => {
    const cooldownUntil = '2026-04-16T12:01:00.000Z';
    const rearmContext = createDeps({
      profiles: [{
        userId: 41,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 50,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 10000,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedPct: 653.17,
          cooldownUntil,
        },
      },
    });

    const rearmResult = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 230000,
        last_vol_5m: 760,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_mcap: 231000,
        last_vol_5m: 900,
        last_vol_24h: 3390000,
      },
    }, { now: '2026-04-16T12:00:11.000Z', deps: rearmContext.deps });

    assert.equal(rearmResult.rearmed, 1);
    assert.equal(rearmContext.rearmWrites.length, 1);
    assert.equal(rearmContext.rearmWrites[0].cooldownUntil, cooldownUntil);

    const suppressContext = createDeps({
      profiles: [{
        userId: 41,
        ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
        thresholdPct: 50,
        minVol: 0,
        minMcap: 0,
        maxMcap: 0,
      }],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 554,
      }],
      stateByRule: {
        'monitored-vol': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 653.17,
          cooldownUntil,
        },
      },
    });

    const suppressResult = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 233000,
        last_vol_5m: 760,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_mcap: 235000,
        last_vol_5m: 6100,
        last_vol_24h: 3390000,
      },
    }, { now: '2026-04-16T12:00:22.000Z', deps: suppressContext.deps });

    assert.equal(suppressResult.emitted, 0);
    assert.equal(suppressResult.suppressed, 1);
    assert.equal(suppressContext.eventWrites.length, 0);
  });

  it('emits monitored-mcap alerts only after the token is old enough for the current frontend rule', async () => {
    const createdAt = Date.UTC(2026, 3, 16, 9, 0, 0);
    const context = createDeps({
      profiles: [{
        userId: 18,
        ruleEnabled: { monitoredVol: false, monitoredMcap: true, hvnc: false, meteoraSurge: false },
        mcapThresholdPct: 50,
        minVol: 8000,
        minMcap: 30000,
        maxMcap: 0,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 100000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 12000,
        last_vol_24h: 180000,
        last_mcap: 170000,
        last_token_created_at_ms: createdAt,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'monitored-mcap');
    assert.equal(context.eventWrites[0].payload.label, 'MCAP');
    assert.equal(context.eventWrites[0].payload.prevMcap, 100000);
    assert.equal(context.eventWrites[0].payload.mcap, 170000);
    assert.equal(context.triggeredWrites[0].lastAlertedPct, 70);
  });

  it('prefers the 1m market-cap bucket baseline over a stale tokenBefore catalog snapshot', async () => {
    const createdAt = Date.UTC(2026, 3, 17, 16, 0, 0);
    const context = createDeps({
      profiles: [{
        userId: 19,
        ruleEnabled: { monitoredVol: false, monitoredMcap: true, hvnc: false, meteoraSurge: false },
        mcapThresholdPct: 50,
        minVol: 8000,
        minMcap: 30000,
        maxMcap: 0,
      }],
      mcapRows: [{
        token_address: TOKEN_ADDRESS,
        current_ts: '2026-04-17T19:25:00.000Z',
        current_mcap: 52231,
        baseline_ts: '2026-04-17T19:20:00.000Z',
        baseline_mcap: 30100,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 10536,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_5m: 9813.43,
        last_vol_24h: 885000,
        last_mcap: 52231,
        last_token_created_at_ms: createdAt,
      },
    }, { now: '2026-04-17T19:25:08.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].payload.prevMcap, 30100);
    assert.equal(context.eventWrites[0].payload.mcap, 52231);
    assert.equal(Math.round(context.eventWrites[0].payload.pct), 74);
  });

  it('rearms hvnc when the token no longer matches the single-fire gate', async () => {
    const createdAt = Date.UTC(2026, 3, 16, 11, 45, 0);
    const context = createDeps({
      profiles: [{
        userId: 21,
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: true, meteoraSurge: false },
        hvncMinVol: 300000,
      }],
      stateByRule: {
        hvnc: {
          status: 'triggered',
          rearmRequired: true,
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_vol_24h: 200000,
        last_token_created_at_ms: createdAt,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.rearmed, 1);
    assert.equal(context.rearmWrites.length, 1);
    assert.equal(context.rearmWrites[0].ruleKey, 'hvnc');
  });

  it('emits hvnc for migrated PumpFun tokens during the post-migration window even when token age is older', async () => {
    const now = Date.UTC(2026, 3, 16, 12, 0, 0);
    const context = createDeps({
      profiles: [{
        userId: 22,
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: true, meteoraSurge: false },
        hvncMinVol: 300000,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        source: 'pumpfun-migrated',
        last_vol_24h: 350000,
        last_token_created_at_ms: now - (2 * 60 * 60 * 1000),
        migration_grace_until: new Date(now + (5 * 60 * 1000)).toISOString(),
      },
    }, { now: new Date(now), deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'hvnc');
  });

  it('emits meteora-surge from stored meteora baselines without frontend recomputation', async () => {
    const context = createDeps({
      profiles: [{
        userId: 5,
        loadedAt: '2026-04-16T10:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 25000,
        baselineTvl1h: 15625,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_5m: 12000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'meteora-surge');
    assert.equal(context.eventWrites[0].payload.label, 'METEORA 1H');
    assert.equal(Math.round(context.eventWrites[0].payload.pct), 60);
    assert.equal(context.eventWrites[0].payload.meteoraCurrentTvl, 25000);
    assert.equal(context.eventWrites[0].payload.meteoraBaselineTvl24h, 10000);
    assert.equal(
      context.triggeredWrites[0].cooldownUntil.toISOString(),
      '2026-04-16T12:30:00.000Z'
    );
  });

  it('primes a hot meteora surge during startup warmup instead of emitting immediately', async () => {
    const context = createDeps({
      profiles: [{
        userId: 6,
        loadedAt: '2026-04-16T11:59:30.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 25000,
        baselineTvl1h: 15625,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
    assert.equal(context.triggeredWrites.length, 1);
    assert.equal(context.triggeredWrites[0].ruleKey, 'meteora-surge');
    assert.equal(context.triggeredWrites[0].lastAlertedAt, null);
    assert.equal(context.triggeredWrites[0].metadata.lastDecision, 'primed-hot');
    assert.equal(context.triggeredWrites[0].metadata.sessionStartedAt, '2026-04-16T11:59:30.000Z');
  });

  it('suppresses a primed meteora surge until change1h advances by 10pp in the same session', async () => {
    const loadedAt = '2026-04-16T11:59:30.000Z';
    const context = createDeps({
      profiles: [{
        userId: 7,
        loadedAt,
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 25500,
        baselineTvl1h: 16451.61,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 50,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 370000,
        last_mcap: 302000,
      },
    }, { now: '2026-04-16T12:02:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('emits a primed meteora surge after change1h advances by 10pp in the same session', async () => {
    const loadedAt = '2026-04-16T11:59:30.000Z';
    const context = createDeps({
      profiles: [{
        userId: 8,
        loadedAt,
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 27500,
        baselineTvl1h: 17187.5,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 50,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 390000,
        last_mcap: 310000,
      },
    }, { now: '2026-04-16T12:02:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'meteora-surge');
  });

  it('keeps the meteora fingerprint stable when only mcap and volume24h drift', () => {
    const profile = {
      userId: 9,
      ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
      meteoraAlert1hThreshold: 50,
    };

    const first = userAlertMatcher.__private.buildMeteoraCandidate(
      profile,
      { symbol: 'WSOL' },
      {
        passesMeteoraPrereqs: true,
        meteoraChange1h: 62,
        meteoraCurrentTvl: 25900,
        meteoraBaselineTvl24h: 10000,
        meteoraBestPoolAddress: 'pool_meteora_primary',
        currentMcap: 300000,
        volume24h: 350000,
      }
    );
    const second = userAlertMatcher.__private.buildMeteoraCandidate(
      profile,
      { symbol: 'WSOL' },
      {
        passesMeteoraPrereqs: true,
        meteoraChange1h: 64,
        meteoraCurrentTvl: 26100,
        meteoraBaselineTvl24h: 10000,
        meteoraBestPoolAddress: 'pool_meteora_primary',
        currentMcap: 450000,
        volume24h: 510000,
      }
    );

    assert.equal(first.fingerprint, second.fingerprint);
  });

  it('suppresses a post-alert meteora repeat until change1h advances by 50pp and tvl grows 15%', async () => {
    const context = createDeps({
      profiles: [{
        userId: 10,
        loadedAt: '2026-04-16T11:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 28400,
        baselineTvl1h: 11269.84,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: '2026-04-16T12:00:00.000Z',
          lastAlertedPct: 60,
          lastAlertedValue: 25000,
          cooldownUntil: '2026-04-16T11:59:00.000Z',
          metadata: {
            lastDecision: 'triggered',
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 370000,
        last_mcap: 302000,
      },
    }, { now: '2026-04-16T12:31:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('emits a post-alert meteora repeat after change1h advances by 50pp and tvl grows 15%', async () => {
    const context = createDeps({
      profiles: [{
        userId: 10,
        loadedAt: '2026-04-16T11:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 29000,
        baselineTvl1h: 11153.85,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: '2026-04-16T12:00:00.000Z',
          lastAlertedPct: 60,
          lastAlertedValue: 25000,
          cooldownUntil: '2026-04-16T11:59:00.000Z',
          metadata: {
            lastDecision: 'triggered',
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 390000,
        last_mcap: 310000,
      },
    }, { now: '2026-04-16T12:31:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'meteora-surge');
  });

  it('preserves meteora cooldown on rearm so a fast pool/state flap cannot re-alert immediately', async () => {
    const cooldownUntil = '2026-04-16T12:30:00.000Z';
    const rearmContext = createDeps({
      profiles: [{
        userId: 11,
        loadedAt: '2026-04-16T11:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: false,
        currentTvl: null,
        baselineTvl1h: null,
        baselineTvl24h: null,
        bestPoolAddress: null,
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedPct: 60,
          cooldownUntil,
        },
      },
    });

    const rearmResult = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:02:00.000Z', deps: rearmContext.deps });

    assert.equal(rearmResult.rearmed, 1);
    assert.equal(rearmContext.rearmWrites.length, 1);
    assert.equal(rearmContext.rearmWrites[0].cooldownUntil, cooldownUntil);

    const suppressContext = createDeps({
      profiles: [{
        userId: 11,
        loadedAt: '2026-04-16T11:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 25000,
        baselineTvl1h: 15625,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 60,
          cooldownUntil,
        },
      },
    });

    const suppressResult = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:03:00.000Z', deps: suppressContext.deps });

    assert.equal(suppressResult.emitted, 0);
    assert.equal(suppressResult.suppressed, 1);
    assert.equal(suppressContext.eventWrites.length, 0);
  });

  it('allows a fresh meteora alert after rearm from falling below threshold', async () => {
    const context = createDeps({
      profiles: [{
        userId: 12,
        loadedAt: '2026-04-16T11:00:00.000Z',
        ruleEnabled: { monitoredVol: false, monitoredMcap: false, hvnc: false, meteoraSurge: true },
        meteoraAlert1hThreshold: 50,
      }],
      meteoraRows: [{
        tokenAddress: TOKEN_ADDRESS,
        hasPool: true,
        currentTvl: 25200,
        baselineTvl1h: 15750,
        baselineTvl24h: 10000,
        bestPoolAddress: 'pool_meteora_primary',
      }],
      stateByRule: {
        'meteora-surge': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedAt: '2026-04-16T12:00:00.000Z',
          lastAlertedPct: 60,
          lastAlertedValue: 25000,
          cooldownUntil: null,
          metadata: {
            lastDecision: 'rearmed',
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_24h: 355000,
        last_mcap: 301000,
      },
    }, { now: '2026-04-16T12:45:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'meteora-surge');
  });

  it('matches multiple active users from a single signal computation for the same token update', async () => {
    let buildSignalCalls = 0;
    const context = createDeps({
      profiles: [
        {
          userId: 1,
          ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
          thresholdPct: 50,
          minVol: 8000,
          minMcap: 30000,
          maxMcap: 0,
        },
        {
          userId: 2,
          ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
          thresholdPct: 80,
          minVol: 14000,
          minMcap: 30000,
          maxMcap: 0,
        },
        {
          userId: 3,
          ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
          thresholdPct: 90,
          minVol: 10000,
          minMcap: 30000,
          maxMcap: 0,
        },
      ],
      tokenAlertSignalBuilder: {
        buildTokenAlertSignals() {
          buildSignalCalls += 1;
          return {
            prevVolume5m: 10000,
            currentVolume5m: 18000,
            prevMcap: 250000,
            currentMcap: 300000,
            volume24h: 350000,
            tokenCreatedAt: null,
            hasVol5mBaseline: true,
            hasMcapBaseline: true,
            vol5mChangePct: 80,
            mcapChangePct: 20,
            isMcapDeclining: false,
            mcapAlertTokenAgeGatePassed: true,
            passesHvncPrereqs: false,
            passesMeteoraPrereqs: false,
            meteoraChange1h: null,
            meteoraCurrentTvl: null,
            meteoraBaselineTvl24h: null,
          };
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 250000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_5m: 18000,
        last_vol_1h: 50000,
        last_vol_6h: 120000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(buildSignalCalls, 1);
    assert.equal(result.evaluatedProfiles, 3);
    assert.equal(result.emitted, 2);
    assert.equal(context.eventWrites.length, 2);
    assert.deepEqual(context.eventWrites.map((item) => item.userId), [1, 2]);
    assert.equal(context.triggeredWrites.length, 2);
    assert.equal(context.transactionLog.filter((item) => item === 'BEGIN').length, 2);
  });

  it('emits recent surge when the 1h price change crosses the configured threshold after 2d and before 7d', async () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 31,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: true,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge1hThresholdPct: 25,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_1h: 18,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_mcap: 300000,
        last_vol_24h: 350000,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 32,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(result.suppressed, 0);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'recent-surge-1h');
    assert.equal(context.eventWrites[0].kind, 'old-surge');
    assert.equal(context.eventWrites[0].payload.label, 'PCHANGE 1H');
    assert.equal(context.eventWrites[0].payload.ageBucket, 'recent');
    assert.equal(context.eventWrites[0].payload.isOldSurge, true);
    assert.equal(context.eventWrites[0].payload.priceChange1h, 32);
  });

  it('coalesces backend dedupe keys for hidden monitored alerts so repeated hidden emits do not fan out rows', async () => {
    const hiddenSessionKey = 'hidden:1713268800000';
    const profile = {
      userId: 72,
      presenceMode: 'hidden',
      hiddenSessionKey,
      ruleEnabled: { monitoredVol: true, monitoredMcap: false, hvnc: false, meteoraSurge: false },
      thresholdPct: 50,
      minVol: 8000,
      minMcap: 30000,
      maxMcap: 0,
    };
    const context = createDeps({
      profiles: [profile],
      volumeRows: [{
        token_address: TOKEN_ADDRESS,
        baseline_vol_5m: 10000,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_mcap: 250000,
        last_vol_5m: 12000,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_vol_5m: 18000,
        last_vol_24h: 350000,
        last_mcap: 300000,
      },
    }, { now: '2026-04-16T12:00:00.000Z', deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(
      context.eventWrites[0].dedupeKey,
      `72:monitored-vol:${TOKEN_ADDRESS}:hidden`
    );
  });

  it('suppresses surge alerts for tokens below 30k market cap', async () => {
    const nowMs = Date.UTC(2026, 3, 17, 19, 17, 48);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 70,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: true,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge6hThresholdPct: 100,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_6h: 90,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'YUJI',
        last_mcap: 15000,
        last_vol_24h: 10000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 149,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 0);
    assert.equal(context.eventWrites.length, 0);
  });

  it('primes a hot old-week surge without emitting when the user first sees an already-hot token', async () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const createdAt = nowMs - (10 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 32,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 120,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_6h: 135,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_mcap: 300000,
        last_vol_24h: 350000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 150,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
    assert.equal(context.triggeredWrites.length, 1);
    assert.equal(context.triggeredWrites[0].ruleKey, 'old-week-surge-6h');
    assert.equal(context.triggeredWrites[0].metadata.lastDecision, 'primed-hot');
    assert.equal(context.triggeredWrites[0].metadata.sessionStartedAt, null);
  });

  it('suppresses surge crossings during the initial active-session warmup so old history is not dumped on connect', async () => {
    const nowMs = Date.UTC(2026, 3, 17, 4, 25, 45);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 52,
        loadedAt: new Date(nowMs - 20_000).toISOString(),
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: true,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge6hThresholdPct: 100,
      }],
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_6h: 99,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'RUDI',
        last_mcap: 247000,
        last_vol_24h: 280000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 105,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
    assert.equal(context.triggeredWrites.length, 1);
    assert.equal(context.triggeredWrites[0].lastAlertedAt, null);
    assert.equal(context.triggeredWrites[0].metadata.lastDecision, 'primed-hot');
  });

  it('rearms a surge rule after the price change drops back below the configured threshold', async () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 33,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: true,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge1hThresholdPct: 25,
      }],
      stateByRule: {
        'recent-surge-1h': {
          status: 'triggered',
          rearmRequired: true,
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 12,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.rearmed, 1);
    assert.equal(context.rearmWrites.length, 1);
    assert.equal(context.rearmWrites[0].ruleKey, 'recent-surge-1h');
  });

  it('suppresses repeated surge alerts in the same session unless the price change grows 50% from the last alert', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 39, 29);
    const createdAt = nowMs - (281 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 61,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 100,
          metadata: {
            lastDecision: 'rearmed',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'JONATHAN',
        last_mcap: 148000,
        last_vol_24h: 285000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 149,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses a primed 1h surge until the same-session price change advances by 5pp', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 39, 29);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 81,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: true,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge1hThresholdPct: 40,
      }],
      stateByRule: {
        'recent-surge-1h': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 50,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'LITE',
        last_mcap: 148000,
        last_vol_24h: 285000,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 54,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('emits a primed 1h surge after the same-session price change advances by 5pp', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 45, 0);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 82,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: true,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge1hThresholdPct: 40,
      }],
      stateByRule: {
        'recent-surge-1h': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 50,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'LIME',
        last_mcap: 151000,
        last_vol_24h: 295000,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 55,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'recent-surge-1h');
  });

  it('suppresses a primed 6h surge until the same-session price change advances by 10pp', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 39, 29);
    const createdAt = nowMs - (10 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 83,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 150,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'CLOUD',
        last_mcap: 500000,
        last_vol_24h: 299000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 159,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('emits a primed 6h surge after the same-session price change advances by 10pp', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 45, 0);
    const createdAt = nowMs - (33 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 84,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'triggered',
          rearmRequired: true,
          lastAlertedAt: null,
          lastAlertedPct: 150,
          metadata: {
            lastDecision: 'primed-hot',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'MINT',
        last_mcap: 500000,
        last_vol_24h: 299000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 160,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'old-week-surge-6h');
  });

  it('allows a same-session surge repeat after 50% relative price-change growth', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 7, 45, 0);
    const createdAt = nowMs - (33 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 62,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 100,
          cooldownUntil: new Date(nowMs - (1 * 60 * 1000)).toISOString(),
          metadata: {
            lastDecision: 'rearmed',
            lastAlertedMcap: 400000,
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'INCOME',
        last_mcap: 500000,
        last_vol_24h: 299000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 150,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 1);
    assert.equal(context.eventWrites.length, 1);
    assert.equal(context.eventWrites[0].ruleKey, 'old-week-surge-6h');
  });

  it('suppresses a 6h surge repeat until market cap advances by at least 15% from the last alerted mcap', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 8, 10, 0);
    const createdAt = nowMs - (33 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 64,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 100,
          cooldownUntil: new Date(nowMs - (1 * 60 * 1000)).toISOString(),
          metadata: {
            lastDecision: 'rearmed',
            lastAlertedMcap: 500000,
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'INCOME',
        last_mcap: 560000,
        last_vol_24h: 299000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 150,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses a 6h surge repeat during the 20m cooldown even when pct and mcap advanced enough', async () => {
    const loadedAt = '2026-04-17T07:35:00.000Z';
    const nowMs = Date.UTC(2026, 3, 17, 8, 10, 0);
    const createdAt = nowMs - (33 * 24 * 60 * 60 * 1000);
    const context = createDeps({
      profiles: [{
        userId: 65,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'old-week-surge-6h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedPct: 100,
          cooldownUntil: new Date(nowMs + (5 * 60 * 1000)).toISOString(),
          metadata: {
            lastDecision: 'rearmed',
            lastAlertedMcap: 400000,
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'INCOME',
        last_mcap: 500000,
        last_vol_24h: 299000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 150,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses a 6h surge if the sibling 1h surge fired for the same token within the last hour', async () => {
    const nowMs = Date.UTC(2026, 3, 17, 17, 54, 11);
    const createdAt = nowMs - (30 * 24 * 60 * 60 * 1000);
    const loadedAt = new Date(nowMs - 5 * 60 * 1000).toISOString();
    const context = createDeps({
      profiles: [{
        userId: 63,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: false,
          oldWeekSurge1h: true,
          oldWeekSurge6h: true,
          meteoraSurge: false,
        },
        oldWeekSurge1hThresholdPct: 50,
        oldWeekSurge6hThresholdPct: 100,
      }],
      getState(userId, ruleKey) {
        if (ruleKey === 'old-week-surge-6h') {
          return null;
        }
        if (ruleKey === 'old-week-surge-1h') {
          return {
            status: 'triggered',
            rearmRequired: true,
            lastAlertedAt: new Date(nowMs - (7 * 1000)).toISOString(),
            lastAlertedPct: 79.61,
            metadata: {
              lastDecision: 'triggered',
              sessionStartedAt: loadedAt,
            },
          };
        }
        return null;
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_1h: 75,
        last_price_change_6h: 99,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'FORG',
        last_mcap: 165000,
        last_vol_24h: 14000,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 79.61,
        last_price_change_6h: 125,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses a repeated 6h surge for the same token within one hour even if the pct advanced', async () => {
    const nowMs = Date.UTC(2026, 3, 17, 19, 11, 11);
    const createdAt = nowMs - (2 * 24 * 60 * 60 * 1000);
    const loadedAt = new Date(nowMs - (15 * 60 * 1000)).toISOString();
    const context = createDeps({
      profiles: [{
        userId: 71,
        loadedAt,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: false,
          recentSurge6h: true,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge6hThresholdPct: 100,
      }],
      stateByRule: {
        'recent-surge-6h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedAt: new Date(nowMs - (3 * 60 * 1000)).toISOString(),
          lastAlertedPct: 5427,
          lastAlertedValue: 5427,
          metadata: {
            lastDecision: 'rearmed',
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_6h: 5400,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'PEACE',
        last_mcap: 178260000,
        last_vol_24h: 1370000,
        last_token_created_at_ms: createdAt,
        last_price_change_6h: 5587,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });

  it('suppresses repeated surge emits while the same hidden session stays active even if the candidate advances enough to repeat', async () => {
    const nowMs = Date.UTC(2026, 3, 17, 20, 4, 0);
    const createdAt = nowMs - (3 * 24 * 60 * 60 * 1000);
    const loadedAt = new Date(nowMs - (25 * 60 * 1000)).toISOString();
    const hiddenSessionKey = `hidden:${nowMs - (5 * 60 * 1000)}`;
    const context = createDeps({
      profiles: [{
        userId: 73,
        loadedAt,
        presenceMode: 'hidden',
        hiddenSessionKey,
        ruleEnabled: {
          monitoredVol: false,
          monitoredMcap: false,
          hvnc: false,
          recentSurge1h: true,
          recentSurge6h: false,
          oldWeekSurge1h: false,
          oldWeekSurge6h: false,
          meteoraSurge: false,
        },
        recentSurge1hThresholdPct: 40,
      }],
      stateByRule: {
        'recent-surge-1h': {
          status: 'rearmed',
          rearmRequired: false,
          lastAlertedAt: new Date(nowMs - (2 * 60 * 1000)).toISOString(),
          lastAlertedPct: 80,
          lastAlertedValue: 80,
          metadata: {
            lastDecision: 'rearmed',
            lastHiddenSessionKey: hiddenSessionKey,
            sessionStartedAt: loadedAt,
          },
        },
      },
    });

    const result = await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: {
        address: TOKEN_ADDRESS,
        last_price_change_1h: 70,
      },
      tokenAfter: {
        address: TOKEN_ADDRESS,
        symbol: 'WSOL',
        last_mcap: 300000,
        last_vol_24h: 350000,
        last_token_created_at_ms: createdAt,
        last_price_change_1h: 140,
      },
    }, { now: new Date(nowMs), deps: context.deps });

    assert.equal(result.emitted, 0);
    assert.equal(result.suppressed, 1);
    assert.equal(context.eventWrites.length, 0);
  });
});
