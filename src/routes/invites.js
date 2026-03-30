const express = require('express');
const Invite = require('../models/invite');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');

const router = express.Router();

function parseInviteCreateOptions(body = {}) {
  const opts = {};
  const hasMaxUses = body.maxUses !== undefined && body.maxUses !== null && String(body.maxUses).trim() !== '';
  const hasExpiryHours = body.expiryHours !== undefined && body.expiryHours !== null && String(body.expiryHours).trim() !== '';
  const hasGrantAccessDays = body.grantAccessDays !== undefined && body.grantAccessDays !== null && String(body.grantAccessDays).trim() !== '';

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

  if (hasGrantAccessDays) {
    const parsed = Number.parseInt(body.grantAccessDays, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: 'grantAccessDays must be an integer' };
    }
    opts.grantAccessDays = parsed;
  }

  return { ok: true, opts };
}

function parseInviteId(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * POST /api/invites
 * Create a new invite. Admins can set custom maxUses/expiryHours.
 * Regular users create with defaults.
 * Body (optional): { maxUses, expiryHours }
 */
router.post('/', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const opts = {};
    // Only admins can customize invite parameters
    if (req.user.role === 'admin') {
      const parsed = parseInviteCreateOptions(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }
      Object.assign(opts, parsed.opts);
    }

    const invite = await Invite.create(req.user.id, opts);
    res.status(201).json({ invite });
  } catch (err) {
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/invites
 * List my invites.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const invites = await Invite.listByUser(req.user.id);
    res.json({ invites });
  } catch (err) {
    console.error('List invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/invites/all
 * List all invites (admin only).
 */
router.get('/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const invites = await Invite.listAll();
    res.json({ invites });
  } catch (err) {
    console.error('List all invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/invites/validate/:code
 * Check if an invite code is valid (public — for registration form).
 */
router.get('/validate/:code', async (req, res) => {
  try {
    const result = await Invite.validate(req.params.code);
    res.json({ valid: result.valid, reason: result.reason || undefined });
  } catch (err) {
    console.error('Validate invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/invites/:id
 * Revoke an invite. Users can revoke their own, admins can revoke any.
 */
router.delete('/:id', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const inviteId = parseInviteId(req.params.id);
    if (!inviteId) {
      return res.status(400).json({ error: 'Invalid invite ID' });
    }

    let result;
    if (req.user.role === 'admin') {
      // Admin can revoke any invite by code or ID
      const { query } = require('../models/db');
      const { rows } = await query(
        'UPDATE invites SET is_revoked = true WHERE id = $1 RETURNING id, code, is_revoked',
        [inviteId]
      );
      result = rows[0];
    } else {
      result = await Invite.revoke(inviteId, req.user.id);
    }

    if (!result) {
      return res.status(404).json({ error: 'Invite not found or not yours to revoke' });
    }
    res.json({ message: 'Invite revoked', invite: result });
  } catch (err) {
    console.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
