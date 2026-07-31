const express = require('express');
const {
  authenticate,
  requireTrustedOrigin,
} = require('../middleware/auth');
const { createTelegramLinkService, TelegramLinkError } = require('../services/telegram-link-service');

function createTelegramRouter(options = {}) {
  const router = express.Router();
  const auth = options.authenticate || authenticate;
  const trustedOrigin = options.requireTrustedOrigin || requireTrustedOrigin;
  const service = options.service || createTelegramLinkService();

  router.get('/status', auth, async (req, res) => {
    try {
      return res.json(await service.getStatus(req.user.id));
    } catch (error) {
      console.error('Telegram status error:', error.message);
      return res.status(500).json({ error: 'Unable to load Telegram status' });
    }
  });

  router.post('/link', auth, trustedOrigin, async (req, res) => {
    try {
      return res.status(201).json(await service.createLink(req.user.id));
    } catch (error) {
      if (error instanceof TelegramLinkError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('Telegram link creation error:', error.message);
      return res.status(500).json({ error: 'Unable to create Telegram link' });
    }
  });

  router.post('/disconnect', auth, trustedOrigin, async (req, res) => {
    try {
      return res.json(await service.disconnect(req.user.id));
    } catch (error) {
      console.error('Telegram disconnect error:', error.message);
      return res.status(500).json({ error: 'Unable to disconnect Telegram' });
    }
  });

  return router;
}

const router = createTelegramRouter();
router.createTelegramRouter = createTelegramRouter;

module.exports = router;
