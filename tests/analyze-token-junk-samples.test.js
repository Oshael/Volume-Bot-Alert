const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAnalysisSummary,
  buildCompactEntry,
  normalizeHumanLabel,
  parseArgs,
  summarizeCandleShape,
} = require('../src/utils/analyze-token-junk-samples');

describe('analyze token junk samples helpers', () => {
  it('parses CLI args with equals and value syntax', () => {
    const parsed = parseArgs([
      '--input=data/in.json',
      '--output',
      'data/out.json',
      '--only-mismatches',
    ]);

    assert.deepEqual(parsed, {
      input: 'data/in.json',
      output: 'data/out.json',
      'only-mismatches': 'true',
    });
  });

  it('summarizes candle shape metrics from market history payload', () => {
    const summary = summarizeCandleShape({
      snapshots: [
        { openMcap: 100, closeMcap: 110 },
        { openMcap: 110, closeMcap: 121 },
        { openMcap: 121, closeMcap: 118 },
        { openMcap: 118, closeMcap: 122 },
      ],
    });

    assert.equal(summary.totalCandles, 4);
    assert.equal(summary.greenCandles, 3);
    assert.equal(summary.redCandles, 1);
    assert.equal(summary.longestGreenStreak, 2);
    assert.equal(summary.directionChanges, 2);
    assert.equal(summary.greenRate, 75);
    assert.equal(summary.redRate, 25);
    assert.ok(summary.pathEfficiencyPct > 0);
  });

  it('builds a compact analysis row with partial metric assessment', () => {
    const entry = buildCompactEntry({
      address: 'So11111111111111111111111111111111111111112',
      label: 'junk',
      confidence: 'high',
      reason: 'test reason',
      collection: {
        dexscreener: {
          summary: {
            symbol: 'TEST',
            dexId: 'raydium',
            marketCap: 600000,
            liquidityUsd: 10000,
            volume5m: 40,
            volume1h: 120,
            volume6h: 900,
            volume24h: 1500,
            txns1hBuys: 6,
            txns1hSells: 1,
            txns24hBuys: 40,
            txns24hSells: 2,
            priceChange24h: 180,
          },
        },
        marketHistory: {
          summary: {
            snapshotCount: 4,
            totalSampleCount: 40,
            rangePct: 90,
            driftPct: 88,
          },
          payload: {
            snapshots: [
              { openMcap: 100, closeMcap: 120 },
              { openMcap: 120, closeMcap: 150 },
              { openMcap: 150, closeMcap: 175 },
              { openMcap: 175, closeMcap: 180 },
            ],
          },
        },
        meteora: {
          summary: {
            noPool: true,
            poolCount: 0,
            latestTvl: null,
            change24h: null,
          },
        },
      },
    });

    assert.equal(entry.address, 'So11111111111111111111111111111111111111112');
    assert.equal(entry.rawHumanLabel, 'junk');
    assert.equal(entry.humanLabel, 'junk_probable');
    assert.equal(entry.dex.symbol, 'TEST');
    assert.equal(entry.metricPartialContext, true);
    assert.equal(entry.heuristicFlags.lowLiquidityToMcap, true);
    assert.equal(entry.heuristicFlags.oneSidedOrderFlow24h, true);
    assert.equal(entry.marketHistory.shape.longestGreenStreak, 4);
  });

  it('normalizes short human labels into the internal label vocabulary', () => {
    assert.equal(normalizeHumanLabel('junk'), 'junk_probable');
    assert.equal(normalizeHumanLabel('legit'), 'valid');
    assert.equal(normalizeHumanLabel('weak but legit'), 'valid_but_weak');
    assert.equal(normalizeHumanLabel('junk_permanent'), 'junk_permanent');
  });

  it('builds summary counts and confusion matrix', () => {
    const summary = buildAnalysisSummary([
      { humanLabel: 'valid', metricLabel: 'valid', agreesWithHuman: true },
      { humanLabel: 'junk_probable', metricLabel: 'valid_but_weak', agreesWithHuman: false },
      { humanLabel: 'junk_probable', metricLabel: 'junk_probable', agreesWithHuman: true },
    ]);

    assert.equal(summary.totalEntries, 3);
    assert.equal(summary.humanLabelCounts.valid, 1);
    assert.equal(summary.humanLabelCounts.junk_probable, 2);
    assert.equal(summary.metricLabelCounts.valid, 1);
    assert.equal(summary.agreementCount, 2);
    assert.equal(summary.disagreementCount, 1);
    assert.equal(summary.confusionMatrix.junk_probable.valid_but_weak, 1);
  });
});
