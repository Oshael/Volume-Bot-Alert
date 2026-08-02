import { apiFetch } from './base';
import type { ApiResponseMetadata } from './response-metadata';
import type { CustomAlertCapabilityEntry, CustomAlertMetric, CustomAlertWindow, MonitoredSortCriterion } from '../../state/app-state';
import {
  createLegacyCompatibleTokenIdentity,
  normalizeTokenChain,
  type TokenChain,
} from '../../utils/token-chain';
import type {
  TokenMetricCoverageMap,
  TokenValuationSnapshot,
  TokenValuationType,
} from '../../utils/token-valuation';

export interface ReportMigratedTokenPayload {
  address: string;
  symbol?: string | null;
  name?: string | null;
  tokenCreatedAt?: number | null;
  mcap?: number | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  pairUrl?: string | null;
}

export function reportMigratedToken(payload: ReportMigratedTokenPayload, token?: string | null) {
  return apiFetch<{ message: string }>('/api/catalog/migrated', {
    method: 'POST',
    body: JSON.stringify({
      address: payload.address,
      source: 'pumpfun-migrated',
      chain: 'solana',
      symbol: payload.symbol ?? null,
      name: payload.name ?? null,
      tokenCreatedAt: payload.tokenCreatedAt ?? null,
      mcap: payload.mcap ?? null,
      imageUrl: payload.imageUrl ?? null,
      twitterUrl: payload.twitterUrl ?? null,
      pairUrl: payload.pairUrl ?? null,
      isActiveMonitorCandidate: true,
    }),
    token,
  });
}

export function trackManualToken(address: string, token?: string | null) {
  return apiFetch<{ message: string; tracked: { address: string }; bootstrapState?: 'scheduled' | 'evaluated' | null }>('/api/catalog/manual-track', {
    method: 'POST',
    body: JSON.stringify({ address }),
    token,
  });
}

export function adminBlockToken(address: string, label?: string | null, token?: string | null) {
  return apiFetch<{ message: string; blocked: { address: string; label?: string | null } }>('/api/catalog/admin-blocklist', {
    method: 'POST',
    body: JSON.stringify({ address, label: label ?? null }),
    token,
  });
}

export function adminUnblockToken(address: string, token?: string | null) {
  return apiFetch<{ message: string; address: string }>(`/api/catalog/admin-blocklist/${encodeURIComponent(address)}`, {
    method: 'DELETE',
    token,
  });
}

export interface EligibleCatalogToken {
  address: string;
  symbol?: string | null;
  name?: string | null;
  mcap?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
}

export interface DashboardMonitoredToken {
  chain: TokenChain;
  address: string;
  source?: string | null;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  pairDexId?: string | null;
  imageUrl?: string | null;
  launchpadId?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  eligibleForMonitoring?: boolean;
  monitorPriority?: string | null;
  mcap?: number | null;
  fdv?: number | null;
  valuationType?: TokenValuationType | null;
  valuation?: TokenValuationSnapshot | null;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  liquidityCoverage?: 'complete' | 'partial' | 'unavailable' | null;
  liquidityMarketCount?: number | null;
  valuedLiquidityMarketCount?: number | null;
  liquidityIsLowerBound?: boolean;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  historySortScore?: number | null;
  pinnedSortOrder?: number | null;
  filterMismatch?: string[];
  tokenCreatedAt?: number | null;
  tokenAgeProvenance?: string | null;
  catalogFirstSeenAt?: number | null;
  firstSeenAt?: string | null;
  prevMcap?: number | null;
  mcapDelta?: number | null;
  prevVolume5mCanonical?: number | null;
  volume5mBaselineAt?: string | null;
  volume5mWindowEnd?: string | null;
  volume5mDeltaCoverage?: 'complete' | 'partial' | 'unavailable' | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
  windowEnd?: string | null;
  lastActivityAt?: string | null;
  swaps5m?: number | null;
  swaps1h?: number | null;
  swaps6h?: number | null;
  swaps24h?: number | null;
  coverage?: TokenMetricCoverageMap;
  swapCoverage?: TokenMetricCoverageMap;
  priceChangeCoverage?: TokenMetricCoverageMap;
  activityState?: 'fresh' | 'stale' | 'unknown';
  riskState?: string | null;
  dataQuality?: string[];
  meteora?: MeteoraBatchItem | null;
  tickerPeers?: {
    chain?: TokenChain | null;
    sourceSymbol?: string | null;
    normalizedSymbol?: string | null;
    count?: number;
    exactCount?: number | null;
    subtickerCount?: number | null;
    hasSubtickerMatch?: boolean;
    sourcePeerRole?: 'og' | 'mcap_leader' | 'peer_warning' | null;
    oldestExactAddress?: string | null;
    highestMcapExactAddress?: string | null;
    items?: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      imageUrl?: string | null;
      mcap?: number | null;
      mcapStale?: boolean;
      mcapAgeMs?: number | null;
      tokenCreatedAt?: number | null;
      ageMsAtAlert?: number | null;
      matchType?: 'exact' | 'subticker' | null;
    }>;
  } | null;
}

export interface DashboardMonitoredPayload {
  generatedAt?: string | null;
  asOf?: string | null;
  source?: string | null;
  chains?: TokenChain[];
  minMcap?: number | null;
  maxMcap?: number | null;
  minFdv?: number | null;
  maxFdv?: number | null;
  coverage?: Partial<Record<TokenChain, string>>;
  tokens: DashboardMonitoredToken[];
  pinnedTokens?: DashboardMonitoredToken[];
  total?: number;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
}

