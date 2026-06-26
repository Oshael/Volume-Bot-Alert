const { query } = require('./db');
const config = require('../../config');
const tokenHoldingSnapshot = require('./token-holding-snapshot');
const userWallet = require('./user-wallet');
const tokenHoldingService = require('../services/token-holding-service');

const VALID_STATUSES = new Set(['inactive', 'active', 'grace', 'revoked']);
const VALID_SOURCES = new Set(['manual', 'payment', 'admin', 'promo', 'invite']);
const DEFAULT_TOKEN_ACCESS = {
  tokenTier: 'none',
  discountPercent: 0,
  tokenBalanceRaw: null,
  tokenBalanceUi: null,
  tokenSnapshotCheckedAt: null,
  tokenSnapshotExpiresAt: null,
};
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(normalized) ? normalized : 'inactive';
}

function normalizeSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_SOURCES.has(normalized) ? normalized : 'manual';
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function computeDaysRemaining(expiresAt, now) {
  if (!expiresAt) return null;
  const msRemaining = expiresAt.getTime() - now.getTime();
  if (msRemaining <= 0) return 0;
  return Math.ceil(msRemaining / DAY_MS);
}

function buildAccessSnapshot(userLike, now = new Date()) {
  if (String(userLike?.role || '').trim().toLowerCase() === 'admin') {
    return {
      accessStatus: 'active',
      accessGrantedAt: parseTimestamp(userLike?.access_granted_at)?.toISOString() || null,
      accessExpiresAt: null,
      accessSource: 'admin',
      accessUpdatedAt: parseTimestamp(userLike?.access_updated_at)?.toISOString() || null,
      isExpired: false,
      isTimed: false,
      hasProductAccess: true,
      denialReason: null,
      denialCode: null,
      daysRemaining: null,
      accessReason: 'admin',
      ...DEFAULT_TOKEN_ACCESS,
    };
  }

  const accessStatus = normalizeStatus(userLike?.access_status || 'active');
  const accessSource = normalizeSource(userLike?.access_source || 'manual');
  const accessGrantedAt = parseTimestamp(userLike?.access_granted_at);
  const accessExpiresAt = parseTimestamp(userLike?.access_expires_at);
  const accessUpdatedAt = parseTimestamp(userLike?.access_updated_at);
  const isExpired = Boolean(accessExpiresAt && accessExpiresAt.getTime() <= now.getTime());

  let hasProductAccess = false;
  let denialReason = null;
  let denialCode = null;

  if (accessStatus === 'revoked') {
    denialReason = 'Access revoked';
    denialCode = 'access_revoked';
  } else if (accessStatus === 'inactive') {
    denialReason = 'Access inactive';
    denialCode = 'access_inactive';
  } else if (isExpired) {
    denialReason = 'Access expired';
    denialCode = 'access_expired';
  } else if (accessStatus === 'active' || accessStatus === 'grace') {
    hasProductAccess = true;
  } else {
    denialReason = 'Access inactive';
    denialCode = 'access_inactive';
  }

  return {
    accessStatus,
    accessGrantedAt: accessGrantedAt ? accessGrantedAt.toISOString() : null,
    accessExpiresAt: accessExpiresAt ? accessExpiresAt.toISOString() : null,
    accessSource,
    accessUpdatedAt: accessUpdatedAt ? accessUpdatedAt.toISOString() : null,
    isExpired,
    isTimed: Boolean(accessExpiresAt),
    hasProductAccess,
    denialReason,
    denialCode,
    daysRemaining: computeDaysRemaining(accessExpiresAt, now),
    accessReason: hasProductAccess ? accessSource : 'none',
    ...DEFAULT_TOKEN_ACCESS,
  };
}

function isValidTokenSnapshot(snapshot, now = new Date()) {
  if (!snapshot) return false;
  const expiresAt = parseTimestamp(snapshot.expiresAt || snapshot.expires_at);
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
}

function isWithinRpcFailureGrace(snapshot, now = new Date(), gateConfig = {}) {
  if (!snapshot || !getTokenAccessReason(snapshot)) return false;
  const checkedAt = parseTimestamp(snapshot.checkedAt || snapshot.checked_at);
  if (!checkedAt) return false;
  const graceSeconds = Math.max(60, Number(gateConfig.rpcFailureGraceSeconds) || 3600);
  return checkedAt.getTime() + (graceSeconds * 1000) > now.getTime();
}

function getTokenAccessReason(snapshot) {
  if (snapshot?.hasUnlimitedAccess || snapshot?.has_unlimited_access) {
    return 'token_unlimited';
  }
  if (snapshot?.hasLaunchPromoAccess || snapshot?.has_launch_promo_access) {
    return 'token_launch_promo';
  }
  return null;
}

