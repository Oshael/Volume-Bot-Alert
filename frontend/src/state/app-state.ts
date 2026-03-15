export interface AlertEntry {
  id: string;
  kind: 'monitored-vol' | 'monitored-mcap' | 'hvnc' | 'old-surge' | 'pumpfun-vol' | 'pumpfun-hvnc';
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
  prevVolume5m?: number | null;
  prevMcap?: number | null;
  lastAlertAt?: number | null;
  deadCycles?: number;
  _hvncFired?: boolean;
  _oldSurgeFired?: boolean;
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
  };
  bars: {
    manual: number;
    recent: number;
    oldWeek: number;
    blocklist: number;
  };
  panels: {
    monitored: number;
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
    monitoredTokens: ManualTokenEntry[];
    manualTokens: ManualTokenEntry[];
    recentTokens: ManualTokenEntry[];
    oldWeekTokens: ManualTokenEntry[];
    dismissedRecent: string[];
    dismissedOldWeek: string[];
    recentRemovalLog: RemovalLogEntry[];
    oldWeekRemovalLog: RemovalLogEntry[];
    blocklist: AddressItem[];
    starredTokens: string[];
    eligibleCatalogTokens: string[];
    meteoraByAddress: Record<string, MeteoraEntry>;
    alerts: AlertEntry[];
    pumpTokens: PumpTokenEntry[];
    recentPumpMigrations: PumpMigrationEntry[];
    pumpToasts: PumpToastEntry[];
  };
  ui: {
    busy: boolean;
    error: string | null;
    notice: string | null;
    recentPage: number;
    oldWeekPage: number;
    recentPerPage: number;
    oldWeekPerPage: number;
    manualSort: 'vol' | 'mcap' | 'pchange';
    manualSortWindow: '1h' | '6h' | '24h';
    recentSort: 'vol' | 'mcap' | 'pchange';
    recentSortWindow: '1h' | '6h' | '24h';
    oldWeekSort: 'vol' | 'mcap' | 'pchange';
    oldWeekSortWindow: '1h' | '6h' | '24h';
    monitoredSort: '5m' | '1h' | '6h' | '24h' | 'mcap';
    soundEnabled: boolean;
    soundVolume: number;
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
    },
    runtime: {
      mode: 'stopped',
      cycle: 0,
      alerts: 0,
      timeouts: 0,
      uptimeLabel: '0m',
    },
    bars: {
      manual: 0,
      recent: 0,
      oldWeek: 0,
      blocklist: 0,
    },
    panels: {
      monitored: 0,
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
      monitoredTokens: [],
      manualTokens: [],
      recentTokens: [],
      oldWeekTokens: [],
      dismissedRecent: [],
      dismissedOldWeek: [],
      recentRemovalLog: [],
      oldWeekRemovalLog: [],
      blocklist: [],
      starredTokens: [],
      eligibleCatalogTokens: [],
      meteoraByAddress: {},
      alerts: [],
      pumpTokens: [],
      recentPumpMigrations: [],
      pumpToasts: [],
    },
    ui: {
      busy: false,
      error: null,
      notice: null,
      recentPage: 0,
      oldWeekPage: 0,
      recentPerPage: 30,
      oldWeekPerPage: 30,
      manualSort: 'mcap',
      manualSortWindow: '24h',
      recentSort: 'vol',
      recentSortWindow: '24h',
      oldWeekSort: 'vol',
      oldWeekSortWindow: '24h',
      monitoredSort: '5m',
      soundEnabled: true,
      soundVolume: 0.05,
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