export interface DashboardMonitoredPin {
  chain: TokenChain;
  address: string;
  sortOrder: number;
  pinnedAt?: string | null;
  updatedAt?: string | null;
}

export interface DashboardHistoryBucketRequest {
  page?: number;
  perPage?: number;
  searchQuery?: string;
  starredOnly?: boolean;
  sorts?: Array<{
    mode: 'vol' | 'mcap' | 'pchange' | 'age';
    window: '1h' | '6h' | '24h' | 'highest' | 'lowest' | 'newest' | 'oldest';
  }>;
  dismissedTokenIdentities?: string[];
  mcapMin?: number;
  mcapMax?: number;
  fdvMin?: number;
  fdvMax?: number;
  ageMinMinutes?: number;
  ageMaxMinutes?: number;
}

export interface DashboardHistoryBucketSlicePayload {
  total: number;
  page: number;
  perPage: number;
  count: number;
  hasMore?: boolean;
  tokens: DashboardMonitoredToken[];
  pinnedTokens?: DashboardMonitoredToken[];
}

export interface DashboardHistoryDebugProbeEntry {
  chain?: TokenChain | null;
  address: string;
  symbol?: string | null;
  included?: boolean;
  diagnosis?: string | null;
  rank?: number | null;
  historySortScore?: number | null;
  eligibleForMonitoring?: boolean | null;
  eligibilityState?: string | null;
  suppressedReason?: string | null;
  monitorPriority?: string | null;
  mcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  tokenCreatedAt?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
}

export interface DashboardHistoryBootstrapPayload {
  generatedAt?: string | null;
  asOf?: string | null;
  recent: DashboardHistoryBucketSlicePayload;
  oldWeek: DashboardHistoryBucketSlicePayload;
  debug?: {
    recentProbe?: DashboardHistoryDebugProbeEntry[];
  } | null;
}

export interface DashboardTopPerformerToken extends DashboardMonitoredToken {
  performanceRank?: number | null;
  performanceScore?: number | null;
}

export interface DashboardTopPerformersPayload {
  generatedAt?: string | null;
  source?: string | null;
  ranking?: string | null;
  minMcap?: number | null;
  minFdv?: number | null;
  minVol24h?: number | null;
  count: number;
  cached?: boolean;
  tokens: DashboardTopPerformerToken[];
}

function normalizeDashboardHistoryBucketSlice(
  slice: Partial<DashboardHistoryBucketSlicePayload> | null | undefined,
): DashboardHistoryBucketSlicePayload {
  return {
    total: Number(slice?.total) || 0,
    page: Number(slice?.page) || 0,
    perPage: Number(slice?.perPage) || 30,
    count: Number(slice?.count) || 0,
    hasMore: Boolean(slice?.hasMore),
    tokens: slice?.tokens || [],
    pinnedTokens: slice?.pinnedTokens || [],
  };
}

export interface DashboardAlertEvent {
  id: number;
  chain: TokenChain;
  kind?: string | null;
  ruleKey?: string | null;
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairDexId?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  launchpadId?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  tokenCreatedAt?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  valuationType?: TokenValuationType | null;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  transactions?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  volume1m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  volume5m?: number | null;
  prevVolume1m?: number | null;
  prevVolume5m?: number | null;
  prevMcap?: number | null;
  prevFdv?: number | null;
  pct?: number | null;
  label?: string | null;
  isHvnc?: boolean;
  isOldSurge?: boolean;
  surgeWindow?: '1H' | '6H' | null;
  ageBucket?: 'recent' | 'old-week' | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  thresholdPct?: number | null;
  customRuleId?: number | null;
  customColorHex?: string | null;
  customTitle?: string | null;
  customMetric?: string | null;
  customOperator?: string | null;
  customTarget?: string | number | null;
  customRepeatMode?: string | null;
  customExpires?: string | null;
  customFilters?: string | null;
  customSoundName?: string | null;
  customSoundDataUrl?: string | null;
  customCurrentValue?: number | null;
  customPreviousValue?: number | null;
  signalType?: number | null;
  claimSequence?: number | null;
  claimId?: string | null;
  claimFeeAmount?: number | null;
  claimFeeCurrency?: string | null;
  claimFeeUsd?: number | null;
  quoteAddress?: string | null;
  totalFeeUsd?: number | null;
  claimedAt?: string | null;
  triggeredAt?: string | null;
  tickerPeers?: {
    sourceSymbol?: string | null;
    normalizedSymbol?: string | null;
    count?: number;
    exactCount?: number | null;
    subtickerCount?: number | null;
    hasSubtickerMatch?: boolean;
    sourcePeerRole?: 'og' | 'mcap_leader' | 'peer_warning' | null;
    oldestExactAddress?: string | null;
    highestMcapExactAddress?: string | null;
    items?: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      imageUrl?: string | null;
      mcap?: number | null;
      mcapStale?: boolean;
      mcapAgeMs?: number | null;
      tokenCreatedAt?: number | null;
      ageMsAtAlert?: number | null;
      matchType?: 'exact' | 'subticker' | null;
    }>;
  } | null;
}

export interface DashboardAlertCursor {
  ruleKey?: string | null;
  chain?: TokenChain | null;
  lastSeenEventId?: number | null;
  lastAckedEventId?: number | null;
  updatedAt?: string | null;
}

