const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeChain(chain) {
  const value = String(chain || 'solana').trim().toLowerCase();
  if (!value) return 'solana';
  return value;
}

function normalizeSource(source) {
  const value = String(source || 'unknown').trim().toLowerCase();
  return value || 'unknown';
}

async function upsertToken(token) {
  const address = String(token.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const chain = normalizeChain(token.chain);
  const source = normalizeSource(token.source);
  const symbol = token.symbol == null ? null : String(token.symbol).trim() || null;
  const name = token.name == null ? null : String(token.name).trim() || null;
  const lastPairAddress = token.pairAddress == null ? null : String(token.pairAddress).trim() || null;
  const lastPairUrl = token.pairUrl == null ? null : String(token.pairUrl).trim() || null;
  const lastImageUrl = token.imageUrl == null ? null : String(token.imageUrl).trim() || null;
  const lastTwitterUrl = token.twitterUrl == null ? null : String(token.twitterUrl).trim() || null;
  const isActiveMonitorCandidate = token.isActiveMonitorCandidate == null ? true : !!token.isActiveMonitorCandidate;
  const lastMcap = Number.isFinite(Number(token.mcap)) ? Number(token.mcap) : null;
  const lastPrice = Number.isFinite(Number(token.price)) ? Number(token.price) : null;

  const { rows } = await db.query(
    `INSERT INTO token_catalog (
       address, chain, symbol, name, source,
       last_mcap, last_price, last_pair_address, last_pair_url,
       last_image_url, last_twitter_url, is_active_monitor_candidate
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (address) DO UPDATE SET
       chain = EXCLUDED.chain,
       symbol = COALESCE(EXCLUDED.symbol, token_catalog.symbol),
       name = COALESCE(EXCLUDED.name, token_catalog.name),
       source = EXCLUDED.source,
       last_seen_at = NOW(),
       last_mcap = COALESCE(EXCLUDED.last_mcap, token_catalog.last_mcap),
       last_price = COALESCE(EXCLUDED.last_price, token_catalog.last_price),
       last_pair_address = COALESCE(EXCLUDED.last_pair_address, token_catalog.last_pair_address),
       last_pair_url = COALESCE(EXCLUDED.last_pair_url, token_catalog.last_pair_url),
       last_image_url = COALESCE(EXCLUDED.last_image_url, token_catalog.last_image_url),
       last_twitter_url = COALESCE(EXCLUDED.last_twitter_url, token_catalog.last_twitter_url),
       is_active_monitor_candidate = EXCLUDED.is_active_monitor_candidate,
       metadata_updated_at = NOW()
     RETURNING *`,
    [
      address,
      chain,
      symbol,
      name,
      source,
      lastMcap,
      lastPrice,
      lastPairAddress,
      lastPairUrl,
      lastImageUrl,
      lastTwitterUrl,
      isActiveMonitorCandidate,
    ]
  );

  return rows[0];
}

async function getByAddress(address) {
  const addr = String(address || '').trim();
  const { rows } = await db.query(
    'SELECT * FROM token_catalog WHERE address = $1 LIMIT 1',
    [addr]
  );
  return rows[0] || null;
}

async function listRecent(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const { rows } = await db.query(
    `SELECT *
     FROM token_catalog
     ORDER BY last_seen_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

module.exports = {
  upsertToken,
  getByAddress,
  listRecent,
};
