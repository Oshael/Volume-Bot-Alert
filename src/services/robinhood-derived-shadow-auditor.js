/**
 * Corte 6B: audit-only sink for built derived-outbox payloads.
 * It compares the payload with the current canonical 1m token bucket and never
 * publishes to sockets, alerts, catalog or aggregates.
 */
const db = require('../models/db');

const LOAD_BUCKET_SQL = `SELECT
  (array_agg(open_price_usd ORDER BY first_block_number, first_log_index,
    protocol, market_key))[1] AS open_price_usd,
  MAX(high_price_usd) AS high_price_usd,
  MIN(low_price_usd) AS low_price_usd,
  (array_agg(close_price_usd ORDER BY last_block_number DESC, last_log_index DESC,
    protocol, market_key))[1] AS close_price_usd,
  (array_agg(open_fdv_usd ORDER BY first_block_number, first_log_index,
    protocol, market_key))[1] AS open_fdv_usd,
  MAX(high_fdv_usd) AS high_fdv_usd,
  MIN(low_fdv_usd) AS low_fdv_usd,
  (array_agg(close_fdv_usd ORDER BY last_block_number DESC, last_log_index DESC,
    protocol, market_key))[1] AS close_fdv_usd,
  SUM(volume_usd) AS volume_usd,
  SUM(swaps)::bigint AS swaps,
  SUM(buys)::bigint AS buys,
  SUM(sells)::bigint AS sells,
  SUM(transactions)::bigint AS transactions,
  MAX(last_observed_at) AS last_observed_at,
  MAX(last_block_number) AS last_block_number,
  (array_agg(last_log_index ORDER BY last_block_number DESC, last_log_index DESC,
    protocol, market_key))[1] AS last_log_index
FROM robinhood_market_buckets_1m
WHERE chain = 'robinhood' AND token_address = $1 AND bucket_ts = $2::timestamptz
GROUP BY chain, token_address, bucket_ts`;

const FIELD_PAIRS = Object.freeze([
  ['activity.volumeUsd', 'volume_usd'], ['activity.swaps', 'swaps'],
  ['activity.buys', 'buys'], ['activity.sells', 'sells'],
  ['activity.transactions', 'transactions'],
  ['valuation.priceUsd', 'close_price_usd', 'number'],
  ['valuation.fdvUsd', 'close_fdv_usd', 'number'],
  ['valuation.observedAt', 'last_observed_at', 'timestamp'],
  ['candle.openPrice', 'open_price_usd', 'number'],
  ['candle.highPrice', 'high_price_usd', 'number'],
  ['candle.lowPrice', 'low_price_usd', 'number'],
  ['candle.closePrice', 'close_price_usd', 'number'],
  ['candle.openFdvUsd', 'open_fdv_usd', 'number'],
  ['candle.highFdvUsd', 'high_fdv_usd', 'number'],
  ['candle.lowFdvUsd', 'low_fdv_usd', 'number'],
  ['candle.closeFdvUsd', 'close_fdv_usd', 'number'],
  ['candle.sampleCount', 'swaps'],
]);

function nested(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function comparable(value, mode) {
  if (value == null) return null;
  if (mode === 'timestamp') return new Date(value).toISOString();
  if (mode === 'number') return Number(value);
  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  const negative = text.startsWith('-');
  const [integerPart, fractionPart = ''] = text.replace(/^-/, '').split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

function compareOrdering(payload, canonical) {
  const expected = [BigInt(payload.ordering.lastBlockNumber), BigInt(payload.ordering.lastLogIndex)];
  const actual = [BigInt(canonical.last_block_number), BigInt(canonical.last_log_index)];
  if (actual[0] !== expected[0]) return actual[0] > expected[0] ? 1 : -1;
  if (actual[1] !== expected[1]) return actual[1] > expected[1] ? 1 : -1;
  return 0;
}

function mismatchedFields(payload, canonical) {
  return FIELD_PAIRS.flatMap(([payloadPath, column, mode]) => (
    comparable(nested(payload, payloadPath), mode) === comparable(canonical[column], mode)
      ? [] : [payloadPath]
  ));
}

function createRobinhoodDerivedShadowAuditor(options = {}) {
  const database = options.database || db;
  const logger = options.logger || console;
  const sampleLimit = Math.max(1, Math.min(Math.trunc(Number(options.sampleLimit) || 5), 20));
  const statementTimeoutMs = Math.max(100, Math.min(
    Math.trunc(Number(options.statementTimeoutMs) || 1000), 10_000
  ));
  if (typeof database?.query !== 'function') throw new Error('derived shadow audit database is required');
  const status = {
    attempted: 0, matched: 0, mismatched: 0, missing: 0, superseded: 0,
    errors: 0, samples: [], lastResult: null, lastError: null,
  };

  function record(result) {
    status[result.outcome] += 1;
    status.lastResult = result;
    status.lastError = null;
    if (result.outcome === 'mismatched' || result.outcome === 'missing') {
      if (status.samples.length < sampleLimit) status.samples.push(result);
      logger.warn?.('[robinhood-derived] shadow bucket divergence', result);
    }
    return result;
  }

  async function consume(payload) {
    status.attempted += 1;
    try {
      if (payload?.type !== 'market:bucket' || payload.chain !== 'robinhood'
        || !payload.address || !payload.bucketTs || !payload.ordering) {
        throw new Error('invalid derived shadow payload');
      }
      const params = [String(payload.address).toLowerCase(), payload.bucketTs];
      const result = typeof database.queryWithStatementTimeout === 'function'
        ? await database.queryWithStatementTimeout(LOAD_BUCKET_SQL, params, statementTimeoutMs)
        : await database.query(LOAD_BUCKET_SQL, params);
      const canonical = result.rows[0];
      if (!canonical) return record({ outcome: 'missing', address: params[0], bucketTs: params[1] });
      const ordering = compareOrdering(payload, canonical);
      if (ordering > 0) return record({ outcome: 'superseded', address: params[0], bucketTs: params[1] });
      const fields = ordering < 0
        ? ['ordering.canonicalBehind'] : mismatchedFields(payload, canonical);
      return record({
        outcome: fields.length ? 'mismatched' : 'matched',
        address: params[0], bucketTs: params[1], fields,
      });
    } catch (error) {
      status.errors += 1;
      status.lastError = String(error?.message || error).slice(0, 500);
      throw error;
    }
  }

  return Object.freeze({ consume, getStatus: () => ({ ...status, samples: [...status.samples] }) });
}

module.exports = {
  createRobinhoodDerivedShadowAuditor,
  __private: { FIELD_PAIRS, LOAD_BUCKET_SQL, comparable, compareOrdering, mismatchedFields },
};
