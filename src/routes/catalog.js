const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const { isValidAddress } = require('../models/user-token');

router.use(authenticate);

router.get('/history/:address', async (req, res) => {
  try {
    const address = String(req.params?.address || '').trim();
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const snapshots = await tokenMarketSnapshot.listHistoryByAddress(address, {
      limit: req.query?.limit,
      hours: req.query?.hours,
      days: req.query?.days,
    });

    res.json({
      address,
      count: snapshots.length,
      snapshots,
    });
  } catch (err) {
    console.error('GET /catalog/history/:address error:', err.message);
    res.status(500).json({ error: 'Failed to load token history' });
  }
});

router.post('/migrated', async (req, res) => {
  try {
    const address = String(req.body?.address || req.body?.mint || '').trim();
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const token = await tokenCatalog.upsertToken({
      address,
      chain: 'solana',
      source: 'pumpfun-migrated',
      symbol: req.body?.symbol || null,
      name: req.body?.name || null,
      mcap: req.body?.mcap || null,
      price: req.body?.price || null,
      pairAddress: req.body?.pairAddress || null,
      pairUrl: req.body?.pairUrl || null,
      imageUrl: req.body?.imageUrl || null,
      twitterUrl: req.body?.twitterUrl || null,
      isActiveMonitorCandidate: true,
    });

    res.status(201).json({ message: 'Migrated token cataloged', token });
  } catch (err) {
    console.error('POST /catalog/migrated error:', err.message);
    res.status(500).json({ error: 'Failed to catalog migrated token' });
  }
});

module.exports = router;
