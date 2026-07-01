const express = require('express');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const userAccess = require('../models/user-access');
const { query } = require('../models/db');
const socketHub = require('../services/socket-hub');
const { classifyTokenJunk } = require('../services/token-junk-metric');
const tokenRiskCandidateSelector = require('../services/token-risk-candidate-selector');
const tokenRiskEnrichmentWorker = require('../services/token-risk-enrichment-worker');
const tokenRiskEnrichment = require('../models/token-risk-enrichment');
const tokenRiskReview = require('../models/token-risk-review');
const adminBlockedToken = require('../models/admin-blocked-token');
const adminTokenReviewAlert = require('../models/admin-token-review-alert');
const monitoredTokenExitEvent = require('../models/monitored-token-exit-event');
const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const { isValidAddress } = require('../models/user-token');
const {
  buildBlockStatusSummary,
  buildEffectiveRiskLabel,
  buildRiskReviewSummary,
} = require('../services/token-risk-summary');

const router = express.Router();

function parseInviteCreateOptions(body = {}) {
  const opts = {};
  const hasMaxUses = body.maxUses !== undefined && body.maxUses !== null && String(body.maxUses).trim() !== '';
  const hasExpiryHours = body.expiryHours !== undefined && body.expiryHours !== null && String(body.expiryHours).trim() !== '';

  if (hasMaxUses) {
    const parsed = Number.parseInt(body.maxUses, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: 'maxUses must be an integer' };
    }
    opts.maxUses = parsed;
  }

  if (hasExpiryHours) {
    const parsed = Number.parseInt(body.expiryHours, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: 'expiryHours must be an integer' };
    }
    opts.expiryHours = parsed;
  }

  return { ok: true, opts };
}

function parsePositiveId(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLogsLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 50;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, 200);
}

function parseOptionalBooleanQuery(value) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return { ok: true, value: true };
  }
  if (normalized === 'false') {
    return { ok: true, value: false };
  }

  return { ok: false, error: 'success must be true or false' };
}

function parseOptionalIntegerField(value, name, { min, max }) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: undefined };
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed)) {
    return { ok: false, error: `${name} must be an integer` };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }

  return { ok: true, value: parsed };
}

function parseAddressListQuery(value, { maxItems = 50 } = {}) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',');

  const unique = Array.from(new Set(
    rawItems
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));

  if (!unique.length) {
    return { ok: false, error: 'addresses query parameter is required' };
  }

  if (unique.length > maxItems) {
    return { ok: false, error: `addresses must contain at most ${maxItems} items` };
  }

  const invalid = unique.find((item) => !isValidAddress(item));
  if (invalid) {
    return { ok: false, error: `Invalid token address: ${invalid}` };
  }

  return { ok: true, value: unique };
}

function parseOptionalAddressQuery(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: undefined };
  }

  const address = String(value).trim();
  if (!isValidAddress(address)) {
    return { ok: false, error: 'Invalid token address' };
  }

  return { ok: true, value: address };
}

function parseTokenRiskLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!tokenRiskReview.VALID_LABELS.has(normalized)) {
    return null;
  }
  return normalized;
}

function buildTokenRiskCandidateResponse(candidates, options) {
  return {
    options: {
      scanLimit: options.scanLimit,
      resultLimit: options.resultLimit,
    },
    count: candidates.length,
    candidates: candidates.map((candidate) => ({
      address: candidate.address,
      score: candidate.score ?? null,
      reasonCodes: Array.isArray(candidate.reasonCodes) ? candidate.reasonCodes : [],
      priority: candidate.priority || 'dormant',
      ageHours: candidate.ageHours ?? null,
      volToMcapRatio: candidate.volToMcapRatio ?? null,
      lastEnrichedAt: candidate.lastEnrichedAt || null,
      lastAttemptedAt: candidate.lastAttemptedAt || null,
      marketCap: candidate.marketCap ?? null,
      volume24h: candidate.volume24h ?? null,
      manualLabel: candidate.manualLabel || null,
    })),
  };
}

function buildAdminMeteoraMetric(summaryRow) {
  const hasPool = summaryRow?.hasPool === true && (Number(summaryRow?.currentTvl) || 0) > 0;
  return {
    noPool: !hasPool,
    poolCount: hasPool ? (Number(summaryRow?.poolCount) || 0) : 0,
    tvl: hasPool ? (Number(summaryRow?.currentTvl) || 0) : null,
  };
}

