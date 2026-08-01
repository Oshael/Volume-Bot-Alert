const { RULE_CONTRACTS } = require('./telegram-alert-rule-contracts');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { createTelegramTranslator } = require('./telegram-i18n');

const RULE_LABELS = Object.freeze({
  'monitored-vol': 'VOLUME 5M',
  'monitored-mcap': 'MARKET CAP 5M',
  'monitored-fdv': 'FDV 5M',
  hvnc: 'HVNC',
  'robinhood-hvnc-v2': 'HVNC',
  'recent-surge-1h': 'RECENT SURGE 1H',
  'recent-surge-6h': 'RECENT SURGE 6H',
  'old-week-surge-1h': 'OLD WEEK SURGE 1H',
  'old-week-surge-6h': 'OLD WEEK SURGE 6H',
  'meteora-surge': 'METEORA SURGE 1H',
});
const SURGE_RULES = new Set([
  'recent-surge-1h', 'recent-surge-6h',
  'old-week-surge-1h', 'old-week-surge-6h',
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeAppBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw new TypeError('Telegram alert appBaseUrl must be a valid URL');
  }
  const localHttp = url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp)
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Telegram alert appBaseUrl must be an approved HTTP(S) URL');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

function requiredObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function timestamp(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError('Telegram alert triggeredAt must be a valid timestamp');
  }
  return parsed;
}

