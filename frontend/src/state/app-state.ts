export interface AlertEntry {
  id: string;
  kind: 'monitored-vol' | 'monitored-mcap' | 'hvnc' | 'old-surge' | 'meteora-surge' | 'high-cap-dump-5m';
  ruleKey?: string | null;
  address: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  symbol: string;
  name?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  createdAt: number;
  tokenCreatedAt?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  prevVolume5m?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  prevMcap?: number | null;
  mcap?: number | null;
  baselineMcap?: number | null;
  windowLowMcap?: number | null;
  thresholdPct?: number | null;
  baselineTs?: string | null;
  currentTs?: string | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  pct: number;
  label: string;
  surgeWindow?: '1H' | '6H' | null;
  ageBucket?: 'recent' | 'old-week' | null;
  isHvnc?: boolean;
  isOldSurge?: boolean;
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
      tokenCreatedAt?: number | null;
      ageMsAtAlert?: number | null;
      matchType?: 'exact' | 'subticker' | null;
    }>;
  } | null;
}

export interface ManualTokenEntry {
  address: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  label?: string | null;
  symbol?: string | null;
  name?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  manual?: boolean;
  _userManual?: boolean;
  createdAt?: number | null;
  mcap?: number | null;
  priceUsd?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  mcapDelta?: number | null;
  prevVolume5m?: number | null;
  prevVolume5mCanonical?: number | null;
  prevMcap?: number | null;
  lastAlertAt?: number | null;
  deadCycles?: number;
  _hvncFired?: boolean;
  _meteoraSurgeFired?: boolean;
  _volAlertAboveThreshold?: boolean;
  _mcapAlertAboveThreshold?: boolean;
  _lastVolAlertPct?: number | null;
  _lastMcapAlertPct?: number | null;
  _lastAlertKind?: AlertEntry['kind'] | null;
  _isRecentRouted?: boolean;
  _isOldWeekRouted?: boolean;
}

export type BucketSortMode = 'vol' | 'mcap' | 'pchange' | 'age';
export type BucketSortWindow = '1h' | '6h' | '24h' | 'newest' | 'oldest' | 'highest' | 'lowest';
export interface BucketSortCriterion {
  mode: BucketSortMode;
  window: BucketSortWindow;
}

export type MonitoredSortMode = 'vol' | 'mcap' | 'age';
export type MonitoredSortWindow = '5m' | '1h' | '6h' | '24h' | 'newest' | 'oldest' | 'highest' | 'lowest';
export interface MonitoredSortCriterion {
  mode: MonitoredSortMode;
  window: MonitoredSortWindow;
}

export type LiveWorkspacePanelKey = 'monitored' | 'pumpfun' | 'alerts';
export type LiveWorkspacePanelSpan = 1 | 2 | 3;

export interface LivePanelLayout {
  order: LiveWorkspacePanelKey[];
  spans: {
    monitored: LiveWorkspacePanelSpan;
    pumpfun: 1;
    alerts: LiveWorkspacePanelSpan;
  };
}

export interface PumpVolumePoint {
  usd: number;
  ts: number;
}

export interface MeteoraTvlPoint {
  tvl: number;
  ts: number;
}

export interface MeteoraEntry {
  tvl: number;
  poolAddress?: string | null;
  poolCount?: number;
  noPool?: boolean;
  lastFetch?: number;
  lastCheckedAt?: string | null;
  lastSnapshotAt?: string | null;
  change1h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  history?: MeteoraTvlPoint[];
}

export interface TokenSparklineEntry {
  address: string;
  pairAddress?: string | null;
  bucketCount?: number;
  coverageRatio?: number | null;
  effectiveHours?: number | null;
  granularityMinutes?: number | null;
  latestBucketAt?: string | null;
  generatedAt?: string | null;
  hours?: number;
  points?: number;
  series: number[];
  loading?: boolean;
}

export interface MockTradingSummaryEntry {
  account: {
    userId: number;
    startingCashUsd: number;
    cashUsd: number;
    realizedPnlUsd: number;
  };
  openPositionCount: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  totalPnlUsd: number;
  totalPnlPct?: number | null;
  generatedAt?: string | null;
}

