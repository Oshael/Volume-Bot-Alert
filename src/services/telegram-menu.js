const { RULE_CONTRACTS } = require('./telegram-alert-rule-contracts');
const { createTelegramTranslator } = require('./telegram-i18n');

const CHAIN_CODES = Object.freeze({ solana: 's', robinhood: 'r' });
const CHAIN_BY_CODE = Object.freeze({ s: 'solana', r: 'robinhood' });
const FIELD_CODES = Object.freeze({
  thresholdPct: 't',
  cooldownMinutes: 'c',
  minVolumeUsd: 'v',
  minHvncVolumeUsd: 'h',
  minMarketCapUsd: 'n',
  maxMarketCapUsd: 'x',
  minFdvUsd: 'f',
  maxFdvUsd: 'z',
});
const FIELD_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(FIELD_CODES).map(([field, code]) => [code, field])
));
const RULE_CODES = Object.freeze({
  'monitored-vol': 'v',
  'monitored-mcap': 'm',
  'monitored-fdv': 'f',
  hvnc: 'h',
  'robinhood-hvnc-v2': 'h',
  'recent-surge-1h': 'r1',
  'recent-surge-6h': 'r6',
  'old-week-surge-1h': 'w1',
  'old-week-surge-6h': 'w6',
  'meteora-surge': 'me',
});
const RULE_LABELS = Object.freeze({
  'monitored-vol': 'Volume 5M',
  'monitored-mcap': 'Market Cap 5M',
  'monitored-fdv': 'FDV 5M',
  hvnc: 'HVNC',
  'robinhood-hvnc-v2': 'HVNC',
  'recent-surge-1h': 'Recent Surge 1H',
  'recent-surge-6h': 'Recent Surge 6H',
  'old-week-surge-1h': 'Old Week Surge 1H',
  'old-week-surge-6h': 'Old Week Surge 6H',
  'meteora-surge': 'Meteora Surge 1H',
});
const RULE_ORDER = Object.freeze({
  solana: Object.freeze([
    'monitored-vol', 'monitored-mcap', 'hvnc',
    'recent-surge-1h', 'recent-surge-6h',
    'old-week-surge-1h', 'old-week-surge-6h', 'meteora-surge',
  ]),
  robinhood: Object.freeze([
    'monitored-vol', 'monitored-fdv', 'robinhood-hvnc-v2',
    'recent-surge-1h', 'recent-surge-6h',
    'old-week-surge-1h', 'old-week-surge-6h',
  ]),
});
const FIELD_LABELS = Object.freeze({
  thresholdPct: ['field.thresholdPct', '%'],
  cooldownMinutes: ['field.cooldownMinutes', ' min'],
  minVolumeUsd: ['field.minVolumeUsd', '$'],
  minHvncVolumeUsd: ['field.minHvncVolumeUsd', '$'],
  minMarketCapUsd: ['field.minMarketCapUsd', '$'],
  maxMarketCapUsd: ['field.maxMarketCapUsd', '$'],
  minFdvUsd: ['field.minFdvUsd', '$'],
  maxFdvUsd: ['field.maxFdvUsd', '$'],
});

