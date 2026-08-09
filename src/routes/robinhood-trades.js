const express = require('express');

const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { rejectHiddenRobinhoodRequests } = require('../middleware/token-chain-visibility');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  createRobinhoodWalletSwapReadRepository,
} = require('../models/robinhood-wallet-swap-read');

const repository = createRobinhoodWalletSwapReadRepository();

// The feed is Robinhood-scoped; gate hidden-robinhood requests exactly like the
// other Robinhood-visible read routes do.
router.use(authenticate);
router.use(rejectHiddenRobinhoodRequests);

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

module.exports = router;