export interface MockTradingPositionEntry {
  userId: number;
  tokenAddress: string;
  quantity: number;
  avgEntryPriceUsd: number;
  avgEntryMcapUsd?: number | null;
  costBasisUsd: number;
  realizedPnlUsd: number;
  currentPriceUsd?: number | null;
  currentMcapUsd?: number | null;
  currentValueUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  unrealizedPnlPct?: number | null;
  priceReturnPct?: number | null;
  priceMultiple?: number | null;
  mcapMultiple?: number | null;
  symbol?: string | null;
  name?: string | null;
  takeProfitOrder?: MockTradingTakeProfitOrderEntry | null;
  takeProfitOrders?: MockTradingTakeProfitOrderEntry[];
}

export interface MockTradingTakeProfitOrderEntry {
  id: number;
  userId: number;
  tokenAddress: string;
  targetMcapUsd: number;
  sellPercent: number;
  status: 'open' | 'triggered' | 'cancelled';
  triggeredTradeId?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  triggeredAt?: string | null;
  cancelledAt?: string | null;
}

export interface MockTradingTradeEntry {
  id: number;
  userId: number;
  tokenAddress: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  marketCapUsd?: number | null;
  notionalUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct?: number | null;
  priceReturnPct?: number | null;
  priceMultiple?: number | null;
  mcapMultiple?: number | null;
  executedAt?: string | null;
}

export interface MockTradingTicketState {
  address: string;
  side: 'buy' | 'sell';
  percent?: number;
}

export interface LateralizedTokenEntry {
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  monitorPriority?: string | null;
  mcap?: number | null;
  catalogMcap?: number | null;
  windowMcap?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  rangePct?: number | null;
  rangeLimitPct?: number | null;
  driftPct?: number | null;
  driftLimitPct?: number | null;
  coverageRatio?: number | null;
  bucketCount?: number;
  sampleCount?: number;
  expectedBucketCount?: number;
  ageHours?: number | null;
  currentPositionPct?: number | null;
  requestedHours?: number;
  minimumWindowHours?: number;
  windowHoursUsed?: number;
  score?: number | null;
}

export interface BidZoneTokenEntry {
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
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

export interface PumpTokenEntry {
  mint: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  metadataUri?: string | null;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  pairUrl?: string | null;
  createdAt?: number | null;
  lastTradeAt?: number | null;
  mcap?: number | null;
  volTotal?: number;
  vol5m?: PumpVolumePoint[];
  _alertFired?: boolean;
  _hvncPumpFired?: boolean;
  _migrated?: boolean;
  _lowMcapSince?: number | null;
  bondingCurveKey?: string | null;
  vTokensInBondingCurve?: number | null;
  virtualSolReserves?: number | null;
  hidden?: boolean;
  _imageResolved?: boolean;
  _imageResolving?: boolean;
}

export interface PumpMigrationEntry {
  mint: string;
  symbol: string;
  imageUrl?: string | null;
  createdAt?: number | null;
  migratedAt: number;
  mcap?: number | null;
  vol5m?: number | null;
  volTotal?: number | null;
}

export interface PumpToastEntry {
  id: string;
  mint: string;
  symbol: string;
  imageUrl?: string | null;
  createdAt?: number | null;
  migratedAt: number;
  mcap?: number | null;
  vol5m?: number | null;
  volTotal?: number | null;
}

export type CollapsibleSectionKey = 'manual' | 'recent' | 'oldWeek' | 'monitored' | 'lateralized' | 'bidZone' | 'pumpfun';
export type WorkspaceView = 'live' | 'history';
export type TradeTerminalKey = 'axiom' | 'photon' | 'bullx' | 'gmgn' | 'padre';
export type ProfileAuthPanel = 'user-settings' | 'bot-settings' | 'blocked-tokens' | 'change-password';
export type AuthPanel =
  | 'none'
  | ProfileAuthPanel
  | 'register'
  | 'invite-assistance'
  | 'password-reset'
  | 'email-verification'
  | 'password-change-success'
  | 'email-verified-success'
  | 'email-otp';

export type StatusMode = 'stopped' | 'active' | 'syncing';

export function isProfileAuthPanel(panel: AuthPanel): panel is ProfileAuthPanel {
  return panel === 'user-settings'
    || panel === 'bot-settings'
    || panel === 'blocked-tokens'
    || panel === 'change-password';
}

export interface StatusMetric {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn';
}

export interface AddressItem {
  address: string;
  label?: string | null;
}

export interface BlockTokenWarningState {
  address: string;
  label?: string | null;
  dontShowAgain: boolean;
}

export interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated' | 'pre_access';
  token: string | null;
  username: string | null;
  email: string | null;
  role: string | null;
  isEmailVerified: boolean;
  emailVerifiedAt: string | null;
  accessStatus: 'inactive' | 'active' | 'grace' | 'revoked' | null;
  accessGrantedAt: string | null;
  accessExpiresAt: string | null;
  accessSource: 'manual' | 'payment' | 'admin' | 'promo' | 'invite' | null;
  accessUpdatedAt: string | null;
  accessIsExpired: boolean;
  accessHasProductAccess: boolean;
  accessDaysRemaining: number | null;
}