export interface DashboardAlertEventsPayload {
  generatedAt?: string | null;
  kind?: string | null;
  ruleKey?: string | null;
  mode?: string | null;
  cursor?: DashboardAlertCursor | null;
  cursors?: DashboardAlertCursor[];
  count: number;
  events: DashboardAlertEvent[];
}

export interface DashboardAlertFeedsPayload {
  generatedAt?: string | null;
  mode?: string | null;
  count: number;
  feeds: DashboardAlertEventsPayload[];
}

export interface CustomAlertRule {
  id: number;
  userId?: number | null;
  chain: TokenChain;
  tokenAddress: string;
  title: string;
  metric: CustomAlertMetric;
  window: CustomAlertWindow;
  operator: 'cross_above' | 'cross_below';
  targetValue: number;
  colorHex?: string | null;
  soundName?: string | null;
  soundDataUrl?: string | null;
  expiresAt?: string | null;
  status: 'active' | 'triggered' | 'disabled';
  triggeredAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  metadata?: {
    baselinePrice?: number | null;
    baselineMcap?: number | null;
    baselineFdv?: number | null;
    baselineAt?: string | null;
  } | null;
}

export interface CreateCustomAlertRulePayload {
  chain: TokenChain;
  tokenAddress: string;
  title: string;
  metric: CustomAlertMetric;
  window: CustomAlertWindow;
  operator: 'cross_above' | 'cross_below';
  targetValue: number;
  colorHex?: string | null;
  soundName?: string | null;
  soundDataUrl?: string | null;
  expiresInHours?: number | null;
}

export interface ChartAlertEvent {
  id: number;
  chain: TokenChain;
  ruleKey: string;
  kind: string;
  address: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  pairUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  tokenCreatedAt?: number | null;
  triggeredAt: string;
  mcap: number | null;
  fdv?: number | null;
  valuationType?: TokenValuationType | null;
  pct: number | null;
  label: string | null;
  prevVolume1m?: number | null;
  volume1m?: number | null;
  prevVolume5m?: number | null;
  volume5m?: number | null;
  prevMcap?: number | null;
  prevFdv?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  thresholdPct?: number | null;
  customRuleId?: number | null;
  customColorHex?: string | null;
  customTitle?: string | null;
  customMetric?: string | null;
  customOperator?: string | null;
  customTarget?: string | number | null;
  customSoundDataUrl?: string | null;
  customCurrentValue?: number | null;
  customPreviousValue?: number | null;
  surgeWindow?: '1H' | '6H' | null;
  ageBucket?: 'recent' | 'old-week' | null;
}

export interface ChartAlertEventsPayload {
  generatedAt: string;
  chain: TokenChain;
  windowHours: number;
  address: string;
  count: number;
  truncated: boolean;
  events: ChartAlertEvent[];
}

export interface TokenSparklineItem {
  chain: TokenChain;
  address: string;
  valuationType?: TokenValuationType | null;
  resolution?: string | null;
  minuteStartsAt?: string | null;
  truncated?: boolean;
  pairAddress?: string | null;
  bucketCount?: number;
  coverageRatio?: number | null;
  effectiveHours?: number | null;
  granularityMinutes?: number | null;
  firstBucketAt?: string | null;
  latestBucketAt?: string | null;
  oneMinuteAvailable?: boolean;
  series: number[];
  candles?: TokenSparklineCandleItem[];
}

export interface TokenSparklineCandleItem {
  bucketTs: string;
  pairAddress?: string | null;
  granularityMinutes: number;
  sourceGranularityMinutes?: number | null;
  valuationType?: TokenValuationType | null;
  openMcap: number | null;
  highMcap: number | null;
  lowMcap: number | null;
  closeMcap: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number | null;
  openFdvUsd?: number | null;
  highFdvUsd?: number | null;
  lowFdvUsd?: number | null;
  closeFdvUsd?: number | null;
  openPriceUsd?: number | null;
  highPriceUsd?: number | null;
  lowPriceUsd?: number | null;
  closePriceUsd?: number | null;
  sampleCount: number;
  activity?: {
    volumeUsd: number | null;
    swaps: number | null;
    buys: number | null;
    sells: number | null;
    transactionContributions: number | null;
    marketCount: number | null;
    protocols: string[];
  } | null;
}

export interface TokenSparklinesPayload {
  generatedAt?: string | null;
  chains?: TokenChain[];
  hours?: number | null;
  allAvailable?: boolean;
  points?: number;
  granularityMinutes?: number | null;
  count: number;
  items: TokenSparklineItem[];
}

export interface ExpandedTokenSparklinePayload {
  generatedAt?: string | null;
  chain?: TokenChain;
  valuationType?: TokenValuationType | null;
  resolution?: string | null;
  minuteStartsAt?: string | null;
  allAvailable?: boolean;
  points?: number;
  granularityMinutes?: number | null;
  count: number;
  item: TokenSparklineItem | null;
}

function toFiniteNumberOrNull(value: unknown) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumberOrZero(value: unknown) {
  return toFiniteNumberOrNull(value) ?? 0;
}

function normalizeTokenSparklineSeries(series: unknown) {
  if (!Array.isArray(series)) {
    return [];
  }

  return series
    .map(toFiniteNumberOrNull)
    .filter((value): value is number => value != null);
}

