'use strict';

const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const EVIDENCE_VERSION = 'callout_robinhood_wallet_buy_v1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_RANGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

const PROFILE_WALLET_BUYS_SQL = `WITH wallet_candidates AS MATERIALIZED (
  SELECT DISTINCT ON (wallet.platform, wallet.platform_user_id, wallet.address_normalized)
    wallet.observation_key, wallet.platform, wallet.platform_user_id,
    wallet.address_normalized, wallet.chain_key, wallet.relation_type,
    wallet.source_type, wallet.source_field, wallet.source_record_id,
    wallet.confidence, wallet.evidence_at, wallet.last_observed_at
  FROM callout_wallet_observations wallet
  WHERE wallet.address_normalized IS NOT NULL
    AND (
      wallet.chain_key = '${CHAIN}'
      OR (
        wallet.chain_key IS NULL
        AND wallet.chain_family = 'evm'
        AND wallet.resolution_status = 'unknown_chain'
      )
    )
  ORDER BY wallet.platform, wallet.platform_user_id, wallet.address_normalized,
    CASE WHEN wallet.chain_key = '${CHAIN}' THEN 0 ELSE 1 END,
    wallet.last_observed_at DESC, wallet.observation_key
)
SELECT profile.platform, profile.platform_user_id, profile.username,
       profile.x_username, profile.display_name, profile.profile_picture_url,
       wallet.observation_key, wallet.address_normalized, wallet.chain_key,
       wallet.relation_type, wallet.source_type, wallet.source_field,
       wallet.source_record_id, wallet.confidence, wallet.evidence_at,
       swap.transaction_hash, swap.action_index, swap.block_number,
       swap.block_time, swap.protocol, swap.market_key, swap.volume_usd,
       swap.price_usd, swap.parser_version
FROM robinhood_wallet_swaps swap
INNER JOIN wallet_candidates wallet
  ON wallet.address_normalized = swap.wallet_address
INNER JOIN callout_profiles profile
  ON profile.platform = wallet.platform
 AND profile.platform_user_id = wallet.platform_user_id
WHERE swap.chain = '${CHAIN}'
  AND swap.token_address = $1
  AND swap.side = 'buy'
  AND swap.block_time >= $2::timestamptz
  AND swap.block_time < $3::timestamptz
ORDER BY swap.block_time DESC, swap.block_number DESC, swap.action_index DESC,
         profile.platform, profile.platform_user_id
LIMIT $4::int`;

function taggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw taggedError('INVALID_ENRICHMENT_RANGE', `${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw taggedError('INVALID_ENRICHMENT_LIMIT', `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function normalizeQuery(input = {}, now = Date.now) {
  const to = input.to == null ? new Date(now()) : instant(input.to, 'to');
  const from = input.from == null ? new Date(to.getTime() - MAX_RANGE_MS) : instant(input.from, 'from');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > MAX_RANGE_MS) {
    throw taggedError('INVALID_ENRICHMENT_RANGE', 'range must be greater than zero and at most 72 hours');
  }
  return Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
    from: from.toISOString(), to: to.toISOString(), limit: normalizeLimit(input.limit),
  });
}

function numericOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEvidence(row) {
  const exactChain = row.chain_key === CHAIN;
  return Object.freeze({
    evidenceId: `${EVIDENCE_VERSION}:${row.observation_key}:${row.transaction_hash}:${row.action_index}`,
    evidenceState: 'wallet_action',
    correlationStatus: 'not_evaluated',
    profile: Object.freeze({
      platform: row.platform, platformUserId: row.platform_user_id,
      username: row.username || null, xUsername: row.x_username || null,
      displayName: row.display_name || null, profilePictureUrl: row.profile_picture_url || null,
    }),
    walletBinding: Object.freeze({
      observationKey: row.observation_key, address: row.address_normalized,
      networkScope: exactChain ? 'exact_chain' : 'evm_address_candidate',
      relationType: row.relation_type, sourceType: row.source_type,
      sourceField: row.source_field || null, sourceRecordId: row.source_record_id || null,
      confidence: row.confidence || null,
      evidenceAt: row.evidence_at ? new Date(row.evidence_at).toISOString() : null,
    }),
    action: Object.freeze({
      actionId: `${CHAIN}:wallet_buy:${row.transaction_hash}:${row.action_index}`,
      chainKey: CHAIN, side: 'buy', transactionHash: row.transaction_hash,
      actionIndex: String(row.action_index), blockNumber: String(row.block_number),
      blockTime: new Date(row.block_time).toISOString(), protocol: row.protocol,
      marketKey: row.market_key, amountUsd: numericOrNull(row.volume_usd),
      priceUsd: numericOrNull(row.price_usd), parserVersion: row.parser_version,
    }),
    provenance: Object.freeze({
      evidenceVersion: EVIDENCE_VERSION,
      actionSource: 'robinhood_wallet_swaps',
      bindingSource: 'callout_wallet_observations',
    }),
  });
}

function createCalloutRobinhoodEnrichmentRead(options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;
  const statementTimeoutMs = options.statementTimeoutMs || DEFAULT_STATEMENT_TIMEOUT_MS;

  async function listProfileWalletBuys(input = {}) {
    const query = normalizeQuery(input, now);
    const params = [query.tokenAddress, query.from, query.to, query.limit + 1];
    const result = database.queryWithStatementTimeout
      ? await database.queryWithStatementTimeout(PROFILE_WALLET_BUYS_SQL, params, statementTimeoutMs)
      : await database.query(PROFILE_WALLET_BUYS_SQL, params);
    const rows = result.rows.map(normalizeEvidence);
    const hasMore = rows.length > query.limit;
    return Object.freeze({
      status: 'ready', chainKey: CHAIN, tokenAddress: query.tokenAddress,
      evidenceVersion: EVIDENCE_VERSION, from: query.from, to: query.to,
      actions: Object.freeze(hasMore ? rows.slice(0, query.limit) : rows), hasMore,
    });
  }

  return Object.freeze({ listProfileWalletBuys });
}

module.exports = {
  createCalloutRobinhoodEnrichmentRead,
  __private: {
    CHAIN, DEFAULT_LIMIT, DEFAULT_STATEMENT_TIMEOUT_MS, EVIDENCE_VERSION, MAX_LIMIT, MAX_RANGE_MS,
    PROFILE_WALLET_BUYS_SQL, normalizeEvidence, normalizeLimit, normalizeQuery,
  },
};