export interface BillingPlanEntry {
  key: string;
  label: string;
  description: string;
  accessDays: number;
  currencyCode: string;
  amountMinor: number;
  priceDisplay: string | null;
  featured: boolean;
  provider: string;
  available: boolean;
  availabilityReason: string | null;
}

export interface BillingOrderEntry {
  id: number;
  planKey: string;
  planName: string;
  accessDays: number;
  provider: string;
  providerChargeId: string | null;
  providerCheckoutUrl: string | null;
  providerStatus: string | null;
  currencyCode: string;
  currencyAmountMinor: number;
  status: 'pending' | 'awaiting_payment' | 'paid' | 'failed' | 'expired' | 'cancelled';
  paidAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LinkedIdentityEntry {
  provider: 'google' | 'discord';
  label: string;
  configured: boolean;
  linked: boolean;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  providerDisplayName: string | null;
  linkedAt: string | null;
  lastLoginAt: string | null;
}

export interface ConfigSummary {
  loaded: boolean;
  configCount: number;
  manualTokens: number;
  blocklist: number;
  starredTokens: number;
  eligibleCatalogTokens: number;
}

export interface AppState {
  session: SessionState;
  billing: {
    loaded: boolean;
    enabled: boolean;
    provider: string | null;
    providerReady: boolean;
    providerMocked: boolean;
    plans: BillingPlanEntry[];
    orders: BillingOrderEntry[];
    pendingPlanKey: string | null;
    error: string | null;
  };
  identities: {
    loaded: boolean;
    providers: LinkedIdentityEntry[];
    error: string | null;
  };
  preAccess: {
    loaded: boolean;
    awaitingConfirmation: boolean;
  };
  runtime: {
    mode: StatusMode;
    cycle: number;
    alerts: number;
    alertRevision: number;
    monitoredRevision: number;
    routedRevision: number;
    lateralizedRevision: number;
    bidZoneRevision: number;
    starredRevision: number;
    timeouts: number;
    uptimeLabel: string;
    monitoredUpdatedAt: string | null;
    monitoredFreshnessLabel: string;
    lateralizedUpdatedAt: string | null;
    lateralizedFreshnessLabel: string;
    bidZoneUpdatedAt: string | null;
    bidZoneFreshnessLabel: string;
    bidZoneRefreshAvailableAt: string | null;
    bidZoneRefreshCooldownLabel: string;
    bidZoneRefreshInFlight: boolean;
  };
  bars: {
    manual: number;
    recent: number;
    oldWeek: number;
    blocklist: number;
  };
  panels: {
    monitored: number;
    lateralized: number;
    bidZone: number;
    pumpfun: number;
    alerts: number;
  };
  pumpfun: {
    connected: boolean;
    statusLabel: string;
    solPriceUsd: number | null;
    migrationCount: number;
    bondTargetMcap: number;
  };
  configSummary: ConfigSummary;
  data: {
    configs: Record<string, string | number>;
    trackedTokensByAddress: Record<string, ManualTokenEntry>;
    monitoredTokenAddresses: string[];
    manualTokenAddresses: string[];
    recentTokenAddresses: string[];
    oldWeekTokenAddresses: string[];
    dismissedRecent: string[];
    dismissedOldWeek: string[];
    dismissedPump: string[];
    blocklist: AddressItem[];
    starredTokens: string[];
    eligibleCatalogTokens: string[];
    meteoraByAddress: Record<string, MeteoraEntry>;
    sparklineByAddress: Record<string, TokenSparklineEntry>;
    alertSparklineById: Record<string, TokenSparklineEntry>;
    mockTradingSummary: MockTradingSummaryEntry | null;
    mockTradingPositionsByAddress: Record<string, MockTradingPositionEntry>;
    mockTradingTradesByAddress: Record<string, MockTradingTradeEntry[]>;
    lateralizedTokens: LateralizedTokenEntry[];
    bidZoneTokens: BidZoneTokenEntry[];
    alerts: AlertEntry[];
    pumpTokens: PumpTokenEntry[];
    recentPumpMigrations: PumpMigrationEntry[];
    pumpToasts: PumpToastEntry[];
  };
  ui: {
    busy: boolean;
    error: string | null;
    notice: string | null;
    loginErrorCount: number;
    authPanel: AuthPanel;
    pendingIdentityUnlinkProvider: LinkedIdentityEntry['provider'] | null;
    pendingVerificationEmail: string | null;
    pendingPasswordResetToken: string | null;
    pendingLoginOtpChallengeToken: string | null;
    pendingLoginOtpEmailHint: string | null;
    blockTokenWarning: BlockTokenWarningState | null;
    alertSearchQuery: string;
    monitoredSearchQuery: string;
    manualSearchQuery: string;
    recentSearchQuery: string;
    oldWeekSearchQuery: string;
    recentSearchPending: boolean;
    oldWeekSearchPending: boolean;
    expandedSparklineAddress: string | null;
    mockTradingTicket: MockTradingTicketState | null;
    mockTradingHistoryOpen: boolean;
    manualStarredOnly: boolean;
    recentStarredOnly: boolean;
    oldWeekStarredOnly: boolean;
    monitoredPage: number;
    alertPage: number;
    recentPage: number;
    oldWeekPage: number;
    monitoredPerPage: number;
    recentPerPage: number;
    oldWeekPerPage: number;
    manualSorts: BucketSortCriterion[];
    recentSorts: BucketSortCriterion[];
    oldWeekSorts: BucketSortCriterion[];
    monitoredSorts: MonitoredSortCriterion[];
    enabledTradeTerminals: TradeTerminalKey[];
    livePanelLayout: LivePanelLayout;
    soundEnabled: boolean;
    soundVolume: number;
    collapsed: Record<CollapsibleSectionKey, boolean>;
    workspace: WorkspaceView;
  };
}

export function createAppState(): AppState {
  return {
    session: {
      status: 'loading',
      token: null,
      username: null,
      email: null,
      role: null,
      isEmailVerified: false,
      emailVerifiedAt: null,
      accessStatus: null,
      accessGrantedAt: null,
      accessExpiresAt: null,
      accessSource: null,
      accessUpdatedAt: null,
      accessIsExpired: false,
      accessHasProductAccess: false,
      accessDaysRemaining: null,
    },
    billing: {
      loaded: false,
      enabled: false,
      provider: null,
      providerReady: false,
      providerMocked: false,
      plans: [],
      orders: [],
      pendingPlanKey: null,
      error: null,
    },
    identities: {
      loaded: false,
      providers: [],
      error: null,
    },
    preAccess: {
      loaded: false,
      awaitingConfirmation: false,
    },
    runtime: {
      mode: 'stopped',
      cycle: 0,
      alerts: 0,
      alertRevision: 0,
      monitoredRevision: 0,
      routedRevision: 0,
      lateralizedRevision: 0,
      bidZoneRevision: 0,
      starredRevision: 0,
      timeouts: 0,
      uptimeLabel: '0m',
      monitoredUpdatedAt: null,
      monitoredFreshnessLabel: '-',
      lateralizedUpdatedAt: null,
      lateralizedFreshnessLabel: '-',
      bidZoneUpdatedAt: null,
      bidZoneFreshnessLabel: '-',
      bidZoneRefreshAvailableAt: null,
      bidZoneRefreshCooldownLabel: 'ready',
      bidZoneRefreshInFlight: false,
    },
    bars: {
      manual: 0,
      recent: 0,
      oldWeek: 0,
      blocklist: 0,
    },
    panels: {
      monitored: 0,
      lateralized: 0,
      bidZone: 0,
      pumpfun: 0,
      alerts: 0,
    },
    pumpfun: {
      connected: false,
      statusLabel: 'disconnected',
      solPriceUsd: null,
      migrationCount: 0,
      bondTargetMcap: 35000,
    },
    configSummary: {
      loaded: false,
      configCount: 0,
      manualTokens: 0,
      blocklist: 0,
      starredTokens: 0,
      eligibleCatalogTokens: 0,
    },
    data: {
      configs: {},
      trackedTokensByAddress: {},
      monitoredTokenAddresses: [],
      manualTokenAddresses: [],
      recentTokenAddresses: [],
      oldWeekTokenAddresses: [],
      dismissedRecent: [],
      dismissedOldWeek: [],
      dismissedPump: [],
      blocklist: [],
      starredTokens: [],
      eligibleCatalogTokens: [],
      meteoraByAddress: {},
      sparklineByAddress: {},
      alertSparklineById: {},
      mockTradingSummary: null,
      mockTradingPositionsByAddress: {},
      mockTradingTradesByAddress: {},
      lateralizedTokens: [],
      bidZoneTokens: [],
      alerts: [],
      pumpTokens: [],
      recentPumpMigrations: [],
      pumpToasts: [],
    },
    ui: {
      busy: false,
      error: null,
      notice: null,
      loginErrorCount: 0,
      authPanel: 'none',
      pendingIdentityUnlinkProvider: null,
      pendingVerificationEmail: null,
      pendingPasswordResetToken: null,
      pendingLoginOtpChallengeToken: null,
      pendingLoginOtpEmailHint: null,
      blockTokenWarning: null,
      alertSearchQuery: '',
      monitoredSearchQuery: '',
      manualSearchQuery: '',
      recentSearchQuery: '',
      oldWeekSearchQuery: '',
      recentSearchPending: false,
      oldWeekSearchPending: false,
      expandedSparklineAddress: null,
      mockTradingTicket: null,
      mockTradingHistoryOpen: false,
      manualStarredOnly: false,
      recentStarredOnly: false,
      oldWeekStarredOnly: false,
      monitoredPage: 0,
      alertPage: 0,
      recentPage: 0,
      oldWeekPage: 0,
      monitoredPerPage: 30,
      recentPerPage: 15,
      oldWeekPerPage: 15,
      manualSorts: [{ mode: 'mcap', window: 'highest' }],
      recentSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
      oldWeekSorts: [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }],
      monitoredSorts: [{ mode: 'vol', window: '5m' }],
      enabledTradeTerminals: ['axiom', 'photon', 'bullx', 'gmgn', 'padre'],
      livePanelLayout: {
        order: ['monitored', 'pumpfun', 'alerts'],
        spans: {
          monitored: 1,
          pumpfun: 1,
          alerts: 1,
        },
      },
      soundEnabled: true,
      soundVolume: 0.05,
      collapsed: {
        manual: false,
        recent: false,
        oldWeek: false,
        monitored: false,
        lateralized: false,
        bidZone: false,
        pumpfun: false,
      },
      workspace: 'live',
    },
  };
}

