const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const dryRun = require('../src/utils/quicknode-onchain-dry-run');

describe('quicknode onchain dry run', () => {
  it('uses the agreed SOL and USD minimums by default', () => {
    const previous = { ...process.env };
    try {
      process.env.QUICKNODE_SOLANA_WS_URL = 'wss://example.test/';
      delete process.env.QUICKNODE_DRY_RUN_MIN_SOL_VOLUME;
      delete process.env.QUICKNODE_DRY_RUN_MIN_USD_VOLUME;

      const options = dryRun.readOptionsFromEnv();

      assert.equal(options.minSolVolume, 0.01);
      assert.equal(options.minUsdVolume, 1.5);
    } finally {
      process.env = previous;
    }
  });

  it('uses PumpSwap and Raydium programs by default without bonding curve', () => {
    const programs = dryRun.resolveDryRunPrograms('');

    assert.deepEqual(programs.map((program) => program.label), [
      'pumpswap',
      'meteora-dlmm',
      'raydium-cpmm',
      'raydium-clmm',
      'raydium-amm-v4',
    ]);
    assert.equal(programs.some((program) => /bond/i.test(program.label)), false);
  });

  it('reports usable prices and ambiguous routed swaps separately', () => {
    const report = dryRun.createPriceObservationReport([{
      candidates: [
        {
          accepted: true,
          program: 'pumpswap',
          signature: 'usable-price',
          tokenMint: 'UsablePriceToken11111111111111111111111111111',
          tokenDelta: 10_000,
          wsolDelta: -0.2,
          uniqueNonQuoteMintCount: 1,
        },
        {
          accepted: true,
          program: 'raydium-clmm',
          signature: 'ambiguous-price',
          tokenMint: 'AmbiguousToken111111111111111111111111111111',
          tokenDelta: 10_000,
          wsolDelta: -0.2,
          uniqueNonQuoteMintCount: 2,
        },
      ],
    }]);

    assert.equal(report.observations.length, 1);
    assert.equal(report.observations[0].price, 0.00002);
    assert.deepEqual(report.skippedByReason, { ambiguous_non_quote_mints: 1 });
  });

  it('builds per-program cost and ingestion report', () => {
    const report = dryRun.buildProgramReport(
      { label: 'pumpswap', address: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
      {
        seen: 6,
        skippedMentionOnly: 4,
        matches: [{ signature: 'a' }, { signature: 'b' }],
        traffic: {
          messages: 7,
          receivedBytes: 150000,
          notificationBytes: 149000,
          mentionOnlyBytes: 100000,
          matchBytes: 49000,
        },
      },
      {
        accepted: 1,
        blocked: 1,
        lowVolume: 2,
        skipped: 1,
        candidates: [{
          accepted: true,
          tokenMint: 'TokenA111111111111111111111111111111111111',
          program: 'pumpswap',
          signature: 'a',
          estimatedSolVolume: 0.2,
          volumeSource: 'wsol',
          blockTime: 1_000,
          tokenDelta: 5_000,
          wsolDelta: -0.2,
          uniqueNonQuoteMintCount: 1,
        }],
        skippedEvents: [{
          tokenMint: 'TokenB111111111111111111111111111111111111',
          program: 'pumpswap',
          signature: 'b',
          skipReason: 'low_volume',
          estimatedSolVolume: 0.001,
          volumeSource: 'wsol',
        }],
      },
    );

    assert.equal(report.program, 'pumpswap');
    assert.equal(report.matches, 2);
    assert.equal(report.accepted, 1);
    assert.equal(report.blocked, 1);
    assert.equal(report.lowVolume, 2);
    assert.equal(report.candidates[0].tokenMint, 'TokenA111111111111111111111111111111111111');
    assert.equal(report.candidates[0].accepted, true);
    assert.equal(report.candidates[0].tokenDelta, 5_000);
    assert.equal(report.skippedEvents[0].skipReason, 'low_volume');
    assert.equal(report.traffic.estimatedCredits, 22.5);
  });

  it('aggregates dry-run reports for final cost summary', () => {
    const summary = dryRun.createDryRunSummary([
      {
        seen: 6,
        matches: 2,
        skippedMentionOnly: 4,
        accepted: 1,
        blocked: 1,
        lowVolume: 2,
        traffic: { receivedBytes: 150000, estimatedCredits: 22.5 },
      },
      {
        seen: 2,
        matches: 1,
        skippedMentionOnly: 1,
        accepted: 1,
        blocked: 0,
        lowVolume: 1,
        traffic: { receivedBytes: 30000, estimatedCredits: 4.5 },
      },
    ]);

    assert.deepEqual(summary, {
      programs: 2,
      seen: 8,
      matches: 3,
      skippedMentionOnly: 5,
      accepted: 2,
      blocked: 1,
      lowVolume: 3,
      receivedBytes: 180000,
      estimatedCredits: 27,
    });
  });

  it('aggregates accepted and skipped dry-run events by token', () => {
    const tokenReports = dryRun.createTokenReports([
      {
        candidates: [
          {
            tokenMint: 'TokenA111111111111111111111111111111111111',
            program: 'pumpswap',
            signature: 'sig-a',
            estimatedSolVolume: 0.03,
            estimatedUsdVolume: null,
            volumeSource: 'wsol',
            blockTime: 1_000,
          },
          {
            tokenMint: 'TokenA111111111111111111111111111111111111',
            program: 'raydium-clmm',
            signature: 'sig-b',
            estimatedSolVolume: null,
            estimatedUsdVolume: 120.245,
            volumeSource: 'usdc',
            blockTime: 1_000,
          },
        ],
        skippedEvents: [
          {
            tokenMint: 'TokenB111111111111111111111111111111111111',
            program: 'meteora-dlmm',
            signature: 'sig-c',
            skipReason: 'low_volume',
            estimatedUsdVolume: 0.5,
            volumeSource: 'usdc',
          },
        ],
      },
      {
        candidates: [
          {
            tokenMint: 'TokenC111111111111111111111111111111111111',
            program: 'raydium-cpmm',
            signature: 'sig-d',
            estimatedSolVolume: 0.02,
            volumeSource: 'wsol',
            blockTime: 1_000,
          },
        ],
        skippedEvents: [
          {
            tokenMint: 'TokenA111111111111111111111111111111111111',
            program: 'raydium-amm-v4',
            signature: 'sig-e',
            skipReason: 'admin_blocked',
            volumeSource: 'none',
          },
        ],
      },
    ]);

    assert.equal(tokenReports[0].tokenMint, 'TokenA111111111111111111111111111111111111');
    assert.equal(tokenReports[0].accepted, 2);
    assert.equal(tokenReports[0].blocked, 1);
    assert.equal(tokenReports[0].estimatedSolVolume, 0.03);
    assert.equal(tokenReports[0].estimatedUsdVolume, 120.25);
    assert.deepEqual(tokenReports[0].programs, ['pumpswap', 'raydium-amm-v4', 'raydium-clmm']);
    assert.deepEqual(tokenReports[0].volumeSources, { none: 1, usdc: 1, wsol: 1 });
    assert.deepEqual(tokenReports[0].sampleSignatures, ['sig-a', 'sig-b', 'sig-e']);

    assert.equal(tokenReports[1].tokenMint, 'TokenC111111111111111111111111111111111111');
    assert.equal(tokenReports[2].tokenMint, 'TokenB111111111111111111111111111111111111');
    assert.equal(tokenReports[2].lowVolume, 1);
  });

  it('builds 1m and 5m dry-run window reports from accepted candidates', () => {
    const reports = dryRun.createWindowReports([
      {
        candidates: [
          {
            tokenMint: 'TokenA111111111111111111111111111111111111',
            program: 'pumpswap',
            signature: 'sig-a',
            estimatedSolVolume: 0.02,
            volumeSource: 'wsol',
            blockTime: 1_000,
          },
          {
            tokenMint: 'TokenA111111111111111111111111111111111111',
            program: 'raydium-cpmm',
            signature: 'sig-b',
            estimatedUsdVolume: 2,
            volumeSource: 'usdc',
            blockTime: 1_000,
          },
        ],
      },
    ], {
      nowMs: 1_000_000,
      windowReportLimit: 10,
    });

    const tokenA1m = reports.find((report) => report.window === '1m');
    const tokenA5m = reports.find((report) => report.window === '5m');

    assert.equal(tokenA1m.swaps, 2);
    assert.equal(tokenA1m.estimatedSolVolume, 0.02);
    assert.equal(tokenA1m.estimatedUsdVolume, 2);
    assert.deepEqual(tokenA1m.programs, ['pumpswap', 'raydium-cpmm']);
    assert.equal(tokenA5m.swaps, 2);
  });

  it('builds 1h price changes instead of volume-based surge candidates', () => {
    const report = dryRun.createPriceChangeReport({
      observations: [
        {
          accepted: true,
          tokenMint: 'TokenA111111111111111111111111111111111111',
          signature: 'baseline',
          program: 'pumpswap',
          quoteMint: 'USD',
          quoteUnit: 'USD',
          price: 1,
          observedAtMs: 1_000_000,
        },
        {
          accepted: true,
          tokenMint: 'TokenA111111111111111111111111111111111111',
          signature: 'current',
          program: 'raydium-clmm',
          quoteMint: 'USD',
          quoteUnit: 'USD',
          price: 1.5,
          observedAtMs: 4_600_000,
        },
      ],
    });

    assert.equal(report.changes.length, 1);
    assert.equal(report.changes[0].currentPriceChange1h, 50);
    assert.deepEqual(report.pendingByReason, { missing_1h_baseline: 1 });
    assert.deepEqual(report.rejectedByReason, {});
  });
});
