const userAlertEvent = require('../models/user-alert-event');
const gmgnClaimAlertEvent = require('../models/gmgn-claim-alert-event');
const alertDeliveryCursor = require('../models/alert-delivery-cursor');
const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const {
  getBackendAlertRule,
  getDefaultDashboardAlertRuleKey,
  listBackendAlertRules,
} = require('./backend-alert-rules');
const { classifyTokenJunk } = require('./token-junk-metric');
const {
  buildBlockStatusSummary,
  buildEffectiveRiskLabel,
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
} = require('./token-risk-summary');
const { normalizeSocialLinkFields } = require('../utils/dex-social-links');

const DEFAULT_ALERT_FEED_LIMIT = 50;
const CHART_ALERT_EVENT_LIMIT = 500;
const CHART_ALERT_WINDOW_HOURS = 24;
const CHART_ALERT_RULE_KEYS = Object.freeze([
  'monitored-vol',
  'monitored-mcap',
  'hvnc',
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
  'meteora-surge',
  'custom-alert',
]);
const WRAPPED_SOL_ADDRESS = 'so11111111111111111111111111111111111111112';
const USDC_ADDRESS = 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v';
const USDT_ADDRESS = 'es9vmfrzacermjfrf4h2fyd4e5hvpdj8w6r9vwxzbdi';
const STABLE_CLAIM_FEE_QUOTES = new Set(['USD', 'USDC', 'USDT']);

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTextOrNull(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function normalizeAlertFeedLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ALERT_FEED_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(parsed), 200));
}

function normalizeAlertFeedMode(value) {
  return String(value || '').trim().toLowerCase() === 'unseen' ? 'unseen' : 'all';
}

function normalizeAlertFeedRuleKeys(value) {
  const inputs = Array.isArray(value)
    ? value
    : (value == null ? [] : [value]);

  return Array.from(new Set(inputs
    .flatMap((item) => String(item || '').split(','))
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)));
}

function resolveDashboardFeedRule(value) {
  const rule = getBackendAlertRule(value || getDefaultDashboardAlertRuleKey());
  if (rule && rule.dashboardFeedEnabled) {
    return rule;
  }

  const error = new Error('Unsupported dashboard alert rule key');
  error.code = 'UNSUPPORTED_ALERT_RULE';
  throw error;
}

function resolveDashboardFeedRules(value) {
  const explicitRuleKeys = normalizeAlertFeedRuleKeys(value);
  if (explicitRuleKeys.length === 0) {
    return listBackendAlertRules({ dashboardFeedEnabled: true });
  }

  return explicitRuleKeys.map((ruleKey) => resolveDashboardFeedRule(ruleKey));
}

function mapDeliveryCursor(cursor, rule) {
  return {
    ruleKey: rule.ruleKey,
    lastSeenEventId: cursor?.lastSeenEventId ?? null,
    lastAckedEventId: cursor?.lastAckedEventId ?? null,
    updatedAt: cursor?.updatedAt ?? null,
  };
}

function shouldSuppressHistoricalReplay(rule) {
  return rule?.historicalReplayEnabled === false;
}

async function bootstrapRealtimeOnlyCursor({ userId, rule, eventModel }) {
  if (userId == null) {
    return null;
  }

  const latestEventId = await eventModel.getLatestEventId({ ruleKey: rule.ruleKey });
  if (latestEventId != null) {
    return alertDeliveryCursor.markSeen(userId, rule.ruleKey, latestEventId);
  }

  return alertDeliveryCursor.getCursor(userId, rule.ruleKey);
}

