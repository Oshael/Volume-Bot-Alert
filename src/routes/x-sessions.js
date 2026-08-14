const express = require('express');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const xSession = require('../models/x-session');

const router = express.Router();

// Admin-only, trusted-origin only. This endpoint ingests a live session's
// cookies (auth_token, ct0) captured by the operator's browser extension, so it
// is the most sensitive write in the X subsystem: it must never be reachable
// anonymously or cross-origin.
router.use(authenticate);
router.use(requireAdmin);
router.use(requireTrustedOrigin);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * POST /api/admin/x-sessions
 * Re-seed a scraping session from freshly captured cookies. Keyed by label:
 * re-seeding an existing account overwrites its tokens, re-enables it and clears
 * any quarantine. Secrets are write-only -- never logged, never echoed back.
 */
router.post('/', async (req, res) => {
  const { label, authToken, ct0, proxyUrl } = req.body || {};
  if (!nonEmpty(label) || !nonEmpty(authToken) || !nonEmpty(ct0)) {
    return res.status(400).json({ error: 'label, authToken and ct0 are required' });
  }
  if (proxyUrl != null && typeof proxyUrl !== 'string') {
    return res.status(400).json({ error: 'proxyUrl must be a string' });
  }

  try {
    const result = await xSession.upsertSession({
      label: label.trim(),
      authToken: authToken.trim(),
      ct0: ct0.trim(),
      proxyUrl: nonEmpty(proxyUrl) ? proxyUrl.trim() : null,
    });
    return res.status(result.created ? 201 : 200).json({ id: result.id, created: result.created });
  } catch (err) {
    console.error(`[x-sessions] re-seed failed: ${err.message}`);
    return res.status(500).json({ error: 'Failed to persist session' });
  }
});

module.exports = router;
