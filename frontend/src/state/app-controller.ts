import { createAppState, getAlertFeedAlerts, getManualTokens, getMonitoredTokens, getOldWeekTokens, getRecentTokens, getTrackedToken, isMockTradingEnabled, type AddressItem, type AdminTokenReviewAlertEntry, type AlertEntry, type AppState, type AuthPanel, type BidZoneTokenEntry, type BillingOrderEntry, type BillingPlanEntry, type BlockTokenWarningState, type BucketSortCriterion, type BucketSortMode, type BucketSortWindow, type CollapsibleSectionKey, type CustomAlertMetric, type CustomAlertPreviewInput, type CustomAlertRuleEntry, type LinkedIdentityEntry, type ManualTokenEntry, type ManualTokenFolderEntry, type ManualTokenFolderItemEntry, type MeteoraEntry, type MockTradingPositionEntry, type MockTradingTradeEntry, type MockTradingWalletEntry, type MonitoredSortCriterion, type MonitoredSortMode, type MonitoredSortWindow, type ProfileAuthPanel, type PumpTokenEntry, type TokenSparklineCandleEntry, type TokenSparklineEntry, type WorkspaceView } from '../state/app-state';
import { resolveManualTableRows, resolveMonitoredTableRows } from '../utils/token-table';
import {
  createLegacyCompatibleTokenIdentity,
  hasEnabledChainCapability,
  normalizeAvailableTokenChains,
  normalizeChainFilterPreferences,
  normalizeStoredTokenIdentityKeys,
  normalizeTokenChain,
  parseTokenIdentityKey,
  toggleEnabledTokenChain,
  toggleTokenChainForSurface,
  type TokenChain,
  type TokenIdentity,
  type WorkspaceChainCapability,
} from '../utils/token-chain';
import {
  resolveWorkspaceMarketSnapshotMs,
  selectWorkspaceSnapshotValue,
} from '../utils/token-valuation';
import {
  changePassword as changePasswordRequest,
  confirmEmailVerification as confirmEmailVerificationRequest,
  resendLoginOtp as resendLoginOtpRequest,
  confirmPasswordReset as confirmPasswordResetRequest,
  fetchCurrentSession,
  login,
  logout,
  logoutAll,
  requestEmailVerification as requestEmailVerificationRequest,
  requestPasswordReset as requestPasswordResetRequest,
  register as registerRequest,
  type RegisterInput,
  type AuthEmailDebug,
  type SessionUser,
  type VerifyEmailConfirmResponse,
  verifyLoginOtp as verifyLoginOtpRequest,
} from '../services/api/auth';
import {
  requestWalletChallenge,
  requestWalletLinkChallenge,
  verifyWalletLinkSignature,
  verifyWalletSignature,
} from '../services/api/wallet-auth';
import {
  addManualTokenToFolder as addManualTokenToFolderRequest,
  addManualToken as addManualTokenRequest,
  addBlockedToken as addBlockedTokenRequest,
  addStarredToken as addStarredTokenRequest,
  createManualTokenFolder as createManualTokenFolderRequest,
  deleteManualTokenFolder as deleteManualTokenFolderRequest,
  fetchAdminTokenReviewAlerts,
  fetchChainReadiness,
  fetchConfig,
  fetchManualTokenFolders,
  patchConfig,
  patchUiPrefs,
  resolveAdminTokenReviewAlert as resolveAdminTokenReviewAlertRequest,
  removeManualTokenFromFolder as removeManualTokenFromFolderRequest,
  removeManualToken as removeManualTokenRequest,
  removeBlockedToken as removeBlockedTokenRequest,
  removeStarredToken as removeStarredTokenRequest,
  updateManualTokenFolder as updateManualTokenFolderRequest,
  type AdminTokenReviewResolution,
  type ConfigPayload,
  type ManualTokenFoldersPayload,
  type UiPrefsPayload,
} from '../services/api/config';
import {
  fetchAccountAccess,
  fetchAccountIdentities,
  fetchAccountSecurityIdentities,
  unlinkAccountSecurityIdentity,
  updateAccountProfile as updateAccountProfileRequest,
  type AccountAccessPayload,
  type AccountIdentitiesPayload,
} from '../services/api/account';
import { createBillingOrder, fetchBillingState, fetchPublicBillingPlans, type BillingStatePayload, type PublicBillingPlansPayload } from '../services/api/billing';
import { completePreAccessSession, createPreAccessOrder, fetchPreAccessBillingState, fetchPreAccessMe, logoutPreAccessSession, syncPreAccessOrder, type PreAccessBillingStatePayload } from '../services/api/pre-access';
import { adminBlockToken as adminBlockTokenRequest, adminUnblockToken as adminUnblockTokenRequest, clearDashboardAlertEvents, createCustomAlertRule as createCustomAlertRuleRequest, disableCustomAlertRule as disableCustomAlertRuleRequest, dismissDashboardAlertEvent, fetchCustomAlertRules as fetchCustomAlertRulesRequest, updateCustomAlertRule as updateCustomAlertRuleRequest, type CreateCustomAlertRulePayload, type CustomAlertRule, fetchBidZoneCandidates, fetchDashboardAlertFeeds, fetchDashboardHistoryBootstrap, fetchDashboardMonitored, fetchDashboardTopPerformers, fetchExpandedTokenSparkline, fetchMeteoraBatch, fetchMonitoredMetadataBatch, fetchPumpfunTokenMeta, fetchTokenSparklines, refreshBidZoneSnapshot as refreshBidZoneSnapshotRequest, reportMigratedToken, resetMonitoredPins as resetMonitoredPinsRequest, saveMonitoredPins as saveMonitoredPinsRequest, trackManualToken, updateDashboardAlertCursor, type BidZonePayload, type DashboardAlertEvent, type DashboardHistoryBucketRequest, type DashboardHistoryDebugProbeEntry, type DashboardMonitoredPin, type DashboardMonitoredToken, type DashboardTopPerformersPayload, type MeteoraBatchItem, type TokenSparklinesPayload } from '../services/api/catalog';
import { addMockTradingCash, archiveMockTradingWallet as archiveMockTradingWalletRequest, buyMockTradingToken, cancelMockTradingTakeProfitOrder as cancelMockTradingTakeProfitOrderRequest, createMockTradingTakeProfitOrder, createMockTradingWallet as createMockTradingWalletRequest, fetchMockTradingPositions, fetchMockTradingSummary, fetchMockTradingTrades, fetchMockTradingWallets, resetMockTradingPortfolio as resetMockTradingPortfolioRequest, sellMockTradingToken, setDefaultMockTradingWallet as setDefaultMockTradingWalletRequest, updateMockTradingWallet as updateMockTradingWalletRequest } from '../services/api/mock-trading';
import { clearLegacyAuthToken } from '../utils/auth-storage';
import { getBackendAlertEventId, partitionVisibleAlertEntries } from './alert-feed-actions';
import {
  addUnincludedLiveActivity,
  mergeMonitoredFirstPage,
  shouldApplyDashboardValuation,
  shouldRunFullMonitoredHydration,
} from './monitored-refresh-policy';
import { normalizeCustomAlertCapabilities, requireCustomAlertCapability } from '../services/alerts/custom-alert-capability';
import { loadSoundSettings, saveSoundSettings } from '../utils/sound-storage';
import {
  clearRecentRemovalLogStorage,
  clearOldWeekRemovalLogStorage,
  loadAlertSparklineCache,
  loadAlerts,
  loadDismissedOldWeek,
  loadDismissedRecent,
  saveAlertSparklineCache,
  saveAlerts,
  saveDismissedOldWeek,
  saveDismissedRecent,
} from '../utils/bar-storage';
import { bindSocketLifecycle, disconnectSocket, replaceWorkspaceMarketSubscriptions, subscribeMarketChart, subscribePumpMint, unsubscribeMarketChart, unsubscribePumpMint, type MarketBucketUpdateEvent } from '../services/socket/client';
import { buildLiveTokenChartCandle, buildRealtimeTokenMarketPatch, shouldReplaceMarketCandleClose, type RealtimeActivityState, type RealtimeTokenMarketPatch } from '../services/socket/market-events';
import { clearChartAlertHistory, publishRealtimeChartAlert } from '../services/charts/chart-alert-history';
import {
  normalizeInviteCode,
  normalizeAuthRouteToken,
  normalizeLoginOtpChallengeToken,
  validateChangePasswordInput,
  validateLoginCredentials,
  validateLoginOtpInput,
  validatePasswordResetConfirmInput,
  validatePasswordResetRequestInput,
  validateRegisterInput,
} from './auth-flow-utils';
import { validateInviteCode, type InviteValidationResponse } from '../services/api/invites';
import { resolveApiBase } from '../services/api/base';
import {
  getApiRateLimitBackoffRemainingMs,
  isApiRateLimitBackoffError,
} from '../services/api/rate-limit-backoff';
import { API_RESPONSE_DEBUG_EVENT } from '../services/api/response-metadata';
import { trimLoginEmailValue } from '../ui/sections/login-form-utils';
import {
  getWorkspaceSparklineNextRefreshAt,
  resolveWorkspaceSparklineGranularityMinutes,
  runWorkspaceSparklineRequestWithTimeout,
  selectWorkspaceSparklineRefreshBatches,
  splitWorkspaceSparklineBatchesByChain,
} from './workspace-sparkline-refresh';
import { evaluateSparklineDebugEvent } from './sparkline-debug-policy';
import {
  findPreviousPasswordMatch,
  formatPasswordChangedDate,
  rememberPreviousPassword,
} from '../utils/password-history';
import {
  getRuntimePerfDebugArchives,
  getRuntimePerfDebugLog,
  isRuntimePerfDebugEnabled,
  measureRuntimePerf,
  measureRuntimePerfAsync,
  readRuntimePerfMemory,
  recordRuntimePerfDebugEntry,
} from '../utils/runtime-perf-debug';
import { hasUsableMockSolRate } from '../utils/mock-trading-display';
import {
  getBrowserNotificationStatus,
  loadBrowserNotificationSettings,
  requestBrowserNotificationPermission,
  saveBrowserNotificationSettings,
} from '../services/alerts/browser-notifications';
import {
  connectSolanaWallet,
  getSolanaNetworkLabel,
  listSolanaWallets,
} from '../services/wallets/solana-wallets';

const AUTH_NOTICE_NO_SESSION = 'No saved session. Sign in to continue.';
const AUTH_NOTICE_RESTORING = 'Restoring session...';
const AUTH_NOTICE_SIGNING_IN = 'Signing in...';
const AUTH_NOTICE_SESSION_RESTORED = 'Session restored. Workspace synced.';
const AUTH_NOTICE_LOGIN_SUCCESS = 'Login successful. Workspace synced.';
const COOKIE_SESSION_MARKER = '__cookie_session__';
const SOCIAL_LINK_RESULT_STORAGE_KEY = 'trend_scope_social_link_result';
const SOCIAL_LINK_POPUP_WINDOW_NAME = 'trend_scope_social_link_popup';
const SOCIAL_LINK_RESULT_MESSAGE_TYPE = 'trend_scope_social_link_result';
const SOCIAL_LINK_SYNC_POLL_MS = 1000;
const SOCIAL_LINK_SYNC_TIMEOUT_MS = 90_000;
const AUTH_ERROR_COOKIE_BLOCKED = 'Login succeeded, but the secure session cookie was not accepted. Check browser cookie/privacy settings and try again.';
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function resolveAppTokenChain(value: unknown): TokenChain {
  return normalizeTokenChain(value) ?? 'solana';
}
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const STANDARD_ALERT_COOLDOWN_MS = 60_000;
const OLD_WEEK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HVNC_MAX_AGE_MS = 5 * 60 * 1000;
const MCAP_ALERT_MIN_TOKEN_AGE_MS = 60 * 60 * 1000;
const PUMP_WINDOW_MS = 5 * 60 * 1000;
const PUMP_VOLUME_BUCKET_MS = 5 * 1000;
const PUMP_GC_INTERVAL_MS = 30 * 1000;
const PUMP_GC_INACTIVE_MS = 15 * 60 * 1000;
const PUMP_GC_LOW_MCAP = 4000;
const PUMP_GC_LOW_MCAP_TIME_MS = 13 * 60 * 1000;
const PUMP_TOAST_TTL_MS = 7 * 1000;
const PUMP_SILENCE_MIGRATION_MS = 30 * 1000;
const PUMP_SILENCE_MIGRATION_MIN_MCAP = 30000;
const DEFAULT_MONITORED_MIN_VALUATION_USD = 30000;
const PUMP_RENDER_THROTTLE_MS = 500;
const UPTIME_REFRESH_INTERVAL_MS = 30 * 1000;
const OLD_WEEK_MIN_AGE_MINUTES = Math.floor(OLD_WEEK_MIN_AGE_MS / (60 * 1000));
const RECENT_MAX_AGE_MINUTES = OLD_WEEK_MIN_AGE_MINUTES;
const OPEN_ENDED_AGE_MAX_MINUTES = 100 * 365 * 24 * 60;

function getMockTradingBuyValidationError(
  state: AppState,
  notionalSol: number,
  takeProfit?: { targetMcapUsd?: number | null; sellPercent?: number | null },
) {
  if (!Number.isFinite(notionalSol) || notionalSol <= 0) {
    return 'Mock buy SOL amount must be greater than zero';
  }
  if (!hasUsableMockSolRate(state.data.mockTradingSummary)) {
    return 'SOL/USD price is unavailable';
  }
  if (takeProfit?.targetMcapUsd != null && (!Number.isFinite(takeProfit.targetMcapUsd) || takeProfit.targetMcapUsd <= 0)) {
    return 'Take profit MCAP must be greater than zero';
  }
  if (takeProfit?.sellPercent != null && (!Number.isFinite(takeProfit.sellPercent) || takeProfit.sellPercent <= 0 || takeProfit.sellPercent > 100)) {
    return 'Take profit percent must be between 1 and 100';
  }
  return null;
}

function encodeBase58(bytes: Uint8Array | number[]) {
  const buffer = Array.from(bytes || []);
  let value = buffer.reduce((total, byte) => (total * 256n) + BigInt(byte), 0n);
  let encoded = '';
  while (value > 0n) {
    const mod = Number(value % 58n);
    encoded = BASE58_ALPHABET[mod] + encoded;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function normalizeWalletLoginError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  if (lower.includes('user rejected') || lower.includes('rejected') || lower.includes('denied')) {
    return 'Wallet signature was declined.';
  }
  if (lower.includes('token access requirements') || lower.includes('insufficient')) {
    return 'This wallet does not currently meet the token access requirement.';
  }
  if (lower.includes('invalid solana wallet') || lower.includes('wallet address')) {
    return 'Connected wallet address is not a valid Solana wallet.';
  }
  if (lower.includes('signature')) {
    return 'Wallet signature could not be verified.';
  }
  return message || 'Wallet login failed';
}
const REPEAT_LOCAL_ALERT_STEP_PCT = 40;
const CROSS_ALERT_BLOCK_MS = 5 * 60 * 1000;
const PUMP_IMAGE_TIMEOUT_MS = 5000;
const MONITORED_REFRESH_INTERVAL_MS = 3 * 1000;
const MONITORED_DASHBOARD_POLL_INTERVAL_MS = 15 * 1000;
const MONITORED_FULL_HYDRATION_INTERVAL_MS = 60 * 1000;
const WORKSPACE_REALTIME_SUBSCRIPTION_LIMIT = 300;
const MONITORED_DASHBOARD_HYDRATION_PAGE_SIZE = 100;
const MONITORED_DASHBOARD_HYDRATION_MAX_ITEMS = 500;
const MOCK_TRADING_MARKET_REFRESH_INTERVAL_MS = 3 * 1000;
const FLOATING_QUICK_BUY_NOTIONAL_SOL = 0.3;
const FLOATING_QUICK_BUY_DASHBOARD_REFRESH_INTERVAL_MS = MONITORED_REFRESH_INTERVAL_MS;
const MOCK_TRADING_ACTIVE_WALLET_KEY = 'mock_trading_active_wallet';
const BID_ZONE_REFRESH_INTERVAL_MS = 60 * 1000;
const BID_ZONE_PANEL_LIMIT = 24;
const SPARKLINE_REFRESH_INTERVAL_MS = 60 * 1000;
const SPARKLINE_REQUEST_TIMEOUT_MS = 12 * 1000;
const SPARKLINE_WINDOW_HOURS = 14 * 24;
const SPARKLINE_POINT_COUNT = 336;
const EXPANDED_SPARKLINE_POINT_COUNT = 720;
const EXPANDED_SPARKLINE_FRONTEND_CACHE_MS = 30 * 1000;
const EXPANDED_SPARKLINE_GRANULARITIES = [1, 5, 15, 30, 60, 240, 1440] as const;
const EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES = 5;
const EXPANDED_CHART_TIME_ZONES = [
  'browser',
  'UTC',
  'America/Fortaleza',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
] as const;
const EXPANDED_CHART_DEFAULT_TIME_ZONE = 'browser';
const EXPANDED_SPARKLINE_ONE_MINUTE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SPARKLINE_VISIBLE_LIMIT_TOTAL = 100;
const SPARKLINE_VISIBLE_LIMIT_MANUAL = 30;
const SPARKLINE_CACHE_MAX_ENTRIES = 300;
const SPARKLINE_AGE_1M_MAX_MS = 24 * 60 * 60 * 1000;
const SPARKLINE_AGE_5M_MAX_MS = 72 * 60 * 60 * 1000;
const SPARKLINE_AGE_15M_MAX_MS = 11 * 24 * 60 * 60 * 1000;
const SPARKLINE_GRANULARITY_FALLBACK_MINUTES = 30;
const SPARKLINE_RANGE_MIN_DAYS = 1;
const SPARKLINE_RANGE_MAX_DAYS = 14;
const SPARKLINE_RANGE_DEFAULT_DAYS = 14;
const SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX = 250;
const METEORA_ALERT_MIN_TVL = 10000;
const COLD_FIELD_RECHECK_MS = 10 * 60 * 1000;
const MANUAL_METADATA_BATCH_CACHE_MS = 12 * 1000;
const MANUAL_METADATA_METEORA_REFRESH_MS = 12 * 1000;
const RESTORED_SESSION_CONFIG_REFRESH_MS = 60 * 1000;
const ALERT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const ADMIN_TOKEN_REVIEW_ALERT_REFRESH_INTERVAL_MS = 15 * 1000;
const ADMIN_TOKEN_REVIEW_EXCLUDED_SUFFIXES = ['pump', 'bonk', 'bags'];
const GMGN_CLAIM_SIGNAL_RULE_KEY = 'gmgn-claim-signal';
const BLOCK_WARNING_ENABLED_CONFIG_KEY = 'block-warning-enabled';
const ROUTED_BUCKET_DEFAULT_PER_PAGE = 15;
const ALERTS_MAX_ENTRIES = 120;
const ALERTS_PER_PAGE = 40;
const ALERT_STORAGE_DEBOUNCE_MS = 250;
const ALERT_DEBUG_LOG_KEY = 'trendscope-alert-debug-log';
const ALERT_DEBUG_MAX_ENTRIES = 500;
const SPARKLINE_DEBUG_ENABLED_KEY = 'trendscope:sparkline-debug';
const SPARKLINE_DEBUG_LOG_KEY = 'trendscope:sparkline-debug-log';
const SPARKLINE_DEBUG_MAX_ENTRIES = 400;
const SPARKLINE_DEBUG_CONTEXT_MAX_ENTRIES = 160;
const SPARKLINE_DEBUG_TRIGGER_CAPTURE_MS = 5 * 60 * 1000;
const SPARKLINE_DEBUG_LOW_REMAINING_THRESHOLD = 80;
const ALERT_SPARKLINE_BATCH_DELAY_MS = 150;
const HISTORY_SYNC_CHANNEL_NAME = 'trendscope-history-sync';
const HISTORY_SYNC_HEARTBEAT_MS = 2000;
const HISTORY_SYNC_PEER_TTL_MS = 6000;
const LEGACY_NETWORK_DEBUG_STORAGE_KEYS = [
  'trendscope-network-debug-enabled',
  'trendscope-network-debug-log',
];

type HistorySyncPresenceMessage = {
  type: 'presence';
  tabId: string;
  workspace: WorkspaceView;
  authenticated: boolean;
  monitoringActive: boolean;
  ts: number;
};

type HistorySyncClosingMessage = {
  type: 'closing';
  tabId: string;
  ts: number;
};

type HistorySyncMonitoredSnapshotMessage = {
  type: 'monitored-snapshot';
  tabId: string;
  workspace: WorkspaceView;
  generatedAt: string | null;
  tokens: DashboardMonitoredToken[];
  ts: number;
};

type HistoryBootstrapRequestPayload = {
  chains: TokenChain[];
  starredTokenIdentities: string[];
  recent: DashboardHistoryBucketRequest;
  oldWeek: DashboardHistoryBucketRequest;
  recentPinnedIdentities?: string[];
  oldWeekPinnedIdentities?: string[];
  recentDebugProbeIdentities?: string[];
};

type HistoryBootstrapPayload = Awaited<ReturnType<typeof fetchDashboardHistoryBootstrap>>;

type HistorySyncBootstrapSnapshotMessage = {
  type: 'history-bootstrap-snapshot';
  tabId: string;
  workspace: WorkspaceView;
  requestPayload: HistoryBootstrapRequestPayload;
  payload: HistoryBootstrapPayload;
  ts: number;
};

type HistorySyncBidZoneSnapshotMessage = {
  type: 'bid-zone-snapshot';
  tabId: string;
  workspace: WorkspaceView;
  payload: BidZonePayload;
  ts: number;
};

type HistorySyncTopPerformersSnapshotMessage = {
  type: 'top-performers-snapshot';
  tabId: string;
  workspace: WorkspaceView;
  payload: DashboardTopPerformersPayload;
  ts: number;
};

type HistorySyncSparklineSnapshotMessage = {
  type: 'sparkline-snapshot';
  tabId: string;
  workspace: WorkspaceView;
  payload: TokenSparklinesPayload;
  ts: number;
};

type HistorySyncMessage =
  | HistorySyncPresenceMessage
  | HistorySyncClosingMessage
  | HistorySyncMonitoredSnapshotMessage
  | HistorySyncBootstrapSnapshotMessage
  | HistorySyncBidZoneSnapshotMessage
  | HistorySyncTopPerformersSnapshotMessage
  | HistorySyncSparklineSnapshotMessage;

type HistoryPeerState = {
  workspace: WorkspaceView;
  authenticated: boolean;
  monitoringActive: boolean;
  seenAt: number;
};

type SparklineBatchRequest = {
  hours: number;
  granularityMinutes: number;
  identities: TokenIdentity[];
};

type WorkspaceSparklineRefreshOptions = {
  force?: boolean;
  token?: string;
  caller?: string;
};

type SparklineDebugEntry = {
  event: string;
  meta: Record<string, unknown>;
  t: number;
  ts: string;
};

type SparklineDebugWindow = Window & {
  trendscopeSparklineDebug?: {
    arm: () => void;
    clear: () => void;
    copy: () => Promise<string | undefined>;
    capture: (durationMs?: number) => void;
    disable: () => void;
    dump: () => SparklineDebugEntry[];
    enable: () => void;
    status: () => Record<string, unknown>;
    text: () => string;
  };
};

type SparklineRangeScope = 'monitored' | 'recent' | 'oldWeek';

function createSparklineDebugId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const sparklineDebugTabId = createSparklineDebugId('tab');

type HistoryBootstrapRefreshOptions = {
  token?: string;
  manualTokensOverride?: AddressItem[];
  suppressErrors?: boolean;
};

type SocialProvider = 'google' | 'discord';
type SocialIntent = {
  status: string;
  provider: SocialProvider;
};

type AuthRouteIntent = {
  mode: 'verify-email' | 'reset-password';
  token: string | null;
};

const TRACKED_MARKET_FIELD_KEYS = [
  'mcap',
  'fdv',
  'priceUsd',
  'liquidityUsd',
  'volume5m',
  'volume1h',
  'volume6h',
  'volume24h',
  'priceChange1h',
  'priceChange6h',
  'priceChange24h',
  'historySortScore',
  'mcapDelta',
  'prevMcap',
  'prevVolume5mCanonical',
] as const;

const TRACKED_REALTIME_VALUATION_FIELD_KEYS = new Set([
  'mcap',
  'fdv',
  'priceUsd',
]);

function shouldApplyTrackedMarketField(
  key: typeof TRACKED_MARKET_FIELD_KEYS[number],
  marketFieldsAreAuthoritative: boolean,
  valuationFieldsAreAuthoritative: boolean,
) {
  return TRACKED_REALTIME_VALUATION_FIELD_KEYS.has(key)
    ? valuationFieldsAreAuthoritative
    : marketFieldsAreAuthoritative;
}

const TRACKED_MARKET_CONTEXT_FIELD_KEYS = [
  'valuation',
  'windowEnd',
  'lastActivityAt',
  'swaps5m',
  'swaps1h',
  'swaps6h',
  'swaps24h',
  'coverage',
  'swapCoverage',
  'priceChangeCoverage',
  'volume5mBaselineAt',
  'volume5mWindowEnd',
  'volume5mDeltaCoverage',
  'activityState',
  'riskState',
  'dataQuality',
] as const;

const TRACKED_ROLLING_VOLUME_FIELDS = [
  'volume5m', 'volume1h', 'volume6h', 'volume24h',
] as const;
const TRACKED_ROLLING_SWAP_FIELDS = [
  'swaps5m', 'swaps1h', 'swaps6h', 'swaps24h',
] as const;

function addTrackedRealtimeDelta(
  current: number | null | undefined,
  delta: number | null | undefined,
) {
  return current != null && delta != null ? current + delta : current ?? null;
}

function getRealtimeActivityState(existing?: ManualTokenEntry | null): RealtimeActivityState {
  return {
    bucketTs: existing?._liveActivityBucketTs,
    volumeUsd: existing?._liveActivityVolumeUsd,
    swaps: existing?._liveActivitySwaps,
    windowEnd: existing?.windowEnd,
    prevVolume5mCanonical: existing?.prevVolume5mCanonical,
    volume5mBaselineAt: existing?.volume5mBaselineAt,
    volume5mWindowEnd: existing?.volume5mWindowEnd,
    volume5mDeltaCoverage: existing?.volume5mDeltaCoverage,
  };
}

function applyCanonicalVolume5mFields(
  fields: Partial<ManualTokenEntry>,
  existing: ManualTokenEntry,
  canonical: NonNullable<NonNullable<RealtimeTokenMarketPatch['activity']>['canonicalVolume5m']>,
) {
  if (canonical.currentVolumeUsd != null) fields.volume5m = canonical.currentVolumeUsd;
  if (canonical.previousVolumeUsd != null) {
    fields.prevVolume5mCanonical = canonical.previousVolumeUsd;
  }
  fields.volume5mBaselineAt = canonical.baselineAt ?? existing.volume5mBaselineAt ?? null;
  fields.volume5mWindowEnd = canonical.windowEnd ?? existing.volume5mWindowEnd ?? null;
  fields.volume5mDeltaCoverage = canonical.coverage;
}

function buildRealtimeActivityFields(
  existing: ManualTokenEntry,
  activity: RealtimeTokenMarketPatch['activity'],
): Partial<ManualTokenEntry> {
  const fields: Partial<ManualTokenEntry> = {};
  for (const key of TRACKED_ROLLING_VOLUME_FIELDS) {
    fields[key] = addTrackedRealtimeDelta(existing[key], activity?.volumeDeltaUsd);
  }
  for (const key of TRACKED_ROLLING_SWAP_FIELDS) {
    fields[key] = addTrackedRealtimeDelta(existing[key], activity?.swapsDelta);
  }
  fields._liveActivityBucketTs = activity?.bucketTs ?? existing._liveActivityBucketTs ?? null;
  fields._liveActivityVolumeUsd = activity?.volumeUsd ?? existing._liveActivityVolumeUsd ?? null;
  fields._liveActivitySwaps = activity?.swaps ?? existing._liveActivitySwaps ?? null;
  const canonical = activity?.canonicalVolume5m;
  if (canonical) applyCanonicalVolume5mFields(fields, existing, canonical);
  return fields;
}

function overlayLiveActivityOnDashboardSnapshot(
  fields: Partial<ManualTokenEntry>,
  existing: ManualTokenEntry | undefined,
  dashboard: DashboardMonitoredToken | undefined,
  applyDashboardFields: boolean,
) {
  if (!applyDashboardFields || !existing || !dashboard) return;
  for (const key of TRACKED_ROLLING_VOLUME_FIELDS) {
    fields[key] = addUnincludedLiveActivity(
      fields[key], dashboard.windowEnd,
      existing._liveActivityBucketTs, existing._liveActivityVolumeUsd,
    );
  }
  for (const key of TRACKED_ROLLING_SWAP_FIELDS) {
    fields[key] = addUnincludedLiveActivity(
      fields[key], dashboard.windowEnd,
      existing._liveActivityBucketTs, existing._liveActivitySwaps,
    );
  }
}

function shouldApplyTrackedMarketContext(
  key: typeof TRACKED_MARKET_CONTEXT_FIELD_KEYS[number],
  marketFieldsAreAuthoritative: boolean,
  valuationFieldsAreAuthoritative: boolean,
) {
  return key === 'valuation' || key === 'activityState'
    ? valuationFieldsAreAuthoritative
    : marketFieldsAreAuthoritative;
}

const TRACKED_ALERT_PRESERVED_KEYS = [
  'lastAlertAt',
  '_hvncFired',
  '_meteoraSurgeFired',
  '_lastVolAlertPct',
  '_lastMcapAlertPct',
  '_lastAlertKind',
] as const;
export interface AppController {
  state: AppState;
  init(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  loginWithWallet(walletId?: string): Promise<void>;
  verifyLoginOtp(code: string): Promise<void>;
  resendLoginOtp(): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  changePassword(currentPassword: string, newPassword: string, confirmNewPassword: string): Promise<void>;
  requestEmailVerification(email?: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(newPassword: string, confirmNewPassword: string): Promise<void>;
  validateInvite(code: string): Promise<InviteValidationResponse>;
  openAuthPanel(panel: Exclude<AuthPanel, 'none'>): void;
  closeAuthPanel(): void;
  goToLogin(panel?: 'register'): void;
  goToPublicLanding(): void;
  goToAccountSecurity(): void;
  goToPreAccess(): void;
  refreshBilling(): Promise<void>;
  updateAccountProfile(username: string, email: string, password: string, confirmPassword: string): Promise<void>;
  startSocialLink(provider: 'google' | 'discord'): void;
  startSocialLogin(provider: 'google' | 'discord'): void;
  connectWallet(walletId?: string): Promise<void>;
  closeWalletSelector(): void;
  openIdentityUnlink(provider: 'google' | 'discord'): void;
  cancelIdentityUnlink(): void;
  unlinkSocialIdentity(provider: 'google' | 'discord', currentPassword: string): Promise<void>;
  startBillingCheckout(planKey: string): Promise<void>;
  startPreAccessCheckout(planKey: string): Promise<void>;
  completePreAccess(): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  reloadConfig(): Promise<void>;
  saveMonitoringConfig(configs: Record<string, number | string>): Promise<void>;
  addManualToken(address: string, label?: string | null, chain?: TokenChain): Promise<void>;
  removeManualToken(address: string, chain?: TokenChain): Promise<void>;
  createManualTokenFolder(name: string): Promise<void>;
  updateManualTokenFolder(folderId: number, input: { name?: string; sortOrder?: number }): Promise<void>;
  deleteManualTokenFolder(folderId: number): Promise<void>;
  addManualTokenToFolder(folderId: number, address: string, chain?: TokenChain): Promise<void>;
  removeManualTokenFromFolder(folderId: number, address: string, chain?: TokenChain): Promise<void>;
  setManualVisibleFolderIds(folderIds: number[]): void;
  addBlockedToken(address: string, label?: string | null, chain?: TokenChain): Promise<void>;
  cancelBlockedTokenWarning(): Promise<void>;
  setBlockedTokenWarningDontShowAgain(enabled: boolean): void;
  confirmBlockedTokenWarning(): Promise<void>;
  adminBlockToken(address: string, label?: string | null): Promise<void>;
  adminUnblockToken(address: string): Promise<void>;
  refreshAdminTokenReviewAlerts(): Promise<void>;
  resolveAdminTokenReviewAlert(id: number, resolution: AdminTokenReviewResolution): Promise<void>;
  mockBuyToken(address: string): Promise<void>;
  mockSellToken(address: string, percent: number): Promise<void>;
  setActiveMockTradingWallet(walletId: number): Promise<void>;
  createMockTradingWallet(name: string): Promise<void>;
  updateMockTradingWallet(walletId: number, name: string): Promise<void>;
  archiveMockTradingWallet(walletId: number): Promise<void>;
  setDefaultMockTradingWallet(walletId: number): Promise<void>;
  openMockTradingHistory(): void;
  closeMockTradingHistory(): void;
  openMockTradingPnlResume(address: string): void;
  closeMockTradingPnlResume(): void;
  closeMockTradingTicket(): void;
  submitMockTradingBuy(address: string, notionalSol: number, takeProfit?: { targetMcapUsd?: number | null; sellPercent?: number | null }): Promise<void>;
  submitMockTradingSell(address: string, percent: number): Promise<void>;
  submitMockTradingSellOrder(address: string, targetMcapUsd: number, sellPercent: number): Promise<void>;
  cancelMockTradingTakeProfitOrder(orderId: number): Promise<void>;
  openFloatingQuickBuy(): void;
  closeFloatingQuickBuy(): void;
  armFloatingQuickBuy(address: string): Promise<void>;
  cancelFloatingQuickBuy(): void;
  addMockTradingCash(): Promise<void>;
  resetMockTradingPortfolio(): Promise<void>;
  removeBlockedToken(address: string, chain?: TokenChain): Promise<void>;
  removePumpToken(mint: string): void;
  dismissRecentToken(address: string, chain?: TokenChain): void;
  dismissOldWeekToken(address: string, chain?: TokenChain): void;
  clearAllAlerts(): void;
  removeAlert(id: string): void;
  previewCustomAlert(input: CustomAlertPreviewInput): void;
  createCustomAlert(input: CustomAlertPreviewInput): Promise<void>;
  loadCustomAlertRules(): Promise<void>;
  updateCustomAlert(ruleId: number, input: CustomAlertPreviewInput): Promise<void>;
  disableCustomAlert(ruleId: number): Promise<void>;
  openExpandedSparkline(address: string, chain?: TokenChain): void;
  openAlertExpandedSparkline(alertId: string, address: string): void;
  closeExpandedSparkline(): void;
  setExpandedSparklineGranularity(granularityMinutes: number): void;
  setExpandedSparklineTimeZone(timeZone: string): void;
  clearDismissedRecent(): void;
  clearDismissedOldWeek(): void;
  toggleSectionCollapsed(section: CollapsibleSectionKey): void;
  setAlertSearchQuery(query: string): void;
  setMonitoredSearchQuery(query: string): void;
  setManualSearchQuery(query: string): void;
  setRecentSearchQuery(query: string): void;
  setOldWeekSearchQuery(query: string): void;
  setManualStarredOnly(enabled: boolean): void;
  setManualFolderDeleteWarningDismissed(enabled: boolean): void;
  setRecentStarredOnly(enabled: boolean): void;
  setOldWeekStarredOnly(enabled: boolean): void;
  toggleEnabledChain(chain: TokenChain): void;
  toggleSurfaceChain(
    surface: 'radarChains' | 'alertFeedChains' | 'browserNotificationChains',
    chain: TokenChain,
  ): void;
  setMonitoredPage(page: number): void;
  setAlertPage(page: number): void;
  setRecentPage(page: number): void;
  setOldWeekPage(page: number): void;
  setMonitoredPerPage(perPage: number): void;
  setRecentPerPage(perPage: number): void;
  setOldWeekPerPage(perPage: number): void;
  setSparklineRangeDays(scope: SparklineRangeScope, days: number): void;
  setSparklineRangeGlobal(enabled: boolean, scope: SparklineRangeScope): void;
  setTokenSparklineRangeDays(address: string, days: number, chain?: TokenChain): void;
  resetTokenSparklineRangeDays(address: string, chain?: TokenChain): void;
  setManualSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setRecentSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setHistoryBucketOrderLocked(bucket: 'recent' | 'old-week', locked: boolean): void;
  setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow): void;
  pinMonitoredToken(address: string, position?: number, chain?: TokenChain): Promise<void>;
  unpinMonitoredToken(address: string, chain?: TokenChain): Promise<void>;
  resetMonitoredTokenPins(): Promise<void>;
  setEnabledTradeTerminals(terminals: AppState['ui']['enabledTradeTerminals']): void;
  setLivePanelSpan(panel: 'monitored' | 'alerts', span: 1 | 2 | 3): void;
  setLivePanelHeight(panel: 'monitored' | 'alerts', height: number): void;
  setLivePanelOrder(order: Array<'monitored' | 'pumpfun' | 'alerts'>): void;
  resetLivePanelLayout(): void;
  setSoundEnabled(enabled: boolean): void;
  setSoundVolume(volume: number): void;
  enableBrowserNotifications(): Promise<void>;
  disableBrowserNotifications(): void;
  toggleStarredToken(address: string, chain?: TokenChain): Promise<void>;
  setWorkspace(workspace: WorkspaceView): void;
  syncWorkspaceFromLocation(): void;
  refreshRestoredSessionState(options?: { force?: boolean }): Promise<void>;
  setDocumentHidden(hidden: boolean): void;
  startMonitoring(): void;
  stopMonitoring(): void;
  clearNotice(): void;
  clearError(): void;
  refreshBidZoneSnapshot(): Promise<void>;
  subscribe(listener: (state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) => void): () => void;
}

export type AppRenderRegion =
  | 'all'
  | 'header'
  | 'toasts'
  | 'legacy'
  | 'top-performers'
  | 'manual'
  | 'recent'
  | 'old-week'
  | 'monitored'
  | 'bid-zone'
  | 'pumpfun'
  | 'alerts'
  | 'overlay';

function normalizeRoutePath(pathname: string | null | undefined) {
  const value = String(pathname || '/').trim().toLowerCase();
  if (value.length > 1 && value.endsWith('/')) {
    return value.replace(/\/+$/, '');
  }
  return value || '/';
}

function isAuthRoutePath(pathname: string | null | undefined) {
  const normalizedPathname = normalizeRoutePath(pathname);
  return normalizedPathname === '/auth/verify-email' || normalizedPathname === '/auth/reset-password';
}

function isLoginRoutePath(pathname: string | null | undefined) {
  const value = normalizeRoutePath(pathname);
  return value === '/login' || value.startsWith('/login/');
}

function isPublicLandingRoutePath(pathname: string | null | undefined) {
  return normalizeRoutePath(pathname) === '/';
}

function isAccountSecurityRoutePath(pathname: string | null | undefined) {
  const value = normalizeRoutePath(pathname);
  return value === '/account-security' || value.startsWith('/account-security/');
}

type LoginRouteAuthPanel = 'register' | 'email-verification' | 'invite-assistance' | 'password-reset' | 'wallet-select';
type AccountRouteAuthPanel = ProfileAuthPanel | 'email-verification' | 'wallet-select';

const LOGIN_AUTH_PANEL_PATHS: Record<LoginRouteAuthPanel, string> = {
  register: '/login/register',
  'email-verification': '/login/verify-email',
  'invite-assistance': '/login/invite-assistance',
  'password-reset': '/login/password-reset',
  'wallet-select': '/login/wallet',
};

const ACCOUNT_AUTH_PANEL_PATHS: Record<AccountRouteAuthPanel, string> = {
  'user-settings': '/account/profile',
  'bot-settings': '/account/bot-settings',
  'blocked-tokens': '/account/blocked-tokens',
  'token-review-alerts': '/account/token-review-alerts',
  'change-password': '/account/change-password',
  'email-verification': '/account/verify-email',
  'wallet-select': '/account/wallet',
};

function getLoginAuthPanelFromPath(pathname: string | null | undefined): LoginRouteAuthPanel | '' {
  const value = normalizeRoutePath(pathname);
  const matched = (Object.entries(LOGIN_AUTH_PANEL_PATHS) as [LoginRouteAuthPanel, string][])
    .find(([, path]) => value === path);
  return matched?.[0] || '';
}

function getAccountAuthPanelFromPath(pathname: string | null | undefined): AccountRouteAuthPanel | '' {
  const value = normalizeRoutePath(pathname);
  const matched = (Object.entries(ACCOUNT_AUTH_PANEL_PATHS) as [AccountRouteAuthPanel, string][])
    .find(([, path]) => value === path);
  return matched?.[0] || '';
}

function isAccountAuthPanelRoutePath(pathname: string | null | undefined) {
  return Boolean(getAccountAuthPanelFromPath(pathname));
}

function hasAuthRouteIntent(locationLike: Location | null | undefined) {
  if (!locationLike) {
    return false;
  }

  const pathname = normalizeRoutePath(locationLike.pathname);
  if (isAuthRoutePath(pathname)) {
    return true;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const rawMode = String(search.get('mode') || '').trim().toLowerCase();
  return rawMode === 'verify-email' || rawMode === 'reset-password';
}

function isPreAccessRoutePath(pathname: string | null | undefined) {
  const value = normalizeRoutePath(pathname);
  return value === '/access' || value.startsWith('/access/');
}

function normalizeBlockWarningState(
  address: string,
  label?: string | null,
  chain: TokenChain = 'solana',
): BlockTokenWarningState | null {
  const normalizedAddress = String(address || '').trim();
  if (!normalizedAddress) {
    return null;
  }

  return {
    chain,
    address: normalizedAddress,
    label: String(label || '').trim() || null,
    dontShowAgain: false,
  };
}

function getLoginPanelIntent(locationLike: Location | null | undefined) {
  if (!locationLike || !isLoginRoutePath(locationLike.pathname)) {
    return '';
  }

  const pathPanel = getLoginAuthPanelFromPath(locationLike.pathname);
  if (pathPanel) {
    return pathPanel;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const panel = String(search.get('panel') || '').trim().toLowerCase();
  return panel === 'register' ? panel : '';
}

function getBillingCheckoutIntent(locationLike: Location | null | undefined) {
  if (!locationLike) {
    return null;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const status = String(search.get('billing') || '').trim().toLowerCase();
  return status === 'success' ? 'success' : null;
}

function getBillingCheckoutOrderId(locationLike: Location | null | undefined) {
  if (!locationLike) {
    return null;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const orderId = Number(search.get('billingOrderId'));
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

function normalizeSocialProvider(value: string | null | undefined): SocialProvider | null {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'google' || provider === 'discord') {
    return provider;
  }
  return null;
}

function getSocialProviderLabel(provider: SocialProvider) {
  return provider === 'google' ? 'Google' : 'Discord';
}

function getSocialIntent(
  locationLike: Location | null | undefined,
  queryKey: 'socialLink' | 'socialLogin',
): SocialIntent | null {
  if (!locationLike) {
    return null;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const status = String(search.get(queryKey) || '').trim().toLowerCase();
  const provider = normalizeSocialProvider(search.get('socialProvider'));
  if (!status || !provider) {
    return null;
  }

  return {
    status,
    provider,
  };
}

function getSocialLinkIntent(locationLike: Location | null | undefined) {
  return getSocialIntent(locationLike, 'socialLink');
}

function getSocialLoginIntent(locationLike: Location | null | undefined) {
  return getSocialIntent(locationLike, 'socialLogin');
}

function getAuthRouteIntent(locationLike: Location | null | undefined): AuthRouteIntent | null {
  if (!locationLike) {
    return null;
  }

  const pathname = normalizeRoutePath(locationLike.pathname);
  const search = new URLSearchParams(locationLike.search || '');
  const token = normalizeAuthRouteToken(String(search.get('token') || ''));
  const rawMode = String(search.get('mode') || '').trim().toLowerCase();
  const mode = rawMode === 'verify-email' || rawMode === 'reset-password'
    ? rawMode
    : null;

  if (pathname === '/auth/verify-email' || mode === 'verify-email') {
    return { mode: 'verify-email', token };
  }

  if (pathname === '/auth/reset-password' || mode === 'reset-password') {
    return { mode: 'reset-password', token };
  }

  return null;
}

function getAuthDefaultErrorMessage(mode: 'login' | 'restore') {
  return mode === 'login'
    ? 'Unable to sign in right now. Please try again.'
    : 'Unable to restore your session. Please login again.';
}

function getAuthLockoutErrorMessage(raw: string) {
  if (!(raw.includes('Too many failed attempts') || raw.includes('Too many authentication attempts'))) {
    return null;
  }

  const retryMatch = raw.match(/Try again in\s+(\d+)s\.?/i);
  if (!retryMatch) {
    return 'Login temporarily locked. Try again in a few minutes.';
  }

  const seconds = Number(retryMatch[1]);
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Login temporarily locked. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

function getMappedAuthErrorMessage(raw: string) {
  const matchedRule = [
    {
      matches: ['Invalid email or password'],
      message: 'Incorrect email or password. Check your credentials and try again.',
    },
    {
      matches: ['Account is deactivated'],
      message: 'This account is deactivated. Contact an administrator if you need access restored.',
    },
    {
      matches: ['Access expired'],
      message: 'Your access has expired. Contact an administrator or renew your access to continue.',
    },
    {
      matches: ['Access revoked'],
      message: 'This account was blocked from product access by an administrator or internal access policy. Contact an administrator if you believe this is a mistake.',
    },
    {
      matches: ['Access inactive'],
      message: 'Your account does not currently have product access. Contact an administrator.',
    },
    {
      matches: ['Email not verified'],
      message: 'Your email is not verified yet. Check your inbox or request a new verification email.',
    },
    {
      matches: ['Token expired', 'Invalid token', 'Session revoked', 'Authentication required', 'User not found'],
      message: 'Your saved session is no longer valid. Please login again.',
    },
    {
      matches: ['Network error:'],
      message: 'Unable to reach the server. Check your connection or API availability and try again.',
    },
    {
      matches: ['Internal server error'],
      message: 'The server could not complete authentication right now. Please try again shortly.',
    },
  ].find((rule) => rule.matches.some((fragment) => raw.includes(fragment)));

  return matchedRule?.message || null;
}

function getInitSocialLinkErrorMessage(intent: SocialIntent) {
  if (intent.status === 'identity_conflict') {
    return 'That social identity is already linked to another TrendScope account.';
  }
  if (intent.status === 'email_conflict') {
    return 'The provider email matches a different existing account. Sign in to the original account instead. Automatic merge is blocked.';
  }
  if (intent.status === 'provider_denied') {
    return 'The social provider did not approve the linking request.';
  }
  return 'Unable to complete social linking. Please try again.';
}

function getSocialLoginFailureMessage(intent: SocialIntent) {
  const providerLabel = getSocialProviderLabel(intent.provider);

  if (intent.status === 'not_linked') {
    return `This ${providerLabel} account is not linked to a TrendScope login yet. Sign in with email and password first, then link it from User Settings.`;
  }
  if (intent.status === 'email_conflict') {
    return 'A TrendScope account already exists with this Google email, but Google sign-in is not linked to it yet. Sign in with email and password first, then link Google from User Settings.';
  }
  if (intent.status === 'provider_denied') {
    return `The ${providerLabel} sign-in request was not approved.`;
  }
  if (intent.status === 'revoked') {
    return 'This account was blocked from product access by an administrator or internal access policy.';
  }
  if (intent.status === 'deactivated') {
    return 'Account is deactivated';
  }
  if (intent.status === 'email_unverified') {
    return 'Email not verified. Check your inbox or resend verification before signing in.';
  }
  if (intent.status === 'provider_unavailable') {
    return `The ${providerLabel} sign-in provider is not configured in this environment yet.`;
  }
  return 'Unable to complete social sign-in. Please try again or use email and password.';
}

function normalizeWorkspace(value: string | null | undefined): WorkspaceView {
  return value === 'history' ? 'history' : 'live';
}

function getWorkspacePath(workspace: WorkspaceView) {
  return workspace === 'history' ? '/monitor' : '/alerts';
}

function getWorkspaceSparklinePath(
  workspace: WorkspaceView,
  address: string,
  chain: TokenChain = 'solana',
) {
  const prefix = workspace === 'history' ? '/radar' : '/alerts';
  const identity = createLegacyCompatibleTokenIdentity(chain, address);
  return identity.chain === 'solana'
    ? `${prefix}/${encodeURIComponent(identity.address)}`
    : `${prefix}/${identity.chain}/${encodeURIComponent(identity.address)}`;
}

function getWorkspaceSparklineBasePath(pathname: string | null | undefined, workspace: WorkspaceView) {
  const value = String(pathname || '').trim().toLowerCase();
  if (workspace === 'history' && value.startsWith('/radar/')) {
    return '/radar';
  }
  return getWorkspacePath(workspace);
}

function parseWorkspaceSparklineRoute(pathname: string | null | undefined): {
  workspace: WorkspaceView;
  chain: TokenChain;
  address: string;
} | null {
  const rawPath = String(pathname || '').trim().replace(/\/+$/, '');
  const segments = rawPath.split('/').filter(Boolean);
  const isCurrentRoute = segments.length === 2;
  const isLegacyRoute = segments.length === 3 && segments[2].toLowerCase() === 'sparkline';
  const isChainRoute = segments.length === 3 && !isLegacyRoute;
  if (!isCurrentRoute && !isLegacyRoute && !isChainRoute) {
    return null;
  }

  const root = segments[0].toLowerCase();
  if (root !== 'alerts' && root !== 'radar' && root !== 'monitor') {
    return null;
  }

  const rawAddress = isChainRoute ? segments[2] : segments[1];
  let address = rawAddress;
  try {
    address = decodeURIComponent(rawAddress);
  } catch (_) {
    address = rawAddress;
  }

  let identity;
  try {
    identity = createLegacyCompatibleTokenIdentity(isChainRoute ? segments[1] : 'solana', address);
  } catch (_) {
    return null;
  }

  return {
    workspace: root === 'alerts' ? 'live' : 'history',
    chain: identity.chain,
    address: identity.address,
  };
}

function resolveWorkspaceFromPath(pathname: string | null | undefined): WorkspaceView {
  const value = String(pathname || '').trim().toLowerCase();
  if (
    value === '/monitor'
    || value.startsWith('/monitor/')
    || value === '/radar'
    || value.startsWith('/radar/')
    || value === '/workspace/history'
    || value.startsWith('/workspace/history/')
  ) {
    return 'history';
  }
  return 'live';
}

interface AccountProfileValidationOk {
  ok: true;
  input: {
    username: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
  };
}

type AccountProfileValidationResult = AccountProfileValidationOk | { ok: false; message: string };

function isWalletOnlySessionEmail(email: string | null | undefined) {
  return /^wallet_[^@]+@wallet\.local$/i.test(String(email || '').trim());
}

function validateAccountUsername(username: string): AccountProfileValidationResult {
  if (username.length < 3 || username.length > 32) {
    return { ok: false, message: 'Username must be 3-32 characters' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { ok: false, message: 'Username can only contain letters, numbers, and underscores' };
  }
  return { ok: true, input: { username } };
}

function validateWalletCompletionInput(input: {
  email: string;
  password: string;
  confirmPassword: string;
  isWalletOnlyAccount: boolean;
}): AccountProfileValidationResult {
  if (!input.isWalletOnlyAccount) {
    return { ok: false, message: 'Email and password can only be added to wallet-only accounts.' };
  }
  if (!input.email || !input.password || !input.confirmPassword) {
    return { ok: false, message: 'Email, password, and confirmation are required.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  if (input.password.length < 8 || input.password.length > 128) {
    return { ok: false, message: 'Password must be 8-128 characters.' };
  }
  if (input.password !== input.confirmPassword) {
    return { ok: false, message: 'Password confirmation does not match.' };
  }
  return {
    ok: true,
    input: {
      username: '',
      email: input.email,
      password: input.password,
      confirmPassword: input.confirmPassword,
    },
  };
}

function validateAccountProfileInput(args: {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  isWalletOnlyAccount: boolean;
}): AccountProfileValidationResult {
  const username = String(args.username || '').trim();
  const usernameValidation = validateAccountUsername(username);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }

  const email = trimLoginEmailValue(args.email);
  const wantsWalletCompletion = Boolean(email || args.password || args.confirmPassword);
  if (!wantsWalletCompletion) {
    return { ok: true, input: { username } };
  }

  const walletValidation = validateWalletCompletionInput({
    email,
    password: args.password,
    confirmPassword: args.confirmPassword,
    isWalletOnlyAccount: args.isWalletOnlyAccount,
  });
  if (!walletValidation.ok) {
    return walletValidation;
  }

  return {
    ok: true,
    input: {
      username,
      email: walletValidation.input.email,
      password: walletValidation.input.password,
      confirmPassword: walletValidation.input.confirmPassword,
    },
  };
}

export function createAppController(): AppController {
  const state = createAppState();
  if (typeof window !== 'undefined' && !isAuthRoutePath(window.location.pathname || '/') && !isPreAccessRoutePath(window.location.pathname || '/')) {
    state.ui.workspace = resolveWorkspaceFromPath(window.location.pathname);
  }
  clearLegacyAuthToken();
  clearLegacyNetworkDebugStorage();
  const listeners = new Set<(state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) => void>();
  hydrateSoundSettings();
  hydrateBrowserNotificationSettings();
  let authSubmitInFlight = false;
  let monitoringInterval: ReturnType<typeof setInterval> | null = null;
  let uptimeInterval: ReturnType<typeof setInterval> | null = null;
  let pumpGcInterval: ReturnType<typeof setInterval> | null = null;
  let adminTokenReviewAlertRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let pumpfunEmitTimer: ReturnType<typeof setTimeout> | null = null;
  let monitoringPausedForAuthPanel = false;
  const monitoredRefreshKeysInFlight = new Set<string>();
  let monitoredPinMutationInFlight = false;
  let queuedMonitoredPinMutation: {
    pins: DashboardMonitoredPin[];
    chains: TokenChain[];
  } | null = null;
  const topPerformersRefreshKeysInFlight = new Set<string>();
  let topPerformersRefreshRevision = 0;
  let chainReadinessRefreshInFlight = false;
  let mockTradingRefreshInFlight = false;
  let adminTokenReviewAlertRefreshInFlight = false;
  let nextMockTradingMarketRefreshAt = 0;
  let floatingQuickBuyExecutionInFlight = false;
  let floatingQuickBuyDashboardRefreshInFlight = false;
  let nextFloatingQuickBuyDashboardRefreshAt = 0;
  let floatingQuickBuyResetTimer: ReturnType<typeof setTimeout> | null = null;
  let supplementalMeteoraRefreshInFlight = false;
  let nextMonitoredDashboardPollAt = 0;
  let nextMonitoredFullHydrationAt = 0;
  let bidZoneRefreshInFlight = false;
  let sparklineRefreshInFlight = false;
  let sparklineRefreshQueued = false;
  let sparklineRefreshQueuedForce = false;
  let sparklineRefreshQueuedCaller = '';
  const expandedSparklineRequests = new Set<string>();
  const deferredExpandedSparklineRenderRegions = new Set<AppRenderRegion>();
  let preferredExpandedSparklineGranularityMinutes = EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
  let historyBootstrapRefreshInFlight = false;
  let historyBootstrapInFlightRequestKey = '';
  let queuedHistoryBootstrapRefresh: HistoryBootstrapRefreshOptions | null = null;
  let historyBootstrapRequestRevision = 0;
  let lastAppliedHistoryBootstrapOrderLockKey = '';
  let nonSolanaHistoryTrackedIdentities = new Set<string>();
  const historyBucketOrderLocks = {
    recent: false,
    oldWeek: false,
  };
  let pendingRecentHistoryOrder: string[] | null = null;
  let pendingOldWeekHistoryOrder: string[] | null = null;
  let monitoredBootstrapHydrationRevision = 0;
  let configReloadRevision = 0;
  let documentHiddenForUi = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let restoredSessionRefreshInFlight = false;
  let nextRestoredSessionRefreshAt = 0;
  let startedAt: number | null = null;
  let uiPrefsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let uiPrefsPersistRevision = 0;
  let alertsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let alertSparklineRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let alertSparklineRefreshInFlight = false;
  let alertsPersistScope: string | null = null;
  let alertsPersistLifecycleBound = false;
  let emitScheduled = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let preAccessPollingTimer: ReturnType<typeof setTimeout> | null = null;
  let socialLinkPopupWindow: Window | null = null;
  let socialLinkSyncTimer: ReturnType<typeof setInterval> | null = null;
  let socialLinkSyncStartedAt = 0;
  let socialLinkPendingProvider: 'google' | 'discord' | null = null;
  let lastMonitoredDashboardError: string | null = null;
  let nextColdFieldRefreshAt = 0;
  let nextBidZoneRefreshAt = 0;
  let nextSparklineRefreshAt = 0;
  let lastSparklineAddressKey = '';
  let lastSparklineVisibleAddresses: string[] = [];
  let manualMetadataBatchCacheKey = '';
  let manualMetadataBatchCacheExpiresAt = 0;
  let manualMetadataMeteoraCacheKey = '';
  let manualMetadataNextMeteoraRefreshAt = 0;
  let manualMetadataBatchRefreshInFlight: Promise<void> | null = null;
  let manualMetadataBatchRefreshInFlightKey = '';
  const sparklineDebugControllerId = createSparklineDebugId('controller');
  let sparklineDebugCaptureUntil = 0;
  let sparklineDebugRecentEntries: SparklineDebugEntry[] = [];
  let sparklineDebugApiResponseListenerBound = false;
  const pendingManualFolderDeleteIds = new Set<number>();
  const pendingManualFolderDeleteAddresses = new Set<string>();
  let suppressSocketStatusNoticeUntil = 0;
  const historySyncTabId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `history-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let historySyncChannel: BroadcastChannel | null = null;
  let historySyncHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let historySyncLifecycleBound = false;
  let historySyncLeaderTabId: string | null = null;
  const historySyncPeers = new Map<string, HistoryPeerState>();
  const recentAlertFingerprints = new Map<string, { ts: number; fingerprint: string }>();
  const pendingAlertSparklineRequests = new Map<string, string>();
  const pendingDirtyRegions = new Set<AppRenderRegion>(['all']);
  const pendingPumpfunEmitRegions = new Set<AppRenderRegion>();
  const COLLAPSIBLE_SECTION_TO_RENDER_REGION: Record<CollapsibleSectionKey, AppRenderRegion> = {
    manual: 'manual',
    recent: 'recent',
    oldWeek: 'old-week',
    monitored: 'monitored',
    bidZone: 'bid-zone',
    pumpfun: 'pumpfun',
  };

  function clearLegacyNetworkDebugStorage() {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      for (const key of LEGACY_NETWORK_DEBUG_STORAGE_KEYS) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Ignore local persistence failures.
    }
  }

  function stopSocialLinkSync() {
    if (socialLinkSyncTimer) {
      clearInterval(socialLinkSyncTimer);
      socialLinkSyncTimer = null;
    }
    socialLinkSyncStartedAt = 0;
    socialLinkPendingProvider = null;
  }

  function clearHistorySearchPending(options: { emitRegions?: boolean } = {}) {
    let changed = false;
    if (state.ui.recentSearchPending) {
      state.ui.recentSearchPending = false;
      changed = true;
    }
    if (state.ui.oldWeekSearchPending) {
      state.ui.oldWeekSearchPending = false;
      changed = true;
    }
    if (changed && options.emitRegions !== false) {
      emit('recent', 'old-week');
    }
  }

  async function pollSocialLinkSync() {
    const pendingProvider = socialLinkPendingProvider;
    if (!pendingProvider || state.session.status !== 'authenticated') {
      stopSocialLinkSync();
      return;
    }

    try {
      await refreshUserSettingsState(COOKIE_SESSION_MARKER);
    } catch {
      emit('overlay', 'header');
    }

    const linked = state.identities.providers.find((entry) => entry.provider === pendingProvider)?.linked;
    if (linked) {
      handleSocialLinkResult({
        provider: pendingProvider,
        status: 'success',
      });
      return;
    }

    const popupClosed = !socialLinkPopupWindow || socialLinkPopupWindow.closed;
    const timedOut = socialLinkSyncStartedAt > 0 && (Date.now() - socialLinkSyncStartedAt) >= SOCIAL_LINK_SYNC_TIMEOUT_MS;
    emit('overlay', 'header');

    if (popupClosed || timedOut) {
      stopSocialLinkSync();
    }
  }

  function startSocialLinkSync(provider: 'google' | 'discord') {
    if (typeof window === 'undefined') {
      return;
    }

    stopSocialLinkSync();
    socialLinkPendingProvider = provider;
    socialLinkSyncStartedAt = Date.now();
    socialLinkSyncTimer = window.setInterval(() => {
      void pollSocialLinkSync();
    }, SOCIAL_LINK_SYNC_POLL_MS);
    void pollSocialLinkSync();
  }

  if (typeof window !== 'undefined') {
    const getAllowedSocialLinkOrigins = () => {
      const origins = new Set<string>();
      origins.add(window.location.origin);
      try {
        origins.add(new URL(resolveApiBase(window.location)).origin);
      } catch {
        // Ignore malformed API base fallback and keep current origin only.
      }
      return origins;
    };

    window.addEventListener('focus', () => {
      if (state.session.status !== 'authenticated' || state.ui.authPanel !== 'user-settings') {
        return;
      }

      void refreshUserSettingsState(COOKIE_SESSION_MARKER)
        .then(() => emit('overlay', 'header'))
        .catch(() => emit('overlay', 'header'));
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== SOCIAL_LINK_RESULT_STORAGE_KEY || !event.newValue) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(event.newValue) as { status?: string; provider?: string };
      } catch {
        return;
      }

      const provider = payload?.provider === 'discord' ? 'discord' : payload?.provider === 'google' ? 'google' : null;
      const status = String(payload?.status || '').trim().toLowerCase();
      if (state.session.status !== 'authenticated' || !provider || !status) {
        return;
      }
      handleSocialLinkResult({
        provider,
        status,
      });
    });

    window.addEventListener('message', (event) => {
      if (!getAllowedSocialLinkOrigins().has(event.origin)) {
        return;
      }

      const payload = event.data && typeof event.data === 'object'
        ? event.data as { type?: string; status?: string; provider?: string }
        : null;
      if (!payload || payload.type !== SOCIAL_LINK_RESULT_MESSAGE_TYPE) {
        return;
      }

      const provider = payload.provider === 'discord' ? 'discord' : payload.provider === 'google' ? 'google' : null;
      const status = String(payload.status || '').trim().toLowerCase();
      if (state.session.status !== 'authenticated' || !provider || !status) {
        return;
      }

      handleSocialLinkResult({
        provider,
        status,
      });
    });

  }

  function handleSocialLinkResult(intent: SocialIntent) {
    stopSocialLinkSync();
    if (socialLinkPopupWindow && !socialLinkPopupWindow.closed) {
      try {
        socialLinkPopupWindow.close();
      } catch {
        // Ignore popup close failures and keep the current tab in sync.
      }
    }
    socialLinkPopupWindow = null;
    state.ui.authPanel = 'user-settings';
    replaceAuthPanelRoute('user-settings');
    state.ui.notice = null;
    state.ui.error = null;

    if (intent.status === 'success') {
      setNotice(`${getSocialProviderLabel(intent.provider)} linked successfully.`);
    } else if (intent.status === 'identity_conflict') {
      setError('That social identity is already linked to another account.');
    } else if (intent.status === 'email_conflict') {
      setError('The provider email matches a different existing account. Automatic merge is blocked.');
    } else if (intent.status === 'provider_denied') {
      setError('The social provider did not approve the linking request.');
    } else if (intent.status === 'session_missing' || intent.status === 'session_mismatch') {
      setError('Social linking must start and finish on the same app session and host. Retry the flow from the same tab.');
    } else {
      setError('Unable to complete social linking. Please try again.');
    }

    void refreshUserSettingsState(COOKIE_SESSION_MARKER)
      .then(() => {
        try {
          window.localStorage.removeItem(SOCIAL_LINK_RESULT_STORAGE_KEY);
        } catch {
          // Ignore storage cleanup failures.
        }
        emit('overlay', 'header');
      })
      .catch(() => emit('overlay', 'header'));
  }

  function publishSocialLinkResult(intent: SocialIntent) {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(
        SOCIAL_LINK_RESULT_STORAGE_KEY,
        JSON.stringify({
          status: intent.status,
          provider: intent.provider,
          ts: Date.now(),
        })
      );
    } catch {
      // Ignore storage sync failures.
    }
  }

  function queueDirtyRegions(regions: AppRenderRegion[]) {
    if (regions.length === 0 || regions.includes('all')) {
      pendingDirtyRegions.clear();
      pendingDirtyRegions.add('all');
      return;
    }

    if (pendingDirtyRegions.has('all')) {
      return;
    }

    for (const region of regions) {
      pendingDirtyRegions.add(region);
    }
  }

  function stopPreAccessPolling() {
    if (preAccessPollingTimer) {
      clearTimeout(preAccessPollingTimer);
      preAccessPollingTimer = null;
    }
  }

  function normalizeDiffValue(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    return value;
  }

  function isLiveWorkspace() {
    return state.ui.workspace === 'live';
  }

  function isHistoryWorkspace() {
    return state.ui.workspace === 'history';
  }

  function usesHistoryBucketBootstrap() {
    return isHistoryWorkspace();
  }

  function selectedChainsSupport(capability: WorkspaceChainCapability) {
    return hasEnabledChainCapability(
      state.ui.chainFilters,
      state.data.chainReadiness,
      capability,
    );
  }

  function getReadySelectedChains(capability: WorkspaceChainCapability) {
    return state.ui.chainFilters.enabledChains.filter((chain) => (
      state.data.chainReadiness[chain]?.capabilities[capability] === true
    ));
  }

  function buildChainRequestKey(chains: TokenChain[]) {
    return [...chains].sort().join(',');
  }

  function getRequestedPaginationFloor(page: number, perPage: number) {
    const safePage = Math.max(0, Math.floor(page) || 0);
    const safePerPage = Math.max(10, Math.floor(perPage) || ROUTED_BUCKET_DEFAULT_PER_PAGE);
    return (safePage + 1) * safePerPage;
  }

  function getRecentTokenTotalForPagination() {
    if (!usesHistoryBucketBootstrap()) {
      return getRecentTokens(state).length;
    }
    return Math.max(
      getRecentTokens(state).length,
      state.bars.recent,
      getRequestedPaginationFloor(state.ui.recentPage, state.ui.recentPerPage),
    );
  }

  function getOldWeekTokenTotalForPagination() {
    if (!usesHistoryBucketBootstrap()) {
      return getOldWeekTokens(state).length;
    }
    return Math.max(
      getOldWeekTokens(state).length,
      state.bars.oldWeek,
      getRequestedPaginationFloor(state.ui.oldWeekPage, state.ui.oldWeekPerPage),
    );
  }

  function shouldRunFrontendAlerts() {
    return isLiveWorkspace();
  }

  function shouldUseBackendOwnedMonitoredAlerts() {
    return isLiveWorkspace() && isAuthenticatedSession();
  }

  function isLiveWorkspaceHiddenForUiWork() {
    return documentHiddenForUi && isLiveWorkspace() && state.runtime.mode === 'active';
  }

  function shouldRunPumpfunRuntime() {
    return false;
  }

  function shouldRunHistoryAnalyticsRuntime() {
    return isHistoryWorkspace();
  }

  function isAuthenticatedSession() {
    return state.session.status === 'authenticated';
  }

  function isWorkspacePollingSyncWorkspace(workspace = state.ui.workspace) {
    return workspace === 'history' || workspace === 'live';
  }

  function isActiveWorkspacePollingSyncCandidate() {
    return isAuthenticatedSession()
      && isWorkspacePollingSyncWorkspace()
      && !isLiveWorkspaceHiddenForUiWork()
      && state.runtime.mode === 'active';
  }

  function shouldUseHistorySyncChannel() {
    return typeof BroadcastChannel !== 'undefined';
  }

  function isWorkspacePollingLeader() {
    if (!isWorkspacePollingSyncWorkspace()) {
      return true;
    }
    if (!shouldUseHistorySyncChannel()) {
      return true;
    }
    return historySyncLeaderTabId === null || historySyncLeaderTabId === historySyncTabId;
  }

  function isHistorySyncLeader() {
    if (!isHistoryWorkspace()) {
      return true;
    }
    return isWorkspacePollingLeader();
  }

  function shouldRunLocalMonitoringPolling() {
    if (state.runtime.mode !== 'active') {
      return false;
    }
    if (isLiveWorkspaceHiddenForUiWork()) {
      return false;
    }
    if (isLiveWorkspace()) {
      return isWorkspacePollingLeader();
    }
    if (isHistoryWorkspace()) {
      return isWorkspacePollingLeader();
    }
    return true;
  }

  function hasCriticalColdFieldGap(token: ManualTokenEntry | null | undefined) {
    if (!token) {
      return true;
    }

    const hasCreatedAt = typeof token.createdAt === 'number' && token.createdAt > 0;
    const hasCatalogFirstSeenAt = typeof token.catalogFirstSeenAt === 'number' && token.catalogFirstSeenAt > 0;
    return !token.symbol || !token.pairUrl || !hasCreatedAt || !hasCatalogFirstSeenAt;
  }

  function getTrackedTokenKey(address: string, chain: TokenChain | null = 'solana') {
    return createLegacyCompatibleTokenIdentity(chain, address).key;
  }

  function getTrackedTokenByIdentity(identityKey: string) {
    try {
      const identity = parseTokenIdentityKey(identityKey);
      return getTrackedToken(state, identity.address, identity.chain);
    } catch {
      return null;
    }
  }

  function getTokenIdentityKey(token: Pick<ManualTokenEntry, 'address' | 'chain'>) {
    return getTrackedTokenKey(token.address, token.chain || 'solana');
  }

  function normalizeStoredHistoryIdentities(values: string[]) {
    return Array.from(new Set((Array.isArray(values) ? values : []).flatMap((value) => {
      try {
        return [parseTokenIdentityKey(value).key];
      } catch {
        try {
          return [getTrackedTokenKey(value, 'solana')];
        } catch {
          return [];
        }
      }
    })));
  }

  function getOptionalTrackedToken(address: string, chain: TokenChain | null = 'solana') {
    return getTrackedToken(state, address, chain) ?? undefined;
  }

  function setTrackedToken(nextToken: ManualTokenEntry) {
    const identity = createLegacyCompatibleTokenIdentity(nextToken.chain, nextToken.address);
    state.data.trackedTokensByIdentity[identity.key] = {
      ...nextToken,
      chain: identity.chain,
      address: identity.address,
    };
  }

  function syncWorkspaceMarketSubscriptions() {
    const identities = new Map<string, { chain: TokenChain; address: string }>();
    const tokens = [
      ...getMonitoredTokens(state),
      ...getManualTokens(state),
      ...getRecentTokens(state),
      ...getOldWeekTokens(state),
    ];
    for (const token of tokens) {
      const chain = token.chain || 'solana';
      if (chain === 'solana') continue;
      const identity = createLegacyCompatibleTokenIdentity(chain, token.address);
      identities.set(identity.key, { chain: identity.chain, address: identity.address });
      if (identities.size >= WORKSPACE_REALTIME_SUBSCRIPTION_LIMIT) break;
    }
    replaceWorkspaceMarketSubscriptions([...identities.values()]);
  }

  function deleteTrackedToken(address: string, chain: TokenChain | null = 'solana') {
    delete state.data.trackedTokensByIdentity[getTrackedTokenKey(address, chain)];
  }

  function replaceTrackedTokenReferences(_address: string, nextToken: ManualTokenEntry) {
    setTrackedToken(nextToken);
  }

  function refreshTrackedTokenStore() {
    const activeIdentities = new Set([
      ...state.data.monitoredTokenIdentities,
      ...state.data.pinnedMonitoredTokenIdentities,
      ...state.data.manualTokenIdentities,
      ...state.data.topPerformerIdentities,
      ...state.data.recentTokenIdentities,
      ...state.data.oldWeekTokenIdentities,
    ]);
    for (const identityKey of Object.keys(state.data.trackedTokensByIdentity)) {
      if (!activeIdentities.has(identityKey)) {
        delete state.data.trackedTokensByIdentity[identityKey];
      }
    }
  }

  function areTrackedTokensEquivalent(existingItem: ManualTokenEntry | undefined, nextItem: ManualTokenEntry | undefined) {
    if (!existingItem || !nextItem) {
      return false;
    }

    const keys = new Set([
      ...Object.keys(existingItem),
      ...Object.keys(nextItem),
    ]);

    for (const key of keys) {
      const existingValue = normalizeDiffValue((existingItem as unknown as Record<string, unknown>)[key]);
      const nextValue = normalizeDiffValue((nextItem as unknown as Record<string, unknown>)[key]);
      if (existingValue !== nextValue) {
        return false;
      }
    }

    return true;
  }

  function firstDefinedTrackedValue<T>(...values: Array<T | null | undefined>): T | null {
    for (const value of values) {
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return null;
  }

  function toNullableTrackedValue<T>(value: T | null | undefined): T | null {
    return value ?? null;
  }

  function toTrackedFreshnessMs(value: string | null | undefined) {
    if (!value) {
      return null;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getTrackedFreshnessMs(item: ManualTokenEntry | DashboardMonitoredToken | undefined) {
    return item ? resolveWorkspaceMarketSnapshotMs(item) : null;
  }

  function shouldApplyTrackedMarketFields(
    existingItem: ManualTokenEntry | undefined,
    dashboardItem: DashboardMonitoredToken | undefined,
  ) {
    if (!dashboardItem) {
      return false;
    }

    const incomingWindowEnd = toTrackedFreshnessMs(dashboardItem.windowEnd);
    const existingWindowEnd = toTrackedFreshnessMs(existingItem?.windowEnd);
    if (incomingWindowEnd != null || existingWindowEnd != null) {
      if (incomingWindowEnd == null) return false;
      if (existingWindowEnd == null) return true;
      return incomingWindowEnd >= existingWindowEnd;
    }

    const incomingFreshness = getTrackedFreshnessMs(dashboardItem);
    const existingFreshness = getTrackedFreshnessMs(existingItem);
    return incomingFreshness == null || existingFreshness == null || incomingFreshness >= existingFreshness;
  }

  function selectFreshestTrackedTimestamp(
    dashboardValue: string | null | undefined,
    existingValue: string | null | undefined,
    baseValue: string | null | undefined,
  ) {
    const candidates = [dashboardValue, existingValue, baseValue];
    let selected: string | null = null;
    let selectedMs: number | null = null;

    for (const value of candidates) {
      const valueMs = toTrackedFreshnessMs(value);
      if (valueMs == null) {
        continue;
      }
      if (selectedMs == null || valueMs > selectedMs) {
        selected = value ?? null;
        selectedMs = valueMs;
      }
    }

    return selected ?? firstDefinedTrackedValue(existingValue, dashboardValue, baseValue);
  }

  function shouldApplyTrackedColdFields(
    existingItem: ManualTokenEntry | undefined,
    dashboardItem: DashboardMonitoredToken | undefined,
    coldRefreshDue: boolean,
  ) {
    return Boolean(dashboardItem) && (!existingItem || hasCriticalColdFieldGap(existingItem) || coldRefreshDue);
  }

  function selectTrackedColdField<T>(
    shouldApplyColdFields: boolean,
    dashboardValue: T | null | undefined,
    existingValue: T | null | undefined,
    baseValue: T | null | undefined,
  ): T | null {
    return shouldApplyColdFields
      ? firstDefinedTrackedValue(dashboardValue, existingValue, baseValue)
      : firstDefinedTrackedValue(existingValue, baseValue);
  }

  function buildMergedTrackedColdFields(
    existingItem: ManualTokenEntry | undefined,
    dashboardItem: DashboardMonitoredToken | undefined,
    base: ManualTokenEntry,
    coldRefreshDue: boolean,
  ) {
    const shouldApplyColdFields = shouldApplyTrackedColdFields(existingItem, dashboardItem, coldRefreshDue);
    const existing: Partial<ManualTokenEntry> = existingItem || {};
    const dashboard: Partial<DashboardMonitoredToken> = dashboardItem || {};

    return {
      chain: dashboardItem?.chain || existingItem?.chain || base.chain || 'solana',
      mintAddress: firstDefinedTrackedValue(existing.mintAddress, dashboard.address, base.address),
      pairAddress: selectTrackedColdField(shouldApplyColdFields, dashboard.pairAddress, existing.pairAddress, base.pairAddress),
      pairUrl: selectTrackedColdField(shouldApplyColdFields, dashboard.pairUrl, existing.pairUrl, base.pairUrl),
      pairDexId: selectTrackedColdField(shouldApplyColdFields, dashboard.pairDexId, existing.pairDexId, base.pairDexId),
      imageUrl: selectTrackedColdField(shouldApplyColdFields, dashboard.imageUrl, existing.imageUrl, base.imageUrl),
      twitterUrl: selectTrackedColdField(shouldApplyColdFields, dashboard.twitterUrl, existing.twitterUrl, base.twitterUrl),
      communityUrl: selectTrackedColdField(shouldApplyColdFields, dashboard.communityUrl, existing.communityUrl, base.communityUrl),
      symbol: selectTrackedColdField(shouldApplyColdFields, dashboard.symbol, existing.symbol, base.symbol),
      name: selectTrackedColdField(shouldApplyColdFields, dashboard.name, existing.name, base.name),
      createdAt: selectTrackedColdField(shouldApplyColdFields, dashboard.tokenCreatedAt, existing.createdAt, base.createdAt),
      catalogFirstSeenAt: selectTrackedColdField(shouldApplyColdFields, dashboard.catalogFirstSeenAt, existing.catalogFirstSeenAt, base.catalogFirstSeenAt),
      tokenAgeProvenance: selectTrackedColdField(
        shouldApplyColdFields,
        dashboard.tokenAgeProvenance,
        existing.tokenAgeProvenance,
        base.tokenAgeProvenance,
      ),
      tickerPeers: firstDefinedTrackedValue(dashboardItem?.tickerPeers, existing.tickerPeers, base.tickerPeers),
    };
  }

  function canonicalSnapshotValue<T>(
    existing: T | null | undefined,
    dashboard: T | null | undefined,
    base: T | null | undefined,
    applyDashboard: boolean,
  ) {
    return applyDashboard
      ? firstDefinedTrackedValue(dashboard, existing, base)
      : firstDefinedTrackedValue(existing, base, dashboard);
  }

  function buildMergedCanonicalVolume5mFields(
    existing: ManualTokenEntry | undefined,
    dashboard: DashboardMonitoredToken | undefined,
    base: ManualTokenEntry,
    applyDashboard: boolean,
  ): Partial<ManualTokenEntry> {
    return {
      prevVolume5mCanonical: canonicalSnapshotValue(
        existing?.prevVolume5mCanonical, dashboard?.prevVolume5mCanonical,
        base.prevVolume5mCanonical, applyDashboard,
      ),
      volume5mBaselineAt: canonicalSnapshotValue(
        existing?.volume5mBaselineAt, dashboard?.volume5mBaselineAt,
        base.volume5mBaselineAt, applyDashboard,
      ),
      volume5mWindowEnd: canonicalSnapshotValue(
        existing?.volume5mWindowEnd, dashboard?.volume5mWindowEnd,
        base.volume5mWindowEnd, applyDashboard,
      ),
      volume5mDeltaCoverage: canonicalSnapshotValue(
        existing?.volume5mDeltaCoverage, dashboard?.volume5mDeltaCoverage,
        base.volume5mDeltaCoverage, applyDashboard,
      ),
    };
  }

  function buildMergedTrackedMarketFields(
    existingItem: ManualTokenEntry | undefined,
    dashboardItem: DashboardMonitoredToken | undefined,
    base: ManualTokenEntry,
  ) {
    const nextFields: Partial<ManualTokenEntry> = {};
    const shouldApplyMarketFields = shouldApplyTrackedMarketFields(existingItem, dashboardItem);
    const shouldApplyValuationFields = shouldApplyDashboardValuation(
      existingItem?._liveMarketObservedAt,
      dashboardItem,
    );

    for (const key of TRACKED_MARKET_FIELD_KEYS) {
      nextFields[key] = selectWorkspaceSnapshotValue(
        shouldApplyTrackedMarketField(
          key,
          shouldApplyMarketFields,
          shouldApplyValuationFields,
        ),
        dashboardItem?.[key],
        existingItem?.[key],
        base[key],
      );
    }

    Object.assign(nextFields, Object.fromEntries(TRACKED_MARKET_CONTEXT_FIELD_KEYS.map((key) => [
      key,
      shouldApplyTrackedMarketContext(
        key,
        shouldApplyMarketFields,
        shouldApplyValuationFields,
      )
        ? dashboardItem?.[key]
        : existingItem?.[key] ?? base[key],
    ])));

    Object.assign(nextFields, buildMergedCanonicalVolume5mFields(
      existingItem, dashboardItem, base, shouldApplyMarketFields,
    ));

    nextFields.lastActivityAt = selectFreshestTrackedTimestamp(
      dashboardItem?.lastActivityAt,
      existingItem?.lastActivityAt,
      base.lastActivityAt,
    );
    overlayLiveActivityOnDashboardSnapshot(
      nextFields,
      existingItem,
      dashboardItem,
      shouldApplyMarketFields,
    );

    nextFields.valuationType = selectWorkspaceSnapshotValue(
      shouldApplyValuationFields,
      dashboardItem?.valuationType,
      existingItem?.valuationType,
      base.valuationType,
    );

    nextFields.prevVolume5m = existingItem?.volume5m != null
      ? existingItem.volume5m
      : firstDefinedTrackedValue(existingItem?.prevVolume5m, base.prevVolume5m);
    nextFields.lastSeenAt = selectFreshestTrackedTimestamp(dashboardItem?.lastSeenAt, existingItem?.lastSeenAt, base.lastSeenAt);
    nextFields.lastEvaluatedAt = selectFreshestTrackedTimestamp(
      dashboardItem?.lastEvaluatedAt,
      existingItem?.lastEvaluatedAt,
      base.lastEvaluatedAt,
    );
    nextFields.meteora = firstDefinedTrackedValue(dashboardItem?.meteora, existingItem?.meteora, base.meteora);

    return nextFields;
  }

  function buildMergedTrackedAlertFields(
    existingItem: ManualTokenEntry | undefined,
    base: ManualTokenEntry,
  ) {
    const nextFields: Partial<ManualTokenEntry> = {};

    for (const key of TRACKED_ALERT_PRESERVED_KEYS) {
      const value = existingItem?.[key] ?? base[key];
      if (value !== undefined) {
        (nextFields as Record<typeof key, ManualTokenEntry[typeof key]>)[key] = value as ManualTokenEntry[typeof key];
      }
    }

    nextFields.deadCycles = existingItem?.deadCycles ?? base.deadCycles ?? 0;
    nextFields._volAlertAboveThreshold = existingItem?._volAlertAboveThreshold ?? base._volAlertAboveThreshold ?? false;
    nextFields._mcapAlertAboveThreshold = existingItem?._mcapAlertAboveThreshold ?? base._mcapAlertAboveThreshold ?? false;

    return nextFields;
  }

  function applyPersistedFrontendAlertFlags(nextTrackedStore: Record<string, ManualTokenEntry>) {
    for (const alert of state.data.alerts) {
      const token = nextTrackedStore[getTrackedTokenKey(alert.address, alert.chain)];
      if (!token) {
        continue;
      }

      const createdAt = Number(alert.createdAt);
      if (Number.isFinite(createdAt) && (!token.lastAlertAt || createdAt > token.lastAlertAt)) {
        token.lastAlertAt = createdAt;
      }

      switch (alert.kind) {
        case 'hvnc':
          token._hvncFired = true;
          token._lastAlertKind = 'hvnc';
          break;
        case 'old-surge':
          token._lastAlertKind = 'old-surge';
          break;
        case 'meteora-surge':
          token._meteoraSurgeFired = true;
          token._lastAlertKind = 'meteora-surge';
          break;
        default:
          break;
      }
    }
  }

  function mergeTrackedDashboardFields(input: {
    existingItem: ManualTokenEntry | undefined;
    dashboardItem: DashboardMonitoredToken | undefined;
    base: ManualTokenEntry;
    coldRefreshDue: boolean;
  }): ManualTokenEntry {
    const { existingItem, dashboardItem, base, coldRefreshDue } = input;

    return {
      ...base,
      ...buildMergedTrackedColdFields(existingItem, dashboardItem, base, coldRefreshDue),
      ...buildMergedTrackedMarketFields(existingItem, dashboardItem, base),
      ...buildMergedTrackedAlertFields(existingItem, base),
    };
  }

  function selectMergedTrackedToken(
    existingItem: ManualTokenEntry | undefined,
    mergedItem: ManualTokenEntry,
  ) {
    return areTrackedTokensEquivalent(existingItem, mergedItem)
      ? existingItem as ManualTokenEntry
      : mergedItem;
  }

  function commitTrackedStateRebuild(input: {
    nextTrackedStore: Record<string, ManualTokenEntry>;
    manualTokens: ManualTokenEntry[];
    monitoredMap: Map<string, ManualTokenEntry>;
    pinnedIdentities: string[];
    alertCandidates: Set<string>;
    coldRefreshDue: boolean;
    now: number;
  }) {
    if (input.coldRefreshDue) {
      nextColdFieldRefreshAt = input.now + COLD_FIELD_RECHECK_MS;
    }

    state.data.trackedTokensByIdentity = input.nextTrackedStore;
    applyPersistedFrontendAlertFlags(state.data.trackedTokensByIdentity);
    state.data.manualTokenIdentities = input.manualTokens.map(getTokenIdentityKey);
    state.data.monitoredTokenIdentities = [...input.monitoredMap.keys()];
    state.data.pinnedMonitoredTokenIdentities = input.pinnedIdentities;
    state.bars.manual = state.data.manualTokenIdentities.length;
    if (!usesHistoryBucketBootstrap()) {
      state.data.recentTokenIdentities = [];
      state.data.oldWeekTokenIdentities = [];
      deriveAgeBuckets();
    }

    if (state.runtime.mode === 'active' && shouldRunFrontendAlerts() && input.alertCandidates.size > 0) {
      for (const token of getMonitoredTokens(state)) {
        if (!input.alertCandidates.has(getTokenIdentityKey(token))) continue;
        maybeFireSpecialAlerts(token);
        maybeFireLocalAlert(token);
      }
    }

    state.runtime.monitoredRevision += 1;
    refreshMonitoredPanelCounts();
    syncWorkspaceMarketSubscriptions();
  }

  function ensureHistorySyncChannel() {
    if (historySyncChannel || !shouldUseHistorySyncChannel() || typeof window === 'undefined') {
      return;
    }

    historySyncChannel = new BroadcastChannel(HISTORY_SYNC_CHANNEL_NAME);
    historySyncChannel.addEventListener('message', (event: MessageEvent<HistorySyncMessage>) => {
      handleHistorySyncMessage(event.data);
    });

    if (!historySyncLifecycleBound) {
      historySyncLifecycleBound = true;
      window.addEventListener('pagehide', () => {
        postHistorySyncMessage({
          type: 'closing',
          tabId: historySyncTabId,
          ts: Date.now(),
        });
        historySyncChannel?.close();
        historySyncChannel = null;
      });
    }
  }

  function postHistorySyncMessage(message: HistorySyncMessage) {
    ensureHistorySyncChannel();
    historySyncChannel?.postMessage(message);
  }

  function pruneHistorySyncPeers(now = Date.now()) {
    for (const [tabId, peer] of historySyncPeers) {
      if ((now - peer.seenAt) > HISTORY_SYNC_PEER_TTL_MS) {
        historySyncPeers.delete(tabId);
      }
    }
  }

  function recomputeHistorySyncLeader(options?: { runImmediatelyOnGain?: boolean }) {
    const previousLeader = historySyncLeaderTabId;
    pruneHistorySyncPeers();

    if (!isWorkspacePollingSyncWorkspace()) {
      historySyncLeaderTabId = null;
      return;
    }

    const workspace = state.ui.workspace;
    const candidates = [historySyncTabId]
      .filter(() => isActiveWorkspacePollingSyncCandidate());

    for (const [tabId, peer] of historySyncPeers) {
      if (peer.authenticated && peer.monitoringActive && peer.workspace === workspace) {
        candidates.push(tabId);
      }
    }

    historySyncLeaderTabId = candidates.length > 0
      ? candidates.sort((a, b) => a.localeCompare(b))[0] || null
      : null;

    if (state.runtime.mode === 'active' && isWorkspacePollingSyncWorkspace() && previousLeader !== historySyncLeaderTabId) {
      syncMonitoringPolling({ runImmediately: Boolean(options?.runImmediatelyOnGain) && historySyncLeaderTabId === historySyncTabId });
    }
  }

  function broadcastHistoryPresence() {
    if (!shouldUseHistorySyncChannel()) {
      return;
    }

    postHistorySyncMessage({
      type: 'presence',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      authenticated: isAuthenticatedSession(),
      monitoringActive: isActiveWorkspacePollingSyncCandidate(),
      ts: Date.now(),
    });
  }

  function startHistorySyncHeartbeat() {
    if (!shouldUseHistorySyncChannel() || historySyncHeartbeatTimer) {
      return;
    }

    ensureHistorySyncChannel();
    historySyncHeartbeatTimer = setInterval(() => {
      broadcastHistoryPresence();
      recomputeHistorySyncLeader();
    }, HISTORY_SYNC_HEARTBEAT_MS);
  }

  function syncHistorySyncState(options?: { runImmediatelyOnGain?: boolean }) {
    if (!shouldUseHistorySyncChannel()) {
      return;
    }

    ensureHistorySyncChannel();
    startHistorySyncHeartbeat();
    broadcastHistoryPresence();
    recomputeHistorySyncLeader(options);
  }

  function flushEmit() {
    emitScheduled = false;
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    const dirtyRegions = new Set(pendingDirtyRegions);
    pendingDirtyRegions.clear();
    for (const listener of listeners) {
      listener(state, dirtyRegions);
    }
  }

  function isRuntimePerfDebugActive() {
    return state.session.role === 'admin' && isRuntimePerfDebugEnabled();
  }

  function toDebugNullable<T>(value: T | null | undefined) {
    return value ?? null;
  }

  function toDebugSymbol(symbol: string | null | undefined, fallback?: string | null) {
    return symbol ?? fallback ?? '';
  }

  function toDebugNumber(value: number | null | undefined, decimals = 2) {
    if (!Number.isFinite(value)) {
      return null;
    }
    const factor = 10 ** decimals;
    return Math.round(Number(value) * factor) / factor;
  }

  function summarizeDebugTokenMetrics(item: Partial<ManualTokenEntry & DashboardMonitoredToken>) {
    return {
      mcap: toDebugNullable(item.mcap),
      vol1h: toDebugNullable(item.volume1h),
      vol6h: toDebugNullable(item.volume6h),
      vol24h: toDebugNullable(item.volume24h),
      pchange1h: toDebugNullable(item.priceChange1h),
      pchange6h: toDebugNullable(item.priceChange6h),
      pchange24h: toDebugNullable(item.priceChange24h),
      historySortScore: toDebugNullable(item.historySortScore),
    };
  }

  function summarizeHistoryRequestDebug(request: DashboardHistoryBucketRequest) {
    return {
      page: request.page ?? null,
      perPage: request.perPage ?? null,
      sorts: (request.sorts || []).map((item) => `${item.mode}:${item.window}`).join(','),
      mcapMin: request.mcapMin ?? null,
      mcapMax: request.mcapMax ?? null,
      fdvMin: request.fdvMin ?? null,
      fdvMax: request.fdvMax ?? null,
      ageMinMinutes: request.ageMinMinutes ?? null,
      ageMaxMinutes: request.ageMaxMinutes ?? null,
      search: request.searchQuery ? 'set' : '',
      starredOnly: Boolean(request.starredOnly),
      dismissedCount: request.dismissedTokenIdentities?.length ?? 0,
    };
  }

  function summarizeCompactHistoryToken(
    address: string,
    item?: Partial<ManualTokenEntry & DashboardMonitoredToken>,
    rank?: number,
  ) {
    return {
      rank: rank ?? null,
      address,
      symbol: toDebugSymbol(item?.symbol, item?.label),
      score: toDebugNumber(item?.historySortScore, 6),
      mcap: toDebugNumber(item?.mcap),
      v24: toDebugNumber(item?.volume24h),
      v6: toDebugNumber(item?.volume6h),
      v1: toDebugNumber(item?.volume1h),
      createdAt: toDebugNullable(item?.tokenCreatedAt ?? item?.createdAt),
      evaluatedAt: toDebugNullable(item?.lastEvaluatedAt),
    };
  }

  function buildPreviousRecentDebugMap(identities: string[]) {
    return new Map(identities.map((identityKey, index) => {
      const identity = parseTokenIdentityKey(identityKey);
      return [
        identityKey,
        summarizeCompactHistoryToken(identity.address, getTrackedTokenByIdentity(identityKey) ?? undefined, index + 1),
      ];
    }));
  }

  function buildPayloadRecentDebugMap(tokens: DashboardMonitoredToken[]) {
    return new Map(tokens.map((item, index) => [
      getTrackedTokenKey(item.address, item.chain),
      summarizeCompactHistoryToken(item.address, item, index + 1),
    ]));
  }

  function summarizeCompactRecentDebugDelta(
    previous: string[],
    next: string[],
    previousMap: Map<string, ReturnType<typeof summarizeCompactHistoryToken>>,
    nextMap: Map<string, ReturnType<typeof summarizeCompactHistoryToken>>,
  ) {
    const previousSet = new Set(previous);
    const nextSet = new Set(next);
    const addedAddresses = next.filter((address) => !previousSet.has(address));
    const removedAddresses = previous.filter((address) => !nextSet.has(address));
    const moved = next
      .map((address, nextIndex) => ({
        address,
        previousRank: previous.indexOf(address) + 1,
        nextRank: nextIndex + 1,
      }))
      .filter((item) => item.previousRank > 0 && item.previousRank !== item.nextRank);

    return {
      addedCount: addedAddresses.length,
      removedCount: removedAddresses.length,
      movedCount: moved.length,
      added: addedAddresses.slice(0, 6).map((address) => nextMap.get(address) || summarizeCompactHistoryToken(address)),
      removed: removedAddresses.slice(0, 6).map((address) => previousMap.get(address) || summarizeCompactHistoryToken(address)),
      moved: moved.slice(0, 8),
    };
  }

  function summarizeHistoryDebugProbe(
    probe: DashboardHistoryDebugProbeEntry[] | undefined,
    previous: string[],
    next: string[],
  ) {
    if (!probe?.length) {
      return [];
    }

    const nextSet = new Set(next);
    const removedSet = new Set(previous.filter((identityKey) => !nextSet.has(identityKey)));
    return probe
      .filter((item) => removedSet.has(getTrackedTokenKey(item.address, item.chain || 'solana')))
      .slice(0, 8)
      .map((item) => ({
        address: item.address,
        symbol: item.symbol ?? null,
        included: Boolean(item.included),
        diagnosis: item.diagnosis ?? null,
        rank: item.rank ?? null,
        score: toDebugNumber(item.historySortScore, 6),
        mcap: toDebugNumber(item.mcap),
        v24: toDebugNumber(item.volume24h),
        v6: toDebugNumber(item.volume6h),
        v1: toDebugNumber(item.volume1h),
        eligible: item.eligibleForMonitoring ?? null,
        state: item.eligibilityState ?? null,
        suppressed: item.suppressedReason ?? null,
        evaluatedAt: item.lastEvaluatedAt ?? null,
      }));
  }

  function summarizeDashboardDebugTokens(tokens: DashboardMonitoredToken[] = []) {
    return tokens.slice(0, 8).map((item) => ({
      address: item.address,
      symbol: toDebugSymbol(item.symbol),
      ...summarizeDebugTokenMetrics(item),
      createdAt: toDebugNullable(item.tokenCreatedAt),
      lastSeenAt: toDebugNullable(item.lastSeenAt),
      lastEvaluatedAt: toDebugNullable(item.lastEvaluatedAt),
    }));
  }

  function formatDebugErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function isSparklineDebugEnabled() {
    if (typeof window === 'undefined') {
      return false;
    }
    try {
      return window.localStorage.getItem(SPARKLINE_DEBUG_ENABLED_KEY) === '1'
        || new URLSearchParams(window.location.search).has('sparklineDebug');
    } catch (_) {
      return false;
    }
  }

  function hashSparklineDebugValue(value: string) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function summarizeSparklineDebugAddresses(addresses: string[] = []) {
    const normalized = addresses.map((address) => String(address || '').trim()).filter(Boolean);
    return {
      count: normalized.length,
      head: normalized.slice(0, 8),
      hash: hashSparklineDebugValue(normalized.join(',')),
    };
  }

  function summarizeSparklineDebugAddressDiff(previous: string[] = [], next: string[] = []) {
    const previousSet = new Set(previous.map((address) => String(address || '').trim()).filter(Boolean));
    const nextSet = new Set(next.map((address) => String(address || '').trim()).filter(Boolean));
    const added = [...nextSet].filter((address) => !previousSet.has(address));
    const removed = [...previousSet].filter((address) => !nextSet.has(address));
    return {
      added: summarizeSparklineDebugAddresses(added),
      removed: summarizeSparklineDebugAddresses(removed),
      changed: added.length > 0 || removed.length > 0,
    };
  }

  function normalizeSparklineDebugCaller(value: unknown, fallback = 'unknown') {
    const caller = String(value || '').trim();
    return caller ? caller.slice(0, 80) : fallback;
  }

  function summarizeSparklineDebugBatches(batches: SparklineBatchRequest[] = []) {
    return {
      batchCount: batches.length,
      addressCount: batches.reduce((total, batch) => total + batch.identities.length, 0),
      batches: batches.slice(0, 6).map((batch) => ({
        hours: batch.hours,
        granularityMinutes: batch.granularityMinutes,
        addresses: summarizeSparklineDebugAddresses(batch.identities.map((identity) => identity.key)),
      })),
    };
  }

  function readSparklineDebugLog(): SparklineDebugEntry[] {
    if (typeof window === 'undefined') {
      return [];
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SPARKLINE_DEBUG_LOG_KEY) || '[]');
      return Array.isArray(parsed) ? parsed as SparklineDebugEntry[] : [];
    } catch (_) {
      return [];
    }
  }

  function readSparklineDebugOutputLog() {
    const persisted = readSparklineDebugLog();
    return persisted.length > 0 ? persisted : sparklineDebugRecentEntries;
  }

  function writeSparklineDebugLog(entries: SparklineDebugEntry[]) {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(SPARKLINE_DEBUG_LOG_KEY, JSON.stringify(entries.slice(0, SPARKLINE_DEBUG_MAX_ENTRIES)));
    } catch (_) {
      // Debug-only persistence must not affect the app.
    }
  }

  function getSparklineDebugEntryKey(entry: SparklineDebugEntry) {
    const controllerId = typeof entry.meta?.controllerId === 'string' ? entry.meta.controllerId : '';
    return `${entry.ts}|${entry.t}|${entry.event}|${controllerId}`;
  }

  function mergeSparklineDebugEntries(
    primary: SparklineDebugEntry[],
    secondary: SparklineDebugEntry[],
  ) {
    const seen = new Set<string>();
    const merged: SparklineDebugEntry[] = [];
    for (const entry of [...primary, ...secondary]) {
      const key = getSparklineDebugEntryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }
    return merged;
  }

  function rememberSparklineDebugEntry(entry: SparklineDebugEntry) {
    sparklineDebugRecentEntries = [entry, ...sparklineDebugRecentEntries]
      .slice(0, SPARKLINE_DEBUG_CONTEXT_MAX_ENTRIES);
  }

  function persistSparklineDebugEntries(entries: SparklineDebugEntry[]) {
    writeSparklineDebugLog(mergeSparklineDebugEntries(entries, readSparklineDebugLog()));
  }

  function activateSparklineDebugCapture(reason: string, entry: SparklineDebugEntry, now: number) {
    sparklineDebugCaptureUntil = Math.max(
      sparklineDebugCaptureUntil,
      now + SPARKLINE_DEBUG_TRIGGER_CAPTURE_MS,
    );
    const triggerEntry: SparklineDebugEntry = {
      event: 'debug.capture-triggered',
      t: entry.t,
      ts: entry.ts,
      meta: {
        ...entry.meta,
        triggerReason: reason,
        captureForMs: SPARKLINE_DEBUG_TRIGGER_CAPTURE_MS,
        bufferedEntries: sparklineDebugRecentEntries.length,
      },
    };
    persistSparklineDebugEntries([triggerEntry, ...sparklineDebugRecentEntries]);
  }

  function clearSparklineDebugLog() {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.removeItem(SPARKLINE_DEBUG_LOG_KEY);
      sparklineDebugRecentEntries = [];
      sparklineDebugCaptureUntil = 0;
    } catch (_) {
      // Ignore debug storage errors.
    }
  }

  function installApiResponseDebugListener() {
    if (typeof window === 'undefined' || sparklineDebugApiResponseListenerBound) {
      return;
    }

    sparklineDebugApiResponseListenerBound = true;
    window.addEventListener(API_RESPONSE_DEBUG_EVENT, (event) => {
      const detail = (event as CustomEvent<{
        path?: unknown;
        method?: unknown;
        response?: unknown;
      }>).detail || {};
      recordSparklineDebug('http.response', {
        endpoint: String(detail.path || 'apiFetch'),
        method: String(detail.method || 'GET').toUpperCase(),
        source: 'apiFetch',
        response: detail.response && typeof detail.response === 'object'
          ? detail.response as Record<string, unknown>
          : {},
      });
    });
  }

  function recordSparklineDebug(event: string, meta: Record<string, unknown> = {}) {
    if (!isSparklineDebugEnabled()) {
      return;
    }

    const cacheEntries = Object.values(state.data.sparklineByAddress);
    const entry: SparklineDebugEntry = {
      event,
      t: Math.round(typeof performance !== 'undefined' ? performance.now() : Date.now()),
      ts: new Date().toISOString(),
      meta: {
        controllerId: sparklineDebugControllerId,
        tabId: sparklineDebugTabId,
        workspace: state.ui.workspace,
        session: state.session.status,
        runtime: state.runtime.mode,
        cacheCount: cacheEntries.length,
        loadingCount: cacheEntries.filter((item) => item.loading).length,
        lastKey: lastSparklineAddressKey ? hashSparklineDebugValue(lastSparklineAddressKey) : '',
        nextRefreshInMs: Math.max(0, nextSparklineRefreshAt - Date.now()),
        inFlight: sparklineRefreshInFlight,
        queued: sparklineRefreshQueued,
        ...meta,
      },
    };

    rememberSparklineDebugEntry(entry);
    const now = Date.now();
    const decision = evaluateSparklineDebugEvent(event, meta, {
      now,
      captureUntil: sparklineDebugCaptureUntil,
      lowRemainingThreshold: SPARKLINE_DEBUG_LOW_REMAINING_THRESHOLD,
    });

    if (decision.trigger) {
      activateSparklineDebugCapture(decision.reason || event, entry, now);
      return;
    }
    if (decision.persist) {
      persistSparklineDebugEntries([entry]);
    }
  }

  function installSparklineDebugConsole() {
    if (typeof window === 'undefined') {
      return;
    }
    installApiResponseDebugListener();

    (window as SparklineDebugWindow).trendscopeSparklineDebug = {
      arm: () => {
        clearSparklineDebugLog();
        window.localStorage.setItem(SPARKLINE_DEBUG_ENABLED_KEY, '1');
        recordSparklineDebug('debug.armed', { mode: 'trigger' });
      },
      clear: clearSparklineDebugLog,
      copy: async () => {
        const text = JSON.stringify(readSparklineDebugOutputLog(), null, 2);
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          return text;
        }
        return undefined;
      },
      capture: (durationMs = SPARKLINE_DEBUG_TRIGGER_CAPTURE_MS) => {
        window.localStorage.setItem(SPARKLINE_DEBUG_ENABLED_KEY, '1');
        sparklineDebugCaptureUntil = Math.max(sparklineDebugCaptureUntil, Date.now() + Math.max(1, Number(durationMs) || 1));
        persistSparklineDebugEntries(sparklineDebugRecentEntries);
      },
      disable: () => {
        window.localStorage.removeItem(SPARKLINE_DEBUG_ENABLED_KEY);
        sparklineDebugCaptureUntil = 0;
      },
      dump: readSparklineDebugOutputLog,
      enable: () => {
        window.localStorage.setItem(SPARKLINE_DEBUG_ENABLED_KEY, '1');
        recordSparklineDebug('debug.enabled', { mode: 'passive' });
      },
      status: () => ({
        enabled: isSparklineDebugEnabled(),
        bufferedEntries: sparklineDebugRecentEntries.length,
        persistedEntries: readSparklineDebugLog().length,
        captureActive: sparklineDebugCaptureUntil > Date.now(),
        captureRemainingMs: Math.max(0, sparklineDebugCaptureUntil - Date.now()),
        lowRemainingThreshold: SPARKLINE_DEBUG_LOW_REMAINING_THRESHOLD,
      }),
      text: () => JSON.stringify(readSparklineDebugOutputLog(), null, 2),
    };
  }

  function recordRestoreControllerDebug(label: string, meta: Record<string, unknown> = {}) {
    const active = isRuntimePerfDebugActive();
    if (!active) {
      return;
    }

    recordRuntimePerfDebugEntry({
      ts: Date.now(),
      kind: 'sample',
      label,
      meta: {
        workspace: state.ui.workspace,
        sessionStatus: state.session.status,
        trackedTokens: Object.keys(state.data.trackedTokensByIdentity).length,
        monitored: state.data.monitoredTokenIdentities.length,
        recent: state.data.recentTokenIdentities.length,
        oldWeek: state.data.oldWeekTokenIdentities.length,
        barsRecent: state.bars.recent,
        barsOldWeek: state.bars.oldWeek,
        recentHead: state.data.recentTokenIdentities.slice(0, 8),
        oldWeekHead: state.data.oldWeekTokenIdentities.slice(0, 8),
        ...meta,
      },
      memory: readRuntimePerfMemory(),
    }, active);
  }

  function summarizeAlertDebug(entries: AlertEntry[] = state.data.alerts) {
    const sorted = [...entries].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const summarize = (alert: AlertEntry) => ({
      id: alert.id,
      kind: alert.kind,
      ruleKey: alert.ruleKey || null,
      address: alert.address,
      symbol: alert.symbol || null,
      createdAt: Number(alert.createdAt || 0),
      createdAtIso: Number.isFinite(Number(alert.createdAt || 0))
        ? new Date(Number(alert.createdAt || 0)).toISOString()
        : null,
    });

    return {
      count: entries.length,
      newest: sorted.slice(0, 8).map(summarize),
      oldest: sorted.slice(-4).map(summarize),
    };
  }

  function getAlertStorageKey(scope: string) {
    return `frontend_vite:${scope}:alerts`;
  }

  function readStoredAlertsDebug(scope: string = getStorageScope()) {
    if (typeof window === 'undefined' || !window.localStorage) {
      return {
        scope,
        key: getAlertStorageKey(scope),
        available: false,
      };
    }

    const key = getAlertStorageKey(scope);
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        return {
          scope,
          key,
          available: true,
          exists: false,
          rawLength: 0,
          parsed: null,
        };
      }

      const parsed = JSON.parse(raw);
      return {
        scope,
        key,
        available: true,
        exists: true,
        rawLength: raw.length,
        parsed: Array.isArray(parsed) ? summarizeAlertDebug(parsed as AlertEntry[]) : null,
        parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
      };
    } catch (error) {
      return {
        scope,
        key,
        available: true,
        exists: true,
        parseError: formatDebugErrorMessage(error),
      };
    }
  }

  function summarizeAlertDebugSlim(summary: ReturnType<typeof summarizeAlertDebug> | null | undefined) {
    if (!summary) {
      return null;
    }

    return {
      count: summary.count,
      newest: summary.newest.slice(0, 3),
      oldest: summary.oldest.slice(-2),
    };
  }

  function summarizeStoredAlertsDebugSlim(storage: ReturnType<typeof readStoredAlertsDebug>) {
    return {
      scope: storage.scope,
      key: storage.key,
      available: storage.available,
      exists: 'exists' in storage ? storage.exists : undefined,
      rawLength: 'rawLength' in storage ? storage.rawLength : undefined,
      parsedType: 'parsedType' in storage ? storage.parsedType : undefined,
      parseError: 'parseError' in storage ? storage.parseError : undefined,
      parsed: 'parsed' in storage ? summarizeAlertDebugSlim(storage.parsed) : undefined,
    };
  }

  function summarizeMissingAlertsSlim(value: unknown) {
    return Array.isArray(value)
      ? value.slice(0, 20)
      : [];
  }

  function compactAlertDebugMeta(label: string, meta: Record<string, unknown>) {
    const scope = String(meta.storageScope || getStorageScope());
    const storage = summarizeStoredAlertsDebugSlim(readStoredAlertsDebug(scope));
    const current = summarizeAlertDebugSlim(meta.current as ReturnType<typeof summarizeAlertDebug> | null | undefined);
    const before = summarizeAlertDebugSlim(meta.before as ReturnType<typeof summarizeAlertDebug> | null | undefined);
    const after = summarizeAlertDebugSlim(meta.after as ReturnType<typeof summarizeAlertDebug> | null | undefined);
    const loaded = summarizeAlertDebugSlim(meta.loaded as ReturnType<typeof summarizeAlertDebug> | null | undefined);
    const saved = summarizeAlertDebugSlim(meta.saved as ReturnType<typeof summarizeAlertDebug> | null | undefined);
    const missingNewestFromBefore = summarizeMissingAlertsSlim(meta.missingNewestFromBefore);

    return {
      ts: new Date().toISOString(),
      label: `alerts.${label}`,
      workspace: meta.workspace,
      sessionStatus: meta.sessionStatus,
      runtimeMode: meta.runtimeMode,
      storageScope: scope,
      current,
      before,
      after,
      loaded,
      saved,
      storage,
      removedCount: meta.removedCount,
      missingCount: missingNewestFromBefore.length,
      missingNewestFromBefore,
      added: meta.added,
      addedEvents: meta.addedEvents,
      mode: meta.mode,
      blocklistCount: meta.blocklistCount,
      feedCount: meta.feedCount,
      backendEventsCount: (meta.backendEvents as { count?: unknown } | null | undefined)?.count,
      builtEntriesCount: (meta.builtEntries as { count?: unknown } | null | undefined)?.count,
      mergedEventsCount: (meta.mergedEvents as { count?: unknown } | null | undefined)?.count,
      sparklineCacheCount: meta.sparklineCacheCount,
    };
  }

  function readAlertDebugLog() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return [];
    }

    try {
      const raw = window.localStorage.getItem(ALERT_DEBUG_LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAlertDebugLog(entries: unknown[]) {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.setItem(ALERT_DEBUG_LOG_KEY, JSON.stringify(entries.slice(0, ALERT_DEBUG_MAX_ENTRIES)));
    } catch {
      try {
        window.localStorage.setItem(ALERT_DEBUG_LOG_KEY, JSON.stringify(entries.slice(0, 80)));
      } catch {
        // Alert debug should never affect the app runtime.
      }
    }
  }

  function clearAlertDebugLog() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.removeItem(ALERT_DEBUG_LOG_KEY);
    } catch {
      // Ignore localStorage failures while debugging.
    }
  }

  function readAlertPerfDebugEntries() {
    const isAlertEntry = (entry: { label?: unknown }) => String(entry.label || '').startsWith('alerts.');
    return {
      active: getRuntimePerfDebugLog().filter(isAlertEntry),
      archives: getRuntimePerfDebugArchives()
        .map((archive) => ({
          ...archive,
          entries: archive.entries.filter(isAlertEntry),
        }))
        .filter((archive) => archive.entries.length > 0),
    };
  }

  function buildAlertDebugSnapshot() {
    const scope = getStorageScope();
    return {
      ts: new Date().toISOString(),
      enabled: isRuntimePerfDebugEnabled(),
      workspace: state.ui.workspace,
      sessionStatus: state.session.status,
      sessionRole: state.session.role,
      runtimeMode: state.runtime.mode,
      storageScope: scope,
      memory: summarizeAlertDebug(),
      storage: readStoredAlertsDebug(scope),
      pendingPersist: Boolean(alertsPersistTimer),
      pendingPersistScope: alertsPersistScope,
    };
  }

  function recordAlertForensics(label: string, meta: Record<string, unknown>) {
    try {
      const entry = compactAlertDebugMeta(label, meta);
      writeAlertDebugLog([entry, ...readAlertDebugLog()]);
    } catch {
      // Alert debug should never affect the app runtime.
    }
  }

  function installAlertDebugConsole() {
    if (typeof window === 'undefined') {
      return;
    }

    (window as Window & {
      trendscopeAlertDebug?: {
        clear: () => void;
        dump: () => unknown[];
        dumpAll: () => Record<string, unknown>;
        isEnabled: () => boolean;
        snapshot: () => Record<string, unknown>;
      };
    }).trendscopeAlertDebug = {
      clear: clearAlertDebugLog,
      dump: readAlertDebugLog,
      dumpAll: () => ({
        snapshot: buildAlertDebugSnapshot(),
        alertLog: readAlertDebugLog(),
        perfAlertLog: readAlertPerfDebugEntries(),
      }),
      isEnabled: isRuntimePerfDebugEnabled,
      snapshot: buildAlertDebugSnapshot,
    };
  }

  function summarizeDashboardAlertEventsDebug(events: DashboardAlertEvent[] = []) {
    const sorted = [...events].sort((a, b) => getBackendAlertCreatedAt(b.triggeredAt) - getBackendAlertCreatedAt(a.triggeredAt));
    return {
      count: events.length,
      newest: sorted.slice(0, 8).map((event) => ({
        id: Number(event.id) || null,
        kind: event.kind || null,
        ruleKey: event.ruleKey || null,
        address: event.address || null,
        triggeredAt: event.triggeredAt || null,
      })),
      oldest: sorted.slice(-4).map((event) => ({
        id: Number(event.id) || null,
        kind: event.kind || null,
        ruleKey: event.ruleKey || null,
        address: event.address || null,
        triggeredAt: event.triggeredAt || null,
      })),
    };
  }

  function getMissingAlertDebug(before: AlertEntry[], after: AlertEntry[]) {
    const afterIds = new Set(after.map((alert) => alert.id));
    return [...before]
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .filter((alert) => !afterIds.has(alert.id))
      .slice(0, 80)
      .map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        ruleKey: alert.ruleKey || null,
        address: alert.address,
        symbol: alert.symbol || null,
        createdAt: Number(alert.createdAt || 0),
      }));
  }

  function recordAlertDebug(label: string, meta: Record<string, unknown> = {}) {
    const active = isRuntimePerfDebugActive();
    if (!active) {
      return;
    }

    const debugMeta = {
      workspace: state.ui.workspace,
      sessionStatus: state.session.status,
      runtimeMode: state.runtime.mode,
      storageScope: getStorageScope(),
      current: summarizeAlertDebug(),
      ...meta,
    };

    recordRuntimePerfDebugEntry({
      ts: Date.now(),
      kind: 'sample',
      label: `alerts.${label}`,
      meta: debugMeta,
      memory: readRuntimePerfMemory(),
    }, active);
    recordAlertForensics(label, debugMeta);
  }

  function recordAlertMutationDebug(label: string, before: AlertEntry[], meta: Record<string, unknown> = {}) {
    const after = state.data.alerts;
    recordAlertDebug(label, {
      before: summarizeAlertDebug(before),
      after: summarizeAlertDebug(after),
      removedCount: Math.max(0, before.length - after.length),
      missingNewestFromBefore: getMissingAlertDebug(before, after),
      ...meta,
    });
  }

  function emit(...regions: AppRenderRegion[]) {
    queueDirtyRegions(regions);
    if (emitScheduled) {
      return;
    }

    if (typeof window === 'undefined') {
      flushEmit();
      return;
    }

    emitScheduled = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => flushEmit());
      emitTimer = window.setTimeout(() => flushEmit(), 50);
      return;
    }

    emitTimer = window.setTimeout(() => flushEmit(), 0);
  }

  function flushPumpfunEmit() {
    if (pumpfunEmitTimer) {
      clearTimeout(pumpfunEmitTimer);
      pumpfunEmitTimer = null;
    }

    if (pendingPumpfunEmitRegions.size === 0) {
      return;
    }

    const regions = [...pendingPumpfunEmitRegions];
    pendingPumpfunEmitRegions.clear();
    emit(...regions);
  }

  function cancelScheduledPumpfunEmit() {
    if (pumpfunEmitTimer) {
      clearTimeout(pumpfunEmitTimer);
      pumpfunEmitTimer = null;
    }
    pendingPumpfunEmitRegions.clear();
  }

  function schedulePumpfunEmit(...regions: AppRenderRegion[]) {
    for (const region of regions.length > 0 ? regions : ['pumpfun' as AppRenderRegion]) {
      pendingPumpfunEmitRegions.add(region);
    }

    if (typeof window === 'undefined') {
      flushPumpfunEmit();
      return;
    }

    if (pumpfunEmitTimer) {
      return;
    }

    pumpfunEmitTimer = window.setTimeout(() => flushPumpfunEmit(), PUMP_RENDER_THROTTLE_MS);
  }

  function setBusy(busy: boolean) {
    state.ui.busy = busy;
  }

  function setError(error: string | null) {
    state.ui.error = error;
  }

  function setNotice(notice: string | null) {
    state.ui.notice = notice;
  }

  function resolveMockTradingActiveWalletId(wallets: MockTradingWalletEntry[]) {
    if (wallets.length === 0) {
      return null;
    }
    const currentId = state.ui.activeMockTradingWalletId;
    if (currentId != null && wallets.some((wallet) => wallet.id === currentId)) {
      return currentId;
    }
    const persistedId = loadPersistedMockTradingActiveWalletId();
    if (persistedId != null && wallets.some((wallet) => wallet.id === persistedId)) {
      return persistedId;
    }
    return wallets.find((wallet) => wallet.isDefault)?.id ?? wallets[0]?.id ?? null;
  }

  function applyMockTradingWallets(wallets: MockTradingWalletEntry[]) {
    state.data.mockTradingWallets = wallets;
    state.ui.activeMockTradingWalletId = resolveMockTradingActiveWalletId(wallets);
    persistMockTradingActiveWalletId(state.ui.activeMockTradingWalletId);
  }

  function clearMockTradingState() {
    state.data.mockTradingWallets = [];
    state.data.mockTradingSummary = null;
    state.data.mockTradingPositionsByAddress = {};
    state.data.mockTradingTradesByAddress = {};
    state.ui.activeMockTradingWalletId = null;
    state.ui.mockTradingTicket = null;
    state.ui.mockTradingHistoryOpen = false;
    state.ui.mockTradingPnlAddress = null;
  }

  function invalidateWorkspaceHydrationRequests() {
    configReloadRevision += 1;
    historyBootstrapRequestRevision += 1;
    monitoredBootstrapHydrationRevision += 1;
    nextMonitoredFullHydrationAt = 0;
    resetManualMetadataBatchState();
  }

  function getMockTradingAdminToken() {
    if (!isMockTradingEnabled(state)) {
      clearMockTradingState();
      setError('Mock trading is disabled');
      emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
      return null;
    }
    const token = state.session.token;
    if (!token || state.session.role !== 'admin') {
      setError('Admin access required');
      emit();
      return null;
    }
    return token;
  }

  function applyMockTradingPositions(positions: MockTradingPositionEntry[]) {
    state.data.mockTradingPositionsByAddress = Object.fromEntries(
      positions.map((position) => [position.tokenAddress, position])
    );
  }

  function applyMockTradingTrades(trades: MockTradingTradeEntry[]) {
    const grouped: Record<string, MockTradingTradeEntry[]> = {};
    for (const trade of trades) {
      grouped[trade.tokenAddress] ||= [];
      grouped[trade.tokenAddress].push(trade);
    }
    state.data.mockTradingTradesByAddress = grouped;
  }

  async function refreshMockTradingState(options?: { emit?: boolean }) {
    const token = state.session.token;
    if (!isMockTradingEnabled(state) || !token || state.session.role !== 'admin') {
      clearMockTradingState();
      return;
    }
    if (mockTradingRefreshInFlight) {
      return;
    }

    mockTradingRefreshInFlight = true;
    try {
      const wallets = await fetchMockTradingWallets(token);
      if (state.session.token !== token || state.session.role !== 'admin') {
        return;
      }
      applyMockTradingWallets(wallets);
      const walletId = state.ui.activeMockTradingWalletId;
      const [summary, positions, trades] = await Promise.all([
        fetchMockTradingSummary(token, walletId),
        fetchMockTradingPositions(token, walletId),
        fetchMockTradingTrades(token, 200, walletId),
      ]);
      if (state.session.token !== token || state.session.role !== 'admin') {
        return;
      }
      state.data.mockTradingSummary = summary;
      if (summary.wallet?.id != null) {
        state.ui.activeMockTradingWalletId = summary.wallet.id;
        persistMockTradingActiveWalletId(summary.wallet.id);
      }
      applyMockTradingPositions(positions);
      applyMockTradingTrades(trades);
      if (options?.emit) {
        emit('legacy', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    } catch (error) {
      console.warn('[AppController] Failed to refresh mock trading state:', error instanceof Error ? error.message : error);
    } finally {
      mockTradingRefreshInFlight = false;
    }
  }

  function refreshMockTradingStateForMarketPoll() {
    if (!isMockTradingEnabled(state) || state.session.role !== 'admin' || !state.session.token) {
      clearMockTradingState();
      return;
    }
    const now = Date.now();
    if (now < nextMockTradingMarketRefreshAt) {
      return;
    }
    nextMockTradingMarketRefreshAt = now + MOCK_TRADING_MARKET_REFRESH_INTERVAL_MS;
    void refreshMockTradingState({ emit: true });
  }

  function buildIdleFloatingQuickBuyState(): AppState['ui']['floatingQuickBuy'] {
    return {
      address: '',
      notionalSol: FLOATING_QUICK_BUY_NOTIONAL_SOL,
      status: 'idle',
      message: null,
      error: null,
      armedAt: null,
      armedCycle: state.runtime.cycle,
      updatedAt: Date.now(),
      executedAt: null,
      lastPriceUsd: null,
      lastMcap: null,
      manualTracked: false,
      buyAttempted: false,
    };
  }

  function resetFloatingQuickBuyState() {
    if (floatingQuickBuyResetTimer) {
      clearTimeout(floatingQuickBuyResetTimer);
      floatingQuickBuyResetTimer = null;
    }
    state.ui.floatingQuickBuy = buildIdleFloatingQuickBuyState();
    nextFloatingQuickBuyDashboardRefreshAt = 0;
    floatingQuickBuyExecutionInFlight = false;
    floatingQuickBuyDashboardRefreshInFlight = false;
  }

  function updateFloatingQuickBuyState(patch: Partial<AppState['ui']['floatingQuickBuy']>) {
    state.ui.floatingQuickBuy = {
      ...state.ui.floatingQuickBuy,
      ...patch,
      updatedAt: Date.now(),
    };
  }

  function scheduleFloatingQuickBuySuccessReset(address: string) {
    if (floatingQuickBuyResetTimer) {
      clearTimeout(floatingQuickBuyResetTimer);
    }
    floatingQuickBuyResetTimer = setTimeout(() => {
      floatingQuickBuyResetTimer = null;
      if (state.ui.floatingQuickBuy.address !== address || state.ui.floatingQuickBuy.status !== 'bought') {
        return;
      }
      resetFloatingQuickBuyState();
      emit('overlay');
    }, 1800);
  }

  function isFloatingQuickBuyWaitingForMarket() {
    const status = state.ui.floatingQuickBuy.status;
    return status === 'tracking' || status === 'waiting_market';
  }

  function getFloatingQuickBuyMarketSnapshot(address: string) {
    const token = getTrackedToken(state, address);
    const priceUsd = Number(token?.priceUsd);
    const mcap = Number(token?.mcap);
    if (!Number.isFinite(mcap) || mcap <= 0) {
      return null;
    }
    return {
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      mcap,
    };
  }

  async function addManualTokenForFloatingQuickBuy(address: string, token: string) {
    if (state.data.manualTokenIdentities.includes(getTrackedTokenKey(address))) {
      await trackManualToken(address, token);
      await hydrateManualTokenDashboardFields(address, token, { retryDelaysMs: [0, 750, 2000] });
      return;
    }

    invalidateWorkspaceHydrationRequests();
    const optimisticSnapshot = captureOptimisticManualTokenSnapshot(address);
    const nextManual = buildOptimisticManualToken(address, null);
    applyOptimisticManualToken(address, nextManual);
    emit('manual', 'monitored', 'header');

    try {
      await syncManualTokenToBackend('solana', address, null, token);
      await hydrateManualTokenDashboardFields(address, token, { retryDelaysMs: [0, 750, 2000] });
    } catch (error) {
      revertOptimisticManualToken(address, optimisticSnapshot);
      throw error;
    }
  }

  async function executeFloatingQuickBuyIfReady() {
    const quickBuy = state.ui.floatingQuickBuy;
    const token = state.session.token;
    if (
      !token
      || state.session.role !== 'admin'
      || floatingQuickBuyExecutionInFlight
      || !isFloatingQuickBuyWaitingForMarket()
      || quickBuy.buyAttempted
    ) {
      return;
    }
    if (!quickBuy.address) {
      return;
    }

    const market = getFloatingQuickBuyMarketSnapshot(quickBuy.address);
    if (!market) {
      updateFloatingQuickBuyState({
        status: 'waiting_market',
        message: 'Waiting for MCAP update',
        error: null,
      });
      emit('overlay');
      return;
    }

    updateFloatingQuickBuyState({
      lastPriceUsd: market.priceUsd,
      lastMcap: market.mcap,
    });

    if (state.data.mockTradingPositionsByAddress[quickBuy.address]) {
      updateFloatingQuickBuyState({
        status: 'error',
        error: 'Active wallet already has an open mock position for this token',
        message: null,
      });
      emit('overlay', 'header');
      return;
    }
    const validationError = getMockTradingBuyValidationError(state, quickBuy.notionalSol);
    if (validationError) {
      updateFloatingQuickBuyState({
        status: 'error',
        error: validationError,
        message: null,
      });
      emit('overlay', 'header');
      return;
    }

    floatingQuickBuyExecutionInFlight = true;
    updateFloatingQuickBuyState({
      status: 'buying',
      buyAttempted: true,
      message: 'Executing quick buy...',
      error: null,
    });
    emit('overlay', 'header');

    try {
      const result = await buyMockTradingToken(
        quickBuy.address,
        quickBuy.notionalSol,
        token,
        undefined,
        state.ui.activeMockTradingWalletId,
      );
      if (state.session.token !== token || state.ui.floatingQuickBuy.address !== quickBuy.address) {
        return;
      }
      if (result.position) {
        state.data.mockTradingPositionsByAddress[quickBuy.address] = result.position;
      }
      updateFloatingQuickBuyState({
        status: 'bought',
        message: result.message,
        error: null,
        executedAt: Date.now(),
        lastPriceUsd: market.priceUsd,
        lastMcap: market.mcap,
      });
      setNotice(result.message);
      scheduleFloatingQuickBuySuccessReset(quickBuy.address);
      void refreshMockTradingState({ emit: true });
    } catch (error) {
      if (state.ui.floatingQuickBuy.address !== quickBuy.address) {
        return;
      }
      updateFloatingQuickBuyState({
        status: 'error',
        buyAttempted: false,
        error: error instanceof Error ? error.message : 'Failed to execute quick buy',
        message: null,
      });
    } finally {
      floatingQuickBuyExecutionInFlight = false;
      emit('header', 'overlay', 'manual', 'monitored');
    }
  }

  function shouldRefreshFloatingQuickBuyDashboard() {
    if (!state.session.token || state.session.role !== 'admin' || !isFloatingQuickBuyWaitingForMarket()) {
      return false;
    }
    if (isLiveWorkspace() || floatingQuickBuyDashboardRefreshInFlight) {
      return false;
    }
    return Date.now() >= nextFloatingQuickBuyDashboardRefreshAt;
  }

  async function refreshFloatingQuickBuyDashboardSnapshot() {
    const token = state.session.token;
    if (!token || !shouldRefreshFloatingQuickBuyDashboard()) {
      return;
    }

    floatingQuickBuyDashboardRefreshInFlight = true;
    nextFloatingQuickBuyDashboardRefreshAt = Date.now() + FLOATING_QUICK_BUY_DASHBOARD_REFRESH_INTERVAL_MS;
    try {
      const monitoredDashboard = await fetchDashboardMonitored(token, {
        chains: ['solana'],
        minMcap: getMonitoredValuationFilters().minMcap,
      });
      if (state.session.token !== token || state.session.role !== 'admin') {
        return;
      }
      applyMonitoredDashboard(
        monitoredDashboard.tokens,
        undefined,
        monitoredDashboard.generatedAt ?? null,
        monitoredDashboard.pinnedTokens,
      );
      await executeFloatingQuickBuyIfReady();
      emit('manual', 'monitored', 'header');
    } catch (error) {
      updateFloatingQuickBuyState({
        status: 'waiting_market',
        error: error instanceof Error ? error.message : 'Failed to refresh quick buy market data',
      });
      emit('overlay');
    } finally {
      floatingQuickBuyDashboardRefreshInFlight = false;
    }
  }

  function appendEmailDebugNotice(notice: string, emailDebug?: AuthEmailDebug | null) {
    if (!emailDebug) {
      return notice;
    }

    const safeOtpCode = String(emailDebug.otpCode || '').replace(/\s+/g, '');
    if (/^\d{4,8}$/.test(safeOtpCode)) {
      return `${notice} Local dev code: ${safeOtpCode}.`;
    }

    const safeActionUrl = String(emailDebug.actionUrl || '').trim();
    if (safeActionUrl) {
      try {
        const url = new URL(safeActionUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          url.hash = '';
          return `${notice} Local dev link: ${url.toString()}`;
        }
      } catch (_) {
        // Ignore invalid debug URL payloads.
      }
    }

    return notice;
  }

  function clearAuthUrl() {
    if (typeof window === 'undefined') {
      return;
    }
    const pathname = window.location.pathname || '/';
    const search = new URLSearchParams(window.location.search);
    if (isAuthRoutePath(pathname) || search.has('mode') || search.has('token')) {
      window.history.replaceState({}, document.title, '/login');
    }
  }

  function clearLoginPanelUrl() {
    if (typeof window === 'undefined' || !isLoginRoutePath(window.location.pathname)) {
      return;
    }

    const url = new URL(window.location.href);
    const isPanelPath = Boolean(getLoginAuthPanelFromPath(url.pathname));
    if (!isPanelPath && !url.searchParams.has('panel')) {
      return;
    }

    url.searchParams.delete('panel');
    const nextUrl = isPanelPath ? '/login' : `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl || '/login');
  }

  function clearAccountPanelUrl() {
    if (typeof window === 'undefined' || !isAccountAuthPanelRoutePath(window.location.pathname)) {
      return;
    }

    window.history.replaceState({}, document.title, getWorkspacePath(state.ui.workspace));
  }

  function clearWorkspaceSparklineUrl() {
    if (typeof window === 'undefined') {
      return;
    }

    const route = parseWorkspaceSparklineRoute(window.location.pathname);
    if (!route) {
      return;
    }

    window.history.replaceState({}, document.title, getWorkspaceSparklineBasePath(window.location.pathname, route.workspace));
  }

  function getAuthPanelRoute(panel: Exclude<AuthPanel, 'none'>) {
    if (state.session.status === 'anonymous') {
      return LOGIN_AUTH_PANEL_PATHS[panel as LoginRouteAuthPanel] || null;
    }
    if (state.session.status === 'authenticated') {
      return ACCOUNT_AUTH_PANEL_PATHS[panel as AccountRouteAuthPanel] || null;
    }
    return null;
  }

  function navigateToAuthPanelRoute(panel: Exclude<AuthPanel, 'none'>) {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = getAuthPanelRoute(panel);
    if (!nextPath) {
      return;
    }

    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentPath !== nextPath) {
      window.history.pushState({}, document.title, nextPath);
    }
  }

  function replaceAuthPanelRoute(panel: Exclude<AuthPanel, 'none'>) {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = getAuthPanelRoute(panel);
    if (!nextPath) {
      return;
    }

    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentPath !== nextPath) {
      window.history.replaceState({}, document.title, nextPath);
    }
  }

  function clearBillingCheckoutUrl() {
    if (typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has('billing') && !url.searchParams.has('billingOrderId')) {
      return;
    }

    url.searchParams.delete('billing');
    url.searchParams.delete('billingOrderId');
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl || '/');
  }

  function clearSocialLinkUrl() {
    if (typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has('socialLink') && !url.searchParams.has('socialProvider')) {
      return;
    }

    url.searchParams.delete('socialLink');
    url.searchParams.delete('socialProvider');
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl || '/');
  }

  function clearSocialLoginUrl() {
    if (typeof window === 'undefined') {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has('socialLogin') && !url.searchParams.has('socialProvider')) {
      return;
    }

    url.searchParams.delete('socialLogin');
    url.searchParams.delete('socialProvider');
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl || '/');
  }

  function navigateToPreAccess(path = '/access') {
    if (typeof window === 'undefined') {
      return;
    }
    const nextPath = isPreAccessRoutePath(path) ? path : '/access';
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, document.title, nextPath);
    }
  }

  function navigateToLogin(panel?: 'register') {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = panel === 'register' ? LOGIN_AUTH_PANEL_PATHS.register : '/login';
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextPath) {
      window.history.pushState({}, document.title, nextPath);
    }
  }

  function navigateToPublicLanding() {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = '/';
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextPath) {
      window.history.pushState({}, document.title, nextPath);
    }
  }

  function navigateToAccountSecurity() {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = '/account-security';
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextPath) {
      window.history.pushState({}, document.title, nextPath);
    }
  }

  function syncAnonymousRouteStateFromLocation() {
    if (typeof window === 'undefined' || state.session.status !== 'anonymous') {
      return;
    }

    const pathname = window.location.pathname || '/';
    if (isPreAccessRoutePath(pathname)) {
      navigateToLogin();
      state.ui.authPanel = 'none';
      return;
    }

    if (isAccountSecurityRoutePath(pathname)) {
      navigateToLogin();
      state.ui.authPanel = 'none';
      return;
    }

    if (isPublicLandingRoutePath(pathname)) {
      state.ui.authPanel = 'none';
      return;
    }

    if (isLoginRoutePath(pathname) || isAuthRoutePath(pathname)) {
      const loginPanelIntent = getLoginPanelIntent(window.location);
      if (loginPanelIntent) {
        if (loginPanelIntent === 'wallet-select' && state.ui.authPanel !== 'wallet-select') {
          void openWalletSelector('login');
          return;
        }
        state.ui.authPanel = loginPanelIntent;
      } else if (isLoginRoutePath(pathname) && getAuthPanelRoute(state.ui.authPanel as Exclude<AuthPanel, 'none'>)) {
        state.ui.authPanel = 'none';
      }
      return;
    }

    navigateToLogin();
    state.ui.authPanel = 'none';
  }

  function emitWorkspaceChange() {
    emit('all');
  }

  function syncAuthenticatedPanelRouteFromLocation() {
    if (typeof window === 'undefined' || state.session.status !== 'authenticated') {
      return false;
    }

    const panel = getAccountAuthPanelFromPath(window.location.pathname);
    if (!panel) {
      if (getAuthPanelRoute(state.ui.authPanel as Exclude<AuthPanel, 'none'>)) {
        state.ui.authPanel = 'none';
        state.ui.pendingIdentityUnlinkProvider = null;
      }
      return false;
    }

    if (panel === 'wallet-select' && state.ui.authPanel !== 'wallet-select') {
      void openWalletSelector('link');
      return true;
    }

    const panelChanged = state.ui.authPanel !== panel;
    state.ui.authPanel = panel;
    if (panel === 'bot-settings') {
      hydrateBrowserNotificationSettings();
    }
    if (panel === 'token-review-alerts') {
      void loadAdminTokenReviewAlertsInternal()
        .then(() => emit('overlay', 'header', 'alerts'))
        .catch(() => emit('overlay', 'header', 'alerts'));
    }
    if (panel === 'user-settings') {
      void refreshUserSettingsState(COOKIE_SESSION_MARKER)
        .then(() => emit('overlay', 'header'))
        .catch(() => emit('overlay', 'header'));
    }
    if (panelChanged) {
      emit('all');
    }
    return true;
  }

  function syncWorkspaceSparklineRouteFromLocation() {
    if (typeof window === 'undefined' || state.session.status !== 'authenticated') {
      return false;
    }

    const route = parseWorkspaceSparklineRoute(window.location.pathname);
    if (!route || state.data.chainReadiness[route.chain]?.capabilities.charts !== true) {
      if (state.ui.expandedSparklineAddress) {
        unsubscribeMarketChart(
          state.ui.expandedSparklineAddress,
          state.ui.expandedSparklineChain,
        );
        state.ui.expandedSparklineAddress = null;
        state.ui.expandedSparklineChain = 'solana';
        emit('overlay');
      }
      return false;
    }

    const canonicalPath = getWorkspaceSparklinePath(route.workspace, route.address, route.chain);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState({}, document.title, canonicalPath);
    }

    if (state.ui.workspace !== route.workspace) {
      clearHistoryBucketOrderLocks({ applyPending: false });
      state.ui.workspace = route.workspace;
    }
    const identityChanged = state.ui.expandedSparklineAddress !== route.address
      || state.ui.expandedSparklineChain !== route.chain;
    if (identityChanged && state.ui.expandedSparklineAddress) {
      unsubscribeMarketChart(state.ui.expandedSparklineAddress, state.ui.expandedSparklineChain);
    }
    state.ui.expandedSparklineChain = route.chain;
    state.ui.expandedSparklineAddress = route.address;
    if (identityChanged) {
      subscribeMarketChart(route.address, route.chain);
    }
    state.ui.mockTradingPnlAddress = null;
    if (!isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(route.address, undefined, route.chain))) {
      setExpandedSparklineLoading(route.address, null, undefined, route.chain);
      void refreshExpandedSparkline(route.address, undefined, undefined, undefined, route.chain);
    }
    if (identityChanged) {
      emit('overlay');
    }
    return true;
  }

  function syncWorkspaceFromLocationInternal(options?: { canonicalize?: boolean }) {
    if (typeof window === 'undefined') {
      return;
    }

    const pathname = window.location.pathname || '/';
    if (isAuthRoutePath(pathname) || isPreAccessRoutePath(pathname)) {
      return;
    }

    if (syncAuthenticatedPanelRouteFromLocation()) {
      return;
    }

    const nextWorkspace = resolveWorkspaceFromPath(pathname);
    const changed = state.ui.workspace !== nextWorkspace;
    if (changed) {
      clearHistoryBucketOrderLocks({ applyPending: false });
    }
    state.ui.workspace = nextWorkspace;
    const isSparklineRoute = syncWorkspaceSparklineRouteFromLocation();

    if (options?.canonicalize && !isSparklineRoute) {
      const canonicalPath = getWorkspacePath(nextWorkspace);
      if (pathname !== canonicalPath) {
        window.history.replaceState({}, document.title, canonicalPath);
      }
    }

    syncWorkspaceCapabilities();
    if (changed) {
      refreshWorkspaceSnapshot();
    }

    if (changed) {
      emitWorkspaceChange();
    }
  }

  function navigateToWorkspace(workspace: WorkspaceView) {
    if (typeof window === 'undefined') {
      return;
    }

    const nextWorkspace = normalizeWorkspace(workspace);
    const nextPath = getWorkspacePath(nextWorkspace);
    const routeChanged = window.location.pathname !== nextPath;
    if (routeChanged) {
      window.history.pushState({}, document.title, nextPath);
    }

    if (state.ui.workspace !== nextWorkspace) {
      clearHistoryBucketOrderLocks({ applyPending: false });
      state.ui.workspace = nextWorkspace;
      syncWorkspaceCapabilities();
      refreshWorkspaceSnapshot();
      emitWorkspaceChange();
      return;
    }

    syncWorkspaceCapabilities();
    if (routeChanged) {
      emitWorkspaceChange();
    }
  }

  function normalizeAuthError(error: unknown, mode: 'login' | 'restore') {
    const raw = error instanceof Error ? error.message : '';

    if (!raw) {
      return getAuthDefaultErrorMessage(mode);
    }

    return getAuthLockoutErrorMessage(raw)
      || getMappedAuthErrorMessage(raw)
      || raw;
  }

  function isCredentialError(message: string | null) {
    return Boolean(message && message.includes('Incorrect email or password'));
  }

  function sortAddresses(items: AddressItem[]) {
    return [...items].sort((a, b) => a.address.localeCompare(b.address));
  }

  function clampUiVolume(value: number) {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : state.ui.soundVolume));
  }

  function getDefaultCollapsedSections() {
    return {
      manual: false,
      recent: false,
      oldWeek: false,
      monitored: false,
      bidZone: false,
      pumpfun: false,
    };
  }

  function getDefaultLivePanelLayout() {
    return createAppState().ui.livePanelLayout;
  }

  function normalizeUiPerPage(value: unknown, fallback: number) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return Math.max(10, Math.floor(fallback) || 30);
    }
    return Math.min(500, Math.max(10, Math.floor(num)));
  }

  function normalizeBucketSorts(
    input: unknown,
    scope: 'manual' | 'recent' | 'old-week',
  ): BucketSortCriterion[] {
    const defaults = getDefaultBucketSorts(scope);
    if (!Array.isArray(input)) {
      return defaults;
    }

    const next: BucketSortCriterion[] = [];
    const seen = new Set<string>();

    for (const item of input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }

      const mode = String((item as { mode?: unknown }).mode || '').trim();
      const window = String((item as { window?: unknown }).window || '').trim();
      if (mode !== 'vol' && mode !== 'mcap' && mode !== 'pchange' && mode !== 'age') {
        continue;
      }

      const normalized = normalizeBucketCriterion(mode as BucketSortMode, window as BucketSortWindow);
      const key = `${normalized.mode}:${normalized.window}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      next.push(normalized);
    }

    return next;
  }

  function normalizeMonitoredSorts(input: unknown): MonitoredSortCriterion[] {
    const defaults = getDefaultMonitoredSorts();
    if (!Array.isArray(input)) {
      return defaults;
    }

    const next: MonitoredSortCriterion[] = [];
    const seen = new Set<string>();

    for (const item of input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }

      const mode = String((item as { mode?: unknown }).mode || '').trim();
      const window = String((item as { window?: unknown }).window || '').trim();
      if (mode !== 'vol' && mode !== 'mcap' && mode !== 'age') {
        continue;
      }

      const normalized = normalizeMonitoredCriterion(mode as MonitoredSortMode, window as MonitoredSortWindow);
      const key = `${normalized.mode}:${normalized.window}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      next.push(normalized);
    }

    return next;
  }

  function normalizeTradeTerminals(input: unknown): AppState['ui']['enabledTradeTerminals'] {
    const defaults = createAppState().ui.enabledTradeTerminals;
    if (!Array.isArray(input)) {
      return [...defaults];
    }

    const next: AppState['ui']['enabledTradeTerminals'] = [];
    const seen = new Set<string>();
    for (const item of input) {
      const normalized = String(item || '').trim().toLowerCase();
      if (normalized !== 'axiom' && normalized !== 'photon' && normalized !== 'bullx' && normalized !== 'gmgn' && normalized !== 'padre') {
        continue;
      }
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      next.push(normalized);
    }

    return next.length > 0 ? next : [...defaults];
  }

  function normalizeLivePanelOrder(input: unknown): AppState['ui']['livePanelLayout']['order'] {
    const defaults = getDefaultLivePanelLayout().order;
    const order: AppState['ui']['livePanelLayout']['order'] = [];
    const seen = new Set<AppState['ui']['livePanelLayout']['order'][number]>();

    for (const item of Array.isArray(input) ? input : []) {
      if (item !== 'monitored' && item !== 'pumpfun' && item !== 'alerts') {
        continue;
      }
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      order.push(item);
    }

    for (const panelKey of defaults) {
      if (!seen.has(panelKey)) {
        order.push(panelKey);
      }
    }

    return order;
  }

  function normalizeResizableLivePanelSpan(input: unknown): 1 | 2 | 3 {
    const span = Number(input);
    return span === 2 || span === 3 ? span : 1;
  }

  function normalizeLivePanelHeight(input: unknown, fallback = 620) {
    const height = Math.round(Number(input));
    return Number.isFinite(height)
      ? Math.min(100000, Math.max(1, height))
      : fallback;
  }

  function normalizeLivePanelLayout(input: unknown): AppState['ui']['livePanelLayout'] {
    const source = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Partial<UiPrefsPayload['livePanelLayout']>
      : null;
    const defaults = getDefaultLivePanelLayout();
    const monitoredSpan = Number(source?.spans?.monitored);
    return {
      order: normalizeLivePanelOrder(source?.order),
      spans: {
        monitored: normalizeResizableLivePanelSpan(monitoredSpan),
        pumpfun: 1,
        alerts: normalizeResizableLivePanelSpan(source?.spans?.alerts),
      },
      heights: {
        monitored: normalizeLivePanelHeight(source?.heights?.monitored, defaults.heights.monitored),
        alerts: normalizeLivePanelHeight(source?.heights?.alerts, defaults.heights.alerts),
      },
    };
  }

  function applyExpandedSparklineUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    preferredExpandedSparklineGranularityMinutes = normalizeExpandedSparklineGranularity(uiPrefs?.expandedSparklineGranularityMinutes);
    state.ui.expandedSparklineGranularityMinutes = preferredExpandedSparklineGranularityMinutes;
    state.ui.expandedSparklineTimeZone = normalizeExpandedChartTimeZone(uiPrefs?.expandedSparklineTimeZone);
  }

  function normalizeSparklineRangeDays(days: unknown, fallback = SPARKLINE_RANGE_DEFAULT_DAYS) {
    const parsed = Math.round(Number(days));
    const fallbackDays = Math.round(Number(fallback));
    const safeFallback = Number.isFinite(fallbackDays)
      ? Math.min(SPARKLINE_RANGE_MAX_DAYS, Math.max(SPARKLINE_RANGE_MIN_DAYS, fallbackDays))
      : SPARKLINE_RANGE_DEFAULT_DAYS;
    return Number.isFinite(parsed)
      ? Math.min(SPARKLINE_RANGE_MAX_DAYS, Math.max(SPARKLINE_RANGE_MIN_DAYS, parsed))
      : safeFallback;
  }

  function normalizeSparklineRangeTokenDays(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }

    const next: Record<string, number> = {};
    for (const [rawAddress, rawDays] of Object.entries(input).slice(0, SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX)) {
      const address = String(rawAddress || '').trim();
      if (!address) {
        continue;
      }
      next[address] = normalizeSparklineRangeDays(rawDays);
    }
    return next;
  }

  function pruneSparklineRangeTokenDays(input: Record<string, number>) {
    return Object.fromEntries(
      Object.entries(input)
        .filter(([address]) => Boolean(String(address || '').trim()))
        .slice(-SPARKLINE_RANGE_TOKEN_OVERRIDE_MAX)
        .map(([address, days]) => [address, normalizeSparklineRangeDays(days)]),
    );
  }

  function normalizeSparklineRange(input: unknown): AppState['ui']['sparklineRange'] {
    const source = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Partial<UiPrefsPayload['sparklineRange']>
      : null;
    const defaults = createAppState().ui.sparklineRange;
    return {
      global: source?.global == null ? defaults.global : Boolean(source.global),
      globalDays: normalizeSparklineRangeDays(source?.globalDays, defaults.globalDays),
      monitoredDays: normalizeSparklineRangeDays(source?.monitoredDays, defaults.monitoredDays),
      recentDays: normalizeSparklineRangeDays(source?.recentDays, defaults.recentDays),
      oldWeekDays: normalizeSparklineRangeDays(source?.oldWeekDays, defaults.oldWeekDays),
      tokenDaysByAddress: normalizeSparklineRangeTokenDays(source?.tokenDaysByAddress),
    };
  }

  function buildUiPrefsPayload(): UiPrefsPayload {
    return {
      collapsed: {
        manual: Boolean(state.ui.collapsed.manual),
        recent: Boolean(state.ui.collapsed.recent),
        oldWeek: Boolean(state.ui.collapsed.oldWeek),
        monitored: Boolean(state.ui.collapsed.monitored),
        bidZone: Boolean(state.ui.collapsed.bidZone),
        pumpfun: Boolean(state.ui.collapsed.pumpfun),
      },
      manualStarredOnly: Boolean(state.ui.manualStarredOnly),
      manualFolderDeleteWarningDismissed: Boolean(state.ui.manualFolderDeleteWarningDismissed),
      recentStarredOnly: Boolean(state.ui.recentStarredOnly),
      oldWeekStarredOnly: Boolean(state.ui.oldWeekStarredOnly),
      chainFilters: state.ui.chainFilters,
      monitoredPerPage: normalizeUiPerPage(state.ui.monitoredPerPage, 30),
      recentPerPage: normalizeUiPerPage(state.ui.recentPerPage, ROUTED_BUCKET_DEFAULT_PER_PAGE),
      oldWeekPerPage: normalizeUiPerPage(state.ui.oldWeekPerPage, ROUTED_BUCKET_DEFAULT_PER_PAGE),
      manualSorts: [...state.ui.manualSorts],
      recentSorts: [...state.ui.recentSorts],
      oldWeekSorts: [...state.ui.oldWeekSorts],
      monitoredSorts: [...state.ui.monitoredSorts],
      expandedSparklineGranularityMinutes: preferredExpandedSparklineGranularityMinutes,
      expandedSparklineTimeZone: normalizeExpandedChartTimeZone(state.ui.expandedSparklineTimeZone),
      sparklineRange: {
        global: Boolean(state.ui.sparklineRange.global),
        globalDays: normalizeSparklineRangeDays(state.ui.sparklineRange.globalDays),
        monitoredDays: normalizeSparklineRangeDays(state.ui.sparklineRange.monitoredDays),
        recentDays: normalizeSparklineRangeDays(state.ui.sparklineRange.recentDays),
        oldWeekDays: normalizeSparklineRangeDays(state.ui.sparklineRange.oldWeekDays),
        tokenDaysByAddress: pruneSparklineRangeTokenDays(state.ui.sparklineRange.tokenDaysByAddress),
      },
      enabledTradeTerminals: [...state.ui.enabledTradeTerminals],
      livePanelLayout: {
        order: [...state.ui.livePanelLayout.order],
        spans: {
          monitored: state.ui.livePanelLayout.spans.monitored,
          pumpfun: 1,
          alerts: state.ui.livePanelLayout.spans.alerts,
        },
        heights: {
          monitored: state.ui.livePanelLayout.heights.monitored,
          alerts: state.ui.livePanelLayout.heights.alerts,
        },
      },
    };
  }
  function getConfigNumber(key: string, fallback: number) {
    const value = state.data.configs[key];
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function getMonitoredValuationFilters() {
    return {
      minMcap: Math.max(0, getConfigNumber(
        'monitored-mcap-min', DEFAULT_MONITORED_MIN_VALUATION_USD,
      )),
      minFdv: Math.max(0, getConfigNumber(
        'monitored-fdv-min', DEFAULT_MONITORED_MIN_VALUATION_USD,
      )),
    };
  }

  function isConfigEnabled(key: string, fallback = true) {
    return String(state.data.configs[key] ?? (fallback ? 'on' : 'off')) !== 'off';
  }

  function isGmgnClaimAlertEnabled(entry: Pick<AlertEntry, 'signalType'>) {
    if (entry.signalType === 17) {
      return isConfigEnabled('alert-gmgn-claim-bags-enabled');
    }
    if (entry.signalType === 18) {
      return isConfigEnabled('alert-gmgn-claim-pump-enabled');
    }
    return true;
  }

  function isAlertKindEnabled(kind: AlertEntry['kind'], entry?: Pick<AlertEntry, 'signalType'>) {
    switch (kind) {
      case 'monitored-vol':
        return isConfigEnabled('alert-vol-enabled');
      case 'monitored-mcap':
        return isConfigEnabled('alert-mcap-enabled');
      case 'monitored-fdv':
        return isConfigEnabled('alert-fdv-enabled', false);
      case 'hvnc':
        return isConfigEnabled('alert-hvnc-enabled');
      case 'meteora-surge':
        return isConfigEnabled('alert-meteora-surge-enabled');
      case 'gmgn-claim-signal':
        return isGmgnClaimAlertEnabled(entry || {});
      default:
        return true;
    }
  }

  function resolveBackendSurgeAlertEnabled(entry: Pick<AlertEntry, 'ruleKey' | 'surgeWindow' | 'ageBucket'>) {
    switch (entry.ruleKey) {
      case 'recent-surge-1h':
        return isConfigEnabled('alert-recent-surge-1h-enabled');
      case 'recent-surge-6h':
        return isConfigEnabled('alert-recent-surge-6h-enabled');
      case 'old-week-surge-1h':
        return isConfigEnabled('alert-old-week-surge-1h-enabled');
      case 'old-week-surge-6h':
        return isConfigEnabled('alert-old-week-surge-6h-enabled');
      case 'surge-continuation-6h':
        return isConfigEnabled(entry.ageBucket === 'recent'
          ? 'alert-recent-surge-6h-enabled'
          : 'alert-old-week-surge-6h-enabled');
      default:
        return isConfigEnabled(entry.surgeWindow === '6H' ? 'alert-old-surge-6h-enabled' : 'alert-old-surge-1h-enabled');
    }
  }

  function isAlertEntryEnabled(entry: Pick<AlertEntry, 'kind' | 'ruleKey' | 'surgeWindow' | 'signalType'>) {
    if (entry.kind === 'old-surge') {
      return resolveBackendSurgeAlertEnabled(entry);
    }

    return isAlertKindEnabled(entry.kind, entry);
  }

  function isCrossAlertBlocked(token: ManualTokenEntry, now: number) {
    return Boolean(token.lastAlertAt && now - token.lastAlertAt < CROSS_ALERT_BLOCK_MS);
  }

  function getStorageScope() {
    return state.session.email || state.session.username || 'anonymous';
  }

  function getMockTradingActiveWalletStorageKey() {
    return `frontend_vite:${getStorageScope()}:${MOCK_TRADING_ACTIVE_WALLET_KEY}`;
  }

  function loadPersistedMockTradingActiveWalletId() {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(getMockTradingActiveWalletStorageKey());
      if (raw == null) {
        return null;
      }
      const walletId = Number(raw);
      return Number.isInteger(walletId) && walletId > 0 ? walletId : null;
    } catch {
      return null;
    }
  }

  function persistMockTradingActiveWalletId(walletId: number | null) {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    try {
      const key = getMockTradingActiveWalletStorageKey();
      if (walletId == null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, String(walletId));
      }
    } catch {
      // Ignore local persistence failures.
    }
  }

  function hydrateSoundSettings() {
    const soundSettings = loadSoundSettings(getStorageScope());
    state.ui.soundEnabled = soundSettings.enabled;
    state.ui.soundVolume = soundSettings.volume;
  }

  function persistSoundSettings() {
    saveSoundSettings(getStorageScope(), {
      enabled: state.ui.soundEnabled,
      volume: state.ui.soundVolume,
    });
  }

  function hydrateBrowserNotificationSettings() {
    const settings = loadBrowserNotificationSettings(getStorageScope());
    const permission = getBrowserNotificationStatus();
    state.ui.browserNotifications = {
      enabled: settings.enabled && permission === 'granted',
      permission,
      notifyWhenVisible: settings.notifyWhenVisible,
    };
  }

  function persistBrowserNotificationSettings() {
    saveBrowserNotificationSettings(getStorageScope(), {
      enabled: state.ui.browserNotifications.enabled,
      notifyWhenVisible: state.ui.browserNotifications.notifyWhenVisible,
    });
  }

  async function persistUiPrefs(snapshot: UiPrefsPayload, revision: number) {
    const token = state.session.token;
    if (!token) {
      return;
    }

    try {
      const result = await patchUiPrefs(snapshot, token);
      if (revision === uiPrefsPersistRevision) {
        applyUiPreferences(result.uiPrefs);
        emit();
      }
    } catch (error) {
      if (revision === uiPrefsPersistRevision) {
        setError(error instanceof Error ? error.message : 'Failed to persist UI preferences');
        emit();
      }
    }
  }

  async function persistUiConfigs(configs: Record<string, string | number>) {
    const token = state.session.token;
    if (!token) {
      return;
    }

    try {
      const result = await patchConfig(configs, token);
      state.data.configs = { ...state.data.configs, ...result.configs };
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to persist UI config');
      emit();
    }
  }

  function shouldShowBlockedTokenWarning() {
    return String(state.data.configs[BLOCK_WARNING_ENABLED_CONFIG_KEY] || 'on').trim().toLowerCase() !== 'off';
  }

  function replaceStarredTokens(nextStarredTokens: string[], options?: { resetRevision?: boolean }) {
    const normalized = normalizeStoredTokenIdentityKeys(nextStarredTokens)
      .sort((a, b) => a.localeCompare(b));
    const current = state.data.starredTokenIdentities;
    const changed = current.length !== normalized.length
      || current.some((item, index) => item !== normalized[index]);

    state.data.starredTokenIdentities = normalized;

    if (options?.resetRevision) {
      state.runtime.starredRevision = 0;
      return;
    }

    if (changed) {
      state.runtime.starredRevision += 1;
    }
  }

  function openBlockedTokenWarning(address: string, label?: string | null, chain: TokenChain = 'solana') {
    const warning = normalizeBlockWarningState(address, label, chain);
    if (!warning) {
      return false;
    }

    state.ui.blockTokenWarning = warning;
    emit('overlay');
    return true;
  }

  function clearBlockedTokenWarning() {
    if (!state.ui.blockTokenWarning) {
      return;
    }

    state.ui.blockTokenWarning = null;
    emit('overlay');
  }

  async function finalizeBlockedTokenWarning() {
    const warning = state.ui.blockTokenWarning;
    if (!warning) {
      return null;
    }

    clearBlockedTokenWarning();

    if (warning.dontShowAgain) {
      await persistUiConfigs({ [BLOCK_WARNING_ENABLED_CONFIG_KEY]: 'off' });
    }

    return warning;
  }

  async function addBlockedTokenInternal(
    address: string,
    label?: string | null,
    chain: TokenChain = 'solana',
  ) {
    const token = state.session.token;
    if (!token) {
      setError('No authenticated session');
      emit();
      return;
    }

    setBusy(true);
    setError(null);
    setNotice('Blocking token...');
    emit();

    try {
      const result = await addBlockedTokenRequest(chain, address, label, token);
      if (!isBlocked(address, chain)) {
        state.data.blocklist = sortAddresses([
          ...state.data.blocklist, { chain, address, label: label ?? null },
        ]);
        state.bars.blocklist = state.data.blocklist.length;
      }
      removeTokenEverywhere(address, { chain });
      applyBlockedFilters();
      await reloadConfigInternal(token);
      setNotice(result.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to block token');
    } finally {
      setBusy(false);
      emit();
    }
  }

  function queueUiPrefsPersist() {
    uiPrefsPersistRevision += 1;
    const revision = uiPrefsPersistRevision;
    const snapshot = buildUiPrefsPayload();

    if (uiPrefsPersistTimer) {
      clearTimeout(uiPrefsPersistTimer);
    }

    uiPrefsPersistTimer = setTimeout(() => {
      uiPrefsPersistTimer = null;
      void persistUiPrefs(snapshot, revision);
    }, 120);
  }

  function applyCollapsedUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    const defaults = getDefaultCollapsedSections();
    const collapsed = uiPrefs?.collapsed || defaults;
    state.ui.collapsed = {
      ...defaults,
      manual: Boolean(collapsed.manual),
      recent: Boolean(collapsed.recent),
      oldWeek: Boolean(collapsed.oldWeek),
      monitored: Boolean(collapsed.monitored),
      bidZone: Boolean(collapsed.bidZone),
      pumpfun: Boolean(collapsed.pumpfun),
    };
  }

  function applyPaginationUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    state.ui.monitoredPerPage = normalizeUiPerPage(uiPrefs?.monitoredPerPage, 30);
    state.ui.recentPerPage = normalizeUiPerPage(
      uiPrefs?.recentPerPage,
      getConfigNumber('old-per-page', state.ui.recentPerPage || ROUTED_BUCKET_DEFAULT_PER_PAGE),
    );
    state.ui.oldWeekPerPage = normalizeUiPerPage(
      uiPrefs?.oldWeekPerPage,
      getConfigNumber('old-week-per-page', state.ui.oldWeekPerPage || ROUTED_BUCKET_DEFAULT_PER_PAGE),
    );
  }

  function applySortUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    state.ui.manualSorts = normalizeBucketSorts(uiPrefs?.manualSorts, 'manual');
    state.ui.recentSorts = normalizeBucketSorts(uiPrefs?.recentSorts, 'recent');
    state.ui.oldWeekSorts = normalizeBucketSorts(uiPrefs?.oldWeekSorts, 'old-week');
    state.ui.monitoredSorts = normalizeMonitoredSorts(uiPrefs?.monitoredSorts);
  }

  function applyUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    applyCollapsedUiPreferences(uiPrefs);
    state.ui.manualStarredOnly = Boolean(uiPrefs?.manualStarredOnly);
    state.ui.manualFolderDeleteWarningDismissed = Boolean(uiPrefs?.manualFolderDeleteWarningDismissed);
    state.ui.recentStarredOnly = Boolean(uiPrefs?.recentStarredOnly);
    state.ui.oldWeekStarredOnly = Boolean(uiPrefs?.oldWeekStarredOnly);
    state.ui.chainFilters = normalizeChainFilterPreferences(
      uiPrefs?.chainFilters,
      state.data.availableChains,
    );
    applyPaginationUiPreferences(uiPrefs);
    applySortUiPreferences(uiPrefs);
    applyExpandedSparklineUiPreferences(uiPrefs);
    state.ui.sparklineRange = normalizeSparklineRange(uiPrefs?.sparklineRange);
    state.ui.enabledTradeTerminals = normalizeTradeTerminals(uiPrefs?.enabledTradeTerminals);
    state.ui.livePanelLayout = normalizeLivePanelLayout(uiPrefs?.livePanelLayout);
    syncRoutedPagination();
  }

  function applyUiPreferencesFromConfigs() {
    state.ui.soundEnabled = String(state.data.configs['sound-mode'] ?? 'on') !== 'off';
    state.ui.soundVolume = clampUiVolume(getConfigNumber('sound-volume', Math.round(state.ui.soundVolume * 100)) / 100);
  }

  function ensureAlertsPersistLifecycle() {
    if (alertsPersistLifecycleBound || typeof window === 'undefined') {
      return;
    }

    alertsPersistLifecycleBound = true;
    window.addEventListener('pagehide', () => {
      flushAlertsPersist();
    });
  }

  function getActiveAlertIdSet() {
    return new Set(
      state.data.alerts
        .map((item) => String(item.id || '').trim())
        .filter(Boolean),
    );
  }

  function pruneAlertSparklineCache() {
    const activeAlertIds = getActiveAlertIdSet();
    const nextCache: Record<string, TokenSparklineEntry> = {};
    let changed = false;

    for (const [alertId, entry] of Object.entries(state.data.alertSparklineById)) {
      if (!activeAlertIds.has(alertId)) {
        changed = true;
        continue;
      }
      nextCache[alertId] = entry;
    }

    if (!changed && Object.keys(nextCache).length === Object.keys(state.data.alertSparklineById).length) {
      return false;
    }

    state.data.alertSparklineById = nextCache;
    return true;
  }

  function flushAlertsPersist() {
    if (alertsPersistTimer) {
      clearTimeout(alertsPersistTimer);
      alertsPersistTimer = null;
    }

    const scope = alertsPersistScope ?? getStorageScope();
    alertsPersistScope = null;
    saveAlerts(scope, state.data.alerts);
    saveAlertSparklineCache(scope, state.data.alertSparklineById);
    recordAlertDebug('persist.flush', {
      scope,
      saved: summarizeAlertDebug(),
      sparklineCacheCount: Object.keys(state.data.alertSparklineById).length,
    });
  }

  function scheduleAlertsPersist() {
    if (typeof window === 'undefined') {
      flushAlertsPersist();
      return;
    }

    ensureAlertsPersistLifecycle();
    if (alertsPersistTimer) {
      return;
    }

    alertsPersistScope = getStorageScope();
    alertsPersistTimer = window.setTimeout(() => {
      alertsPersistTimer = null;
      flushAlertsPersist();
    }, ALERT_STORAGE_DEBOUNCE_MS);
  }

  function persistBarStorage() {
    const scope = getStorageScope();
    saveDismissedRecent(scope, state.data.dismissedRecentIdentities);
    saveDismissedOldWeek(scope, state.data.dismissedOldWeekIdentities);
    clearRecentRemovalLogStorage(scope);
    clearOldWeekRemovalLogStorage(scope);
    flushAlertsPersist();
  }

  function hydrateBarStorage() {
    const scope = getStorageScope();
    const beforeAlerts = state.data.alerts.slice();
    state.data.dismissedRecentIdentities = normalizeStoredHistoryIdentities(loadDismissedRecent(scope));
    state.data.dismissedOldWeekIdentities = normalizeStoredHistoryIdentities(loadDismissedOldWeek(scope));
    clearRecentRemovalLogStorage(scope);
    clearOldWeekRemovalLogStorage(scope);
    state.data.alerts = loadAlerts(scope);
    state.data.alertSparklineById = loadAlertSparklineCache(scope);
    pruneAlertSparklineCache();
    state.runtime.alerts = state.data.alerts.length;
    state.runtime.alertRevision = state.data.alerts.length > 0 ? 1 : 0;
    state.panels.alerts = state.data.alerts.length;
    syncAlertPagination();
    queueMissingAlertSparklineRefresh();
    recordAlertMutationDebug('hydrate.local-storage', beforeAlerts, {
      scope,
      loaded: summarizeAlertDebug(state.data.alerts),
      sparklineCacheCount: Object.keys(state.data.alertSparklineById).length,
    });
  }

  function isBlocked(address: string, chain: TokenChain = 'solana') {
    const identityKey = getTrackedTokenKey(address, chain);
    return state.data.blocklist.some((item) => (
      getTrackedTokenKey(item.address, item.chain || 'solana') === identityKey
    ));
  }

  function syncAlertState() {
    pruneAlertSparklineCache();
    syncAlertPagination();
    state.runtime.alerts = state.data.alerts.length;
    state.runtime.alertRevision += 1;
    state.panels.alerts = state.data.alerts.length;
    scheduleAlertsPersist();
  }

  function removeAlertsForAddress(address: string, chain: TokenChain = 'solana') {
    const beforeAlerts = state.data.alerts.slice();
    state.data.alerts = state.data.alerts.filter((item) => (
      item.address !== address || item.chain !== chain
    ));
    syncAlertState();
    recordAlertMutationDebug('remove.address', beforeAlerts, { address });
  }

  function captureRemovedTokenSnapshot(address: string) {
    const trackedToken = getTrackedToken(state, address);
    const identityKey = getTrackedTokenKey(address);
    return {
      address,
      trackedToken: trackedToken ? { ...trackedToken } : null,
      identityKey,
      wasInMonitored: state.data.monitoredTokenIdentities.includes(identityKey),
      wasPinnedMonitored: state.data.pinnedMonitoredTokenIdentities.includes(identityKey),
      wasInManual: state.data.manualTokenIdentities.includes(identityKey),
      wasEligibleCatalog: state.data.eligibleCatalogTokens.includes(address),
      removedPumpTokens: state.data.pumpTokens
        .filter((item) => item.mint === address || item.mintAddress === address)
        .map((item) => ({ ...item })),
      removedRecentPumpMigrations: state.data.recentPumpMigrations
        .filter((item) => item.mint === address)
        .map((item) => ({ ...item })),
      removedAlerts: state.data.alerts
        .filter((item) => item.address === address)
        .map((item) => ({ ...item })),
      removedAlertSparklines: Object.fromEntries(
        state.data.alerts
          .filter((item) => item.address === address)
          .map((item) => [item.id, state.data.alertSparklineById[item.id]])
          .filter((entry): entry is [string, TokenSparklineEntry] => Boolean(entry[0] && entry[1])),
      ),
      wasDismissedRecent: state.data.dismissedRecentIdentities.includes(getTrackedTokenKey(address)),
      wasDismissedOldWeek: state.data.dismissedOldWeekIdentities.includes(getTrackedTokenKey(address)),
      wasStarred: state.data.starredTokenIdentities.includes(identityKey),
    };
  }

  function restoreTrackedTokenCollections(snapshot: ReturnType<typeof captureRemovedTokenSnapshot>) {
    const { address, identityKey } = snapshot;

    if (snapshot.trackedToken && !getTrackedToken(state, address)) {
      setTrackedToken(snapshot.trackedToken);
    }

    if (snapshot.wasInMonitored && !state.data.monitoredTokenIdentities.includes(identityKey)) {
      state.data.monitoredTokenIdentities = [...state.data.monitoredTokenIdentities, identityKey];
    }

    if (snapshot.wasPinnedMonitored && !state.data.pinnedMonitoredTokenIdentities.includes(identityKey)) {
      state.data.pinnedMonitoredTokenIdentities = [...state.data.pinnedMonitoredTokenIdentities, identityKey];
    }

    if (snapshot.wasInManual && !state.data.manualTokenIdentities.includes(identityKey)) {
      state.data.manualTokenIdentities = [...state.data.manualTokenIdentities, identityKey];
    }

    if (snapshot.wasEligibleCatalog && !state.data.eligibleCatalogTokens.includes(address)) {
      state.data.eligibleCatalogTokens = [...state.data.eligibleCatalogTokens, address]
        .sort((a, b) => a.localeCompare(b));
    }
  }

  function restorePumpAndAlertCollections(snapshot: ReturnType<typeof captureRemovedTokenSnapshot>) {
    const { address } = snapshot;
    const beforeAlerts = state.data.alerts.slice();

    for (const item of snapshot.removedPumpTokens) {
      const exists = state.data.pumpTokens.some((current) => current.mint === item.mint);
      if (!exists) {
        state.data.pumpTokens = [...state.data.pumpTokens, item];
      }
    }

    for (const item of snapshot.removedRecentPumpMigrations) {
      const exists = state.data.recentPumpMigrations.some((current) => current.mint === item.mint);
      if (!exists) {
        state.data.recentPumpMigrations = [...state.data.recentPumpMigrations, item];
      }
    }

    for (const item of snapshot.removedAlerts) {
      const exists = state.data.alerts.some((current) => current.id === item.id);
      if (!exists) {
        state.data.alerts = [...state.data.alerts, item];
      }
    }

    for (const [alertId, entry] of Object.entries(snapshot.removedAlertSparklines || {})) {
      if (!state.data.alertSparklineById[alertId]) {
        state.data.alertSparklineById[alertId] = entry;
      }
    }
    syncAlertState();
    recordAlertMutationDebug('restore.removed-token-snapshot', beforeAlerts, {
      address,
      restoredAlerts: snapshot.removedAlerts.length,
    });

    const identityKey = getTrackedTokenKey(address);
    if (snapshot.wasDismissedRecent && !state.data.dismissedRecentIdentities.includes(identityKey)) {
      state.data.dismissedRecentIdentities = [...state.data.dismissedRecentIdentities, identityKey];
    }

    if (snapshot.wasDismissedOldWeek && !state.data.dismissedOldWeekIdentities.includes(identityKey)) {
      state.data.dismissedOldWeekIdentities = [...state.data.dismissedOldWeekIdentities, identityKey];
    }
  }

  function restoreRemovedTokenSnapshot(snapshot: ReturnType<typeof captureRemovedTokenSnapshot>) {
    restoreTrackedTokenCollections(snapshot);
    restorePumpAndAlertCollections(snapshot);

    if (snapshot.wasStarred && !state.data.starredTokenIdentities.includes(snapshot.identityKey)) {
      replaceStarredTokens([...state.data.starredTokenIdentities, snapshot.identityKey]);
    }

    state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
    state.bars.manual = state.data.manualTokenIdentities.length;
    deriveAgeBuckets();
    refreshTrackedTokenStore();
    refreshMonitoredPanelCounts();
    refreshPumpPanelCounts();
    persistBarStorage();
  }

  function removeTokenEverywhere(
    address: string,
    options: { removeFromStarred?: boolean; chain?: TokenChain } = {},
  ) {
    const chain = options.chain || 'solana';
    const identityKey = getTrackedTokenKey(address, chain);
    state.data.monitoredTokenIdentities = state.data.monitoredTokenIdentities.filter((item) => item !== identityKey);
    state.data.pinnedMonitoredTokenIdentities = state.data.pinnedMonitoredTokenIdentities.filter((item) => item !== identityKey);
    state.data.manualTokenIdentities = state.data.manualTokenIdentities.filter((item) => item !== identityKey);
    state.data.recentTokenIdentities = state.data.recentTokenIdentities.filter((item) => item !== identityKey);
    state.data.oldWeekTokenIdentities = state.data.oldWeekTokenIdentities.filter((item) => item !== identityKey);
    deleteTrackedToken(address, chain);
    if (chain === 'solana') {
      state.data.eligibleCatalogTokens = state.data.eligibleCatalogTokens.filter((item) => item !== address);
      state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== address && item.mintAddress !== address);
      state.data.recentPumpMigrations = state.data.recentPumpMigrations.filter((item) => item.mint !== address);
    }
    state.data.dismissedRecentIdentities = state.data.dismissedRecentIdentities.filter((item) => item !== identityKey);
    state.data.dismissedOldWeekIdentities = state.data.dismissedOldWeekIdentities.filter((item) => item !== identityKey);
    removeAlertsForAddress(address, chain);

    if (options.removeFromStarred && state.data.starredTokenIdentities.includes(identityKey)) {
      replaceStarredTokens(state.data.starredTokenIdentities.filter((item) => item !== identityKey));
    }

    state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
    state.bars.manual = state.data.manualTokenIdentities.length;
    deriveAgeBuckets();
    refreshTrackedTokenStore();
    refreshMonitoredPanelCounts();
    refreshPumpPanelCounts();
    persistBarStorage();
  }

  function clearPumpWorkspaceState() {
    state.pumpfun.connected = false;
    state.pumpfun.statusLabel = 'disconnected';
    state.pumpfun.solPriceUsd = null;
    state.pumpfun.migrationCount = 0;
    state.data.pumpTokens = [];
    state.data.recentPumpMigrations = [];
    state.data.pumpToasts = [];
    refreshPumpPanelCounts();
  }

  function isVisibleMonitoredToken(item: ManualTokenEntry) {
    if (item._userManual) {
      return true;
    }

    const mcap = item.mcap ?? 0;
    return !(mcap > 0 && mcap < 30000);
  }

  function refreshMonitoredPanelCounts() {
    const visibleCount = getVisibleMonitoredTokens().length;
    state.panels.monitored = visibleCount;
    state.panels.bidZone = state.data.bidZoneTokens.length;
    state.panels.alerts = state.data.alerts.length;
    state.runtime.alerts = state.data.alerts.length;
    syncMonitoredPagination();
  }

  function normalizeBucketMetricWindow(window: string | undefined): '1h' | '6h' | '24h' {
    return window === '1h' || window === '6h' || window === '24h' ? window : '24h';
  }

  function normalizeBucketAgeWindow(window: string | undefined): 'newest' | 'oldest' {
    return window === 'oldest' ? 'oldest' : 'newest';
  }

  function normalizeMonitoredVolWindow(window: string | undefined): '5m' | '1h' | '6h' | '24h' {
    return window === '1h' || window === '6h' || window === '24h' ? window : '5m';
  }

  function normalizeMcapWindow(window: string | undefined): 'highest' | 'lowest' {
    return window === 'lowest' ? 'lowest' : 'highest';
  }

  function getDefaultBucketSorts(scope: 'manual' | 'recent' | 'old-week'): BucketSortCriterion[] {
    if (scope === 'manual') {
      return [{ mode: 'mcap', window: 'highest' }];
    }
    return [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }];
  }

  function getDefaultMonitoredSorts(): MonitoredSortCriterion[] {
    return [{ mode: 'vol', window: '5m' }];
  }

  function toggleSortCriterion<T extends { mode: string; window: string }>(current: T[], next: T): T[] {
    const exists = current.some((item) => item.mode === next.mode && item.window === next.window);
    if (exists) {
      return current.filter((item) => !(item.mode === next.mode && item.window === next.window));
    }
    if (next.mode === 'mcap' || next.mode === 'age') {
      return [next, ...current.filter((item) => item.mode !== next.mode)];
    }
    return [next, ...current];
  }

  function normalizeBucketCriterion(mode: BucketSortMode, window?: BucketSortWindow): BucketSortCriterion {
    if (mode === 'age') {
      return { mode, window: normalizeBucketAgeWindow(window) };
    }
    if (mode === 'mcap') {
      return { mode, window: normalizeMcapWindow(window) };
    }
    return { mode, window: normalizeBucketMetricWindow(window) };
  }

  function normalizeMonitoredCriterion(mode: MonitoredSortMode, window?: MonitoredSortWindow): MonitoredSortCriterion {
    if (mode === 'age') {
      return { mode, window: normalizeBucketAgeWindow(window) };
    }
    if (mode === 'mcap') {
      return { mode, window: normalizeMcapWindow(window) };
    }
    return { mode, window: normalizeMonitoredVolWindow(window) };
  }

  function isHotlinkBlockedPumpImageUrl(url: string | null | undefined) {
    try {
      return new URL(String(url || '').trim()).hostname.toLowerCase() === 'metadata.j7tracker.io';
    } catch (_) {
      return false;
    }
  }

  function toHttpAssetUrl(url: string | null | undefined) {
    const value = String(url || '').trim();
    if (!value) {
      return null;
    }
    const normalized = value.startsWith('ipfs://')
      ? `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}`
      : value;

    if (isHotlinkBlockedPumpImageUrl(normalized)) {
      return null;
    }

    return normalized;
  }

  function getPumpVisibleTokens() {
    return [];
  }

  function refreshPumpPanelCounts() {
    state.panels.pumpfun = getPumpVisibleTokens().length;
  }

  function getPumpVolume5mTotal(token: PumpTokenEntry) {
    return (token.vol5m || []).reduce((sum, point) => sum + point.usd, 0);
  }

  function prunePumpTokenWindow(token: PumpTokenEntry, now: number) {
    if (!Array.isArray(token.vol5m) || token.vol5m.length === 0) {
      token.vol5m = [];
      return;
    }

    const cutoff = now - PUMP_WINDOW_MS;
    let keepFromIndex = 0;
    while (keepFromIndex < token.vol5m.length && token.vol5m[keepFromIndex].ts < cutoff) {
      keepFromIndex += 1;
    }

    if (keepFromIndex > 0) {
      token.vol5m.splice(0, keepFromIndex);
    }

    const maxBuckets = Math.ceil(PUMP_WINDOW_MS / PUMP_VOLUME_BUCKET_MS) + 2;
    if (token.vol5m.length > maxBuckets) {
      token.vol5m.splice(0, token.vol5m.length - maxBuckets);
    }
  }

  function appendPumpVolumeBucket(token: PumpTokenEntry, usdAmount: number, now: number) {
    if (!(usdAmount > 0)) {
      prunePumpTokenWindow(token, now);
      return;
    }

    if (!Array.isArray(token.vol5m)) {
      token.vol5m = [];
    }

    const bucketTs = Math.floor(now / PUMP_VOLUME_BUCKET_MS) * PUMP_VOLUME_BUCKET_MS;
    const lastBucket = token.vol5m[token.vol5m.length - 1];

    if (lastBucket && lastBucket.ts === bucketTs) {
      lastBucket.usd += usdAmount;
    } else {
      token.vol5m.push({ ts: bucketTs, usd: usdAmount });
    }

    prunePumpTokenWindow(token, now);
  }

  function maybePersistPumpBondTarget(nextTarget: number) {
    if (!(nextTarget > 0)) {
      return;
    }
    state.pumpfun.bondTargetMcap = nextTarget;
  }

  function dismissPumpToast(id: string) {
    state.data.pumpToasts = state.data.pumpToasts.filter((item) => item.id !== id);
  }

  function _shouldSurfacePumpMigration(token: Pick<PumpTokenEntry, 'mcap'>) {
    return Number(token?.mcap || 0) >= PUMP_SILENCE_MIGRATION_MIN_MCAP;
  }

  function enqueuePumpToast(token: PumpTokenEntry) {
    const toastId = `${token.mint}-${Date.now()}`;
    state.data.pumpToasts = [{
      id: toastId,
      mint: token.mint,
      symbol: token.symbol || token.mint.slice(0, 6),
      imageUrl: token.imageUrl || null,
      createdAt: token.createdAt ?? null,
      migratedAt: Date.now(),
      mcap: token.mcap ?? null,
      vol5m: getPumpVolume5mTotal(token),
      volTotal: token.volTotal ?? null,
    }, ...state.data.pumpToasts].slice(0, 6);
    window.setTimeout(() => {
      dismissPumpToast(toastId);
      emit();
    }, PUMP_TOAST_TTL_MS);
  }

  function _hasRecordedPumpMigration(mint: string) {
    return state.data.recentPumpMigrations.some((entry) => entry.mint === mint)
      || state.data.pumpToasts.some((entry) => entry.mint === mint);
  }

  function resolvePumpMigrationText(
    primary: string | null | undefined,
    fallback: unknown,
  ) {
    return primary ?? (String(fallback || '').trim() || null);
  }

  function createEmptyPumpMigrationToken(mint: string): PumpTokenEntry {
    return {
      mint,
      mintAddress: mint,
      pairAddress: null,
      metadataUri: null,
      name: null,
      symbol: null,
      imageUrl: null,
      twitterUrl: null,
      communityUrl: null,
      pairUrl: null,
      createdAt: null,
      lastTradeAt: null,
      mcap: null,
      volTotal: 0,
      vol5m: [],
      _alertFired: false,
      _hvncPumpFired: false,
      _migrated: true,
      _lowMcapSince: null,
      bondingCurveKey: null,
      vTokensInBondingCurve: null,
      virtualSolReserves: null,
      hidden: false,
      _imageResolved: false,
      _imageResolving: false,
    };
  }

  function _buildPumpMigrationTokenFromPayload(payload: Record<string, unknown>, existingToken?: PumpTokenEntry | null): PumpTokenEntry | null {
    const mint = String(payload.mint || existingToken?.mint || '').trim();
    if (!mint) {
      return null;
    }

    const token = existingToken
      ? { ...existingToken, mint }
      : createEmptyPumpMigrationToken(mint);

    token.mintAddress = token.mintAddress ?? mint;
    token.pairAddress = resolvePumpMigrationText(token.pairAddress, payload.pool || payload.pairAddress);
    token.name = resolvePumpMigrationText(token.name, payload.name);
    token.symbol = resolvePumpMigrationText(token.symbol, payload.symbol);
    token.imageUrl = resolvePumpMigrationText(token.imageUrl, payload.image);
    token.twitterUrl = resolvePumpMigrationText(token.twitterUrl, payload.twitter);
    token._migrated = true;

    return token;
  }

  function runPumpGarbageCollection() {
    const now = Date.now();
    const removed = new Set<string>();
    let migratedBySilence = 0;
    const removedByMigratedFlag: string[] = [];
    const removedBySilenceMigration: string[] = [];
    const removedByInactiveTooLong: string[] = [];
    const removedByLowMcapTooLong: string[] = [];

    state.data.pumpTokens = state.data.pumpTokens.filter((token) => {
      prunePumpTokenWindow(token, now);

      if (token._migrated) {
        removed.add(token.mint);
        removedByMigratedFlag.push(token.mint);
        return false;
      }

      const lastTradeAt = token.lastTradeAt || token.createdAt || 0;
      const mcap = token.mcap ?? 0;
      const silenceSuggestsMigration = lastTradeAt > 0
        && now - lastTradeAt >= PUMP_SILENCE_MIGRATION_MS
        && mcap >= PUMP_SILENCE_MIGRATION_MIN_MCAP
        && Boolean(token.symbol)
        && Boolean(token.createdAt);

      if (silenceSuggestsMigration) {
        token._migrated = true;
        recordPumpMigration(token);
        enqueuePumpToast(token);
        if (!token.imageUrl) {
          void resolvePumpMigrationMetadata(token.mint);
        }
        removed.add(token.mint);
        migratedBySilence += 1;
        removedBySilenceMigration.push(token.mint);
        return false;
      }

      const inactiveTooLong = lastTradeAt > 0 && now - lastTradeAt >= PUMP_GC_INACTIVE_MS;

      if (mcap > 0 && mcap < PUMP_GC_LOW_MCAP) {
        token._lowMcapSince = token._lowMcapSince || now;
      } else {
        token._lowMcapSince = null;
      }

      const lowMcapTooLong = Boolean(token._lowMcapSince && now - token._lowMcapSince >= PUMP_GC_LOW_MCAP_TIME_MS);
      if (inactiveTooLong) {
        removed.add(token.mint);
        removedByInactiveTooLong.push(token.mint);
        return false;
      }

      if (lowMcapTooLong) {
        removed.add(token.mint);
        removedByLowMcapTooLong.push(token.mint);
        return false;
      }

      return true;
    });

    for (const mint of removed) {
      unsubscribePumpMint(mint);
    }

    if (removed.size > 0) {
      console.info('[PumpGC] Removed tokens', {
        totalRemoved: removed.size,
        migratedFlag: removedByMigratedFlag.length,
        silenceMigration: removedBySilenceMigration.length,
        inactiveTooLong: removedByInactiveTooLong.length,
        lowMcapTooLong: removedByLowMcapTooLong.length,
        samples: {
          migratedFlag: removedByMigratedFlag.slice(0, 5),
          silenceMigration: removedBySilenceMigration.slice(0, 5),
          inactiveTooLong: removedByInactiveTooLong.slice(0, 5),
          lowMcapTooLong: removedByLowMcapTooLong.slice(0, 5),
        },
      });
      refreshPumpPanelCounts();
      setNotice(migratedBySilence > 0 ? `Pump detected ${migratedBySilence} migration(s) by silence and removed ${removed.size} token(s).` : `Pump GC removed ${removed.size} token(s).`);
    }
  }

  function recordPumpMigration(token: PumpTokenEntry) {
    const vol5m = getPumpVolume5mTotal(token);
    state.pumpfun.migrationCount += 1;
    state.data.recentPumpMigrations = [{
      mint: token.mint,
      symbol: token.symbol || token.mint.slice(0, 6),
      imageUrl: token.imageUrl || null,
      createdAt: token.createdAt ?? null,
      migratedAt: Date.now(),
      mcap: token.mcap ?? null,
      vol5m,
      volTotal: token.volTotal ?? null,
    }, ...state.data.recentPumpMigrations].slice(0, 12);

    const samples = state.data.recentPumpMigrations
      .map((entry) => entry.mcap)
      .filter((value): value is number => value != null && value > 0)
      .slice(0, 3);

    if (samples.length > 0 && (state.pumpfun.migrationCount === 1 || ((state.pumpfun.migrationCount - 1) % 3 === 0))) {
      const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      maybePersistPumpBondTarget(average);
    }
  }

  const resolvingPumpMigrationMetadata = new Set<string>();

  function getPendingPumpMigrationVisualState(mint: string) {
    const migrationEntry = state.data.recentPumpMigrations.find((entry) => entry.mint === mint) || null;
    const toastEntry = state.data.pumpToasts.find((entry) => entry.mint === mint) || null;
    return {
      existingSymbol: migrationEntry?.symbol || toastEntry?.symbol || null,
      existingImageUrl: migrationEntry?.imageUrl || toastEntry?.imageUrl || null,
    };
  }

  function applyResolvedPumpMigrationVisuals(mint: string, symbol: string | null, imageUrl: string | null) {
    state.data.recentPumpMigrations = state.data.recentPumpMigrations.map((entry) => entry.mint === mint
      ? {
        ...entry,
        symbol: symbol || entry.symbol,
        imageUrl: imageUrl || entry.imageUrl || null,
      }
      : entry);
    state.data.pumpToasts = state.data.pumpToasts.map((entry) => entry.mint === mint
      ? {
        ...entry,
        symbol: symbol || entry.symbol,
        imageUrl: imageUrl || entry.imageUrl || null,
      }
      : entry);
  }

  async function resolvePumpMigrationMetadata(mint: string) {
    const sessionToken = state.session.token;
    if (!sessionToken || resolvingPumpMigrationMetadata.has(mint)) {
      return;
    }

    const { existingSymbol, existingImageUrl } = getPendingPumpMigrationVisualState(mint);
    if (existingSymbol && existingImageUrl) {
      return;
    }

    resolvingPumpMigrationMetadata.add(mint);
    try {
      const data = await fetchPumpfunTokenMeta(mint, sessionToken, null);
      const resolvedSymbol = String(data?.symbol || '').trim() || existingSymbol;
      const resolvedImageUrl = toHttpAssetUrl(data?.imageUrl) || existingImageUrl;
      if (!resolvedSymbol && !resolvedImageUrl) {
        return;
      }

      applyResolvedPumpMigrationVisuals(mint, resolvedSymbol, resolvedImageUrl);
      cancelScheduledPumpfunEmit();
      emit('pumpfun', 'toasts');
    } catch (_) {
      // Keep fallback placeholders when metadata lookup fails.
    } finally {
      resolvingPumpMigrationMetadata.delete(mint);
    }
  }

  function _reportPumpMigration(token: PumpTokenEntry) {
    const sessionToken = state.session.token;
    if (!sessionToken) {
      return;
    }

    void reportMigratedToken({
      address: token.mint,
      symbol: token.symbol || null,
      name: token.name || null,
      tokenCreatedAt: token.createdAt ?? null,
      mcap: token.mcap ?? null,
      imageUrl: token.imageUrl || null,
      twitterUrl: token.twitterUrl || null,
      pairUrl: token.pairUrl || null,
    }, sessionToken).catch(() => {
      setError('Failed to report PumpFun migration to backend catalog');
      emit();
    });
  }

  function maybeFirePumpAlert(token: PumpTokenEntry) {
    void token;
  }

  async function resolvePumpTokenImage(mint: string) {
    const token = state.data.pumpTokens.find((item) => item.mint === mint);
    const sessionToken = state.session.token;
    if (!token || !sessionToken || token.imageUrl || token._imageResolved || token._imageResolving) {
      return;
    }

    token._imageResolving = true;
    schedulePumpfunEmit('pumpfun');

    try {
      const timeout = window.setTimeout(() => {
        state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
          ? { ...item, _imageResolved: true, _imageResolving: false }
          : item);
        schedulePumpfunEmit('pumpfun');
      }, PUMP_IMAGE_TIMEOUT_MS);

      try {
        const data = await fetchPumpfunTokenMeta(mint, sessionToken, token.metadataUri || null);
        const resolvedImageUrl = toHttpAssetUrl(data?.imageUrl);
        if (!resolvedImageUrl) {
          return;
        }

        state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
          ? { ...item, imageUrl: resolvedImageUrl, _imageResolved: true, _imageResolving: false }
          : item);
        schedulePumpfunEmit('pumpfun');
      } finally {
        clearTimeout(timeout);
      }
    } catch (_) {
      // Keep the placeholder avatar if runtime image resolution fails.
    } finally {
      state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
        ? { ...item, _imageResolved: true, _imageResolving: false }
        : item);
      schedulePumpfunEmit('pumpfun');
    }
  }

  function readPumpRawString(raw: Record<string, unknown>, key: string) {
    const value = raw[key];
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed || null;
  }

  function buildInitialPumpToken(raw: Record<string, unknown>, mint: string, now: number): PumpTokenEntry {
    const pairAddress = readPumpRawString(raw, 'pairAddress');
    const metadataUri = readPumpRawString(raw, 'uri');
    const imageUrl = readPumpRawString(raw, 'image');
    return {
      mint,
      mintAddress: mint,
      pairAddress,
      metadataUri,
      name: String(raw.name || mint.slice(0, 8)),
      symbol: String(raw.symbol || mint.slice(0, 6)),
      imageUrl: imageUrl ? toHttpAssetUrl(imageUrl) : null,
      createdAt: now,
      mcap: null,
      volTotal: 0,
      vol5m: [],
      hidden: false,
      _imageResolved: false,
      _imageResolving: false,
    };
  }

  function syncPumpTokenIdentity(token: PumpTokenEntry, raw: Record<string, unknown>, mint: string, now: number) {
    const name = readPumpRawString(raw, 'name');
    const symbol = readPumpRawString(raw, 'symbol');
    const imageUrl = readPumpRawString(raw, 'image');
    const pairAddress = readPumpRawString(raw, 'pairAddress');
    const metadataUri = readPumpRawString(raw, 'uri');

    if (name) {
      token.name = name;
    }
    if (symbol) {
      token.symbol = symbol;
    }
    if (imageUrl) {
      const nextImageUrl = toHttpAssetUrl(imageUrl);
      if (nextImageUrl) {
        token.imageUrl = nextImageUrl;
      }
    }

    token.createdAt = token.createdAt ?? now;
    token.mintAddress = token.mintAddress || mint;
    token.pairAddress = pairAddress ?? token.pairAddress ?? null;
    token.metadataUri = metadataUri ?? token.metadataUri ?? null;
  }

  function syncPumpTokenCurveState(token: PumpTokenEntry, raw: Record<string, unknown>) {
    const vTokensInBondingCurve = Number(raw.vTokensInBondingCurve);
    const virtualSolReserves = Number(raw.virtualSolReserves);

    token.bondingCurveKey = typeof raw.bondingCurveKey === 'string' ? raw.bondingCurveKey : token.bondingCurveKey;
    if (Number.isFinite(vTokensInBondingCurve)) {
      token.vTokensInBondingCurve = vTokensInBondingCurve;
    }
    if (Number.isFinite(virtualSolReserves)) {
      token.virtualSolReserves = virtualSolReserves;
    }
  }

  function resolvePumpTokenMcap(token: PumpTokenEntry, raw: Record<string, unknown>, solPriceUsd: number) {
    const usdMcap = Number(raw.usd_market_cap);
    const marketCapSol = Number(raw.marketCapSol);

    if (Number.isFinite(usdMcap) && usdMcap > 0) {
      return usdMcap;
    }
    if (Number.isFinite(marketCapSol) && marketCapSol > 0 && solPriceUsd > 0) {
      return marketCapSol * solPriceUsd;
    }
    if ((token.virtualSolReserves || 0) > 0 && (token.vTokensInBondingCurve || 0) > 0 && solPriceUsd > 0) {
      const priceUsd = ((token.virtualSolReserves || 0) / 1_000_000_000) / (token.vTokensInBondingCurve || 1) * solPriceUsd;
      return priceUsd * 1_000_000_000;
    }

    return null;
  }

  function applyPumpTradeActivity(token: PumpTokenEntry, raw: Record<string, unknown>, now: number, solPriceUsd: number) {
    const solAmount = Number(raw.solAmount);
    const usdAmount = Number.isFinite(solAmount) && solAmount > 0 && solPriceUsd > 0 ? solAmount * solPriceUsd : 0;

    if (usdAmount > 0) {
      appendPumpVolumeBucket(token, usdAmount, now);
      token.volTotal = (token.volTotal || 0) + usdAmount;
    } else {
      prunePumpTokenWindow(token, now);
    }

    token.lastTradeAt = now;
    token.hidden = false;
    subscribePumpMint(token.mint);
    maybeFirePumpAlert(token);
  }

  function commitPumpTokenUpdate(token: PumpTokenEntry, existing: PumpTokenEntry | undefined) {
    if (!existing) {
      state.data.pumpTokens = [...state.data.pumpTokens, token];
    }

    refreshPumpPanelCounts();

    if (!token.imageUrl) {
      void resolvePumpTokenImage(token.mint);
    }
  }

  function _createOrUpdatePumpToken(raw: Record<string, unknown>, mode: 'new' | 'trade') {
    const mint = String(raw.mint || '').trim();
    if (!mint || isBlocked(mint) || state.data.dismissedPump.includes(mint)) {
      return;
    }

    const now = Date.now();
    const solPriceUsd = state.pumpfun.solPriceUsd ?? 0;
    const existing = state.data.pumpTokens.find((item) => item.mint === mint);
    const token: PumpTokenEntry = existing ?? buildInitialPumpToken(raw, mint, now);

    syncPumpTokenIdentity(token, raw, mint, now);
    syncPumpTokenCurveState(token, raw);
    const nextMcap = resolvePumpTokenMcap(token, raw, solPriceUsd);
    if (nextMcap != null) {
      token.mcap = nextMcap;
    }

    if (mode === 'trade') {
      applyPumpTradeActivity(token, raw, now, solPriceUsd);
    }

    commitPumpTokenUpdate(token, existing);
  }
  function clampPage(page: number, totalItems: number, perPage: number) {
    const safePerPage = Math.max(10, Math.floor(perPage) || 30);
    const totalPages = Math.max(1, Math.ceil(totalItems / safePerPage));
    return Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  }

  function getRoutedEligibilityContext(now = Date.now()) {
    const recentAgeMinMinutes = Math.max(0, Math.min(
      RECENT_MAX_AGE_MINUTES,
      Math.round(getConfigNumber('recent-age-min', 0))
    ));
    const recentAgeMaxMinutes = Math.max(
      recentAgeMinMinutes,
      Math.min(
        RECENT_MAX_AGE_MINUTES,
        Math.round(getConfigNumber('recent-age-max', RECENT_MAX_AGE_MINUTES))
      )
    );
    const oldWeekAgeMinMinutes = Math.max(
      OLD_WEEK_MIN_AGE_MINUTES,
      Math.min(
        OPEN_ENDED_AGE_MAX_MINUTES,
        Math.round(getConfigNumber('old-week-age-min', OLD_WEEK_MIN_AGE_MINUTES))
      )
    );
    const rawOldWeekAgeMaxMinutes = Math.round(getConfigNumber('old-week-age-max', 0));
    const oldWeekAgeMaxMinutes = rawOldWeekAgeMaxMinutes > 0
      ? Math.max(
          oldWeekAgeMinMinutes,
          Math.min(OPEN_ENDED_AGE_MAX_MINUTES, rawOldWeekAgeMaxMinutes)
        )
      : 0;

    return {
      now,
      recentMin: getConfigNumber('old-mcap-min', 120000),
      recentMax: getConfigNumber('old-mcap-max', 100000000),
      recentAgeMinMs: recentAgeMinMinutes * 60 * 1000,
      recentAgeMaxMs: recentAgeMaxMinutes * 60 * 1000,
      oldWeekMin: getConfigNumber('old-week-mcap-min', 120000),
      oldWeekMax: getConfigNumber('old-week-mcap-max', 100000000),
      oldWeekAgeMinMs: oldWeekAgeMinMinutes * 60 * 1000,
      oldWeekAgeMaxMs: oldWeekAgeMaxMinutes > 0 ? oldWeekAgeMaxMinutes * 60 * 1000 : 0,
      recentDismissed: new Set(state.data.dismissedRecentIdentities),
      oldWeekDismissed: new Set(state.data.dismissedOldWeekIdentities),
    };
  }

  function isRecentEligible(
    token: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
    options: { preserveWithoutMcap?: boolean } = {},
  ) {
    if (token._userManual || isBlocked(token.address, token.chain || 'solana') || context.recentDismissed.has(getTokenIdentityKey(token))) {
      return false;
    }
    if (!(typeof token.createdAt === 'number' && token.createdAt > 0)) {
      return false;
    }

    const age = context.now - token.createdAt;
    if (!(age >= context.recentAgeMinMs && age <= context.recentAgeMaxMs && age <= OLD_WEEK_MIN_AGE_MS)) {
      return false;
    }

    const mcap = token.mcap ?? 0;
    if (mcap <= 0) {
      return Boolean(options.preserveWithoutMcap);
    }

    return mcap >= context.recentMin && (context.recentMax <= 0 || mcap <= context.recentMax);
  }

  function isOldWeekEligible(
    token: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
    options: { preserveWithoutMcap?: boolean } = {},
  ) {
    if (token._userManual || isBlocked(token.address, token.chain || 'solana') || context.oldWeekDismissed.has(getTokenIdentityKey(token))) {
      return false;
    }
    if (!(typeof token.createdAt === 'number' && token.createdAt > 0)) {
      return false;
    }

    const age = context.now - token.createdAt;
    if (age < context.oldWeekAgeMinMs) {
      return false;
    }
    if (context.oldWeekAgeMaxMs > 0 && age > context.oldWeekAgeMaxMs) {
      return false;
    }

    const mcap = token.mcap ?? 0;
    if (mcap <= 0) {
      return Boolean(options.preserveWithoutMcap);
    }

    return mcap >= context.oldWeekMin && (context.oldWeekMax <= 0 || mcap <= context.oldWeekMax);
  }

  function getVisibleMonitoredTokens() {
    return getMonitoredTokens(state).filter(isVisibleMonitoredToken);
  }

  function getFilteredAlertsForPagination() {
    const normalizedQuery = String(state.ui.alertSearchQuery || '').trim().toLowerCase();
    const feedAlerts = getAlertFeedAlerts(state);
    if (!normalizedQuery) {
      return feedAlerts;
    }

    return feedAlerts.filter((alert) => {
      const symbol = String(alert.symbol || '').toLowerCase();
      const name = String(alert.name || '').toLowerCase();
      const address = String(alert.address || '').toLowerCase();
      return symbol.includes(normalizedQuery) || name.includes(normalizedQuery) || address.includes(normalizedQuery);
    });
  }

  function syncAlertPagination() {
    state.ui.alertPage = clampPage(state.ui.alertPage, getFilteredAlertsForPagination().length, ALERTS_PER_PAGE);
  }

  function syncMonitoredPagination() {
    state.ui.monitoredPage = clampPage(state.ui.monitoredPage, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
  }

  function syncRoutedPagination() {
    syncAlertPagination();
    syncMonitoredPagination();
    state.ui.recentPage = clampPage(state.ui.recentPage, getRecentTokenTotalForPagination(), state.ui.recentPerPage);
    state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, getOldWeekTokenTotalForPagination(), state.ui.oldWeekPerPage);
  }
  function shouldDeriveRecentList(options?: { forceRecentList?: boolean }) {
    return Boolean(options?.forceRecentList) || !state.ui.collapsed.recent;
  }

  function shouldDeriveOldWeekList(options?: { forceOldWeekList?: boolean }) {
    return Boolean(options?.forceOldWeekList) || !state.ui.collapsed.oldWeek;
  }

  function deriveRoutedTokenState(
    item: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
  ) {
    const wasRecent = Boolean(item._isRecentRouted);
    const wasOldWeek = Boolean(item._isOldWeekRouted);
    const nextRecent = isRecentEligible(item, context, {
      preserveWithoutMcap: wasRecent,
    });
    const nextOldWeek = isOldWeekEligible(item, context, {
      preserveWithoutMcap: wasOldWeek,
    });

    item._isRecentRouted = nextRecent;
    item._isOldWeekRouted = nextOldWeek;

    return {
      wasRecent,
      wasOldWeek,
      nextRecent,
      nextOldWeek,
    };
  }

  function finalizeAgeBucketState(
    deriveRecentList: boolean,
    deriveOldWeekList: boolean,
    nextRecentIdentities: string[],
    nextOldWeekIdentities: string[],
  ) {
    state.data.recentTokenIdentities = deriveRecentList ? nextRecentIdentities : [];
    state.data.oldWeekTokenIdentities = deriveOldWeekList ? nextOldWeekIdentities : [];
    refreshTrackedTokenStore();
    state.bars.recent = getMonitoredTokens(state).filter((item) => item._isRecentRouted).length;
    state.bars.oldWeek = getMonitoredTokens(state).filter((item) => item._isOldWeekRouted).length;
    state.runtime.routedRevision += 1;
    syncRoutedPagination();
  }

  function deriveAgeBuckets(options?: { forceRecentList?: boolean; forceOldWeekList?: boolean }) {
    if (usesHistoryBucketBootstrap()) {
      return;
    }

    measureRuntimePerf(
      'controller.deriveAgeBuckets',
      isRuntimePerfDebugActive(),
      {
        monitored: state.data.monitoredTokenIdentities.length,
        workspace: state.ui.workspace,
      },
      () => {
        const context = getRoutedEligibilityContext();
        const deriveRecentList = shouldDeriveRecentList(options);
        const deriveOldWeekList = shouldDeriveOldWeekList(options);
        const nextRecentIdentities: string[] = [];
        const nextOldWeekIdentities: string[] = [];

        for (const item of getMonitoredTokens(state)) {
          const routedState = deriveRoutedTokenState(item, context);

          if (routedState.nextRecent && deriveRecentList) {
            nextRecentIdentities.push(getTokenIdentityKey(item));
          }
          if (routedState.nextOldWeek && deriveOldWeekList) {
            nextOldWeekIdentities.push(getTokenIdentityKey(item));
          }
        }

        finalizeAgeBucketState(deriveRecentList, deriveOldWeekList, nextRecentIdentities, nextOldWeekIdentities);
      }
    );
  }
  function applyBlockedFilters() {
    const blocked = new Set(state.data.blocklist
      .filter((item) => (item.chain || 'solana') === 'solana')
      .map((item) => item.address));
    const blockedIdentities = new Set(state.data.blocklist.flatMap((item) => {
      try {
        return [getTrackedTokenKey(item.address, item.chain || 'solana')];
      } catch {
        return [];
      }
    }));
    if (blocked.size === 0) {
      deriveAgeBuckets();
      refreshMonitoredPanelCounts();
      refreshPumpPanelCounts();
      return;
    }

    state.data.monitoredTokenIdentities = state.data.monitoredTokenIdentities.filter((item) => !blockedIdentities.has(item));
    state.data.pinnedMonitoredTokenIdentities = state.data.pinnedMonitoredTokenIdentities.filter((item) => !blockedIdentities.has(item));
    state.data.manualTokenIdentities = state.data.manualTokenIdentities.filter((item) => !blockedIdentities.has(item));
    state.data.recentTokenIdentities = state.data.recentTokenIdentities.filter((item) => !blockedIdentities.has(item));
    state.data.oldWeekTokenIdentities = state.data.oldWeekTokenIdentities.filter((item) => !blockedIdentities.has(item));
    state.data.topPerformerIdentities = state.data.topPerformerIdentities.filter((item) => !blockedIdentities.has(item));
    refreshTrackedTokenStore();
    state.data.pumpTokens = state.data.pumpTokens.filter((item) => !blocked.has(item.mint));
    state.data.recentPumpMigrations = state.data.recentPumpMigrations.filter((item) => !blocked.has(item.mint));
    const beforeAlerts = state.data.alerts.slice();
    state.data.alerts = state.data.alerts.filter((item) => !blockedIdentities.has(
      getTrackedTokenKey(item.address, item.chain),
    ));
    recordAlertMutationDebug('filter.blocked-addresses', beforeAlerts, {
      blockedCount: blocked.size,
    });
    state.data.dismissedRecentIdentities = state.data.dismissedRecentIdentities.filter((identity) => !blockedIdentities.has(identity));
    state.data.dismissedOldWeekIdentities = state.data.dismissedOldWeekIdentities.filter((identity) => !blockedIdentities.has(identity));
    state.bars.manual = state.data.manualTokenIdentities.length;
    deriveAgeBuckets();
    refreshMonitoredPanelCounts();
    refreshPumpPanelCounts();
    persistBarStorage();
  }

  function sweepMinMcapRemove() {
    const minMcapRemove = getConfigNumber('min-mcap-remove', 0);
    if (minMcapRemove <= 0) {
      deriveAgeBuckets();
      return;
    }

    const removed: string[] = [];
    state.data.monitoredTokenIdentities = state.data.monitoredTokenIdentities.filter((identityKey) => {
      const item = getTrackedTokenByIdentity(identityKey);
      if (!item) {
        return false;
      }
      if (item._userManual) {
        return true;
      }

      const mcap = item.mcap ?? 0;
      const keep = !(mcap > 0 && mcap < minMcapRemove);
      if (!keep) {
        removed.push(item.symbol || item.label || item.address.slice(0, 8));
        removeAlertsForAddress(item.address);
      }
      return keep;
    });

    state.data.manualTokenIdentities = state.data.manualTokenIdentities.filter((identityKey) => {
      const tracked = getTrackedTokenByIdentity(identityKey);
      return Boolean(tracked?._userManual) || state.data.monitoredTokenIdentities.includes(identityKey);
    });
    refreshTrackedTokenStore();
    state.bars.manual = state.data.manualTokenIdentities.length;
    deriveAgeBuckets();

    if (removed.length > 0) {
      refreshMonitoredPanelCounts();
      setNotice(`Removed ${removed.length} monitored token(s) by min-mcap-remove.`);
    }
  }

  function computeUptimeLabel() {
    if (!startedAt) {
      state.runtime.uptimeLabel = '0m';
      return;
    }
    const ms = Date.now() - startedAt;
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    state.runtime.uptimeLabel = hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
  }

  function formatFreshnessLabel(timestamp: string | null) {
    if (!timestamp) return '-';
    const ageMs = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
    const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
    if (ageSeconds < 2) return 'just now';
    if (ageSeconds < 60) return `${ageSeconds}s ago`;
    const ageMinutes = Math.round(ageSeconds / 60);
    return `${ageMinutes}m ago`;
  }

  function updateMonitoredFreshness(timestamp: string | null) {
    state.runtime.monitoredUpdatedAt = timestamp;
    state.runtime.monitoredFreshnessLabel = formatFreshnessLabel(timestamp);
  }

  function updateBidZoneFreshness(timestamp: string | null) {
    state.runtime.bidZoneUpdatedAt = timestamp;
    state.runtime.bidZoneFreshnessLabel = formatFreshnessLabel(timestamp);
  }

  function formatCooldownLabel(timestamp: string | null) {
    if (!timestamp) return 'ready';
    const remainingMs = new Date(timestamp).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'ready';

    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return remainingMinutes <= 1 ? '1m' : `${remainingMinutes}m`;
  }

  function updateBidZoneRefreshAvailability(timestamp: string | null) {
    state.runtime.bidZoneRefreshAvailableAt = timestamp;
    state.runtime.bidZoneRefreshCooldownLabel = formatCooldownLabel(timestamp);
  }

  function startPumpGcTimer() {
    if (pumpGcInterval || !shouldRunPumpfunRuntime() || state.runtime.mode !== 'active') {
      return;
    }

    pumpGcInterval = setInterval(() => {
      runPumpGarbageCollection();
      emit('pumpfun', 'toasts', 'legacy', 'overlay');
    }, PUMP_GC_INTERVAL_MS);
  }

  function stopPumpGcTimer() {
    if (pumpGcInterval) {
      clearInterval(pumpGcInterval);
      pumpGcInterval = null;
    }
  }

  async function refreshBidZoneTokens(options?: { force?: boolean }) {
    if (!shouldRunHistoryAnalyticsRuntime()) {
      state.data.bidZoneTokens = [];
      state.panels.bidZone = 0;
      updateBidZoneFreshness(null);
      updateBidZoneRefreshAvailability(null);
      state.runtime.bidZoneRefreshInFlight = false;
      return;
    }

    const token = state.session.token;
    if (!token || bidZoneRefreshInFlight) {
      return;
    }

    const now = Date.now();
    if (!options?.force && nextBidZoneRefreshAt > now) {
      return;
    }

    bidZoneRefreshInFlight = true;
    try {
      const payload = await measureRuntimePerfAsync(
        'api.catalog.bid-zone',
        isRuntimePerfDebugActive(),
        { limit: BID_ZONE_PANEL_LIMIT, force: Boolean(options?.force) },
        () => fetchBidZoneCandidates(token, { limit: BID_ZONE_PANEL_LIMIT }),
      );
      applyBidZonePayload(payload);
      if (isHistoryWorkspace() && isHistorySyncLeader()) {
        broadcastHistoryBidZoneSnapshot(payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('Failed to load bid-zone candidates')
        || message.includes('No completed bid-zone snapshot available')
        || message.includes('API request failed:')
      ) {
        state.data.bidZoneTokens = [];
        updateBidZoneFreshness(null);
        updateBidZoneRefreshAvailability(null);
        state.panels.bidZone = 0;
        emit('bid-zone');
        return;
      }
    } finally {
      nextBidZoneRefreshAt = Date.now() + BID_ZONE_REFRESH_INTERVAL_MS;
      bidZoneRefreshInFlight = false;
    }
  }

  function passesAlertFilters(token: ManualTokenEntry) {
    const minVol = getConfigNumber('min-vol', 10000);
    const minMcap = getConfigNumber('min-mcap', 30000);
    const maxMcap = getConfigNumber('max-mcap', 0);
    const volume5m = token.volume5m ?? 0;
    const mcap = token.mcap ?? 0;
    if (volume5m < minVol) return false;
    if (mcap > 0 && mcap < minMcap) return false;
    if (maxMcap > 0 && mcap > maxMcap) return false;
    return true;
  }

  function getMeteoraBaselineTvl1h(entry: MeteoraEntry | undefined) {
    const currentTvl = Number(entry?.tvl) || 0;
    const change1hPct = Number(entry?.change1h);
    if (!(currentTvl > 0) || !Number.isFinite(change1hPct)) {
      return null;
    }

    const ratio = 1 + (change1hPct / 100);
    if (!(ratio > 0)) {
      return null;
    }

    return currentTvl / ratio;
  }

  function getMeteoraBaselineTvl24h(entry: MeteoraEntry | undefined) {
    const currentTvl = Number(entry?.tvl) || 0;
    const change24hPct = Number(entry?.change24h);
    if (!(currentTvl > 0) || !Number.isFinite(change24hPct)) {
      return null;
    }

    const ratio = 1 + (change24hPct / 100);
    if (!(ratio > 0)) {
      return null;
    }

    return currentTvl / ratio;
  }

  function roundAlertMetric(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) {
      return 'na';
    }
    return String(Math.round(value * 100) / 100);
  }

  function toOptionalNumber(value: number | null | undefined) {
    return Number.isFinite(value) ? value : null;
  }

  function toOptionalText(value: string | null | undefined) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
  }

  function getBackendAlertCreatedAt(triggeredAt: string | null | undefined) {
    const createdAt = triggeredAt ? new Date(triggeredAt).getTime() : Date.now();
    return Number.isFinite(createdAt) ? createdAt : Date.now();
  }

  function buildBackendAlertMetaFields(event: DashboardAlertEvent, address: string) {
    const mcap = toOptionalNumber(event.mcap);
    const fdv = toOptionalNumber(event.fdv);
    return {
      backendEventId: toOptionalNumber(event.id),
      chain: normalizeTokenChain(event.chain) || 'solana',
      pairAddress: toOptionalText(event.pairAddress),
      symbol: toOptionalText(event.symbol) || address.slice(0, 8),
      name: toOptionalText(event.name),
      pairUrl: toOptionalText(event.pairUrl),
      imageUrl: toOptionalText(event.imageUrl),
      twitterUrl: toOptionalText(event.twitterUrl),
      communityUrl: toOptionalText(event.communityUrl),
      tokenCreatedAt: toOptionalNumber(event.tokenCreatedAt),
      fdv,
      valuationType: event.valuationType === 'fdv'
        ? 'fdv' as const
        : (mcap != null ? 'market-cap' as const : (fdv != null ? 'fdv' as const : null)),
      priceUsd: toOptionalNumber(event.priceUsd),
      liquidityUsd: toOptionalNumber(event.liquidityUsd),
      transactions: toOptionalNumber(event.transactions),
    };
  }

  function shouldSuppressDuplicateAlert(entry: AlertEntry) {
    let fingerprint = '';

    switch (entry.kind) {
      case 'hvnc':
        fingerprint = 'single-fire';
        break;
      case 'monitored-mcap':
        fingerprint = [
          roundAlertMetric(entry.pct),
          roundAlertMetric(entry.prevMcap ?? null),
          roundAlertMetric(entry.mcap ?? null),
        ].join('|');
        break;
      case 'monitored-fdv':
        fingerprint = [
          roundAlertMetric(entry.pct),
          roundAlertMetric(entry.prevFdv ?? null),
          roundAlertMetric(entry.fdv ?? null),
        ].join('|');
        break;
      case 'meteora-surge':
        fingerprint = [
          roundAlertMetric(entry.pct),
          roundAlertMetric(entry.mcap ?? null),
          roundAlertMetric(entry.volume24h ?? null),
        ].join('|');
        break;
      default:
        return false;
    }

    const dedupeKey = `${entry.chain}:${entry.kind}:${entry.address}`;
    const now = Date.now();
    const previous = recentAlertFingerprints.get(dedupeKey);
    const existingAlert = state.data.alerts.find((item) => {
      if (item.chain !== entry.chain || item.kind !== entry.kind || item.address !== entry.address) {
        return false;
      }

      let existingFingerprint = '';
      switch (item.kind) {
        case 'monitored-mcap':
          existingFingerprint = [
            roundAlertMetric(item.pct),
            roundAlertMetric(item.prevMcap ?? null),
            roundAlertMetric(item.mcap ?? null),
          ].join('|');
          break;
        case 'monitored-fdv':
          existingFingerprint = [
            roundAlertMetric(item.pct),
            roundAlertMetric(item.prevFdv ?? null),
            roundAlertMetric(item.fdv ?? null),
          ].join('|');
          break;
        case 'hvnc':
          existingFingerprint = 'single-fire';
          break;
        case 'meteora-surge':
          existingFingerprint = [
            roundAlertMetric(item.pct),
            roundAlertMetric(item.mcap ?? null),
            roundAlertMetric(item.volume24h ?? null),
          ].join('|');
          break;
        default:
          return false;
      }

      if (entry.kind === 'hvnc') {
        return existingFingerprint === fingerprint;
      }

      return existingFingerprint === fingerprint
        && Math.abs(now - Number(item.createdAt || 0)) < ALERT_DEDUPE_WINDOW_MS;
    });

    recentAlertFingerprints.set(dedupeKey, { ts: now, fingerprint });

    if (existingAlert) {
      return true;
    }

    if (!previous) {
      return false;
    }

    return previous.fingerprint === fingerprint && now - previous.ts < ALERT_DEDUPE_WINDOW_MS;
  }

  function pushAlert(entry: AlertEntry) {
    if (isBlocked(entry.address, entry.chain) || !isAlertEntryEnabled(entry)) {
      recordAlertDebug('push.skip-disabled-or-blocked', {
        entry: summarizeAlertDebug([entry]),
        blocked: isBlocked(entry.address, entry.chain),
        enabled: isAlertEntryEnabled(entry),
      });
      return false;
    }
    if (state.data.alerts.some((item) => item.id === entry.id)) {
      recordAlertDebug('push.skip-duplicate-id', {
        entry: summarizeAlertDebug([entry]),
      });
      return false;
    }
    if (shouldSuppressDuplicateAlert(entry)) {
      recordAlertDebug('push.skip-fingerprint', {
        entry: summarizeAlertDebug([entry]),
      });
      return false;
    }
    const beforeAlerts = state.data.alerts.slice();
    const nextAlerts = [entry, ...state.data.alerts]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, ALERTS_MAX_ENTRIES);
    if (!nextAlerts.some((item) => item.id === entry.id)) {
      recordAlertDebug('push.drop-by-cap', {
        entry: summarizeAlertDebug([entry]),
        before: summarizeAlertDebug(beforeAlerts),
        afterCandidate: summarizeAlertDebug(nextAlerts),
      });
      return false;
    }
    state.data.alerts = nextAlerts;
    syncAlertState();
    recordAlertMutationDebug('push.apply', beforeAlerts, {
      entry: summarizeAlertDebug([entry]),
    });
    queueAlertSparklineRefresh(entry.id, entry.address);
    emit('alerts', 'legacy');
    return true;
  }

  function areAlertEntriesEquivalent(left: AlertEntry, right: AlertEntry) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function upsertBackendAlertEntry(entry: AlertEntry) {
    if (isBlocked(entry.address, entry.chain) || !isAlertEntryEnabled(entry)) {
      recordAlertDebug('backend.upsert.skip-disabled-or-blocked', {
        entry: summarizeAlertDebug([entry]),
        blocked: isBlocked(entry.address, entry.chain),
        enabled: isAlertEntryEnabled(entry),
      });
      return false;
    }

    const existingIndex = state.data.alerts.findIndex((item) => item.id === entry.id);
    if (existingIndex < 0) {
      return pushAlert(entry);
    }

    const existing = state.data.alerts[existingIndex];
    if (areAlertEntriesEquivalent(existing, entry)) {
      recordAlertDebug('backend.upsert.noop-equivalent', {
        entry: summarizeAlertDebug([entry]),
      });
      return false;
    }

    const beforeAlerts = state.data.alerts.slice();
    const nextAlerts = state.data.alerts.slice();
    nextAlerts[existingIndex] = entry;
    nextAlerts.sort((a, b) => b.createdAt - a.createdAt);
    state.data.alerts = nextAlerts.slice(0, ALERTS_MAX_ENTRIES);
    syncAlertState();
    recordAlertMutationDebug('backend.upsert.update-existing', beforeAlerts, {
      entry: summarizeAlertDebug([entry]),
    });
    queueAlertSparklineRefresh(entry.id, entry.address);
    return true;
  }

  function buildBackendGmgnClaimSignalAlertEntry(event: DashboardAlertEvent): AlertEntry | null {
    const address = String(event.address || '').trim();
    if (!address) {
      return null;
    }

    const eventId = Number(event.id);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return null;
    }

    const signalType = toOptionalNumber(event.signalType);
    const label = signalType === 17 ? 'BAGS CLAIM' : 'PUMP CLAIM';

    return {
      id: `backend-gmgn-claim-signal:${eventId}`,
      kind: 'gmgn-claim-signal',
      ruleKey: toOptionalText(event.ruleKey) || GMGN_CLAIM_SIGNAL_RULE_KEY,
      address,
      mintAddress: address,
      createdAt: getBackendAlertCreatedAt(event.triggeredAt || event.claimedAt),
      label,
      pct: 0,
      mcap: toOptionalNumber(event.mcap),
      signalType,
      claimSequence: toOptionalNumber(event.claimSequence),
      claimId: toOptionalText(event.claimId),
      claimFeeAmount: toOptionalNumber(event.claimFeeAmount),
      claimFeeCurrency: toOptionalText(event.claimFeeCurrency),
      claimFeeUsd: toOptionalNumber(event.claimFeeUsd),
      quoteAddress: toOptionalText(event.quoteAddress),
      totalFeeUsd: toOptionalNumber(event.totalFeeUsd),
      claimedAt: toOptionalText(event.claimedAt),
      tickerPeers: event.tickerPeers ?? null,
      ...buildBackendAlertMetaFields(event, address),
    };
  }

  function buildBackendSimpleAlertEntry(event: DashboardAlertEvent, kind: Extract<AlertEntry['kind'], 'monitored-vol' | 'monitored-mcap' | 'monitored-fdv' | 'hvnc' | 'meteora-surge'>): AlertEntry | null {
    const address = String(event.address || '').trim();
    if (!address) {
      return null;
    }

    const eventId = Number(event.id);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return null;
    }

    return {
      id: `backend:${kind}:${eventId}`,
      kind,
      ruleKey: toOptionalText(event.ruleKey),
      address,
      mintAddress: address,
      createdAt: getBackendAlertCreatedAt(event.triggeredAt),
      label: toOptionalText(event.label) || (
        kind === 'hvnc'
          ? 'HVNC'
          : kind === 'meteora-surge'
            ? 'METEORA 1H'
            : kind === 'monitored-mcap'
              ? 'MCAP'
              : kind === 'monitored-fdv'
                ? 'FDV'
              : 'VOL'
      ),
      tickerPeers: event.tickerPeers ?? null,
      ...buildBackendAlertMetaFields(event, address),
      volume1m: toOptionalNumber(event.volume1m),
      volume5m: toOptionalNumber(event.volume5m),
      volume1h: toOptionalNumber(event.volume1h),
      volume6h: toOptionalNumber(event.volume6h),
      volume24h: toOptionalNumber(event.volume24h),
      prevVolume1m: toOptionalNumber(event.prevVolume1m),
      prevVolume5m: toOptionalNumber(event.prevVolume5m),
      prevMcap: toOptionalNumber(event.prevMcap),
      prevFdv: toOptionalNumber(event.prevFdv),
      mcap: toOptionalNumber(event.mcap),
      fdv: toOptionalNumber(event.fdv),
      pct: toOptionalNumber(event.pct) ?? 0,
      isHvnc: kind === 'hvnc' ? true : undefined,
      meteoraCurrentTvl: toOptionalNumber(event.meteoraCurrentTvl),
      meteoraBaselineTvl24h: toOptionalNumber(event.meteoraBaselineTvl24h),
    };
  }

  function buildBackendCustomAlertEntry(event: DashboardAlertEvent): AlertEntry | null {
    const address = String(event.address || '').trim();
    if (!address) {
      return null;
    }

    const eventId = Number(event.id);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return null;
    }

    return {
      id: `backend:custom-alert:${eventId}`,
      kind: 'custom-alert',
      ruleKey: toOptionalText(event.ruleKey) || 'custom-alert',
      address,
      mintAddress: address,
      createdAt: getBackendAlertCreatedAt(event.triggeredAt),
      label: toOptionalText(event.label) || 'CUSTOM',
      tickerPeers: event.tickerPeers ?? null,
      ...buildBackendAlertMetaFields(event, address),
      priceChange1h: toOptionalNumber(event.priceChange1h),
      priceChange6h: toOptionalNumber(event.priceChange6h),
      volume1m: toOptionalNumber(event.volume1m),
      volume5m: toOptionalNumber(event.volume5m),
      volume1h: toOptionalNumber(event.volume1h),
      volume6h: toOptionalNumber(event.volume6h),
      volume24h: toOptionalNumber(event.volume24h),
      prevMcap: toOptionalNumber(event.prevMcap),
      mcap: toOptionalNumber(event.mcap),
      pct: toOptionalNumber(event.pct) ?? 0,
      customRuleId: toOptionalNumber(event.customRuleId),
      customColorHex: toOptionalText(event.customColorHex),
      customTitle: toOptionalText(event.customTitle),
      customMetric: toOptionalText(event.customMetric),
      customOperator: toOptionalText(event.customOperator),
      customTarget: event.customTarget ?? null,
      customRepeatMode: toOptionalText(event.customRepeatMode),
      customExpires: toOptionalText(event.customExpires),
      customFilters: toOptionalText(event.customFilters),
      customSoundName: toOptionalText(event.customSoundName),
      customSoundDataUrl: toOptionalText(event.customSoundDataUrl),
      customCurrentValue: toOptionalNumber(event.customCurrentValue),
      customPreviousValue: toOptionalNumber(event.customPreviousValue),
    };
  }

  function buildBackendSurgeAlertEntry(event: DashboardAlertEvent): AlertEntry | null {
    const address = String(event.address || '').trim();
    if (!address) {
      return null;
    }

    const eventId = Number(event.id);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return null;
    }

    const surgeWindow = event.surgeWindow === '6H' ? '6H' : '1H';
    const ageBucket = event.ageBucket === 'recent' || event.ageBucket === 'old-week'
      ? event.ageBucket
      : null;
    const mcap = toOptionalNumber(event.mcap);
    const fdv = toOptionalNumber(event.fdv);
    const pct = toOptionalNumber(event.pct) ?? 0;
    const mcapRatio = 1 + (pct / 100);
    const prevMcap = toOptionalNumber(event.prevMcap)
      ?? (mcap != null && mcap > 0 && mcapRatio > 0 ? mcap / mcapRatio : null);
    const prevFdv = toOptionalNumber(event.prevFdv);

    return {
      id: `backend:${toOptionalText(event.ruleKey) || 'old-surge'}:${eventId}`,
      kind: 'old-surge',
      ruleKey: toOptionalText(event.ruleKey),
      address,
      mintAddress: address,
      createdAt: getBackendAlertCreatedAt(event.triggeredAt),
      label: toOptionalText(event.label) || `PCHANGE ${surgeWindow}`,
      tickerPeers: event.tickerPeers ?? null,
      ...buildBackendAlertMetaFields(event, address),
      priceChange1h: toOptionalNumber(event.priceChange1h),
      priceChange6h: toOptionalNumber(event.priceChange6h),
      volume1h: toOptionalNumber(event.volume1h),
      volume6h: toOptionalNumber(event.volume6h),
      volume24h: toOptionalNumber(event.volume24h),
      prevMcap,
      prevFdv,
      mcap,
      fdv,
      thresholdPct: toOptionalNumber(event.thresholdPct),
      pct,
      surgeWindow,
      ageBucket,
      isOldSurge: true,
    };
  }

  function buildBackendAlertEntry(event: DashboardAlertEvent): AlertEntry | null {
    const kind = String(event.kind || event.ruleKey || '').trim().toLowerCase();

    switch (kind) {
      case 'gmgn-claim-signal':
        return buildBackendGmgnClaimSignalAlertEntry(event);
      case 'monitored-vol':
        return buildBackendSimpleAlertEntry(event, 'monitored-vol');
      case 'monitored-mcap':
        return buildBackendSimpleAlertEntry(event, 'monitored-mcap');
      case 'monitored-fdv':
        return buildBackendSimpleAlertEntry(event, 'monitored-fdv');
      case 'hvnc':
        return buildBackendSimpleAlertEntry(event, 'hvnc');
      case 'old-surge':
        return buildBackendSurgeAlertEntry(event);
      case 'meteora-surge':
        return buildBackendSimpleAlertEntry(event, 'meteora-surge');
      case 'custom-alert':
        return buildBackendCustomAlertEntry(event);
      default:
        return null;
    }
  }

  function isLocalOnlyAlertEntry(entry: AlertEntry) {
    return entry.kind === 'admin-token-review'
      || String(entry.id || '').startsWith('custom-preview:');
  }

  function buildAuthoritativeBackendAlertEntries(events: DashboardAlertEvent[] = []) {
    return events
      .map((item) => buildBackendAlertEntry(item))
      .filter((item): item is AlertEntry => Boolean(item))
      .filter((item) => !isBlocked(item.address, item.chain) && isAlertEntryEnabled(item));
  }

  async function refreshAuthoritativeBackendAlertHistory(reason = 'manual') {
    const token = state.session.token;
    if (!token || !isAuthenticatedSession()) {
      return;
    }

    try {
      const payload = await fetchDashboardAlertFeeds(token, {
        mode: 'all',
        limit: ALERTS_MAX_ENTRIES,
      });
      const events = payload.feeds.flatMap((feed) => feed.events || []);
      const backendAlerts = buildAuthoritativeBackendAlertEntries(events);
      const localOnlyAlerts = state.data.alerts.filter(isLocalOnlyAlertEntry);
      const beforeAlerts = state.data.alerts.slice();
      const nextAlerts = [...backendAlerts, ...localOnlyAlerts]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, ALERTS_MAX_ENTRIES);

      state.data.alerts = nextAlerts;
      syncAlertState();
      recordAlertMutationDebug('backend.authoritative-history', beforeAlerts, {
        reason,
        mode: payload.mode,
        feedCount: payload.feeds.length,
        backendEvents: summarizeDashboardAlertEventsDebug(events),
        builtEntries: summarizeAlertDebug(backendAlerts),
        localOnlyCount: localOnlyAlerts.length,
      });
      queueMissingAlertSparklineRefresh();
      emit('alerts', 'header', 'legacy');
      flushEmit();
    } catch (error) {
      recordAlertDebug('backend.authoritative-history.error', {
        reason,
        error: formatDebugErrorMessage(error),
      });
    }
  }

  function firstCustomPreviewText(...values: unknown[]) {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function customPreviewValue<T>(value: T | null | undefined) {
    return value ?? null;
  }

  function buildCustomAlertPreviewIdentity(chain: TokenChain, address: string, tracked: ManualTokenEntry | null) {
    const symbol = firstCustomPreviewText(tracked?.symbol, tracked?.label, address.slice(0, 8));
    return {
      chain,
      address,
      mintAddress: firstCustomPreviewText(tracked?.mintAddress, address),
      pairAddress: customPreviewValue(tracked?.pairAddress),
      symbol,
      name: firstCustomPreviewText(tracked?.name, tracked?.label, 'Custom alert preview'),
      pairUrl: customPreviewValue(tracked?.pairUrl),
      imageUrl: customPreviewValue(tracked?.imageUrl),
      twitterUrl: customPreviewValue(tracked?.twitterUrl),
      communityUrl: customPreviewValue(tracked?.communityUrl),
    };
  }

  function buildCustomAlertPreviewMetrics(tracked: ManualTokenEntry | null) {
    return {
      tokenCreatedAt: tracked?.createdAt ?? tracked?.catalogFirstSeenAt ?? null,
      priceChange1h: customPreviewValue(tracked?.priceChange1h),
      priceChange6h: customPreviewValue(tracked?.priceChange6h),
      volume5m: customPreviewValue(tracked?.volume5m),
      volume1h: customPreviewValue(tracked?.volume1h),
      volume6h: customPreviewValue(tracked?.volume6h),
      volume24h: customPreviewValue(tracked?.volume24h),
      prevMcap: customPreviewValue(tracked?.prevMcap),
      mcap: customPreviewValue(tracked?.mcap),
      fdv: customPreviewValue(tracked?.fdv),
      valuationType: tracked?.valuationType ?? null,
    };
  }

  function buildCustomAlertPreviewFields(input: CustomAlertPreviewInput) {
    return {
      customColorHex: input.colorHex,
      customTitle: input.title,
      customMetric: input.metric,
      customOperator: input.operator,
      customTarget: input.target,
      customRepeatMode: input.repeatMode,
      customExpires: input.expires,
      customFilters: input.filters,
      customSoundName: input.soundName,
      customSoundDataUrl: input.soundDataUrl,
    };
  }

  function buildCustomAlertPreviewEntry(input: CustomAlertPreviewInput, address: string, now: number): AlertEntry {
    const chain = normalizeTokenChain(input.chain) || 'solana';
    const tracked = getTrackedToken(state, address, chain);
    return {
      id: `custom-preview:${now}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'custom-alert',
      ruleKey: 'custom-token-alert-preview',
      createdAt: now,
      pct: 0,
      label: 'CUSTOM',
      ...buildCustomAlertPreviewIdentity(chain, address, tracked),
      ...buildCustomAlertPreviewMetrics(tracked),
      ...buildCustomAlertPreviewFields(input),
    };
  }

  function parseCustomAlertTargetValue(value: string) {
    const text = String(value || '').trim().replace(/[$,\s]/g, '');
    const shorthand = /^(\d+(?:\.\d+)?)([kmb])$/i.exec(text);
    const multipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
    const parsed = shorthand
      ? Number(shorthand[1]) * multipliers[shorthand[2].toLowerCase()]
      : Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function requireCustomAlertSessionToken() {
    const token = state.session.token;
    if (!token || !isAuthenticatedSession()) {
      throw new Error('Sign in before saving a custom alert.');
    }
    return token;
  }

  function parseCustomAlertExpiresInHours(value: string): number | null | undefined {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'keep') return undefined;
    if (!text || text === 'never') return null;
    const hours = Number(text);
    return Number.isFinite(hours) && hours > 0 ? hours : null;
  }

  function buildCustomAlertRulePayload(
    input: CustomAlertPreviewInput,
    identityOverride?: { chain: TokenChain; tokenAddress: string },
  ) {
    const targetValue = parseCustomAlertTargetValue(input.target);
    if (targetValue == null) {
      throw new Error('Custom alert target must be greater than 0.');
    }

    const capability = requireCustomAlertCapability(state.data.customAlertCapabilities, {
      chain: identityOverride?.chain ?? input.chain ?? 'solana',
      metric: input.metric,
      window: input.window ?? 'spot',
    });
    const payload: CreateCustomAlertRulePayload = {
      chain: capability.chain,
      tokenAddress: identityOverride?.tokenAddress ?? input.tokenAddress,
      title: input.title,
      metric: capability.metric,
      window: capability.window,
      operator: input.operator === 'cross_below' ? 'cross_below' : 'cross_above',
      targetValue,
      colorHex: input.colorHex,
      soundName: input.soundName,
      soundDataUrl: input.soundDataUrl,
    };
    const expiresInHours = parseCustomAlertExpiresInHours(input.expires);
    if (expiresInHours !== undefined) {
      payload.expiresInHours = expiresInHours;
    }
    return payload;
  }

  async function createCustomAlertRule(input: CustomAlertPreviewInput) {
    const token = requireCustomAlertSessionToken();
    const response = await createCustomAlertRuleRequest(buildCustomAlertRulePayload(input), token);
    upsertCustomAlertRuleEntry(response.rule);
    return response;
  }

  function getCustomAlertRuleIdentity(rule: CustomAlertRule) {
    const chain = normalizeTokenChain(rule?.chain);
    const tokenAddress = String(rule?.tokenAddress || '').trim();
    if (!chain || !tokenAddress) return null;
    try {
      return createLegacyCompatibleTokenIdentity(chain, tokenAddress);
    } catch (_) {
      return null;
    }
  }

  function getCustomAlertRuleMetric(value: unknown): CustomAlertMetric | null {
    return value === 'price' || value === 'mcap' || value === 'fdv' ? value : null;
  }

  function getCustomAlertRuleBaseline(rule: CustomAlertRule, metric: CustomAlertMetric) {
    const baselineKey = metric === 'price'
      ? 'baselinePrice'
      : metric === 'fdv' ? 'baselineFdv' : 'baselineMcap';
    const rawValue = rule.metadata?.[baselineKey];
    if (rawValue == null) return null;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }

  function getCustomAlertRuleStatus(value: unknown): CustomAlertRuleEntry['status'] {
    if (value === 'triggered' || value === 'disabled') return value;
    return 'active';
  }

  function mapCustomAlertRuleEntry(rule: CustomAlertRule): CustomAlertRuleEntry | null {
    const id = Number(rule?.id);
    const identity = getCustomAlertRuleIdentity(rule);
    const metric = getCustomAlertRuleMetric(rule?.metric);
    if (!Number.isFinite(id) || id <= 0 || !identity || !metric || rule.window !== 'spot') {
      return null;
    }
    return {
      id,
      chain: identity.chain,
      identityKey: identity.key,
      tokenAddress: identity.address,
      title: String(rule.title || 'Custom alert'),
      metric,
      window: 'spot',
      operator: rule.operator === 'cross_below' ? 'cross_below' : 'cross_above',
      targetValue: Number(rule.targetValue) || 0,
      colorHex: rule.colorHex ?? null,
      soundName: rule.soundName ?? null,
      expiresAt: rule.expiresAt ?? null,
      status: getCustomAlertRuleStatus(rule.status),
      triggeredAt: rule.triggeredAt ?? null,
      baselineValue: getCustomAlertRuleBaseline(rule, metric),
      baselineAt: rule.metadata?.baselineAt ?? null,
    };
  }

  function upsertCustomAlertRuleEntry(rule: CustomAlertRule) {
    const mapped = mapCustomAlertRuleEntry(rule);
    if (!mapped) {
      return;
    }
    state.data.customAlertRules = [
      mapped,
      ...state.data.customAlertRules.filter((item) => item.id !== mapped.id),
    ].filter((item) => item.status !== 'disabled');
  }

  async function refreshCustomAlertRules() {
    const token = state.session.token;
    if (!token || !isAuthenticatedSession()) {
      return;
    }
    const chains = state.data.availableChains.filter((chain) => chain === 'solana' || chain === 'robinhood');
    const payload = await fetchCustomAlertRulesRequest(token, { chains });
    state.data.customAlertCapabilities = normalizeCustomAlertCapabilities(payload.capabilities);
    const nextRules = (Array.isArray(payload.rules) ? payload.rules : [])
      .map(mapCustomAlertRuleEntry)
      .filter((rule): rule is CustomAlertRuleEntry => Boolean(rule) && rule?.status !== 'disabled');
    const changed = JSON.stringify(nextRules) !== JSON.stringify(state.data.customAlertRules);
    state.data.customAlertRules = nextRules;
    emit('alerts');
    if (changed && state.ui.expandedSparklineAddress) {
      emit('overlay');
    }
    flushEmit();
  }

  function syncBackendAlertEvents(events: DashboardAlertEvent[] = []) {
    const beforeAlerts = state.data.alerts.slice();
    const nextAlerts = events
      .map((item) => buildBackendAlertEntry(item))
      .filter((item): item is AlertEntry => Boolean(item))
      .sort((a, b) => a.createdAt - b.createdAt);

    let added = 0;
    for (const alert of nextAlerts) {
      if (upsertBackendAlertEntry(alert)) {
        added += 1;
      }
    }

    recordAlertMutationDebug('backend.sync-events', beforeAlerts, {
      backendEvents: summarizeDashboardAlertEventsDebug(events),
      builtEntries: summarizeAlertDebug(nextAlerts),
      added,
    });
    return added;
  }

  function getMaxBackendAlertEventId(events: DashboardAlertEvent[] = []) {
    let maxId = 0;
    for (const item of events) {
      const eventId = Number(item?.id);
      if (Number.isInteger(eventId) && eventId > maxId) {
        maxId = eventId;
      }
    }
    return maxId > 0 ? maxId : null;
  }

  async function markDashboardAlertEventsSeen(token: string, events: DashboardAlertEvent[], ruleKey?: string | null) {
    const cursorRuleKey = ruleKey || GMGN_CLAIM_SIGNAL_RULE_KEY;
    const eventsByChain = new Map<TokenChain, DashboardAlertEvent[]>();
    for (const event of events) {
      const chain = normalizeTokenChain(event.chain) || 'solana';
      eventsByChain.set(chain, [...(eventsByChain.get(chain) || []), event]);
    }
    if (eventsByChain.size === 0) {
      recordAlertDebug('backend.mark-seen.skip-no-event-id', {
        ruleKey: cursorRuleKey,
        events: summarizeDashboardAlertEventsDebug(events),
      });
      return;
    }

    try {
      flushAlertsPersist();
      for (const [chain, chainEvents] of eventsByChain) {
        const lastSeenEventId = getMaxBackendAlertEventId(chainEvents);
        if (!lastSeenEventId) continue;
        recordAlertDebug('backend.mark-seen.start', {
          ruleKey: cursorRuleKey,
          chain,
          lastSeenEventId,
          events: summarizeDashboardAlertEventsDebug(chainEvents),
        });
        await updateDashboardAlertCursor({
          ruleKey: cursorRuleKey,
          chain,
          lastSeenEventId,
        }, token);
      }
      recordAlertDebug('backend.mark-seen.complete', {
        ruleKey: cursorRuleKey,
        chains: [...eventsByChain.keys()],
      });
    } catch {
      recordAlertDebug('backend.mark-seen.error', {
        ruleKey: cursorRuleKey,
        chains: [...eventsByChain.keys()],
      });
    }
  }

  function getAlertSymbol(token: ManualTokenEntry) {
    return token.symbol || token.label || token.address.slice(0, 8);
  }

  function buildTrackedAlertEntry(
    token: ManualTokenEntry,
    now: number,
    symbol: string,
    kind: AlertEntry['kind'],
    label: string,
    pct: number,
    extra?: Partial<AlertEntry>,
  ): AlertEntry {
    const chain = resolveAppTokenChain(token.chain);
    return {
      id: `${chain}:${token.address}-${now}-${kind}`,
      chain,
      kind,
      address: token.address,
      symbol,
      name: token.name || token.label || null,
      pairUrl: token.pairUrl || null,
      mintAddress: token.mintAddress || token.address,
      pairAddress: token.pairAddress || null,
      imageUrl: token.imageUrl || null,
      twitterUrl: token.twitterUrl || null,
      communityUrl: token.communityUrl || null,
      createdAt: now,
      tokenCreatedAt: token.createdAt ?? null,
      prevVolume5m: token.prevVolume5m ?? null,
      volume5m: token.volume5m ?? null,
      volume1h: token.volume1h ?? null,
      volume6h: token.volume6h ?? null,
      volume24h: token.volume24h ?? null,
      prevMcap: token.prevMcap ?? null,
      mcap: token.mcap ?? null,
      pct,
      label,
      ...extra,
    };
  }

  function shouldFireHvncAlert(token: ManualTokenEntry, ageMs: number, hvncMinVol: number) {
    return isAlertKindEnabled('hvnc')
      && !token._hvncFired
      && hvncMinVol > 0
      && ageMs <= HVNC_MAX_AGE_MS
      && (token.volume24h ?? 0) >= hvncMinVol;
  }

  function shouldFireMeteoraSurgeAlert(
    token: ManualTokenEntry,
    meteoraEntry: MeteoraEntry | undefined,
    meteoraCurrentTvl: number,
    meteoraBaselineTvl1h: number | null,
    meteoraAlertThreshold1h: number,
  ) {
    return isAlertKindEnabled('meteora-surge')
      && !token._meteoraSurgeFired
      && meteoraAlertThreshold1h > 0
      && Boolean(meteoraEntry)
      && !meteoraEntry?.noPool
      && meteoraCurrentTvl >= METEORA_ALERT_MIN_TVL
      && (meteoraBaselineTvl1h ?? 0) >= METEORA_ALERT_MIN_TVL
      && (meteoraEntry?.change1h ?? 0) >= meteoraAlertThreshold1h;
  }

  function maybeFireSpecialAlerts(token: ManualTokenEntry) {
    if (isBlocked(token.address, token.chain || 'solana')) {
      return;
    }

    const now = Date.now();
    if (isCrossAlertBlocked(token, now)) {
      return;
    }
    const symbol = getAlertSymbol(token);
    const ageMs = token.createdAt ? now - token.createdAt : Number.POSITIVE_INFINITY;
    const hvncMinVol = getConfigNumber('hvnc-min-vol', 300000);
    const meteoraAlertThreshold1h = getConfigNumber('meteora-alert-1h-threshold', 50);
    const meteoraEntry = state.data.meteoraByAddress[token.address];
    const meteoraCurrentTvl = Number(meteoraEntry?.tvl) || 0;
    const meteoraBaselineTvl1h = getMeteoraBaselineTvl1h(meteoraEntry);
    const meteoraBaselineTvl24h = getMeteoraBaselineTvl24h(meteoraEntry);
    const backendOwnedAlerts = shouldUseBackendOwnedMonitoredAlerts();

    if (!backendOwnedAlerts && shouldFireHvncAlert(token, ageMs, hvncMinVol)) {
      token._hvncFired = true;
      pushAlert(buildTrackedAlertEntry(token, now, symbol, 'hvnc', 'HVNC', 0, { isHvnc: true }));
      setNotice(`HVNC alert: ${symbol}`);
    }

    if (!backendOwnedAlerts && shouldFireMeteoraSurgeAlert(token, meteoraEntry, meteoraCurrentTvl, meteoraBaselineTvl1h, meteoraAlertThreshold1h)) {
      token._meteoraSurgeFired = true;
      token.lastAlertAt = now;
      token._lastAlertKind = 'meteora-surge';
      pushAlert(buildTrackedAlertEntry(token, now, symbol, 'meteora-surge', 'METEORA 1H', meteoraEntry?.change1h ?? 0, {
        meteoraCurrentTvl,
        meteoraBaselineTvl24h,
      }));
      setNotice(`Surge + Meteora Alert 1h: ${symbol}`);
    }
  }

  function hasLocalAlertCooldown(token: ManualTokenEntry, now: number) {
    return Boolean(token.lastAlertAt && now - token.lastAlertAt < STANDARD_ALERT_COOLDOWN_MS);
  }

  function evaluateVolumeLocalAlert(
    token: ManualTokenEntry,
    now: number,
    symbol: string,
    threshold: number,
    previousVol: number,
    previousMcap: number | null,
    currentVol: number,
    mcapDeclining: boolean,
  ) {
    const volChange = (currentVol - previousVol) / previousVol;
    const volPct = volChange * 100;
    const volEligible = isAlertKindEnabled('monitored-vol') && volChange >= threshold && passesAlertFilters(token) && !mcapDeclining;
    if (!volEligible) {
      token._volAlertAboveThreshold = false;
      return null;
    }

    const canRepeatVol = token._lastVolAlertPct != null && volPct >= token._lastVolAlertPct + REPEAT_LOCAL_ALERT_STEP_PCT;
    if (token._volAlertAboveThreshold && !canRepeatVol) {
      return null;
    }

    return {
      firedKind: 'vol' as const,
      alert: buildTrackedAlertEntry(token, now, symbol, 'monitored-vol', 'VOL', volPct, {
        prevVolume5m: previousVol,
        prevMcap: previousMcap,
      }),
    };
  }

  function evaluateMcapLocalAlert(
    token: ManualTokenEntry,
    now: number,
    symbol: string,
    mcapThreshold: number,
    previousVol: number | null,
    previousMcap: number,
    currentMcap: number,
  ) {
    if (typeof token.createdAt === 'number' && token.createdAt > 0) {
      const tokenAgeMs = now - token.createdAt;
      if (tokenAgeMs < MCAP_ALERT_MIN_TOKEN_AGE_MS) {
        token._mcapAlertAboveThreshold = false;
        return null;
      }
    }

    const mcapChange = (currentMcap - previousMcap) / previousMcap;
    const mcapPct = mcapChange * 100;
    const mcapEligible = isAlertKindEnabled('monitored-mcap') && mcapChange >= mcapThreshold && passesAlertFilters(token);
    if (!mcapEligible) {
      token._mcapAlertAboveThreshold = false;
      return null;
    }

    const canRepeatMcap = token._lastMcapAlertPct != null && mcapPct >= token._lastMcapAlertPct + REPEAT_LOCAL_ALERT_STEP_PCT;
    if (token._mcapAlertAboveThreshold && !canRepeatMcap) {
      return null;
    }

    return {
      firedKind: 'mcap' as const,
      alert: buildTrackedAlertEntry(token, now, symbol, 'monitored-mcap', 'MCAP', mcapPct, {
        prevVolume5m: previousVol,
        prevMcap: previousMcap,
      }),
    };
  }

  function applyLocalAlertState(token: ManualTokenEntry, alert: AlertEntry, firedKind: 'vol' | 'mcap', now: number) {
    token.lastAlertAt = now;
    if (firedKind === 'vol') {
      token._volAlertAboveThreshold = true;
      token._lastVolAlertPct = alert.pct;
      token._lastAlertKind = 'monitored-vol';
      return;
    }

    token._mcapAlertAboveThreshold = true;
    token._lastMcapAlertPct = alert.pct;
    token._lastAlertKind = 'monitored-mcap';
  }

  function resolveLocalAlertCandidate(
    token: ManualTokenEntry,
    now: number,
    symbol: string,
    threshold: number,
    mcapThreshold: number,
    previousVol: number | null,
    previousMcap: number | null,
    currentVol: number,
    currentMcap: number,
  ) {
    const mcapDeclining = previousMcap != null && previousMcap > 0 && currentMcap > 0 && currentMcap < previousMcap;

    if (previousVol != null && previousVol > 0) {
      const volumeCandidate = evaluateVolumeLocalAlert(token, now, symbol, threshold, previousVol, previousMcap, currentVol, mcapDeclining);
      if (volumeCandidate) {
        return volumeCandidate;
      }
    }

    if (mcapThreshold > 0 && previousMcap != null && previousMcap > 0) {
      return evaluateMcapLocalAlert(token, now, symbol, mcapThreshold, previousVol, previousMcap, currentMcap);
    }

    return null;
  }

  function maybeFireLocalAlert(token: ManualTokenEntry) {
    if (isBlocked(token.address, token.chain || 'solana')) {
      return;
    }
    if (shouldUseBackendOwnedMonitoredAlerts()) {
      return;
    }

    const now = Date.now();
    if (isCrossAlertBlocked(token, now)) {
      return;
    }
    const threshold = getConfigNumber('threshold', 50) / 100;
    const mcapThreshold = getConfigNumber('mcap-threshold', 50) / 100;
    const previousVol = token.prevVolume5m ?? null;
    const previousMcap = token.prevMcap ?? null;
    const currentVol = token.volume5m ?? 0;
    const currentMcap = token.mcap ?? 0;

    if (hasLocalAlertCooldown(token, now)) {
      return;
    }

    const symbol = getAlertSymbol(token);
    const localAlertCandidate = resolveLocalAlertCandidate(
      token,
      now,
      symbol,
      threshold,
      mcapThreshold,
      previousVol,
      previousMcap,
      currentVol,
      currentMcap,
    );

    if (localAlertCandidate) {
      applyLocalAlertState(token, localAlertCandidate.alert, localAlertCandidate.firedKind, now);
      pushAlert(localAlertCandidate.alert);
      setNotice(`Local monitored alert: ${symbol}`);
    }
  }
  function sortPinnedDashboardTokens(tokens: DashboardMonitoredToken[] = []) {
    return tokens
      .slice()
      .sort((a, b) => {
        const orderA = Number.isFinite(Number(a.pinnedSortOrder)) ? Number(a.pinnedSortOrder) : 0;
        const orderB = Number.isFinite(Number(b.pinnedSortOrder)) ? Number(b.pinnedSortOrder) : 0;
        return orderA - orderB || a.address.localeCompare(b.address);
      });
  }

  function mergeDashboardTokenSnapshots(
    monitoredDashboardTokens: DashboardMonitoredToken[] = [],
    pinnedDashboardTokens: DashboardMonitoredToken[] = [],
  ) {
    return Array.from(new Map(
      [...monitoredDashboardTokens, ...pinnedDashboardTokens]
        .map((item) => [getTrackedTokenKey(item.address, item.chain), item]),
    ).values());
  }

  function markPinnedTrackedToken(
    item: DashboardMonitoredToken,
    pinnedSortOrder: number | null,
    nextTrackedStore: Record<string, ManualTokenEntry>,
    monitoredMap: Map<string, ManualTokenEntry>,
  ) {
    const identityKey = getTrackedTokenKey(item.address, item.chain);
    const existingItem = nextTrackedStore[identityKey] || monitoredMap.get(identityKey);
    if (!existingItem) {
      return false;
    }

    const nextItem = {
      ...existingItem,
      _isPinnedMonitored: true,
      pinnedSortOrder,
    };
    nextTrackedStore[identityKey] = nextItem;
    monitoredMap.set(identityKey, nextItem);
    return true;
  }

  function finiteNumberOrNull(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function buildManualConfigTokenBase(item: ConfigPayload['tokens'][number], existingItem?: ManualTokenEntry) {
    const chain = resolveAppTokenChain(item.chain);
    return {
      ...existingItem,
      chain,
      address: item.address,
      label: firstDefinedTrackedValue(item.label, null),
      symbol: firstDefinedTrackedValue(item.symbol, existingItem?.symbol, null),
      name: firstDefinedTrackedValue(item.name, existingItem?.name, null),
      imageUrl: firstDefinedTrackedValue(
        item.imageUrl, item.last_image_url, existingItem?.imageUrl, null,
      ),
      priceUsd: firstDefinedTrackedValue(
        finiteNumberOrNull(item.last_price), existingItem?.priceUsd, null,
      ),
      mcap: chain === 'solana' ? finiteNumberOrNull(item.last_mcap) : null,
      fdv: chain === 'robinhood' ? finiteNumberOrNull(item.last_fdv) : null,
      valuationType: chain === 'robinhood' ? 'fdv' as const : 'market-cap' as const,
      liquidityUsd: finiteNumberOrNull(item.last_liquidity_usd),
      volume5m: finiteNumberOrNull(item.last_vol_5m),
      volume1h: finiteNumberOrNull(item.last_vol_1h),
      volume6h: finiteNumberOrNull(item.last_vol_6h),
      volume24h: finiteNumberOrNull(item.last_vol_24h),
      priceChange1h: finiteNumberOrNull(item.last_price_change_1h),
      priceChange6h: finiteNumberOrNull(item.last_price_change_6h),
      priceChange24h: finiteNumberOrNull(item.last_price_change_24h),
      createdAt: finiteNumberOrNull(item.last_token_created_at_ms),
      catalogFirstSeenAt: item.first_seen_at ? new Date(item.first_seen_at).getTime() : null,
      lastSeenAt: firstDefinedTrackedValue(item.last_seen_at, null),
      manual: true,
      _userManual: true,
      _isPinnedMonitored: false,
      pinnedSortOrder: null,
    };
  }

  function buildManualTrackedTokens(input: {
    payload: ConfigPayload;
    blockedSet: Set<string>;
    dashboardByIdentity: Map<string, DashboardMonitoredToken>;
    existing: Map<string, ManualTokenEntry>;
    nextTrackedStore: Record<string, ManualTokenEntry>;
    alertCandidates: Set<string>;
    coldRefreshDue: boolean;
  }) {
    return sortAddresses(input.payload.tokens)
      .filter((item) => !input.blockedSet.has(getTrackedTokenKey(item.address, item.chain || 'solana')))
      .map((item) => {
        const identityKey = getTrackedTokenKey(item.address, item.chain || 'solana');
        const existingItem = input.existing.get(identityKey);
        const dashboardItem = input.dashboardByIdentity.get(identityKey);
        if (existingItem) {
          input.alertCandidates.add(identityKey);
        }
        const mergedItem = mergeTrackedDashboardFields({
          existingItem,
          dashboardItem,
          base: buildManualConfigTokenBase(item, existingItem),
          coldRefreshDue: input.coldRefreshDue,
        });
        const nextItem = selectMergedTrackedToken(existingItem, mergedItem);
        input.nextTrackedStore[identityKey] = nextItem;
        return nextItem;
      });
  }

  function applyPinnedDashboardItems(input: {
    pinnedDashboardItems: DashboardMonitoredToken[];
    existing: Map<string, ManualTokenEntry>;
    nextTrackedStore: Record<string, ManualTokenEntry>;
    monitoredMap: Map<string, ManualTokenEntry>;
    alertCandidates: Set<string>;
    coldRefreshDue: boolean;
  }) {
    for (const item of input.pinnedDashboardItems) {
      if (markPinnedTrackedToken(
        item,
        item.pinnedSortOrder ?? null,
        input.nextTrackedStore,
        input.monitoredMap,
      )) {
        continue;
      }

      const identityKey = getTrackedTokenKey(item.address, item.chain);
      const existingItem = input.existing.get(identityKey);
      if (existingItem) {
        input.alertCandidates.add(identityKey);
      }
      const mergedItem = mergeTrackedDashboardFields({
        existingItem,
        dashboardItem: item,
        base: {
          ...existingItem,
          address: item.address,
          label: existingItem?.label ?? item.symbol ?? 'Pinned',
          manual: false,
          _userManual: false,
          _isPinnedMonitored: true,
          pinnedSortOrder: item.pinnedSortOrder ?? null,
        },
        coldRefreshDue: input.coldRefreshDue,
      });
      const nextItem = selectMergedTrackedToken(existingItem, mergedItem);
      input.nextTrackedStore[identityKey] = nextItem;
      input.monitoredMap.set(identityKey, nextItem);
    }
  }

  function applyRegularDashboardItems(input: {
    monitoredDashboardTokens: DashboardMonitoredToken[];
    blockedSet: Set<string>;
    existing: Map<string, ManualTokenEntry>;
    nextTrackedStore: Record<string, ManualTokenEntry>;
    monitoredMap: Map<string, ManualTokenEntry>;
    alertCandidates: Set<string>;
    coldRefreshDue: boolean;
  }) {
    for (const item of input.monitoredDashboardTokens
      .slice()
      .sort((a, b) => a.address.localeCompare(b.address))) {
      const identityKey = getTrackedTokenKey(item.address, item.chain);
      if (input.blockedSet.has(identityKey)) continue;
      if (input.monitoredMap.has(identityKey)) continue;
      const existingItem = input.existing.get(identityKey);
      if (existingItem) {
        input.alertCandidates.add(identityKey);
      }
      const mergedItem = mergeTrackedDashboardFields({
        existingItem,
        dashboardItem: item,
        base: {
          ...existingItem,
          address: item.address,
          label: existingItem?.label ?? item.symbol ?? 'Eligible',
          manual: false,
          _userManual: false,
          _isPinnedMonitored: false,
          pinnedSortOrder: null,
        },
        coldRefreshDue: input.coldRefreshDue,
      });
      const nextItem = selectMergedTrackedToken(existingItem, mergedItem);
      input.nextTrackedStore[identityKey] = nextItem;
      input.monitoredMap.set(identityKey, nextItem);
    }
  }

  function rebuildTrackedState(
    payload: ConfigPayload,
    monitoredDashboardTokens: DashboardMonitoredToken[] = [],
    pinnedDashboardTokens: DashboardMonitoredToken[] = [],
  ) {
    const effectivePinnedDashboardTokens = monitoredPinMutationInFlight
      ? getCurrentPinnedMonitoredDashboardSnapshot()
      : pinnedDashboardTokens;
    const existing = new Map(
      Object.entries(state.data.trackedTokensByIdentity).length > 0
        ? Object.entries(state.data.trackedTokensByIdentity)
        : getMonitoredTokens(state).map((item) => [getTrackedTokenKey(item.address, item.chain), item]),
    );
    const blockedSet = new Set(payload.blocklist.map((item) => (
      getTrackedTokenKey(item.address, item.chain || 'solana')
    )));
    const allDashboardTokens = mergeDashboardTokenSnapshots(monitoredDashboardTokens, effectivePinnedDashboardTokens);
    const dashboardByIdentity = new Map(allDashboardTokens.map((item) => [
      getTrackedTokenKey(item.address, item.chain),
      item,
    ]));
    const retainedIdentities = new Set([
      ...state.data.topPerformerIdentities,
      ...state.data.recentTokenIdentities,
      ...state.data.oldWeekTokenIdentities,
    ]);
    const nextTrackedStore: Record<string, ManualTokenEntry> = Object.fromEntries(
      [...existing.entries()].filter(([identityKey]) => retainedIdentities.has(identityKey)),
    );
    const now = Date.now();
    const coldRefreshDue = allDashboardTokens.length > 0 && now >= nextColdFieldRefreshAt;
    const alertCandidates = new Set<string>();
    const pinnedDashboardItems = sortPinnedDashboardTokens(effectivePinnedDashboardTokens)
      .filter((item) => !blockedSet.has(getTrackedTokenKey(item.address, item.chain)));
    const pinnedIdentities = pinnedDashboardItems.map((item) => getTrackedTokenKey(item.address, item.chain));

    const manualTokens = buildManualTrackedTokens({
      payload,
      blockedSet,
      dashboardByIdentity,
      existing,
      nextTrackedStore,
      alertCandidates,
      coldRefreshDue,
    });
    const monitoredMap = new Map<string, ManualTokenEntry>();
    for (const item of manualTokens) {
      monitoredMap.set(getTokenIdentityKey(item), item);
    }

    applyPinnedDashboardItems({
      pinnedDashboardItems,
      existing,
      nextTrackedStore,
      monitoredMap,
      alertCandidates,
      coldRefreshDue,
    });
    applyRegularDashboardItems({
      monitoredDashboardTokens,
      blockedSet,
      existing,
      nextTrackedStore,
      monitoredMap,
      alertCandidates,
      coldRefreshDue,
    });

    commitTrackedStateRebuild({
      nextTrackedStore,
      manualTokens,
      monitoredMap,
      pinnedIdentities,
      alertCandidates,
      coldRefreshDue,
      now,
    });
  }

  function applyHistoryMonitoredSnapshot(tokens: DashboardMonitoredToken[], generatedAt?: string | null) {
    applyMonitoredDashboard(tokens, undefined, generatedAt ?? null, getCurrentPinnedMonitoredDashboardSnapshot());
    if (isLiveWorkspace()) {
      emit('monitored', 'manual', 'recent', 'old-week', 'header');
      return;
    }
    emit('recent', 'old-week', 'bid-zone', 'header');
  }

  function buildCandidateIdentityFields(
    item: BidZonePayload['candidates'][number],
  ) {
    return {
      address: item.address,
      symbol: item.symbol ?? null,
      name: item.name ?? null,
      pairAddress: item.pairAddress ?? null,
      pairUrl: item.pairUrl ?? null,
      imageUrl: item.imageUrl ?? null,
      twitterUrl: item.twitterUrl ?? null,
      communityUrl: item.communityUrl ?? null,
      monitorPriority: item.monitorPriority ?? null,
      mcap: item.mcap ?? null,
      catalogMcap: item.catalogMcap ?? null,
      windowMcap: item.windowMcap ?? null,
      volume1h: item.volume1h ?? null,
      volume6h: item.volume6h ?? null,
      volume24h: item.volume24h ?? null,
    };
  }

  function buildCandidateMetricFields(
    item: BidZonePayload['candidates'][number],
  ) {
    return {
      coverageRatio: item.coverageRatio ?? null,
      bucketCount: item.bucketCount ?? 0,
      sampleCount: item.sampleCount ?? 0,
      expectedBucketCount: item.expectedBucketCount ?? 0,
      ageHours: item.ageHours ?? null,
      requestedHours: item.requestedHours ?? undefined,
      minimumWindowHours: item.minimumWindowHours ?? 0,
      windowHoursUsed: item.windowHoursUsed ?? 0,
      score: item.score ?? null,
    };
  }

  function buildBidZoneSpecificFields(item: BidZonePayload['candidates'][number]) {
    return {
      supportLevelMcap: item.supportLevelMcap ?? null,
      resistanceLevelMcap: item.resistanceLevelMcap ?? null,
      robustRangePct: item.robustRangePct ?? null,
      recentRangePct: item.recentRangePct ?? null,
      closeDriftPct: item.closeDriftPct ?? null,
      supportDistancePct: item.supportDistancePct ?? null,
      resistanceDistancePct: item.resistanceDistancePct ?? null,
      supportTouchClusters: item.supportTouchClusters ?? 0,
    };
  }

  function buildBidZoneTokenEntry(item: BidZonePayload['candidates'][number]): BidZoneTokenEntry {
    return {
      ...buildCandidateIdentityFields(item),
      ...buildCandidateMetricFields(item),
      ...buildBidZoneSpecificFields(item),
    };
  }

  function applyBidZonePayload(payload: BidZonePayload) {
    state.data.bidZoneTokens = (payload.candidates || []).map(buildBidZoneTokenEntry);
    updateBidZoneFreshness(payload.generatedAt ?? null);
    updateBidZoneRefreshAvailability(payload.refreshAvailableAt ?? null);
    state.panels.bidZone = state.data.bidZoneTokens.length;
    state.runtime.bidZoneRevision += 1;
    emit('bid-zone');
  }

  function queueSupplementalMeteoraRefresh(
    token: string,
    monitoredDashboardTokens: DashboardMonitoredToken[] = [],
  ) {
    if (isLiveWorkspaceHiddenForUiWork()) {
      return;
    }

    if (supplementalMeteoraRefreshInFlight) {
      return;
    }

    supplementalMeteoraRefreshInFlight = true;
    void refreshSupplementalMeteoraState(token, monitoredDashboardTokens)
      .catch(() => null)
      .finally(() => {
        supplementalMeteoraRefreshInFlight = false;
      });
  }

  function clearHistorySparklineCache(options?: { debugReason?: string; resetSchedule?: boolean }) {
    const hasEntries = Object.keys(state.data.sparklineByAddress).length > 0;
    recordSparklineDebug('cache.clear', {
      reason: options?.debugReason ?? 'unspecified',
      hadEntries: hasEntries,
      resetSchedule: options?.resetSchedule !== false,
    });
    state.data.sparklineByAddress = {};
    lastSparklineAddressKey = '';
    lastSparklineVisibleAddresses = [];
    if (options?.resetSchedule !== false) {
      nextSparklineRefreshAt = 0;
    }
    if (hasEntries) {
      emit('top-performers', 'manual', 'monitored', 'recent', 'old-week');
    }
  }

  function getChartCapableIdentity(chain: unknown, address: unknown) {
    try {
      const identity = createLegacyCompatibleTokenIdentity(chain, address);
      return state.data.chainReadiness[identity.chain]?.capabilities.charts === true
        ? identity
        : null;
    } catch (_) {
      return null;
    }
  }

  function getVisibleManualSparklineIdentities() {
    const selected: TokenIdentity[] = [];
    const seen = new Set<string>();
    for (const identityKey of state.data.topPerformerIdentities) {
      const identity = parseTokenIdentityKey(identityKey);
      if (
        state.data.chainReadiness[identity.chain]?.capabilities.charts !== true
        || seen.has(identity.key)
      ) {
        continue;
      }
      seen.add(identity.key);
      selected.push(identity);
    }

    for (const item of resolveManualTableRows(getManualTokens(state), {
      starredOnly: state.ui.manualStarredOnly,
      starredTokens: state.data.starredTokenIdentities,
      searchQuery: state.ui.manualSearchQuery,
      sortCriteria: state.ui.manualSorts,
    })
      .slice(0, SPARKLINE_VISIBLE_LIMIT_MANUAL)) {
      const identity = getChartCapableIdentity(item.chain, item.address);
      if (!identity || seen.has(identity.key)) {
        continue;
      }
      seen.add(identity.key);
      selected.push(identity);
    }

    return selected;
  }

  function getVisibleMonitoredSparklineIdentities() {
    if (state.ui.livePanelLayout.spans.monitored <= 1) {
      return [];
    }

    const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
    const filteredTracked = resolveMonitoredTableRows(getMonitoredTokens(state), {
      searchQuery: state.ui.monitoredSearchQuery,
      sortCriteria: state.ui.monitoredSorts,
    });
    const totalPages = Math.max(1, Math.ceil(filteredTracked.length / safePerPage));
    const safePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), totalPages - 1);
    const start = safePage * safePerPage;
    return filteredTracked
      .slice(start, start + safePerPage)
      .map((item) => getChartCapableIdentity(item.chain, item.address))
      .filter((identity): identity is TokenIdentity => Boolean(identity));
  }

  function getVisibleRoutedHistorySparklineIdentityScopes() {
    const recentIdentities = getRecentTokens(state)
      .map((token) => getChartCapableIdentity(token.chain, token.address))
      .filter((identity): identity is TokenIdentity => Boolean(identity));
    const oldWeekIdentities = getOldWeekTokens(state)
      .map((token) => getChartCapableIdentity(token.chain, token.address))
      .filter((identity): identity is TokenIdentity => Boolean(identity));
    const selected: Array<{ identity: TokenIdentity; scope: SparklineRangeScope }> = [];
    const seen = new Set<string>();
    const maxLength = Math.max(recentIdentities.length, oldWeekIdentities.length);

    for (let index = 0; index < maxLength && selected.length < SPARKLINE_VISIBLE_LIMIT_TOTAL; index += 1) {
      const recentIdentity = recentIdentities[index];
      if (recentIdentity && !seen.has(recentIdentity.key)) {
        seen.add(recentIdentity.key);
        selected.push({ identity: recentIdentity, scope: 'recent' });
      }

      if (selected.length >= SPARKLINE_VISIBLE_LIMIT_TOTAL) {
        break;
      }

      const oldWeekIdentity = oldWeekIdentities[index];
      if (oldWeekIdentity && !seen.has(oldWeekIdentity.key)) {
        seen.add(oldWeekIdentity.key);
        selected.push({ identity: oldWeekIdentity, scope: 'oldWeek' });
      }
    }

    return selected;
  }

  function getTokenSparklineRangeDays(identity: TokenIdentity) {
    const days = state.ui.sparklineRange.tokenDaysByAddress[identity.key]
      ?? (identity.chain === 'solana'
        ? state.ui.sparklineRange.tokenDaysByAddress[identity.address]
        : null);
    return Number.isFinite(Number(days)) ? normalizeSparklineRangeDays(days) : null;
  }

  function getSparklineRangeDays(scope: SparklineRangeScope, identity?: TokenIdentity) {
    const tokenDays = identity ? getTokenSparklineRangeDays(identity) : null;
    if (tokenDays != null) {
      return tokenDays;
    }

    const range = state.ui.sparklineRange;
    if (range.global) {
      return normalizeSparklineRangeDays(range.globalDays);
    }
    if (scope === 'recent') {
      return normalizeSparklineRangeDays(range.recentDays);
    }
    if (scope === 'oldWeek') {
      return normalizeSparklineRangeDays(range.oldWeekDays);
    }
    return normalizeSparklineRangeDays(range.monitoredDays);
  }

  function getVisibleWorkspaceSparklineIdentityScopes() {
    if (isLiveWorkspace()) {
      const selected: Array<{ identity: TokenIdentity; scope: SparklineRangeScope }> = [];
      const seen = new Set<string>();
      for (const identity of getVisibleMonitoredSparklineIdentities()) {
        if (seen.has(identity.key)) {
          continue;
        }
        seen.add(identity.key);
        selected.push({ identity, scope: 'monitored' });
      }
      for (const identity of getVisibleManualSparklineIdentities()) {
        if (seen.has(identity.key)) {
          continue;
        }
        seen.add(identity.key);
        selected.push({ identity, scope: 'monitored' });
      }
      return selected;
    }
    if (isHistoryWorkspace()) {
      return getVisibleRoutedHistorySparklineIdentityScopes();
    }
    return [];
  }

  function getVisibleWorkspaceSparklineBatches(referenceTs = Date.now()) {
    const grouped = new Map<string, SparklineBatchRequest>();
    const selectedIdentities = getVisibleWorkspaceSparklineIdentityScopes();

    for (const { identity, scope } of selectedIdentities) {
      const trackedToken = getTrackedToken(state, identity.address, identity.chain);
      const sparklineAnchorAt = trackedToken?.createdAt ?? null;
      const rangeDays = getSparklineRangeDays(scope, identity);
      const hours = rangeDays * 24;
      const granularityMinutes = resolveWorkspaceSparklineGranularityMinutes({
        anchorAt: sparklineAnchorAt,
        rangeDays,
        referenceTs,
      });
      const key = `${hours}:${granularityMinutes}`;
      const batch = grouped.get(key);
      if (batch?.identities.some((item) => item.key === identity.key)) {
        continue;
      }
      if (batch) {
        batch.identities.push(identity);
        continue;
      }

      grouped.set(key, {
        hours,
        granularityMinutes,
        identities: [identity],
      });
    }

    return splitWorkspaceSparklineBatchesByChain(Array.from(grouped.values()))
      .sort((left, right) => left.hours - right.hours || left.granularityMinutes - right.granularityMinutes)
      .filter((item) => item.identities.length > 0);
  }

  function resolveAlertSparklineCreatedAt(alertId: string, address: string) {
    const trackedToken = getTrackedToken(state, address);
    const catalogFirstSeenAt = Number(trackedToken?.catalogFirstSeenAt);
    if (Number.isFinite(catalogFirstSeenAt) && catalogFirstSeenAt > 0) {
      return catalogFirstSeenAt;
    }

    const matchingAlert = state.data.alerts.find((item) => item.id === alertId);
    const alertCreatedAt = Number(matchingAlert?.tokenCreatedAt);
    if (Number.isFinite(alertCreatedAt) && alertCreatedAt > 0) {
      return alertCreatedAt;
    }

    const trackedCreatedAt = Number(trackedToken?.createdAt);
    if (Number.isFinite(trackedCreatedAt) && trackedCreatedAt > 0) {
      return trackedCreatedAt;
    }

    return null;
  }

  function resolveAlertSparklineGranularityMinutes(anchorAt?: number | null, referenceTs = Date.now()) {
    const anchorAtMs = Number(anchorAt);
    if (!Number.isFinite(anchorAtMs) || anchorAtMs <= 0 || anchorAtMs > referenceTs) {
      return SPARKLINE_GRANULARITY_FALLBACK_MINUTES;
    }

    const ageMs = Math.max(0, referenceTs - anchorAtMs);
    if (ageMs < SPARKLINE_AGE_1M_MAX_MS) {
      return 1;
    }
    if (ageMs < SPARKLINE_AGE_5M_MAX_MS) {
      return 5;
    }
    if (ageMs < SPARKLINE_AGE_15M_MAX_MS) {
      return 15;
    }
    return 30;
  }

  function getPendingAlertSparklineBatches(referenceTs = Date.now()) {
    const grouped = new Map<number, { addresses: string[]; alertIdsByAddress: Map<string, string[]> }>();
    const activeAlertIds = getActiveAlertIdSet();
    const pendingRequests = [...pendingAlertSparklineRequests.entries()]
      .filter(([alertId, address]) => activeAlertIds.has(alertId) && Boolean(String(address || '').trim()));

    for (const [alertId, address] of pendingRequests) {
      const granularityMinutes = resolveAlertSparklineGranularityMinutes(
        resolveAlertSparklineCreatedAt(alertId, address),
        referenceTs,
      );

      let batch = grouped.get(granularityMinutes);
      if (!batch) {
        batch = {
          addresses: [],
          alertIdsByAddress: new Map<string, string[]>(),
        };
        grouped.set(granularityMinutes, batch);
      }

      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) {
        continue;
      }

      const alertIds = batch.alertIdsByAddress.get(normalizedAddress) || [];
      if (!alertIds.includes(alertId)) {
        batch.alertIdsByAddress.set(normalizedAddress, [...alertIds, alertId]);
      }
      if (!batch.addresses.includes(normalizedAddress)) {
        batch.addresses.push(normalizedAddress);
      }
    }

    return [1, 5, 15, 30]
      .map((granularityMinutes) => ({
        granularityMinutes,
        addresses: grouped.get(granularityMinutes)?.addresses || [],
        alertIdsByAddress: grouped.get(granularityMinutes)?.alertIdsByAddress || new Map<string, string[]>(),
      }))
      .filter((item) => item.addresses.length > 0);
  }

  function buildSparklineBatchKey(batches: SparklineBatchRequest[]) {
    return batches
      .map((item) => `${item.hours}:${item.granularityMinutes}:${item.identities.map((identity) => identity.key).sort().join(',')}`)
      .join('|');
  }

  function collectWorkspaceSparklineIdentities(batches: SparklineBatchRequest[]) {
    const identities: TokenIdentity[] = [];
    const seen = new Set<string>();

    for (const batch of batches) {
      for (const identity of batch.identities) {
        if (seen.has(identity.key)) {
          continue;
        }
        seen.add(identity.key);
        identities.push(identity);
      }
    }

    return identities;
  }

  function hasRenderableSparklineSeries(entry?: TokenSparklineEntry | null) {
    const series = Array.isArray(entry?.series) ? entry.series : [];
    return series.length >= 2;
  }

  function readWorkspaceSparklineCacheEntry(
    cache: Record<string, TokenSparklineEntry>,
    identity: TokenIdentity,
  ) {
    return cache[identity.key]
      || (identity.chain === 'solana' ? cache[identity.address] : undefined);
  }

  function writeWorkspaceSparklineCacheEntry(
    cache: Record<string, TokenSparklineEntry>,
    identity: TokenIdentity,
    entry: TokenSparklineEntry,
  ) {
    cache[identity.key] = entry;
    if (identity.chain === 'solana') cache[identity.address] = entry;
  }

  function deleteWorkspaceSparklineCacheEntry(
    cache: Record<string, TokenSparklineEntry>,
    identity: TokenIdentity,
  ) {
    delete cache[identity.key];
    if (identity.chain === 'solana') delete cache[identity.address];
  }

  function buildWorkspaceSparklineLoadingEntry(
    identity: TokenIdentity,
    existing?: TokenSparklineEntry,
    hours?: number,
  ) {
    return {
      ...(existing || { address: identity.address, series: [] }),
      chain: identity.chain,
      address: identity.address,
      series: [],
      hours: Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : existing?.hours,
      loading: true,
    } satisfies TokenSparklineEntry;
  }

  function ensureWorkspaceSparklineLoadingEntries(identities: TokenIdentity[]) {
    let nextCache: Record<string, TokenSparklineEntry> | null = null;
    let changed = false;
    const addedLoading: string[] = [];
    const addedDetails: Array<{
      address: string;
      hadEntry: boolean;
      seriesCount: number;
      loading: boolean;
      hours?: number;
    }> = [];

    for (const identity of identities) {
      const cache = nextCache || state.data.sparklineByAddress;
      const existing = readWorkspaceSparklineCacheEntry(cache, identity);
      if (hasRenderableSparklineSeries(existing) || existing?.loading) {
        continue;
      }

      nextCache ||= { ...state.data.sparklineByAddress };
      writeWorkspaceSparklineCacheEntry(
        nextCache,
        identity,
        buildWorkspaceSparklineLoadingEntry(identity, existing),
      );
      changed = true;
      addedLoading.push(identity.key);
      if (addedDetails.length < 8) {
        addedDetails.push({
          address: identity.key,
          hadEntry: Boolean(existing),
          seriesCount: Array.isArray(existing?.series) ? existing.series.length : 0,
          loading: Boolean(existing?.loading),
          hours: existing?.hours,
        });
      }
    }

    if (!nextCache || !changed) {
      return false;
    }

    state.data.sparklineByAddress = nextCache;
    recordSparklineDebug('loading.add', {
      added: summarizeSparklineDebugAddresses(addedLoading),
      requested: summarizeSparklineDebugAddresses(identities.map((identity) => identity.key)),
      addedDetails,
    });
    recordSparklineDebug('loading.without-series', {
      added: summarizeSparklineDebugAddresses(addedLoading),
      addedDetails,
    });
    return true;
  }

  function clearWorkspaceSparklineLoadingEntries(identities: Iterable<TokenIdentity>) {
    let nextCache: Record<string, TokenSparklineEntry> | null = null;
    let changed = false;
    const clearedLoading: string[] = [];

    for (const identity of identities) {
      const existing = readWorkspaceSparklineCacheEntry(
        nextCache || state.data.sparklineByAddress,
        identity,
      );
      if (!existing?.loading || hasRenderableSparklineSeries(existing)) {
        continue;
      }

      nextCache ||= { ...state.data.sparklineByAddress };
      deleteWorkspaceSparklineCacheEntry(nextCache, identity);
      changed = true;
      clearedLoading.push(identity.key);
    }

    if (!nextCache || !changed) {
      return false;
    }

    state.data.sparklineByAddress = nextCache;
    recordSparklineDebug('loading.clear', {
      addresses: summarizeSparklineDebugAddresses(clearedLoading),
    });
    return true;
  }

  function isWorkspaceSparklineSessionValid(token: string) {
    return state.session.token === token && isAuthenticatedSession() && (isHistoryWorkspace() || isLiveWorkspace());
  }

  function handleWorkspaceSparklineRefreshFailure(visibleIdentities: TokenIdentity[], error: unknown) {
    if (clearWorkspaceSparklineLoadingEntries(visibleIdentities)) {
      emit('top-performers', 'manual', 'monitored', 'recent', 'old-week');
    }

    console.warn('[AppController] Failed to refresh monitor sparklines:', error instanceof Error ? error.message : error);
  }

  function buildHistorySparklineChainMetadata(item: TokenSparklinesPayload['items'][number]) {
    return {
      chain: item.chain,
      valuationType: item.valuationType ?? null,
      resolution: item.resolution ?? null,
      minuteStartsAt: item.minuteStartsAt ?? null,
      truncated: item.truncated === true,
    };
  }

  function buildHistorySparklineCacheEntry(
    item: TokenSparklinesPayload['items'][number] | null | undefined,
    payload: TokenSparklinesPayload,
    refreshedAt = Date.now(),
  ) {
    if (!item?.address) {
      return null;
    }

    const series = Array.isArray(item.series) ? item.series : [];
    return {
      ...buildHistorySparklineChainMetadata(item),
      address: item.address,
      pairAddress: item.pairAddress ?? null,
      bucketCount: Number(item.bucketCount) || 0,
      coverageRatio: item.coverageRatio ?? null,
      effectiveHours: item.effectiveHours ?? null,
      granularityMinutes: item.granularityMinutes ?? payload.granularityMinutes ?? SPARKLINE_GRANULARITY_FALLBACK_MINUTES,
      firstBucketAt: item.firstBucketAt ?? null,
      latestBucketAt: item.latestBucketAt ?? null,
      oneMinuteAvailable: item.oneMinuteAvailable === true,
      generatedAt: payload.generatedAt ?? null,
      refreshedAt,
      hours: Number(payload.hours) || SPARKLINE_WINDOW_HOURS,
      points: Number(payload.points) || SPARKLINE_POINT_COUNT,
      series,
      candles: Array.isArray(item.candles) ? item.candles : [],
      loading: false,
    } satisfies TokenSparklineEntry;
  }

  function applyHistorySparklinePayload(payload: TokenSparklinesPayload, expectedBatch?: SparklineBatchRequest) {
    const nextCache: Record<string, TokenSparklineEntry> = { ...state.data.sparklineByAddress };
    const refreshedAt = Date.now();
    const returnedKeys = new Set<string>();
    let changed = false;
    for (const item of payload.items || []) {
      const entry = buildHistorySparklineCacheEntry(item, payload, refreshedAt);
      if (!entry) {
        continue;
      }
      const identity = createLegacyCompatibleTokenIdentity(entry.chain, entry.address);
      writeWorkspaceSparklineCacheEntry(nextCache, identity, entry);
      returnedKeys.add(identity.key);
      changed = true;
    }

    for (const identity of expectedBatch?.identities || []) {
      if (returnedKeys.has(identity.key)) {
        continue;
      }
      writeWorkspaceSparklineCacheEntry(nextCache, identity, {
        chain: identity.chain,
        address: identity.address,
        generatedAt: payload.generatedAt ?? null,
        refreshedAt,
        hours: expectedBatch?.hours,
        points: Number(payload.points) || SPARKLINE_POINT_COUNT,
        granularityMinutes: expectedBatch?.granularityMinutes,
        series: [],
        loading: false,
      });
      changed = true;
    }

    if (!changed) {
      return;
    }

    state.data.sparklineByAddress = nextCache;
    const historySparklineRegions: AppRenderRegion[] = ['top-performers', 'manual', 'monitored', 'recent', 'old-week'];
    if (state.ui.expandedSparklineAddress) {
      for (const region of historySparklineRegions) {
        deferredExpandedSparklineRenderRegions.add(region);
      }
      return;
    }
    emit(...historySparklineRegions);
  }

  function buildExpandedSparklineCacheEntry(
    item: TokenSparklinesPayload['items'][number] | null | undefined,
    generatedAt?: string | null,
    points?: number | null,
  ) {
    if (!item) {
      return null;
    }
    const address = String(item.address || '').trim();
    if (!address) {
      return null;
    }

    const series = normalizeAlertSparklineSeries(item.series);
    return {
      chain: item.chain || 'solana',
      address,
      valuationType: item.valuationType ?? null,
      resolution: item.resolution ?? null,
      minuteStartsAt: item.minuteStartsAt ?? null,
      truncated: item.truncated === true,
      pairAddress: item.pairAddress ?? null,
      bucketCount: Number(item.bucketCount) || 0,
      coverageRatio: toOptionalSparklineNumber(item.coverageRatio),
      effectiveHours: toOptionalSparklineNumber(item.effectiveHours),
      granularityMinutes: resolveSparklineCount(item.granularityMinutes, SPARKLINE_GRANULARITY_FALLBACK_MINUTES),
      firstBucketAt: toOptionalSparklineString(item.firstBucketAt),
      latestBucketAt: toOptionalSparklineString(item.latestBucketAt),
      oneMinuteAvailable: item.oneMinuteAvailable === true,
      generatedAt: toOptionalSparklineString(generatedAt),
      points: resolveSparklineCount(points, EXPANDED_SPARKLINE_POINT_COUNT),
      series,
      candles: Array.isArray(item.candles) ? item.candles : [],
      loading: false,
    } satisfies TokenSparklineEntry;
  }

  function normalizeExpandedSparklineGranularity(granularityMinutes: unknown) {
    const parsed = Math.round(Number(granularityMinutes));
    return EXPANDED_SPARKLINE_GRANULARITIES.includes(parsed as typeof EXPANDED_SPARKLINE_GRANULARITIES[number])
      ? parsed
      : EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
  }

  function normalizeExpandedChartTimeZone(timeZone: unknown) {
    const normalized = String(timeZone || '').trim();
    return EXPANDED_CHART_TIME_ZONES.includes(normalized as typeof EXPANDED_CHART_TIME_ZONES[number])
      ? normalized
      : EXPANDED_CHART_DEFAULT_TIME_ZONE;
  }

  function getActiveExpandedSparklineGranularity() {
    return normalizeExpandedSparklineGranularity(state.ui.expandedSparklineGranularityMinutes);
  }

  function getActiveExpandedSparklineIdentity() {
    if (!state.ui.expandedSparklineAddress) return null;
    return createLegacyCompatibleTokenIdentity(
      state.ui.expandedSparklineChain,
      state.ui.expandedSparklineAddress,
    );
  }

  function isActiveExpandedSparklineIdentity(identityKey: string) {
    return getActiveExpandedSparklineIdentity()?.key === identityKey;
  }

  function restorePreferredExpandedSparklineGranularity() {
    state.ui.expandedSparklineGranularityMinutes = preferredExpandedSparklineGranularityMinutes;
  }

  function isExpandedOneMinuteAgeEligible(
    address: string,
    now = Date.now(),
    chain: TokenChain = 'solana',
  ) {
    if (chain !== 'solana') return true;
    const token = getTrackedToken(state, address, chain);
    const createdAt = Number(token?.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now) {
      return false;
    }

    return now - createdAt < EXPANDED_SPARKLINE_ONE_MINUTE_MAX_AGE_MS;
  }

  function restorePreferredExpandedSparklineGranularityForAddress(
    address: string,
    chain: TokenChain = 'solana',
  ) {
    if (
      preferredExpandedSparklineGranularityMinutes === 1
      && !isExpandedOneMinuteAgeEligible(address, Date.now(), chain)
    ) {
      state.ui.expandedSparklineGranularityMinutes = EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
      return;
    }

    restorePreferredExpandedSparklineGranularity();
  }

  function isExpandedSparklineGranularityAvailable(
    address: string,
    granularityMinutes: number,
    chain: TokenChain = 'solana',
  ) {
    if (granularityMinutes !== 1) {
      return true;
    }
    if (!isExpandedOneMinuteAgeEligible(address, Date.now(), chain)) {
      return false;
    }

    const entry = getExpandedSparklineCacheEntry(
      address,
      EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES,
      chain,
    );
    return entry?.oneMinuteAvailable === true;
  }

  function isExpandedOneMinutePrefetchEligible(
    address: string,
    entry?: TokenSparklineEntry | null,
    now = Date.now(),
    chain: TokenChain = 'solana',
  ) {
    if (entry?.oneMinuteAvailable !== true) {
      return false;
    }

    return isExpandedOneMinuteAgeEligible(address, now, chain);
  }

  function getExpandedSparklineCacheKey(
    address: string,
    granularityMinutes = getActiveExpandedSparklineGranularity(),
    chain: TokenChain = 'solana',
  ) {
    const identity = createLegacyCompatibleTokenIdentity(chain, address);
    return `${identity.key}::${normalizeExpandedSparklineGranularity(granularityMinutes)}`;
  }

  function getExpandedSparklineCacheEntry(
    address: string,
    granularityMinutes = getActiveExpandedSparklineGranularity(),
    chain: TokenChain = 'solana',
  ) {
    const identity = createLegacyCompatibleTokenIdentity(chain, address);
    return state.data.expandedSparklineByAddress[getExpandedSparklineCacheKey(
      identity.address,
      granularityMinutes,
      identity.chain,
    )]
      || (identity.chain === 'solana'
        ? state.data.expandedSparklineByAddress[`${identity.address}::${granularityMinutes}`]
          || state.data.expandedSparklineByAddress[identity.address]
        : null)
      || null;
  }

  function floorLiveCandleBucketTs(bucketTs: string, granularityMinutes: number) {
    const timestampMs = Date.parse(bucketTs);
    if (!Number.isFinite(timestampMs)) {
      return null;
    }

    const bucketMs = Math.max(1, granularityMinutes) * 60 * 1000;
    return new Date(Math.floor(timestampMs / bucketMs) * bucketMs).toISOString();
  }

  function maxNullableNumber(left: number | null | undefined, right: number | null | undefined) {
    const values = [left, right].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? Math.max(...values) : null;
  }

  function minNullableNumber(left: number | null | undefined, right: number | null | undefined) {
    const values = [left, right].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? Math.min(...values) : null;
  }

  function firstPresent<T>(...values: Array<T | null | undefined>) {
    return values.find((value) => value != null) ?? null;
  }

  function mergeLiveClose<T>(
    existing: T | null | undefined,
    incoming: T | null | undefined,
    newerClose: boolean,
  ) {
    return newerClose ? firstPresent(incoming, existing) : firstPresent(existing);
  }

  function mergeLiveCandle(
    existing: TokenSparklineCandleEntry | null | undefined,
    incoming: TokenSparklineCandleEntry,
    granularityMinutes: number,
  ): TokenSparklineCandleEntry | null {
    const bucketTs = floorLiveCandleBucketTs(incoming.bucketTs, granularityMinutes);
    if (!bucketTs) {
      return null;
    }

    if (!existing) {
      return {
        ...incoming,
        bucketTs,
        granularityMinutes,
      };
    }

    const newerClose = shouldReplaceMarketCandleClose(
      existing.liveSourceBucketTs || existing.bucketTs,
      existing.liveSequence,
      incoming.liveSourceBucketTs || incoming.bucketTs,
      incoming.liveSequence,
    );
    return {
      ...existing,
      pairAddress: firstPresent(incoming.pairAddress, existing.pairAddress),
      granularityMinutes,
      openMcap: firstPresent(existing.openMcap, incoming.openMcap),
      highMcap: maxNullableNumber(existing.highMcap, incoming.highMcap),
      lowMcap: minNullableNumber(existing.lowMcap, incoming.lowMcap),
      closeMcap: mergeLiveClose(existing.closeMcap, incoming.closeMcap, newerClose),
      valuationType: firstPresent(incoming.valuationType, existing.valuationType),
      openFdvUsd: firstPresent(existing.openFdvUsd, incoming.openFdvUsd),
      highFdvUsd: maxNullableNumber(existing.highFdvUsd, incoming.highFdvUsd),
      lowFdvUsd: minNullableNumber(existing.lowFdvUsd, incoming.lowFdvUsd),
      closeFdvUsd: mergeLiveClose(existing.closeFdvUsd, incoming.closeFdvUsd, newerClose),
      openPrice: firstPresent(existing.openPrice, incoming.openPrice),
      highPrice: maxNullableNumber(existing.highPrice, incoming.highPrice),
      lowPrice: minNullableNumber(existing.lowPrice, incoming.lowPrice),
      closePrice: mergeLiveClose(existing.closePrice, incoming.closePrice, newerClose),
      openPriceUsd: firstPresent(existing.openPriceUsd, incoming.openPriceUsd),
      highPriceUsd: maxNullableNumber(existing.highPriceUsd, incoming.highPriceUsd),
      lowPriceUsd: minNullableNumber(existing.lowPriceUsd, incoming.lowPriceUsd),
      closePriceUsd: mergeLiveClose(existing.closePriceUsd, incoming.closePriceUsd, newerClose),
      sampleCount: Math.max(Number(existing.sampleCount) || 0, Number(incoming.sampleCount) || 0),
      liveSourceBucketTs: newerClose ? incoming.liveSourceBucketTs : existing.liveSourceBucketTs,
      liveSequence: newerClose ? incoming.liveSequence : existing.liveSequence,
    };
  }

  function mergeLiveCandleList(
    candles: TokenSparklineCandleEntry[],
    incoming: TokenSparklineCandleEntry,
    granularityMinutes: number,
    maxCandles: number,
  ) {
    const bucketTs = floorLiveCandleBucketTs(incoming.bucketTs, granularityMinutes);
    if (!bucketTs) {
      return null;
    }

    const nextCandles = candles.slice();
    const existingIndex = nextCandles.findIndex((candle) => candle.bucketTs === bucketTs);
    const merged = mergeLiveCandle(existingIndex >= 0 ? nextCandles[existingIndex] : null, incoming, granularityMinutes);
    if (!merged) {
      return null;
    }

    if (existingIndex >= 0) {
      nextCandles[existingIndex] = merged;
    } else {
      nextCandles.push(merged);
    }
    nextCandles.sort((left, right) => Date.parse(left.bucketTs) - Date.parse(right.bucketTs));
    return nextCandles.slice(-maxCandles);
  }

  function getLiveExpandedSparklineContext(payload: MarketBucketUpdateEvent) {
    const address = String(payload?.address || '').trim();
    const activeIdentity = getActiveExpandedSparklineIdentity();
    if (
      !address
      || !activeIdentity
      || activeIdentity.address !== address
      || activeIdentity.chain !== payload.chain
      || !payload?.candle
    ) {
      return null;
    }

    const granularityMinutes = getActiveExpandedSparklineGranularity();
    const cacheKey = getExpandedSparklineCacheKey(address, granularityMinutes, payload.chain);
    const entry = getExpandedSparklineCacheEntry(address, granularityMinutes, payload.chain);
    if (!entry || entry.loading || !Array.isArray(entry.candles)) {
      return null;
    }

    return { address, cacheKey, candles: entry.candles, entry, granularityMinutes };
  }

  function buildLiveExpandedSparklineEntry(payload: MarketBucketUpdateEvent) {
    const context = getLiveExpandedSparklineContext(payload);
    const liveCandle = buildLiveTokenChartCandle(payload);
    if (!context || !liveCandle) {
      return null;
    }

    const { address, cacheKey, candles, entry, granularityMinutes } = context;
    const maxCandles = Math.max(
      candles.length,
      EXPANDED_SPARKLINE_POINT_COUNT,
      Number(entry.points) || EXPANDED_SPARKLINE_POINT_COUNT
    );
    const visibleCandles = mergeLiveCandleList(candles, liveCandle, granularityMinutes, maxCandles);
    if (!visibleCandles) {
      return null;
    }

    const valuationType = liveCandle.valuationType ?? entry.valuationType;
    const series = visibleCandles
      .map((candle) => valuationType === 'fdv' ? candle.closeFdvUsd : candle.closeMcap)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    return {
      cacheKey,
      entry: {
        ...entry,
        chain: payload.chain,
        address,
        valuationType,
        pairAddress: payload.pairAddress ?? entry.pairAddress ?? null,
        granularityMinutes,
        generatedAt: payload.generatedAt || new Date().toISOString(),
        latestBucketAt: visibleCandles[visibleCandles.length - 1]?.bucketTs ?? entry.latestBucketAt ?? null,
        bucketCount: visibleCandles.length,
        series: series.length ? series : entry.series,
        candles: visibleCandles,
        loading: false,
      } satisfies TokenSparklineEntry,
    };
  }

  function applyLiveMarketBucketUpdate(payload: MarketBucketUpdateEvent) {
    const update = buildLiveExpandedSparklineEntry(payload);
    if (!update) {
      return;
    }

    state.data.expandedSparklineByAddress = {
      ...state.data.expandedSparklineByAddress,
      [update.cacheKey]: update.entry,
    };
    const latestCandle = update.entry.candles?.[update.entry.candles.length - 1];
    if (typeof window !== 'undefined' && latestCandle) {
      window.dispatchEvent(new CustomEvent('trendscope:expanded-chart-live-candle', {
        detail: { chain: payload.chain, address: update.entry.address, candle: latestCandle },
      }));
    }
  }

  function applyLiveTokenMarketUpdate(payload: MarketBucketUpdateEvent) {
    const existing = getTrackedToken(state, payload.address, payload.chain);
    const patch = buildRealtimeTokenMarketPatch(payload, getRealtimeActivityState(existing));
    if (!existing || !patch) return false;

    const currentSnapshotMs = resolveWorkspaceMarketSnapshotMs(existing) || 0;
    const currentObservedAt = existing._liveMarketObservedAt
      || (currentSnapshotMs > 0 ? new Date(currentSnapshotMs).toISOString() : null);
    if (currentObservedAt && !shouldReplaceMarketCandleClose(
      currentObservedAt,
      existing._liveMarketSequence,
      patch.observedAt,
      payload.sequence,
    )) {
      return false;
    }

    setTrackedToken({
      ...existing,
      priceUsd: patch.priceUsd ?? existing.priceUsd ?? null,
      fdv: patch.valuationType === 'fdv' ? patch.fdv : existing.fdv ?? null,
      mcap: patch.valuationType === 'market-cap' ? patch.mcap : existing.mcap ?? null,
      valuationType: patch.valuationType ?? existing.valuationType ?? null,
      valuation: patch.valuation ?? existing.valuation ?? null,
      ...buildRealtimeActivityFields(existing, patch.activity),
      lastActivityAt: patch.observedAt,
      lastSeenAt: patch.observedAt,
      activityState: patch.activityState,
      _liveMarketObservedAt: patch.observedAt,
      _liveMarketSequence: payload.sequence,
    });
    state.runtime.monitoredRevision += 1;
    emit('monitored', 'manual', 'recent', 'old-week', 'top-performers');
    return true;
  }

  function isExpandedSparklineCacheFresh(entry?: TokenSparklineEntry | null, now = Date.now()) {
    if (!entry || entry.loading || !hasRenderableSparklineSeries(entry)) {
      return false;
    }

    if ((Number(entry.points) || 0) < EXPANDED_SPARKLINE_POINT_COUNT) {
      return false;
    }

    const generatedAtMs = entry.generatedAt ? Date.parse(entry.generatedAt) : NaN;
    return Number.isFinite(generatedAtMs) && now - generatedAtMs < EXPANDED_SPARKLINE_FRONTEND_CACHE_MS;
  }

  function setExpandedSparklineLoading(
    address: string,
    seed?: TokenSparklineEntry | null,
    granularityMinutes = getActiveExpandedSparklineGranularity(),
    chain: TokenChain = 'solana',
  ) {
    const identity = createLegacyCompatibleTokenIdentity(chain, address);
    const compact = readWorkspaceSparklineCacheEntry(state.data.sparklineByAddress, identity);
    const cacheKey = getExpandedSparklineCacheKey(address, granularityMinutes, chain);
    const existing = state.data.expandedSparklineByAddress[cacheKey];
    if (existing?.loading) {
      return;
    }

    state.data.expandedSparklineByAddress = {
      ...state.data.expandedSparklineByAddress,
      [cacheKey]: {
        ...(existing || seed || compact || { address, series: [] }),
        chain: identity.chain,
        address,
        granularityMinutes,
        loading: true,
      },
    };
  }

  function seedExpandedSparklineFromAlert(alertId: string, address: string) {
    const normalized = String(address || '').trim();
    const alertSparkline = state.data.alertSparklineById[String(alertId || '').trim()];
    if (!normalized || !hasRenderableSparklineSeries(alertSparkline)) {
      return null;
    }

    const cacheKey = getExpandedSparklineCacheKey(normalized, undefined, 'solana');
    const existing = state.data.expandedSparklineByAddress[cacheKey];
    if (isExpandedSparklineCacheFresh(existing)) {
      return existing;
    }

    const seed = {
      ...alertSparkline,
      chain: 'solana',
      address: normalized,
      loading: false,
    } satisfies TokenSparklineEntry;
    state.data.expandedSparklineByAddress = {
      ...state.data.expandedSparklineByAddress,
      [cacheKey]: seed,
    };
    return seed;
  }

  function isCurrentExpandedSparklineRequest(
    address: string,
    chain: TokenChain,
    token: string,
    granularityMinutes: number,
    options?: { background?: boolean },
  ) {
    const activeIdentity = getActiveExpandedSparklineIdentity();
    return state.session.token === token
      && activeIdentity?.address === address
      && activeIdentity.chain === chain
      && (options?.background === true || getActiveExpandedSparklineGranularity() === granularityMinutes);
  }

  function writeExpandedSparklineFallbackEntry(
    address: string,
    cacheKey: string,
    granularityMinutes: number,
    oneMinuteAvailable = false,
    chain: TokenChain = 'solana',
  ) {
    const identity = createLegacyCompatibleTokenIdentity(chain, address);
    const compact = readWorkspaceSparklineCacheEntry(state.data.sparklineByAddress, identity);
    state.data.expandedSparklineByAddress = {
      ...state.data.expandedSparklineByAddress,
      [cacheKey]: {
        ...(state.data.expandedSparklineByAddress[cacheKey] || compact || { address, series: [] }),
        chain: identity.chain,
        granularityMinutes,
        oneMinuteAvailable,
        loading: false,
      },
    };
  }

  function maybePrefetchExpandedOneMinuteSparkline(
    address: string,
    requestToken: string,
    sourceGranularity: number,
    entry?: TokenSparklineEntry | null,
    chain: TokenChain = 'solana',
  ) {
    if (sourceGranularity === 1 || !isExpandedOneMinutePrefetchEligible(address, entry, Date.now(), chain)) {
      return;
    }
    if (isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(address, 1, chain))) {
      return;
    }

    void refreshExpandedSparkline(address, requestToken, 1, { background: true }, chain);
  }

  function fallbackExpandedOneMinuteToFiveMinutes(
    address: string,
    requestToken: string,
    options?: { background?: boolean },
    chain: TokenChain = 'solana',
  ) {
    if (options?.background === true || getActiveExpandedSparklineGranularity() !== 1) {
      return false;
    }

    state.ui.expandedSparklineGranularityMinutes = EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
    const fallbackGranularity = EXPANDED_SPARKLINE_DEFAULT_GRANULARITY_MINUTES;
    if (!isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(address, fallbackGranularity, chain))) {
      setExpandedSparklineLoading(address, null, fallbackGranularity, chain);
      void refreshExpandedSparkline(address, requestToken, fallbackGranularity, undefined, chain);
    }
    emit('overlay');
    return true;
  }

  async function refreshExpandedSparkline(
    address: string,
    token?: string | null,
    granularityMinutes = getActiveExpandedSparklineGranularity(),
    options?: { background?: boolean },
    chain: TokenChain = 'solana',
  ) {
    const identity = createLegacyCompatibleTokenIdentity(chain, address);
    const normalized = identity.address;
    const requestToken = token ?? state.session.token;
    const safeGranularity = normalizeExpandedSparklineGranularity(granularityMinutes);
    const cacheKey = getExpandedSparklineCacheKey(normalized, safeGranularity, identity.chain);
    if (!normalized || !requestToken || expandedSparklineRequests.has(cacheKey)) {
      return;
    }

    expandedSparklineRequests.add(cacheKey);
    try {
      const payload = await fetchExpandedTokenSparkline(normalized, {
        chain: identity.chain,
        points: EXPANDED_SPARKLINE_POINT_COUNT,
        granularityMinutes: safeGranularity,
      }, requestToken);
      if (!isCurrentExpandedSparklineRequest(
        normalized,
        identity.chain,
        requestToken,
        safeGranularity,
        options,
      )) {
        return;
      }

      const entry = buildExpandedSparklineCacheEntry(payload.item, payload.generatedAt, payload.points);
      if (!entry || !hasRenderableSparklineSeries(entry)) {
        if (
          safeGranularity === 1
          && fallbackExpandedOneMinuteToFiveMinutes(normalized, requestToken, options, identity.chain)
        ) {
          return;
        }
        const oneMinuteAvailable = payload.item?.oneMinuteAvailable === true;
        writeExpandedSparklineFallbackEntry(
          normalized,
          cacheKey,
          safeGranularity,
          oneMinuteAvailable,
          identity.chain,
        );
        emit('overlay');
        maybePrefetchExpandedOneMinuteSparkline(
          normalized,
          requestToken,
          safeGranularity,
          { chain: identity.chain, address: normalized, series: [], oneMinuteAvailable },
          identity.chain,
        );
        return;
      }

      state.data.expandedSparklineByAddress = {
        ...state.data.expandedSparklineByAddress,
        [cacheKey]: entry,
      };
      emit('overlay');
      maybePrefetchExpandedOneMinuteSparkline(
        normalized,
        requestToken,
        safeGranularity,
        entry,
        identity.chain,
      );
    } catch (error) {
      if (isActiveExpandedSparklineIdentity(identity.key)) {
        if (
          safeGranularity === 1
          && fallbackExpandedOneMinuteToFiveMinutes(normalized, requestToken, options, identity.chain)
        ) {
          return;
        }
        writeExpandedSparklineFallbackEntry(
          normalized,
          cacheKey,
          safeGranularity,
          false,
          identity.chain,
        );
        emit('overlay');
      }
      console.warn('[AppController] Failed to refresh expanded sparkline:', error instanceof Error ? error.message : error);
    } finally {
      expandedSparklineRequests.delete(cacheKey);
    }
  }

  function shouldBroadcastWorkspacePollingSnapshot() {
    return isWorkspacePollingSyncWorkspace() && isWorkspacePollingLeader();
  }

  function broadcastWorkspaceSparklineSnapshot(payload: TokenSparklinesPayload) {
    if (!shouldBroadcastWorkspacePollingSnapshot()) {
      return;
    }

    postHistorySyncMessage({
      type: 'sparkline-snapshot',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      payload,
      ts: Date.now(),
    });
  }

  function normalizeAlertSparklineSeries(series: unknown) {
    if (!Array.isArray(series)) {
      return [];
    }

    return series
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  }

  function toOptionalSparklineNumber(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function toOptionalSparklineString(value: unknown) {
    return typeof value === 'string' ? value : null;
  }

  function resolveSparklineCount(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function buildAlertSparklineCacheEntry(
    item: TokenSparklinesPayload['items'][number] | null | undefined,
    payload: TokenSparklinesPayload,
  ) {
    const address = String(item?.address || '').trim();
    if (!address) {
      return null;
    }

    const series = normalizeAlertSparklineSeries(item?.series);
    if (series.length < 2) {
      return null;
    }

    return {
      address,
      pairAddress: toOptionalSparklineString(item?.pairAddress),
      bucketCount: resolveSparklineCount(item?.bucketCount, 0),
      coverageRatio: toOptionalSparklineNumber(item?.coverageRatio),
      effectiveHours: toOptionalSparklineNumber(item?.effectiveHours),
      granularityMinutes: resolveSparklineCount(
        item?.granularityMinutes ?? payload.granularityMinutes,
        SPARKLINE_GRANULARITY_FALLBACK_MINUTES,
      ),
      firstBucketAt: toOptionalSparklineString(item?.firstBucketAt),
      latestBucketAt: toOptionalSparklineString(item?.latestBucketAt),
      generatedAt: toOptionalSparklineString(payload.generatedAt),
      hours: resolveSparklineCount(payload.hours, SPARKLINE_WINDOW_HOURS),
      points: resolveSparklineCount(payload.points, SPARKLINE_POINT_COUNT),
      series,
    } satisfies TokenSparklineEntry;
  }

  function didAlertSparklineEntryChange(previous: TokenSparklineEntry | undefined, nextEntry: TokenSparklineEntry) {
    const previousSeries = Array.isArray(previous?.series) ? previous.series : [];
    const nextSeries = nextEntry.series;
    const previousLast = previousSeries[previousSeries.length - 1] ?? null;
    const nextLast = nextSeries[nextSeries.length - 1] ?? null;

    return !previous
      || previous.generatedAt !== nextEntry.generatedAt
      || previous.latestBucketAt !== nextEntry.latestBucketAt
      || previous.granularityMinutes !== nextEntry.granularityMinutes
      || previousSeries.length !== nextSeries.length
      || previousLast !== nextLast;
  }

  function applyAlertSparklinePayloads(batchedPayloads: Array<{
    batch: ReturnType<typeof getPendingAlertSparklineBatches>[number];
    payload: TokenSparklinesPayload;
  }>) {
    const activeAlertIds = getActiveAlertIdSet();
    const nextCache = { ...state.data.alertSparklineById };
    let changed = false;

    for (const { batch, payload } of batchedPayloads) {
      for (const item of payload.items || []) {
        const normalized = buildAlertSparklineCacheEntry(item, payload);
        if (!normalized) {
          continue;
        }

        const alertIds = batch.alertIdsByAddress.get(normalized.address) || [];
        for (const alertId of alertIds) {
          if (!activeAlertIds.has(alertId)) {
            continue;
          }

          nextCache[alertId] = normalized;
          changed = changed || didAlertSparklineEntryChange(state.data.alertSparklineById[alertId], normalized);
        }
      }
    }

    if (!changed) {
      return;
    }

    state.data.alertSparklineById = nextCache;
    state.runtime.alertRevision += 1;
    scheduleAlertsPersist();
    emit('alerts');
  }

  async function flushAlertSparklineRefreshQueue(options?: { token?: string }) {
    if (alertSparklineRefreshInFlight) {
      return;
    }

    const token = options?.token ?? state.session.token;
    if (!token || !isAuthenticatedSession()) {
      pendingAlertSparklineRequests.clear();
      return;
    }

    const batches = getPendingAlertSparklineBatches();
    pendingAlertSparklineRequests.clear();
    if (batches.length === 0) {
      return;
    }

    alertSparklineRefreshInFlight = true;
    try {
      const payloads = await Promise.all(
        batches.map(async (batch) => {
          const startedAt = Date.now();
          return {
            batch,
            payload: await fetchTokenSparklines(batch.addresses, {
              hours: SPARKLINE_WINDOW_HOURS,
              points: SPARKLINE_POINT_COUNT,
              granularityMinutes: batch.granularityMinutes,
              allowOneMinuteFallback: true,
              onResponse: (response) => recordSparklineDebug('http.response', {
                endpoint: 'sparklines',
                source: 'alert',
                durationMs: Date.now() - startedAt,
                batch: summarizeSparklineDebugBatches([{
                  hours: SPARKLINE_WINDOW_HOURS,
                  granularityMinutes: batch.granularityMinutes,
                  identities: batch.addresses.map((address) => (
                    createLegacyCompatibleTokenIdentity('solana', address)
                  )),
                }]),
                response,
              }),
            }, token),
          };
        }),
      );

      if (state.session.token !== token || !isAuthenticatedSession()) {
        return;
      }

      applyAlertSparklinePayloads(payloads);
    } catch (error) {
      console.warn('[AppController] Failed to refresh alert sparklines:', error instanceof Error ? error.message : error);
    } finally {
      alertSparklineRefreshInFlight = false;
      if (pendingAlertSparklineRequests.size > 0) {
        const [nextAlertId, nextAddress] = pendingAlertSparklineRequests.entries().next().value || [];
        if (nextAlertId && nextAddress) {
          queueAlertSparklineRefresh(nextAlertId, nextAddress);
        }
      }
    }
  }

  function queueAlertSparklineRefresh(alertId: string, address: string) {
    const normalizedAlertId = String(alertId || '').trim();
    const normalizedAddress = String(address || '').trim();
    if (!normalizedAlertId || !normalizedAddress) {
      return;
    }

    pendingAlertSparklineRequests.set(normalizedAlertId, normalizedAddress);
    if (alertSparklineRefreshTimer) {
      return;
    }

    if (typeof window === 'undefined') {
      void flushAlertSparklineRefreshQueue();
      return;
    }

    alertSparklineRefreshTimer = window.setTimeout(() => {
      alertSparklineRefreshTimer = null;
      void flushAlertSparklineRefreshQueue();
    }, ALERT_SPARKLINE_BATCH_DELAY_MS);
  }

  function queueMissingAlertSparklineRefresh() {
    for (const alert of state.data.alerts) {
      const entry = state.data.alertSparklineById[alert.id];
      const series = Array.isArray(entry?.series) ? entry.series : [];
      if (series.length >= 2) {
        continue;
      }
      queueAlertSparklineRefresh(alert.id, alert.address);
    }
  }

  function isWorkspaceSparklineRefreshAllowed(token: string | undefined): token is string {
    if (token && isWorkspaceSparklineSessionValid(token)) {
      return true;
    }

    recordSparklineDebug('refresh.blocked', { reason: 'invalid-session-or-workspace', hasToken: Boolean(token) });
    clearHistorySparklineCache({ debugReason: 'invalid-session-or-workspace' });
    return false;
  }

  function abortEmptyWorkspaceSparklineBatches() {
    clearHistorySparklineCache({ debugReason: 'empty-visible-batches' });
  }

  function queueWorkspaceSparklineRefreshAfterInFlight(
    refreshIdentities: TokenIdentity[],
    visibleIdentities: TokenIdentity[],
    force: boolean,
    caller: string,
  ) {
    showWorkspaceSparklineLoadingEntries(refreshIdentities, visibleIdentities);
    sparklineRefreshQueued = true;
    sparklineRefreshQueuedForce = sparklineRefreshQueuedForce || force;
    sparklineRefreshQueuedCaller = sparklineRefreshQueuedCaller || caller;
    recordSparklineDebug('refresh.queued-in-flight', {
      caller,
      force,
      refresh: summarizeSparklineDebugAddresses(refreshIdentities.map((identity) => identity.key)),
      visible: summarizeSparklineDebugAddresses(visibleIdentities.map((identity) => identity.key)),
    });
  }

  function pruneWorkspaceSparklineCache(visible: Set<string>) {
    const cachedAddresses = Object.keys(state.data.sparklineByAddress);
    if (cachedAddresses.length <= SPARKLINE_CACHE_MAX_ENTRIES) {
      return false;
    }

    const nextCache = { ...state.data.sparklineByAddress };
    let remaining = cachedAddresses.length;
    let changed = false;
    for (const address of cachedAddresses) {
      if (remaining <= SPARKLINE_CACHE_MAX_ENTRIES) {
        break;
      }
      if (visible.has(address)) {
        continue;
      }
      delete nextCache[address];
      remaining -= 1;
      changed = true;
    }

    if (!changed) {
      return false;
    }

    state.data.sparklineByAddress = nextCache;
    recordSparklineDebug('cache.prune', {
      before: cachedAddresses.length,
      after: remaining,
      visible: visible.size,
    });
    return true;
  }

  function showWorkspaceSparklineLoadingEntries(
    loadingIdentities: TokenIdentity[],
    visibleIdentities: TokenIdentity[] = loadingIdentities,
  ) {
    const visible = new Set(visibleIdentities.flatMap((identity) => (
      identity.chain === 'solana' ? [identity.key, identity.address] : [identity.key]
    )));
    const pruned = pruneWorkspaceSparklineCache(visible);
    const loadingChanged = ensureWorkspaceSparklineLoadingEntries(loadingIdentities);
    if (pruned || loadingChanged) {
      emit('top-performers', 'manual', 'monitored', 'recent', 'old-week');
    }
  }

  type WorkspaceSparklineBatchResult = {
    batch: SparklineBatchRequest;
    payload?: TokenSparklinesPayload;
    error?: unknown;
  };

  async function fetchWorkspaceSparklinePayloads(
    batches: SparklineBatchRequest[],
    token: string,
    onPayload: (batch: SparklineBatchRequest, payload: TokenSparklinesPayload) => void,
  ) {
    return measureRuntimePerfAsync(
      'api.catalog.sparklines',
      isRuntimePerfDebugActive(),
      {
        batches: batches.length,
        identities: batches.reduce((total, batch) => total + batch.identities.length, 0),
      },
      () => Promise.all(
        batches.map(async (batch): Promise<WorkspaceSparklineBatchResult> => {
          const startedAt = Date.now();
          try {
            const payload = await runWorkspaceSparklineRequestWithTimeout(
              SPARKLINE_REQUEST_TIMEOUT_MS,
              (signal) => fetchTokenSparklines(batch.identities, {
                hours: batch.hours,
                points: SPARKLINE_POINT_COUNT,
                granularityMinutes: batch.granularityMinutes,
                allowOneMinuteFallback: true,
                signal,
                onResponse: (response) => recordSparklineDebug('http.response', {
                  endpoint: 'sparklines',
                  source: 'workspace',
                  durationMs: Date.now() - startedAt,
                  batch: summarizeSparklineDebugBatches([batch]),
                  response,
                }),
              }, token),
            );
            onPayload(batch, payload);
            return { batch, payload };
          } catch (error) {
            return { batch, error };
          }
        })
      ),
    );
  }

  function shouldDiscardWorkspaceSparklinePayload(token: string) {
    return !isWorkspaceSparklineSessionValid(token);
  }

  function applyWorkspaceSparklineBatchPayload(payload: TokenSparklinesPayload, batch?: SparklineBatchRequest, caller = 'unknown') {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const returnedAddresses = items.map((item) => (
      createLegacyCompatibleTokenIdentity(item.chain, item.address).key
    ));
    const requestedAddresses = (batch?.identities || []).map((identity) => identity.key);
    const missingAddresses = requestedAddresses.filter((key) => !returnedAddresses.includes(key));
    const emptySeriesAddresses = items
      .filter((item) => !Array.isArray(item.series) || item.series.length < 2)
      .map((item) => createLegacyCompatibleTokenIdentity(item.chain, item.address).key);
    recordSparklineDebug('payload.apply', {
      caller,
      count: items.length,
      emptySeries: emptySeriesAddresses.length,
      missing: missingAddresses.length,
      granularityMinutes: payload.granularityMinutes ?? null,
      hours: payload.hours ?? null,
      requested: summarizeSparklineDebugAddresses(requestedAddresses),
      returned: summarizeSparklineDebugAddresses(returnedAddresses),
      emptySeriesAddresses: summarizeSparklineDebugAddresses(emptySeriesAddresses),
      missingAddresses: summarizeSparklineDebugAddresses(missingAddresses),
    });
    if (items.length === 0 || emptySeriesAddresses.length > 0 || missingAddresses.length > 0) {
      recordSparklineDebug('payload.empty-or-partial', {
        caller,
        batch: batch ? summarizeSparklineDebugBatches([batch]) : null,
        count: items.length,
        emptySeries: emptySeriesAddresses.length,
        missing: missingAddresses.length,
        returned: summarizeSparklineDebugAddresses(returnedAddresses),
        emptySeriesAddresses: summarizeSparklineDebugAddresses(emptySeriesAddresses),
        missingAddresses: summarizeSparklineDebugAddresses(missingAddresses),
      });
    }
    applyHistorySparklinePayload(payload, batch);
    broadcastWorkspaceSparklineSnapshot(payload);
  }

  function updateWorkspaceSparklineRefreshSchedule(
    batches: SparklineBatchRequest[],
    addressKey: string,
    caller: string,
  ) {
    lastSparklineAddressKey = addressKey;
    nextSparklineRefreshAt = getWorkspaceSparklineNextRefreshAt(
      batches,
      state.data.sparklineByAddress,
      SPARKLINE_REFRESH_INTERVAL_MS,
    );
    recordSparklineDebug('refresh.schedule-updated', {
      caller,
      addressKey: hashSparklineDebugValue(addressKey),
      nextRefreshInMs: Math.max(0, nextSparklineRefreshAt - Date.now()),
    });
  }

  function handleWorkspaceSparklineBatchRefreshError(batch: SparklineBatchRequest, error: unknown, caller: string) {
    recordSparklineDebug('refresh.batch-error', {
      caller,
      batch: summarizeSparklineDebugBatches([batch]),
      error: formatDebugErrorMessage(error),
    });
    const nextCache = { ...state.data.sparklineByAddress };
    const refreshedAt = Date.now();
    for (const identity of batch.identities) {
      writeWorkspaceSparklineCacheEntry(nextCache, identity, {
        chain: identity.chain,
        address: identity.address,
        refreshedAt,
        hours: batch.hours,
        points: SPARKLINE_POINT_COUNT,
        granularityMinutes: batch.granularityMinutes,
        series: [],
        loading: false,
      });
    }
    state.data.sparklineByAddress = nextCache;
    emit('top-performers', 'manual', 'monitored', 'recent', 'old-week');

    console.warn(
      `[AppController] Failed to refresh ${batch.granularityMinutes}m workspace sparklines:`,
      error instanceof Error ? error.message : error,
    );
  }

  function handleWorkspaceSparklineRefreshError(visibleIdentities: TokenIdentity[], error: unknown, caller: string) {
    recordSparklineDebug('refresh.error', {
      caller,
      visible: summarizeSparklineDebugAddresses(visibleIdentities.map((identity) => identity.key)),
      error: formatDebugErrorMessage(error),
    });
    handleWorkspaceSparklineRefreshFailure(visibleIdentities, error);
  }

  function applyWorkspaceSparklineRefreshResults(
    results: WorkspaceSparklineBatchResult[],
    visibleBatches: SparklineBatchRequest[],
    addressKey: string,
    caller: string,
  ) {
    const failedResults = results.filter((result) => result.error);
    recordSparklineDebug('refresh.fetch-complete', {
      caller,
      failed: failedResults.length,
      total: results.length,
      failedBatches: summarizeSparklineDebugBatches(failedResults.map((result) => result.batch)),
    });
    for (const result of failedResults) {
      handleWorkspaceSparklineBatchRefreshError(result.batch, result.error, caller);
    }
    updateWorkspaceSparklineRefreshSchedule(visibleBatches, addressKey, caller);
    if (failedResults.length === 0) {
      recordSparklineDebug('refresh.success', {
        caller,
        addressKey: hashSparklineDebugValue(addressKey),
        nextRefreshInMs: Math.max(0, nextSparklineRefreshAt - Date.now()),
      });
    }
  }

  async function refreshHistoryWorkspaceSparklines(options?: WorkspaceSparklineRefreshOptions) {
    const token = options?.token ?? state.session.token ?? undefined;
    const force = Boolean(options?.force);
    const caller = normalizeSparklineDebugCaller(options?.caller);
    if (!isWorkspaceSparklineRefreshAllowed(token)) {
      return;
    }

    const visibleBatches = getVisibleWorkspaceSparklineBatches();
    const addressKey = buildSparklineBatchKey(visibleBatches);
    const visibleIdentities = collectWorkspaceSparklineIdentities(visibleBatches);
    const visibleKeys = visibleIdentities.map((identity) => identity.key);
    const now = Date.now();
    const refreshBatches = selectWorkspaceSparklineRefreshBatches(
      visibleBatches,
      state.data.sparklineByAddress,
      {
        force,
        now,
        refreshIntervalMs: SPARKLINE_REFRESH_INTERVAL_MS,
      },
    );
    const refreshIdentities = collectWorkspaceSparklineIdentities(refreshBatches);
    const refreshKeys = refreshIdentities.map((identity) => identity.key);
    const visibleDiff = summarizeSparklineDebugAddressDiff(lastSparklineVisibleAddresses, visibleKeys);
    recordSparklineDebug('refresh.request', {
      caller,
      force,
      batches: summarizeSparklineDebugBatches(visibleBatches),
      refreshBatches: summarizeSparklineDebugBatches(refreshBatches),
      refresh: summarizeSparklineDebugAddresses(refreshKeys),
      visible: summarizeSparklineDebugAddresses(visibleKeys),
      previousVisible: summarizeSparklineDebugAddresses(lastSparklineVisibleAddresses),
      visibleDiff,
      addressKey: hashSparklineDebugValue(addressKey),
      previousKey: lastSparklineAddressKey ? hashSparklineDebugValue(lastSparklineAddressKey) : '',
      keyChanged: addressKey !== lastSparklineAddressKey,
    });
    lastSparklineVisibleAddresses = visibleKeys.slice();
    if (visibleBatches.length === 0) {
      abortEmptyWorkspaceSparklineBatches();
      return;
    }

    if (refreshBatches.length === 0) {
      updateWorkspaceSparklineRefreshSchedule(visibleBatches, addressKey, caller);
      recordSparklineDebug('refresh.cache-hit', {
        caller,
        addressKey: hashSparklineDebugValue(addressKey),
        nextRefreshInMs: Math.max(0, nextSparklineRefreshAt - now),
      });
      return;
    }
    if (sparklineRefreshInFlight) {
      queueWorkspaceSparklineRefreshAfterInFlight(refreshIdentities, visibleIdentities, force, caller);
      return;
    }

    sparklineRefreshInFlight = true;
    showWorkspaceSparklineLoadingEntries(refreshIdentities, visibleIdentities);
    recordSparklineDebug('refresh.fetch-start', {
      caller,
      force,
      batches: summarizeSparklineDebugBatches(refreshBatches),
      refresh: summarizeSparklineDebugAddresses(refreshKeys),
      visible: summarizeSparklineDebugAddresses(visibleKeys),
      addressKey: hashSparklineDebugValue(addressKey),
    });
    try {
      const results = await fetchWorkspaceSparklinePayloads(refreshBatches, token, (batch, payload) => {
        if (shouldDiscardWorkspaceSparklinePayload(token)) {
          return;
        }
        applyWorkspaceSparklineBatchPayload(payload, batch, caller);
      });
      if (shouldDiscardWorkspaceSparklinePayload(token)) {
        return;
      }

      applyWorkspaceSparklineRefreshResults(results, visibleBatches, addressKey, caller);
    } catch (error) {
      handleWorkspaceSparklineRefreshError(refreshIdentities, error, caller);
    } finally {
      sparklineRefreshInFlight = false;
      const shouldRunQueuedRefresh = sparklineRefreshQueued;
      const queuedForce = sparklineRefreshQueuedForce;
      const queuedCaller = sparklineRefreshQueuedCaller;
      sparklineRefreshQueued = false;
      sparklineRefreshQueuedForce = false;
      sparklineRefreshQueuedCaller = '';
      if (shouldRunQueuedRefresh && isWorkspaceSparklineRefreshAllowed(state.session.token ?? token)) {
        void refreshHistoryWorkspaceSparklines({
          token: state.session.token ?? token,
          force: queuedForce,
          caller: queuedCaller || 'queued-in-flight',
        });
      }
    }
  }

  function refreshMonitoredSparklinesIfExpanded(caller = 'monitored-expanded') {
    if (state.ui.livePanelLayout.spans.monitored <= 1 || !state.session.token || !isLiveWorkspace()) {
      return;
    }
    void refreshHistoryWorkspaceSparklines({ token: state.session.token, force: true, caller });
  }

  function refreshWorkspaceSparklinesAfterRangeChange(addresses?: string[], caller = 'range-change') {
    const targets = new Set((addresses || []).map((address) => String(address || '').trim()).filter(Boolean));
    if (targets.size > 0) {
      const nextCache = { ...state.data.sparklineByAddress };
      for (const { identity } of getVisibleWorkspaceSparklineIdentityScopes()) {
        if (
          targets.has(identity.key)
          || (identity.chain === 'solana' && targets.has(identity.address))
        ) deleteWorkspaceSparklineCacheEntry(nextCache, identity);
      }
      state.data.sparklineByAddress = nextCache;
      lastSparklineAddressKey = '';
      nextSparklineRefreshAt = 0;
    } else {
      clearHistorySparklineCache({ debugReason: 'range-change' });
    }
    emit('manual', 'monitored', 'recent', 'old-week');
    if (state.session.token) {
      void refreshHistoryWorkspaceSparklines({ token: state.session.token, force: true, caller });
    }
  }

  function broadcastWorkspaceMonitoredSnapshot(tokens: DashboardMonitoredToken[], generatedAt?: string | null) {
    if (!shouldBroadcastWorkspacePollingSnapshot()) {
      return;
    }

    postHistorySyncMessage({
      type: 'monitored-snapshot',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      generatedAt: generatedAt ?? null,
      tokens,
      ts: Date.now(),
    });
  }

  function broadcastLiveTopPerformersSnapshot(payload: DashboardTopPerformersPayload) {
    if (!isLiveWorkspace() || !isWorkspacePollingLeader()) {
      return;
    }

    postHistorySyncMessage({
      type: 'top-performers-snapshot',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      payload,
      ts: Date.now(),
    });
  }

  function broadcastHistoryBootstrapSnapshot(
    payload: HistoryBootstrapPayload,
    requestPayload: HistoryBootstrapRequestPayload,
  ) {
    if (!isHistoryWorkspace() || !isHistorySyncLeader()) {
      return;
    }

    postHistorySyncMessage({
      type: 'history-bootstrap-snapshot',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      requestPayload,
      payload,
      ts: Date.now(),
    });
  }

  function broadcastHistoryBidZoneSnapshot(payload: BidZonePayload) {
    if (!isHistoryWorkspace() || !isHistorySyncLeader()) {
      return;
    }

    postHistorySyncMessage({
      type: 'bid-zone-snapshot',
      tabId: historySyncTabId,
      workspace: state.ui.workspace,
      payload,
      ts: Date.now(),
    });
  }

  function handleWorkspacePollingSnapshotMessage(message: HistorySyncMessage) {
    switch (message.type) {
      case 'monitored-snapshot':
        if (usesHistoryBucketBootstrap()) {
          return true;
        }
        applyHistoryMonitoredSnapshot(message.tokens || [], message.generatedAt ?? null);
        return true;
      case 'history-bootstrap-snapshot':
        if (!isCurrentHistoryBootstrapRequest(message.requestPayload)) {
          return true;
        }
        clearHistorySearchPending({ emitRegions: false });
        applyHistoryBootstrapPayload(message.payload, undefined, message.requestPayload);
        emit('recent', 'old-week', 'bid-zone', 'header');
        return true;
      case 'bid-zone-snapshot':
        applyBidZonePayload(message.payload);
        return true;
      case 'top-performers-snapshot':
        if (!isLiveWorkspace()) {
          return true;
        }
        applyDashboardTopPerformers(message.payload);
        emit('top-performers', 'monitored', 'manual', 'header');
        return true;
      case 'sparkline-snapshot':
        applyHistorySparklinePayload(message.payload);
        return true;
      default:
        return false;
    }
  }

  function handleHistorySyncMessage(message: HistorySyncMessage | undefined) {
    if (!message || message.tabId === historySyncTabId) {
      return;
    }

    if (message.type === 'presence') {
      historySyncPeers.set(message.tabId, {
        workspace: normalizeWorkspace(message.workspace),
        authenticated: Boolean(message.authenticated),
        monitoringActive: Boolean(message.monitoringActive),
        seenAt: Number(message.ts) || Date.now(),
      });
      recomputeHistorySyncLeader({ runImmediatelyOnGain: true });
      return;
    }

    if (message.type === 'closing') {
      historySyncPeers.delete(message.tabId);
      recomputeHistorySyncLeader({ runImmediatelyOnGain: true });
      return;
    }

    if ('workspace' in message && normalizeWorkspace(message.workspace) !== state.ui.workspace) {
      return;
    }

    if (!isActiveWorkspacePollingSyncCandidate() || isWorkspacePollingLeader()) {
      return;
    }

    handleWorkspacePollingSnapshotMessage(message);
  }

  function shouldIgnoreHistoryBootstrapRefreshError(input: {
    requestRevision: number;
    token: string;
    suppressErrors?: boolean;
    error: unknown;
  }) {
    return input.requestRevision !== historyBootstrapRequestRevision
      || Boolean(input.suppressErrors)
      || state.session.token !== input.token
      || isApiRateLimitBackoffError(input.error);
  }

  async function refreshHistoryWorkspaceBootstrap(options?: HistoryBootstrapRefreshOptions) {
    const token = options?.token ?? state.session.token;
    if (!token) {
      clearHistorySearchPending({ emitRegions: false });
      return;
    }

    const requestPayload = buildHistoryBootstrapRequest();
    if (requestPayload.chains.length === 0) {
      clearHistorySearchPending({ emitRegions: false });
      emit('recent', 'old-week', 'header');
      return;
    }
    const requestKey = buildHistoryBootstrapRequestKey(token, requestPayload, options?.manualTokensOverride);
    if (queueHistoryBootstrapRefreshIfInFlight(token, requestKey, options)) {
      return;
    }

    historyBootstrapRefreshInFlight = true;
    historyBootstrapInFlightRequestKey = requestKey;
    const requestRevision = historyBootstrapRequestRevision + 1;
    historyBootstrapRequestRevision = requestRevision;

    try {
      const payload = await measureRuntimePerfAsync(
        'api.dashboard.history-bootstrap',
        isRuntimePerfDebugActive(),
        {
          recentPerPage: requestPayload.recent.perPage,
          oldWeekPerPage: requestPayload.oldWeek.perPage,
        },
        () => fetchDashboardHistoryBootstrap(requestPayload, token),
      );
      if (
        requestRevision !== historyBootstrapRequestRevision
        || !usesHistoryBucketBootstrap()
        || state.session.token !== token
      ) {
        return;
      }

      clearHistorySearchPending({ emitRegions: false });
      applyHistoryBootstrapPayload(payload, options?.manualTokensOverride, requestPayload);
      broadcastHistoryBootstrapSnapshot(payload, requestPayload);
      void refreshHistoryWorkspaceSparklines({ token, caller: 'history-bootstrap' });
      refreshMockTradingStateForMarketPoll();
      await executeFloatingQuickBuyIfReady();
      if (lastMonitoredDashboardError && state.ui.error === lastMonitoredDashboardError) {
        setError(null);
      }
      lastMonitoredDashboardError = null;
      state.ui.monitoredLoadError = null;
      emit('recent', 'old-week', 'bid-zone', 'header');
    } catch (error) {
      if (shouldIgnoreHistoryBootstrapRefreshError({
        requestRevision,
        token,
        suppressErrors: options?.suppressErrors,
        error,
      })) {
        return;
      }

      clearHistorySearchPending();
      const message = error instanceof Error ? error.message : 'Failed to refresh monitor history';
      lastMonitoredDashboardError = message;
      setError(message);
      emit('legacy', 'overlay');
    } finally {
      flushQueuedHistoryBootstrapRefresh();
    }
  }

  async function refreshMonitoredDashboard() {
    const token = state.session.token;
    if (!token) {
      return;
    }
    if (isLiveWorkspaceHiddenForUiWork()) {
      return;
    }
    const requestedChains = getReadySelectedChains('monitored');
    if (requestedChains.length === 0) {
      emit('monitored', 'manual', 'top-performers');
      return;
    }

    if (usesHistoryBucketBootstrap()) {
      await refreshHistoryWorkspaceBootstrap({ token });
      void hydrateManualTokensMetadataBatch(token, getManualTokens(state).map((item) => ({
        chain: item.chain || 'solana',
        address: item.address,
        label: item.label ?? null,
      })), { emitOnComplete: isLiveWorkspace() });
      return;
    }

    clearHistorySearchPending({ emitRegions: false });

    const requestKey = buildChainRequestKey(requestedChains);
    if (monitoredRefreshKeysInFlight.has(requestKey)) {
      return;
    }

    monitoredRefreshKeysInFlight.add(requestKey);
    try {
      const manualTokens = getManualTokens(state).map((item) => ({
        chain: item.chain || 'solana',
        address: item.address,
        label: item.label ?? null,
      }));
      const hasSnapshot = getCurrentMonitoredDashboardSnapshot().length > 0;
      const fullHydration = shouldRunFullMonitoredHydration(
        hasSnapshot,
        nextMonitoredFullHydrationAt,
      );
      await measureRuntimePerfAsync(
        'api.dashboard.monitored',
        isRuntimePerfDebugActive(),
        { workspace: state.ui.workspace, mode: 'poll' },
        () => hydratePagedDashboardMonitored(
          token,
          manualTokens,
          requestedChains,
          { fullHydration },
        ),
      );
      const monitoredSnapshot = getCurrentMonitoredDashboardSnapshot();
      void refreshDashboardTopPerformers(token);
      void refreshHistoryWorkspaceSparklines({ token, caller: 'monitored-poll' });
      void hydrateManualTokensMetadataBatch(token, manualTokens, { emitOnComplete: isLiveWorkspace() });
      refreshMockTradingStateForMarketPoll();
      await executeFloatingQuickBuyIfReady();
      if (lastMonitoredDashboardError && state.ui.error === lastMonitoredDashboardError) {
        setError(null);
      }
      lastMonitoredDashboardError = null;
      state.ui.monitoredLoadError = null;
      if (shouldBroadcastWorkspacePollingSnapshot()) {
        broadcastWorkspaceMonitoredSnapshot(monitoredSnapshot, null);
      }
      if (isLiveWorkspace()) {
        emit('monitored', 'manual', 'recent', 'old-week', 'header');
      } else if (isHistoryWorkspace()) {
        emit('recent', 'old-week', 'bid-zone', 'header');
      } else {
        emit('recent', 'old-week', 'header');
      }
    } catch (error) {
      if (requestKey !== buildChainRequestKey(getReadySelectedChains('monitored'))) {
        return;
      }
      if (isApiRateLimitBackoffError(error)) {
        deferMonitoredDashboardPoll(error.retryAfterMs);
        refreshWorkspaceSparklinesForMonitoringCycle();
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to refresh monitored dashboard';
      lastMonitoredDashboardError = message;
      state.ui.monitoredLoadError = message;
      setError(message);
      emit('monitored', 'legacy', 'overlay');
    } finally {
      monitoredRefreshKeysInFlight.delete(requestKey);
    }
  }

  async function refreshDashboardTopPerformers(token = state.session.token) {
    const requestedChains = getReadySelectedChains('topPerformers');
    const requestKey = buildChainRequestKey(requestedChains);
    if (
      !token
      || requestedChains.length === 0
      || topPerformersRefreshKeysInFlight.has(requestKey)
      || !isLiveWorkspace()
    ) {
      return;
    }

    const requestRevision = topPerformersRefreshRevision + 1;
    topPerformersRefreshRevision = requestRevision;
    topPerformersRefreshKeysInFlight.add(requestKey);
    try {
      const payload = await measureRuntimePerfAsync(
        'api.dashboard.top-performers',
        isRuntimePerfDebugActive(),
        { workspace: state.ui.workspace },
        () => fetchDashboardTopPerformers(token, {
          chains: requestedChains,
          ...getMonitoredValuationFilters(),
        }),
      );
      if (
        requestRevision !== topPerformersRefreshRevision
        || state.session.token !== token
        || requestKey !== buildChainRequestKey(getReadySelectedChains('topPerformers'))
      ) {
        return;
      }
      applyDashboardTopPerformers(payload);
      broadcastLiveTopPerformersSnapshot(payload);
      emit('top-performers');
    } catch (error) {
      if (requestRevision !== topPerformersRefreshRevision) {
        return;
      }
      if (isApiRateLimitBackoffError(error)) {
        return;
      }
      console.warn('[AppController] Failed to refresh dashboard top performers:', error instanceof Error ? error.message : error);
    } finally {
      topPerformersRefreshKeysInFlight.delete(requestKey);
    }
  }

  function deferMonitoredDashboardPoll(delayMs: number) {
    nextMonitoredDashboardPollAt = Math.max(
      nextMonitoredDashboardPollAt,
      Date.now() + Math.max(MONITORED_DASHBOARD_POLL_INTERVAL_MS, Math.ceil(delayMs)),
    );
  }

  function shouldStartMonitoredDashboardPoll(now = Date.now()) {
    if (now < nextMonitoredDashboardPollAt) {
      return false;
    }

    const dashboardBackoffMs = getApiRateLimitBackoffRemainingMs('dashboard', now);
    if (dashboardBackoffMs > 0) {
      deferMonitoredDashboardPoll(dashboardBackoffMs);
      return false;
    }

    nextMonitoredDashboardPollAt = now + MONITORED_DASHBOARD_POLL_INTERVAL_MS;
    return true;
  }

  function refreshWorkspaceSparklinesForMonitoringCycle(caller = 'monitored-poll') {
    const token = state.session.token;
    if (!token || usesHistoryBucketBootstrap()) {
      return;
    }
    void refreshHistoryWorkspaceSparklines({ token, caller });
  }

  function runMonitoringCycle() {
    state.runtime.cycle += 1;
    computeUptimeLabel();
    updateMonitoredFreshness(state.runtime.monitoredUpdatedAt);
    updateBidZoneRefreshAvailability(state.runtime.bidZoneRefreshAvailableAt);
    if (isLiveWorkspaceHiddenForUiWork()) {
      return;
    }
    if (usesHistoryBucketBootstrap()) {
      void refreshHistoryWorkspaceBootstrap();
    } else {
      sweepMinMcapRemove();
      refreshMonitoredPanelCounts();
      if (shouldStartMonitoredDashboardPoll()) {
        void refreshMonitoredDashboard();
      } else {
        refreshWorkspaceSparklinesForMonitoringCycle();
      }
    }
    if (shouldRefreshFloatingQuickBuyDashboard()) {
      void refreshFloatingQuickBuyDashboardSnapshot();
    }
    if (shouldRunHistoryAnalyticsRuntime()) {
      void refreshBidZoneTokens();
      emit('header', 'recent', 'old-week', 'bid-zone');
      return;
    }
    if (isLiveWorkspace()) {
      emit('header', 'recent');
      return;
    }
    emit('header', 'recent', 'old-week');
  }

  function syncMonitoringPolling(options?: { runImmediately?: boolean }) {
    const shouldRun = shouldRunLocalMonitoringPolling();
    if (!shouldRun) {
      if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
      }
      return;
    }

    if (monitoringInterval) {
      if (options?.runImmediately) {
        runMonitoringCycle();
      }
      return;
    }

    if (options?.runImmediately) {
      runMonitoringCycle();
    }
    monitoringInterval = setInterval(runMonitoringCycle, MONITORED_REFRESH_INTERVAL_MS);
  }

  function getWorkspaceChainReadinessSignature() {
    return JSON.stringify({
      availableChains: state.data.availableChains,
      readiness: state.data.availableChains.map((chain) => {
        const readiness = state.data.chainReadiness[chain];
        return {
          chain,
          status: readiness?.status,
          phase: readiness?.phase,
          publicationReady: readiness?.publicationReady,
          workspaceReady: readiness?.workspaceReady,
          message: readiness?.message,
          capabilities: readiness?.capabilities,
        };
      }),
    });
  }

  async function refreshWorkspaceChainReadiness() {
    const token = state.session.token;
    if (!token || chainReadinessRefreshInFlight || !isAuthenticatedSession()) {
      return;
    }
    chainReadinessRefreshInFlight = true;
    try {
      const payload = await fetchChainReadiness(token);
      if (state.session.token !== token || !isAuthenticatedSession()) {
        return;
      }
      const previous = getWorkspaceChainReadinessSignature();
      state.data.availableChains = normalizeAvailableTokenChains(payload.availableChains);
      state.data.chainReadiness = payload.chainReadiness || state.data.chainReadiness;
      state.ui.chainFilters = normalizeChainFilterPreferences(
        state.ui.chainFilters,
        state.data.availableChains,
      );
      const next = getWorkspaceChainReadinessSignature();
      if (previous !== next) {
        emit('header', 'top-performers', 'manual', 'monitored', 'alerts', 'recent', 'old-week');
      }
    } catch (error) {
      console.warn('[AppController] Failed to refresh chain readiness:', error instanceof Error ? error.message : error);
    } finally {
      chainReadinessRefreshInFlight = false;
    }
  }

  function startMonitoringTimers() {
    if (state.runtime.mode === 'active') return;
    state.runtime.mode = 'active';
    startedAt = Date.now();
    computeUptimeLabel();
    syncHistorySyncState({ runImmediatelyOnGain: true });
    syncMonitoringPolling({ runImmediately: true });
    syncAdminTokenReviewAlertPolling({ runImmediately: true });
    uptimeInterval = setInterval(() => {
      computeUptimeLabel();
      void refreshWorkspaceChainReadiness();
      emit('header');
    }, UPTIME_REFRESH_INTERVAL_MS);
  }

  function stopMonitoringTimers() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    if (uptimeInterval) clearInterval(uptimeInterval);
    if (adminTokenReviewAlertRefreshInterval) clearInterval(adminTokenReviewAlertRefreshInterval);
    flushPumpfunEmit();
    stopPumpGcTimer();
    monitoringInterval = null;
    uptimeInterval = null;
    adminTokenReviewAlertRefreshInterval = null;
    startedAt = null;
    state.runtime.mode = 'stopped';
    state.runtime.uptimeLabel = '0m';
    updateMonitoredFreshness(state.runtime.monitoredUpdatedAt);
    updateBidZoneRefreshAvailability(state.runtime.bidZoneRefreshAvailableAt);
    syncHistorySyncState();
  }

  function connectRealtime() {
    bindSocketLifecycle({
      onStatus(message) {
        if (Date.now() < suppressSocketStatusNoticeUntil && message.startsWith('Socket disconnected:')) {
          return;
        }
        state.ui.notice = message;
        emit('legacy', 'overlay');
      },
      onRevoked(reason) {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        if (reason === 'access_expired') {
          setError('Your access has expired. Contact an administrator or renew your access to continue.');
        } else if (reason === 'access_revoked') {
          setError('Your access was revoked. Contact an administrator if you believe this is a mistake.');
        } else if (reason === 'access_inactive') {
          setError('Your account does not currently have product access. Contact an administrator.');
        } else {
          setError(`Session revoked by server: ${reason}`);
        }
        emit('all');
      },
      onAlertEvent(payload) {
        if (state.runtime.mode !== 'active' || state.session.status !== 'authenticated') {
          recordAlertDebug('socket.event.skip-inactive', {
            payload: summarizeDashboardAlertEventsDebug([payload]),
          });
          return;
        }
        const sessionToken = state.session.token;
        if (!sessionToken) {
          recordAlertDebug('socket.event.skip-no-session-token', {
            payload: summarizeDashboardAlertEventsDebug([payload]),
          });
          return;
        }

        const hiddenForUiWork = isLiveWorkspaceHiddenForUiWork();
        recordAlertDebug('socket.event.received', {
          hiddenForUiWork,
          payload: summarizeDashboardAlertEventsDebug([payload]),
        });
        const added = syncBackendAlertEvents([payload]);
        publishRealtimeChartAlert(payload);
        if (added > 0) {
          void markDashboardAlertEventsSeen(sessionToken, [payload], payload.ruleKey || payload.kind || GMGN_CLAIM_SIGNAL_RULE_KEY);
          if (hiddenForUiWork) {
            emit('alerts');
          } else {
            emit('alerts', 'header', 'legacy');
          }
        }
      },
      onMarketBucket(payload) {
        if (state.runtime.mode !== 'active' || state.session.status !== 'authenticated') {
          return;
        }
        applyLiveTokenMarketUpdate(payload);
        applyLiveMarketBucketUpdate(payload);
      },
    });
  }

  function syncWorkspaceCapabilities() {
    if (state.session.status !== 'authenticated') {
      syncHistorySyncState();
      return;
    }

    if (state.runtime.mode !== 'active') {
      startMonitoringTimers();
    }

    if (shouldUseBackendOwnedMonitoredAlerts()) {
      connectRealtime();
    } else {
      suppressSocketStatusNoticeUntil = Date.now() + 2000;
      disconnectSocket();
    }

    stopPumpGcTimer();
    if (
      state.pumpfun.connected
      || state.data.pumpTokens.length > 0
      || state.data.recentPumpMigrations.length > 0
      || state.data.pumpToasts.length > 0
    ) {
      clearPumpWorkspaceState();
      emit('pumpfun', 'toasts', 'legacy', 'overlay');
    }

    if (!shouldRunHistoryAnalyticsRuntime()) {
      state.data.bidZoneTokens = [];
      state.panels.bidZone = 0;
      updateBidZoneFreshness(null);
    } else {
      void refreshBidZoneTokens({ force: true });
    }

    syncHistorySyncState({ runImmediatelyOnGain: true });
    syncMonitoringPolling();
    syncAdminTokenReviewAlertPolling({ runImmediately: true });
  }

  function refreshWorkspaceSnapshot() {
    if (state.session.status !== 'authenticated') {
      return;
    }

    if (usesHistoryBucketBootstrap()) {
      void refreshHistoryWorkspaceBootstrap();
    } else {
      void refreshMonitoredDashboard();
    }
    if (shouldRunHistoryAnalyticsRuntime()) {
      void refreshBidZoneTokens({ force: true });
    }
  }

  function applySession(user: SessionUser, options?: { deferWorkspaceSync?: boolean }) {
    state.session.status = 'authenticated';
    state.session.token = COOKIE_SESSION_MARKER;
    state.session.username = user.username;
    state.session.email = user.email;
    state.session.role = user.role;
    state.session.isEmailVerified = Boolean(user.isEmailVerified);
    state.session.emailVerifiedAt = user.emailVerifiedAt ?? null;
    hydrateBarStorage();
    hydrateSoundSettings();
    hydrateBrowserNotificationSettings();
    void refreshAuthoritativeBackendAlertHistory('session-applied');
    void refreshMockTradingState();
    if (!options?.deferWorkspaceSync) {
      syncWorkspaceCapabilities();
      syncHistorySyncState({ runImmediatelyOnGain: true });
    }
  }

  function applyPreAccessSession(user: SessionUser) {
    state.session.status = 'pre_access';
    state.session.token = null;
    state.session.username = user.username;
    state.session.email = user.email;
    state.session.role = user.role;
    state.session.isEmailVerified = Boolean(user.isEmailVerified);
    state.session.emailVerifiedAt = user.emailVerifiedAt ?? null;
    state.preAccess.loaded = true;
    stopMonitoringTimers();
    disconnectSocket();
  }

  function applyAccountAccess(access: AccountAccessPayload | null) {
    if (!access) {
      state.session.accessStatus = null;
      state.session.accessGrantedAt = null;
      state.session.accessExpiresAt = null;
      state.session.accessSource = null;
      state.session.accessUpdatedAt = null;
      state.session.accessIsExpired = false;
      state.session.accessHasProductAccess = false;
      state.session.accessDaysRemaining = null;
      state.session.accessReason = null;
      state.session.tokenTier = null;
      state.session.tokenDiscountPercent = 0;
      state.session.tokenBalanceRaw = null;
      state.session.tokenBalanceUi = null;
      state.session.tokenSnapshotCheckedAt = null;
      state.session.tokenSnapshotExpiresAt = null;
      return;
    }

    state.session.accessStatus = access.accessStatus;
    state.session.accessGrantedAt = access.accessGrantedAt;
    state.session.accessExpiresAt = access.accessExpiresAt;
    state.session.accessSource = access.accessSource;
    state.session.accessUpdatedAt = access.accessUpdatedAt;
    state.session.accessIsExpired = Boolean(access.isExpired);
    state.session.accessHasProductAccess = Boolean(access.hasProductAccess);
    state.session.accessDaysRemaining = access.daysRemaining;
    state.session.accessReason = access.accessReason ?? null;
    state.session.tokenTier = access.tokenTier ?? null;
    state.session.tokenDiscountPercent = Number(access.discountPercent) || 0;
    state.session.tokenBalanceRaw = access.tokenBalanceRaw ?? null;
    state.session.tokenBalanceUi = access.tokenBalanceUi ?? null;
    state.session.tokenSnapshotCheckedAt = access.tokenSnapshotCheckedAt ?? null;
    state.session.tokenSnapshotExpiresAt = access.tokenSnapshotExpiresAt ?? null;
  }

  function applyBillingStateSnapshot(snapshot: BillingStatePayload | null) {
    state.billing.loaded = Boolean(snapshot);
    state.billing.enabled = Boolean(snapshot?.enabled);
    state.billing.provider = snapshot?.provider ?? null;
    state.billing.providerReady = Boolean(snapshot?.providerReady);
    state.billing.providerMocked = Boolean(snapshot?.providerMocked);
    state.billing.plans = (snapshot?.plans ?? []) as BillingPlanEntry[];
    state.billing.orders = (snapshot?.orders ?? []) as BillingOrderEntry[];
    state.billing.error = null;
  }

  function applyPublicBillingPlansSnapshot(snapshot: PublicBillingPlansPayload | null) {
    state.billing.loaded = Boolean(snapshot);
    state.billing.enabled = Boolean(snapshot?.enabled);
    state.billing.provider = snapshot?.provider ?? null;
    state.billing.providerReady = Boolean(snapshot?.providerReady);
    state.billing.providerMocked = Boolean(snapshot?.providerMocked);
    state.billing.plans = (snapshot?.plans ?? []) as BillingPlanEntry[];
    state.billing.orders = [];
    state.billing.error = null;
  }

  function applyPreAccessBillingStateSnapshot(snapshot: PreAccessBillingStatePayload | null) {
    applyBillingStateSnapshot(snapshot as BillingStatePayload | null);
  }

  function applyIdentityStateSnapshot(snapshot: AccountIdentitiesPayload | null) {
    state.identities.loaded = Boolean(snapshot);
    state.identities.providers = (snapshot?.providers ?? []) as LinkedIdentityEntry[];
    state.identities.hasPasswordLogin = Boolean(snapshot?.hasPasswordLogin);
    state.identities.error = null;
  }

  async function refreshAccountAccessState(token: string) {
    try {
      applyAccountAccess(await fetchAccountAccess(token));
    } catch {
      applyAccountAccess(null);
    }
  }

  async function refreshBillingState(token: string) {
    try {
      applyBillingStateSnapshot(await fetchBillingState(token));
    } catch (error) {
      state.billing.loaded = false;
      state.billing.enabled = false;
      state.billing.provider = null;
      state.billing.providerReady = false;
      state.billing.providerMocked = false;
      state.billing.plans = [];
      state.billing.orders = [];
      state.billing.error = error instanceof Error ? error.message : 'Unable to load billing';
    }
  }

  async function refreshPublicBillingState() {
    try {
      applyPublicBillingPlansSnapshot(await fetchPublicBillingPlans());
    } catch (error) {
      state.billing.loaded = false;
      state.billing.enabled = false;
      state.billing.provider = null;
      state.billing.providerReady = false;
      state.billing.providerMocked = false;
      state.billing.plans = [];
      state.billing.orders = [];
      state.billing.error = error instanceof Error ? error.message : 'Unable to load billing plans';
    }
  }

  async function refreshIdentityState(token: string) {
    try {
      applyIdentityStateSnapshot(await fetchAccountIdentities(token));
    } catch (error) {
      state.identities.loaded = false;
      state.identities.providers = [];
      state.identities.hasPasswordLogin = false;
      state.identities.error = error instanceof Error ? error.message : 'Unable to load linked identities';
    }
  }

  async function refreshAccountSecurityIdentityState(token?: string | null) {
    try {
      applyIdentityStateSnapshot(await fetchAccountSecurityIdentities(token));
    } catch (error) {
      state.identities.loaded = false;
      state.identities.providers = [];
      state.identities.hasPasswordLogin = false;
      state.identities.error = error instanceof Error ? error.message : 'Unable to load linked identities';
    }
  }

  async function refreshPreAccessBillingOnlyState() {
    try {
      applyPreAccessBillingStateSnapshot(await fetchPreAccessBillingState());
    } catch (error) {
      state.billing.loaded = false;
      state.billing.enabled = false;
      state.billing.provider = null;
      state.billing.providerReady = false;
      state.billing.providerMocked = false;
      state.billing.plans = [];
      state.billing.orders = [];
      state.billing.error = error instanceof Error ? error.message : 'Unable to load billing';
    }
  }

  async function refreshAccountSecurityState() {
    if (state.session.status === 'authenticated') {
      await Promise.all([
        refreshAccountSecurityIdentityState(COOKIE_SESSION_MARKER),
        refreshBillingState(COOKIE_SESSION_MARKER),
      ]);
      return;
    }

    if (state.session.status === 'pre_access') {
      await Promise.all([
        refreshAccountSecurityIdentityState(),
        refreshPreAccessBillingOnlyState(),
      ]);
    }
  }

  async function refreshPreAccessState() {
    const [preAccess, billing] = await Promise.all([
      fetchPreAccessMe(),
      fetchPreAccessBillingState(),
    ]);

    applyPreAccessSession(preAccess.user);
    applyAccountAccess(preAccess.access);
    applyPreAccessBillingStateSnapshot(billing);
    state.preAccess.loaded = true;
  }

  async function refreshUserSettingsState(token: string) {
    await Promise.all([
      refreshAccountAccessState(token),
      refreshBillingState(token),
      refreshIdentityState(token),
    ]);
  }

  function refreshDeferredAuthenticatedAncillaryState(token: string) {
    void Promise.all([
      refreshBillingState(token),
      refreshIdentityState(token),
    ])
      .finally(() => {
        if (state.session.status === 'authenticated') {
          emit('overlay', 'header');
        }
      });
  }

  async function refreshAuthenticatedBootstrapState() {
    await Promise.all([
      refreshAccountAccessState(COOKIE_SESSION_MARKER),
      reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true }),
    ]);
    refreshDeferredAuthenticatedAncillaryState(COOKIE_SESSION_MARKER);
  }

  function clearSession() {
    clearChartAlertHistory();
    flushAlertsPersist();
    stopSocialLinkSync();
    stopPreAccessPolling();
    recentAlertFingerprints.clear();
    nextColdFieldRefreshAt = 0;
    nextSparklineRefreshAt = 0;
    lastSparklineAddressKey = '';
    state.session.status = 'anonymous';
    state.session.token = null;
    state.session.username = null;
    state.session.email = null;
    state.session.role = null;
    state.session.isEmailVerified = false;
    state.session.emailVerifiedAt = null;
    state.session.accessStatus = null;
    state.session.accessGrantedAt = null;
    state.session.accessExpiresAt = null;
    state.session.accessSource = null;
    state.session.accessUpdatedAt = null;
    state.session.accessIsExpired = false;
    state.session.accessHasProductAccess = false;
    state.session.accessDaysRemaining = null;
    state.session.accessReason = null;
    state.session.tokenTier = null;
    state.session.tokenDiscountPercent = 0;
    state.session.tokenBalanceRaw = null;
    state.session.tokenBalanceUi = null;
    state.session.tokenSnapshotCheckedAt = null;
    state.session.tokenSnapshotExpiresAt = null;
    state.billing.loaded = false;
    state.billing.enabled = false;
    state.billing.provider = null;
    state.billing.providerReady = false;
    state.billing.providerMocked = false;
    state.billing.plans = [];
    state.billing.orders = [];
    state.billing.pendingPlanKey = null;
    state.billing.error = null;
    state.identities.loaded = false;
    state.identities.providers = [];
    state.identities.hasPasswordLogin = false;
    state.identities.error = null;
    state.preAccess.loaded = false;
    state.preAccess.awaitingConfirmation = false;
    state.preAccess.pendingBillingOrderId = null;
    state.runtime.cycle = 0;
    state.runtime.alerts = 0;
    state.runtime.alertRevision = 0;
    state.runtime.monitoredRevision = 0;
    state.runtime.routedRevision = 0;
    state.runtime.bidZoneRevision = 0;
    state.runtime.starredRevision = 0;
    state.runtime.monitoredUpdatedAt = null;
    state.runtime.monitoredFreshnessLabel = '-';
    state.runtime.bidZoneUpdatedAt = null;
    state.runtime.bidZoneFreshnessLabel = '-';
    state.runtime.bidZoneRefreshAvailableAt = null;
    state.runtime.bidZoneRefreshCooldownLabel = 'ready';
    state.runtime.bidZoneRefreshInFlight = false;
    state.panels.alerts = 0;
    state.panels.bidZone = 0;
    state.panels.pumpfun = 0;
    state.configSummary = {
      loaded: false,
      configCount: 0,
      manualTokens: 0,
      blocklist: 0,
      starredTokens: 0,
      eligibleCatalogTokens: 0,
    };
    state.pumpfun.connected = false;
    state.pumpfun.statusLabel = 'disconnected';
    state.pumpfun.solPriceUsd = null;
    state.pumpfun.migrationCount = 0;
    state.pumpfun.bondTargetMcap = 35000;
    const defaultChainReadiness = createAppState().data.chainReadiness;
    state.data = {
      configs: {},
      availableChains: ['solana'],
      chainReadiness: defaultChainReadiness,
      runtimeFlags: {
        mockTradingEnabled: true,
      },
      trackedTokensByIdentity: {},
      monitoredTokenIdentities: [],
      pinnedMonitoredTokenIdentities: [],
      manualTokenIdentities: [],
      manualTokenFolders: [],
      manualTokenFolderItems: [],
      recentTokenIdentities: [],
      oldWeekTokenIdentities: [],
      topPerformerIdentities: [],
      topPerformersGeneratedAt: null,
      topPerformersRanking: null,
      dismissedRecentIdentities: [],
      dismissedOldWeekIdentities: [],
      dismissedPump: [],
      blocklist: [],
      adminTokenReviewAlerts: [],
      customAlertCapabilities: {},
      customAlertRules: [],
      starredTokenIdentities: [],
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
      pumpTokens: [],
      recentPumpMigrations: [],
      pumpToasts: [],
    };
    nonSolanaHistoryTrackedIdentities = new Set<string>();
    state.ui.chainFilters = normalizeChainFilterPreferences(null, state.data.availableChains);
    state.ui.manualVisibleFolderIds = [];
    state.bars.manual = 0;
    state.bars.recent = 0;
    state.bars.oldWeek = 0;
    state.bars.blocklist = 0;
    state.panels.monitored = 0;
    state.panels.bidZone = 0;
    state.ui.authPanel = 'none';
    state.ui.pendingIdentityUnlinkProvider = null;
    state.ui.pendingVerificationEmail = null;
    state.ui.pendingPasswordResetToken = null;
    state.ui.pendingLoginOtpChallengeToken = null;
    state.ui.pendingLoginOtpEmailHint = null;
    state.ui.alertSearchQuery = '';
    state.ui.monitoredSearchQuery = '';
    state.ui.manualSearchQuery = '';
    state.ui.recentSearchQuery = '';
    state.ui.oldWeekSearchQuery = '';
    state.ui.recentSearchPending = false;
    state.ui.oldWeekSearchPending = false;
    state.ui.expandedSparklineAddress = null;
    state.ui.activeMockTradingWalletId = null;
    state.ui.mockTradingTicket = null;
    resetFloatingQuickBuyState();
    state.ui.floatingQuickBuyVisible = true;
    state.ui.mockTradingHistoryOpen = false;
    state.ui.mockTradingPnlAddress = null;
    state.ui.manualStarredOnly = false;
    state.ui.recentStarredOnly = false;
    state.ui.oldWeekStarredOnly = false;
    state.ui.alertPage = 0;
    pendingAlertSparklineRequests.clear();
    if (alertSparklineRefreshTimer) {
      clearTimeout(alertSparklineRefreshTimer);
      alertSparklineRefreshTimer = null;
    }
    alertSparklineRefreshInFlight = false;
    state.ui.monitoredPage = 0;
    state.ui.recentPage = 0;
    state.ui.oldWeekPage = 0;
    state.ui.monitoredPerPage = 30;
    state.ui.recentPerPage = ROUTED_BUCKET_DEFAULT_PER_PAGE;
    state.ui.oldWeekPerPage = ROUTED_BUCKET_DEFAULT_PER_PAGE;
    state.ui.manualSorts = getDefaultBucketSorts('manual');
    state.ui.recentSorts = getDefaultBucketSorts('recent');
    state.ui.oldWeekSorts = getDefaultBucketSorts('old-week');
    state.ui.monitoredSorts = getDefaultMonitoredSorts();
    state.ui.livePanelLayout = getDefaultLivePanelLayout();
    if (uiPrefsPersistTimer) {
      clearTimeout(uiPrefsPersistTimer);
      uiPrefsPersistTimer = null;
    }
    hydrateSoundSettings();
    hydrateBrowserNotificationSettings();
    state.ui.collapsed = getDefaultCollapsedSections();
    replaceStarredTokens([], { resetRevision: true });
    historyBootstrapRequestRevision = 0;
    historySyncPeers.clear();
    historySyncLeaderTabId = null;
    syncHistorySyncState();
  }

  async function completePreAccessFlow(options?: { automatic?: boolean }) {
    if (state.session.status !== 'pre_access') {
      return;
    }
    if (!state.session.accessHasProductAccess) {
      if (!options?.automatic) {
        setError('Payment confirmation still pending');
        emit('legacy');
      }
      return;
    }
    if (authSubmitInFlight) {
      return;
    }

    authSubmitInFlight = true;
    setBusy(true);
    setError(null);
    setNotice(options?.automatic ? 'Payment confirmed. Entering bot...' : 'Entering bot...');
    emit();

    try {
      const result = await completePreAccessSession();
      stopPreAccessPolling();
      state.preAccess.awaitingConfirmation = false;
      state.preAccess.pendingBillingOrderId = null;
      applySession(result.user, { deferWorkspaceSync: true });
      await refreshAccountAccessState(COOKIE_SESSION_MARKER);
      await refreshBillingState(COOKIE_SESSION_MARKER);
      navigateToWorkspace('live');
      setNotice('Payment confirmed. Access granted.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to complete access activation');
    } finally {
      authSubmitInFlight = false;
      setBusy(false);
      emit();
    }
  }

  async function maybeAutoCompletePreAccess(options?: { automatic?: boolean }) {
    if (state.session.status !== 'pre_access' || !state.session.accessHasProductAccess) {
      return false;
    }

    await completePreAccessFlow({ automatic: options?.automatic !== false });
    return true;
  }

  async function syncPendingPreAccessBillingOrder() {
    const orderId = state.preAccess.pendingBillingOrderId;
    if (!orderId) {
      return;
    }

    try {
      const result = await syncPreAccessOrder(orderId);
      if (result.order?.status === 'paid') {
        state.preAccess.pendingBillingOrderId = null;
      }
    } catch (_) {
      // Keep polling; the webhook path or a later provider sync can still confirm payment.
    }
  }

  function schedulePreAccessConfirmationPolling(attempt = 0) {
    if (typeof window === 'undefined' || preAccessPollingTimer || state.session.status !== 'pre_access') {
      return;
    }

    preAccessPollingTimer = window.setTimeout(async () => {
      preAccessPollingTimer = null;
      if (state.session.status !== 'pre_access') {
        return;
      }

      try {
        await syncPendingPreAccessBillingOrder();
        await refreshPreAccessState();
        emit('legacy');

        if (await maybeAutoCompletePreAccess({ automatic: true })) {
          return;
        }
      } catch (_) {
        emit('legacy');
      }

      if (attempt < 39 && state.preAccess.awaitingConfirmation) {
        schedulePreAccessConfirmationPolling(attempt + 1);
      }
    }, 3000);
  }

  function applyMonitoredDashboard(
    monitoredDashboardTokens: DashboardMonitoredToken[] = [],
    manualTokensOverride?: Array<{ address: string; label?: string | null }>,
    generatedAt?: string | null,
    pinnedDashboardTokens: DashboardMonitoredToken[] = [],
  ) {
    measureRuntimePerf(
      'controller.applyMonitoredDashboard',
      isRuntimePerfDebugActive(),
      {
        tokens: monitoredDashboardTokens.length,
        pinnedTokens: pinnedDashboardTokens.length,
        manualOverride: manualTokensOverride?.length ?? null,
        workspace: state.ui.workspace,
      },
      () => {
        const manualPayload = buildMonitoredDashboardPayload(manualTokensOverride);
        syncMeteoraDashboardCache(monitoredDashboardTokens, manualPayload.tokens, pinnedDashboardTokens);
        state.configSummary.eligibleCatalogTokens = monitoredDashboardTokens.length;
        state.data.eligibleCatalogTokens = monitoredDashboardTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
        if (generatedAt !== undefined) {
          updateMonitoredFreshness(generatedAt ?? null);
        }
        rebuildTrackedState(manualPayload, monitoredDashboardTokens, pinnedDashboardTokens);
      },
    );
  }

  function syncNonSolanaHistoryTrackedTokens(tokens: DashboardMonitoredToken[]) {
    const nonSolanaTokens = tokens.filter((item) => item.chain !== 'solana');
    const nextIdentities = new Set(nonSolanaTokens.map((item) => getTrackedTokenKey(item.address, item.chain)));
    const alertIdentities = new Set(
      state.data.alerts.map((alert) => getTrackedTokenKey(alert.address, alert.chain)),
    );

    for (const identityKey of nonSolanaHistoryTrackedIdentities) {
      if (!nextIdentities.has(identityKey) && !alertIdentities.has(identityKey)) {
        delete state.data.trackedTokensByIdentity[identityKey];
      }
    }

    nonSolanaHistoryTrackedIdentities = nextIdentities;
    for (const item of nonSolanaTokens) {
      const identityKey = getTrackedTokenKey(item.address, item.chain);
      const existingItem = state.data.trackedTokensByIdentity[identityKey];
      const mergedItem = mergeTrackedDashboardFields({
        existingItem,
        dashboardItem: item,
        base: {
          ...existingItem,
          chain: item.chain,
          address: item.address,
          label: existingItem?.label ?? item.symbol ?? 'Eligible',
          manual: false,
          _userManual: false,
          _isPinnedMonitored: false,
          pinnedSortOrder: null,
        },
        coldRefreshDue: false,
      });
      setTrackedToken(selectMergedTrackedToken(existingItem, mergedItem));
    }

    applyPersistedFrontendAlertFlags(state.data.trackedTokensByIdentity);
  }

  function clearTopPerformerFlags(identities: string[]) {
    for (const identityKey of identities) {
      const existingItem = getTrackedTokenByIdentity(identityKey);
      if (!existingItem?._isTopPerformer) {
        continue;
      }
      const nextItem = {
        ...existingItem,
        _isTopPerformer: false,
        performanceRank: null,
        performanceScore: null,
      };
      replaceTrackedTokenReferences(existingItem.address, nextItem);
    }
  }

  function applyDashboardTopPerformers(payload: DashboardTopPerformersPayload) {
    const blocked = new Set(state.data.blocklist.map((item) => (
      getTrackedTokenKey(item.address, item.chain || 'solana')
    )));
    const previousIdentities = state.data.topPerformerIdentities;
    const nextIdentities: string[] = [];
    const seen = new Set<string>();

    clearTopPerformerFlags(previousIdentities);

    for (const item of payload.tokens || []) {
      const address = String(item.address || '').trim();
      if (!address) continue;
      const identityKey = getTrackedTokenKey(address, item.chain);
      if (blocked.has(identityKey) || seen.has(identityKey)) {
        continue;
      }
      seen.add(identityKey);
      nextIdentities.push(identityKey);

      const existingItem = getOptionalTrackedToken(address, item.chain);
      const mergedItem = mergeTrackedDashboardFields({
        existingItem,
        dashboardItem: item,
        base: {
          ...existingItem,
          chain: item.chain,
          address,
          label: existingItem?.label ?? item.symbol ?? 'Top performer',
          manual: existingItem?.manual ?? false,
          _userManual: existingItem?._userManual ?? false,
        },
        coldRefreshDue: true,
      });
      replaceTrackedTokenReferences(address, {
        ...selectMergedTrackedToken(existingItem, mergedItem),
        _isTopPerformer: true,
        performanceRank: item.performanceRank ?? nextIdentities.length,
        performanceScore: item.performanceScore ?? null,
      });
    }

    state.data.topPerformerIdentities = nextIdentities;
    state.data.topPerformersGeneratedAt = payload.generatedAt ?? null;
    state.data.topPerformersRanking = payload.ranking ?? null;
    refreshTrackedTokenStore();
  }

  function buildCurrentMonitoredMeteoraSnapshot(address: string) {
    const meteora = state.data.meteoraByAddress[address];
    if (!meteora) {
      return null;
    }

    return {
      address,
      tvl: toNullableTrackedValue(meteora.tvl),
      poolAddress: toNullableTrackedValue(meteora.poolAddress),
      poolCount: meteora.poolCount ?? 0,
      lastCheckedAt: toNullableTrackedValue(meteora.lastCheckedAt),
      lastSnapshotAt: toNullableTrackedValue(meteora.lastSnapshotAt),
      change1h: toNullableTrackedValue(meteora.change1h),
      change4h: toNullableTrackedValue(meteora.change4h),
      change6h: toNullableTrackedValue(meteora.change6h),
      change24h: toNullableTrackedValue(meteora.change24h),
      volume1h: toNullableTrackedValue(meteora.volume1h),
      volume4h: toNullableTrackedValue(meteora.volume4h),
      volume24h: toNullableTrackedValue(meteora.volume24h),
      noPool: meteora.noPool ?? false,
    };
  }

  function buildCurrentMonitoredSnapshotToken(address: string, chain: TokenChain = 'solana') {
    const item = getTrackedToken(state, address, chain);
    if (!item) {
      return null;
    }

    return {
      chain: item.chain || 'solana',
      address: item.address,
      symbol: toNullableTrackedValue(item.symbol),
      name: toNullableTrackedValue(item.name),
      pairAddress: toNullableTrackedValue(item.pairAddress),
      pairUrl: toNullableTrackedValue(item.pairUrl),
      pairDexId: toNullableTrackedValue(item.pairDexId),
      imageUrl: toNullableTrackedValue(item.imageUrl),
      twitterUrl: toNullableTrackedValue(item.twitterUrl),
      communityUrl: toNullableTrackedValue(item.communityUrl),
      mcap: toNullableTrackedValue(item.mcap),
      fdv: toNullableTrackedValue(item.fdv),
      valuationType: toNullableTrackedValue(item.valuationType),
      valuation: toNullableTrackedValue(item.valuation),
      priceUsd: toNullableTrackedValue(item.priceUsd),
      liquidityUsd: toNullableTrackedValue(item.liquidityUsd),
      volume5m: toNullableTrackedValue(item.volume5m),
      volume1h: toNullableTrackedValue(item.volume1h),
      volume6h: toNullableTrackedValue(item.volume6h),
      volume24h: toNullableTrackedValue(item.volume24h),
      priceChange1h: toNullableTrackedValue(item.priceChange1h),
      priceChange6h: toNullableTrackedValue(item.priceChange6h),
      priceChange24h: toNullableTrackedValue(item.priceChange24h),
      historySortScore: toNullableTrackedValue(item.historySortScore),
      tokenCreatedAt: toNullableTrackedValue(item.createdAt),
      prevMcap: toNullableTrackedValue(item.prevMcap),
      mcapDelta: toNullableTrackedValue(item.mcapDelta),
      prevVolume5mCanonical: firstDefinedTrackedValue(item.prevVolume5mCanonical, item.prevVolume5m),
      volume5mBaselineAt: toNullableTrackedValue(item.volume5mBaselineAt),
      volume5mWindowEnd: toNullableTrackedValue(item.volume5mWindowEnd),
      volume5mDeltaCoverage: toNullableTrackedValue(item.volume5mDeltaCoverage),
      lastSeenAt: toNullableTrackedValue(item.lastSeenAt),
      lastEvaluatedAt: toNullableTrackedValue(item.lastEvaluatedAt),
      windowEnd: toNullableTrackedValue(item.windowEnd),
      lastActivityAt: toNullableTrackedValue(item.lastActivityAt),
      swaps5m: toNullableTrackedValue(item.swaps5m),
      swaps1h: toNullableTrackedValue(item.swaps1h),
      swaps6h: toNullableTrackedValue(item.swaps6h),
      swaps24h: toNullableTrackedValue(item.swaps24h),
      coverage: item.coverage,
      swapCoverage: item.swapCoverage,
      priceChangeCoverage: item.priceChangeCoverage,
      activityState: item.activityState,
      riskState: item.riskState,
      dataQuality: item.dataQuality,
      tickerPeers: item.tickerPeers ?? null,
      meteora: buildCurrentMonitoredMeteoraSnapshot(address),
    } satisfies DashboardMonitoredToken;
  }

  function getCurrentMonitoredDashboardSnapshot(): DashboardMonitoredToken[] {
    const manualIdentities = new Set(state.data.manualTokenIdentities);
    const snapshot: DashboardMonitoredToken[] = [];

    for (const identityKey of state.data.monitoredTokenIdentities) {
      if (manualIdentities.has(identityKey)) {
        continue;
      }
      const identity = parseTokenIdentityKey(identityKey);
      const item = buildCurrentMonitoredSnapshotToken(identity.address, identity.chain);
      if (item) {
        snapshot.push(item);
      }
    }

    return snapshot;
  }

  function getCurrentPinnedMonitoredDashboardSnapshot(): DashboardMonitoredToken[] {
    const snapshot: DashboardMonitoredToken[] = [];
    state.data.pinnedMonitoredTokenIdentities.forEach((identityKey) => {
      const identity = parseTokenIdentityKey(identityKey);
      const item = buildCurrentMonitoredSnapshotToken(identity.address, identity.chain);
      if (item) {
        snapshot.push({ ...item, pinnedSortOrder: getTrackedTokenByIdentity(identityKey)?.pinnedSortOrder ?? 0 });
      }
    });
    return snapshot;
  }

  function captureMonitoredPinLayout() {
    return state.data.pinnedMonitoredTokenIdentities.map((identityKey) => {
      const identity = parseTokenIdentityKey(identityKey);
      return {
        chain: identity.chain,
        address: identity.address,
        sortOrder: getTrackedTokenByIdentity(identityKey)?.pinnedSortOrder ?? 0,
      };
    });
  }

  function applyMonitoredPinLayout(pins: DashboardMonitoredPin[]) {
    const positions = new Map(pins.map((item) => [getTrackedTokenKey(item.address, item.chain), item.sortOrder]));
    const previouslyPinned = new Set(state.data.pinnedMonitoredTokenIdentities);
    for (const identityKey of new Set([...previouslyPinned, ...positions.keys()])) {
      const item = getTrackedTokenByIdentity(identityKey);
      if (!item) continue;
      const sortOrder = positions.get(identityKey);
      replaceTrackedTokenReferences(item.address, {
        ...item,
        _isPinnedMonitored: sortOrder != null,
        pinnedSortOrder: sortOrder ?? null,
      });
    }
    state.data.pinnedMonitoredTokenIdentities = [...positions.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([identityKey]) => identityKey);
    emit('monitored');
  }

  function buildMovedMonitoredPinLayout(chain: TokenChain, address: string, requestedPosition: number) {
    const identityKey = getTrackedTokenKey(address, chain);
    const rows = resolveMonitoredTableRows(getMonitoredTokens(state), {
      searchQuery: '',
      sortCriteria: state.ui.monitoredSorts,
    }).filter((item) => getTokenIdentityKey(item) !== identityKey);
    const position = Math.min(Math.max(0, Math.floor(requestedPosition) || 0), rows.length);
    const trackedToken = getTrackedToken(state, address, chain);
    if (!trackedToken) {
      return captureMonitoredPinLayout();
    }
    rows.splice(position, 0, trackedToken);
    const pinnedIdentities = new Set([...state.data.pinnedMonitoredTokenIdentities, identityKey]);
    return rows.flatMap((item, index) => pinnedIdentities.has(getTokenIdentityKey(item))
      ? [{ chain: item.chain || 'solana', address: item.address, sortOrder: index }]
      : []);
  }

  function buildUnpinnedMonitoredPinLayout(chain: TokenChain, address: string) {
    const identityKey = getTrackedTokenKey(address, chain);
    const previous = captureMonitoredPinLayout();
    const removed = previous.find((item) => getTrackedTokenKey(item.address, item.chain) === identityKey);
    if (!removed) {
      return previous;
    }

    const currentRows = resolveMonitoredTableRows(getMonitoredTokens(state), {
      searchQuery: '',
      sortCriteria: state.ui.monitoredSorts,
    });
    const movedUpAddresses = new Set<string>();
    const removedIndex = currentRows.findIndex((item) => getTokenIdentityKey(item) === identityKey);
    if (removedIndex >= 0) {
      for (const item of currentRows.slice(removedIndex + 1)) {
        if (!item._isPinnedMonitored) break;
        movedUpAddresses.add(getTokenIdentityKey(item));
      }
    }

    return previous
      .filter((item) => getTrackedTokenKey(item.address, item.chain) !== identityKey)
      .map((item) => ({
        ...item,
        sortOrder: movedUpAddresses.has(getTrackedTokenKey(item.address, item.chain))
          ? Math.max(0, item.sortOrder - 1)
          : item.sortOrder,
      }));
  }

  async function refreshMonitoredAfterPinsChanged() {
    if (!state.session.token) return;
    await hydrateDashboardMonitoredInternal(state.session.token, getManualTokens(state).map((item) => ({
      chain: item.chain || 'solana',
      address: item.address,
      label: item.label ?? null,
    })));
  }

  function emitMonitoredWorkspaceRegions() {
    if (isLiveWorkspace()) {
      emit('monitored', 'manual', 'recent', 'old-week', 'alerts');
      return;
    }
    if (isHistoryWorkspace()) {
      void refreshBidZoneTokens({ force: true });
      emit('recent', 'old-week', 'bid-zone', 'header');
      return;
    }
    emit('recent', 'old-week', 'header');
  }

  function getMonitoredBootstrapSorts(): MonitoredSortCriterion[] {
    return normalizeMonitoredSorts(state.ui.monitoredSorts);
  }

  function buildHistoryBootstrapRequest(): HistoryBootstrapRequestPayload {
    const recentDebugProbeIdentities = isRuntimePerfDebugActive()
      ? state.data.recentTokenIdentities.slice(0, 30)
      : [];
    const recentPinnedIdentities = historyBucketOrderLocks.recent
      ? state.data.recentTokenIdentities.slice()
      : [];
    const oldWeekPinnedIdentities = historyBucketOrderLocks.oldWeek
      ? state.data.oldWeekTokenIdentities.slice()
      : [];

    return {
      chains: state.ui.chainFilters.radarChains.filter((chain) => (
        state.data.chainReadiness[chain]?.capabilities.history === true
      )),
      starredTokenIdentities: state.data.starredTokenIdentities,
      recentPinnedIdentities,
      oldWeekPinnedIdentities,
      recentDebugProbeIdentities,
      recent: {
        page: state.ui.recentPage,
        perPage: state.ui.recentPerPage,
        searchQuery: state.ui.recentSearchQuery,
        starredOnly: state.ui.recentStarredOnly,
        sorts: state.ui.recentSorts,
        dismissedTokenIdentities: [...state.data.dismissedRecentIdentities],
        mcapMin: getConfigNumber('old-mcap-min', 120000),
        mcapMax: getConfigNumber('old-mcap-max', 100000000),
        fdvMin: getConfigNumber('old-fdv-min', 120000),
        fdvMax: getConfigNumber('old-fdv-max', 100000000),
        ageMinMinutes: getConfigNumber('recent-age-min', 0),
        ageMaxMinutes: getConfigNumber('recent-age-max', RECENT_MAX_AGE_MINUTES),
      },
      oldWeek: {
        page: state.ui.oldWeekPage,
        perPage: state.ui.oldWeekPerPage,
        searchQuery: state.ui.oldWeekSearchQuery,
        starredOnly: state.ui.oldWeekStarredOnly,
        sorts: state.ui.oldWeekSorts,
        dismissedTokenIdentities: [...state.data.dismissedOldWeekIdentities],
        mcapMin: getConfigNumber('old-week-mcap-min', 120000),
        mcapMax: getConfigNumber('old-week-mcap-max', 100000000),
        fdvMin: getConfigNumber('old-week-fdv-min', 120000),
        fdvMax: getConfigNumber('old-week-fdv-max', 100000000),
        ageMinMinutes: getConfigNumber('old-week-age-min', OLD_WEEK_MIN_AGE_MINUTES),
        ageMaxMinutes: getConfigNumber('old-week-age-max', 0),
      },
    };
  }

  function isCurrentHistoryBootstrapRequest(requestPayload: HistoryBootstrapRequestPayload) {
    return JSON.stringify(buildComparableHistoryBootstrapRequest(requestPayload))
      === JSON.stringify(buildComparableHistoryBootstrapRequest(buildHistoryBootstrapRequest()));
  }

  function buildComparableHistoryBootstrapRequest(requestPayload: HistoryBootstrapRequestPayload) {
    return {
      chains: requestPayload.chains,
      starredTokenIdentities: requestPayload.starredTokenIdentities,
      recent: requestPayload.recent,
      oldWeek: requestPayload.oldWeek,
      recentPinnedIdentities: requestPayload.recentPinnedIdentities ?? [],
      oldWeekPinnedIdentities: requestPayload.oldWeekPinnedIdentities ?? [],
    };
  }

  function buildHistoryBootstrapOrderLockKey(requestPayload: HistoryBootstrapRequestPayload) {
    return JSON.stringify({
      token: state.session.token ?? '',
      chains: requestPayload.chains,
      starredTokenIdentities: requestPayload.starredTokenIdentities,
      recent: requestPayload.recent,
      oldWeek: requestPayload.oldWeek,
    });
  }

  function isCurrentHistoryBootstrapOrderLockReady() {
    return Boolean(lastAppliedHistoryBootstrapOrderLockKey)
      && lastAppliedHistoryBootstrapOrderLockKey === buildHistoryBootstrapOrderLockKey(buildHistoryBootstrapRequest());
  }

  function buildHistoryBootstrapRequestKey(
    token: string,
    requestPayload: HistoryBootstrapRequestPayload,
    manualTokensOverride?: AddressItem[],
  ) {
    return JSON.stringify({
      token,
      requestPayload: buildComparableHistoryBootstrapRequest(requestPayload),
      manualTokensOverride: (manualTokensOverride || []).map((item) => ({
        address: item.address,
        label: item.label ?? null,
      })),
    });
  }

  function queueHistoryBootstrapRefreshIfInFlight(
    token: string,
    requestKey: string,
    options?: HistoryBootstrapRefreshOptions,
  ) {
    if (!historyBootstrapRefreshInFlight) {
      return false;
    }

    if (requestKey !== historyBootstrapInFlightRequestKey) {
      queuedHistoryBootstrapRefresh = {
        token,
        manualTokensOverride: options?.manualTokensOverride,
        suppressErrors: options?.suppressErrors,
      };
      historyBootstrapRequestRevision += 1;
    }

    return true;
  }

  function flushQueuedHistoryBootstrapRefresh() {
    historyBootstrapRefreshInFlight = false;
    historyBootstrapInFlightRequestKey = '';
    const queuedRefresh = queuedHistoryBootstrapRefresh;
    queuedHistoryBootstrapRefresh = null;
    if (!queuedRefresh || state.session.token !== queuedRefresh.token || !usesHistoryBucketBootstrap()) {
      return;
    }

    void refreshHistoryWorkspaceBootstrap(queuedRefresh);
  }

  function isHistoryBucketOrderLocked(bucket: 'recent' | 'old-week') {
    return bucket === 'recent' ? historyBucketOrderLocks.recent : historyBucketOrderLocks.oldWeek;
  }

  function mergeLockedHistoryBucketSnapshots(
    tokens: DashboardMonitoredToken[],
    lockedIdentities: string[],
  ) {
    const byIdentity = new Map(tokens.map((item) => [getTrackedTokenKey(item.address, item.chain), item]));
    for (const identityKey of lockedIdentities) {
      if (byIdentity.has(identityKey)) {
        continue;
      }

      const identity = parseTokenIdentityKey(identityKey);
      const snapshot = buildCurrentMonitoredSnapshotToken(identity.address, identity.chain);
      if (snapshot) {
        byIdentity.set(identityKey, snapshot);
      }
    }
    return [...byIdentity.values()];
  }

  function sanitizeHistoryBucketOrder(bucket: 'recent' | 'old-week', identities: string[]) {
    const dismissed = new Set(bucket === 'recent'
      ? state.data.dismissedRecentIdentities
      : state.data.dismissedOldWeekIdentities);
    const blocked = new Set(state.data.blocklist.map((item) => (
      getTrackedTokenKey(item.address, item.chain || 'solana')
    )));
    return identities.filter((identity) => (
      !dismissed.has(identity)
      && !blocked.has(identity)
      && Boolean(getTrackedTokenByIdentity(identity))
    ));
  }

  function resolveHistoryBucketOrderForApply(
    bucket: 'recent' | 'old-week',
    previousAddresses: string[],
    nextAddresses: string[],
  ) {
    const locked = isHistoryBucketOrderLocked(bucket);
    return {
      locked,
      lockedAddresses: locked ? previousAddresses : [],
      visibleAddresses: locked ? previousAddresses : nextAddresses,
      pendingAddresses: locked ? nextAddresses : null,
    };
  }

  function setPendingHistoryOrder(bucket: 'recent' | 'old-week', addresses: string[] | null) {
    if (bucket === 'recent') {
      pendingRecentHistoryOrder = addresses;
      return;
    }
    pendingOldWeekHistoryOrder = addresses;
  }

  function applyPendingHistoryOrder(bucket: 'recent' | 'old-week') {
    if (bucket === 'recent') {
      if (!pendingRecentHistoryOrder) {
        return false;
      }
      state.data.recentTokenIdentities = sanitizeHistoryBucketOrder('recent', pendingRecentHistoryOrder);
      pendingRecentHistoryOrder = null;
      state.runtime.routedRevision += 1;
      syncRoutedPagination();
      return true;
    }

    if (!pendingOldWeekHistoryOrder) {
      return false;
    }
    state.data.oldWeekTokenIdentities = sanitizeHistoryBucketOrder('old-week', pendingOldWeekHistoryOrder);
    pendingOldWeekHistoryOrder = null;
    state.runtime.routedRevision += 1;
    syncRoutedPagination();
    return true;
  }

  function clearHistoryBucketOrderLock(bucket: 'recent' | 'old-week', options?: { applyPending?: boolean }) {
    if (bucket === 'recent') {
      const wasLocked = historyBucketOrderLocks.recent;
      historyBucketOrderLocks.recent = false;
      if (options?.applyPending === false) {
        pendingRecentHistoryOrder = null;
        return false;
      }
      return wasLocked && applyPendingHistoryOrder('recent');
    }

    const wasLocked = historyBucketOrderLocks.oldWeek;
    historyBucketOrderLocks.oldWeek = false;
    if (options?.applyPending === false) {
      pendingOldWeekHistoryOrder = null;
      return false;
    }
    return wasLocked && applyPendingHistoryOrder('old-week');
  }

  function clearHistoryBucketOrderLocks(options?: { applyPending?: boolean }) {
    const recentChanged = clearHistoryBucketOrderLock('recent', options);
    const oldWeekChanged = clearHistoryBucketOrderLock('old-week', options);
    return recentChanged || oldWeekChanged;
  }

  function applyHistoryBootstrapPayload(
    payload: Awaited<ReturnType<typeof fetchDashboardHistoryBootstrap>>,
    manualTokensOverride?: AddressItem[],
    appliedRequestPayload?: HistoryBootstrapRequestPayload,
  ) {
    const previousRecentIdentities = state.data.recentTokenIdentities.slice();
    const previousOldWeekIdentities = state.data.oldWeekTokenIdentities.slice();
    const previousRecentDebugMap = buildPreviousRecentDebugMap(previousRecentIdentities);
    const requestedRecentPage = Math.max(0, Number(payload.recent.page) || 0);
    const requestedOldWeekPage = Math.max(0, Number(payload.oldWeek.page) || 0);
    const recentTokens = payload.recent.tokens || [];
    const oldWeekTokens = payload.oldWeek.tokens || [];
    const recentPinnedTokens = payload.recent.pinnedTokens || [];
    const oldWeekPinnedTokens = payload.oldWeek.pinnedTokens || [];
    const nextRecentIdentities = recentTokens.map((item) => getTrackedTokenKey(item.address, item.chain));
    const nextOldWeekIdentities = oldWeekTokens.map((item) => getTrackedTokenKey(item.address, item.chain));
    const nextRecentDebugMap = buildPayloadRecentDebugMap(recentTokens);
    const historyRequestDebug = buildHistoryBootstrapRequest();
    const recentOrder = resolveHistoryBucketOrderForApply('recent', previousRecentIdentities, nextRecentIdentities);
    const oldWeekOrder = resolveHistoryBucketOrderForApply('old-week', previousOldWeekIdentities, nextOldWeekIdentities);
    const monitoredDashboardTokens = mergeLockedHistoryBucketSnapshots(
      Array.from(new Map(
        [...recentTokens, ...oldWeekTokens, ...recentPinnedTokens, ...oldWeekPinnedTokens]
          .map((item) => [getTrackedTokenKey(item.address, item.chain), item]),
      ).values()),
      [...recentOrder.lockedAddresses, ...oldWeekOrder.lockedAddresses],
    );

    applyMonitoredDashboard(
      monitoredDashboardTokens.filter((item) => item.chain === 'solana'),
      manualTokensOverride,
      payload.asOf ?? payload.generatedAt ?? null,
      getCurrentPinnedMonitoredDashboardSnapshot(),
    );
    syncNonSolanaHistoryTrackedTokens(monitoredDashboardTokens);
    setPendingHistoryOrder('recent', recentOrder.pendingAddresses);
    setPendingHistoryOrder('old-week', oldWeekOrder.pendingAddresses);
    state.data.recentTokenIdentities = recentOrder.visibleAddresses;
    state.data.oldWeekTokenIdentities = oldWeekOrder.visibleAddresses;
    state.bars.recent = Math.max(0, Number(payload.recent.total) || 0);
    state.bars.oldWeek = Math.max(0, Number(payload.oldWeek.total) || 0);
    state.ui.recentPage = requestedRecentPage;
    state.ui.oldWeekPage = requestedOldWeekPage;
    state.runtime.routedRevision += 1;
    lastAppliedHistoryBootstrapOrderLockKey = buildHistoryBootstrapOrderLockKey(appliedRequestPayload ?? historyRequestDebug);
    syncRoutedPagination();
    syncWorkspaceMarketSubscriptions();
    const missingRecentTracked = state.data.recentTokenIdentities
      .filter((identity) => !getTrackedTokenByIdentity(identity))
      .slice(0, 12);
    const missingOldWeekTracked = state.data.oldWeekTokenIdentities
      .filter((identity) => !getTrackedTokenByIdentity(identity))
      .slice(0, 12);
    const oldWeekPreviousSet = new Set(previousOldWeekIdentities);
    const oldWeekNextSet = new Set(state.data.oldWeekTokenIdentities);
    const oldWeekAddedCount = state.data.oldWeekTokenIdentities.filter((identity) => !oldWeekPreviousSet.has(identity)).length;
    const oldWeekRemovedCount = previousOldWeekIdentities.filter((identity) => !oldWeekNextSet.has(identity)).length;
    recordRestoreControllerDebug('controller.history-bootstrap.apply', {
      generatedAt: payload.generatedAt ?? null,
      asOf: payload.asOf ?? null,
      recentReturned: recentTokens.length,
      oldWeekReturned: oldWeekTokens.length,
      recentTotal: state.bars.recent,
      oldWeekTotal: state.bars.oldWeek,
      recentRequest: summarizeHistoryRequestDebug(historyRequestDebug.recent),
      oldWeekRequest: summarizeHistoryRequestDebug(historyRequestDebug.oldWeek),
      recentDelta: summarizeCompactRecentDebugDelta(
        previousRecentIdentities,
        state.data.recentTokenIdentities,
        previousRecentDebugMap,
        nextRecentDebugMap,
      ),
      recentProbe: summarizeHistoryDebugProbe(
        payload.debug?.recentProbe,
        previousRecentIdentities,
        state.data.recentTokenIdentities,
      ),
      oldWeekDelta: {
        addedCount: oldWeekAddedCount,
        removedCount: oldWeekRemovedCount,
      },
      missingRecentTrackedCount: missingRecentTracked.length,
      missingRecentTracked,
      missingOldWeekTrackedCount: missingOldWeekTracked.length,
      recentHead: recentTokens.slice(0, 15).map((item, index) => summarizeCompactHistoryToken(item.address, item, index + 1)),
    });
  }

  function buildMonitoredDashboardPayload(
    manualTokensOverride?: Array<{ address: string; label?: string | null }>,
  ): ConfigPayload {
    return {
      configs: state.data.configs,
      uiPrefs: buildUiPrefsPayload(),
      tokens: (manualTokensOverride ?? getManualTokens(state).map((item) => ({
        chain: item.chain || 'solana', address: item.address, label: item.label ?? null,
      }))),
      blocklist: state.data.blocklist.map((item) => ({
        chain: item.chain || 'solana', address: item.address, label: item.label ?? null,
      })),
      starredTokens: state.data.starredTokenIdentities.flatMap((identityKey) => {
        const identity = parseTokenIdentityKey(identityKey);
        return [{ chain: identity.chain, address: identity.address }];
      }),
    };
  }

  function normalizeManualTokenFolderPayload(payload?: ManualTokenFoldersPayload | null) {
    const foldersById = new Map<number, ManualTokenFolderEntry>();
    const folders = (Array.isArray(payload?.folders) ? payload.folders : [])
      .map((folder) => ({
        id: Number(folder.id),
        userId: Number(folder.userId),
        parentFolderId: folder.parentFolderId == null ? null : Number(folder.parentFolderId),
        name: String(folder.name || '').trim(),
        sortOrder: Number(folder.sortOrder) || 0,
        createdAt: folder.createdAt ?? null,
        updatedAt: folder.updatedAt ?? null,
      }))
      .filter((folder) => Number.isInteger(folder.id) && folder.id > 0 && folder.name && folder.parentFolderId == null);

    for (const folder of folders) {
      foldersById.set(folder.id, folder);
    }

    const manualAddressSet = new Set(state.data.manualTokenIdentities);
    const items = (Array.isArray(payload?.items) ? payload.items : [])
      .map((item) => ({
        userId: Number(item.userId),
        folderId: Number(item.folderId),
        chain: resolveAppTokenChain(item.chain),
        address: String(item.address || '').trim(),
        sortOrder: Number(item.sortOrder) || 0,
        addedAt: item.addedAt ?? null,
      }))
      .filter((item) => foldersById.has(item.folderId)
        && manualAddressSet.has(getTrackedTokenKey(item.address, item.chain)));

    return {
      folders: folders.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id),
      items: items.sort((a, b) => a.folderId - b.folderId || a.sortOrder - b.sortOrder || a.address.localeCompare(b.address)),
    };
  }

  function applyManualTokenFolders(payload?: ManualTokenFoldersPayload | null) {
    const normalized = normalizeManualTokenFolderPayload(payload);
    const folderIds = new Set(normalized.folders.map((folder) => folder.id));
    state.data.manualTokenFolders = normalized.folders;
    state.data.manualTokenFolderItems = normalized.items;
    state.ui.manualVisibleFolderIds = state.ui.manualVisibleFolderIds.filter((id) => folderIds.has(id));
  }

  function filterPendingManualFolderDeletes(input: {
    configPayload: ConfigPayload;
    tokenFolders?: ManualTokenFoldersPayload | null;
  }) {
    if (pendingManualFolderDeleteIds.size === 0 && pendingManualFolderDeleteAddresses.size === 0) {
      return input;
    }

    const removedAddresses = pendingManualFolderDeleteAddresses;
    const removedFolderIds = pendingManualFolderDeleteIds;
    return {
      configPayload: {
        ...input.configPayload,
        tokens: input.configPayload.tokens.filter((item) => !removedAddresses.has(
          getTrackedTokenKey(item.address, item.chain || 'solana'),
        )),
      },
      tokenFolders: input.tokenFolders
        ? {
          folders: input.tokenFolders.folders.filter((folder) => !removedFolderIds.has(Number(folder.id))),
          items: input.tokenFolders.items.filter((item) => (
            !removedFolderIds.has(Number(item.folderId))
            && !removedAddresses.has(getTrackedTokenKey(item.address, item.chain))
          )),
        }
        : input.tokenFolders,
    };
  }

  function upsertManualTokenFolderItem(item: ManualTokenFolderItemEntry) {
    const folderId = Number(item.folderId);
    const chain = resolveAppTokenChain(item.chain);
    const address = String(item.address || '').trim();
    if (!Number.isInteger(folderId) || folderId <= 0 || !address) {
      return;
    }

    const exists = state.data.manualTokenFolders.some((folder) => folder.id === folderId);
    if (!exists) {
      return;
    }

    state.data.manualTokenFolderItems = [
      ...state.data.manualTokenFolderItems.filter((current) => (
        current.folderId !== folderId
        || current.chain !== chain
        || current.address !== address
      )),
      {
        userId: Number(item.userId) || 0,
        folderId,
        chain,
        address,
        sortOrder: Number(item.sortOrder) || 0,
        addedAt: item.addedAt ?? null,
      },
    ].sort((a, b) => a.folderId - b.folderId || a.sortOrder - b.sortOrder || a.address.localeCompare(b.address));
  }

  async function fetchConfigBundle(token: string) {
    const [configPayload, tokenFolders] = await Promise.all([
      fetchConfig(token),
      fetchManualTokenFolders(token),
    ]);
    return { configPayload, tokenFolders };
  }

  function syncMeteoraDashboardCache(
    monitoredDashboardTokens: DashboardMonitoredToken[],
    manualTokens: Array<{ chain?: TokenChain; address: string; label?: string | null }>,
    pinnedDashboardTokens: DashboardMonitoredToken[] = [],
  ) {
    const activeAddresses = new Set([
      ...monitoredDashboardTokens.map((item) => item.address),
      ...pinnedDashboardTokens.map((item) => item.address),
    ]);
    for (const item of manualTokens) {
      if (resolveAppTokenChain(item.chain) === 'solana') activeAddresses.add(item.address);
    }

    for (const address of Object.keys(state.data.meteoraByAddress)) {
      if (!activeAddresses.has(address)) {
        delete state.data.meteoraByAddress[address];
      }
    }

    for (const item of mergeDashboardTokenSnapshots(monitoredDashboardTokens, pinnedDashboardTokens)) {
      const meteoraItem = buildDashboardMeteoraBatchItem(item);
      if (meteoraItem) {
        syncMeteoraCacheEntry(item.address, meteoraItem);
      }
    }
  }

  function syncMeteoraBatchCache(items: MeteoraBatchItem[] = []) {
    for (const item of items) {
      if (!item?.address) continue;
      syncMeteoraCacheEntry(item.address, item);
    }
  }

  function syncMeteoraCacheEntry(address: string, item: MeteoraBatchItem) {
    state.data.meteoraByAddress[address] = {
      ...(state.data.meteoraByAddress[address] || {}),
      tvl: Number(item.tvl) || 0,
      poolAddress: item.poolAddress || null,
      poolCount: Number(item.poolCount) || 0,
      noPool: Boolean(item.noPool),
      lastFetch: Date.now(),
      lastCheckedAt: item.lastCheckedAt || null,
      lastSnapshotAt: item.lastSnapshotAt || null,
      change1h: item.change1h ?? null,
      change4h: item.change4h ?? null,
      change6h: item.change6h ?? null,
      change24h: item.change24h ?? null,
      volume1h: item.volume1h ?? null,
      volume4h: item.volume4h ?? null,
      volume24h: item.volume24h ?? null,
    };
  }

  function getSupplementalMeteoraAddresses(monitoredDashboardTokens: DashboardMonitoredToken[] = []) {
    const activeAddresses = new Set([
      ...Object.values(state.data.trackedTokensByIdentity)
        .filter((item) => (item.chain || 'solana') === 'solana')
        .map((item) => item.address),
      ...monitoredDashboardTokens
        .filter((item) => item.chain === 'solana')
        .map((item) => item.address),
    ]);
    return [...activeAddresses]
      .filter((address) => {
        const cached = state.data.meteoraByAddress[address];
        return !cached || (!cached.lastFetch && !cached.lastCheckedAt && !cached.poolAddress && cached.noPool !== true && !(cached.tvl > 0));
      })
      .sort((a, b) => a.localeCompare(b));
  }

  async function refreshSupplementalMeteoraState(token: string, monitoredDashboardTokens: DashboardMonitoredToken[] = []) {
    const addresses = getSupplementalMeteoraAddresses(monitoredDashboardTokens);
    if (addresses.length === 0) {
      return;
    }

    try {
      for (let index = 0; index < addresses.length; index += 500) {
        if (state.session.token !== token || !isAuthenticatedSession()) {
          return;
        }
        const items = await fetchMeteoraBatch(addresses.slice(index, index + 500), token);
        syncMeteoraBatchCache(items);
      }
    } catch (error) {
      console.warn('[AppController] Failed to hydrate supplemental Meteora state:', error instanceof Error ? error.message : error);
    }
  }

  function applyConfig(
    payload: ConfigPayload,
    monitoredDashboardTokens: DashboardMonitoredToken[] = [],
    pinnedDashboardTokens: DashboardMonitoredToken[] = [],
    tokenFolders?: ManualTokenFoldersPayload | null,
  ) {
    state.configSummary = {
      loaded: true,
      configCount: Object.keys(payload.configs || {}).length,
      manualTokens: payload.tokens.length,
      blocklist: payload.blocklist.length,
      starredTokens: payload.starredTokens.length,
      eligibleCatalogTokens: monitoredDashboardTokens.length,
    };
    state.data.configs = payload.configs || {};
    state.data.availableChains = normalizeAvailableTokenChains(payload.availableChains);
    state.data.chainReadiness = payload.chainReadiness || state.data.chainReadiness;
    state.data.runtimeFlags = {
      mockTradingEnabled: payload.runtimeFlags?.mockTradingEnabled !== false,
    };
    applyUiPreferencesFromConfigs();
    applyUiPreferences(payload.uiPrefs);
    if (!isMockTradingEnabled(state)) {
      clearMockTradingState();
    }
    persistSoundSettings();
    state.data.blocklist = sortAddresses(payload.blocklist.map((item) => ({
      ...item,
      chain: item.chain || 'solana',
    })));
    replaceStarredTokens(payload.starredTokens.map((item) => (
      getTrackedTokenKey(item.address, item.chain || 'solana')
    )));
    const beforeAlerts = state.data.alerts.slice();
    state.data.alerts = state.data.alerts.filter((item) => !isBlocked(item.address, item.chain));
    syncAlertState();
    recordAlertMutationDebug('config.apply-blocklist-filter', beforeAlerts, {
      blocklistCount: state.data.blocklist.length,
    });
    state.bars.blocklist = payload.blocklist.length;
    applyMonitoredDashboard(monitoredDashboardTokens, payload.tokens, undefined, pinnedDashboardTokens);
    applyManualTokenFolders(tokenFolders);
    refreshPumpPanelCounts();
  }

  function applyPagedMonitoredHydrationSnapshot(input: {
    token: string;
    manualTokens: AddressItem[];
    tokens: DashboardMonitoredToken[];
    pinnedTokens: DashboardMonitoredToken[];
    snapshotComplete: boolean;
    preserveExistingUntilComplete: boolean;
    generatedAt?: string | null;
  }) {
    if (input.preserveExistingUntilComplete && !input.snapshotComplete) {
      return false;
    }

    applyMonitoredDashboard(input.tokens, input.manualTokens, input.generatedAt, input.pinnedTokens);
    emitMonitoredWorkspaceRegions();
    queueSupplementalMeteoraRefresh(input.token, mergeDashboardTokenSnapshots(input.tokens, input.pinnedTokens));
    return true;
  }

  function isMonitoredHydrationPageComplete(input: {
    page: number;
    totalPages: number;
    loadedCount: number;
    total: number;
    hasMore: boolean;
  }) {
    return input.page >= input.totalPages - 1 || input.loadedCount >= input.total || !input.hasMore;
  }

  async function fetchMonitoredHydrationPage(input: {
    token: string;
    chains: TokenChain[];
    page: number;
    perPage: number;
    sorts: MonitoredSortCriterion[];
    asOf?: string | null;
    priority?: boolean;
  }) {
    return measureRuntimePerfAsync(
      'api.dashboard.monitored',
      isRuntimePerfDebugActive(),
      { workspace: state.ui.workspace, mode: 'bootstrap-page', page: input.page, perPage: input.perPage },
      () => fetchDashboardMonitored(input.token, {
        chains: input.chains,
        page: input.page,
        perPage: input.perPage,
        sorts: input.sorts,
        ...getMonitoredValuationFilters(),
        asOf: input.asOf || undefined,
        priority: input.priority,
      }),
    );
  }

  function isMonitoredHydrationCurrent(
    requestRevision: number,
    token: string,
    requestKey: string,
  ) {
    return requestRevision === monitoredBootstrapHydrationRevision
      && state.session.token === token
      && requestKey === buildChainRequestKey(getReadySelectedChains('monitored'));
  }

  function refreshFirstMonitoredPageSparklines(token: string, applied: boolean) {
    if (!applied) return;
    void refreshHistoryWorkspaceSparklines({
      token,
      caller: 'monitored-bootstrap-first-page',
    });
  }

  async function hydratePriorityMonitoredPage(
    token: string,
    manualTokens: AddressItem[],
    chains: TokenChain[],
  ) {
    if (getCurrentMonitoredDashboardSnapshot().length > 0) return true;
    const requestRevision = monitoredBootstrapHydrationRevision + 1;
    monitoredBootstrapHydrationRevision = requestRevision;
    const requestKey = buildChainRequestKey(chains);
    const perPage = Math.min(
      MONITORED_DASHBOARD_HYDRATION_PAGE_SIZE,
      normalizeUiPerPage(state.ui.monitoredPerPage, 30),
    );
    const firstPage = await fetchMonitoredHydrationPage({
      token,
      chains,
      page: 0,
      perPage,
      sorts: getMonitoredBootstrapSorts(),
      priority: true,
    });
    if (!isMonitoredHydrationCurrent(requestRevision, token, requestKey)) return false;

    const tokens = [...(firstPage.tokens || [])];
    const snapshotComplete = tokens.length >= firstPage.total || !firstPage.hasMore;
    const applied = applyPagedMonitoredHydrationSnapshot({
      token,
      manualTokens,
      tokens,
      pinnedTokens: firstPage.pinnedTokens || [],
      snapshotComplete,
      preserveExistingUntilComplete: false,
      generatedAt: firstPage.generatedAt ?? firstPage.asOf ?? null,
    });
    refreshFirstMonitoredPageSparklines(token, applied);
    void hydrateManualTokensMetadataBatch(token, manualTokens, { emitOnComplete: false });
    recordRestoreControllerDebug('controller.dashboard-hydrate.monitored.priority-page', {
      generatedAt: firstPage.generatedAt ?? firstPage.asOf ?? null,
      returned: tokens.length,
      total: firstPage.total,
      hasMore: firstPage.hasMore,
      payloadHead: summarizeDashboardDebugTokens(tokens),
    });
    return true;
  }

  async function hydrateRemainingMonitoredPages(input: {
    token: string;
    manualTokens: AddressItem[];
    chains: TokenChain[];
    requestRevision: number;
    requestKey: string;
    pageSize: number;
    sorts: MonitoredSortCriterion[];
    totalPages: number;
    total: number;
    snapshotAsOf: string | null;
    generatedAt: string | null;
    pinnedTokens: DashboardMonitoredToken[];
    preserveExistingUntilComplete: boolean;
    aggregatedTokens: DashboardMonitoredToken[];
  }) {
    let aggregatedTokens = input.aggregatedTokens;
    for (let page = 1; page < input.totalPages; page += 1) {
      if (!isMonitoredHydrationCurrent(input.requestRevision, input.token, input.requestKey)) {
        return null;
      }

      const nextPage = await fetchMonitoredHydrationPage({
        token: input.token,
        chains: input.chains,
        page,
        perPage: input.pageSize,
        sorts: input.sorts,
        asOf: input.snapshotAsOf,
      });
      if (!isMonitoredHydrationCurrent(input.requestRevision, input.token, input.requestKey)) {
        return null;
      }
      const nextSnapshotAsOf = nextPage.asOf ?? nextPage.generatedAt ?? null;
      if (nextSnapshotAsOf !== input.snapshotAsOf) {
        nextMonitoredFullHydrationAt = Date.now() + MONITORED_FULL_HYDRATION_INTERVAL_MS;
        recordRestoreControllerDebug('controller.dashboard-hydrate.monitored.snapshot-mismatch', {
          expectedAsOf: input.snapshotAsOf,
          receivedAsOf: nextSnapshotAsOf,
          page,
        });
        return null;
      }

      if (nextPage.tokens.length === 0) {
        applyPagedMonitoredHydrationSnapshot({
          token: input.token,
          manualTokens: input.manualTokens,
          tokens: aggregatedTokens,
          pinnedTokens: input.pinnedTokens,
          snapshotComplete: true,
          preserveExistingUntilComplete: input.preserveExistingUntilComplete,
          generatedAt: input.generatedAt,
        });
        break;
      }

      aggregatedTokens = Array.from(new Map(
        [...aggregatedTokens, ...nextPage.tokens]
          .map((item) => [getTrackedTokenKey(item.address, item.chain), item]),
      ).values());
      const snapshotComplete = isMonitoredHydrationPageComplete({
        page,
        totalPages: input.totalPages,
        loadedCount: aggregatedTokens.length,
        total: input.total,
        hasMore: nextPage.hasMore,
      });
      const applied = applyPagedMonitoredHydrationSnapshot({
        token: input.token,
        manualTokens: input.manualTokens,
        tokens: aggregatedTokens,
        pinnedTokens: input.pinnedTokens,
        snapshotComplete,
        preserveExistingUntilComplete: input.preserveExistingUntilComplete,
        generatedAt: input.generatedAt,
      });
      if (applied) {
        void hydrateManualTokensMetadataBatch(input.token, input.manualTokens, { emitOnComplete: false });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return aggregatedTokens;
  }

  async function hydratePagedDashboardMonitored(
    token: string,
    manualTokens: AddressItem[],
    chains = getReadySelectedChains('monitored'),
    options: { fullHydration?: boolean } = {},
  ) {
    const fullHydration = options.fullHydration !== false;
    if (fullHydration) {
      nextMonitoredFullHydrationAt = Date.now() + MONITORED_FULL_HYDRATION_INTERVAL_MS;
    }
    const requestRevision = monitoredBootstrapHydrationRevision + 1;
    monitoredBootstrapHydrationRevision = requestRevision;
    const pageSize = MONITORED_DASHBOARD_HYDRATION_PAGE_SIZE;
    const bootstrapSorts = getMonitoredBootstrapSorts();
    const requestKey = buildChainRequestKey(chains);
    const existingSnapshot = getCurrentMonitoredDashboardSnapshot();
    const preserveExistingUntilComplete = existingSnapshot.length > 0;
    const firstPage = await fetchMonitoredHydrationPage({
      token,
      chains,
      page: 0,
      perPage: pageSize,
      sorts: bootstrapSorts,
    });
    if (!isMonitoredHydrationCurrent(requestRevision, token, requestKey)) {
      return;
    }

    let aggregatedTokens = [...(firstPage.tokens || [])];
    const pinnedTokens = firstPage.pinnedTokens || [];
    const snapshotAsOf = firstPage.asOf ?? firstPage.generatedAt ?? null;
    const generatedAt = firstPage.generatedAt ?? snapshotAsOf;
    const totalPages = Math.min(
      MONITORED_DASHBOARD_HYDRATION_MAX_ITEMS / pageSize,
      Math.ceil(Math.max(firstPage.total, aggregatedTokens.length)
        / Math.max(firstPage.perPage || pageSize, 1)),
    );
    const firstPageComplete = isMonitoredHydrationPageComplete({
      page: 0,
      totalPages,
      loadedCount: aggregatedTokens.length,
      total: firstPage.total,
      hasMore: firstPage.hasMore,
    });
    const previewTokens = firstPageComplete
      ? aggregatedTokens
      : mergeMonitoredFirstPage(existingSnapshot, aggregatedTokens);
    const firstPageApplied = applyPagedMonitoredHydrationSnapshot({
      token,
      manualTokens,
      tokens: previewTokens,
      pinnedTokens,
      snapshotComplete: true,
      preserveExistingUntilComplete: false,
      generatedAt,
    });
    refreshFirstMonitoredPageSparklines(token, firstPageApplied);
    void hydrateManualTokensMetadataBatch(token, manualTokens, { emitOnComplete: false });
    recordRestoreControllerDebug('controller.dashboard-hydrate.monitored.first-page', {
      generatedAt,
      returned: firstPage.tokens.length,
      total: firstPage.total,
      hasMore: firstPage.hasMore,
      payloadHead: summarizeDashboardDebugTokens(firstPage.tokens),
    });

    if (firstPageComplete || !fullHydration) {
      if (fullHydration) {
        nextMonitoredFullHydrationAt = Date.now() + MONITORED_FULL_HYDRATION_INTERVAL_MS;
      }
      recordRestoreControllerDebug('controller.dashboard-hydrate.monitored.complete', {
        total: previewTokens.length,
        partialRefresh: !firstPageComplete,
        payloadHead: summarizeDashboardDebugTokens(previewTokens),
      });
      return;
    }

    const completedTokens = await hydrateRemainingMonitoredPages({
      token,
      manualTokens,
      chains,
      requestRevision,
      requestKey,
      pageSize,
      sorts: bootstrapSorts,
      totalPages,
      total: firstPage.total,
      snapshotAsOf,
      generatedAt,
      pinnedTokens,
      preserveExistingUntilComplete,
      aggregatedTokens,
    });
    if (!completedTokens) return;
    aggregatedTokens = completedTokens;
    recordRestoreControllerDebug('controller.dashboard-hydrate.monitored.complete', {
      total: aggregatedTokens.length,
      payloadHead: summarizeDashboardDebugTokens(aggregatedTokens),
    });
    nextMonitoredFullHydrationAt = Date.now() + MONITORED_FULL_HYDRATION_INTERVAL_MS;
  }

  async function hydrateDashboardMonitoredInternal(
    token: string,
    manualTokens: AddressItem[],
  ) {
    recordRestoreControllerDebug('controller.dashboard-hydrate.start', {
      manualTokens: manualTokens.length,
      usesHistoryBootstrap: usesHistoryBucketBootstrap(),
    });
    if (
      (usesHistoryBucketBootstrap() && !selectedChainsSupport('history'))
      || (!usesHistoryBucketBootstrap() && !selectedChainsSupport('monitored'))
    ) {
      emitMonitoredWorkspaceRegions();
      return;
    }
    try {
      if (usesHistoryBucketBootstrap()) {
        await Promise.all([
          refreshHistoryWorkspaceBootstrap({
            token,
            manualTokensOverride: manualTokens,
            suppressErrors: true,
          }),
          hydrateManualTokensMetadataBatch(token, manualTokens, { emitOnComplete: false }),
        ]);
        if (isHistoryWorkspace()) {
          void refreshBidZoneTokens({ force: true });
          emit('recent', 'old-week', 'bid-zone', 'header');
        } else {
          emit('recent', 'old-week', 'header');
        }
        recordRestoreControllerDebug('controller.dashboard-hydrate.history.complete', {
          manualTokens: manualTokens.length,
        });
        return;
      }

      const priorityCurrent = await hydratePriorityMonitoredPage(token, manualTokens, getReadySelectedChains('monitored'));
      if (!priorityCurrent) return;
      await hydratePagedDashboardMonitored(token, manualTokens);
      state.ui.monitoredLoadError = null;
      emitMonitoredWorkspaceRegions();
      void refreshDashboardTopPerformers(token);
    } catch (error) {
      state.ui.monitoredLoadError = error instanceof Error
        ? error.message : 'Failed to load monitored tokens';
      recordRestoreControllerDebug('controller.dashboard-hydrate.error', {
        message: formatDebugErrorMessage(error),
      });
      emitMonitoredWorkspaceRegions();
    }
  }

  async function reloadConfigInternal(token: string, options?: { deferDashboard?: boolean }) {
    const requestRevision = configReloadRevision + 1;
    configReloadRevision = requestRevision;
    recordRestoreControllerDebug('controller.config-reload.start', {
      deferDashboard: Boolean(options?.deferDashboard),
    });
    const { configPayload: rawPayload, tokenFolders: rawTokenFolders } = await fetchConfigBundle(token);
    if (requestRevision !== configReloadRevision || state.session.token !== token || state.session.status !== 'authenticated') {
      return;
    }
    const { configPayload: payload, tokenFolders } = filterPendingManualFolderDeletes({
      configPayload: rawPayload,
      tokenFolders: rawTokenFolders,
    });

    applyConfig(payload, getCurrentMonitoredDashboardSnapshot(), getCurrentPinnedMonitoredDashboardSnapshot(), tokenFolders);
    recordRestoreControllerDebug('controller.config-reload.apply-preserved-dashboard', {
      deferDashboard: Boolean(options?.deferDashboard),
      manualTokens: payload.tokens.length,
    });

    if (options?.deferDashboard) {
      void hydrateDashboardMonitoredInternal(token, payload.tokens);
      return;
    }

    await hydrateDashboardMonitoredInternal(token, payload.tokens);
  }

  async function reloadConfigPreservingMonitoredSnapshot(token: string) {
    const requestRevision = configReloadRevision + 1;
    configReloadRevision = requestRevision;
    const { configPayload: rawPayload, tokenFolders: rawTokenFolders } = await fetchConfigBundle(token);
    if (requestRevision !== configReloadRevision || state.session.token !== token || state.session.status !== 'authenticated') {
      return;
    }
    const { configPayload: payload, tokenFolders } = filterPendingManualFolderDeletes({
      configPayload: rawPayload,
      tokenFolders: rawTokenFolders,
    });
    applyConfig(payload, getCurrentMonitoredDashboardSnapshot(), getCurrentPinnedMonitoredDashboardSnapshot(), tokenFolders);
  }

  function buildAdminTokenReviewAlertsSignature(alerts = state.data.adminTokenReviewAlerts) {
    return alerts
      .map((alert) => `${alert.id}:${alert.status}:${alert.updatedAt || ''}`)
      .join('|');
  }

  async function loadAdminTokenReviewAlertsInternal() {
    const beforeSignature = buildAdminTokenReviewAlertsSignature();
    const token = state.session.token;
    if (!token || state.session.role !== 'admin') {
      state.data.adminTokenReviewAlerts = [];
      return beforeSignature !== buildAdminTokenReviewAlertsSignature();
    }

    const result = await fetchAdminTokenReviewAlerts(token, 'open');
    state.data.adminTokenReviewAlerts = (result.alerts as AdminTokenReviewAlertEntry[])
      .filter((alert) => !hasExcludedAdminTokenReviewSuffix(alert));
    return beforeSignature !== buildAdminTokenReviewAlertsSignature();
  }

  async function autoRefreshAdminTokenReviewAlerts() {
    if (
      adminTokenReviewAlertRefreshInFlight
      || state.runtime.mode !== 'active'
      || state.session.status !== 'authenticated'
      || state.session.role !== 'admin'
      || !state.session.token
    ) {
      return;
    }

    adminTokenReviewAlertRefreshInFlight = true;
    try {
      const changed = await loadAdminTokenReviewAlertsInternal();
      if (changed) {
        emit('header', 'alerts', 'overlay');
      }
    } catch (error) {
      console.warn('[AppController] Failed to auto-refresh token review alerts:', error instanceof Error ? error.message : error);
    } finally {
      adminTokenReviewAlertRefreshInFlight = false;
    }
  }

  function syncAdminTokenReviewAlertPolling(options?: { runImmediately?: boolean }) {
    const shouldRun = state.session.status === 'authenticated' && state.session.role === 'admin' && Boolean(state.session.token);
    if (!shouldRun) {
      if (adminTokenReviewAlertRefreshInterval) {
        clearInterval(adminTokenReviewAlertRefreshInterval);
        adminTokenReviewAlertRefreshInterval = null;
      }
      if (state.data.adminTokenReviewAlerts.length > 0) {
        state.data.adminTokenReviewAlerts = [];
        emit('header', 'alerts', 'overlay');
      }
      return;
    }

    if (options?.runImmediately) {
      void autoRefreshAdminTokenReviewAlerts();
    }
    if (!adminTokenReviewAlertRefreshInterval) {
      adminTokenReviewAlertRefreshInterval = setInterval(
        () => void autoRefreshAdminTokenReviewAlerts(),
        ADMIN_TOKEN_REVIEW_ALERT_REFRESH_INTERVAL_MS,
      );
    }
  }

  function hasExcludedAdminTokenReviewSuffix(alert: AdminTokenReviewAlertEntry) {
    const assessment = alert.assessment || {};
    return [
      alert.tokenAddress,
      getRecordStringValue(assessment, 'symbol'),
      getRecordStringValue(assessment, 'name'),
    ].some(hasExcludedAdminTokenReviewSuffixValue);
  }

  function hasExcludedAdminTokenReviewSuffixValue(value: string | null | undefined) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+$/g, '');
    return Boolean(normalized) && ADMIN_TOKEN_REVIEW_EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  }

  function getRecordStringValue(record: Record<string, unknown> | null | undefined, key: string) {
    const value = record?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  async function refreshRestoredSessionStateInternal(options: { force?: boolean } = {}) {
    const token = state.session.token;
    if (state.session.status !== 'authenticated' || !token) {
      return;
    }

    const now = Date.now();
    if (restoredSessionRefreshInFlight || (!options.force && now < nextRestoredSessionRefreshAt)) {
      recordRestoreControllerDebug('controller.restored-refresh.skip', {
        force: Boolean(options.force),
        inFlight: restoredSessionRefreshInFlight,
        waitMs: Math.max(0, nextRestoredSessionRefreshAt - now),
      });
      return;
    }

    restoredSessionRefreshInFlight = true;
    nextRestoredSessionRefreshAt = now + RESTORED_SESSION_CONFIG_REFRESH_MS;
    recordRestoreControllerDebug('controller.restored-refresh.start', {
      force: Boolean(options.force),
      preservedSnapshot: getCurrentMonitoredDashboardSnapshot().length,
    });

    try {
      const requestRevision = configReloadRevision;
      const { configPayload: rawPayload, tokenFolders: rawTokenFolders } = await fetchConfigBundle(token);
      if (requestRevision !== configReloadRevision || state.session.token !== token || state.session.status !== 'authenticated') {
        return;
      }
      const { configPayload: payload, tokenFolders } = filterPendingManualFolderDeletes({
        configPayload: rawPayload,
        tokenFolders: rawTokenFolders,
      });

      applyConfig(payload, getCurrentMonitoredDashboardSnapshot(), getCurrentPinnedMonitoredDashboardSnapshot(), tokenFolders);
      emit('all');
      void hydrateDashboardMonitoredInternal(token, payload.tokens);
      recordRestoreControllerDebug('controller.restored-refresh.apply-preserved-snapshot', {
        force: Boolean(options.force),
        manualTokens: payload.tokens.length,
      });
      void refreshMockTradingState();
      if (shouldRunHistoryAnalyticsRuntime()) {
        void refreshBidZoneTokens({ force: true });
      }
    } catch (error) {
      console.warn('[AppController] Failed to refresh restored session state:', error instanceof Error ? error.message : error);
    } finally {
      restoredSessionRefreshInFlight = false;
    }
  }

  async function applyVerifiedEmailPreAccessResult(result: VerifyEmailConfirmResponse) {
    disconnectSocket();
    stopMonitoringTimers();
    clearSession();
    applyPreAccessSession(result.user);
    applyAccountAccess(result.access ?? null);
    navigateToPreAccess(result.redirectPath || '/access');

    try {
      await refreshPreAccessState();
      setNotice(result.message || 'Email verified successfully. Continue to access setup.');
    } catch {
      setError(AUTH_ERROR_COOKIE_BLOCKED);
    }

    emit('all');
    flushEmit();
  }

  async function applyVerifiedEmailSuccessResult(result: VerifyEmailConfirmResponse) {
    const session = await fetchCurrentSession();
    applySession(session.user, { deferWorkspaceSync: true });
    applyAccountAccess(result.access ?? null);
    await Promise.all([
      refreshBillingState(COOKIE_SESSION_MARKER),
      refreshIdentityState(COOKIE_SESSION_MARKER),
    ]);
    await reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true });
    navigateToWorkspace('live');
    state.ui.authPanel = 'email-verified-success';
    setNotice(result.message || 'Email verified successfully.');
    emit('all');
    flushEmit();
  }

  async function processVerifyEmailRouteIntent(token: string | null) {
    if (!token) {
      setError('Verification link is missing or invalid.');
      clearAuthUrl();
      return;
    }

    setBusy(true);
    setError(null);
    setNotice('Verifying email...');
    emit();

    try {
      const result = await confirmEmailVerificationRequest(token);
      if (result.requiresPreAccess) {
        await applyVerifiedEmailPreAccessResult(result);
        return;
      }

      await applyVerifiedEmailSuccessResult(result);
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      setError(raw.includes('Authentication required') ? AUTH_ERROR_COOKIE_BLOCKED : raw || 'Email verification failed');
    } finally {
      clearAuthUrl();
      setBusy(false);
      emit();
    }
  }

  function processResetPasswordRouteIntent(token: string | null) {
    state.ui.pendingPasswordResetToken = token || null;
    state.ui.authPanel = 'password-reset';
    setError(token ? null : 'Reset link is missing or invalid.');
    setNotice(token ? 'Set a new password to finish the reset.' : null);
    clearAuthUrl();
    emit();
  }

  async function handleAuthRouteIntent() {
    if (typeof window === 'undefined') {
      return;
    }

    const intent = getAuthRouteIntent(window.location);
    if (!intent) {
      return;
    }

    if (intent.mode === 'verify-email') {
      await processVerifyEmailRouteIntent(intent.token);
      return;
    }

    processResetPasswordRouteIntent(intent.token);
  }

  function shouldHandleSocialLinkPopupIntent(intent: SocialIntent | null) {
    return Boolean(
      typeof window !== 'undefined'
      && intent
      && (window.name === SOCIAL_LINK_POPUP_WINDOW_NAME || (window.opener && !window.opener.closed))
    );
  }

  function handleSocialLinkPopupIntent(intent: SocialIntent) {
    if (typeof window === 'undefined') {
      return;
    }

    publishSocialLinkResult(intent);
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: SOCIAL_LINK_RESULT_MESSAGE_TYPE,
          provider: intent.provider,
          status: intent.status,
        }, window.location.origin);
      }
    } catch {
      // Ignore cross-tab messaging failures and fall back to storage sync.
    }

    clearSocialLinkUrl();
    window.close();
    window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // Ignore delayed popup close failures.
      }
    }, 120);
    setNotice(`${getSocialProviderLabel(intent.provider)} linking finished. You can close this tab if it stays open.`);
    emit();
  }

  function resetUiForAuthRouteIntent() {
    if (state.session.status === 'loading') {
      state.session.status = 'anonymous';
    }
    setBusy(false);
    setError(null);
    setNotice(null);
    emit();
  }

  async function handleInitAuthRouteIntent() {
    if (typeof window === 'undefined' || !hasAuthRouteIntent(window.location)) {
      return false;
    }

    resetUiForAuthRouteIntent();
    await handleAuthRouteIntent();
    syncWorkspaceFromLocationInternal({ canonicalize: false });
    return true;
  }

  function applyAuthenticatedRestoreIntents(options: {
    billingCheckoutSucceeded: boolean;
    socialLinkIntent: SocialIntent | null;
    socialLoginIntent: SocialIntent | null;
  }) {
    if (options.billingCheckoutSucceeded) {
      state.ui.authPanel = 'user-settings';
      replaceAuthPanelRoute('user-settings');
      clearBillingCheckoutUrl();
    }

    if (options.socialLinkIntent) {
      state.ui.authPanel = 'user-settings';
      replaceAuthPanelRoute('user-settings');
      clearSocialLinkUrl();
      if (options.socialLinkIntent.status === 'success') {
        setNotice(`${getSocialProviderLabel(options.socialLinkIntent.provider)} linked successfully.`);
      } else {
        setError(getInitSocialLinkErrorMessage(options.socialLinkIntent));
      }
    }

    if (options.socialLoginIntent?.status === 'success') {
      clearSocialLoginUrl();
      setNotice(`${getSocialProviderLabel(options.socialLoginIntent.provider)} sign-in successful.`);
    }
  }

  function getAuthenticatedRestoreNotice(options: {
    billingCheckoutSucceeded: boolean;
    socialLinkIntent: SocialIntent | null;
    socialLoginIntent: SocialIntent | null;
  }) {
    if (options.socialLinkIntent || options.socialLoginIntent?.status === 'success') {
      return state.ui.notice;
    }
    if (options.billingCheckoutSucceeded) {
      return 'Billing checkout completed. Access and billing history were refreshed.';
    }
    return AUTH_NOTICE_SESSION_RESTORED;
  }

  async function restoreAuthenticatedSession(options: {
    billingCheckoutSucceeded: boolean;
    socialLinkIntent: SocialIntent | null;
    socialLoginIntent: SocialIntent | null;
  }) {
    const session = await fetchCurrentSession();
    applySession(session.user, { deferWorkspaceSync: true });
    await refreshAuthenticatedBootstrapState();
    applyAuthenticatedRestoreIntents(options);
    setNotice(getAuthenticatedRestoreNotice(options));
  }

  async function handlePreAccessRestore(options: {
    billingCheckoutSucceeded: boolean;
    billingCheckoutOrderId: number | null;
    socialLoginIntent: SocialIntent | null;
  }) {
    if (options.billingCheckoutSucceeded && options.billingCheckoutOrderId) {
      try {
        await syncPreAccessOrder(options.billingCheckoutOrderId);
      } catch (_) {
        // The normal webhook/polling path can still complete the checkout.
      }
    }

    await refreshPreAccessState();
    navigateToPreAccess();
    setError(null);
    state.ui.loginErrorCount = 0;

    if (options.billingCheckoutSucceeded) {
      state.preAccess.pendingBillingOrderId = options.billingCheckoutOrderId;
      clearBillingCheckoutUrl();
      state.preAccess.awaitingConfirmation = true;
      setNotice('Waiting for payment confirmation...');
      if (!(await maybeAutoCompletePreAccess({ automatic: true }))) {
        schedulePreAccessConfirmationPolling();
      }
      return;
    }

    if (options.socialLoginIntent?.status === 'success') {
      clearSocialLoginUrl();
      state.preAccess.awaitingConfirmation = false;
      state.preAccess.pendingBillingOrderId = null;
      setNotice(`${getSocialProviderLabel(options.socialLoginIntent.provider)} sign-in successful. Access payment is still required before entering the bot.`);
      return;
    }

    state.preAccess.awaitingConfirmation = false;
    state.preAccess.pendingBillingOrderId = null;
    if (!(await maybeAutoCompletePreAccess({ automatic: true }))) {
      setNotice('Access payment required before entering the bot.');
    }
  }

  async function handleAnonymousRestore(error: unknown, socialLoginIntent: SocialIntent | null) {
    await refreshPublicBillingState();
    syncAnonymousRouteStateFromLocation();
    state.ui.loginErrorCount = 0;

    if (socialLoginIntent) {
      clearSocialLoginUrl();
      setError(getSocialLoginFailureMessage(socialLoginIntent));
      return;
    }

    const message = normalizeAuthError(error, 'restore');
    if (message.includes('no longer valid') || message.includes('Unable to restore')) {
      setNotice(AUTH_NOTICE_NO_SESSION);
      setError(null);
      return;
    }

    setError(message);
  }

  async function handleSessionRestoreFailure(
    error: unknown,
    options: {
      billingCheckoutSucceeded: boolean;
      billingCheckoutOrderId: number | null;
      socialLoginIntent: SocialIntent | null;
    },
  ) {
    disconnectSocket();
    stopMonitoringTimers();
    clearSession();

    try {
      await handlePreAccessRestore(options);
    } catch {
      await handleAnonymousRestore(error, options.socialLoginIntent);
    }
  }

  function buildOptimisticManualToken(
    address: string,
    label?: string | null,
    chain: TokenChain = 'solana',
  ) {
    const existingTracked = getTrackedToken(state, address, chain)
      || getMonitoredTokens(state).find((item) => item.address === address && item.chain === chain)
      || getManualTokens(state).find((item) => item.address === address && item.chain === chain);
    const nextManualDraft: ManualTokenEntry = {
      ...(existingTracked || {}),
      chain,
      address,
      label: label ?? existingTracked?.label ?? null,
      manual: true,
      _userManual: true,
    };

    return areTrackedTokensEquivalent(existingTracked, nextManualDraft)
      ? existingTracked as ManualTokenEntry
      : nextManualDraft;
  }

  function isValidTokenAddressFormat(address: string, chain: TokenChain = 'solana') {
    const normalized = String(address || '').trim();
    return chain === 'robinhood' ? EVM_ADDR_RE.test(normalized) : SOLANA_ADDR_RE.test(normalized);
  }

  function captureOptimisticManualTokenSnapshot(address: string, chain: TokenChain = 'solana') {
    const trackedToken = getTrackedToken(state, address, chain);
    const identityKey = getTrackedTokenKey(address, chain);
    return {
      trackedToken: trackedToken ? { ...trackedToken } : null,
      identityKey,
      wasManual: state.data.manualTokenIdentities.includes(identityKey),
      wasMonitored: state.data.monitoredTokenIdentities.includes(identityKey),
    };
  }

  function applyOptimisticManualToken(address: string, nextManual: ManualTokenEntry) {
    const identityKey = getTrackedTokenKey(address, nextManual.chain || 'solana');
    setTrackedToken(nextManual);
    state.data.manualTokenIdentities = state.data.manualTokenIdentities.includes(identityKey)
      ? state.data.manualTokenIdentities
      : [...state.data.manualTokenIdentities, identityKey];
    state.data.monitoredTokenIdentities = state.data.monitoredTokenIdentities.includes(identityKey)
      ? state.data.monitoredTokenIdentities
      : [...state.data.monitoredTokenIdentities, identityKey];

    state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
    state.bars.manual = state.data.manualTokenIdentities.length;
    refreshMonitoredPanelCounts();
    deriveAgeBuckets();
  }

  function revertOptimisticManualToken(
    address: string,
    snapshot: ReturnType<typeof captureOptimisticManualTokenSnapshot>,
  ) {
    const identityKey = snapshot.identityKey;
    if (snapshot.trackedToken) {
      setTrackedToken(snapshot.trackedToken);
    } else {
      const identity = parseTokenIdentityKey(snapshot.identityKey);
      deleteTrackedToken(address, identity.chain);
    }

    state.data.manualTokenIdentities = snapshot.wasManual
      ? state.data.manualTokenIdentities.includes(identityKey)
        ? state.data.manualTokenIdentities
        : [...state.data.manualTokenIdentities, identityKey]
      : state.data.manualTokenIdentities.filter((item) => item !== identityKey);

    state.data.monitoredTokenIdentities = snapshot.wasMonitored
      ? state.data.monitoredTokenIdentities.includes(identityKey)
        ? state.data.monitoredTokenIdentities
        : [...state.data.monitoredTokenIdentities, identityKey]
      : state.data.monitoredTokenIdentities.filter((item) => item !== identityKey);

    state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
    state.bars.manual = state.data.manualTokenIdentities.length;
    refreshMonitoredPanelCounts();
    deriveAgeBuckets();
  }

  function buildDashboardMeteoraBatchItem(dashboardItem: DashboardMonitoredToken): MeteoraBatchItem | null {
    if (!dashboardItem.meteora) {
      return null;
    }

    return {
      address: dashboardItem.address,
      tvl: dashboardItem.meteora.tvl ?? null,
      poolAddress: dashboardItem.meteora.poolAddress ?? null,
      poolCount: dashboardItem.meteora.poolCount ?? 0,
      lastCheckedAt: dashboardItem.meteora.lastCheckedAt ?? null,
      lastSnapshotAt: dashboardItem.meteora.lastSnapshotAt ?? null,
      change1h: dashboardItem.meteora.change1h ?? null,
      change4h: dashboardItem.meteora.change4h ?? null,
      change6h: dashboardItem.meteora.change6h ?? null,
      change24h: dashboardItem.meteora.change24h ?? null,
      volume1h: dashboardItem.meteora.volume1h ?? null,
      volume4h: dashboardItem.meteora.volume4h ?? null,
      volume24h: dashboardItem.meteora.volume24h ?? null,
      noPool: dashboardItem.meteora.noPool ?? false,
    };
  }

  function mergeHydratedManualToken(
    address: string,
    currentTracked: ManualTokenEntry,
    dashboardItem: DashboardMonitoredToken,
  ) {
    const meteoraItem = buildDashboardMeteoraBatchItem(dashboardItem);
    if (meteoraItem) {
      syncMeteoraBatchCache([meteoraItem]);
    }

    const mergedItem = mergeTrackedDashboardFields({
      existingItem: currentTracked,
      dashboardItem,
      base: {
        ...currentTracked,
        address,
        label: currentTracked.label ?? dashboardItem.symbol ?? null,
        manual: true,
        _userManual: true,
      },
      coldRefreshDue: true,
    });
    return selectMergedTrackedToken(currentTracked, mergedItem);
  }

  function applyHydratedManualToken(address: string, nextItem: ManualTokenEntry, currentTracked: ManualTokenEntry) {
    if (nextItem === currentTracked) {
      return;
    }

    replaceTrackedTokenReferences(address, nextItem);
    deriveAgeBuckets();
    state.runtime.monitoredRevision += 1;
    refreshMonitoredPanelCounts();
    emit('monitored', 'manual', 'recent', 'old-week', 'header');
  }

  function buildManualMetadataBatchCacheCandidate(
    manualTokens: Array<{ chain?: TokenChain; address: string; label?: string | null }>,
  ) {
    return manualTokens
      .map((item) => item.address)
      .sort((left, right) => left.localeCompare(right))
      .join(',');
  }

  function shouldReuseManualMetadataBatch(
    cacheKeyCandidate: string,
    manualTokens: Array<{ chain?: TokenChain; address: string; label?: string | null }>,
  ) {
    if (cacheKeyCandidate !== manualMetadataBatchCacheKey || Date.now() >= manualMetadataBatchCacheExpiresAt) {
      return false;
    }

    return !manualTokens.some((item) => hasCriticalColdFieldGap(getTrackedToken(state, item.address)));
  }

  function shouldIncludeMeteoraInManualMetadataBatch(cacheKeyCandidate: string) {
    return cacheKeyCandidate !== manualMetadataMeteoraCacheKey || Date.now() >= manualMetadataNextMeteoraRefreshAt;
  }

  function resetManualMetadataBatchState() {
    manualMetadataBatchCacheKey = '';
    manualMetadataBatchCacheExpiresAt = 0;
    manualMetadataMeteoraCacheKey = '';
    manualMetadataNextMeteoraRefreshAt = 0;
  }

  function updateManualMetadataBatchRefreshState(cacheKeyCandidate: string, includeMeteora: boolean) {
    const now = Date.now();
    manualMetadataBatchCacheKey = cacheKeyCandidate;
    manualMetadataBatchCacheExpiresAt = now + MANUAL_METADATA_BATCH_CACHE_MS;
    if (includeMeteora) {
      manualMetadataMeteoraCacheKey = cacheKeyCandidate;
      manualMetadataNextMeteoraRefreshAt = now + MANUAL_METADATA_METEORA_REFRESH_MS;
    }
  }

  async function hydrateManualTokensMetadataBatch(
    token: string,
    manualTokens: Array<{ chain?: TokenChain; address: string; label?: string | null }>,
    options?: { emitOnComplete?: boolean },
  ) {
    if (state.session.token !== token || !isAuthenticatedSession()) {
      return;
    }

    const normalizedManualTokens = Array.from(new Map(
      (Array.isArray(manualTokens) ? manualTokens : [])
        .filter((item) => resolveAppTokenChain(item?.chain) === 'solana')
        .map((item) => ({
          chain: 'solana' as const,
          address: String(item?.address || '').trim(),
          label: item?.label ?? null,
        }))
        .filter((item) => item.address)
        .map((item) => [item.address, item]),
    ).values());

    if (normalizedManualTokens.length === 0) {
      resetManualMetadataBatchState();
      return;
    }

    const manualMetadataBatchCacheKeyCandidate = buildManualMetadataBatchCacheCandidate(normalizedManualTokens);
    const criticalGapAddresses = normalizedManualTokens
      .filter((item) => hasCriticalColdFieldGap(getTrackedToken(state, item.address)))
      .map((item) => item.address);
    recordSparklineDebug('metadata.request', {
      addresses: summarizeSparklineDebugAddresses(normalizedManualTokens.map((item) => item.address)),
      criticalGaps: summarizeSparklineDebugAddresses(criticalGapAddresses),
      cacheKeyMatches: manualMetadataBatchCacheKeyCandidate === manualMetadataBatchCacheKey,
      cacheExpiresInMs: Math.max(0, manualMetadataBatchCacheExpiresAt - Date.now()),
      inFlight: Boolean(manualMetadataBatchRefreshInFlight),
    });
    if (shouldReuseManualMetadataBatch(manualMetadataBatchCacheKeyCandidate, normalizedManualTokens)) {
      recordSparklineDebug('metadata.cache-hit', {
        addresses: summarizeSparklineDebugAddresses(normalizedManualTokens.map((item) => item.address)),
        cacheExpiresInMs: Math.max(0, manualMetadataBatchCacheExpiresAt - Date.now()),
      });
      return;
    }

    const includeMeteora = shouldIncludeMeteoraInManualMetadataBatch(manualMetadataBatchCacheKeyCandidate);
    const refreshKey = `${manualMetadataBatchCacheKeyCandidate}:${includeMeteora ? 'meteora' : 'base'}`;
    if (manualMetadataBatchRefreshInFlight && manualMetadataBatchRefreshInFlightKey === refreshKey) {
      recordSparklineDebug('metadata.joined-in-flight', {
        addresses: summarizeSparklineDebugAddresses(normalizedManualTokens.map((item) => item.address)),
        includeMeteora,
      });
      await manualMetadataBatchRefreshInFlight;
      if (options?.emitOnComplete !== false && state.session.token === token && isAuthenticatedSession()) {
        emit('monitored', 'manual', 'recent', 'old-week', 'header');
      }
      return;
    }

    const refreshPromise = hydrateManualTokensMetadataBatchInternal(
      token,
      normalizedManualTokens,
      manualMetadataBatchCacheKeyCandidate,
      includeMeteora,
      options,
    );
    manualMetadataBatchRefreshInFlight = refreshPromise;
    manualMetadataBatchRefreshInFlightKey = refreshKey;
    try {
      await refreshPromise;
    } finally {
      if (manualMetadataBatchRefreshInFlight === refreshPromise) {
        manualMetadataBatchRefreshInFlight = null;
        manualMetadataBatchRefreshInFlightKey = '';
      }
    }
  }

  async function hydrateManualTokensMetadataBatchInternal(
    token: string,
    normalizedManualTokens: Array<{ address: string; label?: string | null }>,
    manualMetadataBatchCacheKeyCandidate: string,
    includeMeteora: boolean,
    options?: { emitOnComplete?: boolean },
  ) {
    let changed = false;

    for (let index = 0; index < normalizedManualTokens.length; index += 500) {
      if (state.session.token !== token || !isAuthenticatedSession()) {
        return;
      }

      const chunk = normalizedManualTokens.slice(index, index + 500);
      const chunkAddresses = chunk.map((item) => item.address);
      const startedAt = Date.now();
      recordSparklineDebug('metadata.fetch-start', {
        chunk: Math.floor(index / 500) + 1,
        chunks: Math.ceil(normalizedManualTokens.length / 500),
        includeMeteora,
        addresses: summarizeSparklineDebugAddresses(chunkAddresses),
      });
      let dashboardItems: DashboardMonitoredToken[];
      try {
        dashboardItems = await fetchMonitoredMetadataBatch(
          chunkAddresses,
          token,
          {
            includeMeteora,
            onResponse: (response) => recordSparklineDebug('http.response', {
              endpoint: 'monitored-metadata-batch',
              source: 'manual-metadata-batch',
              durationMs: Date.now() - startedAt,
              includeMeteora,
              addresses: summarizeSparklineDebugAddresses(chunkAddresses),
              response,
            }),
          },
        );
      } catch (error) {
        recordSparklineDebug('metadata.fetch-error', {
          durationMs: Date.now() - startedAt,
          includeMeteora,
          addresses: summarizeSparklineDebugAddresses(chunkAddresses),
          error: formatDebugErrorMessage(error),
        });
        throw error;
      }
      if (state.session.token !== token || !isAuthenticatedSession()) {
        return;
      }

      const dashboardByAddress = new Map(dashboardItems.map((item) => [item.address, item]));
      for (const manualToken of chunk) {
        const currentTracked = getTrackedToken(state, manualToken.address);
        const dashboardItem = dashboardByAddress.get(manualToken.address);
        if (!currentTracked || !dashboardItem) {
          continue;
        }

        const nextItem = mergeHydratedManualToken(manualToken.address, currentTracked, dashboardItem);
        if (nextItem === currentTracked) {
          continue;
        }

        replaceTrackedTokenReferences(manualToken.address, nextItem);
        changed = true;
      }
    }

    updateManualMetadataBatchRefreshState(manualMetadataBatchCacheKeyCandidate, includeMeteora);

    if (!changed) {
      return;
    }

    deriveAgeBuckets();
    state.runtime.monitoredRevision += 1;
    refreshMonitoredPanelCounts();
    if (options?.emitOnComplete !== false) {
      emit('monitored', 'manual', 'recent', 'old-week', 'header');
    }
  }

  async function hydrateManualTokenDashboardAttempt(address: string, token: string) {
    const currentTracked = getTrackedToken(state, address);
    if (!currentTracked || !hasCriticalColdFieldGap(currentTracked)) {
      return true;
    }

    const startedAt = Date.now();
    recordSparklineDebug('metadata.fetch-start', {
      source: 'manual-token-dashboard-attempt',
      includeMeteora: true,
      addresses: summarizeSparklineDebugAddresses([address]),
    });
    const [dashboardItem] = await fetchMonitoredMetadataBatch([address], token, {
      onResponse: (response) => recordSparklineDebug('http.response', {
        endpoint: 'monitored-metadata-batch',
        source: 'manual-token-dashboard-attempt',
        durationMs: Date.now() - startedAt,
        addresses: summarizeSparklineDebugAddresses([address]),
        response,
      }),
    });
    if (state.session.token !== token || !isAuthenticatedSession()) {
      return true;
    }
    if (!dashboardItem) {
      return false;
    }

    const nextItem = mergeHydratedManualToken(address, currentTracked, dashboardItem);
    applyHydratedManualToken(address, nextItem, currentTracked);
    return !hasCriticalColdFieldGap(nextItem);
  }

  async function hydrateManualTokenDashboardFields(
    address: string,
    token: string,
    options?: { retryDelaysMs?: number[] },
  ) {
    const retryDelaysMs = options?.retryDelaysMs || [0];

    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      if (state.session.token !== token || !isAuthenticatedSession()) {
        return;
      }

      try {
        const complete = await hydrateManualTokenDashboardAttempt(address, token);
        if (complete) {
          return;
        }
      } catch {
      }
    }
  }

  async function syncManualTokenToBackend(
    chain: TokenChain,
    address: string,
    label: string | null | undefined,
    token: string,
  ) {
    const result = await addManualTokenRequest(chain, address, label ?? null, token);
    if (result?.token) {
      const currentTracked = getTrackedToken(state, address, chain);
      if (currentTracked) {
        const syncedTracked = {
          ...currentTracked,
          label: result.token.label ?? currentTracked.label ?? null,
        };
        replaceTrackedTokenReferences(address, syncedTracked);
      }
    }

    if (chain === 'robinhood') {
      await reloadConfigPreservingMonitoredSnapshot(token);
      return { followupError: null };
    }

    let trackResult: Awaited<ReturnType<typeof trackManualToken>> | null = null;
    let followupError: unknown = null;
    try {
      trackResult = await trackManualToken(address, token);
      await reloadConfigPreservingMonitoredSnapshot(token);
    } catch (error) {
      followupError = error;
      console.warn('[ManualTokens] Manual token saved, but catalog tracking refresh failed:', error);
    }

    void hydrateManualTokenDashboardFields(address, token, {
      retryDelaysMs: trackResult?.bootstrapState === 'evaluated'
        ? [0]
        : [0, 750, 2000],
    });
    return { followupError };
  }

  async function applyWalletAuthResult(result: Awaited<ReturnType<typeof verifyWalletSignature>>) {
    if (!result.user) {
      throw new Error('This wallet does not currently meet the token access requirement.');
    }

    if (result.requiresPreAccess) {
      applyPreAccessSession(result.user);
      applyAccountAccess(result.access ?? null);
      await refreshPreAccessState();
      navigateToPreAccess(result.redirectPath || '/access');
      state.ui.authPanel = 'none';
      state.ui.loginErrorCount = 0;
      setNotice(result.message || 'Token discount found. Choose a plan to continue.');
      return;
    }

    if (!result.access?.hasProductAccess) {
      throw new Error('This wallet does not currently meet the token access requirement.');
    }

    const session = await fetchCurrentSession();
    applySession(session.user, { deferWorkspaceSync: true });
    applyAccountAccess(result.access);
    await refreshBillingState(COOKIE_SESSION_MARKER);
    await refreshIdentityState(COOKIE_SESSION_MARKER);
    await reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true });
    state.ui.authPanel = 'none';
    state.ui.loginErrorCount = 0;
    syncWorkspaceFromLocationInternal({ canonicalize: true });
    setNotice(result.mode === 'created_wallet_user'
      ? 'Wallet account created. Workspace synced.'
      : 'Wallet login successful. Workspace synced.');
  }

  function closeWalletSelectorInternal() {
    const mode = state.ui.walletSelectorMode;
    state.ui.walletSelectorMode = null;
    state.ui.walletOptions = [];
    state.ui.authPanel = mode === 'link' && state.session.status === 'authenticated'
      ? 'user-settings'
      : 'none';
    if (state.ui.authPanel === 'user-settings') {
      replaceAuthPanelRoute('user-settings');
    } else if (state.session.status === 'anonymous') {
      clearLoginPanelUrl();
    } else if (state.session.status === 'authenticated') {
      clearAccountPanelUrl();
    }
  }

  async function openWalletSelector(mode: 'login' | 'link') {
    if (authSubmitInFlight) {
      return;
    }
    authSubmitInFlight = true;
    setBusy(true);
    setError(null);
    setNotice('Finding compatible Solana wallets...');
    emit(mode === 'login' ? 'legacy' : 'overlay');
    try {
      const wallets = await listSolanaWallets();
      if (wallets.length === 0) {
        throw new Error('No compatible Solana wallet was detected. Install Phantom, Solflare, Backpack, or another Wallet Standard Solana wallet.');
      }
      state.ui.walletSelectorMode = mode;
      state.ui.walletOptions = wallets;
      state.ui.walletNetworkLabel = getSolanaNetworkLabel();
      state.ui.authPanel = 'wallet-select';
      navigateToAuthPanelRoute('wallet-select');
      setNotice(null);
    } catch (error) {
      setError(normalizeWalletLoginError(error));
    } finally {
      authSubmitInFlight = false;
      setBusy(false);
      emit(mode === 'login' ? 'legacy' : 'overlay');
    }
  }

  async function linkSelectedWallet(walletId: string) {
    const connectedWallet = await connectSolanaWallet(walletId);
    const challenge = await requestWalletLinkChallenge(connectedWallet.address, COOKIE_SESSION_MARKER);
    setNotice(`Sign the message in ${connectedWallet.provider} to link this account.`);
    emit('overlay');
    const signature = await connectedWallet.signMessage(new TextEncoder().encode(challenge.message));
    const result = await verifyWalletLinkSignature({
      walletAddress: connectedWallet.address,
      message: challenge.message,
      signature: encodeBase58(signature),
      walletProvider: connectedWallet.provider,
    }, COOKIE_SESSION_MARKER);

    applyAccountAccess(result.access ?? null);
    await refreshBillingState(COOKIE_SESSION_MARKER);
    setNotice(result.message || 'Wallet connected. Token balance refreshed.');
  }

  async function loginWithSelectedWallet(walletId: string) {
    const connectedWallet = await connectSolanaWallet(walletId);
    setNotice('Requesting wallet challenge...');
    emit('legacy');
    const challenge = await requestWalletChallenge(connectedWallet.address);
    setNotice(`Sign the message in ${connectedWallet.provider} to continue.`);
    emit('legacy');
    const signature = await connectedWallet.signMessage(new TextEncoder().encode(challenge.message));
    const result = await verifyWalletSignature({
      walletAddress: connectedWallet.address,
      message: challenge.message,
      signature: encodeBase58(signature),
      walletProvider: connectedWallet.provider,
    });
    await applyWalletAuthResult(result);
  }

  installAlertDebugConsole();
  installSparklineDebugConsole();

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state, new Set<AppRenderRegion>(['all']));
      return () => listeners.delete(listener);
    },
    clearNotice() {
      state.ui.notice = null;
      state.ui.error = null;
      emit('legacy', 'overlay');
    },
    clearError() {
      if (!state.ui.error) {
        return;
      }
      state.ui.error = null;
      state.ui.loginErrorCount = 0;
      emit('legacy', 'overlay');
    },
    async refreshBidZoneSnapshot() {
      if (!shouldRunHistoryAnalyticsRuntime() || state.runtime.bidZoneRefreshInFlight || bidZoneRefreshInFlight) {
        return;
      }

      const token = state.session.token;
      if (!token) {
        return;
      }

      const availableAt = state.runtime.bidZoneRefreshAvailableAt ? new Date(state.runtime.bidZoneRefreshAvailableAt).getTime() : 0;
      if (Number.isFinite(availableAt) && availableAt > Date.now()) {
        return;
      }

      const requestedAt = Date.now();
      state.runtime.bidZoneRefreshInFlight = true;
      emit('bid-zone');

      try {
        const payload = await refreshBidZoneSnapshotRequest(token, { limit: BID_ZONE_PANEL_LIMIT });
        applyBidZonePayload(payload);
        if (payload.refreshed === true) {
          nextBidZoneRefreshAt = requestedAt + BID_ZONE_REFRESH_INTERVAL_MS;
        } else if (payload.retryAfterSeconds) {
          setNotice(`Bid Zone refresh cooling down. Try again in about ${payload.retryAfterSeconds}s.`);
        }
        if (isHistoryWorkspace() && isHistorySyncLeader()) {
          broadcastHistoryBidZoneSnapshot(payload);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to refresh bid-zone snapshot';
        setError(message);
        emit('legacy', 'overlay');
      } finally {
        state.runtime.bidZoneRefreshInFlight = false;
        emit('bid-zone');
      }
    },
    openAuthPanel(panel: Exclude<AuthPanel, 'none'>) {
      state.ui.pendingIdentityUnlinkProvider = null;
      if (panel === 'change-password') {
        monitoringPausedForAuthPanel = false;
        state.ui.error = null;
        state.ui.notice = null;
      }
      if (panel === 'bot-settings') {
        hydrateBrowserNotificationSettings();
      }
      if (panel === 'token-review-alerts') {
        void loadAdminTokenReviewAlertsInternal()
          .then(() => emit('overlay', 'header', 'alerts'))
          .catch(() => emit('overlay', 'header', 'alerts'));
      }
      state.ui.authPanel = panel;
      navigateToAuthPanelRoute(panel);
      emit('all');
      if (panel === 'user-settings' && state.session.status === 'authenticated') {
        void refreshUserSettingsState(COOKIE_SESSION_MARKER)
          .then(() => emit('overlay', 'header'))
          .catch(() => emit('overlay', 'header'));
      }
    },
    closeAuthPanel() {
      if (state.ui.authPanel === 'none') {
        return;
      }
      const shouldResumeMonitoring = state.ui.authPanel === 'change-password'
        && monitoringPausedForAuthPanel
        && state.session.status === 'authenticated';
      state.ui.authPanel = 'none';
      state.ui.pendingIdentityUnlinkProvider = null;
      state.ui.pendingVerificationEmail = null;
      state.ui.pendingPasswordResetToken = null;
      state.ui.pendingLoginOtpChallengeToken = null;
      state.ui.pendingLoginOtpEmailHint = null;
      if (state.session.status === 'anonymous') {
        clearLoginPanelUrl();
      } else if (state.session.status === 'authenticated') {
        clearAccountPanelUrl();
      }
      monitoringPausedForAuthPanel = false;
      if (shouldResumeMonitoring) {
        startMonitoringTimers();
      }
      emit('all');
    },
    closeWalletSelector() {
      if (state.ui.authPanel !== 'wallet-select') {
        return;
      }
      closeWalletSelectorInternal();
      emit('all');
    },
    goToLogin(panel?: 'register') {
      navigateToLogin(panel);
      if (state.session.status === 'anonymous') {
        syncAnonymousRouteStateFromLocation();
      }
      emit('all');
    },
    goToPublicLanding() {
      navigateToPublicLanding();
      if (state.session.status === 'anonymous' && !state.billing.loaded) {
        void refreshPublicBillingState().then(() => emit('all')).catch(() => emit('all'));
      }
      emit('all');
    },
    goToAccountSecurity() {
      navigateToAccountSecurity();
      if (state.session.status === 'authenticated' || state.session.status === 'pre_access') {
        void refreshAccountSecurityState().then(() => emit('all')).catch(() => emit('all'));
      } else {
        syncAnonymousRouteStateFromLocation();
        emit('all');
      }
    },
    goToPreAccess() {
      navigateToPreAccess();
      if (state.session.status === 'pre_access') {
        void refreshPreAccessState().then(() => emit('all')).catch(() => emit('all'));
        return;
      }
      emit('all');
    },
    async refreshBilling() {
      if (state.session.status === 'authenticated') {
        await refreshUserSettingsState(COOKIE_SESSION_MARKER);
        emit('overlay', 'header');
        return;
      }

      if (state.session.status === 'pre_access') {
        await refreshPreAccessState();
        if (await maybeAutoCompletePreAccess({ automatic: true })) {
          return;
        }
        emit('legacy');
      }
    },
    startSocialLink(provider: 'google' | 'discord') {
      if (typeof window === 'undefined') {
        return;
      }

      const normalizedProvider = provider === 'discord' ? 'discord' : 'google';
      const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}`;
      const url = new URL(`/api/auth/social/${normalizedProvider}/start`, resolveApiBase(window.location));
      url.searchParams.set('returnTo', currentPath || '/alerts');
      const popup = window.open(url.toString(), SOCIAL_LINK_POPUP_WINDOW_NAME, 'popup=yes,width=760,height=860');
      if (!popup) {
        stopSocialLinkSync();
        socialLinkPopupWindow = null;
        window.location.assign(url.toString());
        return;
      }
      socialLinkPopupWindow = popup;
      startSocialLinkSync(normalizedProvider);
      try {
        popup.focus();
      } catch {
        // Ignore popup focus failures.
      }
    },
    openIdentityUnlink(provider: 'google' | 'discord') {
      const normalizedProvider = provider === 'discord' ? 'discord' : 'google';
      state.ui.pendingIdentityUnlinkProvider = normalizedProvider;
      state.ui.error = null;
      state.ui.notice = null;
      emit('all');
    },
    cancelIdentityUnlink() {
      if (!state.ui.pendingIdentityUnlinkProvider) {
        return;
      }
      state.ui.pendingIdentityUnlinkProvider = null;
      state.ui.error = null;
      state.ui.notice = null;
      emit('all');
    },
    async unlinkSocialIdentity(provider: 'google' | 'discord', currentPassword: string) {
      if (authSubmitInFlight) {
        return;
      }

      const normalizedProvider = provider === 'discord' ? 'discord' : 'google';
      const password = String(currentPassword || '');
      if (!password) {
        setError('Current password is required to unlink a social login.');
        emit('all');
        return;
      }

      if (state.session.status !== 'authenticated' && state.session.status !== 'pre_access') {
        setError('Account security authentication required');
        emit('all');
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice(`Removing ${normalizedProvider === 'google' ? 'Google' : 'Discord'} sign-in from this account...`);
      emit('all');

      try {
        const token = state.session.status === 'authenticated' ? COOKIE_SESSION_MARKER : null;
        const snapshot = await unlinkAccountSecurityIdentity(normalizedProvider, password, token);
        applyIdentityStateSnapshot(snapshot);
        state.ui.pendingIdentityUnlinkProvider = null;
        setNotice(snapshot.message || `${normalizedProvider === 'google' ? 'Google' : 'Discord'} sign-in removed.`);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Unable to unlink social identity');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit('all');
      }
    },
    async updateAccountProfile(username: string, email: string, password: string, confirmPassword: string) {
      if (authSubmitInFlight) {
        return;
      }
      if (state.session.status !== 'authenticated') {
        setError('Authenticated bot session required to update account details.');
        emit('overlay');
        return;
      }

      const validated = validateAccountProfileInput({
        username,
        email,
        password,
        confirmPassword,
        isWalletOnlyAccount: isWalletOnlySessionEmail(state.session.email),
      });
      if (!validated.ok) {
        setError(validated.message);
        emit('overlay');
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice(validated.input.email ? 'Saving account details...' : 'Updating profile...');
      emit('overlay');

      try {
        const result = await updateAccountProfileRequest(validated.input, COOKIE_SESSION_MARKER);

        state.session.username = result.user.username;
        state.session.email = result.user.email;
        state.session.role = result.user.role;
        state.session.isEmailVerified = Boolean(result.user.isEmailVerified);
        state.session.emailVerifiedAt = result.user.emailVerifiedAt ?? null;
        if (result.emailVerificationRequired) {
          state.ui.pendingVerificationEmail = trimLoginEmailValue(result.user.email);
          state.ui.authPanel = 'email-verification';
          replaceAuthPanelRoute('email-verification');
        }
        setNotice(appendEmailDebugNotice(result.message || 'Profile updated.', result.emailDebug));
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Unable to update account details');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit('overlay', 'header');
      }
    },
    startSocialLogin(provider: 'google' | 'discord') {
      if (typeof window === 'undefined') {
        return;
      }

      const normalizedProvider = provider === 'discord' ? 'discord' : 'google';
      const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}`;
      const url = new URL(`/api/auth/social/${normalizedProvider}/login/start`, resolveApiBase(window.location));
      url.searchParams.set('returnTo', currentPath || '/alerts');
      window.location.assign(url.toString());
    },
    async connectWallet(walletId?: string) {
      if (authSubmitInFlight) {
        return;
      }
      if (state.session.status !== 'authenticated') {
        setError('Authenticated bot session required to connect a wallet.');
        emit('overlay');
        return;
      }
      if (!walletId) {
        await openWalletSelector('link');
        return;
      }

      closeWalletSelectorInternal();
      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Connecting wallet...');
      emit('overlay');

      try {
        await linkSelectedWallet(walletId);
      } catch (error) {
        setError(normalizeWalletLoginError(error));
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit('overlay', 'header', 'legacy');
      }
    },
    async startBillingCheckout(planKey: string) {
      if (state.session.status !== 'authenticated') {
        throw new Error('Authentication required');
      }

      const normalizedPlanKey = String(planKey || '').trim();
      if (!normalizedPlanKey) {
        throw new Error('Billing plan is required');
      }

      state.billing.pendingPlanKey = normalizedPlanKey;
      state.billing.error = null;
      emit('overlay');

      try {
        const result = await createBillingOrder(normalizedPlanKey, COOKIE_SESSION_MARKER);
        if (!result.checkoutUrl) {
          throw new Error('MoonPay Commerce checkout URL was not returned');
        }
        await refreshBillingState(COOKIE_SESSION_MARKER);
        if (typeof window !== 'undefined') {
          window.open(result.checkoutUrl, '_blank', 'noopener');
        }
        setNotice(
          state.billing.providerMocked
            ? 'Local billing checkout opened in a new tab. Complete the simulated payment there.'
            : 'MoonPay Commerce checkout opened in a new tab.'
        );
      } catch (error) {
        state.billing.error = error instanceof Error ? error.message : 'Unable to start checkout';
        throw error;
      } finally {
        state.billing.pendingPlanKey = null;
        emit('overlay');
      }
    },
    async startPreAccessCheckout(planKey: string) {
      if (state.session.status !== 'pre_access') {
        throw new Error('Pre-access authentication required');
      }

      const normalizedPlanKey = String(planKey || '').trim();
      if (!normalizedPlanKey) {
        throw new Error('Billing plan is required');
      }

      state.billing.pendingPlanKey = normalizedPlanKey;
      state.billing.error = null;
      emit('legacy');

      try {
        const result = await createPreAccessOrder(normalizedPlanKey);
        if (!result.checkoutUrl) {
          throw new Error('MoonPay checkout URL was not returned');
        }
        await refreshPreAccessState();
        if (typeof window !== 'undefined') {
          window.open(result.checkoutUrl, '_blank', 'noopener');
        }
      } catch (error) {
        state.billing.error = error instanceof Error ? error.message : 'Unable to start checkout';
        throw error;
      } finally {
        state.billing.pendingPlanKey = null;
        emit('legacy');
      }
    },
    async completePreAccess() {
      await completePreAccessFlow();
    },
    removePumpToken(mint: string) {
      if (!state.data.dismissedPump.includes(mint)) {
        state.data.dismissedPump = [...state.data.dismissedPump, mint];
      }
      state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== mint);
      unsubscribePumpMint(mint);
      refreshPumpPanelCounts();
      setNotice('PumpFun token removed from the live panel for this session.');
      emit('pumpfun', 'legacy', 'overlay');
    },
    dismissRecentToken(address: string, chain: TokenChain = 'solana') {
      const identityKey = getTrackedTokenKey(address, chain);
      if (!state.data.dismissedRecentIdentities.includes(identityKey)) {
        clearHistoryBucketOrderLock('recent', { applyPending: false });
        state.data.dismissedRecentIdentities = [...state.data.dismissedRecentIdentities, identityKey];
        state.data.recentTokenIdentities = state.data.recentTokenIdentities.filter((item) => item !== identityKey);
        state.bars.recent = Math.max(0, state.bars.recent - 1);
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Recent token dismissed.');
        emit('recent', 'legacy', 'overlay');
        if (usesHistoryBucketBootstrap()) {
          void refreshHistoryWorkspaceBootstrap();
        }
      }
    },
    dismissOldWeekToken(address: string, chain: TokenChain = 'solana') {
      const identityKey = getTrackedTokenKey(address, chain);
      if (!state.data.dismissedOldWeekIdentities.includes(identityKey)) {
        clearHistoryBucketOrderLock('old-week', { applyPending: false });
        state.data.dismissedOldWeekIdentities = [...state.data.dismissedOldWeekIdentities, identityKey];
        state.data.oldWeekTokenIdentities = state.data.oldWeekTokenIdentities.filter((item) => item !== identityKey);
        state.bars.oldWeek = Math.max(0, state.bars.oldWeek - 1);
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Old Week token dismissed.');
        emit('old-week', 'legacy', 'overlay');
        if (usesHistoryBucketBootstrap()) {
          void refreshHistoryWorkspaceBootstrap();
        }
      }
    },
    async clearAllAlerts() {
      const token = state.session.token;
      const shouldClearBackend = Boolean(token && isAuthenticatedSession());
      const { chains, clearedAlerts, remainingAlerts } = partitionVisibleAlertEntries(
        state.data.alerts,
        state.ui.chainFilters,
      );
      if (chains.length === 0) {
        return;
      }
      const beforeAlerts = state.data.alerts.slice();
      state.data.alerts = remainingAlerts;
      if (clearedAlerts.length === 0 && !shouldClearBackend) {
        return;
      }
      syncAlertState();
      flushAlertsPersist();
      recordAlertMutationDebug('user.clear-visible', beforeAlerts, { chains });
      setNotice('Alerts from the selected networks cleared.');
      emit('alerts', 'legacy', 'overlay');
      flushEmit();
      if (!token || !isAuthenticatedSession()) {
        return;
      }

      try {
        recordAlertDebug('backend.clear-all.start', {
          chains,
          localCleared: summarizeAlertDebug(clearedAlerts),
        });
        const payload = await clearDashboardAlertEvents(token, { chains });
        recordAlertDebug('backend.clear-all.complete', {
          cursorCount: Number(payload.count) || 0,
        });
      } catch (error) {
        recordAlertDebug('backend.clear-all.error', {
          error: formatDebugErrorMessage(error),
        });
        setError('Alerts were cleared locally, but the backend clear failed. Refreshing may reload older alerts.');
        emit('overlay');
        flushEmit();
      }
    },
    async removeAlert(id: string) {
      const removedAlert = state.data.alerts.find((item) => item.id === id);
      const nextAlerts = state.data.alerts.filter((item) => item.id !== id);
      if (nextAlerts.length === state.data.alerts.length) {
        return;
      }
      const beforeAlerts = state.data.alerts.slice();
      state.data.alerts = nextAlerts;
      syncAlertState();
      recordAlertMutationDebug('user.remove-one', beforeAlerts, { id });
      emit('alerts');
      flushEmit();
      const token = state.session.token;
      const backendEventId = removedAlert ? getBackendAlertEventId(removedAlert) : null;
      if (!removedAlert || !backendEventId || !removedAlert.ruleKey || !token || !isAuthenticatedSession()) {
        return;
      }
      try {
        await dismissDashboardAlertEvent({
          ruleKey: removedAlert.ruleKey,
          chain: removedAlert.chain,
          eventId: backendEventId,
        }, token);
        recordAlertDebug('backend.dismiss-one.complete', {
          ruleKey: removedAlert.ruleKey,
          chain: removedAlert.chain,
          eventId: backendEventId,
        });
      } catch (error) {
        recordAlertDebug('backend.dismiss-one.error', {
          ruleKey: removedAlert.ruleKey,
          chain: removedAlert.chain,
          eventId: backendEventId,
          error: formatDebugErrorMessage(error),
        });
        setError('The alert was hidden locally, but could not be dismissed. Refreshing alert history.');
        emit('overlay');
        flushEmit();
        void refreshAuthoritativeBackendAlertHistory('dismiss-failed');
      }
    },
    previewCustomAlert(input: CustomAlertPreviewInput) {
      const address = String(input.tokenAddress || '').trim();
      if (!address) {
        setNotice('Pick a token before testing a custom alert.');
        emit('overlay');
        return;
      }

      const now = Date.now();
      const entry = buildCustomAlertPreviewEntry(input, address, now);
      if (pushAlert(entry)) {
        setNotice('Custom alert preview added to Alerts.');
      }
      emit('overlay');
      flushEmit();
    },
    async createCustomAlert(input: CustomAlertPreviewInput) {
      try {
        await createCustomAlertRule(input);
        setNotice('Custom alert saved.');
        emit('overlay');
        flushEmit();
        void refreshCustomAlertRules().catch(() => {});
      } catch (error) {
        state.ui.error = error instanceof Error ? error.message : 'Failed to save custom alert.';
        emit('overlay');
        throw error;
      }
    },
    async loadCustomAlertRules() {
      try {
        await refreshCustomAlertRules();
      } catch {
        // list stays as-is; the modal shows the last known rules
      }
    },
    async updateCustomAlert(ruleId: number, input: CustomAlertPreviewInput) {
      try {
        const token = requireCustomAlertSessionToken();
        const existing = state.data.customAlertRules.find((rule) => rule.id === ruleId);
        if (!existing) throw new Error('Custom alert rule not found.');
        await updateCustomAlertRuleRequest(ruleId, buildCustomAlertRulePayload(input, {
          chain: existing.chain,
          tokenAddress: existing.tokenAddress,
        }), token);
        setNotice('Custom alert updated.');
        emit('overlay');
        flushEmit();
        void refreshCustomAlertRules().catch(() => {});
      } catch (error) {
        state.ui.error = error instanceof Error ? error.message : 'Failed to update custom alert.';
        emit('overlay');
        throw error;
      }
    },
    async disableCustomAlert(ruleId: number) {
      const previousRules = state.data.customAlertRules;
      const existing = previousRules.find((rule) => rule.id === ruleId);
      if (!existing) throw new Error('Custom alert rule not found.');
      state.data.customAlertRules = previousRules.filter((rule) => rule.id !== ruleId);
      emit('alerts');
      flushEmit();
      try {
        const token = requireCustomAlertSessionToken();
        await disableCustomAlertRuleRequest(ruleId, existing.chain, token);
        setNotice('Custom alert canceled.');
        emit('overlay');
        flushEmit();
      } catch (error) {
        state.data.customAlertRules = previousRules;
        state.ui.error = error instanceof Error ? error.message : 'Failed to cancel custom alert.';
        emit('alerts');
        emit('overlay');
        flushEmit();
        throw error;
      }
    },
    openExpandedSparkline(address: string, chain: TokenChain = 'solana') {
      const identity = createLegacyCompatibleTokenIdentity(chain, address);
      if (state.data.chainReadiness[identity.chain]?.capabilities.charts !== true) return;

      restorePreferredExpandedSparklineGranularityForAddress(identity.address, identity.chain);

      const activeIdentity = getActiveExpandedSparklineIdentity();
      if (activeIdentity && activeIdentity.key !== identity.key) {
        unsubscribeMarketChart(activeIdentity.address, activeIdentity.chain);
      }
      state.ui.expandedSparklineChain = identity.chain;
      state.ui.expandedSparklineAddress = identity.address;
      subscribeMarketChart(identity.address, identity.chain);
      state.ui.mockTradingPnlAddress = null;
      if (typeof window !== 'undefined') {
        const nextPath = getWorkspaceSparklinePath(
          state.ui.workspace,
          identity.address,
          identity.chain,
        );
        if (window.location.pathname !== nextPath) {
          window.history.pushState({}, document.title, nextPath);
        }
      }
      emit('overlay');
      if (identity.chain === 'solana') void refreshCustomAlertRules().catch(() => {});
      if (isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(
        identity.address,
        undefined,
        identity.chain,
      ))) {
        return;
      }
      setExpandedSparklineLoading(identity.address, null, undefined, identity.chain);
      emit('overlay');
      void refreshExpandedSparkline(identity.address, undefined, undefined, undefined, identity.chain);
    },
    openAlertExpandedSparkline(alertId: string, address: string) {
      const normalized = String(address || '').trim();
      if (!normalized) {
        return;
      }
      const sourceAlert = state.data.alerts.find((item) => item.id === alertId);
      if (sourceAlert && (sourceAlert.chain || 'solana') !== 'solana') {
        return;
      }

      restorePreferredExpandedSparklineGranularityForAddress(normalized);
      void refreshCustomAlertRules().catch(() => {});
      const seed = seedExpandedSparklineFromAlert(alertId, normalized);

      if (state.ui.expandedSparklineAddress && (
        state.ui.expandedSparklineAddress !== normalized
        || state.ui.expandedSparklineChain !== 'solana'
      )) {
        unsubscribeMarketChart(state.ui.expandedSparklineAddress, state.ui.expandedSparklineChain);
      }
      state.ui.expandedSparklineChain = 'solana';
      state.ui.expandedSparklineAddress = normalized;
      subscribeMarketChart(normalized, 'solana');
      state.ui.mockTradingPnlAddress = null;
      if (typeof window !== 'undefined') {
        const nextPath = getWorkspaceSparklinePath(state.ui.workspace, normalized);
        if (window.location.pathname !== nextPath) {
          window.history.pushState({}, document.title, nextPath);
        }
      }
      emit('overlay');
      if (isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(normalized))) {
        return;
      }
      setExpandedSparklineLoading(normalized, seed);
      emit('overlay');
      void refreshExpandedSparkline(normalized);
    },
    closeExpandedSparkline() {
      if (!state.ui.expandedSparklineAddress) {
        return;
      }
      unsubscribeMarketChart(
        state.ui.expandedSparklineAddress,
        state.ui.expandedSparklineChain,
      );
      state.ui.expandedSparklineAddress = null;
      state.ui.expandedSparklineChain = 'solana';
      clearWorkspaceSparklineUrl();
      if (deferredExpandedSparklineRenderRegions.size > 0) {
        const deferredRegions = [...deferredExpandedSparklineRenderRegions];
        deferredExpandedSparklineRenderRegions.clear();
        emit('overlay', ...deferredRegions);
        return;
      }
      emit('overlay');
    },
    setExpandedSparklineGranularity(granularityMinutes: number) {
      const safeGranularity = normalizeExpandedSparklineGranularity(granularityMinutes);
      if (state.ui.expandedSparklineGranularityMinutes === safeGranularity) {
        if (preferredExpandedSparklineGranularityMinutes !== safeGranularity) {
          preferredExpandedSparklineGranularityMinutes = safeGranularity;
          queueUiPrefsPersist();
        }
        return;
      }

      const address = String(state.ui.expandedSparklineAddress || '').trim();
      const chain = state.ui.expandedSparklineChain;
      if (address && !isExpandedSparklineGranularityAvailable(address, safeGranularity, chain)) {
        emit('overlay');
        return;
      }

      state.ui.expandedSparklineGranularityMinutes = safeGranularity;
      preferredExpandedSparklineGranularityMinutes = safeGranularity;
      queueUiPrefsPersist();
      if (!address) {
        emit('overlay');
        return;
      }

      if (isExpandedSparklineCacheFresh(getExpandedSparklineCacheEntry(address, safeGranularity, chain))) {
        emit('overlay');
        return;
      }

      setExpandedSparklineLoading(address, null, safeGranularity, chain);
      emit('overlay');
      void refreshExpandedSparkline(address, undefined, safeGranularity, undefined, chain);
    },
    setExpandedSparklineTimeZone(timeZone: string) {
      const safeTimeZone = normalizeExpandedChartTimeZone(timeZone);
      if (state.ui.expandedSparklineTimeZone === safeTimeZone) {
        return;
      }
      state.ui.expandedSparklineTimeZone = safeTimeZone;
      queueUiPrefsPersist();
      emit('overlay');
    },
    clearDismissedRecent() {
      state.data.dismissedRecentIdentities = [];
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      } else {
        deriveAgeBuckets();
      }
      persistBarStorage();
      setNotice('Recent dismissed set cleared.');
      emit('recent', 'legacy', 'overlay');
    },
    clearDismissedOldWeek() {
      state.data.dismissedOldWeekIdentities = [];
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      } else {
        deriveAgeBuckets();
      }
      persistBarStorage();
      setNotice('Old Week dismissed set cleared.');
      emit('old-week', 'legacy', 'overlay');
    },
    toggleSectionCollapsed(section: CollapsibleSectionKey) {
      state.ui.collapsed[section] = !state.ui.collapsed[section];
      if (section === 'recent') {
        deriveAgeBuckets({ forceRecentList: !state.ui.collapsed.recent });
      } else if (section === 'oldWeek') {
        deriveAgeBuckets({ forceOldWeekList: !state.ui.collapsed.oldWeek });
      }
      queueUiPrefsPersist();
      emit(COLLAPSIBLE_SECTION_TO_RENDER_REGION[section]);
    },
    setAlertSearchQuery(query: string) {
      state.ui.alertSearchQuery = String(query || '');
      state.ui.alertPage = 0;
      emit('alerts');
    },
    setMonitoredSearchQuery(query: string) {
      state.ui.monitoredSearchQuery = String(query || '');
      state.ui.monitoredPage = 0;
      emit('monitored');
      refreshMonitoredSparklinesIfExpanded('monitored-search');
    },
    setManualSearchQuery(query: string) {
      state.ui.manualSearchQuery = String(query || '');
      emit('manual');
      if (state.session.token && isLiveWorkspace()) {
        void refreshHistoryWorkspaceSparklines({ token: state.session.token, force: true, caller: 'manual-search' });
      }
    },
    setRecentSearchQuery(query: string) {
      clearHistoryBucketOrderLock('recent', { applyPending: false });
      state.ui.recentSearchQuery = String(query || '');
      state.ui.recentSearchPending = usesHistoryBucketBootstrap() && Boolean(String(query || '').trim());
      state.ui.recentPage = 0;
      emit('recent');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setOldWeekSearchQuery(query: string) {
      clearHistoryBucketOrderLock('old-week', { applyPending: false });
      state.ui.oldWeekSearchQuery = String(query || '');
      state.ui.oldWeekSearchPending = usesHistoryBucketBootstrap() && Boolean(String(query || '').trim());
      state.ui.oldWeekPage = 0;
      emit('old-week');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setManualStarredOnly(enabled: boolean) {
      state.ui.manualStarredOnly = Boolean(enabled);
      queueUiPrefsPersist();
      emit('manual');
      if (state.session.token && isLiveWorkspace()) {
        void refreshHistoryWorkspaceSparklines({ token: state.session.token, force: true, caller: 'manual-starred' });
      }
    },
    setManualFolderDeleteWarningDismissed(enabled: boolean) {
      state.ui.manualFolderDeleteWarningDismissed = Boolean(enabled);
      queueUiPrefsPersist();
      emit('manual');
    },
    setRecentStarredOnly(enabled: boolean) {
      clearHistoryBucketOrderLock('recent', { applyPending: false });
      state.ui.recentStarredOnly = Boolean(enabled);
      state.ui.recentPage = 0;
      queueUiPrefsPersist();
      emit('recent');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setOldWeekStarredOnly(enabled: boolean) {
      clearHistoryBucketOrderLock('old-week', { applyPending: false });
      state.ui.oldWeekStarredOnly = Boolean(enabled);
      state.ui.oldWeekPage = 0;
      queueUiPrefsPersist();
      emit('old-week');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    toggleEnabledChain(chain: TokenChain) {
      const next = toggleEnabledTokenChain(
        state.ui.chainFilters,
        state.data.availableChains,
        chain,
      );
      if (
        next.enabledChains.length === state.ui.chainFilters.enabledChains.length
        && next.enabledChains.every((item, index) => item === state.ui.chainFilters.enabledChains[index])
      ) {
        return;
      }
      state.ui.chainFilters = next;
      monitoredBootstrapHydrationRevision += 1;
      nextMonitoredFullHydrationAt = 0;
      topPerformersRefreshRevision += 1;
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
      } else {
        void refreshMockTradingState();
      }
      state.ui.alertPage = 0;
      state.ui.monitoredPage = 0;
      state.ui.recentPage = 0;
      state.ui.oldWeekPage = 0;
      clearHistoryBucketOrderLocks({ applyPending: false });
      queueUiPrefsPersist();
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      } else {
        void refreshMonitoredDashboard();
      }
      void refreshDashboardTopPerformers();
      emit('header', 'top-performers', 'manual', 'monitored', 'alerts', 'recent', 'old-week');
    },
    toggleSurfaceChain(
      surface: 'radarChains' | 'alertFeedChains' | 'browserNotificationChains',
      chain: TokenChain,
    ) {
      const currentSelection = state.ui.chainFilters[surface];
      const next = toggleTokenChainForSurface(
        state.ui.chainFilters,
        state.data.availableChains,
        surface,
        chain,
      );
      const nextSelection = next[surface];
      if (
        nextSelection.length === currentSelection.length
        && nextSelection.every((item, index) => item === currentSelection[index])
      ) {
        return;
      }
      state.ui.chainFilters = next;
      if (surface === 'radarChains') {
        state.ui.recentPage = 0;
        state.ui.oldWeekPage = 0;
        clearHistoryBucketOrderLocks({ applyPending: false });
        if (usesHistoryBucketBootstrap()) {
          void refreshHistoryWorkspaceBootstrap();
        }
      } else if (surface === 'alertFeedChains') {
        state.ui.alertPage = 0;
      }
      queueUiPrefsPersist();
      if (surface === 'radarChains') {
        emit('header', 'recent', 'old-week');
      } else {
        emit('alerts');
      }
    },
    setMonitoredPage(page: number) {
      state.ui.monitoredPage = clampPage(page, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
      emit('monitored');
      refreshMonitoredSparklinesIfExpanded('monitored-page');
    },
    setAlertPage(page: number) {
      state.ui.alertPage = clampPage(page, getFilteredAlertsForPagination().length, ALERTS_PER_PAGE);
      emit('alerts');
    },
    setRecentPage(page: number) {
      clearHistoryBucketOrderLock('recent', { applyPending: false });
      const normalizedPage = Math.max(0, Math.floor(page) || 0);
      state.ui.recentPage = usesHistoryBucketBootstrap()
        ? normalizedPage
        : clampPage(normalizedPage, getRecentTokenTotalForPagination(), state.ui.recentPerPage);
      emit('recent');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setOldWeekPage(page: number) {
      clearHistoryBucketOrderLock('old-week', { applyPending: false });
      const normalizedPage = Math.max(0, Math.floor(page) || 0);
      state.ui.oldWeekPage = usesHistoryBucketBootstrap()
        ? normalizedPage
        : clampPage(normalizedPage, getOldWeekTokenTotalForPagination(), state.ui.oldWeekPerPage);
      emit('old-week');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setMonitoredPerPage(perPage: number) {
      state.ui.monitoredPerPage = normalizeUiPerPage(perPage, 30);
      state.ui.monitoredPage = clampPage(state.ui.monitoredPage, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
      queueUiPrefsPersist();
      emit('monitored');
      refreshMonitoredSparklinesIfExpanded('monitored-per-page');
    },
    setRecentPerPage(perPage: number) {
      clearHistoryBucketOrderLock('recent', { applyPending: false });
      state.ui.recentPerPage = normalizeUiPerPage(perPage, ROUTED_BUCKET_DEFAULT_PER_PAGE);
      state.ui.recentPage = clampPage(state.ui.recentPage, getRecentTokenTotalForPagination(), state.ui.recentPerPage);
      queueUiPrefsPersist();
      emit('recent');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setOldWeekPerPage(perPage: number) {
      clearHistoryBucketOrderLock('old-week', { applyPending: false });
      state.ui.oldWeekPerPage = normalizeUiPerPage(perPage, ROUTED_BUCKET_DEFAULT_PER_PAGE);
      state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, getOldWeekTokenTotalForPagination(), state.ui.oldWeekPerPage);
      queueUiPrefsPersist();
      emit('old-week');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setSparklineRangeDays(scope: SparklineRangeScope, days: number) {
      const safeDays = normalizeSparklineRangeDays(days);
      if (state.ui.sparklineRange.global) {
        if (state.ui.sparklineRange.globalDays === safeDays) {
          return;
        }
        state.ui.sparklineRange.globalDays = safeDays;
      } else if (scope === 'recent') {
        if (state.ui.sparklineRange.recentDays === safeDays) {
          return;
        }
        state.ui.sparklineRange.recentDays = safeDays;
      } else if (scope === 'oldWeek') {
        if (state.ui.sparklineRange.oldWeekDays === safeDays) {
          return;
        }
        state.ui.sparklineRange.oldWeekDays = safeDays;
      } else {
        if (state.ui.sparklineRange.monitoredDays === safeDays) {
          return;
        }
        state.ui.sparklineRange.monitoredDays = safeDays;
      }
      queueUiPrefsPersist();
      refreshWorkspaceSparklinesAfterRangeChange(undefined, `range-days:${scope}`);
    },
    setSparklineRangeGlobal(enabled: boolean, scope: SparklineRangeScope) {
      if (state.ui.sparklineRange.global === enabled) {
        return;
      }
      const activeDays = getSparklineRangeDays(scope);
      if (enabled) {
        state.ui.sparklineRange.globalDays = activeDays;
      } else if (scope === 'recent') {
        state.ui.sparklineRange.recentDays = activeDays;
      } else if (scope === 'oldWeek') {
        state.ui.sparklineRange.oldWeekDays = activeDays;
      } else {
        state.ui.sparklineRange.monitoredDays = activeDays;
      }
      state.ui.sparklineRange.global = enabled;
      queueUiPrefsPersist();
      refreshWorkspaceSparklinesAfterRangeChange(undefined, `range-global:${scope}`);
    },
    setTokenSparklineRangeDays(address: string, days: number, chain: TokenChain = 'solana') {
      const identity = getChartCapableIdentity(chain, address);
      if (!identity) {
        return;
      }

      const safeDays = normalizeSparklineRangeDays(days);
      if (state.ui.sparklineRange.tokenDaysByAddress[identity.key] === safeDays) {
        return;
      }

      const nextTokenDaysByAddress = {
        ...state.ui.sparklineRange.tokenDaysByAddress,
        [identity.key]: safeDays,
      };
      if (identity.chain === 'solana') {
        delete nextTokenDaysByAddress[identity.address];
      }
      state.ui.sparklineRange.tokenDaysByAddress = pruneSparklineRangeTokenDays(nextTokenDaysByAddress);
      queueUiPrefsPersist();
      refreshWorkspaceSparklinesAfterRangeChange([identity.key], 'token-range-days');
    },
    resetTokenSparklineRangeDays(address: string, chain: TokenChain = 'solana') {
      const identity = getChartCapableIdentity(chain, address);
      const hasLegacyOverride = identity?.chain === 'solana'
        && state.ui.sparklineRange.tokenDaysByAddress[identity.address] != null;
      if (!identity || (
        state.ui.sparklineRange.tokenDaysByAddress[identity.key] == null
        && !hasLegacyOverride
      )) {
        return;
      }

      const nextTokenDaysByAddress = { ...state.ui.sparklineRange.tokenDaysByAddress };
      delete nextTokenDaysByAddress[identity.key];
      if (identity.chain === 'solana') {
        delete nextTokenDaysByAddress[identity.address];
      }
      state.ui.sparklineRange.tokenDaysByAddress = nextTokenDaysByAddress;
      queueUiPrefsPersist();
      refreshWorkspaceSparklinesAfterRangeChange([identity.key], 'token-range-reset');
    },
    setManualSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.manualSorts = toggleSortCriterion(
        state.ui.manualSorts,
        normalizeBucketCriterion(mode, window),
      );
      queueUiPrefsPersist();
      emit('manual');
      if (state.session.token && isLiveWorkspace()) {
        void refreshHistoryWorkspaceSparklines({ token: state.session.token, force: true, caller: 'manual-sort' });
      }
    },
    setRecentSort(mode: BucketSortMode, window?: BucketSortWindow) {
      clearHistoryBucketOrderLock('recent', { applyPending: false });
      state.ui.recentSorts = toggleSortCriterion(
        state.ui.recentSorts,
        normalizeBucketCriterion(mode, window),
      );
      state.ui.recentPage = 0;
      queueUiPrefsPersist();
      emit('recent');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow) {
      clearHistoryBucketOrderLock('old-week', { applyPending: false });
      state.ui.oldWeekSorts = toggleSortCriterion(
        state.ui.oldWeekSorts,
        normalizeBucketCriterion(mode, window),
      );
      state.ui.oldWeekPage = 0;
      queueUiPrefsPersist();
      emit('old-week');
      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap();
      }
    },
    setHistoryBucketOrderLocked(bucket: 'recent' | 'old-week', locked: boolean) {
      if (!usesHistoryBucketBootstrap()) {
        return;
      }

      if (locked && !isCurrentHistoryBootstrapOrderLockReady()) {
        return;
      }

      const key = bucket === 'recent' ? 'recent' : 'oldWeek';
      if (historyBucketOrderLocks[key] === locked) {
        return;
      }

      historyBucketOrderLocks[key] = locked;
      if (locked) {
        const otherBucket = bucket === 'recent' ? 'old-week' : 'recent';
        if (clearHistoryBucketOrderLock(otherBucket)) {
          emit(otherBucket);
        }
        return;
      }

      if (applyPendingHistoryOrder(bucket)) {
        emit(bucket);
      }
    },
    setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow) {
      state.ui.monitoredSorts = toggleSortCriterion(
        state.ui.monitoredSorts,
        normalizeMonitoredCriterion(mode, window),
      );
      state.ui.monitoredPage = 0;
      queueUiPrefsPersist();
      emit('monitored');
      refreshMonitoredSparklinesIfExpanded('monitored-sort');
      if (state.session.token && !usesHistoryBucketBootstrap()) {
        void hydrateDashboardMonitoredInternal(state.session.token, getManualTokens(state).map((item) => ({
          chain: item.chain || 'solana',
          address: item.address,
          label: item.label ?? null,
        })));
      }
    },
    async pinMonitoredToken(address: string, position = 0, chain: TokenChain = 'solana') {
      if (!state.session.token || !getTrackedToken(state, address, chain)) return;
      const mutationChains = getReadySelectedChains('monitored');
      const previous = captureMonitoredPinLayout();
      const next = buildMovedMonitoredPinLayout(chain, address, position);
      applyMonitoredPinLayout(next);
      if (monitoredPinMutationInFlight) {
        queuedMonitoredPinMutation = { pins: next, chains: mutationChains };
        return;
      }
      monitoredPinMutationInFlight = true;
      let mutationToSave: typeof queuedMonitoredPinMutation = {
        pins: next,
        chains: mutationChains,
      };
      let lastConfirmedLayout = previous;
      try {
        while (mutationToSave) {
          const savedLayout = await saveMonitoredPinsRequest(
            mutationToSave.pins,
            state.session.token,
            mutationToSave.chains,
          );
          lastConfirmedLayout = savedLayout;
          mutationToSave = queuedMonitoredPinMutation;
          queuedMonitoredPinMutation = null;
          if (!mutationToSave) {
            applyMonitoredPinLayout(savedLayout);
          }
        }
      } catch (error) {
        queuedMonitoredPinMutation = null;
        applyMonitoredPinLayout(lastConfirmedLayout);
        setError(error instanceof Error ? error.message : 'Failed to save monitored pin');
        emit('overlay');
      } finally {
        monitoredPinMutationInFlight = false;
      }
    },
    async unpinMonitoredToken(address: string, chain: TokenChain = 'solana') {
      const identityKey = getTrackedTokenKey(address, chain);
      if (monitoredPinMutationInFlight || !state.session.token || !state.data.pinnedMonitoredTokenIdentities.includes(identityKey)) return;
      const mutationChains = getReadySelectedChains('monitored');
      monitoredPinMutationInFlight = true;
      const previous = captureMonitoredPinLayout();
      const next = buildUnpinnedMonitoredPinLayout(chain, address);
      applyMonitoredPinLayout(next);
      try {
        applyMonitoredPinLayout(await saveMonitoredPinsRequest(
          next,
          state.session.token,
          mutationChains,
        ));
      } catch (error) {
        applyMonitoredPinLayout(previous);
        setError(error instanceof Error ? error.message : 'Failed to remove monitored pin');
        emit('overlay');
        monitoredPinMutationInFlight = false;
        return;
      }
      try {
        await refreshMonitoredAfterPinsChanged();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Pin removed, but monitored refresh failed');
        emit('overlay');
      } finally {
        monitoredPinMutationInFlight = false;
      }
    },
    async resetMonitoredTokenPins() {
      if (monitoredPinMutationInFlight || !state.session.token || state.data.pinnedMonitoredTokenIdentities.length === 0) return;
      monitoredPinMutationInFlight = true;
      const previous = captureMonitoredPinLayout();
      applyMonitoredPinLayout([]);
      try {
        await resetMonitoredPinsRequest(state.session.token, state.ui.chainFilters.enabledChains);
      } catch (error) {
        applyMonitoredPinLayout(previous);
        setError(error instanceof Error ? error.message : 'Failed to reset monitored pins');
        emit('overlay');
        monitoredPinMutationInFlight = false;
        return;
      }
      try {
        await refreshMonitoredAfterPinsChanged();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Pins reset, but monitored refresh failed');
        emit('overlay');
      } finally {
        monitoredPinMutationInFlight = false;
      }
    },
    setEnabledTradeTerminals(terminals: AppState['ui']['enabledTradeTerminals']) {
      state.ui.enabledTradeTerminals = normalizeTradeTerminals(terminals);
      queueUiPrefsPersist();
      emit('manual', 'recent', 'old-week', 'monitored', 'bid-zone', 'pumpfun', 'alerts', 'overlay');
    },
    setLivePanelSpan(panel: 'monitored' | 'alerts', span: 1 | 2 | 3) {
      const nextSpan = normalizeResizableLivePanelSpan(span);
      if (state.ui.livePanelLayout.spans[panel] === nextSpan) {
        return;
      }
      state.ui.livePanelLayout.spans[panel] = nextSpan;
      queueUiPrefsPersist();
      emit(panel);
      if (panel === 'monitored' && nextSpan > 1) {
        refreshMonitoredSparklinesIfExpanded('live-panel-span');
      }
    },
    setLivePanelHeight(panel: 'monitored' | 'alerts', height: number) {
      const nextHeight = normalizeLivePanelHeight(height);
      if (state.ui.livePanelLayout.heights[panel] === nextHeight) {
        return;
      }
      state.ui.livePanelLayout.heights[panel] = nextHeight;
      queueUiPrefsPersist();
      emit(panel);
    },
    setLivePanelOrder(order: Array<'monitored' | 'pumpfun' | 'alerts'>) {
      const nextOrder = normalizeLivePanelOrder(order);
      const currentOrder = state.ui.livePanelLayout.order;
      if (currentOrder.length === nextOrder.length && currentOrder.every((item, index) => item === nextOrder[index])) {
        return;
      }
      state.ui.livePanelLayout.order = nextOrder;
      queueUiPrefsPersist();
      emit('monitored', 'pumpfun', 'alerts');
    },
    resetLivePanelLayout() {
      const defaults = getDefaultLivePanelLayout();
      const current = state.ui.livePanelLayout;
      const isDefaultOrder = current.order.length === defaults.order.length
        && current.order.every((item, index) => item === defaults.order[index]);
      const isDefaultSpans = current.spans.monitored === defaults.spans.monitored
        && current.spans.pumpfun === defaults.spans.pumpfun
        && current.spans.alerts === defaults.spans.alerts;
      const isDefaultHeights = current.heights.monitored === defaults.heights.monitored
        && current.heights.alerts === defaults.heights.alerts;
      if (isDefaultOrder && isDefaultSpans && isDefaultHeights) {
        return;
      }
      state.ui.livePanelLayout = {
        order: [...defaults.order],
        spans: { ...defaults.spans },
        heights: { ...defaults.heights },
      };
      queueUiPrefsPersist();
      emit('monitored', 'pumpfun', 'alerts');
    },
    setSoundEnabled(enabled: boolean) {
      state.ui.soundEnabled = enabled;
      state.data.configs['sound-mode'] = enabled ? 'on' : 'off';
      persistSoundSettings();
      void persistUiConfigs({ 'sound-mode': enabled ? 'on' : 'off' });
      emit('overlay');
    },
    async toggleStarredToken(address: string, chain: TokenChain = 'solana') {
      if (state.data.chainReadiness[chain]?.capabilities.starred !== true) return;
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }
      const identityKey = getTrackedTokenKey(address, chain);
      const wasStarred = state.data.starredTokenIdentities.includes(identityKey);
      replaceStarredTokens(
        wasStarred
          ? state.data.starredTokenIdentities.filter((item) => item !== identityKey)
          : [...state.data.starredTokenIdentities, identityKey],
      );
      emit('manual', 'recent', 'old-week', 'monitored', 'bid-zone', 'alerts');
      try {
        if (wasStarred) {
          await removeStarredTokenRequest(chain, address, token);
        } else {
          await addStarredTokenRequest(chain, address, token);
        }
        if (usesHistoryBucketBootstrap()) {
          void refreshHistoryWorkspaceBootstrap();
        }
      } catch (error) {
        replaceStarredTokens(
          wasStarred
            ? [...state.data.starredTokenIdentities, identityKey]
            : state.data.starredTokenIdentities.filter((item) => item !== identityKey),
        );
        setError(error instanceof Error ? error.message : 'Failed to update starred token');
        emit('manual', 'recent', 'old-week', 'monitored', 'bid-zone', 'alerts');
      }
    },
    setSoundVolume(volume: number) {
      const nextVolume = clampUiVolume(volume);
      state.ui.soundVolume = nextVolume;
      state.data.configs['sound-volume'] = Math.round(nextVolume * 100);
      persistSoundSettings();
      void persistUiConfigs({ 'sound-volume': Math.round(nextVolume * 100) });
      emit('overlay');
    },
    async enableBrowserNotifications() {
      const permission = await requestBrowserNotificationPermission();
      state.ui.browserNotifications.permission = permission;
      state.ui.browserNotifications.enabled = permission === 'granted';
      persistBrowserNotificationSettings();
      emit('overlay');
    },
    disableBrowserNotifications() {
      state.ui.browserNotifications.permission = getBrowserNotificationStatus();
      state.ui.browserNotifications.enabled = false;
      persistBrowserNotificationSettings();
      emit('overlay');
    },
    setWorkspace(workspace: WorkspaceView) {
      navigateToWorkspace(workspace);
    },
    syncWorkspaceFromLocation() {
      if (state.session.status === 'anonymous') {
        syncAnonymousRouteStateFromLocation();
        if (typeof window !== 'undefined' && isPublicLandingRoutePath(window.location.pathname) && !state.billing.loaded) {
          void refreshPublicBillingState().then(() => emit('all')).catch(() => emit('all'));
          return;
        }
        emit('all');
        return;
      }
      if (typeof window !== 'undefined' && isAccountSecurityRoutePath(window.location.pathname)) {
        void refreshAccountSecurityState().then(() => emit('all')).catch(() => emit('all'));
        return;
      }
      syncWorkspaceFromLocationInternal();
    },
    async refreshRestoredSessionState(options?: { force?: boolean }) {
      await refreshRestoredSessionStateInternal(options);
    },
    setDocumentHidden(hidden: boolean) {
      documentHiddenForUi = Boolean(hidden);
      if (hidden && clearHistoryBucketOrderLocks()) {
        emit('recent', 'old-week');
      }
      if (state.session.status !== 'authenticated' || state.runtime.mode !== 'active') {
        return;
      }

      if (hidden) {
        syncHistorySyncState({ runImmediatelyOnGain: true });
        syncMonitoringPolling();
        if (isLiveWorkspace()) {
          stopPumpGcTimer();
        }
        return;
      }

      syncHistorySyncState({ runImmediatelyOnGain: true });
      syncMonitoringPolling();
      if (isLiveWorkspace()) {
        startPumpGcTimer();
        window.setTimeout(() => {
          if (
            documentHiddenForUi
            || state.session.status !== 'authenticated'
            || state.runtime.mode !== 'active'
            || !isLiveWorkspace()
            || !isWorkspacePollingLeader()
          ) {
            return;
          }
          void refreshMonitoredDashboard();
        }, 250);
      }
    },
    startMonitoring() {
      startMonitoringTimers();
      emit('header', 'recent', 'old-week');
    },
    stopMonitoring() {
      stopMonitoringTimers();
      emit('header', 'recent', 'old-week');
    },
    async init() {
      const billingCheckoutSucceeded = typeof window !== 'undefined' && getBillingCheckoutIntent(window.location) === 'success';
      const billingCheckoutOrderId = typeof window !== 'undefined' ? getBillingCheckoutOrderId(window.location) : null;
      const socialLinkIntent = typeof window !== 'undefined' ? getSocialLinkIntent(window.location) : null;
      const socialLoginIntent = typeof window !== 'undefined' ? getSocialLoginIntent(window.location) : null;

      if (socialLinkIntent && shouldHandleSocialLinkPopupIntent(socialLinkIntent)) {
        handleSocialLinkPopupIntent(socialLinkIntent);
        return;
      }

      if (await handleInitAuthRouteIntent()) {
        return;
      }

      setBusy(true);
      setError(null);
      setNotice(AUTH_NOTICE_RESTORING);
      emit();

      try {
        await restoreAuthenticatedSession({
          billingCheckoutSucceeded,
          socialLinkIntent,
          socialLoginIntent,
        });
      } catch (error) {
        await handleSessionRestoreFailure(error, {
          billingCheckoutSucceeded,
          billingCheckoutOrderId,
          socialLoginIntent,
        });
      } finally {
        setBusy(false);
        emit();
      }

      await handleAuthRouteIntent();
      if (state.session.status === 'pre_access') {
        if (typeof window !== 'undefined' && isAccountSecurityRoutePath(window.location.pathname)) {
          await refreshAccountSecurityState();
        } else {
          navigateToPreAccess();
        }
      } else if (state.session.status === 'anonymous') {
        syncAnonymousRouteStateFromLocation();
      } else {
        if (typeof window !== 'undefined' && isAccountSecurityRoutePath(window.location.pathname)) {
          await refreshAccountSecurityState();
        } else {
          syncWorkspaceFromLocationInternal({
            canonicalize: state.session.status === 'authenticated',
          });
        }
      }
    },
    async login(email: string, password: string) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validateLoginCredentials(email, password);
      if (!validated.ok) {
        setError(validated.message);
        state.ui.loginErrorCount = 0;
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice(AUTH_NOTICE_SIGNING_IN);
      emit();

      try {
        const result = await login(validated.email, validated.password);
        const challengeToken = normalizeLoginOtpChallengeToken(String(result.challengeToken || ''));
        if (result.otpRequired) {
          if (!challengeToken) {
            throw new Error('Verification challenge is missing. Please sign in again.');
          }
          disconnectSocket();
          stopMonitoringTimers();
          clearSession();
          state.ui.pendingLoginOtpChallengeToken = challengeToken;
          state.ui.pendingLoginOtpEmailHint = trimLoginEmailValue(result.otpEmailHint || validated.email);
          state.ui.authPanel = 'email-otp';
          state.ui.loginErrorCount = 0;
          setNotice(appendEmailDebugNotice(
            result.message || 'Verification code sent. Check your email to finish signing in.',
            result.emailDebug,
          ));
          return;
        }
        const session = await fetchCurrentSession();
        applySession(session.user, { deferWorkspaceSync: true });
        await refreshAccountAccessState(COOKIE_SESSION_MARKER);
        await refreshBillingState(COOKIE_SESSION_MARKER);
        await refreshIdentityState(COOKIE_SESSION_MARKER);
        await reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true });
        syncWorkspaceFromLocationInternal({ canonicalize: true });
        state.ui.loginErrorCount = 0;
        setNotice(AUTH_NOTICE_LOGIN_SUCCESS);
      } catch (error) {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        const raw = error instanceof Error ? error.message : '';
        if (raw.includes('Authentication required')) {
          setError(AUTH_ERROR_COOKIE_BLOCKED);
          authSubmitInFlight = false;
          setBusy(false);
          emit();
          return;
        }
        let message = normalizeAuthError(error, 'login');
        if (message.includes('Incorrect email or password')) {
          const previousPasswordMatch = await findPreviousPasswordMatch(validated.email, validated.password);
          if (previousPasswordMatch) {
            const changedAt = formatPasswordChangedDate(previousPasswordMatch.changedAt);
            message = changedAt
              ? `You are using the old password changed on ${changedAt}.`
              : 'You are using the old password from a previous change.';
          }
        }
        state.ui.loginErrorCount = isCredentialError(message)
          ? state.ui.loginErrorCount + 1
          : 0;
        setError(message);
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async loginWithWallet(walletId?: string) {
      if (authSubmitInFlight) {
        return;
      }
      if (!walletId) {
        await openWalletSelector('login');
        return;
      }

      closeWalletSelectorInternal();
      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Connecting wallet...');
      emit('legacy');

      try {
        await loginWithSelectedWallet(walletId);
      } catch (error) {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        setError(normalizeWalletLoginError(error));
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async verifyLoginOtp(code: string) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validateLoginOtpInput({
        challengeToken: state.ui.pendingLoginOtpChallengeToken || '',
        code,
      });
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Verifying code...');
      emit();

      try {
        const result = await verifyLoginOtpRequest(validated.input);
        if (!result.user) {
          throw new Error('OTP verification succeeded without session payload');
        }
        state.ui.pendingLoginOtpChallengeToken = null;
        state.ui.pendingLoginOtpEmailHint = null;
        state.ui.authPanel = 'none';
        if (result.requiresPreAccess) {
          applyPreAccessSession(result.user);
          applyAccountAccess(result.access ?? null);
          await refreshPreAccessState();
          navigateToPreAccess(result.redirectPath || '/access');
          state.ui.loginErrorCount = 0;
          setNotice(result.message || 'Access payment required before entering the bot.');
        } else {
          applySession(result.user, { deferWorkspaceSync: true });
          await refreshAccountAccessState(COOKIE_SESSION_MARKER);
          await refreshBillingState(COOKIE_SESSION_MARKER);
          await refreshIdentityState(COOKIE_SESSION_MARKER);
          await reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true });
          syncWorkspaceFromLocationInternal({ canonicalize: true });
          state.ui.loginErrorCount = 0;
          setNotice(result.message || AUTH_NOTICE_LOGIN_SUCCESS);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'OTP verification failed');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async resendLoginOtp() {
      if (authSubmitInFlight) {
        return;
      }

      const challengeToken = String(state.ui.pendingLoginOtpChallengeToken || '').trim();
      if (!challengeToken) {
        setError('Verification challenge is missing. Please sign in again.');
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Sending verification code...');
      emit();

      try {
        const result = await resendLoginOtpRequest(challengeToken);
        state.ui.pendingLoginOtpChallengeToken = normalizeLoginOtpChallengeToken(String(result.challengeToken || '')) || challengeToken;
        state.ui.pendingLoginOtpEmailHint = trimLoginEmailValue(result.otpEmailHint || state.ui.pendingLoginOtpEmailHint || '') || state.ui.pendingLoginOtpEmailHint;
        setNotice(appendEmailDebugNotice(
          result.message || 'A new verification code has been sent.',
          result.emailDebug,
        ));
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to resend verification code');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async register(input: RegisterInput) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validateRegisterInput(input);
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Creating account...');
      emit();

      try {
        const result = await registerRequest(validated.input);
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        navigateToLogin();
        state.ui.pendingVerificationEmail = trimLoginEmailValue(validated.input.email);
        state.ui.authPanel = 'email-verification';
        replaceAuthPanelRoute('email-verification');
        setNotice(appendEmailDebugNotice(
          result.verificationEmailError
            ? 'Account created, but the verification email could not be sent. Fix email delivery and resend.'
            : result.emailVerificationRequired
              ? 'Account created. Check your inbox to verify your email.'
              : 'Account created. Workspace synced.',
          result.emailDebug,
        ));
      } catch (error) {
        const raw = error instanceof Error ? error.message : '';
        if (raw.includes('Authentication required')) {
          setError(AUTH_ERROR_COOKIE_BLOCKED);
        } else {
          setError(normalizeAuthError(error, 'login'));
        }
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async requestEmailVerification(email?: string) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validatePasswordResetRequestInput({ email: String(email || state.session.email || '') });
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Sending verification email...');
      emit();

      try {
        const result = await requestEmailVerificationRequest(validated.input, state.session.token);
        setNotice(appendEmailDebugNotice(
          result.message || 'Verification email sent.',
          result.emailDebug,
        ));
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to send verification email');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async requestPasswordReset(email: string) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validatePasswordResetRequestInput({ email });
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Sending password reset email...');
      emit();

      try {
        const result = await requestPasswordResetRequest(validated.input);
        setNotice(appendEmailDebugNotice(
          result.message || 'Password reset email sent.',
          result.emailDebug,
        ));
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Password reset request failed');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async confirmPasswordReset(newPassword: string, confirmNewPassword: string) {
      if (authSubmitInFlight) {
        return;
      }

      const validated = validatePasswordResetConfirmInput({
        token: state.ui.pendingPasswordResetToken || '',
        newPassword,
        confirmNewPassword,
      });
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Resetting password...');
      emit();

      try {
        const result = await confirmPasswordResetRequest(validated.input);
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        navigateToLogin();
        state.ui.authPanel = 'none';
        state.ui.pendingPasswordResetToken = null;
        setNotice(result.message || 'Password reset successful. Please login again.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Password reset failed');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async changePassword(currentPassword: string, newPassword: string, confirmNewPassword: string) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }
      if (authSubmitInFlight) {
        return;
      }

      const validated = validateChangePasswordInput({ currentPassword, newPassword, confirmNewPassword });
      if (!validated.ok) {
        setError(validated.message);
        emit();
        return;
      }

      authSubmitInFlight = true;
      setBusy(true);
      setError(null);
      setNotice('Changing password...');
      emit();

      try {
        const sessionEmail = state.session.email;
        const result = await changePasswordRequest(validated.input, token);
        if (sessionEmail) {
          await rememberPreviousPassword(sessionEmail, validated.input.currentPassword, new Date());
        }
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        navigateToLogin();
        state.ui.authPanel = 'password-change-success';
        setNotice(result.message || 'Password changed successfully. Please login again with your new password.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Change-password failed');
      } finally {
        authSubmitInFlight = false;
        setBusy(false);
        emit();
      }
    },
    async validateInvite(code: string) {
      return validateInviteCode(normalizeInviteCode(code));
    },
    async logout() {
      const token = state.session.token;
      setBusy(true);
      setError(null);
      setNotice('Logging out...');
      emit();

      try {
        if (state.session.status === 'pre_access') {
          await logoutPreAccessSession();
        } else if (token) {
          await logout(token);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Logout failed');
      } finally {
        const hadPreAccessSession = state.session.status === 'pre_access';
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        if (hadPreAccessSession || typeof window !== 'undefined') {
          navigateToPublicLanding();
        }
        setBusy(false);
        setNotice('Logged out. Review the plans or sign in again when ready.');
        emit();
        void refreshPublicBillingState().then(() => emit('all')).catch(() => emit('all'));
      }
    },
    async logoutAll() {
      const token = state.session.token;
      setBusy(true);
      setError(null);
      setNotice('Revoking all sessions...');
      emit();

      try {
        if (token) {
          const result = await logoutAll(token);
          setNotice(result.message);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Logout-all failed');
      } finally {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        setBusy(false);
        emit();
      }
    },
    async reloadConfig() {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Reloading /api/config...');
      emit();

      try {
        await reloadConfigInternal(token);
        if (monitoringInterval) {
          stopMonitoringTimers();
          startMonitoringTimers();
        }
        setNotice('Config reloaded successfully.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Config reload failed');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async saveMonitoringConfig(configs: Record<string, number | string>) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setError(null);
      const updatesMonitoredValuationFilters = (
        Object.prototype.hasOwnProperty.call(configs, 'monitored-mcap-min')
        || Object.prototype.hasOwnProperty.call(configs, 'monitored-fdv-min')
      );
      const previousConfigs = { ...state.data.configs };
      state.data.configs = { ...state.data.configs, ...configs };
      applyUiPreferencesFromConfigs();
      persistSoundSettings();

      if (usesHistoryBucketBootstrap()) {
        void refreshHistoryWorkspaceBootstrap({ token });
      } else {
        sweepMinMcapRemove();
        deriveAgeBuckets();
      }
      emit();

      try {
        const patchResult = await patchConfig(configs, token);
        state.data.configs = { ...state.data.configs, ...patchResult.configs };
        applyUiPreferencesFromConfigs();
        persistSoundSettings();
        if (updatesMonitoredValuationFilters) {
          state.ui.monitoredPage = 0;
          void refreshMonitoredDashboard();
        }
        emit();
      } catch (error) {
        state.data.configs = previousConfigs;
        applyUiPreferencesFromConfigs();
        persistSoundSettings();
        if (usesHistoryBucketBootstrap()) {
          void refreshHistoryWorkspaceBootstrap({ token });
        } else {
          sweepMinMcapRemove();
          deriveAgeBuckets();
        }
        setError(error instanceof Error ? error.message : 'Failed to save config');
        emit();
      }
    },
    async addManualToken(address: string, label?: string | null, chain: TokenChain = 'solana') {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) {
        setError('Token address is required');
        emit();
        return;
      }

      if (!isValidTokenAddressFormat(normalizedAddress, chain)) {
        setError('Invalid token address format');
        setNotice(null);
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Adding manual token...');

      invalidateWorkspaceHydrationRequests();
      const optimisticSnapshot = captureOptimisticManualTokenSnapshot(normalizedAddress, chain);
      const nextManual = buildOptimisticManualToken(normalizedAddress, label, chain);
      applyOptimisticManualToken(normalizedAddress, nextManual);
      emit();

      try {
        const syncResult = await syncManualTokenToBackend(chain, normalizedAddress, label, token);
        setNotice(syncResult.followupError ? 'Token added; metadata refresh pending' : 'Token added');
      } catch (error) {
        revertOptimisticManualToken(normalizedAddress, optimisticSnapshot);
        setError(error instanceof Error ? error.message : 'Failed to persist manual token');
        setNotice(null);
      } finally {
        setBusy(false);
        emit();
      }
    },
    async removeManualToken(address: string, chain: TokenChain = 'solana') {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Removing manual token...');
      emit();

      try {
        invalidateWorkspaceHydrationRequests();
        const identityKey = getTrackedTokenKey(address, chain);
        state.data.manualTokenIdentities = state.data.manualTokenIdentities.filter((item) => (
          item !== identityKey
        ));
        const currentTracked = getTrackedToken(state, address, chain);
        if (currentTracked) {
          replaceTrackedTokenReferences(address, {
            ...currentTracked,
            manual: false,
            _userManual: false,
          });
        }
        state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
        state.bars.manual = state.data.manualTokenIdentities.length;
        deriveAgeBuckets();
        refreshMonitoredPanelCounts();
        emit();
        await removeManualTokenRequest(chain, address, token);
        await reloadConfigPreservingMonitoredSnapshot(token);
        setNotice('Token removed');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove manual token');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async createManualTokenFolder(name: string) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Creating manual token folder...');
      emit('manual');

      try {
        await createManualTokenFolderRequest({ name }, token);
        applyManualTokenFolders(await fetchManualTokenFolders(token));
        setNotice('Folder created');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create folder');
      } finally {
        setBusy(false);
        emit('manual', 'header');
      }
    },
    async updateManualTokenFolder(folderId: number, input: { name?: string; sortOrder?: number }) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Updating manual token folder...');
      emit('manual');

      try {
        await updateManualTokenFolderRequest(folderId, input, token);
        applyManualTokenFolders(await fetchManualTokenFolders(token));
        setNotice('Folder updated');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to update folder');
      } finally {
        setBusy(false);
        emit('manual', 'header');
      }
    },
    async deleteManualTokenFolder(folderId: number) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Deleting manual token folder...');
      const removedIdentities = [...new Map(state.data.manualTokenFolderItems
        .filter((item) => item.folderId === folderId)
        .map((item) => {
          const chain = resolveAppTokenChain(item.chain);
          const address = String(item.address || '').trim();
          return [getTrackedTokenKey(address, chain), { chain, address }];
        })).values()].filter((item) => item.address);
      const folderSnapshot = state.data.manualTokenFolders.map((item) => ({ ...item }));
      const folderItemsSnapshot = state.data.manualTokenFolderItems.map((item) => ({ ...item }));
      const visibleFolderIdsSnapshot = [...state.ui.manualVisibleFolderIds];
      const manualAddressesSnapshot = [...state.data.manualTokenIdentities];
      const trackedTokenSnapshots = Object.fromEntries(
        removedIdentities
          .map((item) => {
            const identityKey = getTrackedTokenKey(item.address, item.chain);
            const trackedToken = getTrackedToken(state, item.address, item.chain);
            return [identityKey, trackedToken ? { ...trackedToken } : null] as const;
          }),
      );
      const pendingRemovedAddresses = new Set(removedIdentities.map((item) => (
        getTrackedTokenKey(item.address, item.chain)
      )));
      const removedIdentitySet = new Set(pendingRemovedAddresses);

      pendingManualFolderDeleteIds.add(folderId);
      for (const item of pendingRemovedAddresses) {
        pendingManualFolderDeleteAddresses.add(item);
      }
      state.data.manualTokenFolders = state.data.manualTokenFolders.filter((folder) => folder.id !== folderId);
      state.data.manualTokenFolderItems = state.data.manualTokenFolderItems.filter((item) => (
        item.folderId !== folderId
        && !removedIdentitySet.has(getTrackedTokenKey(item.address, item.chain))
      ));
      state.ui.manualVisibleFolderIds = state.ui.manualVisibleFolderIds.filter((id) => id !== folderId);
      state.data.manualTokenIdentities = state.data.manualTokenIdentities.filter((item) => !removedIdentitySet.has(item));
      for (const item of removedIdentities) {
        const currentTracked = getTrackedToken(state, item.address, item.chain);
        if (currentTracked) {
          replaceTrackedTokenReferences(item.address, {
            ...currentTracked,
            manual: false,
            _userManual: false,
          });
        }
      }
      state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
      state.bars.manual = state.data.manualTokenIdentities.length;
      deriveAgeBuckets();
      refreshMonitoredPanelCounts();
      emit('manual', 'monitored', 'header');

      try {
        const result = await deleteManualTokenFolderRequest(folderId, token);
        for (const item of result.removedTokenIdentities || []) {
          const identityKey = getTrackedTokenKey(item.address, item.chain);
          pendingRemovedAddresses.add(identityKey);
          pendingManualFolderDeleteAddresses.add(identityKey);
        }
        await reloadConfigPreservingMonitoredSnapshot(token);
        const removedCount = result.removedTokens.length;
        setNotice(removedCount > 0 ? `Folder deleted; ${removedCount} manual token(s) removed` : 'Folder deleted');
      } catch (error) {
        pendingManualFolderDeleteIds.delete(folderId);
        for (const item of pendingRemovedAddresses) {
          pendingManualFolderDeleteAddresses.delete(item);
        }
        state.data.manualTokenFolders = folderSnapshot;
        state.data.manualTokenFolderItems = folderItemsSnapshot;
        state.ui.manualVisibleFolderIds = visibleFolderIdsSnapshot;
        state.data.manualTokenIdentities = manualAddressesSnapshot;
        for (const [identityKey, snapshot] of Object.entries(trackedTokenSnapshots)) {
          if (snapshot) {
            setTrackedToken(snapshot);
          } else {
            const identity = parseTokenIdentityKey(identityKey);
            deleteTrackedToken(identity.address, identity.chain);
          }
        }
        state.configSummary.manualTokens = state.data.manualTokenIdentities.length;
        state.bars.manual = state.data.manualTokenIdentities.length;
        deriveAgeBuckets();
        refreshMonitoredPanelCounts();
        setError(error instanceof Error ? error.message : 'Failed to delete folder');
      } finally {
        pendingManualFolderDeleteIds.delete(folderId);
        for (const item of pendingRemovedAddresses) {
          pendingManualFolderDeleteAddresses.delete(item);
        }
        setBusy(false);
        emit('manual', 'monitored', 'header');
      }
    },
    async addManualTokenToFolder(
      folderId: number,
      address: string,
      chain: TokenChain = 'solana',
    ) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) {
        setError('Token address is required');
        emit('manual');
        return;
      }

      if (!isValidTokenAddressFormat(normalizedAddress, chain)) {
        setError('Invalid token address format');
        setNotice(null);
        emit('manual');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Adding token to folder...');

      const tokenSnapshot = captureOptimisticManualTokenSnapshot(normalizedAddress, chain);
      const folderItemsSnapshot = state.data.manualTokenFolderItems.map((item) => ({ ...item }));
      applyOptimisticManualToken(
        normalizedAddress,
        buildOptimisticManualToken(normalizedAddress, null, chain),
      );
      upsertManualTokenFolderItem({
        userId: 0,
        folderId,
        chain,
        address: normalizedAddress,
        sortOrder: 0,
        addedAt: null,
      });
      emit('manual', 'monitored', 'header');

      try {
        const result = await addManualTokenToFolderRequest(
          folderId, chain, normalizedAddress, token,
        );
        upsertManualTokenFolderItem(result.item);
        void reloadConfigPreservingMonitoredSnapshot(token)
          .then(() => emit('manual', 'monitored', 'header'))
          .catch(() => {
            void fetchManualTokenFolders(token)
              .then((payload) => {
                applyManualTokenFolders(payload);
                emit('manual', 'header');
              })
              .catch(() => {});
          });
        setNotice('Token added to folder');
      } catch (error) {
        revertOptimisticManualToken(normalizedAddress, tokenSnapshot);
        state.data.manualTokenFolderItems = folderItemsSnapshot;
        setError(error instanceof Error ? error.message : 'Failed to add token to folder');
        setNotice(null);
      } finally {
        setBusy(false);
        emit('manual', 'monitored', 'header');
      }
    },
    async removeManualTokenFromFolder(
      folderId: number,
      address: string,
      chain: TokenChain = 'solana',
    ) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Removing manual token...');
      emit('manual');

      try {
        await removeManualTokenFromFolderRequest(folderId, chain, address, token);
        await reloadConfigPreservingMonitoredSnapshot(token);
        setNotice('Token removed');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove token');
      } finally {
        setBusy(false);
        emit('manual', 'monitored', 'header');
      }
    },
    setManualVisibleFolderIds(folderIds: number[]) {
      const nextFolderIds = Array.from(new Set(
        (Array.isArray(folderIds) ? folderIds : [])
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0),
      ));
      const current = state.ui.manualVisibleFolderIds;
      if (current.length === nextFolderIds.length && current.every((id, index) => id === nextFolderIds[index])) {
        return;
      }
      state.ui.manualVisibleFolderIds = nextFolderIds;
      emit('manual');
    },
    async addBlockedToken(
      address: string,
      label?: string | null,
      chain: TokenChain = 'solana',
    ) {
      if (!state.session.token) {
        setError('No authenticated session');
        emit();
        return;
      }

      if (shouldShowBlockedTokenWarning()) {
        if (openBlockedTokenWarning(address, label, chain)) {
          return;
        }
      }

      await addBlockedTokenInternal(address, label, chain);
    },
    async cancelBlockedTokenWarning() {
      await finalizeBlockedTokenWarning();
    },
    setBlockedTokenWarningDontShowAgain(enabled: boolean) {
      if (!state.ui.blockTokenWarning) {
        return;
      }

      state.ui.blockTokenWarning = {
        ...state.ui.blockTokenWarning,
        dontShowAgain: Boolean(enabled),
      };
      emit('overlay');
    },
    async confirmBlockedTokenWarning() {
      const warning = await finalizeBlockedTokenWarning();
      if (!warning) {
        return;
      }
      await addBlockedTokenInternal(warning.address, warning.label, warning.chain);
    },
    async adminBlockToken(address: string, label?: string | null) {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      if (state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Permanently blocking token in backend...');
      const removedTokenSnapshot = captureRemovedTokenSnapshot(address);
      removeTokenEverywhere(address);
      emit();

      try {
        const result = await adminBlockTokenRequest(address, label, token);
        if (removedTokenSnapshot.wasStarred) {
          replaceStarredTokens(state.data.starredTokenIdentities.filter((item) => (
            item !== removedTokenSnapshot.identityKey
          )));
          await removeStarredTokenRequest('solana', address, token).catch(() => {});
        }
        setNotice(result.message);
      } catch (error) {
        restoreRemovedTokenSnapshot(removedTokenSnapshot);
        setError(error instanceof Error ? error.message : 'Failed to permanently block token');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async adminUnblockToken(address: string) {
      const token = state.session.token;
      const normalized = String(address || '').trim();
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      if (state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }

      if (!isValidTokenAddressFormat(normalized)) {
        setError('Enter a valid token contract address');
        emit('overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Removing backend block and scheduling Dex refresh...');
      emit('overlay');

      try {
        const result = await adminUnblockTokenRequest(normalized, token);
        setNotice(`${result.message}. Dex evaluation was queued.`);
        void refreshMonitoredDashboard();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove token from backend blocklist');
      } finally {
        setBusy(false);
        emit('overlay', 'monitored', 'manual', 'recent', 'old-week', 'header');
      }
    },
    async refreshAdminTokenReviewAlerts() {
      if (!state.session.token || state.session.role !== 'admin') {
        state.data.adminTokenReviewAlerts = [];
        emit('overlay', 'header', 'alerts');
        return;
      }

      try {
        await loadAdminTokenReviewAlertsInternal();
        setError(null);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to load token review alerts');
      } finally {
        emit('overlay', 'header', 'alerts');
      }
    },
    async resolveAdminTokenReviewAlert(id: number, resolution: AdminTokenReviewResolution) {
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit('overlay');
        return;
      }

      const parsedId = Number(id);
      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        setError('Valid review alert id is required');
        emit('overlay');
        return;
      }

      const currentAlert = state.data.adminTokenReviewAlerts.find((alert) => alert.id === parsedId) || null;
      setBusy(true);
      setError(null);
      setNotice('Resolving token review alert...');
      emit('overlay');

      try {
        const result = await resolveAdminTokenReviewAlertRequest(parsedId, resolution, token);
        state.data.adminTokenReviewAlerts = state.data.adminTokenReviewAlerts.filter((alert) => alert.id !== parsedId);
        if (resolution === 'block' && currentAlert?.tokenAddress) {
          removeTokenEverywhere(currentAlert.tokenAddress);
        }
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to resolve token review alert');
      } finally {
        setBusy(false);
        emit('overlay', 'manual', 'recent', 'old-week', 'monitored', 'header', 'alerts');
      }
    },
    async mockBuyToken(address: string) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      if (!state.session.token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }

      state.ui.mockTradingTicket = { address, side: 'buy' };
      state.ui.mockTradingHistoryOpen = false;
      state.ui.expandedSparklineAddress = null;
      state.ui.mockTradingPnlAddress = null;
      setError(null);
      emit('overlay');
    },
    async mockSellToken(address: string, percent: number) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      if (!state.session.token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }

      state.ui.mockTradingTicket = { address, side: 'sell', percent };
      state.ui.mockTradingHistoryOpen = false;
      state.ui.expandedSparklineAddress = null;
      state.ui.mockTradingPnlAddress = null;
      setError(null);
      emit('overlay');
    },
    async setActiveMockTradingWallet(walletId: number) {
      if (!getMockTradingAdminToken()) {
        return;
      }
      if (!Number.isInteger(walletId) || !state.data.mockTradingWallets.some((wallet) => wallet.id === walletId)) {
        setError('Valid mock trading wallet is required');
        emit('header', 'overlay');
        return;
      }
      if (state.ui.activeMockTradingWalletId === walletId) {
        return;
      }

      state.ui.activeMockTradingWalletId = walletId;
      persistMockTradingActiveWalletId(walletId);
      if (state.data.mockTradingSummary) {
        state.data.mockTradingSummary = {
          ...state.data.mockTradingSummary,
          wallet: state.data.mockTradingWallets.find((wallet) => wallet.id === walletId) || state.data.mockTradingSummary.wallet || null,
        };
      }
      state.data.mockTradingPositionsByAddress = {};
      state.data.mockTradingTradesByAddress = {};
      state.ui.mockTradingTicket = null;
      state.ui.mockTradingHistoryOpen = false;
      state.ui.mockTradingPnlAddress = null;
      setError(null);
      emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      await refreshMockTradingState({ emit: true });
      emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
    },
    async createMockTradingWallet(name: string) {
      const token = getMockTradingAdminToken();
      if (!token || state.ui.busy) {
        return;
      }
      const safeName = String(name || '').trim();
      if (!safeName) {
        setError('Wallet name is required');
        emit('header', 'overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Creating mock wallet...');
      emit('header', 'overlay');
      try {
        const result = await createMockTradingWalletRequest(safeName, token);
        state.ui.activeMockTradingWalletId = result.wallet.id;
        persistMockTradingActiveWalletId(result.wallet.id);
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create mock trading wallet');
      } finally {
        setBusy(false);
        emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    },
    async updateMockTradingWallet(walletId: number, name: string) {
      const token = getMockTradingAdminToken();
      if (!token || state.ui.busy) {
        return;
      }
      const safeName = String(name || '').trim();
      if (!Number.isInteger(walletId) || walletId <= 0 || !safeName) {
        setError('Valid wallet id and name are required');
        emit('header', 'overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Updating mock wallet...');
      emit('header', 'overlay');
      try {
        const result = await updateMockTradingWalletRequest(walletId, safeName, token);
        state.data.mockTradingWallets = state.data.mockTradingWallets.map((wallet) => (
          wallet.id === result.wallet.id ? result.wallet : wallet
        ));
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to update mock trading wallet');
      } finally {
        setBusy(false);
        emit('header', 'overlay');
      }
    },
    async archiveMockTradingWallet(walletId: number) {
      const token = getMockTradingAdminToken();
      if (!token || state.ui.busy) {
        return;
      }
      if (!Number.isInteger(walletId) || walletId <= 0) {
        setError('Valid wallet id is required');
        emit('header', 'overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Archiving mock wallet...');
      emit('header', 'overlay');
      try {
        const result = await archiveMockTradingWalletRequest(walletId, token);
        if (state.ui.activeMockTradingWalletId === result.wallet.id) {
          state.ui.activeMockTradingWalletId = null;
          persistMockTradingActiveWalletId(null);
        }
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to archive mock trading wallet');
      } finally {
        setBusy(false);
        emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    },
    async setDefaultMockTradingWallet(walletId: number) {
      const token = getMockTradingAdminToken();
      if (!token || state.ui.busy) {
        return;
      }
      if (!Number.isInteger(walletId) || walletId <= 0) {
        setError('Valid wallet id is required');
        emit('header', 'overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Updating default mock wallet...');
      emit('header', 'overlay');
      try {
        const result = await setDefaultMockTradingWalletRequest(walletId, token);
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to update default mock trading wallet');
      } finally {
        setBusy(false);
        emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    },
    openMockTradingHistory() {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      if (state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      state.ui.mockTradingHistoryOpen = true;
      state.ui.mockTradingTicket = null;
      state.ui.expandedSparklineAddress = null;
      state.ui.mockTradingPnlAddress = null;
      setError(null);
      emit('overlay');
    },
    closeMockTradingHistory() {
      state.ui.mockTradingHistoryOpen = false;
      emit('overlay');
    },
    openMockTradingPnlResume(address: string) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      if (state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }

      const normalized = String(address || '').trim();
      if (!normalized || !state.data.mockTradingPositionsByAddress[normalized]) {
        return;
      }

      state.ui.mockTradingPnlAddress = normalized;
      state.ui.mockTradingTicket = null;
      state.ui.mockTradingHistoryOpen = false;
      state.ui.expandedSparklineAddress = null;
      setError(null);
      emit('overlay');
    },
    closeMockTradingPnlResume() {
      if (!state.ui.mockTradingPnlAddress) {
        return;
      }
      state.ui.mockTradingPnlAddress = null;
      emit('overlay');
    },
    closeMockTradingTicket() {
      state.ui.mockTradingTicket = null;
      emit('overlay');
    },
    async submitMockTradingBuy(address: string, notionalSol: number, takeProfit?: { targetMcapUsd?: number | null; sellPercent?: number | null }) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      if (state.ui.busy) {
        return;
      }

      const validationError = getMockTradingBuyValidationError(state, notionalSol, takeProfit);
      if (validationError) {
        setError(validationError);
        emit('overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Executing mock buy...');
      emit();
      try {
        const result = await buyMockTradingToken(address, notionalSol, token, takeProfit, state.ui.activeMockTradingWalletId);
        if (result.position) {
          state.data.mockTradingPositionsByAddress[address] = result.position;
        }
        state.ui.mockTradingTicket = null;
        setNotice(result.message);
        void refreshMockTradingState({ emit: true });
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to execute mock buy');
      } finally {
        setBusy(false);
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
      }
    },
    async submitMockTradingSell(address: string, percent: number) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      if (state.ui.busy) {
        return;
      }
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        setError('Mock sell percent must be between 1 and 100');
        emit('overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Executing mock sell...');
      emit();
      try {
        const result = await sellMockTradingToken(address, percent, token, state.ui.activeMockTradingWalletId);
        if (result.position) {
          state.data.mockTradingPositionsByAddress[address] = result.position;
        } else {
          delete state.data.mockTradingPositionsByAddress[address];
          if (state.ui.mockTradingPnlAddress === address) {
            state.ui.mockTradingPnlAddress = null;
          }
        }
        state.ui.mockTradingTicket = null;
        setNotice(result.message);
        void refreshMockTradingState({ emit: true });
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to execute mock sell');
      } finally {
        setBusy(false);
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
      }
    },
    async submitMockTradingSellOrder(address: string, targetMcapUsd: number, sellPercent: number) {
      if (!isMockTradingEnabled(state)) {
        clearMockTradingState();
        setError('Mock trading is disabled');
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
        return;
      }
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      if (state.ui.busy) {
        return;
      }
      if (!Number.isFinite(targetMcapUsd) || targetMcapUsd <= 0) {
        setError('Sell order MCAP must be greater than zero');
        emit('overlay');
        return;
      }
      if (!Number.isFinite(sellPercent) || sellPercent <= 0 || sellPercent > 100) {
        setError('Sell order percent must be between 1 and 100');
        emit('overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Creating mock sell order...');
      emit('overlay');
      try {
        const result = await createMockTradingTakeProfitOrder(address, targetMcapUsd, sellPercent, token, state.ui.activeMockTradingWalletId);
        state.data.mockTradingPositionsByAddress[address] = result.position;
        state.ui.mockTradingTicket = null;
        setNotice(result.message);
        void refreshMockTradingState({ emit: true });
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create mock sell order');
      } finally {
        setBusy(false);
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
      }
    },
    async cancelMockTradingTakeProfitOrder(orderId: number) {
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      if (!Number.isInteger(orderId) || orderId <= 0) {
        setError('Valid sell order id is required');
        emit('overlay');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Cancelling mock sell order...');
      emit('overlay');
      try {
        const result = await cancelMockTradingTakeProfitOrderRequest(orderId, token, state.ui.activeMockTradingWalletId);
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to cancel mock sell order');
      } finally {
        setBusy(false);
        emit('header', 'overlay', 'manual', 'recent', 'old-week', 'monitored');
      }
    },
    async armFloatingQuickBuy(address: string) {
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit('overlay');
        return;
      }

      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) {
        updateFloatingQuickBuyState({
          status: 'error',
          error: 'Token address is required',
          message: null,
        });
        emit('overlay');
        return;
      }
      if (!isValidTokenAddressFormat(normalizedAddress)) {
        updateFloatingQuickBuyState({
          status: 'error',
          address: normalizedAddress,
          error: 'Invalid token address format',
          message: null,
        });
        emit('overlay');
        return;
      }

      state.ui.floatingQuickBuyVisible = true;
      state.ui.floatingQuickBuy = {
        address: normalizedAddress,
        notionalSol: FLOATING_QUICK_BUY_NOTIONAL_SOL,
        status: 'tracking',
        message: 'Adding token to Manual Tokens...',
        error: null,
        armedAt: Date.now(),
        armedCycle: state.runtime.cycle,
        updatedAt: Date.now(),
        executedAt: null,
        lastPriceUsd: null,
        lastMcap: null,
        manualTracked: false,
        buyAttempted: false,
      };
      nextFloatingQuickBuyDashboardRefreshAt = 0;
      setError(null);
      emit('overlay', 'manual', 'header');

      try {
        await addManualTokenForFloatingQuickBuy(normalizedAddress, token);
        if (state.session.token !== token || state.session.role !== 'admin' || state.ui.floatingQuickBuy.address !== normalizedAddress) {
          return;
        }
        if (state.ui.floatingQuickBuy.buyAttempted || state.ui.floatingQuickBuy.status === 'bought') {
          return;
        }
        updateFloatingQuickBuyState({
          status: 'waiting_market',
          manualTracked: true,
          message: 'Waiting for GMGN/catalog MCAP update',
          error: null,
        });
        await executeFloatingQuickBuyIfReady();
      } catch (error) {
        if (state.ui.floatingQuickBuy.address !== normalizedAddress) {
          return;
        }
        updateFloatingQuickBuyState({
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to prepare quick buy token',
          message: null,
        });
      } finally {
        emit('overlay', 'manual', 'monitored', 'header');
      }
    },
    cancelFloatingQuickBuy() {
      if (state.ui.floatingQuickBuy.status === 'idle') {
        return;
      }
      resetFloatingQuickBuyState();
      emit('overlay', 'header');
    },
    openFloatingQuickBuy() {
      if (state.session.role !== 'admin') {
        return;
      }
      state.ui.floatingQuickBuyVisible = true;
      emit('overlay');
    },
    closeFloatingQuickBuy() {
      state.ui.floatingQuickBuyVisible = false;
      emit('overlay');
    },
    async addMockTradingCash() {
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      const rawAmount = typeof window === 'undefined'
        ? ''
        : window.prompt('Add mock SOL amount', '10');
      if (rawAmount == null) {
        return;
      }
      const amountSol = Number(rawAmount);
      if (!Number.isFinite(amountSol) || amountSol <= 0) {
        setError('Mock SOL amount must be greater than zero');
        emit('header');
        return;
      }
      if (!hasUsableMockSolRate(state.data.mockTradingSummary)) {
        setError('SOL/USD price is unavailable');
        emit('header');
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Adding mock SOL...');
      emit('header');
      try {
        const result = await addMockTradingCash(amountSol, token, state.ui.activeMockTradingWalletId);
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to add mock trading cash');
      } finally {
        setBusy(false);
        emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    },
    async resetMockTradingPortfolio() {
      const token = state.session.token;
      if (!token || state.session.role !== 'admin') {
        setError('Admin access required');
        emit();
        return;
      }
      if (typeof window !== 'undefined' && !window.confirm('Reset mock trading portfolio?')) {
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Resetting mock portfolio...');
      emit('header');
      try {
        const result = await resetMockTradingPortfolioRequest(undefined, token, state.ui.activeMockTradingWalletId);
        state.data.mockTradingPositionsByAddress = {};
        state.data.mockTradingTradesByAddress = {};
        await refreshMockTradingState();
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to reset mock trading portfolio');
      } finally {
        setBusy(false);
        emit('header', 'manual', 'recent', 'old-week', 'monitored', 'overlay');
      }
    },
    async removeBlockedToken(address: string, chain: TokenChain = 'solana') {
      const token = state.session.token;
      if (!token) {
        setError('No authenticated session');
        emit();
        return;
      }

      setBusy(true);
      setError(null);
      setNotice('Removing token from blocklist...');
      emit();

      try {
        const result = await removeBlockedTokenRequest(chain, address, token);
        const identityKey = getTrackedTokenKey(address, chain);
        state.data.blocklist = state.data.blocklist.filter((item) => (
          getTrackedTokenKey(item.address, item.chain || 'solana') !== identityKey
        ));
        state.bars.blocklist = state.data.blocklist.length;
        await reloadConfigInternal(token);
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove blocked token');
      } finally {
        setBusy(false);
        emit();
      }
    },
  };
}