function buildDashboardAlertEventCatalogPayload(catalogRow) {
  const meteora = catalogRow?.meteora || null;
  const socialLinks = normalizeSocialLinkFields({
    twitterUrl: catalogRow?.last_twitter_url,
    communityUrl: catalogRow?.last_community_url,
  });

  return {
    symbol: toTextOrNull(catalogRow?.symbol),
    name: toTextOrNull(catalogRow?.name),
    pairAddress: toTextOrNull(catalogRow?.last_pair_address),
    pairUrl: toTextOrNull(catalogRow?.last_pair_url),
    imageUrl: toTextOrNull(catalogRow?.last_image_url),
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    tokenCreatedAt: toNumberOrNull(catalogRow?.last_token_created_at_ms),
    priceChange1h: toNumberOrNull(catalogRow?.last_price_change_1h),
    priceChange6h: toNumberOrNull(catalogRow?.last_price_change_6h),
    volume1h: toNumberOrNull(catalogRow?.last_vol_1h),
    volume6h: toNumberOrNull(catalogRow?.last_vol_6h),
    volume24h: toNumberOrNull(catalogRow?.last_vol_24h),
    blockStatus: buildBlockStatusSummary(catalogRow),
    effectiveRiskLabel: buildEffectiveRiskLabel(catalogRow),
    riskReview: buildRiskReviewSummary(catalogRow),
    structuralRisk: buildStructuralRiskSummary(catalogRow),
    junkAssessment: classifyTokenJunk({
      ...catalogRow,
      meteora,
    }),
  };
}

async function loadDashboardCatalogRowsWithMeteora(addresses = []) {
  const metadataRows = await tokenCatalog.listDashboardMetadataByAddresses(addresses);
  const meteoraRows = await tokenMeteoraState.listSummaryByAddresses(addresses);
  const meteoraByAddress = new Map(meteoraRows.map((row) => [row.tokenAddress, row]));

  return metadataRows.map((row) => ({
    ...row,
    meteora: {
      noPool: !(meteoraByAddress.get(row.address)?.hasPool === true && (Number(meteoraByAddress.get(row.address)?.currentTvl) || 0) > 0),
      poolCount: Number(meteoraByAddress.get(row.address)?.poolCount) || 0,
      tvl: toNumberOrNull(meteoraByAddress.get(row.address)?.currentTvl),
    },
  }));
}

function normalizeObjectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function timestampSecondsToMs(value) {
  const createdTimestamp = toNumberOrNull(value);
  return createdTimestamp != null ? createdTimestamp * 1000 : null;
}

function buildDashboardGmgnClaimIdentityPayload(data, catalogRow) {
  return {
    symbol: toTextOrNull(data.symbol) ?? toTextOrNull(catalogRow?.symbol),
    name: toTextOrNull(data.name) ?? toTextOrNull(catalogRow?.name),
    imageUrl: toTextOrNull(data.logo) ?? toTextOrNull(catalogRow?.last_image_url),
    pairAddress: toTextOrNull(data.pool_address) ?? toTextOrNull(catalogRow?.last_pair_address),
    tokenCreatedAt: timestampSecondsToMs(data.created_timestamp) ?? toNumberOrNull(catalogRow?.last_token_created_at_ms),
  };
}

function buildDashboardGmgnClaimMetricPayload(data, catalogRow) {
  return {
    mcap: toNumberOrNull(data.usd_market_cap) ?? toNumberOrNull(data.market_cap) ?? toNumberOrNull(catalogRow?.last_mcap),
    volume1m: toNumberOrNull(data.volume_1m),
    volume1h: toNumberOrNull(data.volume_1h) ?? toNumberOrNull(catalogRow?.last_vol_1h),
    volume6h: toNumberOrNull(data.volume_6h) ?? toNumberOrNull(catalogRow?.last_vol_6h),
    volume24h: toNumberOrNull(data.volume_24h) ?? toNumberOrNull(catalogRow?.last_vol_24h),
  };
}

function normalizeClaimFeeQuoteAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveGmgnClaimQuoteSymbol(data) {
  const explicitSymbol = toTextOrNull(data.quote_symbol) ?? toTextOrNull(data.quoteSymbol);
  if (explicitSymbol) {
    return explicitSymbol.toUpperCase();
  }

  switch (normalizeClaimFeeQuoteAddress(data.quote_address ?? data.quoteAddress)) {
    case WRAPPED_SOL_ADDRESS:
      return 'SOL';
    case USDC_ADDRESS:
      return 'USDC';
    case USDT_ADDRESS:
      return 'USDT';
    default:
      return null;
  }
}