function buildTokenJunkAssessmentResponse(rows, meteoraRows) {
  const meteoraByAddress = new Map((meteoraRows || []).map((row) => [row.tokenAddress, row]));

  return rows.map((row) => {
    const meteora = buildAdminMeteoraMetric(meteoraByAddress.get(row.address) || null);
    return {
      address: row.address,
      symbol: row.symbol || null,
      name: row.name || null,
      effectiveRiskLabel: buildEffectiveRiskLabel(row),
      blockStatus: buildBlockStatusSummary(row),
      riskReview: buildRiskReviewSummary(row),
      manualLabel: row.risk_review_label || null,
      assessment: classifyTokenJunk({
        ...row,
        meteora,
      }),
      meteora,
    };
  });
}

function parseAccessDays(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : null;
}

function parseAccessSource(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'admin';
  }
  const normalized = String(value).trim().toLowerCase();
  return userAccess.VALID_SOURCES.has(normalized) ? normalized : null;
}

function normalizeReviewAlertResolution(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['dismiss', 'block', 'mark_valid', 'mark_weak'].includes(normalized) ? normalized : null;
}

function normalizeReviewNotes(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function resolveReviewLabelForResolution(resolution) {
  if (resolution === 'mark_valid') return 'valid';
  if (resolution === 'mark_weak') return 'valid_but_weak';
  return null;
}

async function applyReviewAlertResolution(alert, resolution, userId, notes) {
  if (resolution === 'block') {
    const label = String(alert.label || alert.alertKind || 'admin-review-block').slice(0, 128);
    await adminBlockedToken.add({
      address: alert.tokenAddress,
      label,
      createdBy: userId,
    });
    await tokenCatalog.upsertToken({
      address: alert.tokenAddress,
      chain: 'solana',
      source: 'admin-blocked',
      symbol: alert.assessment?.symbol || alert.tokenAddress.slice(0, 8),
      isActiveMonitorCandidate: false,
    });
    await tokenCatalog.applyEvaluationResult(alert.tokenAddress, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
    });
    await tokenRiskReview.removeAutoReview(alert.tokenAddress);
    return;
  }

  const reviewLabel = resolveReviewLabelForResolution(resolution);
  if (reviewLabel) {
    await tokenRiskReview.upsertReview({
      tokenAddress: alert.tokenAddress,
      label: reviewLabel,
      source: 'manual',
      notes,
      createdBy: userId,
      updatedBy: userId,
    });
  }
}

// All admin routes require authentication + admin role
router.use(authenticate);
router.use(requireAdmin);
router.use(requireTrustedOrigin);

router.get('/token-review-alerts', async (req, res) => {
  const limit = parseLogsLimit(req.query?.limit);
  if (limit == null) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }

  const address = parseOptionalAddressQuery(req.query?.address);
  if (!address.ok) {
    return res.status(400).json({ error: address.error });
  }

  const status = String(req.query?.status || 'open').trim().toLowerCase();
  if (!['open', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'status must be open or resolved' });
  }

  try {
    const alerts = await adminTokenReviewAlert.listRecent({
      status,
      address: address.value,
      limit,
    });
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    console.error('Admin token review alerts error:', err.message);
    res.status(500).json({ error: 'Failed to load token review alerts' });
  }
});

router.post('/token-review-alerts/:id/resolve', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid alert id' });
  }

  const resolution = normalizeReviewAlertResolution(req.body?.resolution);
  if (!resolution) {
    return res.status(400).json({ error: 'resolution must be dismiss, block, mark_valid, or mark_weak' });
  }

  const notes = normalizeReviewNotes(req.body?.notes);
  try {
    const alert = await adminTokenReviewAlert.getById(id);
    if (!alert || alert.status !== 'open') {
      return res.status(404).json({ error: 'Open token review alert not found' });
    }

    await applyReviewAlertResolution(alert, resolution, req.user.id, notes);
    const resolved = await adminTokenReviewAlert.resolve(id, {
      resolution,
      resolvedBy: req.user.id,
      notes,
    });
    res.json({ message: 'Token review alert resolved', alert: resolved });
  } catch (err) {
    console.error('Admin token review resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve token review alert' });
  }
});

