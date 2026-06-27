const db = require('./db');
const userWallet = require('./user-wallet');

const VALID_TIERS = new Set(['unlimited', 'launch_free', 'none']);
const DISCOUNT_TIER_RE = /^discount_(100|[1-9]\d?)$/;

function normalizeAddress(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 64) {
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  }
  return normalized;
}

function normalizeTier(value) {
  const normalized = String(value || 'none').trim().toLowerCase();
  return VALID_TIERS.has(normalized) || DISCOUNT_TIER_RE.test(normalized) ? normalized : 'none';
}

function normalizeBalanceRaw(value) {
  const normalized = typeof value === 'bigint' ? value.toString() : String(value || '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw Object.assign(new Error('Invalid raw token balance'), { status: 400 });
  }
  return normalized;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    mintAddress: row.mint_address,
    tokenProgram: row.token_program || null,
    decimals: normalizeInteger(row.decimals),
    balanceRaw: normalizeBalanceRaw(row.balance_raw),
    balanceUiString: row.balance_ui_string || null,
    tier: normalizeTier(row.tier),
    discountPercent: normalizeInteger(row.discount_percent),
    hasUnlimitedAccess: Boolean(row.has_unlimited_access),
    hasLaunchPromoAccess: Boolean(row.has_launch_promo_access),
    checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    rpcProvider: row.rpc_provider || null,
    rpcSlot: row.rpc_slot == null ? null : Number(row.rpc_slot),
    rpcError: row.rpc_error || null,
    metadata: normalizeMetadata(row.metadata),
  };
}

async function createSnapshot(input = {}, runner = db) {
  const { rows } = await runner.query(
    `INSERT INTO token_holding_snapshots (
       user_id,
       wallet_address,
       mint_address,
       token_program,
       decimals,
       balance_raw,
       balance_ui_string,
       tier,
       discount_percent,
       has_unlimited_access,
       has_launch_promo_access,
       checked_at,
       expires_at,
       rpc_provider,
       rpc_slot,
       rpc_error,
       metadata
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, COALESCE($12, NOW()), $13, $14, $15, $16, $17::jsonb
     )
     RETURNING *`,
    [
      input.userId,
      userWallet.normalizeWalletAddress(input.walletAddress),
      normalizeAddress(input.mintAddress, 'mint address'),
      input.tokenProgram ? String(input.tokenProgram).trim().slice(0, 128) : null,
      normalizeInteger(input.decimals),
      normalizeBalanceRaw(input.balanceRaw),
      input.balanceUiString ? String(input.balanceUiString).trim() : null,
      normalizeTier(input.tier),
      normalizeInteger(input.discountPercent),
      Boolean(input.hasUnlimitedAccess),
      Boolean(input.hasLaunchPromoAccess),
      input.checkedAt || null,
      input.expiresAt,
      input.rpcProvider ? String(input.rpcProvider).trim().slice(0, 64) : null,
      input.rpcSlot == null ? null : normalizeInteger(input.rpcSlot),
      input.rpcError ? String(input.rpcError).trim().slice(0, 1000) : null,
      JSON.stringify(normalizeMetadata(input.metadata)),
    ]
  );
  return mapRow(rows[0]);
}

async function findLatestForUser(userId, mintAddress, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM token_holding_snapshots
     WHERE user_id = $1
       AND mint_address = $2
     ORDER BY checked_at DESC, id DESC
     LIMIT 1`,
    [userId, normalizeAddress(mintAddress, 'mint address')]
  );
  return mapRow(rows[0]);
}

async function findLatestForWallet(walletAddress, mintAddress, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM token_holding_snapshots
     WHERE wallet_address = $1
       AND mint_address = $2
     ORDER BY checked_at DESC, id DESC
     LIMIT 1`,
    [
      userWallet.normalizeWalletAddress(walletAddress),
      normalizeAddress(mintAddress, 'mint address'),
    ]
  );
  return mapRow(rows[0]);
}

module.exports = {
  VALID_TIERS,
  normalizeTier,
  normalizeBalanceRaw,
  mapRow,
  createSnapshot,
  findLatestForUser,
  findLatestForWallet,
};
