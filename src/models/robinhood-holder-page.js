const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  deriveWalletPositionMetrics,
} = require('../services/robinhood-wallet-position-domain');
const {
  HOLDER_CLASSIFICATION_VERSION,
} = require('../services/robinhood-holder-classification-domain');
const {
  SNIPER_HIGH_CONFIDENCE_RULE,
} = require('../services/robinhood-holder-sniper-policy');

const PAGE_SIZE = 50;
const CURSOR_PREFIX = 'ledger_v1.';
const MAX_CURSOR_LENGTH = 512;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const HOLDER_FILTERS = Object.freeze(['top', 'snipers', 'bundled']);
const BUNDLE_RULE_VERSION = 'rh_possible_bundle_v1';

function invalidCursor() {
  const error = new Error('Holder ledger cursor is invalid');
  error.code = 'invalid_cursor';
  return error;
}

function normalizeFilter(value) {
  const normalized = String(value ?? 'top').trim().toLowerCase();
  if (!HOLDER_FILTERS.includes(normalized)) throw invalidCursor();
  return normalized;
}

function normalizeCursorPayload(payload, expectedFilter) {
  const balanceRaw = String(payload?.balanceRaw ?? '');
  const rank = Number(payload?.rank);
  const filter = normalizeFilter(payload?.filter);
  const walletAddress = normalizeTokenAddress('robinhood', payload?.walletAddress);
  const validBalance = /^\d{1,78}$/.test(balanceRaw) && balanceRaw !== '0';
  const validRank = Number.isSafeInteger(rank) && rank >= 1 && rank <= 10_000_000;
  if (!validBalance || !validRank || filter !== normalizeFilter(expectedFilter)) {
    throw invalidCursor();
  }
  return Object.freeze({ balanceRaw, walletAddress, rank, filter });
}