function normalizeDelivery(delivery) {
  requiredObject(delivery, 'Telegram alert delivery');
  const chain = String(delivery.chain || '').trim();
  const ruleKey = String(delivery.ruleKey || '').trim();
  if (!RULE_CONTRACTS[chain]?.[ruleKey]) {
    throw new TypeError(`Unsupported Telegram alert rule: ${chain}/${ruleKey}`);
  }
  const eventPayload = requiredObject(delivery.eventPayload, 'Telegram alert event payload');
  const payload = requiredObject(eventPayload.payload, 'Telegram alert event payload body');
  const address = normalizeTokenAddress(chain, delivery.tokenAddress);
  const symbol = String(payload.symbol || address.slice(0, 8)).trim().slice(0, 32)
    || address.slice(0, 8);
  return {
    address,
    chain,
    payload,
    ruleKey,
    symbol,
    triggeredAt: timestamp(delivery.triggeredAt),
  };
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function signedNumberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactNumber(value, digits = 2) {
  return Number(value.toFixed(digits)).toString();
}

function formatUsd(value) {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  const unit = [
    [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
  ].find(([threshold]) => parsed >= threshold);
  if (!unit) return `$${compactNumber(parsed)}`;
  return `$${compactNumber(parsed / unit[0])}${unit[1]}`;
}

function formatPct(value) {
  const parsed = signedNumberOrNull(value);
  if (parsed == null) return null;
  return `${parsed >= 0 ? '+' : ''}${compactNumber(parsed)}%`;
}

function formatAgeMs(value) {
  const milliseconds = numberOrNull(value);
  if (milliseconds == null) return null;
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function resolveAge(payload, triggeredAt) {
  const explicit = formatAgeMs(payload.tokenAgeMs);
  if (explicit) return explicit;
  const createdAt = numberOrNull(payload.tokenCreatedAt);
  if (createdAt == null) return null;
  return formatAgeMs(Math.max(0, triggeredAt.getTime() - createdAt));
}

function transition(label, previous, current) {
  const currentLabel = formatUsd(current);
  if (!currentLabel) return null;
  const previousLabel = formatUsd(previous);
  return `${label}: ${previousLabel ? `${previousLabel} → ` : ''}${currentLabel}`;
}

function volumeWindowLine(value, payload) {
  const key = value.ruleKey.endsWith('-6h') ? 'volume6h' : 'volume1h';
  return transition(`Volume ${key === 'volume6h' ? '6H' : '1H'}`, null, payload[key]);
}

function buildMetricLines(value) {
  const payload = value.payload;
  if (value.ruleKey === 'monitored-vol') {
    return [
      transition('Volume 5M', payload.prevVolume5m, payload.volume5m),
      transition(value.chain === 'robinhood' ? 'FDV' : 'Market cap', null,
        value.chain === 'robinhood' ? payload.fdv : payload.mcap),
    ];
  }
  if (value.ruleKey === 'monitored-mcap') {
    return [
      transition('Market cap', payload.prevMcap, payload.mcap),
      transition('Volume 5M', null, payload.volume5m),
    ];
  }
  if (value.ruleKey === 'monitored-fdv') {
    return [
      transition('FDV', payload.prevFdv, payload.fdv),
      transition('Volume 5M', null, payload.volume5m),
    ];
  }
  if (value.ruleKey === 'hvnc' || value.ruleKey === 'robinhood-hvnc-v2') {
    return [
      transition('Volume 24H', null, payload.volume24h),
      transition(value.chain === 'robinhood' ? 'FDV' : 'Market cap', null,
        value.chain === 'robinhood' ? payload.fdv : payload.mcap),
    ];
  }
  if (value.ruleKey === 'meteora-surge') {
    return [
      transition('TVL Meteora', payload.meteoraBaselineTvl24h, payload.meteoraCurrentTvl),
      transition('Market cap', null, payload.mcap),
    ];
  }
  if (SURGE_RULES.has(value.ruleKey)) {
    return [
      transition(value.chain === 'robinhood' ? 'FDV' : 'Market cap',
        value.chain === 'robinhood' ? payload.prevFdv : payload.prevMcap,
        value.chain === 'robinhood' ? payload.fdv : payload.mcap),
      volumeWindowLine(value, payload),
    ];
  }
  return [];
}

function buildText(value, t) {
  const chainLabel = value.chain === 'robinhood' ? 'Robinhood' : 'Solana';
  const lines = [
    `<b>${RULE_LABELS[value.ruleKey]} · ${escapeHtml(value.symbol)}</b>`,
    `${t('alert.network')}: ${chainLabel}`,
    formatPct(value.payload.pct)
      ? `${t('alert.change')}: ${formatPct(value.payload.pct)}` : null,
    ...buildMetricLines(value),
    resolveAge(value.payload, value.triggeredAt)
      ? `${t('alert.age')}: ${resolveAge(value.payload, value.triggeredAt)}` : null,
    `${t('alert.contract')}: ${escapeHtml(`${value.address.slice(0, 6)}...${value.address.slice(-4)}`)}`,
    `${t('alert.time')}: ${value.triggeredAt.toISOString().slice(11, 19)} UTC`,
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTokenUrl(baseUrl, value) {
  const path = value.chain === 'solana'
    ? `/alerts/${encodeURIComponent(value.address)}`
    : `/alerts/${value.chain}/${encodeURIComponent(value.address)}`;
  return new URL(path, baseUrl).toString();
}

function buildExplorerUrl(value) {
  if (value.chain === 'solana') {
    return `https://solscan.io/token/${encodeURIComponent(value.address)}`;
  }
  return `https://robinhoodchain.blockscout.com/address/${encodeURIComponent(value.address)}`;
}

function createTelegramAlertFormatter(options = {}) {
  const appBaseUrl = normalizeAppBaseUrl(options.appBaseUrl);

  function format(delivery, formatOptions = {}) {
    const value = normalizeDelivery(delivery);
    const { t } = createTelegramTranslator(formatOptions.languageCode);
    const text = buildText(value, t);
    return Object.freeze({
      text,
      caption: text,
      parseMode: 'HTML',
      replyMarkup: Object.freeze({
        inline_keyboard: Object.freeze([
          Object.freeze([{ text: t('alert.openTrendScope'), url: buildTokenUrl(appBaseUrl, value) }]),
          Object.freeze([{ text: t('alert.explorer'), url: buildExplorerUrl(value) }]),
        ]),
      }),
    });
  }

  return Object.freeze({ format });
}

module.exports = {
  createTelegramAlertFormatter,
};
