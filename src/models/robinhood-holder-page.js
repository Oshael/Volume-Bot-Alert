const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const PAGE_SIZE = 50;
const CURSOR_PREFIX = 'ledger_v1.';
const MAX_CURSOR_LENGTH = 512;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

function invalidCursor() {
  const error = new Error('Holder ledger cursor is invalid');
  error.code = 'invalid_cursor';
  return error;
}

function decodeCursor(value) {
  if (value == null) return null;
  const raw = String(value);
  if (!raw.startsWith(CURSOR_PREFIX) || raw.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  try {
    const payload = JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url'));
    const balanceRaw = String(payload?.balanceRaw ?? '');
    const rank = Number(payload?.rank);
    const walletAddress = normalizeTokenAddress('robinhood', payload?.walletAddress);
    if (!/^\d{1,78}$/.test(balanceRaw) || balanceRaw === '0'
        || !Number.isSafeInteger(rank) || rank < 1 || rank > 10_000_000) {
      throw invalidCursor();
    }
    return Object.freeze({ balanceRaw, walletAddress, rank });
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

function validateLedgerCursor(value) {
  decodeCursor(value);
  return String(value);
}

function mapPage(tokenAddress, cursor, rows) {
  if (!rows.length) return null;
  const holderCount = Number(rows[0].holder_count);
  if (!Number.isSafeInteger(holderCount) || holderCount < 0) {
    throw new Error('Published holder count is invalid');
  }
  const pageRows = rows.filter((row) => row.wallet_address != null);
  const hasMore = pageRows.length > PAGE_SIZE;
  const selected = pageRows.slice(0, PAGE_SIZE);
  const startRank = cursor?.rank || 0;
  const items = selected.map((row, index) => Object.freeze({
    rank: startRank + index + 1,
    address: row.wallet_address,
    balanceRaw: String(row.balance_raw),
    addressType: row.address_type,
    label: null,
    isVerifiedContract: false,
  }));
  const last = items.at(-1);
  const totalSupplyRaw = rows[0].token_total_supply_raw != null
    ? String(rows[0].token_total_supply_raw) : null;
  return Object.freeze({
    address: tokenAddress,
    holderCount,
    totalSupplyRaw,
    items: Object.freeze(items),
    hasMore,
    nextCursor: hasMore ? encodeCursor({
      balanceRaw: last.balanceRaw, walletAddress: last.address, rank: last.rank,
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
    const cursor = decodeCursor(input.cursor);
    const result = await database.query(
      `WITH published_state AS MATERIALIZED (
         SELECT state.holder_count, state.updated_at AS observed_at,
                cursor.updated_at AS checked_at
           FROM robinhood_holder_token_states state
           INNER JOIN robinhood_holder_cursors cursor
             ON cursor.chain = state.chain AND cursor.stream = 'live'
          WHERE state.chain = 'robinhood' AND state.token_address = $1
            AND state.ledger_status = 'live'
       ), token_supply AS MATERIALIZED (
         SELECT observation.token_total_supply_raw
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
            AND ($2::numeric IS NULL OR balance.balance_raw < $2::numeric
              OR (balance.balance_raw = $2::numeric AND balance.wallet_address > $3))
          ORDER BY balance.balance_raw DESC, balance.wallet_address ASC
          LIMIT ${PAGE_SIZE + 1}
       )
       SELECT state.holder_count, state.observed_at, state.checked_at,
              supply.token_total_supply_raw, page.wallet_address,
              page.balance_raw, page.address_type
         FROM published_state state
         LEFT JOIN token_supply supply ON TRUE
         LEFT JOIN page ON TRUE
        ORDER BY page.balance_raw DESC NULLS LAST, page.wallet_address ASC`,
      [tokenAddress, cursor?.balanceRaw || null, cursor?.walletAddress || null]
    );
    return mapPage(tokenAddress, cursor, result.rows);
  }

  return Object.freeze({ listPublishedPage });
}

module.exports = {
  createRobinhoodHolderPageRepository,
  isLedgerCursor,
  validateLedgerCursor,
  __private: { decodeCursor, encodeCursor, mapPage, PAGE_SIZE },
};