function catalogCallbackData(route) {
  const staticCode = { main: 'm', alerts: 'a', status: 'i', help: 'h' }[route.kind];
  if (staticCode) return `ts1:${staticCode}`;
  if (route.kind === 'toggle-connection') {
    const version = Number(route.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError('Telegram mutation callback requires a positive version');
    }
    return `ts1:u:${version.toString(36)}`;
  }
  const chainCode = CHAIN_CODES[route.chain];
  if (!chainCode) throw new TypeError('Unsupported Telegram menu chain');
  if (route.kind === 'chain') return `ts1:c:${chainCode}`;
  const ruleCode = RULE_CODES[route.ruleKey];
  const supportedRule = ruleCode && RULE_CONTRACTS[route.chain]?.[route.ruleKey];
  const ruleAction = {
    rule: 'r',
    'toggle-rule': 't',
    'confirm-reset-rule': 'q',
    'reset-rule': 'd',
  }[route.kind];
  if (route.kind === 'rule') {
    if (supportedRule) return `ts1:r:${chainCode}:${ruleCode}`;
    throw new TypeError('Unsupported Telegram menu rule');
  }
  if (ruleAction && !supportedRule) throw new TypeError('Unsupported Telegram menu rule');
  const action = ruleAction || {
    'toggle-profile': 'p',
    'toggle-sparkline': 's',
  }[route.kind];
  if (!action) throw new TypeError('Unsupported Telegram menu action');
  const version = Number(route.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('Telegram mutation callback requires a positive version');
  }
  const encodedVersion = version.toString(36);
  return ruleAction
    ? `ts1:${action}:${chainCode}:${ruleCode}:${encodedVersion}`
    : `ts1:${action}:${chainCode}:${encodedVersion}`;
}

function editCallbackData(route) {
  const chainCode = CHAIN_CODES[route.chain];
  const ruleCode = RULE_CODES[route.ruleKey];
  const fieldCode = FIELD_CODES[route.field];
  const contract = RULE_CONTRACTS[route.chain]?.[route.ruleKey];
  if (!chainCode || !ruleCode || !fieldCode || !contract?.fields.includes(route.field)) {
    throw new TypeError('Unsupported Telegram menu setting field');
  }
  const version = Number(route.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('Telegram mutation callback requires a positive version');
  }
  return `ts1:e:${chainCode}:${ruleCode}:${fieldCode}:${version.toString(36)}`;
}

function encodeConnectionId(value) {
  const normalized = String(value ?? '');
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new TypeError('Telegram disconnect callback requires a connection id');
  }
  return BigInt(normalized).toString(36);
}

function parseConnectionId(value) {
  if (!/^[1-9a-z][0-9a-z]*$/.test(value || '')) return null;
  let parsed = 0n;
  for (const character of value) {
    parsed = parsed * 36n + BigInt(Number.parseInt(character, 36));
  }
  return parsed > 0n && parsed.toString(36) === value ? parsed.toString() : null;
}

function disconnectCallbackData(route) {
  const action = { 'confirm-disconnect': 'k', disconnect: 'd' }[route.kind];
  const version = Number(route.version);
  if (!action || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('Telegram disconnect callback requires a positive version');
  }
  return `ts1:${action}:${encodeConnectionId(route.connectionId)}:${version.toString(36)}`;
}

function callbackData(route) {
  if (route.kind === 'edit-rule-field') return editCallbackData(route);
  if (route.kind === 'confirm-disconnect' || route.kind === 'disconnect') {
    return disconnectCallbackData(route);
  }
  return catalogCallbackData(route);
}

function parseVersion(value) {
  if (!/^[1-9a-z][0-9a-z]*$/.test(value || '')) return null;
  const version = Number.parseInt(value, 36);
  return Number.isSafeInteger(version) && version > 0 && version.toString(36) === value
    ? version
    : null;
}

function findRuleKey(chain, code) {
  return Object.keys(RULE_CODES).find((key) => (
    RULE_CODES[key] === code && RULE_CONTRACTS[chain]?.[key]
  )) || null;
}

function parseProfileMutation(parts, chain) {
  const kinds = { p: 'toggle-profile', s: 'toggle-sparkline' };
  const version = parseVersion(parts[3]);
  return parts.length === 4 && kinds[parts[1]] && version
    ? { kind: kinds[parts[1]], chain, version }
    : null;
}

