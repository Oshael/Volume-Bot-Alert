'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectHiddenRobinhoodRequests } = require('../middleware/token-chain-visibility');
const { createCalloutEventRead } = require('../models/callout-event-read');
const { createCalloutChainEnrichment } = require('../services/callout-chain-enrichment');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const CLIENT_ERROR_CODES = new Set([
  'INVALID_CALLOUT_CURSOR', 'INVALID_CALLOUT_LIMIT', 'INVALID_CALLOUT_RANGE',
  'INVALID_ENRICHMENT_LIMIT', 'INVALID_ENRICHMENT_RANGE',
]);

function tokenIdentity(query = {}) {
  const chainKey = normalizeTokenChain(query.chain);
  return { chainKey, tokenAddress: normalizeTokenAddress(chainKey, query.token) };
}

function createCalloutEnrichmentRouter(options = {}) {
  const router = express.Router();
  const auth = options.authenticate || authenticate;
  const visibility = options.visibility || rejectHiddenRobinhoodRequests;
  const enrichment = options.enrichment || createCalloutChainEnrichment();
  const eventRead = options.eventRead || createCalloutEventRead();
  const logger = options.logger || console;

  router.use(auth);
  router.use(visibility);

  router.get('/events', async (req, res) => {
    let identity;
    try {
      identity = tokenIdentity(req.query);
    } catch (_) {
      return res.status(400).json({
        error: 'chain and token must form a valid token identity',
        code: 'INVALID_TOKEN_IDENTITY',
      });
    }

    try {
      return res.json(await eventRead.listEvents({
        ...identity,
        from: req.query?.from, to: req.query?.to,
        limit: req.query?.limit, cursor: req.query?.cursor,
      }));
    } catch (error) {
      if (CLIENT_ERROR_CODES.has(error?.code)) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      logger.error?.('GET /callouts/events failed', {
        code: String(error?.code || 'CALLOUT_EVENT_READ_FAILED'),
        chainKey: identity.chainKey,
      });
      return res.status(500).json({
        error: 'Failed to load callout events',
        code: 'CALLOUT_EVENT_READ_FAILED',
      });
    }
  });

  router.get('/profile-wallet-buys', async (req, res) => {
    let identity;
    try {
      identity = tokenIdentity(req.query);
    } catch (_) {
      return res.status(400).json({
        error: 'chain and token must form a valid token identity',
        code: 'INVALID_TOKEN_IDENTITY',
      });
    }

    try {
      const result = await enrichment.listProfileWalletBuys({
        ...identity,
        from: req.query?.from, to: req.query?.to, limit: req.query?.limit,
      });
      return res.json(result);
    } catch (error) {
      if (CLIENT_ERROR_CODES.has(error?.code)) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      logger.error?.('GET /callouts/profile-wallet-buys failed', {
        code: String(error?.code || 'CALLOUT_ENRICHMENT_READ_FAILED'),
        chainKey: identity.chainKey,
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
