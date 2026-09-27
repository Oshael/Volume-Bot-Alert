const express = require('express');

const { authenticate } = require('../middleware/auth');
const { rejectHiddenRobinhoodRequests } = require('../middleware/token-chain-visibility');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  createRobinhoodWalletSwapReadRepository,
} = require('../models/robinhood-wallet-swap-read');
const {
  createRobinhoodWalletTradeReadRepository,
} = require('../models/robinhood-wallet-trade-read');

function createRobinhoodTradesRouter(options = {}) {
  const router = express.Router();
  const repository = options.repository || createRobinhoodWalletSwapReadRepository();
  const walletRepository = options.walletRepository || createRobinhoodWalletTradeReadRepository();

  router.use(options.authenticate || authenticate);
  router.use(options.visibility || rejectHiddenRobinhoodRequests);

  router.get('/trades', async (req, res) => {
    let tokenAddress;
    try {
      tokenAddress = normalizeTokenAddress('robinhood', req.query?.token);
    } catch (_) {
      return res.status(400).json({ error: 'token must be a valid Robinhood token address' });
    }

    try {
      const page = await repository.getRecentTrades({
        tokenAddress,
        cursor: req.query?.cursor,
        limit: req.query?.limit,
        scope: req.query?.scope,
      });
      return res.json(page);
    } catch (err) {
      if (err.code === 'INVALID_CURSOR' || err.code === 'INVALID_LIMIT' || err.code === 'INVALID_SCOPE') {
        return res.status(400).json({ error: err.message });
      }
      console.error('GET /robinhood/trades error:', err.message);
      return res.status(500).json({ error: 'Failed to load token trades' });
    }
  });

  router.get('/wallet-trades', async (req, res) => {
    let walletAddress;
    try {
      walletAddress = normalizeTokenAddress('robinhood', req.query?.wallet);
    } catch (_) {
      return res.status(400).json({ error: 'wallet must be a valid Robinhood wallet address' });
    }
    try {
      const page = await walletRepository.getWalletTrades({
        walletAddress, side: req.query?.side,
        cursor: req.query?.cursor, limit: req.query?.limit,
      });
      return res.json(page);
    } catch (err) {
      if (['INVALID_CURSOR', 'INVALID_LIMIT', 'INVALID_SIDE'].includes(err.code)) {
        return res.status(400).json({ error: err.message });
      }
      console.error('GET /robinhood/wallet-trades error:', err.message);
      return res.status(500).json({ error: 'Failed to load wallet trades' });
    }
  });

  return router;
}

const router = createRobinhoodTradesRouter();
router.createRobinhoodTradesRouter = createRobinhoodTradesRouter;
module.exports = router;
