const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectHiddenRobinhoodRoute } = require('../middleware/token-chain-visibility');
const {
  createRobinhoodWalletRankingPage,
} = require('../services/robinhood-wallet-ranking-page');

function createRobinhoodWalletRankingRouter(options = {}) {
  const router = express.Router();
  const page = options.page || createRobinhoodWalletRankingPage();
  const logger = options.logger || console;
  router.use(options.authenticate || authenticate);
  router.use(options.visibility || rejectHiddenRobinhoodRoute);
  router.get('/top-wallets', async (req, res) => {
    try {
      return res.json(await page.list(req.query));
    } catch (failure) {
      if (failure.code === 'INVALID_RANKING_REQUEST') {
        return res.status(400).json({ code: failure.code, error: failure.message });
      }
      if (failure.code === 'STALE_RANKING_CURSOR') {
        return res.status(409).json({ code: failure.code, error: failure.message });
      }
      if (failure.code === 'RANKING_NOT_READY') {
        return res.status(503).json({ code: failure.code, error: failure.message });
      }
      logger.error?.('GET /robinhood/top-wallets failed', {
        code: String(failure?.code || 'RANKING_READ_FAILED'),
      });
      return res.status(500).json({ code: 'RANKING_READ_FAILED',
        error: 'Failed to load wallet ranking' });
    }
  });
  return router;
}

const router = createRobinhoodWalletRankingRouter();
router.createRobinhoodWalletRankingRouter = createRobinhoodWalletRankingRouter;
module.exports = router;
