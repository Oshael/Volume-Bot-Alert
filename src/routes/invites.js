const express = require('express');
const Invite = require('../models/invite');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/invites
 * Create a new invite. Admins can set custom maxUses/expiryHours.
 * Regular users create with defaults.
 * Body (optional): { maxUses, expiryHours }
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const opts = {};
    // Only admins can customize invite parameters
    if (req.user.role === 'admin') {
      if (req.body.maxUses) opts.maxUses = Math.min(parseInt(req.body.maxUses) || 1, 100);
      if (req.body.expiryHours) opts.expiryHours = Math.min(parseInt(req.body.expiryHours) || 72, 720); // max 30 days
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
router.delete('/:id', authenticate, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      // Admin can revoke any invite by code or ID
      const { query } = require('../models/db');
      const { rows } = await query(
        'UPDATE invites SET is_revoked = true WHERE id = $1 RETURNING id, code, is_revoked',
        [req.params.id]
      );
      result = rows[0];
    } else {
      result = await Invite.revoke(parseInt(req.params.id), req.user.id);
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