export function getStatusMetrics(state: AppState): StatusMetric[] {
  return [
    {
      label: 'STATUS',
      value: state.runtime.mode.toUpperCase(),
      tone: state.runtime.mode === 'active' ? 'ok' : 'neutral',
    },
    { label: 'CYCLE', value: String(state.runtime.cycle) },
    { label: 'UPTIME', value: state.runtime.uptimeLabel },
    { label: 'ALERTS', value: String(state.runtime.alerts) },
    {
      label: 'TIMEOUTS',
      value: String(state.runtime.timeouts),
      tone: state.runtime.timeouts > 0 ? 'warn' : 'neutral',
    },
  ];
}

export function getTrackedToken(state: AppState, address: string) {
  return state.data.trackedTokensByAddress[String(address || '').trim()] || null;
}

function toLiveMockNumber(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value) : null;
}

function pickLiveMockMarketValue(primary: number | null | undefined, fallback: number | null | undefined) {
  const primaryNumber = toLiveMockNumber(primary);
  if (primaryNumber != null && primaryNumber > 0) {
    return primaryNumber;
  }
  return toLiveMockNumber(fallback);
}

function buildLiveMockPriceMetrics(position: MockTradingPositionEntry, currentPriceUsd: number | null) {
  const currentValueUsd = currentPriceUsd == null ? null : position.quantity * currentPriceUsd;
  const unrealizedPnlUsd = currentValueUsd == null ? null : currentValueUsd - position.costBasisUsd;
  const unrealizedPnlPct = unrealizedPnlUsd == null || position.costBasisUsd <= 0
    ? null
    : (unrealizedPnlUsd / position.costBasisUsd) * 100;
  const priceMultiple = currentPriceUsd == null || position.avgEntryPriceUsd <= 0
    ? null
    : currentPriceUsd / position.avgEntryPriceUsd;

  return {
    currentValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    priceMultiple,
    priceReturnPct: priceMultiple == null ? null : (priceMultiple - 1) * 100,
  };
}

