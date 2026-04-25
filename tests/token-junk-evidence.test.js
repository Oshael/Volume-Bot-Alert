const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenJunkEvidence = require('../src/models/token-junk-evidence');
const evidenceCapture = require('../src/services/token-junk-evidence-capture');

describe('token junk evidence model', () => {
  it('creates compact evidence rows', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 12,
          token_address: 'So11111111111111111111111111111111111111112',
          label: 'junk_probable',
          source: 'auto_sync',
          assessment_fingerprint: 'abc123',
          assessment: { label: 'junk_probable' },
          catalog_snapshot: { symbol: 'SOL' },
          market_history: { summary: { snapshotCount: 2 } },
          meteora_history: { summary: { snapshotCount: 1 } },
          created_at: '2026-04-25T03:00:00.000Z',
        }],
      };
    };

    try {
      const row = await tokenJunkEvidence.createEvidence({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        label: 'junk_probable',
        assessmentFingerprint: 'abc123',
        assessment: { label: 'junk_probable' },
        catalogSnapshot: { symbol: 'SOL' },
        marketHistory: { summary: { snapshotCount: 2 } },
        meteoraHistory: { summary: { snapshotCount: 1 } },
      });

      assert.deepEqual(capturedParams, [
        'So11111111111111111111111111111111111111112',
        'junk_probable',
        'auto_sync',
        'abc123',
        JSON.stringify({ label: 'junk_probable' }),
        JSON.stringify({ symbol: 'SOL' }),
        JSON.stringify({ summary: { snapshotCount: 2 } }),
        JSON.stringify({ summary: { snapshotCount: 1 } }),
      ]);
      assert.equal(row.id, 12);
      assert.equal(row.label, 'junk_probable');
      assert.equal(row.marketHistory.summary.snapshotCount, 2);
    } finally {
      db.query = originalQuery;
    }
  });
});

describe('token junk evidence capture service', () => {
  it('skips non-junk labels', async () => {
    const result = await evidenceCapture.captureJunkEvidence(
      { address: 'So11111111111111111111111111111111111111112' },
      { label: 'valid' },
      null,
      {}
    );

    assert.deepEqual(result, {
      saved: false,
      skipped: 'non_junk_label',
    });
  });

  it('skips duplicate evidence fingerprints before fetching history', async () => {
    let marketFetched = false;
    const result = await evidenceCapture.captureJunkEvidence(
      {
        address: 'So11111111111111111111111111111111111111112',
        last_mcap: 880000,
      },
      {
        label: 'junk_probable',
        reasonCodes: ['volume_to_mcap_too_low'],
      },
      {
        hasPool: false,
        poolCount: 0,
        currentTvl: null,
      },
      {
        tokenJunkEvidenceModel: {
          hasFingerprint: async () => true,
        },
        tokenMarketBucket1mModel: {
          listHistoryByAddress: async () => {
            marketFetched = true;
            return [];
          },
        },
      }
    );

    assert.equal(result.saved, false);
    assert.equal(result.skipped, 'duplicate');
    assert.equal(marketFetched, false);
  });

  it('captures sampled market and Meteora evidence for new junk fingerprints', async () => {
    const createdPayloads = [];
    const result = await evidenceCapture.captureJunkEvidence(
      {
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Solana',
        last_mcap: 880000,
        last_price: 1.23456789,
        last_vol_5m: 11,
        last_vol_1h: 222,
        last_vol_6h: 333,
        last_vol_24h: 444,
        last_liquidity_usd: 555,
        last_txns_1h_buys: 2,
        last_txns_1h_sells: 3,
        last_txns_24h_buys: 10,
        last_txns_24h_sells: 14,
        risk_holder_count: 120,
        risk_top_10_pct: 44.4,
        risk_top_20_pct: 55.5,
      },
      {
        label: 'junk_probable',
        confidence: 'medium',
        mode: 'v1_manual_review',
        strongSignalCount: 2,
        reasonCodes: ['volume_to_mcap_too_low'],
        strongSignals: [],
        weakSignals: ['volume_to_mcap_too_low'],
        behavioralSignals: [],
        positiveSignals: [],
        marketCap: 880000,
        liquidityUsd: 555,
        liquidityToMcapRatio: 0.0006,
        volToMcapRatio: 0.01,
        txns24hTotal: 24,
        buySellImbalanceRatio24h: 1.4,
        manualReviewRequired: true,
      },
      {
        hasPool: false,
        poolCount: 0,
        currentTvl: null,
        lastCheckedAt: '2026-04-25T03:00:00.000Z',
      },
      {
        tokenJunkEvidenceModel: {
          hasFingerprint: async () => false,
          createEvidence: async (payload) => {
            createdPayloads.push(payload);
            return { id: 1, tokenAddress: payload.tokenAddress };
          },
        },
        tokenMarketBucket1mModel: {
          listHistoryByAddress: async () => ([
            { ts: '2026-04-25T00:00:00.000Z', mcap: 100, price: 1, pairAddress: 'Pair1', sampleCount: 2 },
            { ts: '2026-04-25T00:01:00.000Z', mcap: 150, price: 1.2, pairAddress: 'Pair1', sampleCount: 3 },
          ]),
        },
        tokenMeteoraSnapshotModel: {
          listHistoryByAddress: async () => ([
            { ts: '2026-04-25T00:00:00.000Z', total_tvl: 10, pool_count: 1, best_pool_address: 'Pool1' },
          ]),
        },
      }
    );

    assert.equal(result.saved, true);
    assert.equal(createdPayloads.length, 1);
    assert.equal(createdPayloads[0].label, 'junk_probable');
    assert.equal(createdPayloads[0].marketHistory.summary.snapshotCount, 2);
    assert.equal(createdPayloads[0].marketHistory.points.length, 2);
    assert.equal(createdPayloads[0].meteoraHistory.summary.snapshotCount, 1);
    assert.equal(createdPayloads[0].catalogSnapshot.symbol, 'SOL');
  });
});
