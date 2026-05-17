#!/usr/bin/env node

const db = require('../models/db');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const {
  evaluateBlockedToken,
  summarizeBacktestResults,
} = require('../services/admin-block-rule-backtest');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    limit: 200,
    format: 'table',
    includeManual: false,
    includeInitialBuckets: true,
    summaryOnly: false,
    statementTimeoutMs: 30000,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--csv') {
      options.format = 'csv';
    } else if (arg === '--include-manual') {
      options.includeManual = true;
    } else if (arg === '--skip-initial-buckets') {
      options.includeInitialBuckets = false;
    } else if (arg === '--summary-only') {
      options.summaryOnly = true;
    } else if (arg.startsWith('--limit=')) {
      options.limit = Math.max(1, Math.min(Number(arg.slice('--limit='.length)) || options.limit, 5000));
    } else if (arg.startsWith('--statement-timeout-ms=')) {
      options.statementTimeoutMs = Math.max(1000, Number(arg.slice('--statement-timeout-ms='.length)) || options.statementTimeoutMs);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node src/utils/backtest-admin-block-rules.js [options]

Read-only backtest for admin auto-blocked tokens.

Options:
  --limit=N                 Max blocked tokens to inspect. Default: 200
  --json                    Print full JSON
  --csv                     Print CSV summary rows
  --include-manual          Include rows with created_by set
  --skip-initial-buckets    Skip token_market_buckets_1m initial-bucket lookup
  --summary-only            Print only aggregate counts in table mode
  --statement-timeout-ms=N  Statement timeout for the main SELECT. Default: 30000
`);
}

async function listBlockedRows(options) {
  const { rows } = await db.queryWithStatementTimeout(
    `SELECT
       ab.address,
       ab.label AS blocked_label,
       ab.created_at AS banned_at,
       ab.created_by AS blocked_created_by,
       tc.source,
       tc.symbol,
       tc.name,
       tc.eligibility_state,
       tc.suppressed_reason,
       tc.last_pair_url,
       tc.last_mcap,
       tc.last_vol_5m,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_liquidity_usd,
       tc.last_txns_1h_buys,
       tc.last_txns_1h_sells,
       tc.last_txns_24h_buys,
       tc.last_txns_24h_sells,
       tc.last_price_change_1h,
       tc.last_price_change_6h,
       tc.last_price_change_24h,
       tc.last_token_created_at_ms,
       trr.label AS risk_review_label,
       trr.source AS risk_review_source,
       trr.notes AS risk_review_notes,
       trr.updated_at AS risk_review_updated_at,
       tre.holder_count AS risk_holder_count,
       tre.mint_authority_active AS risk_mint_authority_active,
       tre.freeze_authority_active AS risk_freeze_authority_active,
       tre.top_10_pct AS risk_top_10_pct,
       tre.top_20_pct AS risk_top_20_pct,
       tms.has_pool AS meteora_has_pool,
       tms.current_tvl AS meteora_current_tvl,
       tms.pool_count AS meteora_pool_count,
       tje.assessment AS evidence_assessment,
       tje.created_at AS evidence_created_at
     FROM admin_blocked_tokens ab
     LEFT JOIN token_catalog tc
       ON tc.address = ab.address
     LEFT JOIN token_risk_reviews trr
       ON trr.token_address = ab.address
     LEFT JOIN token_risk_enrichment tre
       ON tre.token_address = ab.address
     LEFT JOIN token_meteora_state tms
       ON tms.token_address = ab.address
     LEFT JOIN LATERAL (
       SELECT assessment, created_at
       FROM token_junk_evidence
       WHERE token_address = ab.address
       ORDER BY created_at DESC
       LIMIT 1
     ) tje ON TRUE
     WHERE ($2::boolean = TRUE OR ab.created_by IS NULL)
     ORDER BY ab.created_at DESC
     LIMIT $1`,
    [options.limit, options.includeManual],
    options.statementTimeoutMs
  );
  return rows;
}

async function getInitialBucket(address, enabled) {
  if (!enabled) {
    return null;
  }
  try {
    return await tokenMarketBucket1m.getInitialBucketByAddress(address);
  } catch (error) {
    return { error: error.message };
  }
}

function toCsvCell(value) {
  const raw = String(value ?? '');
  if (!/[",\n]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

function printCsv(results) {
  const headers = [
    'address',
    'symbol',
    'stored_label',
    'match_count',
    'original_still_matches',
    'evidence_supports_stored_rule',
    'matching_rules_now',
    'mcap',
    'liquidity_usd',
    'vol5m',
    'vol24h',
  ];
  console.log(headers.join(','));
  for (const result of results) {
    console.log([
      result.address,
      result.symbol,
      result.storedLabel,
      result.matchCount,
      result.originalStillMatches,
      result.evidenceSupportsStoredRule,
      result.matchingRules.map((rule) => rule.ruleId).join('|'),
      result.market.mcap,
      result.market.liquidityUsd,
      result.market.vol5m,
      result.market.vol24h,
    ].map(toCsvCell).join(','));
  }
}

function printTable(results) {
  const summary = summarizeBacktestResults(results);
  console.log('Admin auto-block rule backtest');
  console.log(summary);
  return summary;
}

function printTableRows(results) {
  console.table(results.map((result) => ({
    address: result.address,
    symbol: result.symbol,
    stored: result.storedRuleId,
    matches: result.matchCount,
    originalNow: result.originalStillMatches ? 'yes' : 'no',
    evidence: result.evidenceSupportsStoredRule ? 'yes' : 'no',
    matchingRulesNow: result.matchingRules.map((rule) => rule.ruleId).join(' | '),
    mcap: result.market.mcap,
    liq: result.market.liquidityUsd,
    vol5m: result.market.vol5m,
  })));
}

async function run() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const rows = await listBlockedRows(options);
  const results = [];
  for (const row of rows) {
    const initialBucket = await getInitialBucket(row.address, options.includeInitialBuckets);
    results.push(evaluateBlockedToken(row, {
      initialBucket: initialBucket?.error ? null : initialBucket,
    }));
  }

  if (options.format === 'json') {
    console.log(JSON.stringify({ summary: summarizeBacktestResults(results), results }, null, 2));
  } else if (options.format === 'csv') {
    printCsv(results);
  } else {
    printTable(results);
    if (!options.summaryOnly) {
      printTableRows(results);
    }
  }
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = {
  listBlockedRows,
  parseArgs,
};
