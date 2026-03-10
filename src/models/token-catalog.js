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

function toNullableText(value) {
  return value == null ? null : String(value).trim() || null;
}

async function upsertToken(token) {
  const address = String(token.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const chain = normalizeChain(token.chain);
  const source = normalizeSource(token.source);
  const symbol = toNullableText(token.symbol);
  const name = toNullableText(token.name);
  const lastPairAddress = toNullableText(token.pairAddress);
  const lastPairUrl = toNullableText(token.pairUrl);
  const lastImageUrl = toNullableText(token.imageUrl);
  const lastTwitterUrl = toNullableText(token.twitterUrl);
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

async function listDueForEvaluation(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
  const { rows } = await db.query(
    `SELECT *
     FROM token_catalog
     WHERE next_evaluation_at <= NOW()
     ORDER BY next_evaluation_at ASC, last_seen_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

async function applyEvaluationResult(address, result) {
  const addr = String(address || '').trim();
  const eligibilityState = toNullableText(result.eligibilityState) || 'unknown';
  const eligibleForMonitoring = !!result.eligibleForMonitoring;
  const suppressedReason = toNullableText(result.suppressedReason);
  const nextEvaluationAt = result.nextEvaluationAt || new Date(Date.now() + 10 * 60 * 1000);
  const lastEvaluationError = toNullableText(result.lastEvaluationError);
  const errorCount = Number.isInteger(result.evaluationErrorCount) ? result.evaluationErrorCount : 0;
  const symbol = toNullableText(result.symbol);
  const name = toNullableText(result.name);
  const pairAddress = toNullableText(result.pairAddress);
  const pairUrl = toNullableText(result.pairUrl);
  const imageUrl = toNullableText(result.imageUrl);
  const twitterUrl = toNullableText(result.twitterUrl);
  const lastMcap = Number.isFinite(Number(result.mcap)) ? Number(result.mcap) : null;
  const lastPrice = Number.isFinite(Number(result.price)) ? Number(result.price) : null;

  const { rows } = await db.query(
    `UPDATE token_catalog
     SET eligibility_state = $2,
         eligible_for_monitoring = $3,
         suppressed_reason = $4,
         last_evaluated_at = NOW(),
         next_evaluation_at = $5,
         last_evaluation_error = $6,
         evaluation_error_count = $7,
         last_eligible_at = CASE WHEN $3 THEN NOW() ELSE last_eligible_at END,
         symbol = COALESCE($8, symbol),
         name = COALESCE($9, name),
         last_pair_address = COALESCE($10, last_pair_address),
         last_pair_url = COALESCE($11, last_pair_url),
         last_image_url = COALESCE($12, last_image_url),
         last_twitter_url = COALESCE($13, last_twitter_url),
         last_mcap = COALESCE($14, last_mcap),
         last_price = COALESCE($15, last_price),
         metadata_updated_at = CASE
           WHEN $8 IS NOT NULL OR $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL OR $12 IS NOT NULL OR $13 IS NOT NULL OR $14 IS NOT NULL OR $15 IS NOT NULL
           THEN NOW()
           ELSE metadata_updated_at
         END
     WHERE address = $1
     RETURNING *`,
    [
      addr,
      eligibilityState,
      eligibleForMonitoring,
      suppressedReason,
      nextEvaluationAt,
      lastEvaluationError,
      errorCount,
      symbol,
      name,
      pairAddress,
      pairUrl,
      imageUrl,
      twitterUrl,
      lastMcap,
      lastPrice,
    ]
  );

  return rows[0] || null;
}

module.exports = {
  upsertToken,
  getByAddress,
  listRecent,
  listDueForEvaluation,
  applyEvaluationResult,
};