function readGmgnClaimQuoteFeeAmount(data) {
  return toNumberOrNull(data.claim_fee_quote_amount)
    ?? toNumberOrNull(data.claimFeeQuoteAmount)
    ?? toNumberOrNull(data.claim_fee_amount)
    ?? toNumberOrNull(data.claimFeeAmount)
    ?? toNumberOrNull(data.total_fee)
    ?? toNumberOrNull(data.totalFee);
}

function resolveGmgnClaimFeeAmount(data, quoteSymbol) {
  const solAmount = toNumberOrNull(data.claim_fee_sol_amount) ?? toNumberOrNull(data.claimFeeSolAmount);
  if (quoteSymbol === 'SOL') {
    return solAmount ?? readGmgnClaimQuoteFeeAmount(data);
  }

  return readGmgnClaimQuoteFeeAmount(data) ?? solAmount;
}

function buildDashboardGmgnClaimFeePayload(data, eventRow) {
  const quoteSymbol = resolveGmgnClaimQuoteSymbol(data);
  const claimFeeAmount = resolveGmgnClaimFeeAmount(data, quoteSymbol);
  const claimFeeUsd = STABLE_CLAIM_FEE_QUOTES.has(quoteSymbol || '')
    ? claimFeeAmount ?? toNumberOrNull(eventRow?.totalFeeUsd)
    : null;
  const legacyTotalFeeUsd = quoteSymbol ? null : toNumberOrNull(eventRow?.totalFeeUsd);

  return {
    claimFeeAmount,
    claimFeeCurrency: quoteSymbol,
    claimFeeUsd: claimFeeUsd ?? legacyTotalFeeUsd,
    quoteAddress: toTextOrNull(data.quote_address) ?? toTextOrNull(data.quoteAddress),
    totalFeeUsd: claimFeeUsd ?? legacyTotalFeeUsd,
  };
}

function buildDashboardGmgnClaimSignalPayload(eventRow, catalogRow) {
  const payload = normalizeObjectPayload(eventRow?.payload);
  const data = normalizeObjectPayload(payload.data);

  return {
    id: toNumberOrNull(eventRow?.id),
    kind: 'gmgn-claim-signal',
    ruleKey: eventRow?.ruleKey || 'gmgn-claim-signal',
    ...buildDashboardGmgnClaimIdentityPayload(data, catalogRow),
    ...buildDashboardGmgnClaimMetricPayload(data, catalogRow),
    signalType: toNumberOrNull(eventRow?.signalType),
    claimSequence: toNumberOrNull(eventRow?.claimSequence),
    claimId: toTextOrNull(eventRow?.claimId),
    ...buildDashboardGmgnClaimFeePayload(data, eventRow),
    claimedAt: toTextOrNull(eventRow?.claimedAt),
    source: toTextOrNull(eventRow?.source) || 'gmgn',
    label: toNumberOrNull(eventRow?.signalType) === 17 ? 'BAGS CLAIM' : 'PUMP CLAIM',
    payload,
    triggeredAt: toTextOrNull(eventRow?.triggeredAt),
  };
}

function normalizeUserAlertPayloadValue(payload, key, fallback = null) {
  return payload && Object.prototype.hasOwnProperty.call(payload, key)
    ? payload[key]
    : fallback;
}

function normalizeTickerPeersSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const items = Array.isArray(value.items)
    ? value.items
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const address = toTextOrNull(item.address);
        if (!address) {
          return null;
        }

        return {
          address,
          symbol: toTextOrNull(item.symbol),
          name: toTextOrNull(item.name),
          imageUrl: toTextOrNull(item.imageUrl),
          mcap: toNumberOrNull(item.mcap),
          tokenCreatedAt: toNumberOrNull(item.tokenCreatedAt),
          ageMsAtAlert: toNumberOrNull(item.ageMsAtAlert),
          matchType: toTextOrNull(item.matchType) === 'subticker' ? 'subticker' : 'exact',
        };
      })
      .filter(Boolean)
    : [];

  if (items.length <= 1) {
    return null;
  }

  const sourcePeerRole = toTextOrNull(value.sourcePeerRole);
  return {
    sourceSymbol: toTextOrNull(value.sourceSymbol),
    normalizedSymbol: toTextOrNull(value.normalizedSymbol),
    count: Math.max(items.length, Number(value.count) || 0),
    exactCount: toNumberOrNull(value.exactCount),
    subtickerCount: toNumberOrNull(value.subtickerCount),
    hasSubtickerMatch: Boolean(value.hasSubtickerMatch),
    sourcePeerRole: ['og', 'mcap_leader', 'peer_warning'].includes(sourcePeerRole) ? sourcePeerRole : null,
    oldestExactAddress: toTextOrNull(value.oldestExactAddress),
    highestMcapExactAddress: toTextOrNull(value.highestMcapExactAddress),
    items,
  };
}

