const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeAddressList(addresses) {
  const normalized = [...new Set((addresses || []).map((address) => String(address || '').trim()).filter(Boolean))];
  for (const address of normalized) {
    if (!isValidAddress(address)) {
      throw new Error('Invalid token address format');
    }
  }
  return normalized;
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toTimestamp(value, fallback = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function normalizeInterval(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1m', '5m', '1h', '6h', '24h'].includes(normalized) ? normalized : null;
}

function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function mapPanelStateRow(row) {
  if (!row) return null;
  return {
    tokenAddress: row.token_address || null,
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    lastInterval: row.last_interval || null,
    lastRank: row.last_rank == null ? null : Number(row.last_rank),
    lastMcap: toFiniteNumberOrNull(row.last_mcap),
    lastVol1m: toFiniteNumberOrNull(row.last_vol_1m),
    lastVol5m: toFiniteNumberOrNull(row.last_vol_5m),
    lastPayload: normalizePayload(row.last_payload),
    status: row.status || 'active',
    dexHandoffAt: row.dex_handoff_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeSeenToken(token = {}) {
  const tokenAddress = normalizeAddress(token.tokenAddress || token.address);
  return {
    tokenAddress,
    lastInterval: normalizeInterval(token.lastInterval || token.gmgnInterval || token.interval),
    lastRank: toPositiveIntegerOrNull(token.lastRank || token.gmgnRank || token.rank),
    lastMcap: toFiniteNumberOrNull(token.lastMcap ?? token.mcap),
    lastVol1m: toFiniteNumberOrNull(token.lastVol1m ?? token.vol1m),
    lastVol5m: toFiniteNumberOrNull(token.lastVol5m ?? token.vol5m),
    lastPayload: normalizePayload(token.lastPayload || token.raw || token),
  };
}

async function markTokenSeen(token, options = {}, runner = db) {
  const normalized = normalizeSeenToken(token);
  const seenAt = toTimestamp(options.seenAt);

  const { rows } = await runner.query(
    `INSERT INTO token_gmgn_panel_state (
       token_address,
       first_seen_at,
       last_seen_at,
       last_interval,
       last_rank,
       last_mcap,
       last_vol_1m,
       last_vol_5m,
       last_payload,
       status,
       dex_handoff_at,
       updated_at
     )
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', NULL, NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       last_seen_at = EXCLUDED.last_seen_at,
       last_interval = EXCLUDED.last_interval,
       last_rank = EXCLUDED.last_rank,
       last_mcap = EXCLUDED.last_mcap,
       last_vol_1m = COALESCE(EXCLUDED.last_vol_1m, token_gmgn_panel_state.last_vol_1m),
       last_vol_5m = COALESCE(EXCLUDED.last_vol_5m, token_gmgn_panel_state.last_vol_5m),
       last_payload = EXCLUDED.last_payload,
       status = 'active',
       dex_handoff_at = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      normalized.tokenAddress,
      seenAt,
      normalized.lastInterval,
      normalized.lastRank,
      normalized.lastMcap,
      normalized.lastVol1m,
      normalized.lastVol5m,
      JSON.stringify(normalized.lastPayload),
    ]
  );

  return mapPanelStateRow(rows[0] || null);
}

async function markTokensSeen(tokens, options = {}, runner = db) {
  const rows = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    rows.push(await markTokenSeen(token, options, runner));
  }
  return rows.filter(Boolean);
}

async function markMissingActiveTokensStale(seenAddresses, options = {}, runner = db) {
  const normalizedSeenAddresses = normalizeAddressList(seenAddresses);
  const staleBefore = toTimestamp(options.staleBefore);

  const { rows } = await runner.query(
    `UPDATE token_gmgn_panel_state
     SET status = 'stale',
         dex_handoff_at = COALESCE(dex_handoff_at, NOW()),
         updated_at = NOW()
     WHERE status = 'active'
       AND last_seen_at <= $1
       AND (
         cardinality($2::varchar[]) = 0
         OR token_address <> ALL($2::varchar[])
       )
     RETURNING *`,
    [staleBefore, normalizedSeenAddresses]
  );

  return rows.map(mapPanelStateRow).filter(Boolean);
}

async function getState(address, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const { rows } = await runner.query(
    `SELECT *
     FROM token_gmgn_panel_state
     WHERE token_address = $1
     LIMIT 1`,
    [tokenAddress]
  );
  return mapPanelStateRow(rows[0] || null);
}

module.exports = {
  getState,
  markMissingActiveTokensStale,
  markTokenSeen,
  markTokensSeen,
  __private: {
    mapPanelStateRow,
    normalizeAddressList,
    normalizeSeenToken,
    toTimestamp,
  },
};
