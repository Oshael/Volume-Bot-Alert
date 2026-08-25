'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectHiddenRobinhoodRequests } = require('../middleware/token-chain-visibility');
const { createCalloutChainEnrichment } = require('../services/callout-chain-enrichment');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const CLIENT_ERROR_CODES = new Set(['INVALID_ENRICHMENT_LIMIT', 'INVALID_ENRICHMENT_RANGE']);

function createCalloutEnrichmentRouter(options = {}) {
  const router = express.Router();
  const auth = options.authenticate || authenticate;
  const visibility = options.visibility || rejectHiddenRobinhoodRequests;
  const enrichment = options.enrichment || createCalloutChainEnrichment();
  const logger = options.logger || console;

  router.use(auth);
  router.use(visibility);

  router.get('/profile-wallet-buys', async (req, res) => {
    let chainKey;
    let tokenAddress;
    try {
      chainKey = normalizeTokenChain(req.query?.chain);
      tokenAddress = normalizeTokenAddress(chainKey, req.query?.token);
    } catch (_) {
      return res.status(400).json({
        error: 'chain and token must form a valid token identity',
        code: 'INVALID_TOKEN_IDENTITY',
      });
    }

    try {
      const result = await enrichment.listProfileWalletBuys({
        chainKey, tokenAddress,
        from: req.query?.from, to: req.query?.to, limit: req.query?.limit,
      });
      return res.json(result);
    } catch (error) {
      if (CLIENT_ERROR_CODES.has(error?.code)) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      logger.error?.('GET /callouts/profile-wallet-buys failed', {
        code: String(error?.code || 'CALLOUT_ENRICHMENT_READ_FAILED'), chainKey,
      });
      return res.status(500).json({
        error: 'Failed to load profile wallet activity',
        code: 'CALLOUT_ENRICHMENT_READ_FAILED',
      });
    }
  });

  return router;
}

const router = createCalloutEnrichmentRouter();
router.createCalloutEnrichmentRouter = createCalloutEnrichmentRouter;

module.exports = router;
