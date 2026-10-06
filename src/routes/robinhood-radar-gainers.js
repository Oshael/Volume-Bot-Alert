const express = require('express');
const config = require('../../config');
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { createRobinhoodRouteVisibilityMiddleware } = require('../middleware/token-chain-visibility');
const { createRobinhoodRadarGainersPage } = require('../services/robinhood-radar-gainers-page');

function createRobinhoodRadarGainersRouter(options = {}) {
  const router = express.Router();
  const runtimeConfig = options.config || config;
  const page = options.page || createRobinhoodRadarGainersPage();
  const logger = options.logger || console;
  router.use(options.authenticate || authenticate);
  router.use(options.requireTrustedOrigin || requireTrustedOrigin);
  router.use(createRobinhoodRouteVisibilityMiddleware(runtimeConfig));
  router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (runtimeConfig.robinhoodRadarGainers?.enabled !== true) {
      return res.status(503).json({ code: 'GAINERS_NOT_READY', error: 'Gainers are not enabled' });
    }
    if (Object.keys(req.query).length) {
      return res.status(400).json({ code: 'INVALID_GAINERS_REQUEST', error: 'Query parameters are not accepted' });
    }
    try {
      return res.json(await page.list(req.user.id, req.body));
    } catch (error) {
      if (error.code === 'INVALID_GAINERS_REQUEST') {
        return res.status(400).json({ code: error.code, error: error.message });
      }
      if (['GAINERS_BUSY', 'GAINERS_UNAVAILABLE'].includes(error.code)) {
        res.set('Retry-After', String(error.retryAfterSeconds));
        return res.status(503).json({ code: error.code, error: error.message });
      }
      logger.error?.('POST /robinhood/radar-gainers failed', {
        code: String(error?.code || 'GAINERS_READ_FAILED'),
      });
      res.set('Retry-After', '10');
      return res.status(503).json({ code: 'GAINERS_UNAVAILABLE', error: 'Failed to load gainers' });
    }
  });
  return router;
}

const router = createRobinhoodRadarGainersRouter();
router.createRobinhoodRadarGainersRouter = createRobinhoodRadarGainersRouter;
module.exports = router;
