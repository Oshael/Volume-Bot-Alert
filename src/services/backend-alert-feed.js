const tokenAlertEvent = require('../models/token-alert-event');
const alertDeliveryCursor = require('../models/alert-delivery-cursor');
const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const { getBackendAlertRule, getDefaultDashboardAlertRuleKey } = require('./backend-alert-rules');
const { classifyTokenJunk } = require('./token-junk-metric');
const { buildRiskReviewSummary, buildStructuralRiskSummary } = require('./token-risk-summary');

const DEFAULT_ALERT_FEED_LIMIT = 50;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTextOrNull(value) {
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

function resolveDashboardFeedRule(value) {
  const rule = getBackendAlertRule(value || getDefaultDashboardAlertRuleKey());
  if (rule && rule.dashboardFeedEnabled) {
    return rule;
  }

  const error = new Error('Unsupported dashboard alert rule key');
  error.code = 'UNSUPPORTED_ALERT_RULE';
  throw error;
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

  return {
    symbol: toTextOrNull(catalogRow?.symbol),
    name: toTextOrNull(catalogRow?.name),
    pairAddress: toTextOrNull(catalogRow?.last_pair_address),
    pairUrl: toTextOrNull(catalogRow?.last_pair_url),
    imageUrl: toTextOrNull(catalogRow?.last_image_url),
    twitterUrl: toTextOrNull(catalogRow?.last_twitter_url),
    tokenCreatedAt: toNumberOrNull(catalogRow?.last_token_created_at_ms),
    volume1h: toNumberOrNull(catalogRow?.last_vol_1h),
    volume6h: toNumberOrNull(catalogRow?.last_vol_6h),
    volume24h: toNumberOrNull(catalogRow?.last_vol_24h),
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
    triggeredAt: toTextOrNull(eventRow?.triggeredAt),
  };
}

function buildDashboardAlertEventItem(eventRow, catalogRow, rule) {
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

async function listDashboardAlertEvents(options = {}) {
  const limit = normalizeAlertFeedLimit(options.limit);
  const rule = resolveDashboardFeedRule(options.ruleKey);
  const mode = normalizeAlertFeedMode(options.mode);
  let cursor = options.userId == null ? null : await alertDeliveryCursor.getCursor(options.userId, rule.ruleKey);
  const hasExplicitAfterId = options.afterId != null && String(options.afterId).trim() !== '';
  let afterId = hasExplicitAfterId
    ? options.afterId
    : (mode === 'unseen' ? cursor?.lastSeenEventId : null);

  if (mode === 'unseen' && !hasExplicitAfterId && cursor == null && options.userId != null) {
    const latestEventId = await tokenAlertEvent.getLatestEventId({ ruleKey: rule.ruleKey });
    if (latestEventId != null) {
      cursor = await alertDeliveryCursor.markSeen(options.userId, rule.ruleKey, latestEventId);
      afterId = latestEventId;
    }
  }

  const events = await tokenAlertEvent.listRecentEvents({
    ruleKey: rule.ruleKey,
    limit,
    afterId,
    sort: afterId != null ? 'asc' : 'desc',
  });
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
  listDashboardAlertEvents,
  normalizeAlertFeedLimit,
  normalizeAlertFeedMode,
  resolveDashboardFeedRule,
  updateDashboardAlertCursor,
  __private: {
    buildDashboardAlertEventCatalogPayload,
    buildDashboardAlertEventDetectionPayload,
    loadDashboardCatalogRowsWithMeteora,
    mapDeliveryCursor,
    toNumberOrNull,
    toTextOrNull,
  },
};