function buildDashboardUserAlertIdentityPayload(payload, catalogRow) {
  const textField = (payloadKey, catalogKey) => (
    toTextOrNull(normalizeUserAlertPayloadValue(payload, payloadKey)) ?? toTextOrNull(catalogRow?.[catalogKey])
  );
  const socialLinks = normalizeSocialLinkFields({
    twitterUrl: textField('twitterUrl', 'last_twitter_url'),
    communityUrl: textField('communityUrl', 'last_community_url'),
  });
  return {
    address: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'address')) || toTextOrNull(catalogRow?.address) || '',
    symbol: textField('symbol', 'symbol'),
    name: textField('name', 'name'),
    pairAddress: textField('pairAddress', 'last_pair_address'),
    pairUrl: textField('pairUrl', 'last_pair_url'),
    imageUrl: textField('imageUrl', 'last_image_url'),
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    tokenCreatedAt: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'tokenCreatedAt')) ?? toNumberOrNull(catalogRow?.last_token_created_at_ms),
  };
}

function buildDashboardUserAlertMetricPayload(payload, catalogRow) {
  return {
    volume1m: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'volume1m')),
    volume5m: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'volume5m')),
    volume1h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'volume1h')) ?? toNumberOrNull(catalogRow?.last_vol_1h),
    volume6h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'volume6h')) ?? toNumberOrNull(catalogRow?.last_vol_6h),
    volume24h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'volume24h')) ?? toNumberOrNull(catalogRow?.last_vol_24h),
    priceChange1h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'priceChange1h')) ?? toNumberOrNull(catalogRow?.last_price_change_1h),
    priceChange6h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'priceChange6h')) ?? toNumberOrNull(catalogRow?.last_price_change_6h),
    prevVolume1m: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'prevVolume1m')),
    prevVolume5m: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'prevVolume5m')),
    prevMcap: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'prevMcap')),
    mcap: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'mcap')) ?? toNumberOrNull(catalogRow?.last_mcap),
    pct: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'pct')),
    label: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'label')),
    isHvnc: Boolean(normalizeUserAlertPayloadValue(payload, 'isHvnc')),
    isOldSurge: Boolean(normalizeUserAlertPayloadValue(payload, 'isOldSurge')),
    surgeWindow: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'surgeWindow')),
    ageBucket: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'ageBucket')),
    meteoraCurrentTvl: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'meteoraCurrentTvl')),
    meteoraBaselineTvl24h: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'meteoraBaselineTvl24h')),
    thresholdPct: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'thresholdPct')),
    customRuleId: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'customRuleId')),
    customColorHex: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customColorHex')),
    customTitle: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customTitle')),
    customMetric: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customMetric')),
    customOperator: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customOperator')),
    customTarget: normalizeUserAlertPayloadValue(payload, 'customTarget'),
    customRepeatMode: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customRepeatMode')),
    customExpires: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customExpires')),
    customFilters: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customFilters')),
    customSoundName: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customSoundName')),
    customSoundDataUrl: toTextOrNull(normalizeUserAlertPayloadValue(payload, 'customSoundDataUrl')),
    customCurrentValue: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'customCurrentValue')),
    customPreviousValue: toNumberOrNull(normalizeUserAlertPayloadValue(payload, 'customPreviousValue')),
    tickerPeers: normalizeTickerPeersSnapshot(normalizeUserAlertPayloadValue(payload, 'tickerPeers')),
  };
}