function normalizeTokenSparklineCandles(candles: unknown): TokenSparklineCandleItem[] {
  if (!Array.isArray(candles)) {
    return [];
  }

  const normalized: TokenSparklineCandleItem[] = [];
  for (const item of candles) {
    const candle = item as Record<string, unknown>;
    const bucketTs = typeof candle.bucketTs === 'string' ? candle.bucketTs : '';
    if (!bucketTs) {
      continue;
    }

    normalized.push({
      bucketTs,
      pairAddress: typeof candle.pairAddress === 'string' ? candle.pairAddress : null,
      granularityMinutes: toFiniteNumberOrZero(candle.granularityMinutes),
      sourceGranularityMinutes: toFiniteNumberOrNull(candle.sourceGranularityMinutes),
      valuationType: candle.valuationType === 'fdv' || candle.valuationType === 'market-cap'
        ? candle.valuationType
        : null,
      openMcap: toFiniteNumberOrNull(candle.openMcap),
      highMcap: toFiniteNumberOrNull(candle.highMcap),
      lowMcap: toFiniteNumberOrNull(candle.lowMcap),
      closeMcap: toFiniteNumberOrNull(candle.closeMcap),
      openPrice: toFiniteNumberOrNull(candle.openPrice),
      highPrice: toFiniteNumberOrNull(candle.highPrice),
      lowPrice: toFiniteNumberOrNull(candle.lowPrice),
      closePrice: toFiniteNumberOrNull(candle.closePrice),
      openFdvUsd: toFiniteNumberOrNull(candle.openFdvUsd),
      highFdvUsd: toFiniteNumberOrNull(candle.highFdvUsd),
      lowFdvUsd: toFiniteNumberOrNull(candle.lowFdvUsd),
      closeFdvUsd: toFiniteNumberOrNull(candle.closeFdvUsd),
      openPriceUsd: toFiniteNumberOrNull(candle.openPriceUsd),
      highPriceUsd: toFiniteNumberOrNull(candle.highPriceUsd),
      lowPriceUsd: toFiniteNumberOrNull(candle.lowPriceUsd),
      closePriceUsd: toFiniteNumberOrNull(candle.closePriceUsd),
      sampleCount: toFiniteNumberOrZero(candle.sampleCount),
      activity: candle.activity && typeof candle.activity === 'object'
        ? {
          volumeUsd: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).volumeUsd),
          swaps: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).swaps),
          buys: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).buys),
          sells: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).sells),
          transactionContributions: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).transactionContributions),
          marketCount: toFiniteNumberOrNull((candle.activity as Record<string, unknown>).marketCount),
          protocols: Array.isArray((candle.activity as Record<string, unknown>).protocols)
            ? ((candle.activity as Record<string, unknown>).protocols as unknown[]).map(String)
            : [],
        }
        : null,
    });
  }

  return normalized;
}

function normalizeTokenSparklineItem(
  item: TokenSparklineItem,
  fallbackGranularityMinutes: number,
  fallbackChain: TokenChain = 'solana',
): TokenSparklineItem {
  return {
    chain: normalizeTokenChain(item.chain) ?? fallbackChain,
    address: item.address,
    valuationType: item.valuationType ?? null,
    resolution: item.resolution ?? null,
    minuteStartsAt: item.minuteStartsAt ?? null,
    truncated: item.truncated === true,
    pairAddress: item.pairAddress ?? null,
    bucketCount: Number(item.bucketCount) || 0,
    coverageRatio: item.coverageRatio ?? null,
    effectiveHours: item.effectiveHours ?? null,
    granularityMinutes: Number(item.granularityMinutes) || fallbackGranularityMinutes,
    firstBucketAt: item.firstBucketAt ?? null,
    latestBucketAt: item.latestBucketAt ?? null,
    oneMinuteAvailable: Boolean(item.oneMinuteAvailable),
    series: normalizeTokenSparklineSeries(item.series),
    candles: normalizeTokenSparklineCandles(item.candles),
  };
}

export interface BidZoneCandidate {
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  monitorPriority?: string | null;
  mcap?: number | null;
  catalogMcap?: number | null;
  windowMcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  supportLevelMcap?: number | null;
  resistanceLevelMcap?: number | null;
  robustRangePct?: number | null;
  recentRangePct?: number | null;
  closeDriftPct?: number | null;
  supportDistancePct?: number | null;
  resistanceDistancePct?: number | null;
  supportTouchClusters?: number;
  coverageRatio?: number | null;
  bucketCount?: number;
  sampleCount?: number;
  expectedBucketCount?: number;
  ageHours?: number | null;
  requestedHours?: number;
  minimumWindowHours?: number;
  windowHoursUsed?: number;
  score?: number | null;
}

export interface BidZonePayload {
  generatedAt?: string | null;
  runId?: number | null;
  requestedHours?: number;
  minMcap?: number;
  minVol1h?: number;
  minVol24h?: number;
  candidateCount?: number;
  resultCount?: number;
  refreshAvailableAt?: string | null;
  refreshed?: boolean;
  retryAfterSeconds?: number;
  count: number;
  candidates: BidZoneCandidate[];
}

export interface MeteoraBatchItem {
  address: string;
  tvl?: number | null;
  poolAddress?: string | null;
  poolCount?: number;
  lastCheckedAt?: string | null;
  lastSnapshotAt?: string | null;
  change1h?: number | null;
  change4h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  volume1h?: number | null;
  volume4h?: number | null;
  volume24h?: number | null;
  noPool?: boolean;
}

const FRONTEND_MONITORED_MIN_MCAP = 30_000;

