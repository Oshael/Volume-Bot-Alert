const express = require('express');
const { authenticate } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/rate-limit');
const globalSearchReader = require('../services/global-search-reader');

const router = express.Router();

router.use(authenticate);

router.get('/global', dashboardLimiter, async (req, res) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  try {
    const payload = await globalSearchReader.search({
      q: req.query?.q,
      kinds: req.query?.kinds,
      limit: req.query?.limit,
      signal: controller.signal,
    });
    return res.json(payload);
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ error: error.message });
    console.error('GET /search/global error:', error.message);
    return res.status(error.status === 504 ? 504 : 500).json({ error: 'Failed to search workspace' });
  } finally {
    req.off('aborted', abort);
  }
});

module.exports = router;
