const crypto = require('node:crypto');
const express = require('express');
const config = require('../../config');
const {
  createTelegramCommandHandler,
} = require('../services/telegram-command-handler');
const {
  TelegramUpdateValidationError,
  createTelegramUpdateProcessor,
} = require('../services/telegram-update-processor');

const TELEGRAM_WEBHOOK_BODY_LIMIT = '64kb';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function digestSecret(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function isValidWebhookSecret(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(digestSecret(provided), digestSecret(expected));
}

function createTelegramWebhookRouter(options = {}) {
  const router = express.Router();
  const settings = options.settings || config.telegram || {};
  const processor = options.processor || null;
  const logger = options.logger || console;
  const jsonParser = express.json({ limit: TELEGRAM_WEBHOOK_BODY_LIMIT });

  router.post(
    '/',
    (req, res, next) => {
      if (!settings.enabled) {
        return res.status(503).json({ error: 'Telegram webhook is disabled' });
      }
      if (!isValidWebhookSecret(req.get(SECRET_HEADER), settings.webhookSecret)) {
        return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
      }
      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Telegram webhook requires application/json' });
      }
      return next();
    },
    jsonParser,
    async (req, res) => {
      if (!processor) {
        return res.status(503).json({ error: 'Telegram webhook processor is unavailable' });
      }
      try {
        await processor.process(req.body);
        return res.json({ ok: true });
      } catch (error) {
        if (error instanceof TelegramUpdateValidationError) {
          return res.status(400).json({ error: error.message });
        }
        logger.error('Telegram webhook processing failed', {
          code: String(error?.code || error?.name || 'unknown'),
        });
        return res.status(500).json({ error: 'Unable to process Telegram update' });
      }
    }
  );

  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Telegram webhook payload is too large' });
    }
    if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Telegram webhook payload is invalid JSON' });
    }
    return next(error);
  });

  return router;
}

const defaultProcessor = config.telegram.enabled
  ? createTelegramUpdateProcessor({
    handleUpdate: createTelegramCommandHandler().handleUpdate,
  })
  : null;
const router = createTelegramWebhookRouter({ processor: defaultProcessor });
router.createTelegramWebhookRouter = createTelegramWebhookRouter;
router.isValidWebhookSecret = isValidWebhookSecret;

module.exports = router;