export function fetchEligibleCatalog(token?: string | null) {
  return apiFetch<{
    tokens: Array<{
      address: string;
      symbol?: string | null;
      name?: string | null;
      mcap?: number | null;
      lastSeenAt?: string | null;
      lastEvaluatedAt?: string | null;
    }>;
  }>(`/api/catalog/eligible?minMcap=${FRONTEND_MONITORED_MIN_MCAP}`, { token })
    .then((response) => response.tokens.map((item) => ({
      address: item.address,
      symbol: item.symbol ?? null,
      name: item.name ?? null,
      mcap: item.mcap ?? null,
      lastSeenAt: item.lastSeenAt ?? null,
      lastEvaluatedAt: item.lastEvaluatedAt ?? null,
    })));
}

export interface DashboardMonitoredRequestOptions {
  chains?: TokenChain[];
  page?: number;
  perPage?: number;
  sorts?: MonitoredSortCriterion[];
  minMcap?: number;
  maxMcap?: number;
  minFdv?: number;
  maxFdv?: number;
  asOf?: string;
  priority?: boolean;
}

function setMonitoredSnapshotQuery(
  query: URLSearchParams,
  options?: DashboardMonitoredRequestOptions,
) {
  const asOf = String(options?.asOf || '').trim();
  if (asOf) query.set('asOf', asOf);
  if (options?.priority === true) query.set('priority', 'true');
}

function setMonitoredValuationQuery(
  query: URLSearchParams,
  options?: DashboardMonitoredRequestOptions,
) {
  const values: Array<[string, number | undefined]> = [
    ['minMcap', options?.minMcap],
    ['maxMcap', options?.maxMcap],
    ['minFdv', options?.minFdv],
    ['maxFdv', options?.maxFdv],
  ];
  for (const [key, value] of values) {
    if (value != null) query.set(key, String(Math.max(0, Number(value) || 0)));
  }
}

export function fetchDashboardMonitored(
  token?: string | null,
  options?: DashboardMonitoredRequestOptions,
) {
  const query = new URLSearchParams();
  if (options?.chains?.length) {
    query.set('chains', options.chains.join(','));
  }
  if (options?.page != null) {
    query.set('page', String(Math.max(0, Math.trunc(options.page))));
  }
  if (options?.perPage != null) {
    query.set('perPage', String(Math.min(100, Math.max(1, Math.trunc(options.perPage)))));
  }
  if (Array.isArray(options?.sorts) && options.sorts.length > 0) {
    query.set('sorts', JSON.stringify(options.sorts));
  }
  setMonitoredValuationQuery(query, options);
  setMonitoredSnapshotQuery(query, options);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch<DashboardMonitoredPayload>(`/api/dashboard/monitored${suffix}`, {
    token,
    rateLimitScope: 'dashboard',
  })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      asOf: response.asOf ?? response.generatedAt ?? null,
      tokens: response.tokens || [],
      pinnedTokens: response.pinnedTokens || [],
      total: Number(response.total) || 0,
      page: Number(response.page) || 0,
      perPage: Number(response.perPage) || 0,
      hasMore: Boolean(response.hasMore),
    }));
}

export type TickerPeerListItem = NonNullable<NonNullable<DashboardMonitoredToken['tickerPeers']>['items']>[number];

export interface TickerPeerListPayload {
  chain: TokenChain;
  address: string;
  count: number;
  exactCount?: number | null;
  oldestExactAddress?: string | null;
  highestMcapExactAddress?: string | null;
  items: TickerPeerListItem[];
}

/** Full peer list for one token, fetched only when the user opens the panel. */
export function fetchTickerPeers(chain: TokenChain, address: string, token?: string | null) {
  const query = new URLSearchParams({ chain });
  return apiFetch<TickerPeerListPayload>(
    `/api/catalog/ticker-peers/${encodeURIComponent(address)}?${query}`,
    { token }
  );
}

export function fetchMonitoredPins(token?: string | null, chains: TokenChain[] = ['solana']) {
  const query = new URLSearchParams({ chains: chains.join(',') });
  return apiFetch<{ pinnedTokens: DashboardMonitoredPin[] }>(`/api/dashboard/monitored-pins?${query}`, { token })
    .then((response) => response.pinnedTokens || []);
}

export function saveMonitoredPins(
  pinnedTokens: DashboardMonitoredPin[],
  token?: string | null,
  requestedChains?: TokenChain[],
) {
  const chains = requestedChains?.length
    ? [...new Set(requestedChains)]
    : [...new Set(pinnedTokens.map((item) => item.chain))];
  return apiFetch<{ pinnedTokens: DashboardMonitoredPin[] }>('/api/dashboard/monitored-pins', {
    method: 'PUT',
    body: JSON.stringify({ chains, pinnedTokens }),
    token,
  }).then((response) => response.pinnedTokens || []);
}

export function removeMonitoredPin(chain: TokenChain, address: string, token?: string | null) {
  const query = new URLSearchParams({ chain });
  return apiFetch<{ removed: boolean }>(`/api/dashboard/monitored-pins/${encodeURIComponent(address)}?${query}`, {
    method: 'DELETE',
    token,
  });
}

export function resetMonitoredPins(token?: string | null, chains: TokenChain[] = ['solana']) {
  const query = new URLSearchParams({ chains: chains.join(',') });
  return apiFetch<{ removed: number }>(`/api/dashboard/monitored-pins?${query}`, {
    method: 'DELETE',
    token,
  });
}