function buildLiveMockMcapMultiple(position: MockTradingPositionEntry, currentMcapUsd: number | null) {
  return currentMcapUsd == null || !(position.avgEntryMcapUsd && position.avgEntryMcapUsd > 0)
    ? null
    : currentMcapUsd / position.avgEntryMcapUsd;
}

function buildLiveMockTradingPosition(
  position: MockTradingPositionEntry,
  token: ManualTokenEntry | null,
): MockTradingPositionEntry {
  const currentPriceUsd = pickLiveMockMarketValue(token?.priceUsd, position.currentPriceUsd);
  const currentMcapUsd = pickLiveMockMarketValue(token?.mcap, position.currentMcapUsd);
  const priceMetrics = buildLiveMockPriceMetrics(position, currentPriceUsd);

  return {
    ...position,
    symbol: token?.symbol || position.symbol || null,
    name: token?.name || position.name || null,
    currentPriceUsd,
    currentMcapUsd,
    ...priceMetrics,
    mcapMultiple: buildLiveMockMcapMultiple(position, currentMcapUsd),
  };
}

export function getMockTradingPositionView(state: AppState, address: string) {
  const normalizedAddress = String(address || '').trim();
  const position = state.data.mockTradingPositionsByAddress[normalizedAddress] || null;
  if (!position) {
    return null;
  }
  return buildLiveMockTradingPosition(position, getTrackedToken(state, normalizedAddress));
}

