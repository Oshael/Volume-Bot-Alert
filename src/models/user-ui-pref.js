const db = require('./db');
const { normalizeTokenChain } = require('../utils/token-identity');
const {
  getAvailableTokenChains,
  isRobinhoodUserVisible,
} = require('../utils/token-chain-availability');
const config = require('../../config');

const COLLAPSIBLE_SECTIONS = ['manual', 'recent', 'oldWeek', 'monitored', 'bidZone', 'pumpfun'];
const BUCKET_SORT_MODES = ['vol', 'mcap', 'pchange', 'age'];
const MONITORED_SORT_MODES = ['vol', 'mcap', 'age'];
const BOOLEAN_PREF_KEYS = [
  'manualStarredOnly',
  'manualFolderDeleteWarningDismissed',
  'recentStarredOnly',
  'oldWeekStarredOnly',
];
const TRADE_TERMINAL_KEYS = ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo'];
const TRADE_TERMINAL_CATALOG_VERSION = 2;
const LIVE_PANEL_KEYS = ['monitored', 'pumpfun', 'alerts'];
const LIVE_PANEL_SPANS = {
  monitored: [1, 2, 3],
  pumpfun: [1],
  alerts: [1, 2, 3],
};
const LIVE_PANEL_DEFAULT_HEIGHT = 620;
const LIVE_PANEL_MAX_HEIGHT = 100000;
const EXPANDED_SPARKLINE_GRANULARITIES = [1, 5, 15, 30, 60, 240, 1440];
const EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES = 5;
const EXPANDED_CHART_TIME_ZONES = [
  'browser',
  'UTC',
  'America/Fortaleza',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];
const EXPANDED_CHART_DEFAULT_TIME_ZONE = 'browser';
const SPARKLINE_RANGE_MIN_DAYS = 1;
const SPARKLINE_RANGE_MAX_DAYS = 14;
const SPARKLINE_RANGE_DEFAULT_DAYS = 14;
const SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX = 250;
const SPARKLINE_RANGE_PRESETS = Object.freeze([
  '1h', '4h', '12h', '1d', '3d', '7d', '14d', 'all',
]);
const CHAIN_FILTER_KEYS = [
  'enabledChains',
  'radarChains',
  'alertFeedChains',
  'browserNotificationChains',
];
const DEFAULT_CHAIN_FILTERS = Object.freeze({
  enabledChains: Object.freeze(['solana']),
  radarChains: Object.freeze(['solana']),
  alertFeedChains: Object.freeze(['solana']),
  browserNotificationChains: Object.freeze(['solana']),
});

function getConfiguredAvailableTokenChains() {
  return getAvailableTokenChains({
    robinhoodVisible: isRobinhoodUserVisible(config),
  });
}

const DEFAULT_UI_PREFS = {
  collapsed: {
    manual: false,
    recent: false,
    oldWeek: false,
    monitored: false,
    bidZone: false,
    pumpfun: false,
  },
  manualStarredOnly: false,
  manualFolderDeleteWarningDismissed: false,
  recentStarredOnly: false,
  oldWeekStarredOnly: false,
  chainFilters: DEFAULT_CHAIN_FILTERS,
  monitoredPerPage: 30,
  recentPerPage: 30,
  oldWeekPerPage: 30,
  manualSorts: [{ mode: 'mcap', window: 'highest' }],
  recentSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
  oldWeekSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
  monitoredSorts: [{ mode: 'vol', window: '5m' }],
  expandedSparklineGranularityMinutes: EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES,
  expandedSparklineTimeZone: EXPANDED_CHART_DEFAULT_TIME_ZONE,
  sparklineRange: {
    monitoredDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    recentDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    oldWeekDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    monitoredPreset: '14d',
    recentPreset: '14d',
    oldWeekPreset: '14d',
    tokenDaysByAddress: {},
    tokenPresetByAddress: {},
  },
  enabledTradeTerminals: [...TRADE_TERMINAL_KEYS],
  tradeTerminalCatalogVersion: TRADE_TERMINAL_CATALOG_VERSION,
  livePanelLayout: {
    order: [...LIVE_PANEL_KEYS],
    spans: {
      monitored: 2,
      pumpfun: 1,
      alerts: 1,
    },
    heights: {
      monitored: LIVE_PANEL_DEFAULT_HEIGHT,
      alerts: LIVE_PANEL_DEFAULT_HEIGHT,
    },
  },
};

function cloneDefaultPrefs() {
  return JSON.parse(JSON.stringify(DEFAULT_UI_PREFS));
}

