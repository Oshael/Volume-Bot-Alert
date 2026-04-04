import { createAppState, getManualTokens, getMonitoredTokens, type AddressItem, type AlertEntry, type AppState, type AuthPanel, type BidZoneTokenEntry, type BillingOrderEntry, type BillingPlanEntry, type BucketSortCriterion, type BucketSortMode, type BucketSortWindow, type CollapsibleSectionKey, type LateralizedTokenEntry, type LinkedIdentityEntry, type ManualTokenEntry, type MeteoraEntry, type MonitoredSortCriterion, type MonitoredSortMode, type MonitoredSortWindow, type PumpTokenEntry, type RemovalLogEntry, type WorkspaceView } from '../state/app-state';
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
  addManualToken as addManualTokenRequest,
  addBlockedToken as addBlockedTokenRequest,
  fetchConfig,
  patchConfig,
  patchUiPrefs,
  removeManualToken as removeManualTokenRequest,
  removeBlockedToken as removeBlockedTokenRequest,
  syncConfig,
  type ConfigPayload,
  type UiPrefsPayload,
} from '../services/api/config';
import {
  fetchAccountAccess,
  fetchAccountIdentities,
  fetchAccountSecurityIdentities,
  unlinkAccountSecurityIdentity,
  type AccountAccessPayload,
  type AccountIdentitiesPayload,
} from '../services/api/account';
import { createBillingOrder, fetchBillingState, fetchPublicBillingPlans, type BillingStatePayload, type PublicBillingPlansPayload } from '../services/api/billing';
import { completePreAccessSession, createPreAccessOrder, fetchPreAccessBillingState, fetchPreAccessMe, logoutPreAccessSession, type PreAccessBillingStatePayload } from '../services/api/pre-access';
import { adminBlockToken as adminBlockTokenRequest, fetchBidZoneCandidates, fetchDashboardMonitored, fetchLateralizedCandidates, fetchPumpfunTokenMeta, reportMigratedToken, trackManualToken, type BidZonePayload, type DashboardMonitoredToken, type LateralizedPayload } from '../services/api/catalog';
import { clearLegacyAuthToken } from '../utils/auth-storage';
import { loadSoundSettings, saveSoundSettings } from '../utils/sound-storage';
import {
  loadAlerts,
  loadDismissedOldWeek,
  loadDismissedRecent,
  loadOldWeekRemovalLog,
  loadRecentRemovalLog,
  saveAlerts,
  saveDismissedOldWeek,
  saveDismissedRecent,
  saveOldWeekRemovalLog,
  saveRecentRemovalLog,
} from '../utils/bar-storage';
import { bindSocketLifecycle, disconnectSocket, subscribePumpMint, unsubscribePumpMint } from '../services/socket/client';
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
import { trimLoginEmailValue } from '../ui/sections/login-form-utils';
import {
  findPreviousPasswordMatch,
  formatPasswordChangedDate,
  rememberPreviousPassword,
} from '../utils/password-history';

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

const STANDARD_ALERT_COOLDOWN_MS = 60_000;
const SURGE_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const OLD_WEEK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HVNC_MAX_AGE_MS = 30 * 60 * 1000;
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
const UPTIME_REFRESH_INTERVAL_MS = 30 * 1000;
const OLD_SURGE_SESSION_DELTA_PCT = 50;
const REPEAT_LOCAL_ALERT_STEP_PCT = 40;
const CROSS_ALERT_BLOCK_MS = 5 * 60 * 1000;
const PUMP_IMAGE_TIMEOUT_MS = 5000;
const MONITORED_REFRESH_INTERVAL_MS = 3 * 1000;
const LATERALIZED_REFRESH_INTERVAL_MS = 60 * 1000;
const LATERALIZED_PANEL_LIMIT = 24;
const BID_ZONE_REFRESH_INTERVAL_MS = 60 * 1000;
const BID_ZONE_PANEL_LIMIT = 24;
const METEORA_ALERT_MIN_TVL = 10000;
const COLD_FIELD_RECHECK_MS = 10 * 60 * 1000;
const ALERT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const HISTORY_SYNC_CHANNEL_NAME = 'trendscope-history-sync';
const HISTORY_SYNC_HEARTBEAT_MS = 2000;
const HISTORY_SYNC_PEER_TTL_MS = 6000;

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
  generatedAt: string | null;
  tokens: DashboardMonitoredToken[];
  ts: number;
};

type HistorySyncLateralizedSnapshotMessage = {
  type: 'lateralized-snapshot';
  tabId: string;
  payload: LateralizedPayload;
  ts: number;
};

type HistorySyncBidZoneSnapshotMessage = {
  type: 'bid-zone-snapshot';
  tabId: string;
  payload: BidZonePayload;
  ts: number;
};

type HistorySyncMessage =
  | HistorySyncPresenceMessage
  | HistorySyncClosingMessage
  | HistorySyncMonitoredSnapshotMessage
  | HistorySyncLateralizedSnapshotMessage
  | HistorySyncBidZoneSnapshotMessage;

type HistoryPeerState = {
  workspace: WorkspaceView;
  authenticated: boolean;
  monitoringActive: boolean;
  seenAt: number;
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
  'priceUsd',
  'volume5m',
  'volume1h',
  'volume6h',
  'volume24h',
  'priceChange1h',
  'priceChange6h',
  'priceChange24h',
  'mcapDelta',
  'prevMcap',
  'prevVolume5mCanonical',
] as const;

const TRACKED_ALERT_PRESERVED_KEYS = [
  'lastAlertAt',
  '_hvncFired',
  '_oldSurgeFired',
  '_meteoraSurgeFired',
  '_oldSurgeSessionBase1h',
  '_oldSurgeSessionBase6h',
  '_lastVolAlertPct',
  '_lastMcapAlertPct',
  '_lastAlertKind',
] as const;
export interface AppController {
  state: AppState;
  init(): Promise<void>;
  login(email: string, password: string): Promise<void>;
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
  startSocialLink(provider: 'google' | 'discord'): void;
  startSocialLogin(provider: 'google' | 'discord'): void;
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
  addManualToken(address: string, label?: string | null): Promise<void>;
  removeManualToken(address: string): Promise<void>;
  addBlockedToken(address: string, label?: string | null): Promise<void>;
  adminBlockToken(address: string, label?: string | null): Promise<void>;
  removeBlockedToken(address: string): Promise<void>;
  removePumpToken(mint: string): void;
  dismissRecentToken(address: string): void;
  dismissOldWeekToken(address: string): void;
  clearAllAlerts(): void;
  removeAlert(id: string): void;
  clearRecentRemovalLog(): void;
  clearOldWeekRemovalLog(): void;
  clearDismissedRecent(): void;
  clearDismissedOldWeek(): void;
  toggleSectionCollapsed(section: CollapsibleSectionKey): void;
  setAlertSearchQuery(query: string): void;
  setMonitoredSearchQuery(query: string): void;
  setManualSearchQuery(query: string): void;
  setRecentSearchQuery(query: string): void;
  setOldWeekSearchQuery(query: string): void;
  setManualStarredOnly(enabled: boolean): void;
  setRecentStarredOnly(enabled: boolean): void;
  setOldWeekStarredOnly(enabled: boolean): void;
  setMonitoredPage(page: number): void;
  setRecentPage(page: number): void;
  setOldWeekPage(page: number): void;
  setMonitoredPerPage(perPage: number): void;
  setRecentPerPage(perPage: number): void;
  setOldWeekPerPage(perPage: number): void;
  setManualSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setRecentSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow): void;
  setEnabledTradeTerminals(terminals: AppState['ui']['enabledTradeTerminals']): void;
  setSoundEnabled(enabled: boolean): void;
  setSoundVolume(volume: number): void;
  toggleStarredToken(address: string): Promise<void>;
  setWorkspace(workspace: WorkspaceView): void;
  syncWorkspaceFromLocation(): void;
  startMonitoring(): void;
  stopMonitoring(): void;
  clearNotice(): void;
  clearError(): void;
  subscribe(listener: (state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) => void): () => void;
}

export type AppRenderRegion =
  | 'all'
  | 'header'
  | 'toasts'
  | 'legacy'
  | 'manual'
  | 'recent'
  | 'old-week'
  | 'monitored'
  | 'lateralized'
  | 'bid-zone'
  | 'pumpfun'
  | 'alerts'
  | 'overlay';

function isAuthRoutePath(pathname: string) {
  return pathname === '/auth/verify-email' || pathname === '/auth/reset-password';
}

function isLoginRoutePath(pathname: string | null | undefined) {
  return String(pathname || '').trim().toLowerCase() === '/login';
}

function isPublicLandingRoutePath(pathname: string | null | undefined) {
  return String(pathname || '').trim().toLowerCase() === '/';
}

function isAccountSecurityRoutePath(pathname: string | null | undefined) {
  const value = String(pathname || '').trim().toLowerCase();
  return value === '/account-security' || value.startsWith('/account-security/');
}

function hasAuthRouteIntent(locationLike: Location | null | undefined) {
  if (!locationLike) {
    return false;
  }

  const pathname = String(locationLike.pathname || '/');
  if (isAuthRoutePath(pathname)) {
    return true;
  }

  const search = new URLSearchParams(locationLike.search || '');
  const rawMode = String(search.get('mode') || '').trim().toLowerCase();
  return rawMode === 'verify-email' || rawMode === 'reset-password';
}

function isPreAccessRoutePath(pathname: string | null | undefined) {
  const value = String(pathname || '').trim().toLowerCase();
  return value === '/access' || value.startsWith('/access/');
}

