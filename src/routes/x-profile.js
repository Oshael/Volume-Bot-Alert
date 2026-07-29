const express = require('express');
const { authenticate } = require('../middleware/auth');
const { createXProfileCardService } = require('../services/x-profile-card');

const router = express.Router();
const service = createXProfileCardService();

const STATUS_CODES = {
  invalid: 400,
  not_found: 404,
  unavailable: 503,
};

/**
 * GET /api/x-profile/:handle
 * Cached read-through for the X profile card. Authenticated so the endpoint
 * cannot be used as an anonymous proxy against the upstream service.
 */
router.get('/:handle', authenticate, async (req, res) => {
  const result = await service.get(req.params.handle);

  if (result.status !== 'ok') {
    return res.status(STATUS_CODES[result.status] || 503).json({
      error: result.status === 'invalid' ? 'Invalid X handle' : 'X profile unavailable',
      status: result.status,
    });
  }

  return res.json({
    profile: result.profile,
    cached: result.cached === true,
    stale: result.stale === true,
  });
});

module.exports = router;
module.exports.__private = { service };
