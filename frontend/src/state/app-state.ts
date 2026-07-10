export interface AlertEntry {
  id: string;
  kind: 'monitored-vol' | 'monitored-mcap' | 'hvnc' | 'old-surge' | 'meteora-surge' | 'gmgn-claim-signal' | 'admin-token-review' | 'custom-alert';
  ruleKey?: string | null;
  address: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  symbol: string;
  name?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  reviewAlertId?: number | null;
  reviewPriority?: string | null;
  reviewReasons?: string[];
  reviewWebsiteUrl?: string | null;
  reviewTop10Pct?: number | null;
  reviewTop20Pct?: number | null;
  createdAt: number;
  tokenCreatedAt?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  prevVolume1m?: number | null;
  volume1m?: number | null;
  prevVolume5m?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  prevMcap?: number | null;
  mcap?: number | null;
  thresholdPct?: number | null;
  signalType?: number | null;
  claimSequence?: number | null;
  claimId?: string | null;
  claimFeeAmount?: number | null;
  claimFeeCurrency?: string | null;
  claimFeeUsd?: number | null;
  quoteAddress?: string | null;
  totalFeeUsd?: number | null;
  claimedAt?: string | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  pct: number;
  label: string;
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
  customRuleId?: number | null;
  customCurrentValue?: number | null;
  customPreviousValue?: number | null;
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

export interface CustomAlertPreviewInput {
  tokenAddress: string;
  title: string;
  metric: string;
  operator: string;
  target: string;
  repeatMode: string;
  expires: string;
  colorHex: string;
  filters: string;
  soundName: string | null;
  soundDataUrl: string | null;
}

export interface CustomAlertRuleEntry {
  id: number;
  tokenAddress: string;
  title: string;
  metric: 'price' | 'mcap';
  operator: 'cross_above' | 'cross_below';
  targetValue: number;
  colorHex: string | null;
  soundName: string | null;
  expiresAt: string | null;
  status: 'active' | 'triggered' | 'disabled';
  triggeredAt: string | null;
}

export interface ManualTokenEntry {
  address: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  pairDexId?: string | null;
  label?: string | null;
  symbol?: string | null;
  name?: string | null;
  pairUrl?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
  manual?: boolean;
  _userManual?: boolean;
  createdAt?: number | null;
  catalogFirstSeenAt?: number | null;
  mcap?: number | null;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  historySortScore?: number | null;
  mcapDelta?: number | null;
  prevVolume5m?: number | null;
  prevVolume5mCanonical?: number | null;
  prevMcap?: number | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
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
  _isTopPerformer?: boolean;
  performanceRank?: number | null;
  performanceScore?: number | null;
  meteora?: ManualTokenMeteoraEntry | null;
  tickerPeers?: AlertEntry['tickerPeers'];
  _isPinnedMonitored?: boolean;
  pinnedSortOrder?: number | null;
}

export interface ManualTokenFolderEntry {
  id: number;
  userId: number;
  parentFolderId: number | null;
  name: string;
  sortOrder: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ManualTokenFolderItemEntry {
  userId: number;
  folderId: number;
  address: string;
  sortOrder: number;
  addedAt?: string | null;
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
  heights: {
    monitored: number;
    alerts: number;
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
  change4h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  volume1h?: number | null;
  volume4h?: number | null;
  volume24h?: number | null;
  history?: MeteoraTvlPoint[];
}

export interface ManualTokenMeteoraEntry {
  address: string;
  tvl?: number | null;
  poolAddress?: string | null;
  poolCount?: number;
  noPool?: boolean;
  lastCheckedAt?: string | null;
  lastSnapshotAt?: string | null;
  change1h?: number | null;
  change4h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  volume1h?: number | null;
  volume4h?: number | null;
  volume24h?: number | null;
}

export interface TokenSparklineCandleEntry {
  bucketTs: string;
  pairAddress?: string | null;
  granularityMinutes: number;
  openMcap: number | null;
  highMcap: number | null;
  lowMcap: number | null;
  closeMcap: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number | null;
  sampleCount: number;
}

export interface TokenSparklineEntry {
  address: string;
  pairAddress?: string | null;
  bucketCount?: number;
  coverageRatio?: number | null;
  effectiveHours?: number | null;
  granularityMinutes?: number | null;
  firstBucketAt?: string | null;
  latestBucketAt?: string | null;
  oneMinuteAvailable?: boolean;
  generatedAt?: string | null;
  refreshedAt?: number;
  hours?: number;
  points?: number;
  series: number[];
  candles?: TokenSparklineCandleEntry[];
  loading?: boolean;
}

export interface MockTradingSummaryEntry {
  account: {
    userId: number;
    walletId?: number | null;
    startingCashUsd: number;
    cashUsd: number;
    realizedPnlUsd: number;
  };
  wallet?: MockTradingWalletEntry | null;
  openPositionCount: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  totalPnlUsd: number;
  totalPnlPct?: number | null;
  solUsdPrice?: {
    provider?: string | null;
    priceUsd?: number | null;
    stale?: boolean | null;
    lastUpdatedAt?: string | null;
    ageSeconds?: number | null;
    lastError?: string | null;
  } | null;
  generatedAt?: string | null;
}

export interface MockTradingWalletEntry {
  id: number;
  userId: number;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  archivedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface MockTradingPositionEntry {
  userId: number;
  walletId?: number | null;
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
  imageUrl?: string | null;
  takeProfitOrder?: MockTradingTakeProfitOrderEntry | null;
  takeProfitOrders?: MockTradingTakeProfitOrderEntry[];
}

export interface MockTradingTakeProfitOrderEntry {
  id: number;
  userId: number;
  walletId?: number | null;
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
  walletId?: number | null;
  tokenAddress: string;
  symbol?: string | null;
  name?: string | null;
  imageUrl?: string | null;
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
  mockSolUsdcRate?: number | null;
  executedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MockTradingTicketState {
  address: string;
  side: 'buy' | 'sell';
  percent?: number;
}

export type FloatingQuickBuyStatus = 'idle' | 'tracking' | 'waiting_market' | 'buying' | 'bought' | 'error';

export interface FloatingQuickBuyState {
  address: string;
  notionalSol: number;
  status: FloatingQuickBuyStatus;
  message: string | null;
  error: string | null;
  armedAt: number | null;
  armedCycle: number;
  updatedAt: number | null;
  executedAt: number | null;
  lastPriceUsd: number | null;
  lastMcap: number | null;
  manualTracked: boolean;
  buyAttempted: boolean;
}

export interface BidZoneTokenEntry {
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

export interface PumpTokenEntry {
  mint: string;
  mintAddress?: string | null;
  pairAddress?: string | null;
  metadataUri?: string | null;
  name?: string | null;
  symbol?: string | null;
  imageUrl?: string | null;
  twitterUrl?: string | null;
  communityUrl?: string | null;
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

export type CollapsibleSectionKey = 'manual' | 'recent' | 'oldWeek' | 'monitored' | 'bidZone' | 'pumpfun';
export type WorkspaceView = 'live' | 'history';
export type TradeTerminalKey = 'axiom' | 'photon' | 'bullx' | 'gmgn' | 'padre';
export type ProfileAuthPanel = 'user-settings' | 'bot-settings' | 'blocked-tokens' | 'token-review-alerts' | 'change-password';
export type AuthPanel =
  | 'none'
  | ProfileAuthPanel
  | 'wallet-select'
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
    || panel === 'token-review-alerts'
    || panel === 'change-password';
}

export interface StatusMetric {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn';
}

export interface SolanaWalletOptionState {
  id: string;
  name: string;
  icon: string | null;
}

export interface AddressItem {
  address: string;
  label?: string | null;
  imageUrl?: string | null;
}

export interface AdminTokenReviewAlertEntry {
  id: number;
  tokenAddress: string | null;
  status: 'open' | 'resolved' | string | null;
  priority: string | null;
  alertKind: string | null;
  pipeline: string | null;
  label: string | null;
  reasonCodes: string[];
  assessment: Record<string, unknown>;
  socialSnapshot: Record<string, unknown>;
  marketSnapshot: Record<string, unknown>;
  riskSnapshot: Record<string, unknown>;
  meteoraSnapshot: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: number | null;
  resolution: string | null;
  notes: string | null;
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
  accessSource: 'manual' | 'payment' | 'admin' | 'promo' | 'invite' | 'token' | null;
  accessUpdatedAt: string | null;
  accessIsExpired: boolean;
  accessHasProductAccess: boolean;
  accessDaysRemaining: number | null;
  accessReason: string | null;
  tokenTier: string | null;
  tokenDiscountPercent: number;
  tokenBalanceRaw: string | null;
  tokenBalanceUi: string | null;
  tokenSnapshotCheckedAt: string | null;
  tokenSnapshotExpiresAt: string | null;
}

export interface BillingPlanEntry {
  key: string;
  label: string;
  description: string;
  accessDays: number;
  currencyCode: string;
  amountMinor: number;
  priceDisplay: string | null;
  discountedAmountMinor?: number | null;
  discountedPriceDisplay?: string | null;
  discountPercent?: number;
  discountAvailable?: boolean;
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
  canUnlink: boolean;
  unlinkBlockedReason: string | null;
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
    hasPasswordLogin: boolean;
    error: string | null;
  };
  preAccess: {
    loaded: boolean;
    awaitingConfirmation: boolean;
    pendingBillingOrderId: number | null;
  };
  runtime: {
    mode: StatusMode;
    cycle: number;
    alerts: number;
    alertRevision: number;
    monitoredRevision: number;
    routedRevision: number;
    bidZoneRevision: number;
    starredRevision: number;
    timeouts: number;
    uptimeLabel: string;
    monitoredUpdatedAt: string | null;
    monitoredFreshnessLabel: string;
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
    runtimeFlags: {
      mockTradingEnabled: boolean;
    };
    trackedTokensByAddress: Record<string, ManualTokenEntry>;
    monitoredTokenAddresses: string[];
    pinnedMonitoredTokenAddresses: string[];
    manualTokenAddresses: string[];
    manualTokenFolders: ManualTokenFolderEntry[];
    manualTokenFolderItems: ManualTokenFolderItemEntry[];
    recentTokenAddresses: string[];
    oldWeekTokenAddresses: string[];
    topPerformerAddresses: string[];
    topPerformersGeneratedAt: string | null;
    topPerformersRanking: string | null;
    dismissedRecent: string[];
    dismissedOldWeek: string[];
    dismissedPump: string[];
    blocklist: AddressItem[];
    adminTokenReviewAlerts: AdminTokenReviewAlertEntry[];
    starredTokens: string[];
    eligibleCatalogTokens: string[];
    meteoraByAddress: Record<string, MeteoraEntry>;
    sparklineByAddress: Record<string, TokenSparklineEntry>;
    expandedSparklineByAddress: Record<string, TokenSparklineEntry>;
    alertSparklineById: Record<string, TokenSparklineEntry>;
    mockTradingWallets: MockTradingWalletEntry[];
    mockTradingSummary: MockTradingSummaryEntry | null;
    mockTradingPositionsByAddress: Record<string, MockTradingPositionEntry>;
    mockTradingTradesByAddress: Record<string, MockTradingTradeEntry[]>;
    bidZoneTokens: BidZoneTokenEntry[];
    alerts: AlertEntry[];
    customAlertRules: CustomAlertRuleEntry[];
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
    walletSelectorMode: 'login' | 'link' | null;
    walletOptions: SolanaWalletOptionState[];
    walletNetworkLabel: string;
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
    expandedSparklineGranularityMinutes: number;
    sparklineRange: {
      global: boolean;
      globalDays: number;
      monitoredDays: number;
      recentDays: number;
      oldWeekDays: number;
      tokenDaysByAddress: Record<string, number>;
    };
    activeMockTradingWalletId: number | null;
    mockTradingTicket: MockTradingTicketState | null;
    floatingQuickBuy: FloatingQuickBuyState;
    floatingQuickBuyVisible: boolean;
    mockTradingHistoryOpen: boolean;
    mockTradingPnlAddress: string | null;
    manualStarredOnly: boolean;
    manualFolderDeleteWarningDismissed: boolean;
    manualVisibleFolderIds: number[];
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
    browserNotifications: {
      enabled: boolean;
      permission: 'unsupported' | 'default' | 'granted' | 'denied';
      notifyWhenVisible: boolean;
    };
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
      accessReason: null,
      tokenTier: null,
      tokenDiscountPercent: 0,
      tokenBalanceRaw: null,
      tokenBalanceUi: null,
      tokenSnapshotCheckedAt: null,
      tokenSnapshotExpiresAt: null,
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
      hasPasswordLogin: false,
      error: null,
    },
    preAccess: {
      loaded: false,
      awaitingConfirmation: false,
      pendingBillingOrderId: null,
    },
    runtime: {
      mode: 'stopped',
      cycle: 0,
      alerts: 0,
      alertRevision: 0,
      monitoredRevision: 0,
      routedRevision: 0,
      bidZoneRevision: 0,
      starredRevision: 0,
      timeouts: 0,
      uptimeLabel: '0m',
      monitoredUpdatedAt: null,
      monitoredFreshnessLabel: '-',
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
      runtimeFlags: {
        mockTradingEnabled: true,
      },
      trackedTokensByAddress: {},
      monitoredTokenAddresses: [],
      pinnedMonitoredTokenAddresses: [],
      manualTokenAddresses: [],
      manualTokenFolders: [],
      manualTokenFolderItems: [],
      recentTokenAddresses: [],
      oldWeekTokenAddresses: [],
      topPerformerAddresses: [],
      topPerformersGeneratedAt: null,
      topPerformersRanking: null,
      dismissedRecent: [],
      dismissedOldWeek: [],
      dismissedPump: [],
      blocklist: [],
      adminTokenReviewAlerts: [],
      starredTokens: [],
      eligibleCatalogTokens: [],
      meteoraByAddress: {},
      sparklineByAddress: {},
      expandedSparklineByAddress: {},
      alertSparklineById: {},
      mockTradingWallets: [],
      mockTradingSummary: null,
      mockTradingPositionsByAddress: {},
      mockTradingTradesByAddress: {},
      bidZoneTokens: [],
      alerts: [],
      customAlertRules: [],
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
      walletSelectorMode: null,
      walletOptions: [],
      walletNetworkLabel: 'Solana Mainnet',
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
      expandedSparklineGranularityMinutes: 5,
      sparklineRange: {
        global: true,
        globalDays: 14,
        monitoredDays: 14,
        recentDays: 14,
        oldWeekDays: 14,
        tokenDaysByAddress: {},
      },
      activeMockTradingWalletId: null,
      mockTradingTicket: null,
      floatingQuickBuy: {
        address: '',
        notionalSol: 0.3,
        status: 'idle',
        message: null,
        error: null,
        armedAt: null,
        armedCycle: 0,
        updatedAt: null,
        executedAt: null,
        lastPriceUsd: null,
        lastMcap: null,
        manualTracked: false,
        buyAttempted: false,
      },
      floatingQuickBuyVisible: true,
      mockTradingHistoryOpen: false,
      mockTradingPnlAddress: null,
      manualStarredOnly: false,
      manualFolderDeleteWarningDismissed: false,
      manualVisibleFolderIds: [],
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
          monitored: 2,
          pumpfun: 1,
          alerts: 1,
        },
        heights: {
          monitored: 620,
          alerts: 620,
        },
      },
      soundEnabled: true,
      soundVolume: 0.05,
      browserNotifications: {
        enabled: false,
        permission: 'unsupported',
        notifyWhenVisible: false,
      },
      collapsed: {
        manual: false,
        recent: false,
        oldWeek: false,
        monitored: false,
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

function deriveLiveMockPriceFromMcap(position: MockTradingPositionEntry, currentMcapUsd: number | null) {
  if (
    currentMcapUsd == null
    || currentMcapUsd <= 0
    || !(position.avgEntryMcapUsd && position.avgEntryMcapUsd > 0)
    || !(position.avgEntryPriceUsd > 0)
  ) {
    return null;
  }

  return position.avgEntryPriceUsd * (currentMcapUsd / position.avgEntryMcapUsd);
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
  const currentMcapUsd = pickLiveMockMarketValue(token?.mcap, position.currentMcapUsd);
  const currentPriceUsd = deriveLiveMockPriceFromMcap(position, currentMcapUsd)
    ?? pickLiveMockMarketValue(token?.priceUsd, position.currentPriceUsd);
  const priceMetrics = buildLiveMockPriceMetrics(position, currentPriceUsd);

  return {
    ...position,
    symbol: token?.symbol || position.symbol || null,
    name: token?.name || position.name || null,
    imageUrl: token?.imageUrl || position.imageUrl || null,
    currentPriceUsd,
    currentMcapUsd,
    ...priceMetrics,
    mcapMultiple: buildLiveMockMcapMultiple(position, currentMcapUsd),
  };
}

export function getMockTradingPositionView(state: AppState, address: string) {
  if (!isMockTradingEnabled(state)) {
    return null;
  }
  const normalizedAddress = String(address || '').trim();
  const position = state.data.mockTradingPositionsByAddress[normalizedAddress] || null;
  if (!position) {
    return null;
  }
  return buildLiveMockTradingPosition(position, getTrackedToken(state, normalizedAddress));
}

export function getMockTradingPositionsViewByAddress(state: AppState) {
  if (!isMockTradingEnabled(state)) {
    return {};
  }
  return Object.fromEntries(
    Object.keys(state.data.mockTradingPositionsByAddress).map((address) => [
      address,
      getMockTradingPositionView(state, address) as MockTradingPositionEntry,
    ])
  );
}

export function getMockTradingSummaryView(state: AppState) {
  if (!isMockTradingEnabled(state)) {
    return null;
  }
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

export function isMockTradingEnabled(state: AppState) {
  return state.data.runtimeFlags.mockTradingEnabled !== false;
}

export function getTokenSparkline(state: AppState, address: string) {
  return state.data.sparklineByAddress[String(address || '').trim()] || null;
}

export function getExpandedTokenSparkline(state: AppState, address: string) {
  const normalized = String(address || '').trim();
  const granularityMinutes = Math.max(1, Math.round(Number(state.ui.expandedSparklineGranularityMinutes) || 5));
  const scopedKey = `${normalized}::${granularityMinutes}`;
  return state.data.expandedSparklineByAddress[scopedKey] || state.data.expandedSparklineByAddress[normalized] || state.data.sparklineByAddress[normalized] || null;
}

export function getManualTokens(state: AppState) {
  return state.data.manualTokenAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}

export function getManualFolderAddressSet(state: AppState, folderIds = state.ui.manualVisibleFolderIds) {
  const normalizedFolderIds = Array.from(new Set(
    (Array.isArray(folderIds) ? folderIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (normalizedFolderIds.length === 0) {
    return new Set(state.data.manualTokenAddresses);
  }

  const selected = new Set(normalizedFolderIds);
  const addresses = new Set<string>();
  for (const item of state.data.manualTokenFolderItems) {
    if (selected.has(item.folderId)) {
      addresses.add(item.address);
    }
  }
  return addresses;
}

export function getVisibleManualTokens(state: AppState) {
  const visibleAddresses = getManualFolderAddressSet(state);
  return getManualTokens(state).filter((item) => visibleAddresses.has(item.address));
}

export function getMonitoredTokens(state: AppState) {
  const orderedAddresses = [
    ...state.data.pinnedMonitoredTokenAddresses,
    ...state.data.monitoredTokenAddresses,
  ];
  const seen = new Set<string>();
  return orderedAddresses
    .filter((address) => {
      if (seen.has(address)) {
        return false;
      }
      seen.add(address);
      return true;
    })
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

export function getTopPerformerTokens(state: AppState) {
  return state.data.topPerformerAddresses
    .map((address) => getTrackedToken(state, address))
    .filter((item): item is ManualTokenEntry => Boolean(item));
}