export function fetchMonitoredMetadataBatch(
  addresses: string[],
  token?: string | null,
  options?: { includeMeteora?: boolean; onResponse?: (metadata: ApiResponseMetadata) => void },
) {
  return apiFetch<{
    generatedAt?: string | null;
    count: number;
    tokens: DashboardMonitoredToken[];
  }>('/api/catalog/monitored-metadata-batch', {
    method: 'POST',
    body: JSON.stringify({
      addresses,
      includeMeteora: options?.includeMeteora ?? true,
    }),
    token,
    onResponse: options?.onResponse,
  }).then((response) => response.tokens || []);
}

export function fetchDashboardHistoryBootstrap(
  payload: {
    chains?: TokenChain[];
    starredTokenIdentities?: string[];
    recent?: DashboardHistoryBucketRequest;
    oldWeek?: DashboardHistoryBucketRequest;
    recentPinnedIdentities?: string[];
    oldWeekPinnedIdentities?: string[];
    recentDebugProbeIdentities?: string[];
  },
  token?: string | null,
) {
  return apiFetch<DashboardHistoryBootstrapPayload>('/api/dashboard/history-bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      chains: payload.chains ?? ['solana'],
      starredTokenIdentities: payload.starredTokenIdentities ?? [],
      recent: payload.recent ?? {},
      oldWeek: payload.oldWeek ?? {},
      recentPinnedIdentities: payload.recentPinnedIdentities ?? [],
      oldWeekPinnedIdentities: payload.oldWeekPinnedIdentities ?? [],
      recentDebugProbeIdentities: payload.recentDebugProbeIdentities ?? [],
    }),
    token,
    rateLimitScope: 'dashboard',
  }).then((response) => ({
    generatedAt: response.generatedAt ?? response.asOf ?? null,
    asOf: response.asOf ?? response.generatedAt ?? null,
    recent: normalizeDashboardHistoryBucketSlice(response.recent),
    oldWeek: normalizeDashboardHistoryBucketSlice(response.oldWeek),
    debug: response.debug ?? null,
  }));
}

export function fetchDashboardTopPerformers(
  token?: string | null,
  options?: {
    chains?: TokenChain[];
    limit?: number;
    minMcap?: number;
    minFdv?: number;
    minVol24h?: number;
  },
) {
  const query = new URLSearchParams();
  if (options?.chains?.length) {
    query.set('chains', options.chains.join(','));
  }
  if (options?.limit != null) {
    query.set('limit', String(Math.max(1, Math.trunc(options.limit))));
  }
  if (options?.minMcap != null) {
    query.set('minMcap', String(Math.max(0, Number(options.minMcap) || 0)));
  }
  if (options?.minFdv != null) {
    query.set('minFdv', String(Math.max(0, Number(options.minFdv) || 0)));
  }
  if (options?.minVol24h != null) {
    query.set('minVol24h', String(Math.max(0, Number(options.minVol24h) || 0)));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return apiFetch<DashboardTopPerformersPayload>(`/api/dashboard/top-performers${suffix}`, {
    token,
    rateLimitScope: 'dashboard',
  })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      source: response.source ?? null,
      ranking: response.ranking ?? null,
      minMcap: response.minMcap ?? null,
      minFdv: response.minFdv ?? null,
      minVol24h: response.minVol24h ?? null,
      count: Number(response.count) || 0,
      cached: Boolean(response.cached),
      tokens: Array.isArray(response.tokens) ? response.tokens.map((item) => ({
        ...item,
        performanceRank: item.performanceRank == null ? null : Number(item.performanceRank),
        performanceScore: item.performanceScore == null ? null : Number(item.performanceScore),
      })) : [],
    }));
}

export function fetchMarketTicker(token?: string | null) {
  return apiFetch<{
    generatedAt?: string | null;
    stale?: boolean;
    items?: Array<{ symbol?: string; priceUsd?: number; change24hPct?: number }>;
  }>('/api/dashboard/market-ticker', {
    token,
    rateLimitScope: 'market-ticker',
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    stale: Boolean(response.stale),
    items: (response.items || []).flatMap((item) => {
      const priceUsd = Number(item.priceUsd);
      const change24hPct = Number(item.change24hPct);
      return item.symbol && Number.isFinite(priceUsd) && Number.isFinite(change24hPct)
        ? [{ symbol: item.symbol, priceUsd, change24hPct }]
        : [];
    }),
  }));
}

function buildTokenSparklinesRequestBody(
  identities: ReturnType<typeof createLegacyCompatibleTokenIdentity>[],
  options?: {
    hours?: number;
    points?: number;
    granularityMinutes?: number;
    allAvailable?: boolean;
    allowOneMinuteFallback?: boolean;
  },
) {
  const allAvailable = options?.allAvailable === true;
  return {
    identities: identities.map(({ chain, address }) => ({ chain, address })),
    hours: allAvailable ? undefined : (options?.hours ?? (14 * 24)),
    points: options?.points ?? (allAvailable ? 500 : 336),
    granularityMinutes: allAvailable ? 60 : (options?.granularityMinutes ?? 30),
    allAvailable,
    allowOneMinuteFallback: options?.allowOneMinuteFallback ?? false,
  };
}

