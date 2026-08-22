const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  main, parseArgs, runCalibration, summarizeEvidence,
} = require('../src/utils/calibrate-robinhood-holder-snipers');

const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;

function ready(firstBuys, exclusions = []) {
  return { ready: true, firstBuys, exclusions };
}

function buy(walletAddress, volumeUsd, withinLaunchWindow = true) {
  return { walletAddress, volumeUsd, withinLaunchWindow };
}

describe('Robinhood SNIPER calibration command', () => {
  it('parses bounded deterministic read-only sampling options', () => {
    assert.deepEqual(parseArgs([]), {
      limit: 25, concurrency: 1, seed: 'default', thresholds: [],
    });
    assert.deepEqual(parseArgs([
      '--limit=100', '--concurrency=5', '--seed=aug21', '--thresholds=010.0,25,10',
    ]), {
      limit: 100, concurrency: 5, seed: 'aug21', thresholds: ['10', '25'],
    });
    assert.throws(() => parseArgs(['--limit=101']), /between 1 and 100/);
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    assert.throws(() => parseArgs(['--seed=UPPER']), /lowercase identifier/);
  });

  it('reports quantiles only for priced, non-excluded buys inside the window', () => {
    const report = summarizeEvidence([
      ready([
        buy(WALLET_A, '10'), buy(WALLET_B, '20'),
        buy(`0x${'3'.repeat(40)}`, '100', false),
      ], [{ walletAddress: WALLET_B, reason: 'infrastructure_cex' }]),
      ready([buy(`0x${'4'.repeat(40)}`, '40'), buy(`0x${'5'.repeat(40)}`, null)]),
      { ready: false, reason: 'swap_seed_not_complete' },
    ], ['10', '25']);

    assert.deepEqual(report.tokens, {
      selected: 3, ready: 2, unavailable: 1,
      unavailableReasons: { swap_seed_not_complete: 1 },
    });
    assert.deepEqual(report.buys, {
      first: 5, withinWindow: 4, excluded: 1, missingVolumeUsd: 1,
      pricedCandidates: 2,
    });
    assert.deepEqual(report.notionalUsd, {
      sampleSize: 2, quantileMethod: 'nearest_rank',
      min: '10', p25: '10', p50: '10', p75: '40',
      p90: '40', p95: '40', max: '40', countsAtThreshold: { 10: 2, 25: 1 },
    });
  });

  it('selects a seeded bounded cohort and never opens a write transaction', async () => {
    const calls = [];
    const runtime = {
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{ token_address: 'token-a' }, { token_address: 'token-b' }] };
        },
        getClient: async () => { throw new Error('calibration must not write'); },
      },
      source: { loadLaunchEvidence: async (token) => (
        token === 'token-a' ? ready([buy(WALLET_A, '12')])
          : { ready: false, reason: 'holder_frontier_unavailable' }
      ) },
    };
    const options = parseArgs(['--limit=2', '--seed=test', '--thresholds=10']);
    const report = await runCalibration(runtime, options);

    assert.equal(report.mode, 'read-only');
    assert.deepEqual(calls[0].params, ['test', 2]);
    assert.match(calls[0].sql, /ORDER BY MD5\(token_address \|\| \$1\)/);
    assert.equal(report.notionalUsd.countsAtThreshold['10'], 1);
    const logs = [];
    assert.equal((await main([], {
      runtime, runCalibration: async () => report, logger: { log: (line) => logs.push(line) },
    })).mode, 'read-only');
    assert.equal(logs.length, 1);
  });
});