function buildDashboardUserAlertEventPayload(eventRow, catalogRow, rule) {
  const payload = eventRow?.payload && typeof eventRow.payload === 'object' && !Array.isArray(eventRow.payload)
    ? eventRow.payload
    : {};

  return {
    id: toNumberOrNull(eventRow?.id),
    kind: rule.kind,
    ruleKey: rule.ruleKey,
    ...buildDashboardUserAlertIdentityPayload(payload, catalogRow),
    ...buildDashboardUserAlertMetricPayload(payload, catalogRow),
    triggeredAt: toTextOrNull(eventRow?.triggeredAt),
  };
}

function buildDashboardAlertEventItem(eventRow, catalogRow, rule) {
  if (rule.scope === 'user-token') {
    return {
      ...buildDashboardAlertEventCatalogPayload(catalogRow),
      ...buildDashboardUserAlertEventPayload(eventRow, catalogRow, rule),
    };
  }

  if (rule.scope === 'global-signal') {
    return {
      address: toTextOrNull(eventRow?.tokenAddress) || '',
      ...buildDashboardAlertEventCatalogPayload(catalogRow),
      ...buildDashboardGmgnClaimSignalPayload(eventRow, catalogRow),
    };
  }

  return null;
}

async function buildDashboardAlertEventFromEvent(eventRow) {
  const rule = resolveDashboardFeedRule(eventRow?.ruleKey);
  const tokenAddress = toTextOrNull(eventRow?.tokenAddress);
  const metadataRows = tokenAddress
    ? await loadDashboardCatalogRowsWithMeteora([tokenAddress])
    : [];

  return buildDashboardAlertEventItem(eventRow, metadataRows[0] || null, rule);
}

function resolveAlertEventModel(rule) {
  if (rule.scope === 'user-token') {
    return userAlertEvent;
  }
  if (rule.scope === 'global-signal') {
    return gmgnClaimAlertEvent;
  }
  return null;
}

async function listDashboardAlertEvents(options = {}) {
  const limit = normalizeAlertFeedLimit(options.limit);
  const rule = resolveDashboardFeedRule(options.ruleKey);
  const mode = normalizeAlertFeedMode(options.mode);
  const eventModel = resolveAlertEventModel(rule);

  if (shouldSuppressHistoricalReplay(rule)) {
    const cursor = await bootstrapRealtimeOnlyCursor({ userId: options.userId, rule, eventModel });
    return {
      generatedAt: new Date().toISOString(),
      ruleKey: rule.ruleKey,
      kind: rule.kind,
      mode,
      cursor: mapDeliveryCursor(cursor, rule),
      count: 0,
      events: [],
    };
  }

  let cursor = options.userId == null ? null : await alertDeliveryCursor.getCursor(options.userId, rule.ruleKey);
  const hasExplicitAfterId = options.afterId != null && String(options.afterId).trim() !== '';
  let afterId = hasExplicitAfterId
    ? options.afterId
    : (mode === 'unseen' ? cursor?.lastSeenEventId : null);

  if (mode === 'unseen' && !hasExplicitAfterId && cursor == null && options.userId != null) {
    const latestEventFilters = { ruleKey: rule.ruleKey };
    if (rule.scope === 'user-token') {
      latestEventFilters.userId = options.userId;
    }

    const latestEventId = await eventModel.getLatestEventId(latestEventFilters);
    if (latestEventId != null) {
      cursor = await alertDeliveryCursor.markSeen(options.userId, rule.ruleKey, latestEventId);
      afterId = latestEventId;
    }
  }

  const eventFilters = {
    ruleKey: rule.ruleKey,
    limit,
    afterId,
    sort: afterId != null ? 'asc' : 'desc',
  };
  if (rule.scope === 'user-token') {
    eventFilters.userId = options.userId;
  }

  const events = await eventModel.listRecentEvents(eventFilters);
  const metadataRows = await loadDashboardCatalogRowsWithMeteora(events.map((item) => item.tokenAddress));
  const metadataByAddress = new Map(metadataRows.map((row) => [row.address, row]));

  return {
    generatedAt: new Date().toISOString(),
    ruleKey: rule.ruleKey,
    kind: rule.kind,
    mode,
    cursor: mapDeliveryCursor(cursor, rule),
    count: events.length,
    events: events.map((item) => buildDashboardAlertEventItem(item, metadataByAddress.get(item.tokenAddress) || null, rule)),
  };
}