export function fetchTokenSparklines(
  identities: Array<string | { chain?: TokenChain | null; address: string }>,
  options?: {
    hours?: number;
    points?: number;
    granularityMinutes?: number;
    allAvailable?: boolean;
    allowOneMinuteFallback?: boolean;
    signal?: AbortSignal;
    onResponse?: (metadata: ApiResponseMetadata) => void;
  },
  token?: string | null,
) {
  const normalizedIdentities = identities.map((identity) => (
    typeof identity === 'string'
      ? createLegacyCompatibleTokenIdentity('solana', identity)
      : createLegacyCompatibleTokenIdentity(identity.chain, identity.address)
  ));
  return apiFetch<TokenSparklinesPayload>('/api/catalog/sparklines', {
    method: 'POST',
    body: JSON.stringify(buildTokenSparklinesRequestBody(normalizedIdentities, options)),
    token,
    signal: options?.signal,
    onResponse: options?.onResponse,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    chains: Array.isArray(response.chains)
      ? response.chains.map(normalizeTokenChain).filter((chain): chain is TokenChain => Boolean(chain))
      : [],
    hours: response.allAvailable ? null : (Number(response.hours) || (14 * 24)),
    allAvailable: response.allAvailable === true,
    points: Number(response.points) || (response.allAvailable ? 500 : 336),
    granularityMinutes: Number(response.granularityMinutes) || (response.allAvailable ? 60 : 30),
    count: Number(response.count) || 0,
    items: Array.isArray(response.items)
      ? response.items.map((item) => normalizeTokenSparklineItem(
        item,
        Number(response.granularityMinutes) || 30,
      ))
      : [],
  }));
}

export function fetchExpandedTokenSparkline(
  address: string,
  options?: {
    chain?: TokenChain | null;
    points?: number;
    granularityMinutes?: number;
    allowOneMinuteFallback?: boolean;
    allAvailable?: boolean;
  },
  token?: string | null,
) {
  const identity = createLegacyCompatibleTokenIdentity(options?.chain, address);
  const body: {
    chain: TokenChain;
    address: string;
    points: number;
    granularityMinutes?: number;
    allowOneMinuteFallback?: boolean;
    allAvailable?: boolean;
  } = {
    chain: identity.chain,
    address: identity.address,
    points: options?.points ?? 720,
  };
  if (options?.granularityMinutes != null) {
    body.granularityMinutes = options.granularityMinutes;
  }
  if (options?.allowOneMinuteFallback != null) {
    body.allowOneMinuteFallback = options.allowOneMinuteFallback;
  }
  if (options?.allAvailable != null) {
    body.allAvailable = options.allAvailable;
  }

  return apiFetch<ExpandedTokenSparklinePayload>('/api/catalog/sparklines/expanded', {
    method: 'POST',
    body: JSON.stringify(body),
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    chain: normalizeTokenChain(response.chain) ?? identity.chain,
    valuationType: response.valuationType ?? null,
    resolution: response.resolution ?? null,
    minuteStartsAt: response.minuteStartsAt ?? null,
    allAvailable: response.allAvailable === true,
    points: Number(response.points) || 720,
    granularityMinutes: Number(response.granularityMinutes) || null,
    count: Number(response.count) || 0,
    item: response.item
      ? normalizeTokenSparklineItem(response.item, 30, identity.chain)
      : null,
  }));
}

export function fetchMeteoraBatch(addresses: string[], token?: string | null) {
  return apiFetch<{ count?: number; items?: MeteoraBatchItem[] }>('/api/catalog/meteora/batch', {
    method: 'POST',
    body: JSON.stringify({ addresses }),
    token,
  }).then((response) => response.items || []);
}

export function fetchDashboardAlertEvents(token?: string | null, options?: { limit?: number; ruleKey?: string; mode?: string; afterId?: number; chains?: TokenChain[] }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.ruleKey) {
    params.set('ruleKey', String(options.ruleKey));
  }
  if (options?.mode) {
    params.set('mode', String(options.mode));
  }
  if (options?.afterId) {
    params.set('afterId', String(options.afterId));
  }
  if (Array.isArray(options?.chains) && options.chains.length > 0) {
    params.set('chains', options.chains.join(','));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<DashboardAlertEventsPayload>(`/api/dashboard/alert-events${suffix}`, {
    token,
    rateLimitScope: 'dashboard',
  })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      kind: response.kind ?? null,
      ruleKey: response.ruleKey ?? null,
      mode: response.mode ?? null,
      cursor: response.cursor ?? null,
      cursors: response.cursors ?? [],
      count: Number(response.count) || 0,
      events: response.events || [],
    }));
}

export function fetchDashboardAlertFeeds(token?: string | null, options?: { limit?: number; mode?: string; ruleKeys?: string[]; chains?: TokenChain[] }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  if (options?.mode) {
    params.set('mode', String(options.mode));
  }
  if (Array.isArray(options?.ruleKeys) && options.ruleKeys.length > 0) {
    params.set('ruleKeys', options.ruleKeys.join(','));
  }
  if (Array.isArray(options?.chains) && options.chains.length > 0) {
    params.set('chains', options.chains.join(','));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<DashboardAlertFeedsPayload>(`/api/dashboard/alert-feeds${suffix}`, {
    token,
    rateLimitScope: 'dashboard',
  })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      mode: response.mode ?? null,
      count: Number(response.count) || 0,
      feeds: Array.isArray(response.feeds)
        ? response.feeds.map((feed) => ({
            generatedAt: feed.generatedAt ?? null,
            kind: feed.kind ?? null,
            ruleKey: feed.ruleKey ?? null,
            mode: feed.mode ?? null,
            cursor: feed.cursor ?? null,
            cursors: feed.cursors ?? [],
            count: Number(feed.count) || 0,
            events: feed.events || [],
          }))
        : [],
    }));
}

