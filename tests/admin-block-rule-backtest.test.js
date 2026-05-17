const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backtest = require('../src/services/admin-block-rule-backtest');
const cli = require('../src/utils/backtest-admin-block-rules');

describe('admin block rule backtest', () => {
  it('normalizes dynamic labels into stable rule ids', () => {
    const { canonicalRuleIdFromLabel } = backtest.__private;
    assert.equal(
      canonicalRuleIdFromLabel('gmgn-origin:new-non-pump-high-launch-mcap:60000:250000'),
      'gmgn-origin:new-non-pump-high-launch-mcap'
    );
    assert.equal(
      canonicalRuleIdFromLabel('gmgn-security:top10-holder-rate-72%'),
      'gmgn-security:top10-holder-rate'
    );
    assert.equal(
      canonicalRuleIdFromLabel('auto-junk-probable:gmgn_confirmed_micro_liquidity'),
      'auto-junk-probable:gmgn_confirmed_micro_liquidity'
    );
  });

  it('detects overlapping current matches for a blocked token', () => {
    const result = backtest.evaluateBlockedToken({
      address: '726MVtUgSjsHZvyaaYQw4jg59UBBfJE9MZqj2qw8Rvbu',
      blocked_label: 'auto-junk-probable:gmgn_confirmed_micro_liquidity',
      banned_at: '2026-05-17T08:00:00.000Z',
      source: 'gmgn',
      symbol: 'MICRO',
      last_mcap: 80000,
      last_liquidity_usd: 75,
      last_vol_5m: 600000,
      last_vol_1h: 150000,
      last_vol_6h: 150000,
      last_vol_24h: 2000000,
      last_txns_24h_buys: 700,
      last_txns_24h_sells: 700,
      last_price_change_24h: 250,
      last_token_created_at_ms: Date.parse('2026-05-17T07:30:00.000Z'),
      meteora_has_pool: false,
      meteora_current_tvl: null,
      meteora_pool_count: 0,
    });

    assert.equal(result.originalStillMatches, true);
    assert.ok(result.matchCount >= 2);
    assert.ok(result.matchingRules.some((rule) => rule.ruleId === 'auto-junk-probable:gmgn_confirmed_micro_liquidity'));
    assert.ok(result.matchingRules.some((rule) => rule.ruleId === 'gmgn-volume:low-mcap-extreme-vol5m'));
  });

  it('summarizes zero, single, and multiple rule matches', () => {
    assert.deepEqual(backtest.summarizeBacktestResults([
      { matchCount: 0, originalStillMatches: false, evidenceSupportsStoredRule: false },
      { matchCount: 1, originalStillMatches: true, evidenceSupportsStoredRule: false },
      { matchCount: 2, originalStillMatches: true, evidenceSupportsStoredRule: true },
    ]), {
      total: 3,
      zeroMatches: 1,
      singleMatch: 1,
      multipleMatches: 1,
      originalStillMatches: 2,
      evidenceSupportsStoredRule: 1,
    });
  });

  it('parses summary-only CLI mode', () => {
    assert.deepEqual(cli.parseArgs(['--limit=25', '--summary-only', '--skip-initial-buckets']), {
      limit: 25,
      format: 'table',
      includeManual: false,
      includeInitialBuckets: false,
      summaryOnly: true,
      statementTimeoutMs: 30000,
    });
  });
});
