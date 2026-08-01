const catalogMarketHistory = require('./catalog-market-history');
const {
  renderTelegramAlertSparkline,
} = require('./telegram-alert-sparkline-renderer');
const {
  isSparklineGranularityMinutes,
} = require('../utils/market-bucket-granularities');
const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
} = require('../utils/telegram-locale');

const MAX_TEXT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;

function positiveInteger(value, field) {
  try {
    const parsed = BigInt(String(value ?? '').trim());
    if (parsed > 0n) return parsed.toString();
  } catch (_) {}
  throw new TypeError(`${field} must be a positive integer`);
}

function boundedText(value, field, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function normalizeTimestamp(value, field) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function requiredObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function normalizeDelivery(delivery) {
  requiredObject(delivery, 'Telegram alert delivery');
  const eventPayload = delivery?.eventPayload;
  const payload = eventPayload?.payload;
  requiredObject(eventPayload, 'Telegram alert event payload');
  requiredObject(payload, 'Telegram alert event payload body');
  const chain = String(delivery.chain || '').trim();
  if (!['solana', 'robinhood'].includes(chain)) {
    throw new TypeError(`Unsupported Telegram alert delivery chain: ${chain || 'missing'}`);
  }
  return { delivery, eventPayload, payload, chain };
}

function normalizeSparklineOptions(input) {
  if (typeof input.sparklineEnabled !== 'boolean') {
    throw new TypeError('Telegram sparklineEnabled must be boolean');
  }
  const sparklineHours = Number(input.sparklineHours);
  const sparklineGranularityMinutes = Number(input.sparklineGranularityMinutes);
  if (input.sparklineEnabled
    && (!Number.isSafeInteger(sparklineHours) || sparklineHours < 1 || sparklineHours > 720)) {
    throw new TypeError('Telegram sparklineHours must be an integer between 1 and 720');
  }
  if (input.sparklineEnabled && !isSparklineGranularityMinutes(sparklineGranularityMinutes)) {
    throw new TypeError('Telegram sparklineGranularityMinutes is unsupported');
  }
  return {
    enabled: input.sparklineEnabled,
    hours: input.sparklineEnabled ? sparklineHours : null,
    granularityMinutes: input.sparklineEnabled ? sparklineGranularityMinutes : null,
  };
}

function normalizeInput(input = {}) {
  const { delivery, payload, chain } = normalizeDelivery(input.delivery);
  const sparkline = normalizeSparklineOptions(input);
  return {
    chatId: positiveInteger(input.chatId, 'Telegram chat id'),
    languageCode: normalizeTelegramLanguageCode(input.languageCode)
      || DEFAULT_LANGUAGE_CODE,
    delivery,
    chain,
    tokenAddress: boundedText(delivery.tokenAddress, 'Telegram token address', 128),
    triggeredAt: normalizeTimestamp(delivery.triggeredAt, 'Telegram delivery triggeredAt'),
    sparklineEnabled: sparkline.enabled,
    sparklineHours: sparkline.hours,
    sparklineGranularityMinutes: sparkline.granularityMinutes,
    symbol: String(payload.symbol || '').trim().slice(0, 24)
      || String(delivery.tokenAddress).slice(0, 8),
  };
}

function normalizeFormattedAlert(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram alert formatter must return an object');
  }
  const text = boundedText(value.text, 'Telegram alert text', MAX_TEXT_LENGTH);
  const caption = value.caption == null
    ? boundedText(text, 'Telegram alert caption', MAX_CAPTION_LENGTH)
    : boundedText(value.caption, 'Telegram alert caption', MAX_CAPTION_LENGTH);
  return {
    text,
    caption,
    parseMode: value.parseMode || null,
    replyMarkup: value.replyMarkup || null,
  };
}

function messageId(result) {
  return positiveInteger(result?.message_id, 'Telegram result message id');
}

function latestFileId(result) {
  const photo = Array.isArray(result?.photo) ? result.photo : [];
  const fileId = String(photo.at(-1)?.file_id || '').trim();
  return fileId || null;
}

function buildRequest(base, formatted) {
  return {
    chat_id: base.chatId,
    parse_mode: formatted.parseMode || undefined,
    reply_markup: formatted.replyMarkup || undefined,
  };
}

function createTelegramAlertDeliverySender(options = {}) {
  const history = options.marketHistory || catalogMarketHistory;
  const renderer = options.sparklineRenderer || { render: renderTelegramAlertSparkline };
  const bot = options.bot;
  const formatAlert = options.formatAlert;
  const onSparklineFallback = typeof options.onSparklineFallback === 'function'
    ? options.onSparklineFallback
    : () => {};
  if (typeof history?.getSparklineBatch !== 'function') {
    throw new TypeError('Telegram market history port is required');
  }
  if (typeof renderer?.render !== 'function') {
    throw new TypeError('Telegram sparkline renderer port is required');
  }
  if (typeof bot?.sendPhoto !== 'function' || typeof bot?.sendMessage !== 'function') {
    throw new TypeError('Telegram bot delivery port is required');
  }
  if (typeof formatAlert !== 'function') {
    throw new TypeError('Telegram alert formatter port is required');
  }

  async function notifyFallback(input) {
    try {
      await onSparklineFallback(input);
    } catch (_) {}
  }

  async function preparePhoto(value) {
    if (!value.sparklineEnabled) return { state: 'disabled', photo: null };
    try {
      const historyPayload = await history.getSparklineBatch({
        identities: [{ chain: value.chain, address: value.tokenAddress }],
        hours: value.sparklineHours,
        points: 180,
        granularityMinutes: value.sparklineGranularityMinutes,
        endAt: value.triggeredAt,
      });
      const rendered = await renderer.render({
        chain: value.chain,
        symbol: value.symbol,
        hours: value.sparklineHours,
        triggeredAt: value.triggeredAt,
        series: historyPayload?.items?.[0]?.series || [],
      });
      if (rendered.kind === 'image') return { state: 'ready', photo: rendered.photo };
      await notifyFallback({ delivery: value.delivery, reason: rendered.reason });
      return { state: rendered.reason || 'unavailable', photo: null };
    } catch (error) {
      await notifyFallback({ delivery: value.delivery, reason: 'sparkline_error', error });
      return { state: 'sparkline_error', photo: null };
    }
  }

  async function send(input = {}) {
    const value = normalizeInput(input);
    const formatted = normalizeFormattedAlert(await formatAlert(value.delivery, {
      languageCode: value.languageCode,
    }));
    const request = buildRequest(value, formatted);
    const prepared = await preparePhoto(value);
    if (prepared.photo) {
      const result = await bot.sendPhoto({
        ...request,
        photo: prepared.photo,
        caption: formatted.caption,
      });
      return Object.freeze({
        method: 'sendPhoto',
        messageId: messageId(result),
        fileId: latestFileId(result),
        sparkline: 'sent',
      });
    }

    const result = await bot.sendMessage({ ...request, text: formatted.text });
    return Object.freeze({
      method: 'sendMessage',
      messageId: messageId(result),
      fileId: null,
      sparkline: prepared.state,
    });
  }

  return Object.freeze({ send });
}

module.exports = {
  createTelegramAlertDeliverySender,
};