async function listDashboardAlertFeeds(options = {}) {
  const rules = resolveDashboardFeedRules(options.ruleKeys);
  const mode = normalizeAlertFeedMode(options.mode);
  const listSingleFeed = module.exports.listDashboardAlertEvents || listDashboardAlertEvents;
  const feeds = await Promise.all(rules.map((rule) => listSingleFeed({
    ...options,
    ruleKey: rule.ruleKey,
  })));

  return {
    generatedAt: new Date().toISOString(),
    mode,
    count: feeds.reduce((sum, feed) => sum + (Number(feed?.count) || 0), 0),
    feeds,
  };
}

function buildDashboardChartAlertEvent(eventRow) {
  const rule = resolveDashboardFeedRule(eventRow?.ruleKey);
  const event = buildDashboardUserAlertEventPayload(eventRow, null, rule);
  return {
    ...event,
    address: toTextOrNull(eventRow?.tokenAddress) || event.address,
  };
}

async function listDashboardChartAlertEvents(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Valid chart alert reference time is required');
  }
  const cutoff = new Date(now.getTime() - (CHART_ALERT_WINDOW_HOURS * 60 * 60 * 1000));
  const rows = await userAlertEvent.listChartEvents({
    userId: options.userId,
    tokenAddress: options.tokenAddress,
    triggeredAfter: cutoff,
    ruleKeys: CHART_ALERT_RULE_KEYS,
    limit: CHART_ALERT_EVENT_LIMIT + 1,
  });
  const truncated = rows.length > CHART_ALERT_EVENT_LIMIT;
  const events = rows
    .slice(0, CHART_ALERT_EVENT_LIMIT)
    .map((row) => buildDashboardChartAlertEvent(row));

  return {
    generatedAt: now.toISOString(),
    windowHours: CHART_ALERT_WINDOW_HOURS,
    address: String(options.tokenAddress || '').trim(),
    count: events.length,
    truncated,
    events,
  };
}

async function updateDashboardAlertCursor(userId, payload = {}) {
  const rule = resolveDashboardFeedRule(payload.ruleKey);
  const cursor = await alertDeliveryCursor.upsertCursor({
    userId,
    ruleKey: rule.ruleKey,
    lastSeenEventId: payload.lastSeenEventId,
    lastAckedEventId: payload.lastAckedEventId,
  });

  return mapDeliveryCursor(cursor, rule);
}

module.exports = {
  CHART_ALERT_EVENT_LIMIT,
  CHART_ALERT_RULE_KEYS,
  CHART_ALERT_WINDOW_HOURS,
  DEFAULT_ALERT_FEED_LIMIT,
  buildDashboardAlertEventFromEvent,
  buildDashboardAlertEventItem,
  listDashboardAlertFeeds,
  listDashboardAlertEvents,
  listDashboardChartAlertEvents,
  normalizeAlertFeedLimit,
  normalizeAlertFeedMode,
  normalizeAlertFeedRuleKeys,
  resolveDashboardFeedRule,
  resolveDashboardFeedRules,
  updateDashboardAlertCursor,
  __private: {
    buildDashboardAlertEventCatalogPayload,
    buildDashboardGmgnClaimSignalPayload,
    buildDashboardUserAlertIdentityPayload,
    buildDashboardUserAlertMetricPayload,
    buildDashboardUserAlertEventPayload,
    buildDashboardChartAlertEvent,
    bootstrapRealtimeOnlyCursor,
    loadDashboardCatalogRowsWithMeteora,
    mapDeliveryCursor,
    resolveAlertEventModel,
    shouldSuppressHistoricalReplay,
    toNumberOrNull,
    toTextOrNull,
  },
};