function parseRuleRoute(parts, chain) {
  const ruleKey = findRuleKey(chain, parts[3]);
  if (!ruleKey) return null;
  if (parts.length === 4 && parts[1] === 'r') {
    return { kind: 'rule', chain, ruleKey };
  }
  const field = FIELD_BY_CODE[parts[4]];
  const fieldVersion = parseVersion(parts[5]);
  if (parts.length === 6 && parts[1] === 'e' && field && fieldVersion
    && RULE_CONTRACTS[chain][ruleKey].fields.includes(field)) {
    return { kind: 'edit-rule-field', chain, ruleKey, field, version: fieldVersion };
  }
  const kinds = {
    t: 'toggle-rule',
    q: 'confirm-reset-rule',
    d: 'reset-rule',
  };
  const version = parseVersion(parts[4]);
  return parts.length === 5 && kinds[parts[1]] && version
    ? { kind: kinds[parts[1]], chain, ruleKey, version }
    : null;
}

function parseCallbackData(value) {
  const encoded = String(value || '');
  if (Buffer.byteLength(encoded, 'utf8') > 64) return null;
  const parts = encoded.split(':');
  if (parts[0] !== 'ts1') return null;
  const staticKind = { m: 'main', a: 'alerts', i: 'status', h: 'help' }[parts[1]];
  if (parts.length === 2 && staticKind) return { kind: staticKind };
  const disconnectKind = { k: 'confirm-disconnect', d: 'disconnect' }[parts[1]];
  const connectionId = parseConnectionId(parts[2]);
  const disconnectVersion = parseVersion(parts[3]);
  if (parts.length === 4 && disconnectKind && connectionId && disconnectVersion) {
    return { kind: disconnectKind, connectionId, version: disconnectVersion };
  }
  const connectionVersion = parseVersion(parts[2]);
  if (parts.length === 3 && parts[1] === 'u' && connectionVersion) {
    return { kind: 'toggle-connection', version: connectionVersion };
  }
  const chain = CHAIN_BY_CODE[parts[2]];
  if (parts.length === 3 && parts[1] === 'c' && chain) return { kind: 'chain', chain };
  if (!chain) return null;
  return parseProfileMutation(parts, chain) || parseRuleRoute(parts, chain);
}

function isMutationRoute(route) {
  return [
    'toggle-connection', 'toggle-profile', 'toggle-sparkline',
    'toggle-rule', 'reset-rule',
  ].includes(route?.kind);
}

function isInputRoute(route) {
  return route?.kind === 'edit-rule-field';
}

function isDisconnectRoute(route) {
  return route?.kind === 'disconnect';
}

function disconnectConfirmationRoute(connection) {
  const version = Number(connection?.version);
  try {
    encodeConnectionId(connection?.id);
  } catch (_) {
    return null;
  }
  return Number.isSafeInteger(version) && version > 0
    ? { kind: 'confirm-disconnect', connectionId: String(connection.id), version }
    : null;
}

function targetRoute(route) {
  if (route.kind === 'toggle-connection') return { kind: 'main' };
  return route.ruleKey
    ? { kind: 'rule', chain: route.chain, ruleKey: route.ruleKey }
    : { kind: 'chain', chain: route.chain };
}

function button(text, route) {
  return { text, callback_data: callbackData(route) };
}

function chainLabel(chain) {
  return chain === 'solana' ? 'Solana' : 'Robinhood';
}

