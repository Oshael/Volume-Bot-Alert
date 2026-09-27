const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_PAIRS = 20;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

const CLASSIFICATION_SQL = `SELECT requested.token_address, requested.wallet_address,
    EXISTS (
      SELECT 1 FROM robinhood_token_transfer_events transfer
      WHERE transfer.chain = '${CHAIN}'
        AND transfer.token_address = requested.token_address
        AND (transfer.from_wallet = requested.wallet_address
          OR transfer.to_wallet = requested.wallet_address)
        AND transfer.block_time >= $2::timestamptz
        AND transfer.block_time <= $3::timestamptz
        AND transfer.amount_raw > 0
        AND transfer.transfer_kind IN ('unclassified', 'unknown')
    ) AS unresolved,
    EXISTS (
      SELECT 1 FROM robinhood_token_transfer_events transfer
      WHERE transfer.chain = '${CHAIN}'
        AND transfer.token_address = requested.token_address
        AND (transfer.from_wallet = requested.wallet_address
          OR transfer.to_wallet = requested.wallet_address)
        AND transfer.block_time >= $2::timestamptz
        AND transfer.block_time <= $3::timestamptz
        AND transfer.amount_raw > 0
        AND transfer.classification_version IS DISTINCT FROM $4
    ) AS version_mismatch
  FROM jsonb_to_recordset($1::jsonb)
    AS requested(token_address text, wallet_address text)
  ORDER BY requested.token_address, requested.wallet_address`;

function version(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('classificationVersion is invalid');
  }
  return normalized;
}

function normalizeInput(input) {
  if (!Array.isArray(input.pairs) || input.pairs.length > MAX_PAIRS) {
    throw new Error(`pairs must contain at most ${MAX_PAIRS} entries`);
  }
  const seen = new Set();
  const pairs = input.pairs.map((pair) => {
    const tokenAddress = normalizeTokenAddress(CHAIN, pair?.tokenAddress);
    const walletAddress = normalizeTokenAddress(CHAIN, pair?.walletAddress);
    const key = `${tokenAddress}:${walletAddress}`;
    if (seen.has(key)) throw new Error('duplicate wallet/token pair');
    seen.add(key);
    return { tokenAddress, walletAddress, key };
  });
  const start = new Date(input.windowStart);
  const end = new Date(input.asOf);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || end <= start || end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  return { pairs, start, end, classificationVersion: version(input.classificationVersion) };
}

function assessPair(pair, row) {
  const reasons = [];
  if (!row || row.unresolved !== false) reasons.push('transfer_classification_unresolved');
  if (!row || row.version_mismatch !== false) {
    reasons.push('transfer_classification_version_mismatch');
  }
  return {
    tokenAddress: pair.tokenAddress, walletAddress: pair.walletAddress,
    rawRowsClassified: reasons.length === 0, reasons,
    sourceCoverageVerified: false,
  };
}

function createRobinhoodWalletRankingTransferClassificationRepository(options = {}) {
  const database = options.database || db;
  return {
    async inspectWindow(input = {}) {
      const { pairs, start, end, classificationVersion } = normalizeInput(input);
      if (!pairs.length) return [];
      const payload = JSON.stringify(pairs.map(({ tokenAddress, walletAddress }) => ({
        token_address: tokenAddress, wallet_address: walletAddress,
      })));
      const result = await database.queryWithStatementTimeout(
        CLASSIFICATION_SQL, [payload, start, end, classificationVersion], TIMEOUT_MS,
      );
      const byPair = new Map(result.rows.map((row) => [
        `${row.token_address}:${row.wallet_address}`, row,
      ]));
      return pairs.map((pair) => ({
        ...assessPair(pair, byPair.get(pair.key)),
        windowStart: start.toISOString(), asOf: end.toISOString(), classificationVersion,
      }));
    },
  };
}

module.exports = { createRobinhoodWalletRankingTransferClassificationRepository };
