const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const {
  normalizeRobinhoodHolderSummary,
} = require('../utils/robinhood-holder-summary-view');

// Solana address: base58, 32-44 chars
// Ethereum/BSC/Base: hex, 42 chars (0x + 40)
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a token address.
 */
function isValidAddress(address) {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  return SOLANA_ADDR_RE.test(trimmed) || EVM_ADDR_RE.test(trimmed);
}

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

/**
 * Get all manual tokens for a user.
 */
async function getAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT chain, address, label, added_at
     FROM user_tokens
     WHERE user_id = $1 AND chain = $2
     ORDER BY added_at ASC`,
    [userId, chain]
  );
  return rows;
}

async function getAllForChains(userId, chainValues = ['solana', 'robinhood']) {
  const chains = [...new Set(chainValues.map(normalizeTokenChain))];
  if (chains.length === 0) return [];
  const { rows } = await db.query(
    `SELECT ut.chain, ut.address, ut.label, ut.added_at,
            tc.symbol, tc.name, tc.last_image_url,
            tc.last_price, tc.last_mcap, tc.last_fdv,
            tc.last_liquidity_usd, tc.last_vol_5m, tc.last_vol_1h,
            tc.last_vol_6h, tc.last_vol_24h, tc.last_price_change_1h,
            tc.last_price_change_6h, tc.last_price_change_24h,
            tc.last_pair_address, tc.last_dex_id,
            tc.last_token_created_at_ms, tc.first_seen_at, tc.last_seen_at,
            holder_summary.holder_count, holder_summary.source AS holder_source,
            holder_summary.observed_at AS holder_observed_at,
            holder_summary.checked_at AS holder_checked_at
     FROM user_tokens ut
     LEFT JOIN token_catalog tc
       ON tc.chain = ut.chain AND tc.address = ut.address
     LEFT JOIN robinhood_published_holder_summaries holder_summary
       ON holder_summary.chain = ut.chain AND holder_summary.token_address = ut.address
     WHERE ut.user_id = $1 AND ut.chain = ANY($2::varchar[])
     ORDER BY ut.added_at ASC, ut.chain ASC, ut.address ASC`,
    [userId, chains]
  );
  const asOf = new Date();
  return rows.map((row) => ({
    ...row,
    ...(row.chain === 'robinhood'
      ? normalizeRobinhoodHolderSummary(row, asOf)
      : { holderCount: null, holderObservedAt: null, holderCheckedAt: null,
        holderFreshness: 'unavailable' }),
  }));
}

/**
 * Check whether a manual token already exists for a user.
 */
async function exists(userId, address, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rows } = await db.query(
    `SELECT 1
     FROM user_tokens
     WHERE user_id = $1 AND chain = $2 AND address = $3
     LIMIT 1`,
    [userId, identity.chain, identity.address]
  );
  return rows.length > 0;
}

/**
 * Add a manual token. Returns the created row or null if duplicate.
 */
async function add(userId, address, label = null, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rows } = await db.query(
    `INSERT INTO user_tokens (user_id, chain, address, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, chain, address) DO NOTHING
     RETURNING chain, address, label, added_at`,
    [userId, identity.chain, identity.address, label]
  );
  return rows[0] || null;
}

/**
 * Add multiple tokens at once (for PUT sync). Ignores duplicates.
 */
async function setAll(userId, tokens, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Clear existing
    await client.query('DELETE FROM user_tokens WHERE user_id = $1 AND chain = $2', [userId, chain]);
    // Insert new
    for (const tok of tokens) {
      const label = tok?.label || null;
      let addr;
      try { addr = normalizeTokenAddress(chain, tok?.address || tok); } catch (_) { continue; }
      await client.query(
        `INSERT INTO user_tokens (user_id, chain, address, label)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, chain, address) DO NOTHING`,
        [userId, chain, addr, label]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove a manual token. Returns true if deleted.
 */
async function remove(userId, address, chainValue = 'solana') {
  const identity = normalizeIdentity(address, chainValue);
  const { rowCount } = await db.query(
    'DELETE FROM user_tokens WHERE user_id = $1 AND chain = $2 AND address = $3',
    [userId, identity.chain, identity.address]
  );
  return rowCount > 0;
}

/**
 * Count tokens for a user (for rate limiting).
 */
async function count(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM user_tokens WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );
  return rows[0].count;
}

module.exports = {
  isValidAddress,
  getAll,
  getAllForChains,
  exists,
  add,
  setAll,
  remove,
  count,
  normalizeIdentity,
};