function renderMain(context, t) {
  const profiles = context.profiles || [];
  const activeChains = profiles.filter((profile) => profile.enabled).map(
    (profile) => chainLabel(profile.chain)
  );
  const paused = context.connection?.status === 'paused';
  const statusLabel = {
    active: t('state.active'),
    paused: t('state.paused'),
    access_suspended: t('state.accessSuspended'),
    disconnected: t('state.disconnected'),
  }[context.connection?.status] || t('state.unavailable');
  const rows = [[button(t('button.alerts'), { kind: 'alerts' })]];
  const connectionVersion = context.connection?.version;
  if (
    ['active', 'paused'].includes(context.connection?.status)
    && Number.isSafeInteger(connectionVersion)
    && connectionVersion > 0
  ) {
    rows.push([button(paused ? t('button.resume') : t('button.pause'), {
      kind: 'toggle-connection', version: connectionVersion,
    })]);
  }
  rows.push([
    button(t('button.accountStatus'), { kind: 'status' }),
    button(t('button.help'), { kind: 'help' }),
  ]);
  const disconnectRoute = disconnectConfirmationRoute(context.connection);
  if (disconnectRoute) rows.push([button(t('button.disconnect'), disconnectRoute)]);
  return {
    text: [
      t('main.title'),
      '',
      `${t('main.status')}: ${statusLabel}`,
      `${t('main.networks')}: ${activeChains.join(', ') || `${t('common.none')} ❌`}`,
      `${t('main.sparkline')}: ${profiles.some((profile) => profile.sparkline_enabled) ? t('state.activeFeminine') : t('state.disabledFeminine')}`,
    ].join('\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

function formatTimestamp(value, t) {
  if (!value) return t('common.none');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('common.unavailable') : date.toISOString();
}

function renderStatus(context, t) {
  const connection = context.connection || {};
  const delivery = {
    active: t('state.deliveriesActive'),
    paused: t('state.deliveriesPaused'),
    access_suspended: t('state.deliveriesSuspended'),
    disconnected: t('state.deliveriesDisconnected'),
  }[connection.status] || t('state.deliveriesUnavailable');
  return {
    text: [
      t('status.title'),
      '',
      `${t('status.access')}: ${context.access?.hasProductAccess ? t('state.active') : `${t('common.unavailable')} ❌`}`,
      `${t('status.deliveries')}: ${delivery}`,
      `${t('status.lastDelivery')}: ${formatTimestamp(connection.last_delivery_at, t)}`,
      `${t('status.lastError')}: ${connection.last_error_code || t('common.none')}`,
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button(t('button.back'), { kind: 'main' })]] },
  };
}

function renderHelp(t) {
  return {
    text: [
      t('help.title'),
      '',
      t('help.configure'),
      t('help.edit'),
      t('help.pause'),
      t('help.status'),
      t('help.disconnect'),
      t('help.independent'),
    ].join('\n'),
    reply_markup: { inline_keyboard: [[button(t('button.back'), { kind: 'main' })]] },
  };
}

function renderDisconnectConfirmation(route, t) {
  return {
    text: [
      t('disconnect.title'),
      '',
      t('disconnect.delivery'),
      t('disconnect.preserved'),
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      [button(t('button.confirmDisconnect'), { ...route, kind: 'disconnect' })],
      [button(t('button.cancel'), { kind: 'main' })],
    ] },
  };
}

function renderAlerts(t) {
  return {
    text: `${t('alerts.title')}\n\n${t('alerts.chooseNetwork')}`,
    reply_markup: { inline_keyboard: [
      [
        button(t('button.solana'), { kind: 'chain', chain: 'solana' }),
        button(t('button.robinhood'), { kind: 'chain', chain: 'robinhood' }),
      ],
      [button(t('button.back'), { kind: 'main' })],
    ] },
  };
}

