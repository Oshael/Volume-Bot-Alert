const db = require('./db');

const COLLAPSIBLE_SECTIONS = ['manual', 'recent', 'oldWeek', 'monitored', 'lateralized', 'bidZone', 'pumpfun'];
const BUCKET_SORT_MODES = ['vol', 'mcap', 'pchange', 'age'];
const MONITORED_SORT_MODES = ['vol', 'mcap', 'age'];

const DEFAULT_UI_PREFS = {
  collapsed: {
    manual: false,
    recent: false,
    oldWeek: false,
    monitored: false,
    lateralized: false,
    bidZone: false,
    pumpfun: false,
  },
  manualStarredOnly: false,
  recentStarredOnly: false,
  oldWeekStarredOnly: false,
  monitoredPerPage: 30,
  recentPerPage: 30,
  oldWeekPerPage: 30,
  manualSorts: [{ mode: 'mcap', window: 'highest' }],
  recentSorts: [{ mode: 'vol', window: '24h' }],
  oldWeekSorts: [{ mode: 'vol', window: '24h' }],
  monitoredSorts: [{ mode: 'vol', window: '5m' }],
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
    lateralized: Boolean(collapsed.lateralized),
    bidZone: Boolean(collapsed.bidZone),
    pumpfun: Boolean(collapsed.pumpfun),
  };

  defaults.manualStarredOnly = Boolean(source.manualStarredOnly);
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

    if (key === 'manualStarredOnly' || key === 'recentStarredOnly' || key === 'oldWeekStarredOnly') {
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
