const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenAlertSignalBuilder = require('../src/services/token-alert-signal-builder');

describe('token alert signal builder', () => {
  it('uses a 5 minute max age gate for HVNC', () => {
    assert.equal(tokenAlertSignalBuilder.HVNC_MAX_AGE_MS, 5 * 60 * 1000);
  });

  it('builds reusable monitored, hvnc, and meteora signals from dashboard-like input', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const createdAt = nowMs - (5 * 60 * 1000);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      volume5m: 18000,
      prevVolume5mCanonical: 10000,
      mcap: 300000,
      prevMcap: 250000,
      volume24h: 350000,
      tokenCreatedAt: createdAt,
      priceChange1h: 28,
      priceChange6h: 120,
      prevPriceChange1h: 18,
      prevPriceChange6h: 95,
      meteora: {
        noPool: false,
        tvl: 25000,
        change1h: 60,
        change24h: 120,
      },
    }, { nowMs });

    assert.equal(signals.address, 'So11111111111111111111111111111111111111112');
    assert.equal(signals.generatedAt, '2026-04-16T12:00:00.000Z');
    assert.equal(signals.currentVolume5m, 18000);
    assert.equal(signals.prevVolume5m, 10000);
    assert.equal(signals.vol5mChangePct, 80);
    assert.equal(signals.currentMcap, 300000);
    assert.equal(signals.prevMcap, 250000);
    assert.equal(signals.mcapChangePct, 20);
    assert.equal(signals.currentPriceChange1h, 28);
    assert.equal(signals.prevPriceChange1h, 18);
    assert.equal(signals.currentPriceChange6h, 120);
    assert.equal(signals.prevPriceChange6h, 95);
    assert.equal(signals.isMcapDeclining, false);
    assert.equal(signals.ageMs, 5 * 60 * 1000);
    assert.equal(signals.hvncAgeGatePassed, true);
    assert.equal(signals.hvncVolume24hGatePassed, true);
    assert.equal(signals.passesHvncPrereqs, true);
    assert.equal(signals.mcapAlertTokenAgeGatePassed, false);
    assert.equal(signals.recentSurgeAgeGatePassed, false);
    assert.equal(signals.oldWeekSurgeAgeGatePassed, false);
    assert.equal(signals.meteoraCurrentTvl, 25000);
    assert.equal(Math.round(signals.meteoraBaselineTvl1h), 15625);
    assert.equal(Math.round(signals.meteoraBaselineTvl24h), 11364);
    assert.equal(signals.meteoraHasPool, true);
    assert.equal(signals.meteoraMinTvlGatePassed, true);
    assert.equal(signals.meteoraBaseline1hGatePassed, true);
    assert.equal(signals.passesMeteoraPrereqs, true);
  });

  it('prioritizes internal market-bucket surge changes over catalog price change fields', () => {
    const nowMs = Date.UTC(2026, 6, 7, 8, 0, 0);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      internal_surge_current_ts: new Date('2026-07-07T08:00:00.000Z'),
      internal_surge_current_mcap: 1900000,
      internal_surge_baseline_1h_ts: new Date('2026-07-07T07:00:00.000Z'),
      internal_surge_baseline_1h_mcap: 800000,
      internal_surge_baseline_6h_ts: new Date('2026-07-07T02:00:00.000Z'),
      internal_surge_baseline_6h_mcap: 760000,
      last_price_change_1h: 12,
      last_price_change_6h: 18,
    }, { nowMs });

    assert.equal(signals.currentMcap, null);
    assert.equal(Math.round(signals.currentPriceChange1h * 100) / 100, 137.5);
    assert.equal(Math.round(signals.currentPriceChange6h * 100) / 100, 150);
    assert.equal(signals.internalSurge1hAvailable, true);
    assert.equal(signals.internalSurge6hAvailable, true);
    assert.equal(signals.internalSurgeCurrentMcap, 1900000);
    assert.equal(signals.internalSurgeBaseline1hMcap, 800000);
    assert.equal(signals.internalSurgeCurrentTs, '2026-07-07T08:00:00.000Z');
    assert.equal(signals.internalSurgeBaseline1hTs, '2026-07-07T07:00:00.000Z');
    assert.equal(signals.internalSurgeBaseline6hTs, '2026-07-07T02:00:00.000Z');
  });

  it('falls back to catalog surge changes when an internal market-bucket baseline is missing', () => {
    const nowMs = Date.UTC(2026, 6, 7, 8, 0, 0);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      internal_surge_current_mcap: 1900000,
      last_price_change_1h: 44,
      last_price_change_6h: 88,
    }, { nowMs });

    assert.equal(signals.currentPriceChange1h, 44);
    assert.equal(signals.currentPriceChange6h, 88);
    assert.equal(signals.internalSurge1hAvailable, false);
    assert.equal(signals.internalSurge6hAvailable, false);
  });

  it('uses post-migration age instead of pre-migration token age for PumpFun HVNC', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      source: 'pumpfun-migrated',
      last_token_created_at_ms: nowMs - (2 * 60 * 60 * 1000),
      migration_grace_until: new Date(nowMs + (5 * 60 * 1000)).toISOString(),
      last_vol_24h: 350000,
    }, { nowMs });

    assert.equal(signals.ageMs, 2 * 60 * 60 * 1000);
    assert.equal(signals.migrationAgeMs, 5 * 60 * 1000);
    assert.equal(signals.hvncAgeGatePassed, true);
    assert.equal(signals.passesHvncPrereqs, true);
  });

  it('rejects normal HVNC tokens older than 5 minutes', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      volume24h: 350000,
      tokenCreatedAt: nowMs - (5 * 60 * 1000) - 1,
    }, { nowMs });

    assert.equal(signals.ageMs, (5 * 60 * 1000) + 1);
    assert.equal(signals.hvncAgeGatePassed, false);
    assert.equal(signals.passesHvncPrereqs, false);
  });

  it('does not let pre-migration token age qualify an expired PumpFun HVNC window', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      source: 'pumpfun-migrated',
      last_token_created_at_ms: nowMs - (5 * 60 * 1000),
      migration_grace_until: new Date(nowMs - (60 * 1000)).toISOString(),
      last_vol_24h: 350000,
    }, { nowMs });

    assert.equal(signals.ageMs, 5 * 60 * 1000);
    assert.equal(signals.migrationAgeMs, 11 * 60 * 1000);
    assert.equal(signals.hvncAgeGatePassed, false);
    assert.equal(signals.passesHvncPrereqs, false);
  });

  it('accepts backend-shaped aliases and exposes declining mcap / old-token gates', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const createdAt = nowMs - (2 * 60 * 60 * 1000);

    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      last_vol_5m: 12000,
      baseline_vol_5m: 8000,
      last_mcap: 90000,
      baseline_mcap: 100000,
      last_vol_24h: 2000,
      last_token_created_at_ms: createdAt,
      last_price_change_1h: 36,
      baseline_price_change_1h: 12,
      last_price_change_6h: 180,
      baseline_price_change_6h: 130,
      meteoraCurrentTvl: 9000,
      meteoraChange1h: 80,
      meteoraNoPool: true,
    }, { nowMs });

    assert.equal(signals.vol5mChangePct, 50);
    assert.equal(signals.mcapChangePct, -10);
    assert.equal(signals.isMcapDeclining, true);
    assert.equal(signals.ageMs, 2 * 60 * 60 * 1000);
    assert.equal(signals.currentPriceChange1h, 36);
    assert.equal(signals.prevPriceChange1h, 12);
    assert.equal(signals.currentPriceChange6h, 180);
    assert.equal(signals.prevPriceChange6h, 130);
    assert.equal(signals.hvncAgeGatePassed, false);
    assert.equal(signals.hvncVolume24hGatePassed, true);
    assert.equal(signals.passesHvncPrereqs, false);
    assert.equal(signals.mcapAlertTokenAgeGatePassed, true);
    assert.equal(signals.recentSurgeAgeGatePassed, false);
    assert.equal(signals.oldWeekSurgeAgeGatePassed, false);
    assert.equal(signals.meteoraHasPool, false);
    assert.equal(signals.meteoraMinTvlGatePassed, false);
    assert.equal(signals.meteoraBaseline1hGatePassed, false);
    assert.equal(signals.passesMeteoraPrereqs, false);
  });

  it('returns null metrics and closed prereq gates when canonical facts are missing', () => {
    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      volume5m: 0,
      mcap: null,
      volume24h: null,
      meteora: {
        noPool: false,
        tvl: null,
        change1h: null,
      },
    }, { nowMs: Date.UTC(2026, 3, 16, 12, 0, 0) });

    assert.equal(signals.vol5mChangePct, null);
    assert.equal(signals.mcapChangePct, null);
    assert.equal(signals.ageMs, null);
    assert.equal(signals.hasVol5mBaseline, false);
    assert.equal(signals.hasMcapBaseline, false);
    assert.equal(signals.hvncAgeGatePassed, false);
    assert.equal(signals.hvncVolume24hGatePassed, false);
    assert.equal(signals.passesHvncPrereqs, false);
    assert.equal(signals.currentPriceChange1h, null);
    assert.equal(signals.currentPriceChange6h, null);
    assert.equal(signals.recentSurgeAgeGatePassed, false);
    assert.equal(signals.oldWeekSurgeAgeGatePassed, false);
    assert.equal(signals.meteoraCurrentTvl, null);
    assert.equal(signals.meteoraBaselineTvl1h, null);
    assert.equal(signals.meteoraHasPool, true);
    assert.equal(signals.meteoraMinTvlGatePassed, false);
    assert.equal(signals.meteoraBaseline1hGatePassed, false);
    assert.equal(signals.passesMeteoraPrereqs, false);
  });

  it('derives Meteora percentage changes from persisted baselines when direct change fields are absent', () => {
    const signals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      meteoraCurrentTvl: 25000,
      meteoraBaselineTvl1h: 15625,
      meteoraBaselineTvl24h: 10000,
      meteoraNoPool: false,
    }, { nowMs: Date.UTC(2026, 3, 16, 12, 0, 0) });

    assert.equal(Math.round(signals.meteoraChange1h), 60);
    assert.equal(Math.round(signals.meteoraChange24h), 150);
    assert.equal(signals.passesMeteoraPrereqs, true);
  });

  it('exposes recent and old-week surge age gates from token age', () => {
    const nowMs = Date.UTC(2026, 3, 16, 12, 0, 0);
    const oneAndHalfDaySignals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      tokenCreatedAt: nowMs - (36 * 60 * 60 * 1000),
    }, { nowMs });
    const recentSignals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      tokenCreatedAt: nowMs - (3 * 24 * 60 * 60 * 1000),
    }, { nowMs });
    const oldWeekSignals = tokenAlertSignalBuilder.buildTokenAlertSignals({
      address: 'So11111111111111111111111111111111111111112',
      tokenCreatedAt: nowMs - (9 * 24 * 60 * 60 * 1000),
    }, { nowMs });

    assert.equal(oneAndHalfDaySignals.recentSurgeAgeGatePassed, true);
    assert.equal(oneAndHalfDaySignals.recentSurge1hAgeGatePassed, true);
    assert.equal(oneAndHalfDaySignals.recentSurge6hAgeGatePassed, false);
    assert.equal(oneAndHalfDaySignals.oldWeekSurgeAgeGatePassed, false);
    assert.equal(recentSignals.recentSurgeAgeGatePassed, true);
    assert.equal(recentSignals.recentSurge1hAgeGatePassed, true);
    assert.equal(recentSignals.recentSurge6hAgeGatePassed, true);
    assert.equal(recentSignals.oldWeekSurgeAgeGatePassed, false);
    assert.equal(oldWeekSignals.recentSurgeAgeGatePassed, false);
    assert.equal(oldWeekSignals.recentSurge1hAgeGatePassed, false);
    assert.equal(oldWeekSignals.recentSurge6hAgeGatePassed, false);
    assert.equal(oldWeekSignals.oldWeekSurgeAgeGatePassed, true);
  });
});