function renderChain(route, context, t) {
  const enabled = new Map((context.rules || []).map((rule) => [rule.rule_key, rule.enabled]));
  const rows = RULE_ORDER[route.chain].map((ruleKey) => {
    const marker = !enabled.has(ruleKey) ? '⚠️' : enabled.get(ruleKey) ? '✅' : '❌';
    return [button(
      `${marker} ${RULE_LABELS[ruleKey]}`,
      { kind: 'rule', chain: route.chain, ruleKey }
    )];
  });
  const profile = context.profile;
  if (Number.isSafeInteger(profile?.version) && profile.version > 0) {
    rows.push([
      button(profile.enabled ? t('button.deactivateNetwork') : t('button.activateNetwork'), {
        kind: 'toggle-profile', chain: route.chain, version: profile.version,
      }),
      button(profile.sparkline_enabled
        ? t('button.deactivateSparkline') : t('button.activateSparkline'), {
        kind: 'toggle-sparkline', chain: route.chain, version: profile.version,
      }),
    ]);
  }
  rows.push([button(t('button.back'), { kind: 'alerts' })]);
  return {
    text: [
      t('chain.title', { chain: chainLabel(route.chain) }),
      '',
      `${t('chain.network')}: ${!profile ? t('state.unavailable') : profile.enabled ? t('state.activeFeminine') : t('state.disabledFeminine')}`,
      `${t('chain.sparkline')}: ${profile?.sparkline_enabled ? t('state.activeFeminine') : t('state.disabledFeminine')}`,
      '',
      t('chain.chooseRule'),
    ].join('\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

function formatSetting(key, value, t) {
  const [labelKey, unit] = FIELD_LABELS[key] || [null, ''];
  const label = labelKey ? t(labelKey) : key;
  if (unit === '$') {
    return `${label}: $${Number(value).toLocaleString('en-US')}`;
  }
  return `${label}: ${value}${unit}`;
}

function renderRule(route, context, t) {
  const rule = context.rule;
  const settings = rule?.settings_json || {};
  const lines = Object.entries(settings)
    .filter(([key]) => key !== 'defaultsVersion')
    .map(([key, value]) => formatSetting(key, value, t));
  const rows = [];
  if (Number.isSafeInteger(rule?.version) && rule.version > 0) {
    rows.push([button(rule.enabled ? t('button.deactivate') : t('button.activate'), {
      kind: 'toggle-rule', chain: route.chain,
      ruleKey: route.ruleKey, version: rule.version,
    })]);
    rows.push([button(t('button.restoreDefaults'), {
      kind: 'confirm-reset-rule', chain: route.chain,
      ruleKey: route.ruleKey, version: rule.version,
    })]);
    for (const field of Object.keys(settings).filter((key) => key !== 'defaultsVersion')) {
      const labelKey = FIELD_LABELS[field]?.[0];
      rows.push([button(t('button.change', { field: labelKey ? t(labelKey) : field }), {
        kind: 'edit-rule-field',
        chain: route.chain,
        ruleKey: route.ruleKey,
        field,
        version: rule.version,
      })]);
    }
  }
  rows.push([button(t('button.back'), { kind: 'chain', chain: route.chain })]);
  return {
    text: [
      t('rule.title', {
        chain: chainLabel(route.chain), rule: RULE_LABELS[route.ruleKey],
      }),
      '',
      `${t('rule.state')}: ${!rule ? t('state.unavailable') : rule.enabled ? t('state.active') : t('state.disabled')}`,
      ...lines,
    ].join('\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

function renderResetConfirmation(route, t) {
  return {
    text: [
      t('rule.title', {
        chain: chainLabel(route.chain), rule: RULE_LABELS[route.ruleKey],
      }),
      '',
      t('reset.question'),
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      [button(t('button.confirmRestore'), {
        kind: 'reset-rule', chain: route.chain,
        ruleKey: route.ruleKey, version: route.version,
      })],
      [button(t('button.cancel'), {
        kind: 'rule', chain: route.chain, ruleKey: route.ruleKey,
      })],
    ] },
  };
}

function renderMenu(route, context = {}) {
  const { t } = createTelegramTranslator(
    context.languageCode || context.connection?.language_code
  );
  if (route.kind === 'main') return renderMain(context, t);
  if (route.kind === 'alerts') return renderAlerts(t);
  if (route.kind === 'status') return renderStatus(context, t);
  if (route.kind === 'help') return renderHelp(t);
  if (route.kind === 'confirm-disconnect') return renderDisconnectConfirmation(route, t);
  if (route.kind === 'chain') return renderChain(route, context, t);
  if (route.kind === 'rule') return renderRule(route, context, t);
  if (route.kind === 'confirm-reset-rule') return renderResetConfirmation(route, t);
  throw new TypeError('Unsupported Telegram menu route');
}

module.exports = {
  callbackData,
  disconnectConfirmationRoute,
  isDisconnectRoute,
  isInputRoute,
  isMutationRoute,
  parseCallbackData,
  renderMenu,
  targetRoute,
};