function validateBoolean(key, value) {
  if (typeof value !== 'boolean') {
    return { valid: false, error: `${key} must be a boolean` };
  }
  return { valid: true, value };
}

function validatePerPage(key, value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 10 || num > 500) {
    return { valid: false, error: `${key} must be between 10 and 500` };
  }
  return { valid: true, value: Math.floor(num) };
}

function normalizeExpandedSparklineGranularity(value) {
  const parsed = Math.round(Number(value));
  return EXPANDED_SPARKLINE_GRANULARITIES.includes(parsed)
    ? parsed
    : EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
}

function validateExpandedSparklineGranularity(key, value) {
  const parsed = Math.round(Number(value));
  if (!EXPANDED_SPARKLINE_GRANULARITIES.includes(parsed)) {
    return { valid: false, error: `${key} must be one of ${EXPANDED_SPARKLINE_GRANULARITIES.join(', ')}` };
  }
  return { valid: true, value: parsed };
}

function normalizeExpandedChartTimeZone(value) {
  const timeZone = String(value || '').trim();
  return EXPANDED_CHART_TIME_ZONES.includes(timeZone)
    ? timeZone
    : EXPANDED_CHART_DEFAULT_TIME_ZONE;
}

function validateExpandedChartTimeZone(key, value) {
  const timeZone = String(value || '').trim();
  if (!EXPANDED_CHART_TIME_ZONES.includes(timeZone)) {
    return { valid: false, error: `${key} must be one of ${EXPANDED_CHART_TIME_ZONES.join(', ')}` };
  }
  return { valid: true, value: timeZone };
}

function normalizeSparklineRangeDays(value, fallback = SPARKLINE_RANGE_DEFAULT_DAYS) {
  const parsed = Math.round(Number(value));
  const fallbackDays = Math.round(Number(fallback));
  const safeFallback = Number.isFinite(fallbackDays)
    ? Math.min(SPARKLINE_RANGE_MAX_DAYS, Math.max(SPARKLINE_RANGE_MIN_DAYS, fallbackDays))
    : SPARKLINE_RANGE_DEFAULT_DAYS;
  return Number.isFinite(parsed)
    ? Math.min(SPARKLINE_RANGE_MAX_DAYS, Math.max(SPARKLINE_RANGE_MIN_DAYS, parsed))
    : safeFallback;
}

function sparklinePresetFromDays(value) {
  const hours = normalizeSparklineRangeDays(value) * 24;
  const timedPresets = [
    ['1h', 1], ['4h', 4], ['12h', 12], ['1d', 24],
    ['3d', 72], ['7d', 168], ['14d', 336],
  ];
  return timedPresets.reduce((best, candidate) => (
    Math.abs(candidate[1] - hours) < Math.abs(best[1] - hours) ? candidate : best
  ))[0];
}

function normalizeSparklinePreset(value, fallbackDays) {
  const preset = String(value || '').trim().toLowerCase();
  return SPARKLINE_RANGE_PRESETS.includes(preset)
    ? preset
    : sparklinePresetFromDays(fallbackDays);
}

function validateSparklineRangeTokenDays(key, value) {
  if (value == null) {
    return { valid: true, value: {} };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key}.tokenDaysByAddress must be an object` };
  }

  const entries = Object.entries(value);
  if (entries.length > SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX) {
    return { valid: false, error: `${key}.tokenDaysByAddress must contain at most ${SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX} tokens` };
  }

  const tokenDaysByAddress = {};
  for (const [rawAddress, rawDays] of entries) {
    const address = String(rawAddress || '').trim();
    const days = Math.round(Number(rawDays));
    if (!address) {
      return { valid: false, error: `${key}.tokenDaysByAddress has an empty token address` };
    }
    if (!Number.isFinite(days) || days < SPARKLINE_RANGE_MIN_DAYS || days > SPARKLINE_RANGE_MAX_DAYS) {
      return { valid: false, error: `${key}.tokenDaysByAddress.${address} must be between ${SPARKLINE_RANGE_MIN_DAYS} and ${SPARKLINE_RANGE_MAX_DAYS}` };
    }
    tokenDaysByAddress[address] = days;
  }

  return { valid: true, value: tokenDaysByAddress };
}

function validateSparklineRangeTokenPresets(key, value) {
  if (value == null) return { valid: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key}.tokenPresetByAddress must be an object` };
  }
  const entries = Object.entries(value);
  if (entries.length > SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX) {
    return { valid: false, error: `${key}.tokenPresetByAddress must contain at most ${SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX} tokens` };
  }
  const presets = {};
  for (const [rawAddress, rawPreset] of entries) {
    const address = String(rawAddress || '').trim();
    const preset = String(rawPreset || '').trim().toLowerCase();
    if (!address || !SPARKLINE_RANGE_PRESETS.includes(preset)) {
      return { valid: false, error: `${key}.tokenPresetByAddress contains an invalid token or preset` };
    }
    presets[address] = preset;
  }
  return { valid: true, value: presets };
}