function getSnapshotValue(snapshot, camelKey, snakeKey, fallback = null) {
  return snapshot?.[camelKey] ?? snapshot?.[snakeKey] ?? fallback;
}

function getLaunchPromoEndAt(gateConfig = {}) {
  return parseTimestamp(gateConfig?.launchPromo?.endAt);
}

function isLaunchPromoStillActive(now = new Date(), gateConfig = {}) {
  const endAt = getLaunchPromoEndAt(gateConfig);
  return Boolean(endAt && endAt.getTime() > now.getTime());
}

function buildTokenFields(snapshot) {
  return {
    tokenTier: getSnapshotValue(snapshot, 'tier', 'tier', 'none'),
    discountPercent: Number(getSnapshotValue(snapshot, 'discountPercent', 'discount_percent', 0)) || 0,
    tokenBalanceRaw: getSnapshotValue(snapshot, 'balanceRaw', 'balance_raw'),
    tokenBalanceUi: getSnapshotValue(snapshot, 'balanceUiString', 'balance_ui_string'),
    tokenSnapshotCheckedAt: getSnapshotValue(snapshot, 'checkedAt', 'checked_at'),
    tokenSnapshotExpiresAt: getSnapshotValue(snapshot, 'expiresAt', 'expires_at'),
  };
}

function shouldApplyTokenAccess(baseAccess, snapshot, now, gateConfig = {}) {
  const reason = getTokenAccessReason(snapshot);
  if (reason === 'token_launch_promo' && !isLaunchPromoStillActive(now, gateConfig)) {
    return false;
  }

  return Boolean(
    isValidTokenSnapshot(snapshot, now)
    && reason
    && !baseAccess.hasProductAccess
    && baseAccess.denialCode !== 'access_revoked'
  );
}

function buildTokenAccessExpiry(reason, now = new Date(), gateConfig = {}) {
  if (reason !== 'token_launch_promo') {
    return {
      accessExpiresAt: null,
      isTimed: false,
      daysRemaining: null,
    };
  }

  const endAt = getLaunchPromoEndAt(gateConfig);
  return {
    accessExpiresAt: endAt ? endAt.toISOString() : null,
    isTimed: Boolean(endAt),
    daysRemaining: computeDaysRemaining(endAt, now),
  };
}

function mergeTokenAccess(baseAccess, snapshot, now = new Date(), gateConfig = config.tokenGate || {}) {
  const tokenFields = buildTokenFields(snapshot);
  if (!shouldApplyTokenAccess(baseAccess, snapshot, now, gateConfig)) {
    return {
      ...baseAccess,
      ...tokenFields,
    };
  }

  const reason = getTokenAccessReason(snapshot);
  const expiry = buildTokenAccessExpiry(reason, now, gateConfig);
  return {
    ...baseAccess,
    accessStatus: 'active',
    accessSource: 'token',
    isExpired: false,
    isTimed: expiry.isTimed,
    hasProductAccess: true,
    denialReason: null,
    denialCode: null,
    accessExpiresAt: expiry.accessExpiresAt,
    daysRemaining: expiry.daysRemaining,
    accessReason: reason,
    ...tokenFields,
  };
}

function mergeGraceTokenAccess(baseAccess, snapshot, now = new Date(), gateConfig = config.tokenGate || {}) {
  const reason = getTokenAccessReason(snapshot);
  if (
    !reason
    || baseAccess.hasProductAccess
    || baseAccess.denialCode === 'access_revoked'
    || (reason === 'token_launch_promo' && !isLaunchPromoStillActive(now, gateConfig))
  ) {
    return {
      ...baseAccess,
      ...buildTokenFields(snapshot),
    };
  }

  const expiry = buildTokenAccessExpiry(reason, now, gateConfig);
  return {
    ...baseAccess,
    accessStatus: 'active',
    accessSource: 'token',
    isExpired: false,
    isTimed: expiry.isTimed,
    hasProductAccess: true,
    denialReason: null,
    denialCode: null,
    accessExpiresAt: expiry.accessExpiresAt,
    daysRemaining: expiry.daysRemaining,
    accessReason: reason,
    ...buildTokenFields(snapshot),
  };
}

async function refreshExpiredTokenSnapshot({ userId, snapshot, now, gateConfig, deps }) {
  if (!snapshot || isValidTokenSnapshot(snapshot, now) || !getTokenAccessReason(snapshot)) {
    return snapshot;
  }

  const walletModel = deps.userWalletModel || userWallet;
  const holdingService = deps.tokenHoldingService || tokenHoldingService;
  const wallet = await walletModel.findByUserId(userId);
  if (!wallet?.walletAddress) {
    return snapshot;
  }

  return holdingService.refreshSnapshotForUser({
    userId,
    walletAddress: wallet.walletAddress,
    now,
  }, {
    ...deps,
    config: gateConfig,
    snapshotModel: deps.tokenHoldingSnapshotModel || tokenHoldingSnapshot,
  });
}

