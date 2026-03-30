const { query } = require('./db');

const VALID_STATUSES = new Set(['inactive', 'active', 'grace', 'revoked']);
const VALID_SOURCES = new Set(['manual', 'payment', 'admin', 'promo', 'invite']);
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
  };
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
  getAccessRowByUserId,
  getAccessSnapshotByUserId,
  grantForUserWithRunner,
  grantForUser,
  extendForUserWithRunner,
  extendForUser,
  revokeForUserWithRunner,
  revokeForUser,
};