function decodeCursor(value, expectedFilter = 'top') {
  if (value == null) return null;
  const raw = String(value);
  if (!raw.startsWith(CURSOR_PREFIX) || raw.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  try {
    const payload = JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url'));
    return normalizeCursorPayload(payload, expectedFilter);
  } catch (error) {
    if (error?.code === 'invalid_cursor') throw error;
    throw invalidCursor();
  }
}

function encodeCursor(value) {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function isLedgerCursor(value) {
  return typeof value === 'string' && value.startsWith(CURSOR_PREFIX);
}

function validateLedgerCursor(value, filter = 'top') {
  decodeCursor(value, filter);
  return String(value);
}

function financialMetrics(row, totalSupplyRaw, currentFdvUsd) {
  const position = row.projection_version == null ? {
    quantityRaw: String(row.balance_raw),
    zeroCostReceivedRaw: String(row.balance_raw),
    costBasisSource: 'transferred_assumed_zero',
    quality: 'transferred_assumed_zero',
  } : {
    quantityRaw: String(row.quantity_raw),
    costBasisUsd: String(row.cost_basis_usd),
    realizedPnlUsd: String(row.realized_pnl_usd),
    buyVolumeUsd: String(row.buy_volume_usd),
    sellProceedsUsd: String(row.sell_proceeds_usd),
    buyMcapWeightedSum: String(row.buy_mcap_weighted_sum),
    buyMcapWeightUsd: String(row.buy_mcap_weight_usd),
    sellMcapWeightedSum: String(row.sell_mcap_weighted_sum),
    sellMcapWeightUsd: String(row.sell_mcap_weight_usd),
    buyTxCount: Number(row.buy_tx_count),
    sellTxCount: Number(row.sell_tx_count),
    zeroCostReceivedRaw: String(row.zero_cost_received_raw),
    zeroCostSoldRaw: String(row.zero_cost_sold_raw),
    costBasisSource: row.cost_basis_source,
    quality: row.quality,
  };
  const metrics = deriveWalletPositionMetrics(position, {
    holderBalanceRaw: String(row.balance_raw), totalSupplyRaw, currentFdvUsd,
  });
  return Object.freeze({
    buyVolumeUsd: metrics.buyVolumeUsd,
    sellProceedsUsd: metrics.sellProceedsUsd,
    avgBuyMcapUsd: metrics.avgBuyMcapUsd,
    avgSellMcapUsd: metrics.avgSellMcapUsd,
    buyTxCount: metrics.buyTxCount,
    sellTxCount: metrics.sellTxCount,
    realizedPnlUsd: metrics.realizedPnlUsd,
    unrealizedPnlUsd: metrics.unrealizedPnlUsd,
    unrealizedPnlPct: metrics.unrealizedPnlPct,
    currentValueUsd: metrics.currentValueUsd,
    positionQuality: metrics.quality,
    costBasisSource: metrics.costBasisSource,
  });
}

function mapPage(tokenAddress, cursor, rows, filter = 'top') {
  if (!rows.length) return null;
  const holderCount = Number(rows[0].holder_count);
  if (!Number.isSafeInteger(holderCount) || holderCount < 0) {
    throw new Error('Published holder count is invalid');
  }
  const pageRows = rows.filter((row) => row.wallet_address != null);
  const hasMore = pageRows.length > PAGE_SIZE;
  const selected = pageRows.slice(0, PAGE_SIZE);
  const startRank = cursor?.rank || 0;
  const totalSupplyRaw = rows[0].token_total_supply_raw != null
    ? String(rows[0].token_total_supply_raw) : null;
  const currentFdvUsd = rows[0].current_fdv_usd != null
    ? String(rows[0].current_fdv_usd) : null;
  const items = selected.map((row, index) => Object.freeze({
    rank: startRank + index + 1,
    address: row.wallet_address,
    balanceRaw: String(row.balance_raw),
    addressType: row.address_type,
    label: null,
    isVerifiedContract: false,
    ...financialMetrics(row, totalSupplyRaw, currentFdvUsd),
  }));
  const last = items.at(-1);
  return Object.freeze({
    address: tokenAddress,
    holderCount,
    totalSupplyRaw,
    items: Object.freeze(items),
    hasMore,
    nextCursor: hasMore ? encodeCursor({
      balanceRaw: last.balanceRaw, walletAddress: last.address, rank: last.rank, filter,
    }) : null,
    source: 'ledger_live',
    observedAt: rows[0].observed_at?.toISOString?.() || rows[0].observed_at,
    checkedAt: rows[0].checked_at?.toISOString?.() || rows[0].checked_at,
  });
}

function createRobinhoodHolderPageRepository(options = {}) {
  const database = options.database || db;

  async function listPublishedPage(input = {}) {
    const tokenAddress = normalizeTokenAddress('robinhood', input.tokenAddress);
    const filter = normalizeFilter(input.filter);
    const cursor = decodeCursor(input.cursor, filter);
    const result = await database.query(
      `WITH sniper_wallets AS MATERIALIZED (
         SELECT classification.wallet_address
           FROM robinhood_holder_classifications classification
           INNER JOIN robinhood_holder_balances balance
             ON balance.chain = classification.chain
            AND balance.token_address = classification.token_address
            AND balance.wallet_address = classification.wallet_address
          WHERE $4::varchar = 'snipers' AND classification.chain = 'robinhood'
            AND classification.token_address = $1
            AND classification.classification_version = $5
            AND classification.tag = 'sniper' AND classification.confidence = 'high'
            AND classification.evidence_json #>> '{rule,evidenceVersion}' = $6
            AND (classification.expires_at IS NULL OR classification.expires_at > NOW())
       ), bundled_wallets AS MATERIALIZED (
         SELECT member.wallet_address
           FROM robinhood_possible_bundle_members member
           INNER JOIN robinhood_possible_bundle_states state
             ON state.chain = member.chain AND state.token_address = member.token_address
            AND state.rule_version = member.rule_version
           INNER JOIN robinhood_holder_balances balance
             ON balance.chain = member.chain AND balance.token_address = member.token_address
            AND balance.wallet_address = member.wallet_address
          WHERE $4::varchar = 'bundled' AND member.chain = 'robinhood'
            AND member.token_address = $1 AND member.rule_version = $7
            AND state.status = 'ready'
       ), published_state AS MATERIALIZED (
         SELECT CASE $4::varchar
                  WHEN 'snipers' THEN (SELECT COUNT(*) FROM sniper_wallets)
                  WHEN 'bundled' THEN (SELECT COUNT(*) FROM bundled_wallets)
                  ELSE state.holder_count END AS holder_count,
                state.updated_at AS observed_at,
                cursor.updated_at AS checked_at
           FROM robinhood_holder_token_states state
           INNER JOIN robinhood_holder_cursors cursor
             ON cursor.chain = state.chain AND cursor.stream = 'live'
          WHERE state.chain = 'robinhood' AND state.token_address = $1
            AND state.ledger_status = 'live'
       ), token_valuation AS MATERIALIZED (
         SELECT observation.token_total_supply_raw, observation.fdv_usd
           FROM robinhood_market_observations observation
          WHERE observation.chain = 'robinhood' AND observation.token_address = $1
            AND observation.status = 'accepted'
            AND observation.token_total_supply_raw IS NOT NULL
          ORDER BY observation.observed_at DESC
          LIMIT 1
       ), page AS MATERIALIZED (
         SELECT balance.wallet_address, balance.balance_raw,
                CASE
                  WHEN balance.wallet_address = '${DEAD_ADDRESS}' THEN 'burn'
                  WHEN EXISTS (
                    SELECT 1 FROM robinhood_pool_registry registry
                     WHERE registry.chain = 'robinhood'
                       AND registry.pool_address = balance.wallet_address
                  ) THEN 'pool'
                  ELSE 'unknown'
                END AS address_type
           FROM robinhood_holder_balances balance
          WHERE balance.chain = 'robinhood' AND balance.token_address = $1
            AND EXISTS (SELECT 1 FROM published_state)
            AND ($4::varchar = 'top'
              OR ($4::varchar = 'snipers' AND EXISTS (
                SELECT 1 FROM sniper_wallets sniper
                 WHERE sniper.wallet_address = balance.wallet_address
              )) OR ($4::varchar = 'bundled' AND EXISTS (
                SELECT 1 FROM bundled_wallets bundled
                 WHERE bundled.wallet_address = balance.wallet_address
              )))
            AND ($2::numeric IS NULL OR balance.balance_raw < $2::numeric
              OR (balance.balance_raw = $2::numeric AND balance.wallet_address > $3))
          ORDER BY balance.balance_raw DESC, balance.wallet_address ASC
          LIMIT ${PAGE_SIZE + 1}
       )
       SELECT state.holder_count, state.observed_at, state.checked_at,
              valuation.token_total_supply_raw, valuation.fdv_usd AS current_fdv_usd,
              page.wallet_address, page.balance_raw, page.address_type,
              position.projection_version, position.quantity_raw,
              position.cost_basis_usd, position.realized_pnl_usd,
              position.buy_volume_usd, position.sell_proceeds_usd,
              position.buy_mcap_weighted_sum, position.buy_mcap_weight_usd,
              position.sell_mcap_weighted_sum, position.sell_mcap_weight_usd,
              position.buy_tx_count, position.sell_tx_count,
              position.zero_cost_received_raw, position.zero_cost_sold_raw,
              position.cost_basis_source, position.quality
         FROM published_state state
         LEFT JOIN token_valuation valuation ON TRUE
         LEFT JOIN page ON TRUE
         LEFT JOIN robinhood_wallet_token_positions position
           ON position.chain = 'robinhood'
          AND position.projection_version = 'unified_transfer_v1'
          AND position.token_address = $1
          AND position.wallet_address = page.wallet_address
        ORDER BY page.balance_raw DESC NULLS LAST, page.wallet_address ASC`,
      [
        tokenAddress, cursor?.balanceRaw || null, cursor?.walletAddress || null, filter,
        HOLDER_CLASSIFICATION_VERSION, SNIPER_HIGH_CONFIDENCE_RULE.evidenceVersion,
        BUNDLE_RULE_VERSION,
      ]
    );
    return mapPage(tokenAddress, cursor, result.rows, filter);
  }

  return Object.freeze({ listPublishedPage });
}

module.exports = {
  createRobinhoodHolderPageRepository,
  isLedgerCursor,
  validateLedgerCursor,
  __private: {
    decodeCursor, encodeCursor, mapPage, normalizeCursorPayload, normalizeFilter, PAGE_SIZE,
  },
};