function getLoginPanelIntent(locationLike: Location | null | undefined) {
  if (!locationLike || !isLoginRoutePath(locationLike.pathname)) {
    return '';
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

  const pathname = String(locationLike.pathname || '/');
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

function resolveWorkspaceFromPath(pathname: string | null | undefined): WorkspaceView {
  const value = String(pathname || '').trim().toLowerCase();
  if (
    value === '/monitor'
    || value.startsWith('/monitor/')
    || value === '/workspace/history'
    || value.startsWith('/workspace/history/')
  ) {
    return 'history';
  }
  return 'live';
}

export function createAppController(): AppController {
  const state = createAppState();
  if (typeof window !== 'undefined' && !isAuthRoutePath(window.location.pathname || '/') && !isPreAccessRoutePath(window.location.pathname || '/')) {
    state.ui.workspace = resolveWorkspaceFromPath(window.location.pathname);
  }
  clearLegacyAuthToken();
  const listeners = new Set<(state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) => void>();
  hydrateSoundSettings();
  let authSubmitInFlight = false;
  let monitoringInterval: ReturnType<typeof setInterval> | null = null;
  let uptimeInterval: ReturnType<typeof setInterval> | null = null;
  let pumpGcInterval: ReturnType<typeof setInterval> | null = null;
  let monitoringPausedForAuthPanel = false;
  let monitoredRefreshInFlight = false;
  let lateralizedRefreshInFlight = false;
  let bidZoneRefreshInFlight = false;
  let startedAt: number | null = null;
  let starredPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let starredPersistRevision = 0;
  let uiPrefsPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let uiPrefsPersistRevision = 0;
  let emitScheduled = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let preAccessPollingTimer: ReturnType<typeof setTimeout> | null = null;
  let socialLinkPopupWindow: Window | null = null;
  let socialLinkSyncTimer: ReturnType<typeof setInterval> | null = null;
  let socialLinkSyncStartedAt = 0;
  let socialLinkPendingProvider: 'google' | 'discord' | null = null;
  let nextColdFieldRefreshAt = 0;
  let nextLateralizedRefreshAt = 0;
  let nextBidZoneRefreshAt = 0;
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
  const pendingDirtyRegions = new Set<AppRenderRegion>(['all']);
  const COLLAPSIBLE_SECTION_TO_RENDER_REGION: Record<CollapsibleSectionKey, AppRenderRegion> = {
    manual: 'manual',
    recent: 'recent',
    oldWeek: 'old-week',
    monitored: 'monitored',
    lateralized: 'lateralized',
    bidZone: 'bid-zone',
    pumpfun: 'pumpfun',
  };

  function stopSocialLinkSync() {
    if (socialLinkSyncTimer) {
      clearInterval(socialLinkSyncTimer);
      socialLinkSyncTimer = null;
    }
    socialLinkSyncStartedAt = 0;
    socialLinkPendingProvider = null;
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

  function shouldRunFrontendAlerts() {
    return isLiveWorkspace();
  }

  function shouldRunPumpfunRuntime() {
    return isLiveWorkspace();
  }

  function shouldRunLateralizedRuntime() {
    return isHistoryWorkspace();
  }

  function isAuthenticatedSession() {
    return state.session.status === 'authenticated';
  }

  function isActiveHistorySyncCandidate() {
    return isAuthenticatedSession()
      && isHistoryWorkspace()
      && state.runtime.mode === 'active';
  }

  function shouldUseHistorySyncChannel() {
    return typeof BroadcastChannel !== 'undefined';
  }

  function isHistorySyncLeader() {
    if (!isHistoryWorkspace()) {
      return true;
    }
    if (!shouldUseHistorySyncChannel()) {
      return true;
    }
    return historySyncLeaderTabId === null || historySyncLeaderTabId === historySyncTabId;
  }

  function shouldRunLocalMonitoringPolling() {
    if (state.runtime.mode !== 'active') {
      return false;
    }
    if (isLiveWorkspace()) {
      return true;
    }
    if (isHistoryWorkspace()) {
      return isHistorySyncLeader();
    }
    return true;
  }

  function hasCriticalColdFieldGap(token: ManualTokenEntry | undefined) {
    if (!token) {
      return true;
    }

    const hasCreatedAt = typeof token.createdAt === 'number' && token.createdAt > 0;
    return !token.symbol || !token.pairUrl || !hasCreatedAt;
  }

  function replaceTrackedTokenReferences(address: string, nextToken: ManualTokenEntry) {
    state.data.trackedTokensByAddress[address] = nextToken;
  }

  function refreshTrackedTokenStore() {
    const activeAddresses = new Set(state.data.monitoredTokenAddresses);
    for (const address of Object.keys(state.data.trackedTokensByAddress)) {
      if (!activeAddresses.has(address)) {
        delete state.data.trackedTokensByAddress[address];
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

    return {
      mintAddress: firstDefinedTrackedValue(existingItem?.mintAddress, dashboardItem?.address, base.address),
      pairAddress: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.pairAddress, existingItem?.pairAddress, base.pairAddress),
      pairUrl: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.pairUrl, existingItem?.pairUrl, base.pairUrl),
      imageUrl: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.imageUrl, existingItem?.imageUrl, base.imageUrl),
      twitterUrl: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.twitterUrl, existingItem?.twitterUrl, base.twitterUrl),
      symbol: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.symbol, existingItem?.symbol, base.symbol),
      name: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.name, existingItem?.name, base.name),
      createdAt: selectTrackedColdField(shouldApplyColdFields, dashboardItem?.tokenCreatedAt, existingItem?.createdAt, base.createdAt),
    };
  }

  function buildMergedTrackedMarketFields(
    existingItem: ManualTokenEntry | undefined,
    dashboardItem: DashboardMonitoredToken | undefined,
    base: ManualTokenEntry,
  ) {
    const nextFields: Partial<ManualTokenEntry> = {};

    for (const key of TRACKED_MARKET_FIELD_KEYS) {
      nextFields[key] = firstDefinedTrackedValue(
        dashboardItem?.[key],
        existingItem?.[key],
        base[key],
      );
    }

    nextFields.prevVolume5m = existingItem?.volume5m != null
      ? existingItem.volume5m
      : firstDefinedTrackedValue(existingItem?.prevVolume5m, base.prevVolume5m);

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
    alertCandidates: Set<string>;
    coldRefreshDue: boolean;
    now: number;
  }) {
    if (input.coldRefreshDue) {
      nextColdFieldRefreshAt = input.now + COLD_FIELD_RECHECK_MS;
    }

    state.data.trackedTokensByAddress = input.nextTrackedStore;
    state.data.manualTokenAddresses = input.manualTokens.map((item) => item.address);
    state.data.monitoredTokenAddresses = [...input.monitoredMap.keys()];
    state.data.recentTokenAddresses = [];
    state.data.oldWeekTokenAddresses = [];
    state.bars.manual = state.data.manualTokenAddresses.length;
    deriveAgeBuckets();

    if (state.runtime.mode === 'active' && shouldRunFrontendAlerts() && input.alertCandidates.size > 0) {
      for (const token of getMonitoredTokens(state)) {
        if (!input.alertCandidates.has(token.address)) continue;
        maybeFireSpecialAlerts(token);
        maybeFireLocalAlert(token);
      }
    }

    refreshMonitoredPanelCounts();
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

    const candidates = [historySyncTabId]
      .filter(() => isActiveHistorySyncCandidate());

    for (const [tabId, peer] of historySyncPeers) {
      if (peer.authenticated && peer.monitoringActive && peer.workspace === 'history') {
        candidates.push(tabId);
      }
    }

    historySyncLeaderTabId = candidates.length > 0
      ? candidates.sort((a, b) => a.localeCompare(b))[0] || null
      : null;

    if (state.runtime.mode === 'active' && isHistoryWorkspace() && previousLeader !== historySyncLeaderTabId) {
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
      monitoringActive: state.runtime.mode === 'active',
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

  function setBusy(busy: boolean) {
    state.ui.busy = busy;
  }

  function setError(error: string | null) {
    state.ui.error = error;
  }

  function setNotice(notice: string | null) {
    state.ui.notice = notice;
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
    if (pathname === '/auth/verify-email' || pathname === '/auth/reset-password' || search.has('mode') || search.has('token')) {
      window.history.replaceState({}, document.title, '/login');
    }
  }

  function clearLoginPanelUrl() {
    if (typeof window === 'undefined' || !isLoginRoutePath(window.location.pathname)) {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has('panel')) {
      return;
    }

    url.searchParams.delete('panel');
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl || '/login');
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

    const url = new URL('/login', window.location.origin);
    if (panel === 'register') {
      url.searchParams.set('panel', 'register');
    }

    const nextPath = `${url.pathname}${url.search}${url.hash}`;
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
      if (loginPanelIntent === 'register') {
        state.ui.authPanel = 'register';
      } else if (isLoginRoutePath(pathname) && state.ui.authPanel === 'register') {
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

  function syncWorkspaceFromLocationInternal(options?: { canonicalize?: boolean }) {
    if (typeof window === 'undefined') {
      return;
    }

    const pathname = window.location.pathname || '/';
    if (isAuthRoutePath(pathname) || isPreAccessRoutePath(pathname)) {
      return;
    }

    const nextWorkspace = resolveWorkspaceFromPath(pathname);
    const changed = state.ui.workspace !== nextWorkspace;
    state.ui.workspace = nextWorkspace;

    if (options?.canonicalize) {
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
      lateralized: false,
      bidZone: false,
      pumpfun: false,
    };
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

  function buildUiPrefsPayload(): UiPrefsPayload {
    return {
      collapsed: {
        manual: Boolean(state.ui.collapsed.manual),
        recent: Boolean(state.ui.collapsed.recent),
        oldWeek: Boolean(state.ui.collapsed.oldWeek),
        monitored: Boolean(state.ui.collapsed.monitored),
        lateralized: Boolean(state.ui.collapsed.lateralized),
        bidZone: Boolean(state.ui.collapsed.bidZone),
        pumpfun: Boolean(state.ui.collapsed.pumpfun),
      },
      manualStarredOnly: Boolean(state.ui.manualStarredOnly),
      recentStarredOnly: Boolean(state.ui.recentStarredOnly),
      oldWeekStarredOnly: Boolean(state.ui.oldWeekStarredOnly),
      monitoredPerPage: normalizeUiPerPage(state.ui.monitoredPerPage, 30),
      recentPerPage: normalizeUiPerPage(state.ui.recentPerPage, 30),
      oldWeekPerPage: normalizeUiPerPage(state.ui.oldWeekPerPage, 30),
      manualSorts: [...state.ui.manualSorts],
      recentSorts: [...state.ui.recentSorts],
      oldWeekSorts: [...state.ui.oldWeekSorts],
      monitoredSorts: [...state.ui.monitoredSorts],
      enabledTradeTerminals: [...state.ui.enabledTradeTerminals],
    };
  }
  function getConfigNumber(key: string, fallback: number) {
    const value = state.data.configs[key];
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function isConfigEnabled(key: string, fallback = true) {
    return String(state.data.configs[key] ?? (fallback ? 'on' : 'off')) !== 'off';
  }

  function getOldAlert1hThreshold() {
    return getConfigNumber('old-alert-1h-threshold', 50);
  }

  function getOldAlert6hThreshold() {
    return getConfigNumber('old-alert-6h-threshold', 150);
  }

  function isAlertKindEnabled(kind: AlertEntry['kind']) {
    switch (kind) {
      case 'monitored-vol':
        return isConfigEnabled('alert-vol-enabled');
      case 'monitored-mcap':
        return isConfigEnabled('alert-mcap-enabled');
      case 'hvnc':
        return isConfigEnabled('alert-hvnc-enabled');
      case 'meteora-surge':
        return isConfigEnabled('alert-meteora-surge-enabled');
      case 'pumpfun-vol':
        return isConfigEnabled('alert-pumpfun-vol-enabled');
      case 'pumpfun-hvnc':
        return isConfigEnabled('alert-pumpfun-hvnc-enabled');
      default:
        return true;
    }
  }

  function isAlertEntryEnabled(entry: Pick<AlertEntry, 'kind' | 'surgeWindow'>) {
    if (entry.kind === 'old-surge') {
      return isConfigEnabled(entry.surgeWindow === '6H' ? 'alert-old-surge-6h-enabled' : 'alert-old-surge-1h-enabled');
    }

    return isAlertKindEnabled(entry.kind);
  }

  function isCrossAlertBlocked(token: ManualTokenEntry, now: number) {
    return Boolean(token.lastAlertAt && now - token.lastAlertAt < CROSS_ALERT_BLOCK_MS);
  }

  function getStorageScope() {
    return state.session.email || state.session.username || 'anonymous';
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

  async function persistStarredTokens(snapshot: string[], revision: number) {
    const token = state.session.token;
    if (!token) {
      return;
    }

    try {
      const result = await syncConfig({
        starredTokens: snapshot.map((address) => ({ address })),
      }, token);

      if (revision == starredPersistRevision) {
        state.data.configs = result.configs || {};
        applyUiPreferencesFromConfigs();
        state.data.starredTokens = result.starredTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
        emit();
      }
    } catch (error) {
      if (revision == starredPersistRevision) {
        setError(error instanceof Error ? error.message : 'Failed to sync starred tokens');
        emit();
      }
    }
  }

  function queueStarredTokensPersist() {
    starredPersistRevision += 1;
    const revision = starredPersistRevision;
    const snapshot = [...state.data.starredTokens];

    if (starredPersistTimer) {
      clearTimeout(starredPersistTimer);
    }

    starredPersistTimer = setTimeout(() => {
      starredPersistTimer = null;
      void persistStarredTokens(snapshot, revision);
    }, 120);
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

  function applyUiPreferences(uiPrefs?: Partial<UiPrefsPayload> | null) {
    const defaults = getDefaultCollapsedSections();
    const collapsed = uiPrefs?.collapsed || defaults;
    state.ui.collapsed = {
      ...defaults,
      manual: Boolean(collapsed.manual),
      recent: Boolean(collapsed.recent),
      oldWeek: Boolean(collapsed.oldWeek),
      monitored: Boolean(collapsed.monitored),
      lateralized: Boolean(collapsed.lateralized),
      bidZone: Boolean(collapsed.bidZone),
      pumpfun: Boolean(collapsed.pumpfun),
    };

    state.ui.manualStarredOnly = Boolean(uiPrefs?.manualStarredOnly);
    state.ui.recentStarredOnly = Boolean(uiPrefs?.recentStarredOnly);
    state.ui.oldWeekStarredOnly = Boolean(uiPrefs?.oldWeekStarredOnly);

    state.ui.monitoredPerPage = normalizeUiPerPage(uiPrefs?.monitoredPerPage, 30);
    state.ui.recentPerPage = normalizeUiPerPage(
      uiPrefs?.recentPerPage,
      getConfigNumber('old-per-page', state.ui.recentPerPage || 30),
    );
    state.ui.oldWeekPerPage = normalizeUiPerPage(
      uiPrefs?.oldWeekPerPage,
      getConfigNumber('old-week-per-page', state.ui.oldWeekPerPage || 30),
    );

    state.ui.manualSorts = normalizeBucketSorts(uiPrefs?.manualSorts, 'manual');
    state.ui.recentSorts = normalizeBucketSorts(uiPrefs?.recentSorts, 'recent');
    state.ui.oldWeekSorts = normalizeBucketSorts(uiPrefs?.oldWeekSorts, 'old-week');
    state.ui.monitoredSorts = normalizeMonitoredSorts(uiPrefs?.monitoredSorts);
    state.ui.enabledTradeTerminals = normalizeTradeTerminals(uiPrefs?.enabledTradeTerminals);
    syncRoutedPagination();
  }

  function applyUiPreferencesFromConfigs() {
    state.ui.soundEnabled = String(state.data.configs['sound-mode'] ?? 'on') !== 'off';
    state.ui.soundVolume = clampUiVolume(getConfigNumber('sound-volume', Math.round(state.ui.soundVolume * 100)) / 100);
  }
  function persistBarStorage() {
    const scope = getStorageScope();
    saveDismissedRecent(scope, state.data.dismissedRecent);
    saveDismissedOldWeek(scope, state.data.dismissedOldWeek);
    saveRecentRemovalLog(scope, state.data.recentRemovalLog);
    saveOldWeekRemovalLog(scope, state.data.oldWeekRemovalLog);
    saveAlerts(scope, state.data.alerts);
  }

  function hydrateBarStorage() {
    const scope = getStorageScope();
    state.data.dismissedRecent = loadDismissedRecent(scope);
    state.data.dismissedOldWeek = loadDismissedOldWeek(scope);
    state.data.recentRemovalLog = loadRecentRemovalLog(scope);
    state.data.oldWeekRemovalLog = loadOldWeekRemovalLog(scope);
    state.data.alerts = loadAlerts(scope);
    state.runtime.alerts = state.data.alerts.length;
    state.panels.alerts = state.data.alerts.length;
  }

  function isBlocked(address: string) {
    return state.data.blocklist.some((item) => item.address === address);
  }

  function syncAlertState() {
    state.runtime.alerts = state.data.alerts.length;
    state.panels.alerts = state.data.alerts.length;
    persistBarStorage();
  }

  function removeAlertsForAddress(address: string) {
    state.data.alerts = state.data.alerts.filter((item) => item.address !== address);
    syncAlertState();
  }

  function removeTokenEverywhere(address: string, options: { removeFromStarred?: boolean } = {}) {
    state.data.monitoredTokenAddresses = state.data.monitoredTokenAddresses.filter((item) => item !== address);
    state.data.manualTokenAddresses = state.data.manualTokenAddresses.filter((item) => item !== address);
    state.data.recentTokenAddresses = state.data.recentTokenAddresses.filter((item) => item !== address);
    state.data.oldWeekTokenAddresses = state.data.oldWeekTokenAddresses.filter((item) => item !== address);
    delete state.data.trackedTokensByAddress[address];
    state.data.eligibleCatalogTokens = state.data.eligibleCatalogTokens.filter((item) => item !== address);
    state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== address && item.mintAddress !== address);
    state.data.recentPumpMigrations = state.data.recentPumpMigrations.filter((item) => item.mint !== address);
    state.data.dismissedRecent = state.data.dismissedRecent.filter((item) => item !== address);
    state.data.dismissedOldWeek = state.data.dismissedOldWeek.filter((item) => item !== address);
    removeAlertsForAddress(address);

    if (options.removeFromStarred && state.data.starredTokens.includes(address)) {
      state.data.starredTokens = state.data.starredTokens.filter((item) => item !== address);
      queueStarredTokensPersist();
    }

    state.configSummary.manualTokens = state.data.manualTokenAddresses.length;
    state.bars.manual = state.data.manualTokenAddresses.length;
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
    state.panels.lateralized = state.data.lateralizedTokens.length;
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
    return [{ mode: 'vol', window: '24h' }];
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

  function getPumpConfigNumber(key: string, fallback: number) {
    return getConfigNumber(key, fallback);
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
    const entryVol = getPumpConfigNumber('pump-entry-vol', 3000);
    const maxAgeMin = getPumpConfigNumber('pump-max-age-min', 0);
    const now = Date.now();
    return state.data.pumpTokens.filter((item) => {
      if (item._migrated || isBlocked(item.mint) || state.data.dismissedPump.includes(item.mint)) {
        return false;
      }
      const vol5m = getPumpVolume5mTotal(item);
      if (!(vol5m >= entryVol) || item.hidden) {
        return false;
      }
      if (maxAgeMin > 0 && item.createdAt) {
        const ageMinutes = (now - item.createdAt) / 60000;
        if (ageMinutes > maxAgeMin) {
          return false;
        }
      }
      return true;
    });
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
    state.data.configs['pump-bond-mcap'] = Math.round(nextTarget);
    void persistUiConfigs({ 'pump-bond-mcap': Math.round(nextTarget) });
  }

  function dismissPumpToast(id: string) {
    state.data.pumpToasts = state.data.pumpToasts.filter((item) => item.id !== id);
  }

  function shouldSurfacePumpMigration(token: Pick<PumpTokenEntry, 'mcap'>) {
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
    }, ...state.data.pumpToasts].slice(0, 6);
    window.setTimeout(() => {
      dismissPumpToast(toastId);
      emit();
    }, PUMP_TOAST_TTL_MS);
  }

  function hasRecordedPumpMigration(mint: string) {
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

  function buildPumpMigrationTokenFromPayload(payload: Record<string, unknown>, existingToken?: PumpTokenEntry | null): PumpTokenEntry | null {
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
      emit('pumpfun', 'toasts');
    } catch (_) {
      // Keep fallback placeholders when metadata lookup fails.
    } finally {
      resolvingPumpMigrationMetadata.delete(mint);
    }
  }

  function reportPumpMigration(token: PumpTokenEntry) {
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

  function buildPumpAlertEntry(
    token: PumpTokenEntry,
    kind: 'pumpfun-hvnc' | 'pumpfun-vol',
    label: 'PUMP HVNC' | 'PUMP VOL',
    vol5m: number,
    symbol: string,
  ): AlertEntry {
    return {
      id: `${token.mint}-${Date.now()}-${kind === 'pumpfun-hvnc' ? 'pump-hvnc' : 'pump-vol'}`,
      kind,
      address: token.mint,
      symbol,
      name: token.name || null,
      imageUrl: token.imageUrl || null,
      twitterUrl: token.twitterUrl || null,
      pairUrl: token.pairUrl || null,
      createdAt: Date.now(),
      tokenCreatedAt: token.createdAt ?? null,
      volume5m: vol5m,
      volume1h: null,
      volume6h: null,
      volume24h: token.volTotal ?? null,
      prevMcap: null,
      mcap: token.mcap ?? null,
      pct: 0,
      label,
      isHvnc: kind === 'pumpfun-hvnc',
    };
  }

  function shouldFirePumpHvncAlert(
    token: PumpTokenEntry,
    vol5m: number,
    hvncMinVol: number,
    ageMs: number,
  ) {
    return isAlertKindEnabled('pumpfun-hvnc')
      && !token._hvncPumpFired
      && hvncMinVol > 0
      && ageMs < HVNC_MAX_AGE_MS
      && vol5m >= hvncMinVol;
  }

  function shouldFirePumpVolumeAlert(token: PumpTokenEntry, vol5m: number, minVol: number) {
    return isAlertKindEnabled('pumpfun-vol')
      && vol5m >= minVol
      && !token._alertFired;
  }

  function maybeFirePumpAlert(token: PumpTokenEntry) {
    const vol5m = getPumpVolume5mTotal(token);
    const minVol = getPumpConfigNumber('pump-min-vol', 100000);
    const hvncMinVol = getConfigNumber('hvnc-min-vol', 300000);
    const ageMs = token.createdAt ? Date.now() - token.createdAt : Number.POSITIVE_INFINITY;
    const symbol = token.symbol || token.mint.slice(0, 6);

    if (shouldFirePumpHvncAlert(token, vol5m, hvncMinVol, ageMs)) {
      token._hvncPumpFired = true;
      pushAlert(buildPumpAlertEntry(token, 'pumpfun-hvnc', 'PUMP HVNC', vol5m, symbol));
      return;
    }

    if (shouldFirePumpVolumeAlert(token, vol5m, minVol)) {
      token._alertFired = true;
      pushAlert(buildPumpAlertEntry(token, 'pumpfun-vol', 'PUMP VOL', vol5m, symbol));
    }
  }

  async function resolvePumpTokenImage(mint: string) {
    const token = state.data.pumpTokens.find((item) => item.mint === mint);
    const sessionToken = state.session.token;
    if (!token || !sessionToken || token.imageUrl || token._imageResolved || token._imageResolving) {
      return;
    }

    token._imageResolving = true;
    emit();

    try {
      const timeout = window.setTimeout(() => {
        state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
          ? { ...item, _imageResolved: true, _imageResolving: false }
          : item);
        emit();
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
        emit();
      } finally {
        clearTimeout(timeout);
      }
    } catch (_) {
      // Keep the placeholder avatar if runtime image resolution fails.
    } finally {
      state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
        ? { ...item, _imageResolved: true, _imageResolving: false }
        : item);
      emit();
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

  function createOrUpdatePumpToken(raw: Record<string, unknown>, mode: 'new' | 'trade') {
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
  function logRemoval(target: 'recent' | 'oldWeek', token: ManualTokenEntry, reason: string) {
    const entry: RemovalLogEntry = {
      address: token.address,
      symbol: token.symbol || token.label || token.address.slice(0, 8),
      imageUrl: token.imageUrl || null,
      pairUrl: token.pairUrl || null,
      mcap: token.mcap ?? null,
      reason,
      ts: Date.now(),
    };

    if (target === 'recent') {
      state.data.recentRemovalLog = [entry, ...state.data.recentRemovalLog].slice(0, 100);
    } else {
      state.data.oldWeekRemovalLog = [entry, ...state.data.oldWeekRemovalLog].slice(0, 100);
    }
    persistBarStorage();
  }

  function clampPage(page: number, totalItems: number, perPage: number) {
    const safePerPage = Math.max(10, Math.floor(perPage) || 30);
    const totalPages = Math.max(1, Math.ceil(totalItems / safePerPage));
    return Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  }

  function getRoutedEligibilityContext(now = Date.now()) {
    return {
      now,
      recentMin: getConfigNumber('old-mcap-min', 120000),
      recentMax: getConfigNumber('old-mcap-max', 100000000),
      oldWeekMin: getConfigNumber('old-week-mcap-min', 120000),
      oldWeekMax: getConfigNumber('old-week-mcap-max', 100000000),
      recentDismissed: new Set(state.data.dismissedRecent),
      oldWeekDismissed: new Set(state.data.dismissedOldWeek),
    };
  }

  function isRecentEligible(
    token: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
    options: { preserveWithoutMcap?: boolean } = {},
  ) {
    if (token._userManual || isBlocked(token.address) || context.recentDismissed.has(token.address)) {
      return false;
    }
    if (!(typeof token.createdAt === 'number' && token.createdAt > 0)) {
      return false;
    }

    const age = context.now - token.createdAt;
    if (!(age >= 0 && age < OLD_WEEK_MIN_AGE_MS)) {
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
    if (token._userManual || isBlocked(token.address) || context.oldWeekDismissed.has(token.address)) {
      return false;
    }
    if (!(typeof token.createdAt === 'number' && token.createdAt > 0)) {
      return false;
    }

    const age = context.now - token.createdAt;
    if (age < OLD_WEEK_MIN_AGE_MS) {
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

  function syncMonitoredPagination() {
    state.ui.monitoredPage = clampPage(state.ui.monitoredPage, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
  }

  function syncRoutedPagination() {
    syncMonitoredPagination();
    state.ui.recentPage = clampPage(state.ui.recentPage, state.data.recentTokenAddresses.length, state.ui.recentPerPage);
    state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, state.data.oldWeekTokenAddresses.length, state.ui.oldWeekPerPage);
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

  function maybeLogRecentRemoval(
    item: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
    routedState: ReturnType<typeof deriveRoutedTokenState>,
  ) {
    if (routedState.nextRecent || !routedState.wasRecent || context.recentDismissed.has(item.address)) {
      return;
    }

    const age = context.now - (item.createdAt || 0);
    const mcap = item.mcap ?? 0;
    const reason = age >= OLD_WEEK_MIN_AGE_MS
      ? 'aged into Old Tokens 1 Week+'
      : age < 0
        ? 'age not yet valid for Recent'
        : mcap > 0 && (mcap < context.recentMin || (context.recentMax > 0 && mcap > context.recentMax))
          ? 'MCAP out of Recent range'
          : 'left Recent routing';
    logRemoval('recent', item, reason);
  }

  function maybeLogOldWeekRemoval(
    item: ManualTokenEntry,
    context: ReturnType<typeof getRoutedEligibilityContext>,
    routedState: ReturnType<typeof deriveRoutedTokenState>,
  ) {
    if (routedState.nextOldWeek || !routedState.wasOldWeek || context.oldWeekDismissed.has(item.address)) {
      return;
    }

    const age = context.now - (item.createdAt || 0);
    const mcap = item.mcap ?? 0;
    const reason = age < OLD_WEEK_MIN_AGE_MS
      ? 'age no longer in Old Week bucket'
      : mcap > 0 && (mcap < context.oldWeekMin || (context.oldWeekMax > 0 && mcap > context.oldWeekMax))
        ? 'MCAP out of Old Week range'
        : 'left Old Week routing';
    logRemoval('oldWeek', item, reason);
  }

  function finalizeAgeBucketState(
    deriveRecentList: boolean,
    deriveOldWeekList: boolean,
    nextRecentAddresses: string[],
    nextOldWeekAddresses: string[],
  ) {
    state.data.recentTokenAddresses = deriveRecentList ? nextRecentAddresses : [];
    state.data.oldWeekTokenAddresses = deriveOldWeekList ? nextOldWeekAddresses : [];
    refreshTrackedTokenStore();
    state.bars.recent = getMonitoredTokens(state).filter((item) => item._isRecentRouted).length;
    state.bars.oldWeek = getMonitoredTokens(state).filter((item) => item._isOldWeekRouted).length;
    syncRoutedPagination();
  }

  function deriveAgeBuckets(options?: { forceRecentList?: boolean; forceOldWeekList?: boolean }) {
    const context = getRoutedEligibilityContext();
    const deriveRecentList = shouldDeriveRecentList(options);
    const deriveOldWeekList = shouldDeriveOldWeekList(options);
    const nextRecentAddresses: string[] = [];
    const nextOldWeekAddresses: string[] = [];

    for (const item of getMonitoredTokens(state)) {
      const routedState = deriveRoutedTokenState(item, context);

      if (routedState.nextRecent && deriveRecentList) {
        nextRecentAddresses.push(item.address);
      }
      if (routedState.nextOldWeek && deriveOldWeekList) {
        nextOldWeekAddresses.push(item.address);
      }

      maybeLogRecentRemoval(item, context, routedState);
      maybeLogOldWeekRemoval(item, context, routedState);
    }

    finalizeAgeBucketState(deriveRecentList, deriveOldWeekList, nextRecentAddresses, nextOldWeekAddresses);
  }
  function applyBlockedFilters() {
    const blocked = new Set(state.data.blocklist.map((item) => item.address));
    if (blocked.size === 0) {
      deriveAgeBuckets();
      refreshMonitoredPanelCounts();
      refreshPumpPanelCounts();
      return;
    }

    state.data.monitoredTokenAddresses = state.data.monitoredTokenAddresses.filter((item) => !blocked.has(item));
    state.data.manualTokenAddresses = state.data.manualTokenAddresses.filter((item) => !blocked.has(item));
    state.data.recentTokenAddresses = state.data.recentTokenAddresses.filter((item) => !blocked.has(item));
    state.data.oldWeekTokenAddresses = state.data.oldWeekTokenAddresses.filter((item) => !blocked.has(item));
    refreshTrackedTokenStore();
    state.data.pumpTokens = state.data.pumpTokens.filter((item) => !blocked.has(item.mint));
    state.data.recentPumpMigrations = state.data.recentPumpMigrations.filter((item) => !blocked.has(item.mint));
    state.data.alerts = state.data.alerts.filter((item) => !blocked.has(item.address));
    state.data.dismissedRecent = state.data.dismissedRecent.filter((address) => !blocked.has(address));
    state.data.dismissedOldWeek = state.data.dismissedOldWeek.filter((address) => !blocked.has(address));
    state.bars.manual = state.data.manualTokenAddresses.length;
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
    state.data.monitoredTokenAddresses = state.data.monitoredTokenAddresses.filter((address) => {
      const item = state.data.trackedTokensByAddress[address];
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

    state.data.manualTokenAddresses = state.data.manualTokenAddresses.filter((address) => {
      const tracked = state.data.trackedTokensByAddress[address];
      return Boolean(tracked?._userManual) || state.data.monitoredTokenAddresses.includes(address);
    });
    refreshTrackedTokenStore();
    state.bars.manual = state.data.manualTokenAddresses.length;
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

  function updateLateralizedFreshness(timestamp: string | null) {
    state.runtime.lateralizedUpdatedAt = timestamp;
    state.runtime.lateralizedFreshnessLabel = formatFreshnessLabel(timestamp);
  }

  function updateBidZoneFreshness(timestamp: string | null) {
    state.runtime.bidZoneUpdatedAt = timestamp;
    state.runtime.bidZoneFreshnessLabel = formatFreshnessLabel(timestamp);
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

  async function refreshLateralizedTokens(options?: { force?: boolean }) {
    if (!shouldRunLateralizedRuntime()) {
      state.data.lateralizedTokens = [];
      state.panels.lateralized = 0;
      updateLateralizedFreshness(null);
      return;
    }

    const token = state.session.token;
    if (!token || lateralizedRefreshInFlight) {
      return;
    }

    const now = Date.now();
    if (!options?.force && nextLateralizedRefreshAt > now) {
      return;
    }

    lateralizedRefreshInFlight = true;
    try {
      const payload = await fetchLateralizedCandidates(token, { limit: LATERALIZED_PANEL_LIMIT });
      applyLateralizedPayload(payload);
      if (isHistoryWorkspace() && isHistorySyncLeader()) {
        broadcastHistoryLateralizedSnapshot(payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('No completed lateralization run available')
        || message.includes('Failed to load lateralized candidates')
        || message.includes('API request failed:')
      ) {
        state.data.lateralizedTokens = [];
        updateLateralizedFreshness(null);
        state.panels.lateralized = 0;
        emit('lateralized');
        return;
      }
    } finally {
      nextLateralizedRefreshAt = Date.now() + LATERALIZED_REFRESH_INTERVAL_MS;
      lateralizedRefreshInFlight = false;
    }
  }

  async function refreshBidZoneTokens(options?: { force?: boolean }) {
    if (!shouldRunLateralizedRuntime()) {
      state.data.bidZoneTokens = [];
      state.panels.bidZone = 0;
      updateBidZoneFreshness(null);
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
      const payload = await fetchBidZoneCandidates(token, { limit: BID_ZONE_PANEL_LIMIT });
      applyBidZonePayload(payload);
      if (isHistoryWorkspace() && isHistorySyncLeader()) {
        broadcastHistoryBidZoneSnapshot(payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('Failed to load bid-zone candidates')
        || message.includes('API request failed:')
      ) {
        state.data.bidZoneTokens = [];
        updateBidZoneFreshness(null);
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
    const minVol = getConfigNumber('min-vol', 5000);
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

  function roundAlertMetric(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) {
      return 'na';
    }
    return String(Math.round(value * 100) / 100);
  }

  function shouldSuppressDuplicateAlert(entry: AlertEntry) {
    if (entry.kind !== 'monitored-mcap') {
      return false;
    }

    const dedupeKey = `${entry.kind}:${entry.address}`;
    const fingerprint = [
      roundAlertMetric(entry.pct),
      roundAlertMetric(entry.prevMcap ?? null),
      roundAlertMetric(entry.mcap ?? null),
    ].join('|');
    const now = Date.now();
    const previous = recentAlertFingerprints.get(dedupeKey);

    recentAlertFingerprints.set(dedupeKey, { ts: now, fingerprint });

    if (!previous) {
      return false;
    }

    return previous.fingerprint === fingerprint && now - previous.ts < ALERT_DEDUPE_WINDOW_MS;
  }

  function pushAlert(entry: AlertEntry) {
    if (isBlocked(entry.address) || !isAlertEntryEnabled(entry)) {
      return;
    }
    if (shouldSuppressDuplicateAlert(entry)) {
      return;
    }
    state.data.alerts = [entry, ...state.data.alerts].slice(0, 100);
    syncAlertState();
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
    return {
      id: `${token.address}-${now}-${kind}`,
      kind,
      address: token.address,
      symbol,
      name: token.name || token.label || null,
      pairUrl: token.pairUrl || null,
      mintAddress: token.mintAddress || token.address,
      pairAddress: token.pairAddress || null,
      imageUrl: token.imageUrl || null,
      twitterUrl: token.twitterUrl || null,
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
      && ageMs < HVNC_MAX_AGE_MS
      && (token.volume24h ?? 0) >= hvncMinVol;
  }

  function primeOldSurgeSessionBases(token: ManualTokenEntry, pc1h: number | null, pc6h: number | null) {
    if (token._oldSurgeSessionBase1h == null) {
      token._oldSurgeSessionBase1h = pc1h;
    }
    if (token._oldSurgeSessionBase6h == null) {
      token._oldSurgeSessionBase6h = pc6h;
    }
  }

  function hasTriggeredOldSurge(base: number | null | undefined, current: number | null, threshold: number) {
    const crossedThreshold = base != null && base < threshold && current != null && current >= threshold;
    const repeatedHotMove = base != null && base >= threshold && current != null && current >= base + OLD_SURGE_SESSION_DELTA_PCT;
    return crossedThreshold || repeatedHotMove;
  }

  function resolveOldSurgeAlert(token: ManualTokenEntry) {
    const pc1h = token.priceChange1h ?? null;
    const pc6h = token.priceChange6h ?? null;
    const oldAlert1hPct = getOldAlert1hThreshold();
    const oldAlert6hPct = getOldAlert6hThreshold();
    const oldSurge1hEnabled = isConfigEnabled('alert-old-surge-1h-enabled');
    const oldSurge6hEnabled = isConfigEnabled('alert-old-surge-6h-enabled');
    const base1h = token._oldSurgeSessionBase1h;
    const base6h = token._oldSurgeSessionBase6h;

    primeOldSurgeSessionBases(token, pc1h, pc6h);

    if (oldSurge6hEnabled && hasTriggeredOldSurge(base6h, pc6h, oldAlert6hPct)) {
      return { pct: pc6h ?? 0, surgeWindow: '6H' as const };
    }

    if (oldSurge1hEnabled && hasTriggeredOldSurge(base1h, pc1h, oldAlert1hPct)) {
      return { pct: pc1h ?? 0, surgeWindow: '1H' as const };
    }

    return null;
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
    if (isBlocked(token.address)) {
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

    if (shouldFireHvncAlert(token, ageMs, hvncMinVol)) {
      token._hvncFired = true;
      pushAlert(buildTrackedAlertEntry(token, now, symbol, 'hvnc', 'HVNC', 0, { isHvnc: true }));
      setNotice(`HVNC alert: ${symbol}`);
    }

    const isOldRouted = Boolean(token._isRecentRouted || token._isOldWeekRouted);

    if (!token._oldSurgeFired && isOldRouted && ageMs >= SURGE_MIN_AGE_MS) {
      const surgeAlert = resolveOldSurgeAlert(token);
      if (surgeAlert && surgeAlert.pct > 0) {
        token._oldSurgeFired = true;
        token.lastAlertAt = now;
        token._lastAlertKind = 'old-surge';
        pushAlert(buildTrackedAlertEntry(token, now, symbol, 'old-surge', `PCHANGE ${surgeAlert.surgeWindow}`, surgeAlert.pct, {
          surgeWindow: surgeAlert.surgeWindow,
          isOldSurge: true,
        }));
        setNotice(`Old token surge alert ${surgeAlert.surgeWindow}: ${symbol}`);
      }
    }

    if (shouldFireMeteoraSurgeAlert(token, meteoraEntry, meteoraCurrentTvl, meteoraBaselineTvl1h, meteoraAlertThreshold1h)) {
      token._meteoraSurgeFired = true;
      token.lastAlertAt = now;
      token._lastAlertKind = 'meteora-surge';
      pushAlert(buildTrackedAlertEntry(token, now, symbol, 'meteora-surge', 'METEORA 1H', meteoraEntry?.change1h ?? 0));
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

  function maybeFireLocalAlert(token: ManualTokenEntry) {
    if (isBlocked(token.address)) {
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
    const mcapDeclining = previousMcap != null && previousMcap > 0 && currentMcap > 0 && currentMcap < previousMcap;
    let localAlertCandidate: { alert: AlertEntry; firedKind: 'vol' | 'mcap' } | null = null;

    if (previousVol != null && previousVol > 0) {
      localAlertCandidate = evaluateVolumeLocalAlert(token, now, symbol, threshold, previousVol, previousMcap, currentVol, mcapDeclining);
    }

    if (!localAlertCandidate && mcapThreshold > 0 && previousMcap != null && previousMcap > 0) {
      localAlertCandidate = evaluateMcapLocalAlert(token, now, symbol, mcapThreshold, previousVol, previousMcap, currentMcap);
    }

    if (localAlertCandidate) {
      applyLocalAlertState(token, localAlertCandidate.alert, localAlertCandidate.firedKind, now);
      pushAlert(localAlertCandidate.alert);
      setNotice(`Local monitored alert: ${symbol}`);
    }
  }
  function rebuildTrackedState(payload: ConfigPayload, monitoredDashboardTokens: DashboardMonitoredToken[] = []) {
    const existing = new Map(
      Object.entries(state.data.trackedTokensByAddress).length > 0
        ? Object.entries(state.data.trackedTokensByAddress)
        : getMonitoredTokens(state).map((item) => [item.address, item]),
    );
    const blockedSet = new Set(payload.blocklist.map((item) => item.address));
    const dashboardByAddress = new Map(monitoredDashboardTokens.map((item) => [item.address, item]));
    const nextTrackedStore: Record<string, ManualTokenEntry> = {};
    const now = Date.now();
    const coldRefreshDue = monitoredDashboardTokens.length > 0 && now >= nextColdFieldRefreshAt;
    const alertCandidates = new Set<string>();

    const manualTokens = sortAddresses(payload.tokens)
      .filter((item) => !blockedSet.has(item.address))
      .map((item) => {
        const existingItem = existing.get(item.address);
        const dashboardItem = dashboardByAddress.get(item.address);
        if (existingItem) {
          alertCandidates.add(item.address);
        }
        const mergedItem = mergeTrackedDashboardFields({
          existingItem,
          dashboardItem,
          base: {
            ...existingItem,
            address: item.address,
            label: item.label ?? null,
            manual: true,
            _userManual: true,
          },
          coldRefreshDue,
        });
        const nextItem = selectMergedTrackedToken(existingItem, mergedItem);
        nextTrackedStore[item.address] = nextItem;
        return nextItem;
      });

    const monitoredMap = new Map<string, ManualTokenEntry>();
    for (const item of manualTokens) {
      monitoredMap.set(item.address, item);
    }
    for (const item of monitoredDashboardTokens
      .slice()
      .sort((a, b) => a.address.localeCompare(b.address))) {
      if (blockedSet.has(item.address)) continue;
      if (monitoredMap.has(item.address)) continue;
      const existingItem = existing.get(item.address);
      if (existingItem) {
        alertCandidates.add(item.address);
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
        },
        coldRefreshDue,
      });
      const nextItem = selectMergedTrackedToken(existingItem, mergedItem);
      nextTrackedStore[item.address] = nextItem;
      monitoredMap.set(item.address, nextItem);
    }

    commitTrackedStateRebuild({
      nextTrackedStore,
      manualTokens,
      monitoredMap,
      alertCandidates,
      coldRefreshDue,
      now,
    });
  }

  function applyHistoryMonitoredSnapshot(tokens: DashboardMonitoredToken[], generatedAt?: string | null) {
    applyMonitoredDashboard(tokens, undefined, generatedAt ?? null);
    emit('recent', 'old-week', 'lateralized', 'bid-zone', 'header');
  }

  function buildCandidateIdentityFields(
    item: LateralizedPayload['candidates'][number] | BidZonePayload['candidates'][number],
  ) {
    return {
      address: item.address,
      symbol: item.symbol ?? null,
      name: item.name ?? null,
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
    item: LateralizedPayload['candidates'][number] | BidZonePayload['candidates'][number],
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

  function buildLateralizedSpecificFields(item: LateralizedPayload['candidates'][number]) {
    return {
      rangePct: item.rangePct ?? null,
      rangeLimitPct: item.rangeLimitPct ?? null,
      driftPct: item.driftPct ?? null,
      driftLimitPct: item.driftLimitPct ?? null,
      currentPositionPct: item.currentPositionPct ?? null,
    };
  }

  function buildLateralizedTokenEntry(item: LateralizedPayload['candidates'][number]): LateralizedTokenEntry {
    return {
      ...buildCandidateIdentityFields(item),
      ...buildCandidateMetricFields(item),
      ...buildLateralizedSpecificFields(item),
    };
  }

  function applyLateralizedPayload(payload: LateralizedPayload) {
    state.data.lateralizedTokens = (payload.candidates || []).map(buildLateralizedTokenEntry);
    updateLateralizedFreshness(payload.generatedAt ?? null);
    state.panels.lateralized = state.data.lateralizedTokens.length;
    emit('lateralized');
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
    state.panels.bidZone = state.data.bidZoneTokens.length;
    emit('bid-zone');
  }

  function broadcastHistoryMonitoredSnapshot(tokens: DashboardMonitoredToken[], generatedAt?: string | null) {
    if (!isHistoryWorkspace() || !isHistorySyncLeader()) {
      return;
    }

    postHistorySyncMessage({
      type: 'monitored-snapshot',
      tabId: historySyncTabId,
      generatedAt: generatedAt ?? null,
      tokens,
      ts: Date.now(),
    });
  }

  function broadcastHistoryLateralizedSnapshot(payload: LateralizedPayload) {
    if (!isHistoryWorkspace() || !isHistorySyncLeader()) {
      return;
    }

    postHistorySyncMessage({
      type: 'lateralized-snapshot',
      tabId: historySyncTabId,
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
      payload,
      ts: Date.now(),
    });
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

    if (!isActiveHistorySyncCandidate() || isHistorySyncLeader()) {
      return;
    }

    if (message.type === 'monitored-snapshot') {
      applyHistoryMonitoredSnapshot(message.tokens || [], message.generatedAt ?? null);
      return;
    }

    if (message.type === 'lateralized-snapshot') {
      applyLateralizedPayload(message.payload);
      return;
    }

    if (message.type === 'bid-zone-snapshot') {
      applyBidZonePayload(message.payload);
    }
  }

  async function refreshMonitoredDashboard() {
    const token = state.session.token;
    if (!token || monitoredRefreshInFlight) {
      return;
    }

    monitoredRefreshInFlight = true;
    try {
      const monitoredDashboard = await fetchDashboardMonitored(token);
      applyMonitoredDashboard(monitoredDashboard.tokens, undefined, monitoredDashboard.generatedAt ?? null);
      if (isHistoryWorkspace() && isHistorySyncLeader()) {
        broadcastHistoryMonitoredSnapshot(monitoredDashboard.tokens, monitoredDashboard.generatedAt ?? null);
      }
      if (isLiveWorkspace()) {
        emit('monitored', 'manual', 'recent', 'old-week', 'alerts', 'header');
      } else if (isHistoryWorkspace()) {
        emit('recent', 'old-week', 'lateralized', 'bid-zone', 'header');
      } else {
        emit('recent', 'old-week', 'header');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh monitored dashboard');
      emit('legacy', 'overlay');
    } finally {
      monitoredRefreshInFlight = false;
    }
  }

  function runMonitoringCycle() {
    state.runtime.cycle += 1;
    sweepMinMcapRemove();
    refreshMonitoredPanelCounts();
    computeUptimeLabel();
    updateMonitoredFreshness(state.runtime.monitoredUpdatedAt);
    void refreshMonitoredDashboard();
    if (shouldRunLateralizedRuntime()) {
      void refreshLateralizedTokens();
      void refreshBidZoneTokens();
      emit('header', 'recent', 'old-week', 'lateralized', 'bid-zone');
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

  function startMonitoringTimers() {
    if (state.runtime.mode === 'active') return;
    state.runtime.mode = 'active';
    startedAt = Date.now();
    computeUptimeLabel();
    syncHistorySyncState({ runImmediatelyOnGain: true });
    syncMonitoringPolling({ runImmediately: true });
    startPumpGcTimer();
    uptimeInterval = setInterval(() => {
      computeUptimeLabel();
      emit('header');
    }, UPTIME_REFRESH_INTERVAL_MS);
  }

  function stopMonitoringTimers() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    if (uptimeInterval) clearInterval(uptimeInterval);
    stopPumpGcTimer();
    monitoringInterval = null;
    uptimeInterval = null;
    startedAt = null;
    state.runtime.mode = 'stopped';
    state.runtime.uptimeLabel = '0m';
    updateMonitoredFreshness(state.runtime.monitoredUpdatedAt);
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
      onPumpStatus(payload) {
        if (!shouldRunPumpfunRuntime()) {
          return;
        }
        state.pumpfun.connected = Boolean(payload.connected);
        state.pumpfun.statusLabel = state.pumpfun.connected ? 'connected' : 'disconnected';
        emit('pumpfun', 'header');
      },
      onSolPrice(payload) {
        if (!shouldRunPumpfunRuntime() || state.runtime.mode !== 'active') {
          return;
        }
        const price = Number(payload.price);
        if (Number.isFinite(price) && price > 0) {
          state.pumpfun.solPriceUsd = price;
        }
        emit('pumpfun');
      },
      onPumpNewToken(payload) {
        if (!shouldRunPumpfunRuntime() || state.runtime.mode !== 'active') {
          return;
        }
        createOrUpdatePumpToken(payload, 'new');
        const mint = String(payload.mint || '').trim();
        if (mint) {
          subscribePumpMint(mint);
        }
        emit('pumpfun');
      },
      onPumpTrade(payload) {
        if (!shouldRunPumpfunRuntime() || state.runtime.mode !== 'active') {
          return;
        }
        createOrUpdatePumpToken(payload, 'trade');
        emit('pumpfun');
      },
      onPumpMigrate(payload) {
        if (!shouldRunPumpfunRuntime() || state.runtime.mode !== 'active') {
          return;
        }
        const mint = String(payload.mint || '').trim();
        if (!mint) return;
        const existingToken = state.data.pumpTokens.find((item) => item.mint === mint) || null;
        if ((existingToken && existingToken._migrated) || (!existingToken && hasRecordedPumpMigration(mint))) {
          return;
        }

        const migrationToken = buildPumpMigrationTokenFromPayload(payload, existingToken);
        if (!migrationToken) return;
        if (existingToken) {
          existingToken._migrated = true;
        }

        reportPumpMigration(migrationToken);
        if (shouldSurfacePumpMigration(migrationToken)) {
          recordPumpMigration(migrationToken);
          enqueuePumpToast(migrationToken);
          if (!migrationToken.symbol || !migrationToken.imageUrl) {
            void resolvePumpMigrationMetadata(mint);
          }
        }
        state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== mint);
        unsubscribePumpMint(mint);
        refreshPumpPanelCounts();
        if (shouldSurfacePumpMigration(migrationToken)) {
          setNotice(`PumpFun migration: ${migrationToken.symbol || mint.slice(0, 6)}`);
        }
        emit('pumpfun', 'toasts', 'legacy', 'overlay');
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

    if (shouldRunPumpfunRuntime()) {
      connectRealtime();
      startPumpGcTimer();
    } else {
      suppressSocketStatusNoticeUntil = Date.now() + 2000;
      disconnectSocket();
      stopPumpGcTimer();
      clearPumpWorkspaceState();
      emit('pumpfun', 'toasts', 'legacy', 'overlay');
    }

    if (!shouldRunLateralizedRuntime()) {
      state.data.lateralizedTokens = [];
      state.panels.lateralized = 0;
      updateLateralizedFreshness(null);
      state.data.bidZoneTokens = [];
      state.panels.bidZone = 0;
      updateBidZoneFreshness(null);
    } else {
      void refreshLateralizedTokens({ force: true });
      void refreshBidZoneTokens({ force: true });
    }

    syncHistorySyncState({ runImmediatelyOnGain: true });
    syncMonitoringPolling();
  }

  function refreshWorkspaceSnapshot() {
    if (state.session.status !== 'authenticated') {
      return;
    }

    void refreshMonitoredDashboard();
    if (shouldRunLateralizedRuntime()) {
      void refreshLateralizedTokens({ force: true });
      void refreshBidZoneTokens({ force: true });
    }
  }

  function applySession(user: SessionUser) {
    state.session.status = 'authenticated';
    state.session.token = COOKIE_SESSION_MARKER;
    state.session.username = user.username;
    state.session.email = user.email;
    state.session.role = user.role;
    state.session.isEmailVerified = Boolean(user.isEmailVerified);
    state.session.emailVerifiedAt = user.emailVerifiedAt ?? null;
    hydrateBarStorage();
    hydrateSoundSettings();
    syncWorkspaceCapabilities();
    syncHistorySyncState({ runImmediatelyOnGain: true });
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
    state.session.accessStatus = access?.accessStatus ?? null;
    state.session.accessGrantedAt = access?.accessGrantedAt ?? null;
    state.session.accessExpiresAt = access?.accessExpiresAt ?? null;
    state.session.accessSource = access?.accessSource ?? null;
    state.session.accessUpdatedAt = access?.accessUpdatedAt ?? null;
    state.session.accessIsExpired = Boolean(access?.isExpired);
    state.session.accessHasProductAccess = Boolean(access?.hasProductAccess);
    state.session.accessDaysRemaining = access?.daysRemaining ?? null;
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
      state.identities.error = error instanceof Error ? error.message : 'Unable to load linked identities';
    }
  }

  async function refreshAccountSecurityIdentityState(token?: string | null) {
    try {
      applyIdentityStateSnapshot(await fetchAccountSecurityIdentities(token));
    } catch (error) {
      state.identities.loaded = false;
      state.identities.providers = [];
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
      fetchPublicBillingPlans(),
    ]);

    applyPreAccessSession(preAccess.user);
    applyAccountAccess(preAccess.access);
    applyPublicBillingPlansSnapshot(billing);
    state.preAccess.loaded = true;
  }

  async function refreshUserSettingsState(token: string) {
    await Promise.all([
      refreshAccountAccessState(token),
      refreshBillingState(token),
      refreshIdentityState(token),
    ]);
  }

  async function refreshAuthenticatedBootstrapState() {
    await refreshUserSettingsState(COOKIE_SESSION_MARKER);
    await reloadConfigInternal(COOKIE_SESSION_MARKER, { deferDashboard: true });
  }

  function clearSession() {
    stopSocialLinkSync();
    stopPreAccessPolling();
    recentAlertFingerprints.clear();
    nextColdFieldRefreshAt = 0;
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
    state.identities.error = null;
    state.preAccess.loaded = false;
    state.preAccess.awaitingConfirmation = false;
    state.runtime.cycle = 0;
    state.runtime.alerts = 0;
    state.runtime.monitoredUpdatedAt = null;
    state.runtime.monitoredFreshnessLabel = '-';
    state.runtime.lateralizedUpdatedAt = null;
    state.runtime.lateralizedFreshnessLabel = '-';
    state.runtime.bidZoneUpdatedAt = null;
    state.runtime.bidZoneFreshnessLabel = '-';
    state.panels.alerts = 0;
    state.panels.lateralized = 0;
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
    state.data = {
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
      bidZoneTokens: [],
      alerts: [],
      pumpTokens: [],
      recentPumpMigrations: [],
      pumpToasts: [],
    };
    state.bars.manual = 0;
    state.bars.recent = 0;
    state.bars.oldWeek = 0;
    state.bars.blocklist = 0;
    state.panels.monitored = 0;
    state.panels.lateralized = 0;
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
    state.ui.manualStarredOnly = false;
    state.ui.recentStarredOnly = false;
    state.ui.oldWeekStarredOnly = false;
    state.ui.monitoredPage = 0;
    state.ui.recentPage = 0;
    state.ui.oldWeekPage = 0;
    state.ui.monitoredPerPage = 30;
    state.ui.recentPerPage = 30;
    state.ui.oldWeekPerPage = 30;
    state.ui.manualSorts = getDefaultBucketSorts('manual');
    state.ui.recentSorts = getDefaultBucketSorts('recent');
    state.ui.oldWeekSorts = getDefaultBucketSorts('old-week');
    state.ui.monitoredSorts = getDefaultMonitoredSorts();
    if (uiPrefsPersistTimer) {
      clearTimeout(uiPrefsPersistTimer);
      uiPrefsPersistTimer = null;
    }
    hydrateSoundSettings();
    state.ui.collapsed = getDefaultCollapsedSections();
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
      applySession(result.user);
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
  ) {
    const manualPayload = buildMonitoredDashboardPayload(manualTokensOverride);
    syncMeteoraDashboardCache(monitoredDashboardTokens, manualPayload.tokens);
    state.configSummary.eligibleCatalogTokens = monitoredDashboardTokens.length;
    state.data.eligibleCatalogTokens = monitoredDashboardTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
    if (generatedAt !== undefined) {
      updateMonitoredFreshness(generatedAt ?? null);
    }
    rebuildTrackedState(manualPayload, monitoredDashboardTokens);
  }

  function buildMonitoredDashboardPayload(
    manualTokensOverride?: Array<{ address: string; label?: string | null }>,
  ): ConfigPayload {
    return {
      configs: state.data.configs,
      uiPrefs: buildUiPrefsPayload(),
      tokens: (manualTokensOverride ?? getManualTokens(state).map((item) => ({ address: item.address, label: item.label ?? null }))),
      blocklist: state.data.blocklist.map((item) => ({ address: item.address, label: item.label ?? null })),
      starredTokens: state.data.starredTokens.map((address) => ({ address })),
    };
  }

  function syncMeteoraDashboardCache(
    monitoredDashboardTokens: DashboardMonitoredToken[],
    manualTokens: Array<{ address: string; label?: string | null }>,
  ) {
    const activeAddresses = new Set(monitoredDashboardTokens.map((item) => item.address));
    for (const item of manualTokens) {
      activeAddresses.add(item.address);
    }

    for (const address of Object.keys(state.data.meteoraByAddress)) {
      if (!activeAddresses.has(address)) {
        delete state.data.meteoraByAddress[address];
      }
    }

    for (const item of monitoredDashboardTokens) {
      if (!item?.address || !item.meteora) continue;
      state.data.meteoraByAddress[item.address] = {
        ...(state.data.meteoraByAddress[item.address] || {}),
        tvl: Number(item.meteora.tvl) || 0,
        poolAddress: item.meteora.poolAddress || null,
        poolCount: Number(item.meteora.poolCount) || 0,
        noPool: Boolean(item.meteora.noPool),
        lastFetch: Date.now(),
        lastSnapshotAt: item.meteora.lastSnapshotAt || null,
        change1h: item.meteora.change1h ?? null,
        change6h: item.meteora.change6h ?? null,
        change24h: item.meteora.change24h ?? null,
      };
    }
  }

  function applyConfig(payload: ConfigPayload, monitoredDashboardTokens: DashboardMonitoredToken[] = []) {
    state.configSummary = {
      loaded: true,
      configCount: Object.keys(payload.configs || {}).length,
      manualTokens: payload.tokens.length,
      blocklist: payload.blocklist.length,
      starredTokens: payload.starredTokens.length,
      eligibleCatalogTokens: monitoredDashboardTokens.length,
    };
    state.data.configs = payload.configs || {};
    state.pumpfun.bondTargetMcap = getConfigNumber('pump-bond-mcap', state.pumpfun.bondTargetMcap || 35000);
    applyUiPreferencesFromConfigs();
    applyUiPreferences(payload.uiPrefs);
    persistSoundSettings();
    state.data.blocklist = sortAddresses(payload.blocklist);
    state.data.starredTokens = payload.starredTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
    state.data.alerts = state.data.alerts.filter((item) => !isBlocked(item.address));
    syncAlertState();
    state.bars.blocklist = payload.blocklist.length;
    applyMonitoredDashboard(monitoredDashboardTokens, payload.tokens);
    refreshPumpPanelCounts();
  }

  async function hydrateDashboardMonitoredInternal(token: string, manualTokens: AddressItem[]) {
    try {
      const monitoredDashboard = await fetchDashboardMonitored(token);
      applyMonitoredDashboard(monitoredDashboard.tokens, manualTokens, monitoredDashboard.generatedAt ?? null);
      if (isLiveWorkspace()) {
        emit('monitored', 'manual', 'recent', 'old-week', 'alerts');
      } else if (isHistoryWorkspace()) {
        void refreshLateralizedTokens({ force: true });
        void refreshBidZoneTokens({ force: true });
        emit('recent', 'old-week', 'lateralized', 'bid-zone', 'header');
      } else {
        emit('recent', 'old-week', 'header');
      }
    } catch {
    }
  }

  async function reloadConfigInternal(token: string, options?: { deferDashboard?: boolean }) {
    const payload = await fetchConfig(token);

    applyConfig(payload, []);

    if (options?.deferDashboard) {
      void hydrateDashboardMonitoredInternal(token, payload.tokens);
      return;
    }

    await hydrateDashboardMonitoredInternal(token, payload.tokens);
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

  function applyVerifiedEmailSuccessResult(result: VerifyEmailConfirmResponse) {
    if (state.session.status === 'authenticated') {
      applySession(result.user);
    }
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

      applyVerifiedEmailSuccessResult(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Email verification failed');
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
      clearBillingCheckoutUrl();
    }

    if (options.socialLinkIntent) {
      state.ui.authPanel = 'user-settings';
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
    applySession(session.user);
    await refreshAuthenticatedBootstrapState();
    applyAuthenticatedRestoreIntents(options);
    setNotice(getAuthenticatedRestoreNotice(options));
  }

  async function handlePreAccessRestore(options: {
    billingCheckoutSucceeded: boolean;
    socialLoginIntent: SocialIntent | null;
  }) {
    await refreshPreAccessState();
    navigateToPreAccess();
    setError(null);
    state.ui.loginErrorCount = 0;

    if (options.billingCheckoutSucceeded) {
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
      setNotice(`${getSocialProviderLabel(options.socialLoginIntent.provider)} sign-in successful. Access payment is still required before entering the bot.`);
      return;
    }

    state.preAccess.awaitingConfirmation = false;
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

  function buildOptimisticManualToken(address: string, label?: string | null) {
    const existingTracked = state.data.trackedTokensByAddress[address]
      || getMonitoredTokens(state).find((item) => item.address === address)
      || getManualTokens(state).find((item) => item.address === address);
    const nextManualDraft: ManualTokenEntry = {
      ...(existingTracked || {}),
      address,
      label: label ?? existingTracked?.label ?? null,
      manual: true,
      _userManual: true,
    };

    return areTrackedTokensEquivalent(existingTracked, nextManualDraft)
      ? existingTracked as ManualTokenEntry
      : nextManualDraft;
  }

  function applyOptimisticManualToken(address: string, nextManual: ManualTokenEntry) {
    state.data.trackedTokensByAddress[address] = nextManual;
    state.data.manualTokenAddresses = state.data.manualTokenAddresses.includes(address)
      ? state.data.manualTokenAddresses
      : [...state.data.manualTokenAddresses, address];
    state.data.monitoredTokenAddresses = state.data.monitoredTokenAddresses.includes(address)
      ? state.data.monitoredTokenAddresses
      : [...state.data.monitoredTokenAddresses, address];

    state.configSummary.manualTokens = state.data.manualTokenAddresses.length;
    state.bars.manual = state.data.manualTokenAddresses.length;
    refreshMonitoredPanelCounts();
    deriveAgeBuckets();
  }

  async function syncManualTokenToBackend(address: string, label: string | null | undefined, token: string) {
    const result = await addManualTokenRequest(address, label ?? null, token);
    if (result?.token) {
      const currentTracked = state.data.trackedTokensByAddress[address];
      if (currentTracked) {
        const syncedTracked = {
          ...currentTracked,
          label: result.token.label ?? currentTracked.label ?? null,
        };
        replaceTrackedTokenReferences(address, syncedTracked);
      }
    }

    await trackManualToken(address, token);
    await reloadConfigInternal(token);
  }

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
    openAuthPanel(panel: Exclude<AuthPanel, 'none'>) {
      state.ui.pendingIdentityUnlinkProvider = null;
      if (panel === 'change-password') {
        monitoringPausedForAuthPanel = false;
        state.ui.error = null;
        state.ui.notice = null;
      }
      state.ui.authPanel = panel;
      if (panel === 'register' && typeof window !== 'undefined' && state.session.status === 'anonymous' && isLoginRoutePath(window.location.pathname)) {
        navigateToLogin('register');
      }
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
      }
      monitoringPausedForAuthPanel = false;
      if (shouldResumeMonitoring) {
        startMonitoringTimers();
      }
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
    dismissRecentToken(address: string) {
      if (!state.data.dismissedRecent.includes(address)) {
        state.data.dismissedRecent = [...state.data.dismissedRecent, address];
        state.data.recentTokenAddresses = state.data.recentTokenAddresses.filter((item) => item !== address);
        state.bars.recent = state.data.recentTokenAddresses.length;
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Recent token dismissed.');
        emit('recent', 'legacy', 'overlay');
      }
    },
    dismissOldWeekToken(address: string) {
      if (!state.data.dismissedOldWeek.includes(address)) {
        state.data.dismissedOldWeek = [...state.data.dismissedOldWeek, address];
        state.data.oldWeekTokenAddresses = state.data.oldWeekTokenAddresses.filter((item) => item !== address);
        state.bars.oldWeek = state.data.oldWeekTokenAddresses.length;
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Old Week token dismissed.');
        emit('old-week', 'legacy', 'overlay');
      }
    },
    clearAllAlerts() {
      if (state.data.alerts.length === 0) {
        return;
      }
      state.data.alerts = [];
      syncAlertState();
      setNotice('All alerts cleared.');
      emit('alerts', 'legacy', 'overlay');
    },
    removeAlert(id: string) {
      const nextAlerts = state.data.alerts.filter((item) => item.id !== id);
      if (nextAlerts.length === state.data.alerts.length) {
        return;
      }
      state.data.alerts = nextAlerts;
      syncAlertState();
      emit('alerts');
    },
    clearRecentRemovalLog() {
      state.data.recentRemovalLog = [];
      persistBarStorage();
      emit('recent');
    },
    clearOldWeekRemovalLog() {
      state.data.oldWeekRemovalLog = [];
      persistBarStorage();
      emit('old-week');
    },
    clearDismissedRecent() {
      state.data.dismissedRecent = [];
      deriveAgeBuckets();
      persistBarStorage();
      setNotice('Recent dismissed set cleared.');
      emit('recent', 'legacy', 'overlay');
    },
    clearDismissedOldWeek() {
      state.data.dismissedOldWeek = [];
      deriveAgeBuckets();
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
      emit('alerts');
    },
    setMonitoredSearchQuery(query: string) {
      state.ui.monitoredSearchQuery = String(query || '');
      state.ui.monitoredPage = 0;
      emit('monitored');
    },
    setManualSearchQuery(query: string) {
      state.ui.manualSearchQuery = String(query || '');
      emit('manual');
    },
    setRecentSearchQuery(query: string) {
      state.ui.recentSearchQuery = String(query || '');
      state.ui.recentPage = 0;
      emit('recent');
    },
    setOldWeekSearchQuery(query: string) {
      state.ui.oldWeekSearchQuery = String(query || '');
      state.ui.oldWeekPage = 0;
      emit('old-week');
    },
    setManualStarredOnly(enabled: boolean) {
      state.ui.manualStarredOnly = Boolean(enabled);
      queueUiPrefsPersist();
      emit('manual');
    },
    setRecentStarredOnly(enabled: boolean) {
      state.ui.recentStarredOnly = Boolean(enabled);
      state.ui.recentPage = 0;
      queueUiPrefsPersist();
      emit('recent');
    },
    setOldWeekStarredOnly(enabled: boolean) {
      state.ui.oldWeekStarredOnly = Boolean(enabled);
      state.ui.oldWeekPage = 0;
      queueUiPrefsPersist();
      emit('old-week');
    },
    setMonitoredPage(page: number) {
      state.ui.monitoredPage = clampPage(page, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
      emit('monitored');
    },
    setRecentPage(page: number) {
      state.ui.recentPage = clampPage(page, state.data.recentTokenAddresses.length, state.ui.recentPerPage);
      emit('recent');
    },
    setOldWeekPage(page: number) {
      state.ui.oldWeekPage = clampPage(page, state.data.oldWeekTokenAddresses.length, state.ui.oldWeekPerPage);
      emit('old-week');
    },
    setMonitoredPerPage(perPage: number) {
      state.ui.monitoredPerPage = normalizeUiPerPage(perPage, 30);
      state.ui.monitoredPage = clampPage(state.ui.monitoredPage, getVisibleMonitoredTokens().length, state.ui.monitoredPerPage);
      queueUiPrefsPersist();
      emit('monitored');
    },
    setRecentPerPage(perPage: number) {
      state.ui.recentPerPage = normalizeUiPerPage(perPage, 30);
      state.ui.recentPage = clampPage(state.ui.recentPage, state.data.recentTokenAddresses.length, state.ui.recentPerPage);
      queueUiPrefsPersist();
      emit('recent');
    },
    setOldWeekPerPage(perPage: number) {
      state.ui.oldWeekPerPage = normalizeUiPerPage(perPage, 30);
      state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, state.data.oldWeekTokenAddresses.length, state.ui.oldWeekPerPage);
      queueUiPrefsPersist();
      emit('old-week');
    },
    setManualSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.manualSorts = toggleSortCriterion(
        state.ui.manualSorts,
        normalizeBucketCriterion(mode, window),
      );
      queueUiPrefsPersist();
      emit('manual');
    },
    setRecentSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.recentSorts = toggleSortCriterion(
        state.ui.recentSorts,
        normalizeBucketCriterion(mode, window),
      );
      queueUiPrefsPersist();
      emit('recent');
    },
    setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.oldWeekSorts = toggleSortCriterion(
        state.ui.oldWeekSorts,
        normalizeBucketCriterion(mode, window),
      );
      queueUiPrefsPersist();
      emit('old-week');
    },
    setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow) {
      state.ui.monitoredSorts = toggleSortCriterion(
        state.ui.monitoredSorts,
        normalizeMonitoredCriterion(mode, window),
      );
      queueUiPrefsPersist();
      emit('monitored');
    },
    setEnabledTradeTerminals(terminals: AppState['ui']['enabledTradeTerminals']) {
      state.ui.enabledTradeTerminals = normalizeTradeTerminals(terminals);
      queueUiPrefsPersist();
      emit('manual', 'recent', 'old-week', 'monitored', 'lateralized', 'bid-zone', 'pumpfun', 'alerts', 'overlay');
    },
    setSoundEnabled(enabled: boolean) {
      state.ui.soundEnabled = enabled;
      state.data.configs['sound-mode'] = enabled ? 'on' : 'off';
      persistSoundSettings();
      void persistUiConfigs({ 'sound-mode': enabled ? 'on' : 'off' });
      emit('overlay');
    },
    async toggleStarredToken(address: string) {
      const wasStarred = state.data.starredTokens.includes(address);
      state.data.starredTokens = wasStarred
        ? state.data.starredTokens.filter((item) => item !== address)
        : [...state.data.starredTokens, address].sort((a, b) => a.localeCompare(b));
      emit('manual', 'recent', 'old-week', 'monitored', 'lateralized', 'bid-zone', 'alerts');
      queueStarredTokensPersist();
    },
    setSoundVolume(volume: number) {
      const nextVolume = clampUiVolume(volume);
      state.ui.soundVolume = nextVolume;
      state.data.configs['sound-volume'] = Math.round(nextVolume * 100);
      persistSoundSettings();
      void persistUiConfigs({ 'sound-volume': Math.round(nextVolume * 100) });
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
        applySession(session.user);
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
          applySession(result.user);
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

      try {
        const patchResult = await patchConfig(configs, token);
        state.data.configs = { ...state.data.configs, ...patchResult.configs };
        applyUiPreferencesFromConfigs();
        persistSoundSettings();
        sweepMinMcapRemove();
        deriveAgeBuckets();
        emit();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to save config');
        emit();
      }
    },
    async addManualToken(address: string, label?: string | null) {
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

      setBusy(true);
      setError(null);
      setNotice('Adding manual token...');

      const nextManual = buildOptimisticManualToken(normalizedAddress, label);
      applyOptimisticManualToken(normalizedAddress, nextManual);
      emit();

      try {
        await syncManualTokenToBackend(normalizedAddress, label, token);
        setNotice('Token added');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to persist manual token');
        setNotice('Token added locally, but backend sync failed.');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async removeManualToken(address: string) {
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
        state.data.manualTokenAddresses = state.data.manualTokenAddresses.filter((item) => item !== address);
        const currentTracked = state.data.trackedTokensByAddress[address];
        if (currentTracked) {
          replaceTrackedTokenReferences(address, {
            ...currentTracked,
            manual: false,
            _userManual: false,
          });
        }
        state.configSummary.manualTokens = state.data.manualTokenAddresses.length;
        state.bars.manual = state.data.manualTokenAddresses.length;
        deriveAgeBuckets();
        refreshMonitoredPanelCounts();
        emit();
        await removeManualTokenRequest(address, token);
        await reloadConfigInternal(token);
        setNotice('Token removed');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to remove manual token');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async addBlockedToken(address: string, label?: string | null) {
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
        const result = await addBlockedTokenRequest(address, label, token);
        if (!isBlocked(address)) {
          state.data.blocklist = sortAddresses([...state.data.blocklist, { address, label: label ?? null }]);
          state.bars.blocklist = state.data.blocklist.length;
        }
        removeTokenEverywhere(address);
        applyBlockedFilters();
        await reloadConfigInternal(token);
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to block token');
      } finally {
        setBusy(false);
        emit();
      }
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
      emit();

      try {
        const result = await adminBlockTokenRequest(address, label, token);
        removeTokenEverywhere(address, { removeFromStarred: true });
        setNotice(result.message);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to permanently block token');
      } finally {
        setBusy(false);
        emit();
      }
    },
    async removeBlockedToken(address: string) {
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
        const result = await removeBlockedTokenRequest(address, token);
        state.data.blocklist = state.data.blocklist.filter((item) => item.address !== address);
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
