const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeSource(value) {
  const normalized = String(value || 'helius').trim().toLowerCase();
  return normalized || 'helius';
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIntegerOrNull(value) {
  const parsed = toNumberOrNull(value);
  if (parsed == null) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeError(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function normalizeStringOrNull(value, maxLength = 128) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeReasonCodes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 64)
  )];
}

function normalizeTopHolders(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((row) => {
      const address = normalizeStringOrNull(row?.address, 128);
      if (!address) {
        return null;
      }

      return {
        address,
        uiAmount: toNumberOrNull(row?.uiAmount),
        pctOfSupply: toNumberOrNull(row?.pctOfSupply),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function mapRow(row) {
  if (!row) return null;
  return {
    tokenAddress: row.token_address || null,
    source: row.source || 'helius',
    lastAttemptedAt: row.last_attempted_at || null,
    lastEnrichedAt: row.last_enriched_at || null,
    lastError: normalizeError(row.last_error),
    holderCount: toIntegerOrNull(row.holder_count),
    supply: {
      amount: normalizeStringOrNull(row.supply_amount, 128),
      decimals: toIntegerOrNull(row.supply_decimals),
      uiAmount: toNumberOrNull(row.supply_ui_amount),
      tokenProgram: normalizeStringOrNull(row.token_program, 128),
    },
    mintAuthority: normalizeStringOrNull(row.mint_authority, 128),
    freezeAuthority: normalizeStringOrNull(row.freeze_authority, 128),
    mintAuthorityActive: Boolean(row.mint_authority_active),
    freezeAuthorityActive: Boolean(row.freeze_authority_active),
    top1Pct: toNumberOrNull(row.top_1_pct),
    top5Pct: toNumberOrNull(row.top_5_pct),
    top10Pct: toNumberOrNull(row.top_10_pct),
    top20Pct: toNumberOrNull(row.top_20_pct),
    topHolders: Array.isArray(row.top_holders) ? row.top_holders : [],
    reasonCodes: normalizeReasonCodes(row.reason_codes),
    updatedAt: row.updated_at || null,
  };
}

async function getByAddress(address, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const { rows } = await runner.query(
    `SELECT *
     FROM token_risk_enrichment
     WHERE token_address = $1
     LIMIT 1`,
    [tokenAddress]
  );

  return mapRow(rows[0] || null);
}

async function listByAddresses(addresses = [], runner = db) {
  const normalized = [...new Set((addresses || []).map((address) => String(address || '').trim()).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  for (const address of normalized) {
    if (!isValidAddress(address)) {
      throw new Error('Invalid token address format');
    }
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM token_risk_enrichment
     WHERE token_address = ANY($1::varchar[])
     ORDER BY token_address ASC`,
    [normalized]
  );

  return rows.map(mapRow);
}

async function upsertEnrichment(payload = {}, runner = db) {
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const source = normalizeSource(payload.source);
  const lastAttemptedAt = toTimestampOrNull(payload.lastAttemptedAt) || new Date();
  const lastEnrichedAt = toTimestampOrNull(payload.lastEnrichedAt) || lastAttemptedAt;
  const lastError = normalizeError(payload.lastError);
  const holderCount = toIntegerOrNull(payload.holderCount);
  const supply = payload.supply && typeof payload.supply === 'object' ? payload.supply : {};
  const supplyAmount = normalizeStringOrNull(supply.amount, 128);
  const supplyDecimals = toIntegerOrNull(supply.decimals);
  const supplyUiAmount = toNumberOrNull(supply.uiAmount);
  const tokenProgram = normalizeStringOrNull(supply.tokenProgram, 128);
  const mintAuthority = normalizeStringOrNull(payload.mintAuthority, 128);
  const freezeAuthority = normalizeStringOrNull(payload.freezeAuthority, 128);
  const mintAuthorityActive = Boolean(payload.mintAuthorityActive);
  const freezeAuthorityActive = Boolean(payload.freezeAuthorityActive);
  const top1Pct = toNumberOrNull(payload.top1Pct);
  const top5Pct = toNumberOrNull(payload.top5Pct);
  const top10Pct = toNumberOrNull(payload.top10Pct);
  const top20Pct = toNumberOrNull(payload.top20Pct);
  const topHolders = normalizeTopHolders(payload.topHolders);
  const reasonCodes = normalizeReasonCodes(payload.reasonCodes);

  const { rows } = await runner.query(
    `INSERT INTO token_risk_enrichment (
       token_address,
       source,
       last_attempted_at,
       last_enriched_at,
       last_error,
       holder_count,
       supply_amount,
       supply_decimals,
       supply_ui_amount,
       token_program,
       mint_authority,
       freeze_authority,
       mint_authority_active,
       freeze_authority_active,
       top_1_pct,
       top_5_pct,
       top_10_pct,
       top_20_pct,
       top_holders,
       reason_codes,
       updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, NOW()
     )
     ON CONFLICT (token_address) DO UPDATE SET
       source = EXCLUDED.source,
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_enriched_at = EXCLUDED.last_enriched_at,
       last_error = EXCLUDED.last_error,
       holder_count = EXCLUDED.holder_count,
       supply_amount = EXCLUDED.supply_amount,
       supply_decimals = EXCLUDED.supply_decimals,
       supply_ui_amount = EXCLUDED.supply_ui_amount,
       token_program = EXCLUDED.token_program,
       mint_authority = EXCLUDED.mint_authority,
       freeze_authority = EXCLUDED.freeze_authority,
       mint_authority_active = EXCLUDED.mint_authority_active,
       freeze_authority_active = EXCLUDED.freeze_authority_active,
       top_1_pct = EXCLUDED.top_1_pct,
       top_5_pct = EXCLUDED.top_5_pct,
       top_10_pct = EXCLUDED.top_10_pct,
       top_20_pct = EXCLUDED.top_20_pct,
       top_holders = EXCLUDED.top_holders,
       reason_codes = EXCLUDED.reason_codes,
       updated_at = NOW()
     RETURNING *`,
    [
      tokenAddress,
      source,
      lastAttemptedAt,
      lastEnrichedAt,
      lastError,
      holderCount,
      supplyAmount,
      supplyDecimals,
      supplyUiAmount,
      tokenProgram,
      mintAuthority,
      freezeAuthority,
      mintAuthorityActive,
      freezeAuthorityActive,
      top1Pct,
      top5Pct,
      top10Pct,
      top20Pct,
      JSON.stringify(topHolders),
      JSON.stringify(reasonCodes),
    ]
  );

  return mapRow(rows[0] || null);
}

async function recordError(address, error, options = {}, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const source = normalizeSource(options.source);
  const lastAttemptedAt = toTimestampOrNull(options.lastAttemptedAt) || new Date();
  const lastError = normalizeError(error);

  const { rows } = await runner.query(
    `INSERT INTO token_risk_enrichment (
       token_address,
       source,
       last_attempted_at,
       last_error,
       updated_at
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       source = EXCLUDED.source,
       last_attempted_at = EXCLUDED.last_attempted_at,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()
     RETURNING *`,
    [
      tokenAddress,
      source,
      lastAttemptedAt,
      lastError,
    ]
  );

  return mapRow(rows[0] || null);
}

module.exports = {
  getByAddress,
  listByAddresses,
  upsertEnrichment,
  recordError,
  __private: {
    mapRow,
    normalizeAddress,
    normalizeError,
    normalizeReasonCodes,
    normalizeSource,
    normalizeStringOrNull,
    normalizeTopHolders,
    toIntegerOrNull,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