export function createCustomAlertRule(payload: CreateCustomAlertRulePayload, token?: string | null) {
  return apiFetch<{ rule: CustomAlertRule }>('/api/dashboard/custom-alert-rules', {
    method: 'POST',
    body: JSON.stringify(payload),
    token,
  });
}

export function fetchCustomAlertRules(token?: string | null, options?: { chains?: TokenChain[] }) {
  const params = new URLSearchParams();
  if (Array.isArray(options?.chains) && options.chains.length > 0) {
    params.set('chains', options.chains.join(','));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<{
    rules: CustomAlertRule[];
    count: number;
    capabilities?: Partial<Record<TokenChain, CustomAlertCapabilityEntry>>;
  }>(`/api/dashboard/custom-alert-rules${suffix}`, { token });
}

export function updateCustomAlertRule(id: number, payload: CreateCustomAlertRulePayload, token?: string | null) {
  return apiFetch<{ rule: CustomAlertRule }>(`/api/dashboard/custom-alert-rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
    token,
  });
}

export function disableCustomAlertRule(id: number, chain: TokenChain, token?: string | null) {
  const query = new URLSearchParams({ chain });
  return apiFetch<{ rule: CustomAlertRule; disabled: boolean }>(`/api/dashboard/custom-alert-rules/${id}?${query.toString()}`, {
    method: 'DELETE',
    token,
  });
}

export function fetchDashboardChartAlertEvents(chain: TokenChain, address: string, token?: string | null) {
  const query = new URLSearchParams({ chain, address: String(address || '').trim() });
  return apiFetch<ChartAlertEventsPayload>(`/api/dashboard/chart-alert-events?${query.toString()}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt,
      chain: response.chain,
      windowHours: Number(response.windowHours) || 24,
      address: response.address,
      count: Number(response.count) || 0,
      truncated: Boolean(response.truncated),
      events: Array.isArray(response.events) ? response.events : [],
    }));
}

export function updateDashboardAlertCursor(
  payload: { ruleKey?: string | null; chain: TokenChain; lastSeenEventId?: number | null; lastAckedEventId?: number | null },
  token?: string | null
) {
  return apiFetch<{
    cursor?: DashboardAlertCursor | null;
  }>('/api/dashboard/alert-events/cursor', {
    method: 'POST',
    body: JSON.stringify({
      ruleKey: payload.ruleKey ?? null,
      chain: payload.chain,
      lastSeenEventId: payload.lastSeenEventId ?? null,
      lastAckedEventId: payload.lastAckedEventId ?? null,
    }),
    token,
  });
}

export function clearDashboardAlertEvents(token: string, options: { ruleKeys?: string[]; chains: TokenChain[] }) {
  return apiFetch<{
    generatedAt?: string | null;
    count?: number;
    cursors?: Array<DashboardAlertCursor | null>;
  }>('/api/dashboard/alert-events/clear', {
    method: 'POST',
    keepalive: true,
    body: JSON.stringify({
      ruleKeys: Array.isArray(options?.ruleKeys) ? options.ruleKeys : null,
      chains: options.chains,
    }),
    token,
  });
}

export function dismissDashboardAlertEvent(
  payload: { ruleKey: string; chain: TokenChain; eventId: number },
  token: string,
) {
  return apiFetch<{ dismissal?: { dismissedAt?: string | null } | null }>('/api/dashboard/alert-events/dismiss', {
    method: 'POST',
    body: JSON.stringify(payload),
    token,
  });
}

export function fetchBidZoneCandidates(token?: string | null, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<BidZonePayload>(`/api/catalog/bid-zone${suffix}`, { token })
    .then((response) => ({
      generatedAt: response.generatedAt ?? null,
      runId: response.runId ?? null,
      requestedHours: response.requestedHours,
      minMcap: response.minMcap,
      minVol1h: response.minVol1h,
      minVol24h: response.minVol24h,
      candidateCount: response.candidateCount,
      resultCount: response.resultCount,
      refreshAvailableAt: response.refreshAvailableAt ?? null,
      refreshed: response.refreshed,
      retryAfterSeconds: response.retryAfterSeconds,
      count: Number(response.count) || 0,
      candidates: response.candidates || [],
    }));
}

export function refreshBidZoneSnapshot(token?: string | null, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<BidZonePayload>(`/api/catalog/bid-zone/refresh${suffix}`, {
    method: 'POST',
    token,
  }).then((response) => ({
    generatedAt: response.generatedAt ?? null,
    runId: response.runId ?? null,
    requestedHours: response.requestedHours,
    minMcap: response.minMcap,
    minVol1h: response.minVol1h,
    minVol24h: response.minVol24h,
    candidateCount: response.candidateCount,
    resultCount: response.resultCount,
    refreshAvailableAt: response.refreshAvailableAt ?? null,
    refreshed: response.refreshed,
    retryAfterSeconds: response.retryAfterSeconds,
    count: Number(response.count) || 0,
    candidates: response.candidates || [],
  }));
}

export function fetchPumpfunTokenMeta(mint: string, token?: string | null, metadataUri?: string | null) {
  const params = new URLSearchParams();
  if (metadataUri) {
    params.set('uri', metadataUri);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiFetch<{
    mint: string;
    symbol?: string | null;
    name?: string | null;
    imageUrl?: string | null;
  }>(`/api/catalog/pumpfun/${encodeURIComponent(mint)}/meta${suffix}`, { token });
}
