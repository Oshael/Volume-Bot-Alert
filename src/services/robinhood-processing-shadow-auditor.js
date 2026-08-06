/**
 * Corte 6A: compares processing-decoded observations with the canonical rows
 * already committed by the monolith. Read-only and fail-open by contract.
 */
const db = require('../models/db');
const { __private: persistence } = require('../models/robinhood-persistence');

const FIELD_PAIRS = Object.freeze([
  ['blockNumber', 'block_number', 'decimal'], ['protocol', 'protocol'], ['marketKey', 'market_key'],
  ['tokenAddress', 'token_address'], ['quoteAddress', 'quote_address'], ['side', 'side'],
  ['status', 'status'], ['rejectionReason', 'rejection_reason'], ['observedAt', 'observed_at'],
  ['tokenDecimals', 'token_decimals', 'decimal'], ['quoteDecimals', 'quote_decimals', 'decimal'],
  ['tokenTotalSupplyRaw', 'token_total_supply_raw', 'decimal'],
  ['tokenSupplyStatus', 'token_supply_status'],
  ['tokenSupplyAnchorBlockNumber', 'token_supply_anchor_block_number', 'decimal'],
  ['tokenAmountRaw', 'token_amount_raw', 'decimal'],
  ['quoteAmountRaw', 'quote_amount_raw', 'decimal'],
  ['tokenAmount', 'token_amount', 'decimal'], ['quoteAmount', 'quote_amount', 'decimal'],
  ['priceQuote', 'price_quote', 'decimal'], ['quoteUsdPrice', 'quote_usd_price', 'decimal'],
  ['priceUsd', 'price_usd', 'decimal'], ['volumeUsd', 'volume_usd', 'decimal'],
  ['fdvUsd', 'fdv_usd', 'decimal'], ['marketCapUsd', 'market_cap_usd', 'decimal'],
  ['valuationType', 'valuation_type'],
  ['quoteUsdSource', 'quote_usd_source'], ['quoteUsdStatus', 'quote_usd_status'],
  ['liquidityUsd', 'liquidity_usd', 'decimal'],
  ['liquidityRaw', 'liquidity_raw', 'decimal'],
  ['liquidityStatus', 'liquidity_status'],
  ['liquidityConfidence', 'liquidity_confidence'],
  ['liquidityWarning', 'liquidity_warning'],
]);

const LOAD_CANONICAL_SQL = `WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS identity(
    "transactionHash" text, "logIndex" bigint
  )
)
SELECT observation.*
FROM input
INNER JOIN robinhood_market_observations observation
  ON observation.chain = 'robinhood'
 AND observation.transaction_hash = input."transactionHash"
 AND observation.log_index = input."logIndex"`;

function identityKey(transactionHash, logIndex) {
  return `${String(transactionHash).toLowerCase()}:${String(logIndex)}`;
}

function comparable(value, mode) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  if (mode !== 'decimal' || !/^-?\d+(\.\d+)?$/.test(text)) return text;
  const negative = text.startsWith('-');
  const [integerPart, fractionPart = ''] = text.replace(/^-/, '').split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

function normalizeEntry(entry) {
  const log = persistence.normalizeLogEntry(entry, 'market');
  return persistence.normalizeObservation(entry, log);
}

function compareFields(expected, actual) {
  return FIELD_PAIRS.flatMap(([expectedKey, actualKey, mode]) => (
    comparable(expected[expectedKey], mode) === comparable(actual[actualKey], mode) ? [] : [expectedKey]
  ));
}

function boundedSampleLimit(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 20)) : 5;
}

function createRobinhoodProcessingShadowAuditor(options = {}) {
  const database = options.database || db;
  const normalize = options.normalize || normalizeEntry;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const sampleLimit = boundedSampleLimit(options.sampleLimit);
  const statementTimeoutMs = Math.max(100, Math.min(
    Math.trunc(Number(options.statementTimeoutMs) || 1000), 10_000
  ));
  if (typeof database?.query !== 'function') throw new Error('shadow audit database is required');

  async function compare(entries = []) {
    const startedAt = now();
    const expectedRows = entries.map(normalize).filter(Boolean);
    if (!expectedRows.length) {
      return {
        attempted: 0, compared: 0, matched: 0, mismatched: 0,
        missing: 0, errors: 0, durationMs: 0, samples: [],
      };
    }
    const identities = expectedRows.map((row) => ({
      transactionHash: row.transactionHash, logIndex: row.logIndex,
    }));
    const params = [JSON.stringify(identities)];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(LOAD_CANONICAL_SQL, params, statementTimeoutMs)
      : await database.query(LOAD_CANONICAL_SQL, params);
    const canonical = new Map(result.rows.map((row) => (
      [identityKey(row.transaction_hash, row.log_index), row]
    )));
    const summary = {
      attempted: expectedRows.length, compared: 0, matched: 0,
      mismatched: 0, missing: 0, errors: 0, durationMs: 0, samples: [],
    };
    for (const expected of expectedRows) {
      const key = identityKey(expected.transactionHash, expected.logIndex);
      const actual = canonical.get(key);
      if (!actual) {
        summary.missing += 1;
        if (summary.samples.length < sampleLimit) {
          summary.samples.push({ transactionHash: expected.transactionHash, logIndex: expected.logIndex, fields: ['canonicalObservation'] });
        }
        continue;
      }
      summary.compared += 1;
      const fields = compareFields(expected, actual);
      if (!fields.length) summary.matched += 1;
      else {
        summary.mismatched += 1;
        if (summary.samples.length < sampleLimit) {
          summary.samples.push({ transactionHash: expected.transactionHash, logIndex: expected.logIndex, fields });
        }
      }
    }
    summary.durationMs = Math.max(0, now() - startedAt);
    if (summary.mismatched || summary.missing) {
      logger.warn?.('[robinhood-processing] shadow audit divergence', summary);
    }
    return summary;
  }

  return Object.freeze({ compare });
}

module.exports = {
  createRobinhoodProcessingShadowAuditor,
  __private: { FIELD_PAIRS, LOAD_CANONICAL_SQL, boundedSampleLimit, compareFields, identityKey },
};