function validateSparklineRangeTokenOverrides(key, value) {
  const days = validateSparklineRangeTokenDays(key, value.tokenDaysByAddress);
  if (!days.valid) return days;
  const presets = validateSparklineRangeTokenPresets(key, value.tokenPresetByAddress);
  if (!presets.valid) return presets;
  return { valid: true, days: days.value, presets: presets.value };
}

function validateSparklineRange(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key} must be an object` };
  }
  if (value.global != null && typeof value.global !== 'boolean') {
    return { valid: false, error: `${key}.global must be a boolean` };
  }
  const tokenOverrides = validateSparklineRangeTokenOverrides(key, value);
  if (!tokenOverrides.valid) return tokenOverrides;

  const legacyGlobalDays = normalizeSparklineRangeDays(value.globalDays);
  const legacyGlobal = value.global === true;
  const monitoredDays = normalizeSparklineRangeDays(
    legacyGlobal ? legacyGlobalDays : value.monitoredDays
  );
  const recentDays = normalizeSparklineRangeDays(
    legacyGlobal ? legacyGlobalDays : value.recentDays
  );
  const oldWeekDays = normalizeSparklineRangeDays(
    legacyGlobal ? legacyGlobalDays : value.oldWeekDays
  );
  const next = {
    monitoredDays,
    recentDays,
    oldWeekDays,
    monitoredPreset: normalizeSparklinePreset(value.monitoredPreset, monitoredDays),
    recentPreset: normalizeSparklinePreset(value.recentPreset, recentDays),
    oldWeekPreset: normalizeSparklinePreset(value.oldWeekPreset, oldWeekDays),
    tokenDaysByAddress: tokenOverrides.days,
    tokenPresetByAddress: tokenOverrides.presets,
  };

  for (const dayKey of ['globalDays', 'monitoredDays', 'recentDays', 'oldWeekDays']) {
    const raw = value[dayKey];
    const parsed = Math.round(Number(raw));
    if (raw != null && (!Number.isFinite(parsed) || parsed < SPARKLINE_RANGE_MIN_DAYS || parsed > SPARKLINE_RANGE_MAX_DAYS)) {
      return { valid: false, error: `${key}.${dayKey} must be between ${SPARKLINE_RANGE_MIN_DAYS} and ${SPARKLINE_RANGE_MAX_DAYS}` };
    }
  }

  for (const presetKey of ['monitoredPreset', 'recentPreset', 'oldWeekPreset']) {
    if (value[presetKey] != null
      && !SPARKLINE_RANGE_PRESETS.includes(String(value[presetKey]).toLowerCase())) {
      return { valid: false, error: `${key}.${presetKey} must be a supported range preset` };
    }
  }

  return { valid: true, value: next };
}

function validateCollapsed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: 'collapsed must be an object' };
  }

  const next = {};
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!COLLAPSIBLE_SECTIONS.includes(key)) {
      errors.push(`Unknown collapsed section: ${key}`);
      continue;
    }
    const result = validateBoolean(`collapsed.${key}`, value[key]);
    if (!result.valid) {
      errors.push(result.error);
      continue;
    }
    next[key] = result.value;
  }

  return {
    valid: errors.length === 0,
    value: next,
    errors,
  };
}

function isAllowedBucketWindow(mode, window) {
  if (mode === 'vol' || mode === 'pchange') {
    return window === '1h' || window === '6h' || window === '24h';
  }
  if (mode === 'mcap') {
    return window === 'highest' || window === 'lowest';
  }
  if (mode === 'age') {
    return window === 'newest' || window === 'oldest';
  }
  return false;
}

function isAllowedMonitoredWindow(mode, window) {
  if (mode === 'vol') {
    return window === '5m' || window === '1h' || window === '6h' || window === '24h';
  }
  if (mode === 'mcap') {
    return window === 'highest' || window === 'lowest';
  }
  if (mode === 'age') {
    return window === 'newest' || window === 'oldest';
  }
  return false;
}

function validateSorts(key, value, options) {
  if (!Array.isArray(value)) {
    return { valid: false, error: `${key} must be an array` };
  }

  const next = [];
  const errors = [];
  const seen = new Set();

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${key} entries must be objects`);
      continue;
    }

    const mode = String(item.mode || '').trim();
    const window = String(item.window || '').trim();
    if (!options.allowedModes.includes(mode)) {
      errors.push(`${key} contains invalid mode: ${mode || '(empty)'}`);
      continue;
    }
    if (!options.isAllowedWindow(mode, window)) {
      errors.push(`${key} contains invalid window for ${mode}: ${window || '(empty)'}`);
      continue;
    }

    const dedupeKey = `${mode}:${window}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    next.push({ mode, window });
  }

  if (next.length > 8) {
    errors.push(`${key} can contain at most 8 entries`);
  }

  return {
    valid: errors.length === 0,
    value: next.slice(0, 8),
    errors,
  };
}

function validateTradeTerminals(key, value) {
  if (!Array.isArray(value)) {
    return { valid: false, error: `${key} must be an array` };
  }

  const next = [];
  const seen = new Set();

  for (const item of value) {
    const normalized = String(item || '').trim().toLowerCase();
    if (!TRADE_TERMINAL_KEYS.includes(normalized)) {
      return { valid: false, error: `${key} contains invalid terminal: ${normalized || '(empty)'}` };
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }

  if (next.length === 0) {
    return { valid: false, error: `${key} must contain at least one terminal` };
  }

  return { valid: true, value: next };
}

function normalizeStoredChainSelection(value, allowedChains, fallback) {
  const next = [];
  for (const item of Array.isArray(value) ? value : []) {
    let chain;
    try {
      chain = normalizeTokenChain(item);
    } catch (_) {
      continue;
    }
    if (allowedChains.has(chain) && !next.includes(chain)) {
      next.push(chain);
    }
  }
  return next.length > 0 ? next : [...fallback];
}

function normalizeChainFilters(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const available = new Set(getConfiguredAvailableTokenChains());
  const enabledChains = normalizeStoredChainSelection(
    source.enabledChains,
    available,
    DEFAULT_CHAIN_FILTERS.enabledChains,
  );
  const enabled = new Set(enabledChains);
  return {
    enabledChains,
    radarChains: normalizeStoredChainSelection(source.radarChains, enabled, enabledChains),
    alertFeedChains: normalizeStoredChainSelection(source.alertFeedChains, enabled, enabledChains),
    browserNotificationChains: normalizeStoredChainSelection(
      source.browserNotificationChains,
      enabled,
      enabledChains,
    ),
  };
}

function validateChainSelection(key, value, allowedChains) {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, error: `${key} must contain at least one chain` };
  }
  const next = [];
  for (const item of value) {
    let chain;
    try {
      chain = normalizeTokenChain(item);
    } catch (_) {
      return { valid: false, error: `${key} contains an unsupported chain` };
    }
    if (!allowedChains.has(chain)) {
      return { valid: false, error: `${key} contains an unavailable chain: ${chain}` };
    }
    if (!next.includes(chain)) {
      next.push(chain);
    }
  }
  return { valid: true, value: next };
}

function validateChainFilters(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key} must be an object` };
  }
  const unknownKeys = Object.keys(value).filter((item) => !CHAIN_FILTER_KEYS.includes(item));
  if (unknownKeys.length > 0) {
    return { valid: false, error: `${key} contains unknown keys: ${unknownKeys.join(', ')}` };
  }

  const available = new Set(getConfiguredAvailableTokenChains());
  const enabledResult = validateChainSelection(`${key}.enabledChains`, value.enabledChains, available);
  if (!enabledResult.valid) return enabledResult;

  const enabled = new Set(enabledResult.value);
  const next = { enabledChains: enabledResult.value };
  for (const filterKey of CHAIN_FILTER_KEYS.slice(1)) {
    const result = validateChainSelection(`${key}.${filterKey}`, value[filterKey], enabled);
    if (!result.valid) return result;
    next[filterKey] = result.value;
  }
  return { valid: true, value: next };
}