router.get('/monitored-exit-events', async (req, res) => {
  const limit = parseLogsLimit(req.query?.limit);
  if (limit == null) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }

  const address = parseOptionalAddressQuery(req.query?.address);
  if (!address.ok) {
    return res.status(400).json({ error: address.error });
  }

  try {
    const events = await monitoredTokenExitEvent.listRecent({
      limit,
      address: address.value,
      exitReason: req.query?.reason,
    });
    res.json({
      events,
      count: events.length,
    });
  } catch (err) {
    console.error('Admin monitored exit events error:', err.message);
    res.status(500).json({ error: 'Failed to load monitored exit events' });
  }
});

// ============================================================
// USERS
// ============================================================

/**
 * GET /api/admin/users
 * List all users with invite tree info.
 */
router.get('/users', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.username, u.email, u.role, u.is_active,
             u.access_status, u.access_expires_at, u.access_source, u.access_updated_at,
             u.invited_by, inv.username as invited_by_username,
             u.invite_code, u.created_at, u.last_login
      FROM users u
      LEFT JOIN users inv ON u.invited_by = inv.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: rows, total: rows.length });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/users/online
 * List currently online users (active sessions).
 */
router.get('/users/online', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (u.id)
             u.id, u.username, u.role, s.ip_address, s.user_agent,
             s.created_at as session_started, s.expires_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.expires_at > NOW() AND u.is_active = true
      ORDER BY u.id, s.created_at DESC
    `);
    res.json({ online: rows, count: rows.length });
  } catch (err) {
    console.error('Admin online users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/token-risk-enrichment/runs', async (req, res) => {
  const scanLimit = parseOptionalIntegerField(req.body?.scanLimit, 'scanLimit', { min: 1, max: 5000 });
  if (!scanLimit.ok) return res.status(400).json({ error: scanLimit.error });

  const batchLimit = parseOptionalIntegerField(req.body?.batchLimit, 'batchLimit', { min: 1, max: 25 });
  if (!batchLimit.ok) return res.status(400).json({ error: batchLimit.error });

  try {
    const result = await tokenRiskEnrichmentWorker.runOnce({
      scanLimit: scanLimit.value,
      batchLimit: batchLimit.value,
    }, {
      triggeredBy: 'admin',
    });

    res.status(201).json(result);
  } catch (err) {
    if (err.message === 'Token risk enrichment worker already has an active run') {
      return res.status(409).json({ error: err.message });
    }

    console.error('Admin token risk enrichment run error:', err.message);
    res.status(500).json({ error: 'Failed to run token risk enrichment' });
  }
});

router.get('/token-risk-candidates', async (req, res) => {
  const scanLimit = parseOptionalIntegerField(req.query?.scanLimit, 'scanLimit', { min: 1, max: 5000 });
  if (!scanLimit.ok) return res.status(400).json({ error: scanLimit.error });

  const resultLimit = parseOptionalIntegerField(req.query?.resultLimit, 'resultLimit', { min: 1, max: 200 });
  if (!resultLimit.ok) return res.status(400).json({ error: resultLimit.error });

  try {
    const options = {
      scanLimit: scanLimit.value,
      resultLimit: resultLimit.value,
    };
    const candidates = await tokenRiskCandidateSelector.listCandidates(options);
    res.json(buildTokenRiskCandidateResponse(candidates, {
      scanLimit: options.scanLimit ?? 250,
      resultLimit: options.resultLimit ?? 50,
    }));
  } catch (err) {
    console.error('Admin token risk candidates error:', err.message);
    res.status(500).json({ error: 'Failed to load token risk candidates' });
  }
});

router.get('/token-junk-assessments', async (req, res) => {
  const parsed = parseAddressListQuery(req.query?.addresses, { maxItems: 100 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const [rows, meteoraRows] = await Promise.all([
      tokenCatalog.listDashboardMetadataByAddresses(parsed.value),
      tokenMeteoraState.listSummaryByAddresses(parsed.value),
    ]);

    const assessments = buildTokenJunkAssessmentResponse(rows, meteoraRows);
    res.json({
      assessments,
      count: assessments.length,
    });
  } catch (err) {
    console.error('Admin token junk assessments error:', err.message);
    res.status(500).json({ error: 'Failed to load token junk assessments' });
  }
});

router.get('/token-risk-enrichment', async (req, res) => {
  const parsed = parseAddressListQuery(req.query?.addresses, { maxItems: 100 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const enrichments = await tokenRiskEnrichment.listByAddresses(parsed.value);
    res.json({
      enrichments,
      count: enrichments.length,
    });
  } catch (err) {
    console.error('Admin token risk enrichment list error:', err.message);
    res.status(500).json({ error: 'Failed to load token risk enrichment' });
  }
});

router.post('/token-risk-enrichment/addresses', async (req, res) => {
  const parsed = parseAddressListQuery(req.body?.addresses, { maxItems: 25 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const result = await tokenRiskEnrichmentWorker.runAddressesOnce(parsed.value, {
      triggeredBy: 'admin',
    });

    res.status(201).json(result);
  } catch (err) {
    if (err.message === 'Token risk enrichment worker already has an active run') {
      return res.status(409).json({ error: err.message });
    }

    console.error('Admin token risk enrichment addresses run error:', err.message);
    res.status(500).json({ error: 'Failed to run token risk enrichment for addresses' });
  }
});

router.get('/token-risk-labels', async (req, res) => {
  const parsed = parseAddressListQuery(req.query?.addresses, { maxItems: 100 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const reviews = await tokenRiskReview.listByAddresses(parsed.value);
    res.json({
      reviews,
      count: reviews.length,
    });
  } catch (err) {
    console.error('Admin token risk labels list error:', err.message);
    res.status(500).json({ error: 'Failed to load token risk labels' });
  }
});

router.post('/token-risk-labels', async (req, res) => {
  const address = String(req.body?.address || '').trim();
  const label = parseTokenRiskLabel(req.body?.label);
  const notes = typeof req.body?.notes === 'string'
    ? req.body.notes.trim()
    : '';

  if (!isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid token address' });
  }
  if (!label) {
    return res.status(400).json({ error: 'Invalid token risk label' });
  }

  try {
    const review = await tokenRiskReview.upsertReview({
      tokenAddress: address,
      label,
      notes,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });

    res.status(201).json({
      message: 'Token risk label saved',
      review,
    });
  } catch (err) {
    console.error('Admin token risk label save error:', err.message);
    res.status(500).json({ error: 'Failed to save token risk label' });
  }
});

router.delete('/token-risk-labels/:address', async (req, res) => {
  const address = String(req.params.address || '').trim();
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid token address' });
  }

  try {
    const removed = await tokenRiskReview.remove(address);
    if (!removed) {
      return res.status(404).json({ error: 'Token risk label not found' });
    }

    res.json({
      message: 'Token risk label removed',
      address,
    });
  } catch (err) {
    console.error('Admin token risk label remove error:', err.message);
    res.status(500).json({ error: 'Failed to remove token risk label' });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Update user: activate/deactivate, change role.
 * Body: { is_active?, role? }
 * Cannot modify own account or other admins (unless you're the only admin).
 */
router.patch('/users/:id', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Prevent self-modification
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot modify your own account via admin panel' });
    }

    // Get target user
    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent modifying other admins
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot modify another admin' });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    // Handle is_active
    if (typeof req.body.is_active === 'boolean') {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(req.body.is_active);
    }

    // Handle role change
    if (req.body.role && ['user', 'admin'].includes(req.body.role)) {
      updates.push(`role = $${paramIndex++}`);
      values.push(req.body.role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update. Use is_active (bool) or role (user/admin).' });
    }

    values.push(targetId);
    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, username, email, role, is_active`,
      values
    );

    // If user was deactivated, revoke all their sessions
    if (req.body.is_active === false) {
      const revokedCount = await Session.revokeAllForUser(targetId);
      socketHub.revokeUserSockets(targetId, 'admin_deactivated');
      return res.json({
        message: `User ${rows[0].username} deactivated, ${revokedCount} session(s) revoked`,
        user: rows[0],
      });
    }

    res.json({ message: `User ${rows[0].username} updated`, user: rows[0] });
  } catch (err) {
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/users/:id/sessions
 * Force-logout a user by revoking all their sessions.
 */
router.delete('/users/:id/sessions', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const count = await Session.revokeAllForUser(targetId);
    socketHub.revokeUserSockets(targetId, 'admin_revoked');
    res.json({ message: `Revoked ${count} session(s) for ${target.username}` });
  } catch (err) {
    console.error('Admin revoke sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/access/grant', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const days = parseAccessDays(req.body?.days);
    if (!days) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 3650' });
    }

    const source = parseAccessSource(req.body?.source);
    if (!source) {
      return res.status(400).json({ error: 'source must be one of: manual, payment, admin, promo' });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const access = await userAccess.grantForUser(targetId, { days, source });
    res.json({
      message: `Granted ${days} day(s) of access to ${target.username}`,
      access,
    });
  } catch (err) {
    console.error('Admin grant access error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/access/extend', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const days = parseAccessDays(req.body?.days);
    if (!days) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 3650' });
    }

    const source = parseAccessSource(req.body?.source);
    if (!source) {
      return res.status(400).json({ error: 'source must be one of: manual, payment, admin, promo' });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const access = await userAccess.extendForUser(targetId, { days, source });
    res.json({
      message: `Extended ${target.username} by ${days} day(s)`,
      access,
    });
  } catch (err) {
    console.error('Admin extend access error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/access/revoke', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const source = parseAccessSource(req.body?.source);
    if (!source) {
      return res.status(400).json({ error: 'source must be one of: manual, payment, admin, promo' });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const access = await userAccess.revokeForUser(targetId, { source });
    const revokedCount = await Session.revokeAllForUser(targetId);
    socketHub.revokeUserSockets(targetId, 'access_revoked');
    res.json({
      message: `Revoked access for ${target.username} and removed ${revokedCount} session(s)`,
      access,
    });
  } catch (err) {
    console.error('Admin revoke access error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// INVITES
// ============================================================

/**
 * GET /api/admin/invites
 * List all invites with creator info.
 */
router.get('/invites', async (req, res) => {
  try {
    const invites = await Invite.listAll();
    res.json({ invites, total: invites.length });
  } catch (err) {
    console.error('Admin list invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/invites
 * Create invite with custom params.
 * Body: { maxUses?, expiryHours? }
 */
router.post('/invites', async (req, res) => {
  try {
    const parsed = parseInviteCreateOptions(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    const invite = await Invite.create(req.user.id, parsed.opts);
    res.status(201).json({ invite });
  } catch (err) {
    console.error('Admin create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/invites/:id
 * Revoke any invite by ID.
 */
router.delete('/invites/:id', async (req, res) => {
  try {
    const inviteId = parsePositiveId(req.params.id);
    if (!inviteId) {
      return res.status(400).json({ error: 'Invalid invite ID' });
    }

    const { rows } = await query(
      'UPDATE invites SET is_revoked = true WHERE id = $1 RETURNING id, code, is_revoked',
      [inviteId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ message: 'Invite revoked', invite: rows[0] });
  } catch (err) {
    console.error('Admin revoke invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// LOGS
// ============================================================

/**
 * GET /api/admin/logs
 * Recent login attempts. Query: ?limit=50&email=&success=
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = parseLogsLimit(req.query.limit);
    if (limit == null) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const parsedSuccess = parseOptionalBooleanQuery(req.query.success);
    if (!parsedSuccess.ok) {
      return res.status(400).json({ error: parsedSuccess.error });
    }

    let sql = `SELECT id, email, ip_address, success, user_agent, created_at
               FROM login_attempts`;
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (req.query.email) {
      conditions.push(`email = LOWER($${paramIndex++})`);
      values.push(String(req.query.email).trim().toLowerCase().slice(0, 254));
    }
    if (parsedSuccess.value !== undefined) {
      conditions.push(`success = $${paramIndex++}`);
      values.push(parsedSuccess.value);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    values.push(limit);

    const { rows } = await query(sql, values);
    res.json({ logs: rows, total: rows.length });
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// STATS
// ============================================================

/**
 * GET /api/admin/stats
 * Dashboard summary stats.
 */
router.get('/stats', async (req, res) => {
  try {
    const [users, sessions, invites, attempts] = await Promise.all([
      query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM users'),
      query('SELECT COUNT(*) as total FROM sessions WHERE expires_at > NOW()'),
      query(`SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE NOT is_revoked AND expires_at > NOW() AND use_count < max_uses) as available
             FROM invites`),
      query(`SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE success = false AND created_at > NOW() - INTERVAL '1 hour') as failed_1h
             FROM login_attempts
             WHERE created_at > NOW() - INTERVAL '24 hours'`),
    ]);

    res.json({
      users: {
        total: parseInt(users.rows[0].total),
        active: parseInt(users.rows[0].active),
      },
      sessions: {
        active: parseInt(sessions.rows[0].total),
      },
      invites: {
        total: parseInt(invites.rows[0].total),
        available: parseInt(invites.rows[0].available),
      },
      loginAttempts24h: {
        total: parseInt(attempts.rows[0].total),
        failedLastHour: parseInt(attempts.rows[0].failed_1h),
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
