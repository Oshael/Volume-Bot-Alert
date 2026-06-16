const tokenAlertEvent = require('../models/token-alert-event');
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

function buildDashboardAlertEventDetectionPayload(eventRow, catalogRow, rule) {
  return {
    id: toNumberOrNull(eventRow?.id),
    kind: rule.kind,
    ruleKey: rule.ruleKey,
    mcap: toNumberOrNull(eventRow?.currentCloseMcap) ?? toNumberOrNull(catalogRow?.last_mcap),
    baselineTs: toTextOrNull(eventRow?.baselineTs),
    baselineMcap: toNumberOrNull(eventRow?.baselineMcap),
    windowLowMcap: toNumberOrNull(eventRow?.windowLowMcap),
    currentTs: toTextOrNull(eventRow?.currentTs),
    currentCloseMcap: toNumberOrNull(eventRow?.currentCloseMcap),
    dumpPct: toNumberOrNull(eventRow?.dumpPct),
    thresholdPct: toNumberOrNull(eventRow?.thresholdPct),
    tickerPeers: normalizeTickerPeersSnapshot(eventRow?.metadata?.tickerPeers),
    triggeredAt: toTextOrNull(eventRow?.triggeredAt),
  };
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
    totalFeeUsd: toNumberOrNull(eventRow?.totalFeeUsd),
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

  return {
    address: toTextOrNull(eventRow?.tokenAddress) || '',
    ...buildDashboardAlertEventCatalogPayload(catalogRow),
    ...buildDashboardAlertEventDetectionPayload(eventRow, catalogRow, rule),
  };
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
  return tokenAlertEvent;
}

async function listDashboardAlertEvents(options = {}) {
  const limit = normalizeAlertFeedLimit(options.limit);
  const rule = resolveDashboardFeedRule(options.ruleKey);
  const mode = normalizeAlertFeedMode(options.mode);
  const eventModel = resolveAlertEventModel(rule);
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
  DEFAULT_ALERT_FEED_LIMIT,
  buildDashboardAlertEventFromEvent,
  buildDashboardAlertEventItem,
  listDashboardAlertFeeds,
  listDashboardAlertEvents,
  normalizeAlertFeedLimit,
  normalizeAlertFeedMode,
  normalizeAlertFeedRuleKeys,
  resolveDashboardFeedRule,
  resolveDashboardFeedRules,
  updateDashboardAlertCursor,
  __private: {
    buildDashboardAlertEventCatalogPayload,
    buildDashboardAlertEventDetectionPayload,
    buildDashboardGmgnClaimSignalPayload,
    buildDashboardUserAlertIdentityPayload,
    buildDashboardUserAlertMetricPayload,
    buildDashboardUserAlertEventPayload,
    loadDashboardCatalogRowsWithMeteora,
    mapDeliveryCursor,
    resolveAlertEventModel,
    toNumberOrNull,
    toTextOrNull,
  },
};
