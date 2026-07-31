const updateModel = require('../models/telegram-update');
const MAX_BIGINT_ID = 9223372036854775807n;

class TelegramUpdateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramUpdateValidationError';
  }
}

function normalizeUpdateId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TelegramUpdateValidationError('Telegram update_id must be a non-negative integer');
  }
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  if (!/^\d+$/.test(normalized)) {
    throw new TelegramUpdateValidationError('Telegram update_id must be a non-negative integer');
  }
  const parsed = BigInt(normalized);
  if (parsed > MAX_BIGINT_ID) {
    throw new TelegramUpdateValidationError('Telegram update_id is outside the supported range');
  }
  return parsed.toString();
}

function errorCode(error) {
  const candidate = String(error?.code || error?.name || 'update_processing_failed')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (candidate || 'update_processing_failed').slice(0, 120);
}

function createTelegramUpdateProcessor(options = {}) {
  const updates = options.updateModel || updateModel;
  const handleUpdate = options.handleUpdate;
  if (typeof handleUpdate !== 'function') {
    throw new Error('Telegram update handler is required');
  }

  async function process(update) {
    const updateId = normalizeUpdateId(update?.update_id);
    const received = await updates.receive(updateId);
    if (!received) return { status: 'duplicate', updateId };

    try {
      await handleUpdate(update);
      await updates.markProcessed(updateId);
      return { status: 'processed', updateId };
    } catch (error) {
      await updates.markFailed(updateId, errorCode(error)).catch(() => {});
      throw error;
    }
  }

  return { process };
}

module.exports = {
  TelegramUpdateValidationError,
  createTelegramUpdateProcessor,
  errorCode,
  normalizeUpdateId,
};