function normalizeLivePanelOrder(input) {
  const next = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input : []) {
    const normalized = String(item || '').trim();
    if (!LIVE_PANEL_KEYS.includes(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  for (const key of LIVE_PANEL_KEYS) {
    if (!seen.has(key)) {
      next.push(key);
    }
  }
  return next;
}

function validateLivePanelHeights(key, value) {
  const sourceHeights = value == null ? {} : value;
  if (!sourceHeights || typeof sourceHeights !== 'object' || Array.isArray(sourceHeights)) {
    return { valid: false, error: `${key}.heights must be an object` };
  }

  const heights = {};
  for (const panelKey of ['monitored', 'alerts']) {
    const rawHeight = sourceHeights[panelKey] ?? LIVE_PANEL_DEFAULT_HEIGHT;
    const numeric = Math.round(Number(rawHeight));
    if (!Number.isFinite(numeric) || numeric < 1 || numeric > LIVE_PANEL_MAX_HEIGHT) {
      return {
        valid: false,
        error: `${key}.heights.${panelKey} must be between 1 and ${LIVE_PANEL_MAX_HEIGHT}`,
      };
    }
    heights[panelKey] = numeric;
  }

  return { valid: true, value: heights };
}

function validateLivePanelLayout(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key} must be an object` };
  }

  if (!Array.isArray(value.order)) {
    return { valid: false, error: `${key}.order must be an array` };
  }

  const order = normalizeLivePanelOrder(value.order);
  if (order.length !== LIVE_PANEL_KEYS.length) {
    return { valid: false, error: `${key}.order must contain monitored, pumpfun, and alerts exactly once` };
  }

  if (!value.spans || typeof value.spans !== 'object' || Array.isArray(value.spans)) {
    return { valid: false, error: `${key}.spans must be an object` };
  }

  const spans = {};
  for (const panelKey of LIVE_PANEL_KEYS) {
    const allowed = LIVE_PANEL_SPANS[panelKey];
    const numeric = Number(value.spans[panelKey]);
    if (!allowed.includes(numeric)) {
      return { valid: false, error: `${key}.spans.${panelKey} must be one of ${allowed.join(', ')}` };
    }
    spans[panelKey] = numeric;
  }

  const heights = validateLivePanelHeights(key, value.heights);
  if (!heights.valid) {
    return heights;
  }

  return {
    valid: true,
    value: {
      order,
      spans,
      heights: heights.value,
    },
  };
}

function normalizedStoredValue(result, fallback) {
  return result.valid ? result.value : fallback;
}

function normalizeStoredPerPage(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 10 && numeric <= 500
    ? Math.floor(numeric)
    : fallback;
}

function normalizeStoredSorts(key, value, options, fallback) {
  return normalizedStoredValue(validateSorts(key, value, options), fallback);
}

function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = cloneDefaultPrefs();
  const collapsed = source.collapsed && typeof source.collapsed === 'object' && !Array.isArray(source.collapsed)
    ? source.collapsed
    : {};

  defaults.collapsed = {
    ...defaults.collapsed,
    manual: Boolean(collapsed.manual),
    recent: Boolean(collapsed.recent),
    oldWeek: Boolean(collapsed.oldWeek),
    monitored: Boolean(collapsed.monitored),
    bidZone: Boolean(collapsed.bidZone),
    pumpfun: Boolean(collapsed.pumpfun),
  };
  defaults.manualStarredOnly = Boolean(source.manualStarredOnly);
  defaults.manualFolderDeleteWarningDismissed = Boolean(source.manualFolderDeleteWarningDismissed);
  defaults.recentStarredOnly = Boolean(source.recentStarredOnly);
  defaults.oldWeekStarredOnly = Boolean(source.oldWeekStarredOnly);
  defaults.chainFilters = normalizeChainFilters(source.chainFilters);
  defaults.monitoredPerPage = normalizeStoredPerPage(source.monitoredPerPage, defaults.monitoredPerPage);
  defaults.recentPerPage = normalizeStoredPerPage(source.recentPerPage, defaults.recentPerPage);
  defaults.oldWeekPerPage = normalizeStoredPerPage(source.oldWeekPerPage, defaults.oldWeekPerPage);
  defaults.manualSorts = normalizeStoredSorts('manualSorts', source.manualSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  }, defaults.manualSorts);
  defaults.recentSorts = normalizeStoredSorts('recentSorts', source.recentSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  }, defaults.recentSorts);
  defaults.oldWeekSorts = normalizeStoredSorts('oldWeekSorts', source.oldWeekSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  }, defaults.oldWeekSorts);
  defaults.monitoredSorts = normalizeStoredSorts('monitoredSorts', source.monitoredSorts, {
    allowedModes: MONITORED_SORT_MODES,
    isAllowedWindow: isAllowedMonitoredWindow,
  }, defaults.monitoredSorts);
  defaults.expandedSparklineGranularityMinutes = normalizeExpandedSparklineGranularity(source.expandedSparklineGranularityMinutes);
  defaults.expandedSparklineTimeZone = normalizeExpandedChartTimeZone(source.expandedSparklineTimeZone);
  defaults.sparklineRange = normalizedStoredValue(
    validateSparklineRange('sparklineRange', source.sparklineRange),
    defaults.sparklineRange,
  );
  const normalizedTradeTerminals = normalizedStoredValue(
    validateTradeTerminals('enabledTradeTerminals', source.enabledTradeTerminals),
    defaults.enabledTradeTerminals,
  );
  const storedTerminalCatalogVersion = Number(source.tradeTerminalCatalogVersion) || 1;
  defaults.enabledTradeTerminals = storedTerminalCatalogVersion < TRADE_TERMINAL_CATALOG_VERSION
    && !normalizedTradeTerminals.includes('fomo')
    ? [...normalizedTradeTerminals, 'fomo']
    : normalizedTradeTerminals;
  defaults.tradeTerminalCatalogVersion = TRADE_TERMINAL_CATALOG_VERSION;
  defaults.livePanelLayout = normalizedStoredValue(
    validateLivePanelLayout('livePanelLayout', source.livePanelLayout),
    defaults.livePanelLayout,
  );
  return defaults;
}

const UI_PREF_VALIDATORS = new Map([
  ['collapsed', (_key, value) => validateCollapsed(value)],
  ...BOOLEAN_PREF_KEYS.map((key) => [key, validateBoolean]),
  ['monitoredPerPage', validatePerPage],
  ['recentPerPage', validatePerPage],
  ['oldWeekPerPage', validatePerPage],
  ['expandedSparklineGranularityMinutes', validateExpandedSparklineGranularity],
  ['expandedSparklineTimeZone', validateExpandedChartTimeZone],
  ['sparklineRange', validateSparklineRange],
  ['manualSorts', (key, value) => validateSorts(key, value, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  })],
  ['recentSorts', (key, value) => validateSorts(key, value, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  })],
  ['oldWeekSorts', (key, value) => validateSorts(key, value, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  })],
  ['monitoredSorts', (key, value) => validateSorts(key, value, {
    allowedModes: MONITORED_SORT_MODES,
    isAllowedWindow: isAllowedMonitoredWindow,
  })],
  ['enabledTradeTerminals', validateTradeTerminals],
  ['livePanelLayout', validateLivePanelLayout],
  ['chainFilters', validateChainFilters],
]);

function validationErrors(result) {
  return Array.isArray(result.errors) && result.errors.length > 0
    ? result.errors
    : [result.error || 'Invalid UI preference value'];
}

function validatePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, prefs: {}, errors: ['uiPrefs must be an object'] };
  }

  const prefs = {};
  const errors = [];
  for (const [key, value] of Object.entries(input)) {
    const validator = UI_PREF_VALIDATORS.get(key);
    if (!validator) {
      errors.push(`Unknown uiPrefs key: ${key}`);
      continue;
    }
    const result = validator(key, value);
    if (!result.valid) {
      errors.push(...validationErrors(result));
      continue;
    }
    prefs[key] = result.value;
  }
  return { valid: errors.length === 0, prefs, errors };
}

function mergePrefs(current, patch) {
  return normalizePrefs({
    ...current,
    ...patch,
    collapsed: patch.collapsed
      ? {
        ...(current?.collapsed || {}),
        ...patch.collapsed,
      }
      : current?.collapsed,
  });
}

async function getAll(userId) {
  const { rows } = await db.query(
    `SELECT prefs_json
     FROM user_ui_prefs
     WHERE user_id = $1`,
    [userId]
  );
  return normalizePrefs(rows[0]?.prefs_json || {});
}

async function replace(userId, prefs) {
  const normalized = normalizePrefs(prefs);
  await db.query(
    `INSERT INTO user_ui_prefs (user_id, prefs_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = NOW()`,
    [userId, JSON.stringify(normalized)]
  );
  return normalized;
}

async function patch(userId, partialPrefs) {
  const current = await getAll(userId);
  const next = mergePrefs(current, partialPrefs);
  return replace(userId, next);
}

module.exports = {
  DEFAULT_UI_PREFS,
  cloneDefaultPrefs,
  normalizePrefs,
  validatePatch,
  getAll,
  replace,
  patch,
};