async function buildResolvedAccessSnapshot(userLike, now = new Date(), deps = {}) {
  const baseAccess = buildAccessSnapshot(userLike, now);
  const gateConfig = deps.config || config.tokenGate || {};
  const snapshotModel = deps.tokenHoldingSnapshotModel || tokenHoldingSnapshot;
  const userId = userLike?.id;

  if (!gateConfig.enabled || !gateConfig.mintAddress || !userId || baseAccess.denialCode === 'access_revoked') {
    return baseAccess;
  }

  const snapshot = await snapshotModel.findLatestForUser(userId, gateConfig.mintAddress);
  try {
    const refreshedSnapshot = await refreshExpiredTokenSnapshot({
      userId,
      snapshot,
      now,
      gateConfig,
      deps,
    });
    return mergeTokenAccess(baseAccess, refreshedSnapshot, now, gateConfig);
  } catch (err) {
    if (isWithinRpcFailureGrace(snapshot, now, gateConfig)) {
      return mergeGraceTokenAccess(baseAccess, snapshot, now, gateConfig);
    }
    throw err;
  }
}

async function getAccessRowByUserId(userId) {
  const { rows } = await query(
    `SELECT id, access_status, access_granted_at, access_expires_at, access_source, access_updated_at
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function getAccessSnapshotByUserId(userId) {
  const row = await getAccessRowByUserId(userId);
  return row ? buildAccessSnapshot(row) : null;
}

async function grantForUserWithRunner(runner, userId, { days, source = 'admin' }) {
  const normalizedSource = normalizeSource(source);
  const { rows } = await runner.query(
    `UPDATE users
     SET access_status = 'active',
         access_granted_at = NOW(),
         access_expires_at = NOW() + INTERVAL '1 day' * $2,
         access_source = $3,
         access_updated_at = NOW()
     WHERE id = $1
     RETURNING id, access_status, access_granted_at, access_expires_at, access_source, access_updated_at`,
    [userId, days, normalizedSource]
  );
  return rows[0] ? buildAccessSnapshot(rows[0]) : null;
}

async function grantForUser(userId, { days, source = 'admin' }) {
  return grantForUserWithRunner({ query }, userId, { days, source });
}

async function extendForUserWithRunner(runner, userId, { days, source = 'admin' }) {
  const normalizedSource = normalizeSource(source);
  const { rows } = await runner.query(
    `UPDATE users
     SET access_status = 'active',
         access_granted_at = COALESCE(access_granted_at, NOW()),
         access_expires_at = (
           CASE
             WHEN access_expires_at IS NOT NULL AND access_expires_at > NOW() THEN access_expires_at
             ELSE NOW()
           END
         ) + INTERVAL '1 day' * $2,
         access_source = $3,
         access_updated_at = NOW()
     WHERE id = $1
     RETURNING id, access_status, access_granted_at, access_expires_at, access_source, access_updated_at`,
    [userId, days, normalizedSource]
  );
  return rows[0] ? buildAccessSnapshot(rows[0]) : null;
}

async function extendForUser(userId, { days, source = 'admin' }) {
  return extendForUserWithRunner({ query }, userId, { days, source });
}

async function revokeForUserWithRunner(runner, userId, { source = 'admin' } = {}) {
  const normalizedSource = normalizeSource(source);
  const { rows } = await runner.query(
    `UPDATE users
     SET access_status = 'revoked',
         access_source = $2,
         access_updated_at = NOW()
     WHERE id = $1
     RETURNING id, access_status, access_granted_at, access_expires_at, access_source, access_updated_at`,
    [userId, normalizedSource]
  );
  return rows[0] ? buildAccessSnapshot(rows[0]) : null;
}

async function revokeForUser(userId, { source = 'admin' } = {}) {
  return revokeForUserWithRunner({ query }, userId, { source });
}

module.exports = {
  VALID_STATUSES,
  VALID_SOURCES,
  buildAccessSnapshot,
  buildResolvedAccessSnapshot,
  mergeTokenAccess,
  mergeGraceTokenAccess,
  getAccessRowByUserId,
  getAccessSnapshotByUserId,
  grantForUserWithRunner,
  grantForUser,
  extendForUserWithRunner,
  extendForUser,
  revokeForUserWithRunner,
  revokeForUser,
};
