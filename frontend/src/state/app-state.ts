export interface AlertEntry {
  id: string;
  kind: 'monitored-vol' | 'monitored-mcap' | 'hvnc' | 'old-surge' | 'meteora-surge' | 'pumpfun-vol' | 'pumpfun-hvnc';
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
  prevVolume5m?: number | null;
  volume5m?: number | null;
  volume1h?: number | null;
  volume6h?: number | null;
  volume24h?: number | null;
  prevMcap?: number | null;
  mcap?: number | null;
  pct: number;
  label: string;
  surgeWindow?: '1H' | '6H' | null;
  isHvnc?: boolean;
  isOldSurge?: boolean;
}

export interface RemovalLogEntry {
  address: string;
  symbol: string;
  imageUrl?: string | null;
  pairUrl?: string | null;
  mcap?: number | null;
  reason: string;
  ts: number;
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
  prevMcap?: number | null;
  lastAlertAt?: number | null;
  deadCycles?: number;
  _hvncFired?: boolean;
  _oldSurgeFired?: boolean;
  _meteoraSurgeFired?: boolean;
  _oldSurgeSessionBase1h?: number | null;
  _oldSurgeSessionBase6h?: number | null;
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
  lastSnapshotAt?: string | null;
  change1h?: number | null;
  change6h?: number | null;
  change24h?: number | null;
  history?: MeteoraTvlPoint[];
}

export interface LateralizedTokenEntry {
  address: string;
  symbol?: string | null;
  name?: string | null;
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
}

export type CollapsibleSectionKey = 'manual' | 'recent' | 'oldWeek' | 'monitored' | 'lateralized' | 'pumpfun';

export type StatusMode = 'stopped' | 'active' | 'syncing';

export interface StatusMetric {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn';
}

export interface AddressItem {
  address: string;
  label?: string | null;
}

export interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  token: string | null;
  username: string | null;
  email: string | null;
  role: string | null;
  isEmailVerified: boolean;
  emailVerifiedAt: string | null;
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
  runtime: {
    mode: StatusMode;
    cycle: number;
    alerts: number;
    timeouts: number;
    uptimeLabel: string;
    monitoredUpdatedAt: string | null;
    monitoredFreshnessLabel: string;
    lateralizedUpdatedAt: string | null;
    lateralizedFreshnessLabel: string;
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
    recentRemovalLog: RemovalLogEntry[];
    oldWeekRemovalLog: RemovalLogEntry[];
    blocklist: AddressItem[];
    starredTokens: string[];
    eligibleCatalogTokens: string[];
    meteoraByAddress: Record<string, MeteoraEntry>;
    lateralizedTokens: LateralizedTokenEntry[];
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
    authPanel: 'none' | 'change-password' | 'register' | 'invite-assistance' | 'password-reset' | 'email-verification' | 'password-change-success' | 'email-verified-success' | 'email-otp';
    pendingVerificationEmail: string | null;
    pendingPasswordResetToken: string | null;
    pendingLoginOtpChallengeToken: string | null;
    pendingLoginOtpEmailHint: string | null;
    alertSearchQuery: string;
    monitoredSearchQuery: string;
    manualSearchQuery: string;
    recentSearchQuery: string;
    oldWeekSearchQuery: string;
    manualStarredOnly: boolean;
    recentStarredOnly: boolean;
    oldWeekStarredOnly: boolean;
    monitoredPage: number;
    recentPage: number;
    oldWeekPage: number;
    monitoredPerPage: number;
    recentPerPage: number;
    oldWeekPerPage: number;
    manualSorts: BucketSortCriterion[];
    recentSorts: BucketSortCriterion[];
    oldWeekSorts: BucketSortCriterion[];
    monitoredSorts: MonitoredSortCriterion[];
    soundEnabled: boolean;
    soundVolume: number;
    collapsed: Record<CollapsibleSectionKey, boolean>;
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
    },
    runtime: {
      mode: 'stopped',
      cycle: 0,
      alerts: 0,
      timeouts: 0,
      uptimeLabel: '0m',
      monitoredUpdatedAt: null,
      monitoredFreshnessLabel: '-',
      lateralizedUpdatedAt: null,
      lateralizedFreshnessLabel: '-',
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
      recentRemovalLog: [],
      oldWeekRemovalLog: [],
      blocklist: [],
      starredTokens: [],
      eligibleCatalogTokens: [],
      meteoraByAddress: {},
      lateralizedTokens: [],
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
      pendingVerificationEmail: null,
      pendingPasswordResetToken: null,
      pendingLoginOtpChallengeToken: null,
      pendingLoginOtpEmailHint: null,
      alertSearchQuery: '',
      monitoredSearchQuery: '',
      manualSearchQuery: '',
      recentSearchQuery: '',
      oldWeekSearchQuery: '',
      manualStarredOnly: false,
      recentStarredOnly: false,
      oldWeekStarredOnly: false,
      monitoredPage: 0,
      recentPage: 0,
      oldWeekPage: 0,
      monitoredPerPage: 30,
      recentPerPage: 30,
      oldWeekPerPage: 30,
      manualSorts: [{ mode: 'mcap', window: 'highest' }],
      recentSorts: [{ mode: 'vol', window: '24h' }],
      oldWeekSorts: [{ mode: 'vol', window: '24h' }],
      monitoredSorts: [{ mode: 'vol', window: '5m' }],
      soundEnabled: true,
      soundVolume: 0.05,
      collapsed: {
        manual: false,
        recent: false,
        oldWeek: false,
        monitored: false,
        lateralized: false,
        pumpfun: false,
      },
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
