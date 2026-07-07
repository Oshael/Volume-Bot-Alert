const db = require('./db');

const COLLAPSIBLE_SECTIONS = ['manual', 'recent', 'oldWeek', 'monitored', 'bidZone', 'pumpfun'];
const BUCKET_SORT_MODES = ['vol', 'mcap', 'pchange', 'age'];
const MONITORED_SORT_MODES = ['vol', 'mcap', 'age'];
const BOOLEAN_PREF_KEYS = [
  'manualStarredOnly',
  'manualFolderDeleteWarningDismissed',
  'recentStarredOnly',
  'oldWeekStarredOnly',
];
const TRADE_TERMINAL_KEYS = ['axiom', 'photon', 'bullx', 'gmgn', 'padre'];
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
const SPARKLINE_RANGE_MIN_DAYS = 1;
const SPARKLINE_RANGE_MAX_DAYS = 14;
const SPARKLINE_RANGE_DEFAULT_DAYS = 14;
const SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX = 250;

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
  monitoredPerPage: 30,
  recentPerPage: 30,
  oldWeekPerPage: 30,
  manualSorts: [{ mode: 'mcap', window: 'highest' }],
  recentSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
  oldWeekSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
  monitoredSorts: [{ mode: 'vol', window: '5m' }],
  expandedSparklineGranularityMinutes: EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES,
  sparklineRange: {
    global: true,
    globalDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    monitoredDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    recentDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    oldWeekDays: SPARKLINE_RANGE_DEFAULT_DAYS,
    tokenDaysByAddress: {},
  },
  enabledTradeTerminals: [...TRADE_TERMINAL_KEYS],
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

function validateSparklineRange(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, error: `${key} must be an object` };
  }
  if (value.global != null && typeof value.global !== 'boolean') {
    return { valid: false, error: `${key}.global must be a boolean` };
  }
  const tokenDaysByAddress = validateSparklineRangeTokenDays(key, value.tokenDaysByAddress);
  if (!tokenDaysByAddress.valid) {
    return tokenDaysByAddress;
  }

  const next = {
    global: value.global == null ? true : Boolean(value.global),
    globalDays: normalizeSparklineRangeDays(value.globalDays),
    monitoredDays: normalizeSparklineRangeDays(value.monitoredDays),
    recentDays: normalizeSparklineRangeDays(value.recentDays),
    oldWeekDays: normalizeSparklineRangeDays(value.oldWeekDays),
    tokenDaysByAddress: tokenDaysByAddress.value,
  };

  for (const dayKey of ['globalDays', 'monitoredDays', 'recentDays', 'oldWeekDays']) {
    const raw = value[dayKey];
    const parsed = Math.round(Number(raw));
    if (raw != null && (!Number.isFinite(parsed) || parsed < SPARKLINE_RANGE_MIN_DAYS || parsed > SPARKLINE_RANGE_MAX_DAYS)) {
      return { valid: false, error: `${key}.${dayKey} must be between ${SPARKLINE_RANGE_MIN_DAYS} and ${SPARKLINE_RANGE_MAX_DAYS}` };
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

  const monitoredPerPage = Number(source.monitoredPerPage);
  if (Number.isFinite(monitoredPerPage) && monitoredPerPage >= 10 && monitoredPerPage <= 500) {
    defaults.monitoredPerPage = Math.floor(monitoredPerPage);
  }

  const recentPerPage = Number(source.recentPerPage);
  if (Number.isFinite(recentPerPage) && recentPerPage >= 10 && recentPerPage <= 500) {
    defaults.recentPerPage = Math.floor(recentPerPage);
  }

  const oldWeekPerPage = Number(source.oldWeekPerPage);
  if (Number.isFinite(oldWeekPerPage) && oldWeekPerPage >= 10 && oldWeekPerPage <= 500) {
    defaults.oldWeekPerPage = Math.floor(oldWeekPerPage);
  }

  const manualSorts = validateSorts('manualSorts', source.manualSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  });
  if (manualSorts.valid) {
    defaults.manualSorts = manualSorts.value;
  }

  const recentSorts = validateSorts('recentSorts', source.recentSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  });
  if (recentSorts.valid) {
    defaults.recentSorts = recentSorts.value;
  }

  const oldWeekSorts = validateSorts('oldWeekSorts', source.oldWeekSorts, {
    allowedModes: BUCKET_SORT_MODES,
    isAllowedWindow: isAllowedBucketWindow,
  });
  if (oldWeekSorts.valid) {
    defaults.oldWeekSorts = oldWeekSorts.value;
  }

  const monitoredSorts = validateSorts('monitoredSorts', source.monitoredSorts, {
    allowedModes: MONITORED_SORT_MODES,
    isAllowedWindow: isAllowedMonitoredWindow,
  });
  if (monitoredSorts.valid) {
    defaults.monitoredSorts = monitoredSorts.value;
  }

  defaults.expandedSparklineGranularityMinutes = normalizeExpandedSparklineGranularity(source.expandedSparklineGranularityMinutes);

  const sparklineRange = validateSparklineRange('sparklineRange', source.sparklineRange);
  if (sparklineRange.valid) {
    defaults.sparklineRange = sparklineRange.value;
  }

  const enabledTradeTerminals = validateTradeTerminals('enabledTradeTerminals', source.enabledTradeTerminals);
  if (enabledTradeTerminals.valid) {
    defaults.enabledTradeTerminals = enabledTradeTerminals.value;
  }

  const livePanelLayout = validateLivePanelLayout('livePanelLayout', source.livePanelLayout);
  if (livePanelLayout.valid) {
    defaults.livePanelLayout = livePanelLayout.value;
  }

  return defaults;
}

function validatePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, prefs: {}, errors: ['uiPrefs must be an object'] };
  }

  const prefs = {};
  const errors = [];

  for (const [key, value] of Object.entries(input)) {
    if (key === 'collapsed') {
      const result = validateCollapsed(value);
      if (!result.valid) {
        errors.push(...result.errors);
      } else {
        prefs.collapsed = result.value;
      }
      continue;
    }

    if (BOOLEAN_PREF_KEYS.includes(key)) {
      const result = validateBoolean(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'monitoredPerPage' || key === 'recentPerPage' || key === 'oldWeekPerPage') {
      const result = validatePerPage(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'expandedSparklineGranularityMinutes') {
      const result = validateExpandedSparklineGranularity(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'sparklineRange') {
      const result = validateSparklineRange(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'manualSorts' || key === 'recentSorts' || key === 'oldWeekSorts') {
      const result = validateSorts(key, value, {
        allowedModes: BUCKET_SORT_MODES,
        isAllowedWindow: isAllowedBucketWindow,
      });
      if (!result.valid) {
        errors.push(...result.errors);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'monitoredSorts') {
      const result = validateSorts(key, value, {
        allowedModes: MONITORED_SORT_MODES,
        isAllowedWindow: isAllowedMonitoredWindow,
      });
      if (!result.valid) {
        errors.push(...result.errors);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'enabledTradeTerminals') {
      const result = validateTradeTerminals(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    if (key === 'livePanelLayout') {
      const result = validateLivePanelLayout(key, value);
      if (!result.valid) {
        errors.push(result.error);
      } else {
        prefs[key] = result.value;
      }
      continue;
    }

    errors.push(`Unknown uiPrefs key: ${key}`);
  }

  return {
    valid: errors.length === 0,
    prefs,
    errors,
  };
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