export function getMockTradingPositionsViewByAddress(state: AppState) {
  return Object.fromEntries(
    Object.keys(state.data.mockTradingPositionsByAddress).map((address) => [
      address,
      getMockTradingPositionView(state, address) as MockTradingPositionEntry,
    ])
  );
}

export function getMockTradingSummaryView(state: AppState) {
  const summary = state.data.mockTradingSummary;
  if (!summary) {
    return null;
  }
  const positions = Object.values(getMockTradingPositionsViewByAddress(state));
  const openPositionValueUsd = positions.reduce((sum, position) => sum + (position.currentValueUsd || 0), 0);
  const totalEquityUsd = summary.account.cashUsd + openPositionValueUsd;
  const totalPnlUsd = totalEquityUsd - summary.account.startingCashUsd;
  return {
    ...summary,
    openPositionCount: positions.length,
    openPositionValueUsd,
    totalEquityUsd,
    totalPnlUsd,
    totalPnlPct: summary.account.startingCashUsd > 0
      ? (totalPnlUsd / summary.account.startingCashUsd) * 100
      : null,
  };
}

export function getTokenSparkline(state: AppState, address: string) {
  return state.data.sparklineByAddress[String(address || '').trim()] || null;
}

export function getManualTokens(state: AppState) {
  return state.data.manualTokenAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}

export function getMonitoredTokens(state: AppState) {
  return state.data.monitoredTokenAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}

export function getRecentTokens(state: AppState) {
  return state.data.recentTokenAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}

export function getOldWeekTokens(state: AppState) {
  return state.data.oldWeekTokenAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}
