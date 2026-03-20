import { createAppState, type AddressItem, type AlertEntry, type AppState, type BucketSortCriterion, type BucketSortMode, type BucketSortWindow, type ManualTokenEntry, type MeteoraEntry, type MonitoredSortCriterion, type MonitoredSortMode, type MonitoredSortWindow, type PumpTokenEntry, type RemovalLogEntry } from '../state/app-state';
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
  type SessionUser,
  verifyLoginOtp as verifyLoginOtpRequest,
} from '../services/api/auth';
import {
  addManualToken as addManualTokenRequest,
  addBlockedToken as addBlockedTokenRequest,
  fetchConfig,
  patchConfig,
  removeManualToken as removeManualTokenRequest,
  removeBlockedToken as removeBlockedTokenRequest,
  syncConfig,
  type ConfigPayload,
} from '../services/api/config';
import { fetchDashboardMonitored, fetchPumpfunTokenMeta, reportMigratedToken, trackManualToken, type DashboardMonitoredToken } from '../services/api/catalog';
import { clearLegacyAuthToken } from '../utils/auth-storage';
import { loadSoundSettings, saveSoundSettings } from '../utils/sound-storage';
import {
  loadDismissedOldWeek,
  loadDismissedRecent,
  loadOldWeekRemovalLog,
  loadRecentRemovalLog,
  saveDismissedOldWeek,
  saveDismissedRecent,
  saveOldWeekRemovalLog,
  saveRecentRemovalLog,
} from '../utils/bar-storage';
import { bindSocketLifecycle, disconnectSocket, subscribePumpMint, unsubscribePumpMint } from '../services/socket/client';
import {
  normalizeInviteCode,
  validateChangePasswordInput,
  validateLoginCredentials,
  validateLoginOtpInput,
  validatePasswordResetConfirmInput,
  validatePasswordResetRequestInput,
  validateRegisterInput,
} from './auth-flow-utils';
import { validateInviteCode, type InviteValidationResponse } from '../services/api/invites';
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
const AUTH_ERROR_COOKIE_BLOCKED = 'Login succeeded, but the secure session cookie was not accepted. Check browser cookie/privacy settings and try again.';

const STANDARD_ALERT_COOLDOWN_MS = 60_000;
const SURGE_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const OLD_WEEK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HVNC_MAX_AGE_MS = 30 * 60 * 1000;
const PUMP_WINDOW_MS = 5 * 60 * 1000;
const PUMP_GC_INTERVAL_MS = 30 * 1000;
const PUMP_GC_INACTIVE_MS = 10 * 60 * 1000;
const PUMP_GC_LOW_MCAP = 4000;
const PUMP_GC_LOW_MCAP_TIME_MS = 8 * 60 * 1000;
const PUMP_TOAST_TTL_MS = 7 * 1000;
const PUMP_SILENCE_MIGRATION_MS = 30 * 1000;
const PUMP_SILENCE_MIGRATION_MIN_MCAP = 30000;
const OLD_SURGE_SESSION_DELTA_PCT = 50;
const REPEAT_LOCAL_ALERT_STEP_PCT = 40;
const CROSS_ALERT_BLOCK_MS = 2 * 60 * 1000;
const PUMP_IMAGE_TIMEOUT_MS = 5000;
const MONITORED_REFRESH_INTERVAL_MS = 10 * 1000;

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
  openAuthPanel(panel: 'change-password' | 'register' | 'invite-assistance' | 'password-reset' | 'email-verification' | 'password-change-success' | 'email-verified-success' | 'email-otp'): void;
  closeAuthPanel(): void;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  reloadConfig(): Promise<void>;
  saveMonitoringConfig(configs: Record<string, number | string>): Promise<void>;
  addManualToken(address: string, label?: string | null): Promise<void>;
  removeManualToken(address: string): Promise<void>;
  addBlockedToken(address: string, label?: string | null): Promise<void>;
  removeBlockedToken(address: string): Promise<void>;
  removePumpToken(mint: string): void;
  dismissRecentToken(address: string): void;
  dismissOldWeekToken(address: string): void;
  clearRecentRemovalLog(): void;
  clearOldWeekRemovalLog(): void;
  clearDismissedRecent(): void;
  clearDismissedOldWeek(): void;
  setRecentPage(page: number): void;
  setOldWeekPage(page: number): void;
  setRecentPerPage(perPage: number): void;
  setOldWeekPerPage(perPage: number): void;
  setManualSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setRecentSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow): void;
  setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow): void;
  setSoundEnabled(enabled: boolean): void;
  setSoundVolume(volume: number): void;
  toggleStarredToken(address: string): Promise<void>;
  startMonitoring(): void;
  stopMonitoring(): void;
  clearNotice(): void;
  clearError(): void;
  subscribe(listener: (state: AppState) => void): () => void;
}

export function createAppController(): AppController {
  const state = createAppState();
  clearLegacyAuthToken();
  const listeners = new Set<(state: AppState) => void>();
  hydrateSoundSettings();
  let authSubmitInFlight = false;
  let monitoringInterval: ReturnType<typeof setInterval> | null = null;
  let uptimeInterval: ReturnType<typeof setInterval> | null = null;
  let pumpGcInterval: ReturnType<typeof setInterval> | null = null;
  let monitoringPausedForAuthPanel = false;
  let monitoredRefreshInFlight = false;
  let startedAt: number | null = null;
  let starredPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let starredPersistRevision = 0;

  function writeConfigDebug(_stage: string, _extra: Record<string, unknown> = {}) {
    return;
  }

  function emit() {
    for (const listener of listeners) {
      listener(state);
    }
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

  function clearAuthUrl() {
    if (typeof window === 'undefined') {
      return;
    }
    const pathname = window.location.pathname || '/';
    const search = new URLSearchParams(window.location.search);
    if (pathname === '/auth/verify-email' || pathname === '/auth/reset-password' || search.has('mode') || search.has('token')) {
      window.history.replaceState({}, document.title, '/');
    }
  }

  function normalizeAuthError(error: unknown, mode: 'login' | 'restore') {
    const raw = error instanceof Error ? error.message : '';

    if (!raw) {
      return mode === 'login' ? 'Unable to sign in right now. Please try again.' : 'Unable to restore your session. Please login again.';
    }

    if (raw.includes('Invalid email or password')) {
      return 'Incorrect email or password. Check your credentials and try again.';
    }
    if (raw.includes('Account is deactivated')) {
      return 'This account is deactivated. Contact an administrator if you need access restored.';
    }
    if (raw.includes('Email not verified')) {
      return 'Your email is not verified yet. Check your inbox or request a new verification email.';
    }
    if (
      raw.includes('Too many failed attempts')
      || raw.includes('Too many authentication attempts')
    ) {
      const retryMatch = raw.match(/Try again in\s+(\d+)s\.?/i);
      if (retryMatch) {
        const seconds = Number(retryMatch[1]);
        const minutes = Math.max(1, Math.ceil(seconds / 60));
        return `Login temporarily locked. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
      }
      return 'Login temporarily locked. Try again in a few minutes.';
    }
    if (
      raw.includes('Token expired')
      || raw.includes('Invalid token')
      || raw.includes('Session revoked')
      || raw.includes('Authentication required')
      || raw.includes('User not found')
    ) {
      return 'Your saved session is no longer valid. Please login again.';
    }
    if (raw.includes('Network error:')) {
      return 'Unable to reach the server. Check your connection or API availability and try again.';
    }
    if (raw.includes('Internal server error')) {
      return 'The server could not complete authentication right now. Please try again shortly.';
    }

    return raw;
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
  function getConfigNumber(key: string, fallback: number) {
    const value = state.data.configs[key];
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function isConfigEnabled(key: string, fallback = true) {
    return String(state.data.configs[key] ?? (fallback ? 'on' : 'off')) !== 'off';
  }

  function getOldAlert1hThreshold() {
    return getConfigNumber('old-alert-1h-threshold', 100);
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
      case 'old-surge':
        return isConfigEnabled('alert-old-surge-enabled');
      case 'pumpfun-vol':
        return isConfigEnabled('alert-pumpfun-vol-enabled');
      case 'pumpfun-hvnc':
        return isConfigEnabled('alert-pumpfun-hvnc-enabled');
      default:
        return true;
    }
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

  async function persistUiConfigs(configs: Record<string, string | number>) {
    const token = state.session.token;
    if (!token) {
      return;
    }

    try {
      writeConfigDebug('persistUiConfigs:before-patch', { configs });
      const result = await patchConfig(configs, token);
      state.data.configs = { ...state.data.configs, ...result.configs };
      writeConfigDebug('persistUiConfigs:after-patch', { configs: result.configs });
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
        writeConfigDebug('persistStarredTokens:after-sync', {
          starredCount: result.starredTokens.length,
          syncedMinVol: result.configs?.['min-vol'],
        });
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
  function applyUiPreferencesFromConfigs() {
    state.ui.recentPerPage = Math.max(10, Math.floor(getConfigNumber('old-per-page', state.ui.recentPerPage || 30)));
    state.ui.oldWeekPerPage = Math.max(10, Math.floor(getConfigNumber('old-week-per-page', state.ui.oldWeekPerPage || 30)));
    state.ui.soundEnabled = String(state.data.configs['sound-mode'] ?? 'on') !== 'off';
    state.ui.soundVolume = clampUiVolume(getConfigNumber('sound-volume', Math.round(state.ui.soundVolume * 100)) / 100);
    syncRoutedPagination();
  }
  function persistBarStorage() {
    const scope = getStorageScope();
    saveDismissedRecent(scope, state.data.dismissedRecent);
    saveDismissedOldWeek(scope, state.data.dismissedOldWeek);
    saveRecentRemovalLog(scope, state.data.recentRemovalLog);
    saveOldWeekRemovalLog(scope, state.data.oldWeekRemovalLog);
  }

  function hydrateBarStorage() {
    const scope = getStorageScope();
    state.data.dismissedRecent = loadDismissedRecent(scope);
    state.data.dismissedOldWeek = loadDismissedOldWeek(scope);
    state.data.recentRemovalLog = loadRecentRemovalLog(scope);
    state.data.oldWeekRemovalLog = loadOldWeekRemovalLog(scope);
  }

  function isBlocked(address: string) {
    return state.data.blocklist.some((item) => item.address === address);
  }

  function removeAlertsForAddress(address: string) {
    state.data.alerts = state.data.alerts.filter((item) => item.address !== address);
    state.runtime.alerts = state.data.alerts.length;
    state.panels.alerts = state.data.alerts.length;
  }

  function isVisibleMonitoredToken(item: ManualTokenEntry) {
    if (item._userManual) {
      return true;
    }

    const mcap = item.mcap ?? 0;
    return !(mcap > 0 && mcap < 30000);
  }

  function refreshMonitoredPanelCounts() {
    state.panels.monitored = state.data.monitoredTokens.filter(isVisibleMonitoredToken).length;
    state.panels.alerts = state.data.alerts.length;
    state.runtime.alerts = state.data.alerts.length;
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

  function getMeteoraMinPool() {
    return getConfigNumber('meteora-min-pool', 5000);
  }

  function toHttpAssetUrl(url: string | null | undefined) {
    const value = String(url || '').trim();
    if (!value) {
      return null;
    }
    if (value.startsWith('ipfs://')) {
      return `https://ipfs.io/ipfs/${value.slice('ipfs://'.length)}`;
    }
    return value;
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
    token.vol5m = (token.vol5m || []).filter((point) => now - point.ts <= PUMP_WINDOW_MS);
  }

  function maybePersistPumpBondTarget(nextTarget: number) {
    if (!(nextTarget > 0)) {
      return;
    }
    state.pumpfun.bondTargetMcap = nextTarget;
    state.data.configs['pump-bond-mcap'] = Math.round(nextTarget);
    void persistUiConfigs({ 'pump-bond-mcap': Math.round(nextTarget) });
  }  function dismissPumpToast(id: string) {
    state.data.pumpToasts = state.data.pumpToasts.filter((item) => item.id !== id);
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

  function runPumpGarbageCollection() {
    const now = Date.now();
    const removed = new Set<string>();
    let migratedBySilence = 0;

    state.data.pumpTokens = state.data.pumpTokens.filter((token) => {
      if (token._migrated) {
        removed.add(token.mint);
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
        removed.add(token.mint);
        migratedBySilence += 1;
        return false;
      }

      const inactiveTooLong = lastTradeAt > 0 && now - lastTradeAt >= PUMP_GC_INACTIVE_MS;

      if (mcap > 0 && mcap < PUMP_GC_LOW_MCAP) {
        token._lowMcapSince = token._lowMcapSince || now;
      } else {
        token._lowMcapSince = null;
      }

      const lowMcapTooLong = Boolean(token._lowMcapSince && now - token._lowMcapSince >= PUMP_GC_LOW_MCAP_TIME_MS);
      if (inactiveTooLong || lowMcapTooLong) {
        removed.add(token.mint);
        return false;
      }

      return true;
    });

    for (const mint of removed) {
      unsubscribePumpMint(mint);
    }

    if (removed.size > 0) {
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
  }  function reportPumpMigration(token: PumpTokenEntry) {
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
    const vol5m = getPumpVolume5mTotal(token);
    const minVol = getPumpConfigNumber('pump-min-vol', 100000);
    const hvncMinVol = getConfigNumber('hvnc-min-vol', 300000);
    const ageMs = token.createdAt ? Date.now() - token.createdAt : Number.POSITIVE_INFINITY;
    const symbol = token.symbol || token.mint.slice(0, 6);

    if (isAlertKindEnabled('pumpfun-hvnc') && !token._hvncPumpFired && hvncMinVol > 0 && ageMs < HVNC_MAX_AGE_MS && vol5m >= hvncMinVol) {
      token._hvncPumpFired = true;
      pushAlert({
        id: `${token.mint}-${Date.now()}-pump-hvnc`,
        kind: 'pumpfun-hvnc',
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
        label: 'PUMP HVNC',
        isHvnc: true,
      });
      return;
    }

    if (isAlertKindEnabled('pumpfun-vol') && vol5m >= minVol && !token._alertFired) {
      token._alertFired = true;
      pushAlert({
        id: `${token.mint}-${Date.now()}-pump-vol`,
        kind: 'pumpfun-vol',
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
        label: 'PUMP VOL',
      });
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
        if (!data?.imageUrl) {
          return;
        }

        state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint
          ? { ...item, imageUrl: data.imageUrl, _imageResolved: true, _imageResolving: false }
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

  function createOrUpdatePumpToken(raw: Record<string, unknown>, mode: 'new' | 'trade') {
    const mint = String(raw.mint || '').trim();
    if (!mint || isBlocked(mint) || state.data.dismissedPump.includes(mint)) {
      return;
    }

    const now = Date.now();
    const solPriceUsd = state.pumpfun.solPriceUsd ?? 0;
    const existing = state.data.pumpTokens.find((item) => item.mint === mint);
    const token: PumpTokenEntry = existing ?? {
      mint,
      mintAddress: mint,
      pairAddress: typeof raw.pairAddress === 'string' && raw.pairAddress.trim() ? raw.pairAddress.trim() : null,
      metadataUri: typeof raw.uri === 'string' && raw.uri.trim() ? raw.uri.trim() : null,
      name: String(raw.name || mint.slice(0, 8)),
      symbol: String(raw.symbol || mint.slice(0, 6)),
      imageUrl: typeof raw.image === 'string' ? toHttpAssetUrl(raw.image) : null,
      createdAt: now,
      mcap: null,
      volTotal: 0,
      vol5m: [],
      hidden: false,
      _imageResolved: false,
      _imageResolving: false,
    };

    token.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : token.name;
    token.symbol = typeof raw.symbol === 'string' && raw.symbol.trim() ? raw.symbol.trim() : token.symbol;
    token.imageUrl = typeof raw.image === 'string' && raw.image.trim() ? toHttpAssetUrl(raw.image) : token.imageUrl;
    token.createdAt = token.createdAt ?? now;
    token.mintAddress = token.mintAddress || mint;
    token.pairAddress = typeof raw.pairAddress === 'string' && raw.pairAddress.trim() ? raw.pairAddress.trim() : token.pairAddress || null;
    token.metadataUri = typeof raw.uri === 'string' && raw.uri.trim() ? raw.uri.trim() : token.metadataUri || null;

    const usdMcap = Number(raw.usd_market_cap);
    const marketCapSol = Number(raw.marketCapSol);
    const vTokensInBondingCurve = Number(raw.vTokensInBondingCurve);
    const virtualSolReserves = Number(raw.virtualSolReserves);
    token.bondingCurveKey = typeof raw.bondingCurveKey === 'string' ? raw.bondingCurveKey : token.bondingCurveKey;
    if (Number.isFinite(vTokensInBondingCurve)) {
      token.vTokensInBondingCurve = vTokensInBondingCurve;
    }
    if (Number.isFinite(virtualSolReserves)) {
      token.virtualSolReserves = virtualSolReserves;
    }
    if (Number.isFinite(usdMcap) && usdMcap > 0) {
      token.mcap = usdMcap;
    } else if (Number.isFinite(marketCapSol) && marketCapSol > 0 && solPriceUsd > 0) {
      token.mcap = marketCapSol * solPriceUsd;
    } else if ((token.virtualSolReserves || 0) > 0 && (token.vTokensInBondingCurve || 0) > 0 && solPriceUsd > 0) {
      const priceUsd = ((token.virtualSolReserves || 0) / 1_000_000_000) / (token.vTokensInBondingCurve || 1) * solPriceUsd;
      token.mcap = priceUsd * 1_000_000_000;
    }

    if (mode === 'trade') {
      const solAmount = Number(raw.solAmount);
      const usdAmount = Number.isFinite(solAmount) && solAmount > 0 && solPriceUsd > 0 ? solAmount * solPriceUsd : 0;
      if (usdAmount > 0) {
        token.vol5m = [...(token.vol5m || []), { ts: now, usd: usdAmount }];
        token.volTotal = (token.volTotal || 0) + usdAmount;
      }
      prunePumpTokenWindow(token, now);
      token.lastTradeAt = now;
      token.hidden = false;
      subscribePumpMint(mint);
      maybeFirePumpAlert(token);
    }

    if (existing) {
      state.data.pumpTokens = state.data.pumpTokens.map((item) => item.mint === mint ? token : item);
    } else {
      state.data.pumpTokens = [...state.data.pumpTokens, token];
    }

    state.data.pumpTokens.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    refreshPumpPanelCounts();

    if (!token.imageUrl) {
      void resolvePumpTokenImage(mint);
    }
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

  function syncRoutedPagination() {
    state.ui.recentPage = clampPage(state.ui.recentPage, state.data.recentTokens.length, state.ui.recentPerPage);
    state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, state.data.oldWeekTokens.length, state.ui.oldWeekPerPage);
  }
  function deriveAgeBuckets() {
    const previousRecent = new Map(state.data.recentTokens.map((item) => [item.address, item]));
    const previousOldWeek = new Map(state.data.oldWeekTokens.map((item) => [item.address, item]));
    const recentDismissed = new Set(state.data.dismissedRecent);
    const oldWeekDismissed = new Set(state.data.dismissedOldWeek);

    const recentMin = getConfigNumber('old-mcap-min', 120000);
    const recentMax = getConfigNumber('old-mcap-max', 1000000);
    const oldWeekMin = getConfigNumber('old-week-mcap-min', 120000);
    const oldWeekMax = getConfigNumber('old-week-mcap-max', 5000000);
    const now = Date.now();

    const candidates = state.data.monitoredTokens.filter((item) => {
      if (item._userManual || isBlocked(item.address)) {
        return false;
      }
      return typeof item.createdAt === 'number' && item.createdAt > 0;
    });

    const nextRecent = candidates.filter((item) => {
      if (recentDismissed.has(item.address)) return false;
      const age = now - (item.createdAt || 0);
      if (!(age >= 0 && age < OLD_WEEK_MIN_AGE_MS)) {
        return false;
      }

      const mcap = item.mcap ?? 0;
      if (mcap <= 0) {
        return previousRecent.has(item.address);
      }

      return mcap >= recentMin && (recentMax <= 0 || mcap <= recentMax);
    });

    const recentAddresses = new Set(nextRecent.map((item) => item.address));
    const nextOldWeek = candidates.filter((item) => {
      if (oldWeekDismissed.has(item.address)) return false;
      const age = now - (item.createdAt || 0);
      if (age < OLD_WEEK_MIN_AGE_MS || recentAddresses.has(item.address)) {
        return false;
      }

      const mcap = item.mcap ?? 0;
      if (mcap <= 0) {
        return previousOldWeek.has(item.address);
      }

      return mcap >= oldWeekMin && (oldWeekMax <= 0 || mcap <= oldWeekMax);
    });

    for (const [address, token] of previousRecent) {
      if (recentAddresses.has(address) || recentDismissed.has(address)) continue;
      const age = now - (token.createdAt || 0);
      const mcap = token.mcap ?? 0;
      const reason = age >= OLD_WEEK_MIN_AGE_MS
        ? 'aged into Old Tokens 1 Week+'
        : age < 0
          ? 'age not yet valid for Recent'
          : mcap > 0 && (mcap < recentMin || (recentMax > 0 && mcap > recentMax))
            ? 'MCAP out of Recent range'
            : 'left Recent routing';
      logRemoval('recent', token, reason);
    }

    const oldWeekAddresses = new Set(nextOldWeek.map((item) => item.address));
    for (const [address, token] of previousOldWeek) {
      if (oldWeekAddresses.has(address) || oldWeekDismissed.has(address)) continue;
      const mcap = token.mcap ?? 0;
      const age = now - (token.createdAt || 0);
      const reason = age < OLD_WEEK_MIN_AGE_MS
        ? 'age no longer in Old Week bucket'
        : mcap > 0 && (mcap < oldWeekMin || (oldWeekMax > 0 && mcap > oldWeekMax))
          ? 'MCAP out of Old Week range'
          : 'left Old Week routing';
      logRemoval('oldWeek', token, reason);
    }

    state.data.recentTokens = nextRecent;
    state.data.oldWeekTokens = nextOldWeek;
    state.bars.recent = nextRecent.length;
    state.bars.oldWeek = nextOldWeek.length;
    syncRoutedPagination();
  }
  function applyBlockedFilters() {
    const blocked = new Set(state.data.blocklist.map((item) => item.address));
    if (blocked.size === 0) {
      deriveAgeBuckets();
      refreshMonitoredPanelCounts();
      refreshPumpPanelCounts();
      return;
    }

    state.data.monitoredTokens = state.data.monitoredTokens.filter((item) => !blocked.has(item.address));
    state.data.manualTokens = state.data.manualTokens.filter((item) => !blocked.has(item.address));
    state.data.recentTokens = state.data.recentTokens.filter((item) => !blocked.has(item.address));
    state.data.oldWeekTokens = state.data.oldWeekTokens.filter((item) => !blocked.has(item.address));
    state.data.pumpTokens = state.data.pumpTokens.filter((item) => !blocked.has(item.mint));
    state.data.recentPumpMigrations = state.data.recentPumpMigrations.filter((item) => !blocked.has(item.mint));
    state.data.alerts = state.data.alerts.filter((item) => !blocked.has(item.address));
    state.data.dismissedRecent = state.data.dismissedRecent.filter((address) => !blocked.has(address));
    state.data.dismissedOldWeek = state.data.dismissedOldWeek.filter((address) => !blocked.has(address));
    state.bars.manual = state.data.manualTokens.length;
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
    state.data.monitoredTokens = state.data.monitoredTokens.filter((item) => {
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

    state.data.manualTokens = state.data.manualTokens.filter((item) => item._userManual || state.data.monitoredTokens.some((tok) => tok.address === item.address));
    state.bars.manual = state.data.manualTokens.length;
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

  function passesAlertFilters(token: ManualTokenEntry) {
    const minVol = getConfigNumber('min-vol', 500);
    const minMcap = getConfigNumber('min-mcap', 10000);
    const maxMcap = getConfigNumber('max-mcap', 0);
    const volume5m = token.volume5m ?? 0;
    const mcap = token.mcap ?? 0;
    if (volume5m < minVol) return false;
    if (mcap > 0 && mcap < minMcap) return false;
    if (maxMcap > 0 && mcap > maxMcap) return false;
    return true;
  }

  function pushAlert(entry: AlertEntry) {
    if (isBlocked(entry.address) || !isAlertKindEnabled(entry.kind)) {
      return;
    }
    state.data.alerts = [entry, ...state.data.alerts].slice(0, 50);
    state.runtime.alerts = state.data.alerts.length;
    state.panels.alerts = state.data.alerts.length;
  }

  function maybeFireSpecialAlerts(token: ManualTokenEntry) {
    if (isBlocked(token.address)) {
      return;
    }

    const now = Date.now();
    if (isCrossAlertBlocked(token, now)) {
      return;
    }
    const symbol = token.symbol || token.label || token.address.slice(0, 8);
    const ageMs = token.createdAt ? now - token.createdAt : Number.POSITIVE_INFINITY;
    const hvncMinVol = getConfigNumber('hvnc-min-vol', 300000);

    if (isAlertKindEnabled('hvnc') && !token._hvncFired && hvncMinVol > 0 && ageMs < HVNC_MAX_AGE_MS && (token.volume24h ?? 0) >= hvncMinVol) {
      token._hvncFired = true;
      pushAlert({
        id: `${token.address}-${now}-hvnc`,
        kind: 'hvnc',
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
        pct: 0,
        label: 'HVNC',
        isHvnc: true,
      });
      setNotice(`HVNC alert: ${symbol}`);
    }

    const isOldRouted = state.data.recentTokens.some((item) => item.address === token.address)
      || state.data.oldWeekTokens.some((item) => item.address === token.address);

    if (isAlertKindEnabled('old-surge') && !token._oldSurgeFired && isOldRouted && ageMs >= SURGE_MIN_AGE_MS) {
      const pc1h = token.priceChange1h ?? null;
      const pc6h = token.priceChange6h ?? null;
      const oldAlert1hPct = getOldAlert1hThreshold();
      const oldAlert6hPct = getOldAlert6hThreshold();
      let pct = 0;
      let surgeWindow: '1H' | '6H' | null = null;
      const base1h = token._oldSurgeSessionBase1h;
      const base6h = token._oldSurgeSessionBase6h;

      if (token._oldSurgeSessionBase1h == null) {
        token._oldSurgeSessionBase1h = pc1h;
      }
      if (token._oldSurgeSessionBase6h == null) {
        token._oldSurgeSessionBase6h = pc6h;
      }

      const crossed6h = base6h != null && base6h < oldAlert6hPct && pc6h != null && pc6h >= oldAlert6hPct;
      const rose50AfterHot6h = base6h != null && base6h >= oldAlert6hPct && pc6h != null && pc6h >= base6h + OLD_SURGE_SESSION_DELTA_PCT;
      const crossed1h = base1h != null && base1h < oldAlert1hPct && pc1h != null && pc1h >= oldAlert1hPct;
      const rose50AfterHot1h = base1h != null && base1h >= oldAlert1hPct && pc1h != null && pc1h >= base1h + OLD_SURGE_SESSION_DELTA_PCT;

      if (crossed6h || rose50AfterHot6h) {
        pct = pc6h;
        surgeWindow = '6H';
      } else if (crossed1h || rose50AfterHot1h) {
        pct = pc1h;
        surgeWindow = '1H';
      }

      if (pct > 0) {
        token._oldSurgeFired = true;
        token.lastAlertAt = now;
        token._lastAlertKind = 'old-surge';
        pushAlert({
          id: `${token.address}-${now}-old-surge`,
          kind: 'old-surge',
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
          label: surgeWindow ? `PCHANGE ${surgeWindow}` : 'PCHANGE',
          isOldSurge: true,
        });
        setNotice(`Old token surge alert: ${symbol}`);
      }
    }
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

    if (token.lastAlertAt && now - token.lastAlertAt < STANDARD_ALERT_COOLDOWN_MS) {
      return;
    }

    const symbol = token.symbol || token.label || token.address.slice(0, 8);
    const mcapDeclining = previousMcap != null && previousMcap > 0 && currentMcap > 0 && currentMcap < previousMcap;
    let alert: AlertEntry | null = null;
    let firedKind: 'vol' | 'mcap' | null = null;

    if (previousVol != null && previousVol > 0) {
      const volChange = (currentVol - previousVol) / previousVol;
      const volPct = volChange * 100;
      const volEligible = isAlertKindEnabled('monitored-vol') && volChange >= threshold && passesAlertFilters(token) && !mcapDeclining;
      if (!volEligible) {
        token._volAlertAboveThreshold = false;
      }
      const canRepeatVol = token._lastVolAlertPct != null && volPct >= token._lastVolAlertPct + REPEAT_LOCAL_ALERT_STEP_PCT;
      if (volEligible && (!token._volAlertAboveThreshold || canRepeatVol)) {
        alert = {
          id: `${token.address}-${now}-vol`,
          kind: 'monitored-vol',
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
          prevVolume5m: previousVol,
          volume5m: token.volume5m ?? null,
          volume1h: token.volume1h ?? null,
          volume6h: token.volume6h ?? null,
          volume24h: token.volume24h ?? null,
          prevMcap: previousMcap,
          mcap: token.mcap ?? null,
          pct: volPct,
          label: 'VOL',
        };
        firedKind = 'vol';
      }
    }

    if (!alert && mcapThreshold > 0 && previousMcap != null && previousMcap > 0) {
      const mcapChange = (currentMcap - previousMcap) / previousMcap;
      const mcapPct = mcapChange * 100;
      const mcapEligible = isAlertKindEnabled('monitored-mcap') && mcapChange >= mcapThreshold && passesAlertFilters(token);
      if (!mcapEligible) {
        token._mcapAlertAboveThreshold = false;
      }
      const canRepeatMcap = token._lastMcapAlertPct != null && mcapPct >= token._lastMcapAlertPct + REPEAT_LOCAL_ALERT_STEP_PCT;
      if (mcapEligible && (!token._mcapAlertAboveThreshold || canRepeatMcap)) {
        alert = {
          id: `${token.address}-${now}-mcap`,
          kind: 'monitored-mcap',
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
          prevVolume5m: previousVol,
          volume5m: token.volume5m ?? null,
          volume1h: token.volume1h ?? null,
          volume6h: token.volume6h ?? null,
          volume24h: token.volume24h ?? null,
          prevMcap: previousMcap,
          mcap: token.mcap ?? null,
          pct: mcapPct,
          label: 'MCAP',
        };
        firedKind = 'mcap';
      }
    }

    if (alert) {
      token.lastAlertAt = now;
      if (firedKind === 'vol') {
        token._volAlertAboveThreshold = true;
        token._lastVolAlertPct = alert.pct;
        token._lastAlertKind = 'monitored-vol';
      } else if (firedKind === 'mcap') {
        token._mcapAlertAboveThreshold = true;
        token._lastMcapAlertPct = alert.pct;
        token._lastAlertKind = 'monitored-mcap';
      }
      pushAlert(alert);
      setNotice(`Local monitored alert: ${symbol}`);
    }
  }
  function rebuildTrackedState(payload: ConfigPayload, monitoredDashboardTokens: DashboardMonitoredToken[] = []) {
    const existing = new Map(state.data.monitoredTokens.map((item) => [item.address, item]));
    const blockedSet = new Set(payload.blocklist.map((item) => item.address));
    const dashboardByAddress = new Map(monitoredDashboardTokens.map((item) => [item.address, item]));

    function mergeDashboardFields(
      existingItem: ManualTokenEntry | undefined,
      dashboardItem: DashboardMonitoredToken | undefined,
      base: ManualTokenEntry,
    ) {
      const nextMcap = dashboardItem?.mcap ?? existingItem?.mcap ?? base.mcap ?? null;
      const nextVolume5m = dashboardItem?.volume5m ?? existingItem?.volume5m ?? base.volume5m ?? null;

      return {
        ...base,
        mintAddress: existingItem?.mintAddress ?? dashboardItem?.address ?? base.address,
        pairAddress: dashboardItem?.pairAddress ?? existingItem?.pairAddress ?? base.pairAddress ?? null,
        pairUrl: dashboardItem?.pairUrl ?? existingItem?.pairUrl ?? base.pairUrl ?? null,
        imageUrl: dashboardItem?.imageUrl ?? existingItem?.imageUrl ?? base.imageUrl ?? null,
        twitterUrl: dashboardItem?.twitterUrl ?? existingItem?.twitterUrl ?? base.twitterUrl ?? null,
        symbol: dashboardItem?.symbol ?? existingItem?.symbol ?? base.symbol ?? null,
        name: dashboardItem?.name ?? existingItem?.name ?? base.name ?? null,
        createdAt: dashboardItem?.tokenCreatedAt ?? existingItem?.createdAt ?? base.createdAt ?? null,
        mcap: nextMcap,
        priceUsd: dashboardItem?.priceUsd ?? existingItem?.priceUsd ?? base.priceUsd ?? null,
        volume5m: nextVolume5m,
        volume1h: dashboardItem?.volume1h ?? existingItem?.volume1h ?? base.volume1h ?? null,
        volume6h: dashboardItem?.volume6h ?? existingItem?.volume6h ?? base.volume6h ?? null,
        volume24h: dashboardItem?.volume24h ?? existingItem?.volume24h ?? base.volume24h ?? null,
        priceChange1h: dashboardItem?.priceChange1h ?? existingItem?.priceChange1h ?? base.priceChange1h ?? null,
        priceChange6h: dashboardItem?.priceChange6h ?? existingItem?.priceChange6h ?? base.priceChange6h ?? null,
        priceChange24h: dashboardItem?.priceChange24h ?? existingItem?.priceChange24h ?? base.priceChange24h ?? null,
        mcapDelta: dashboardItem?.mcapDelta ?? existingItem?.mcapDelta ?? base.mcapDelta ?? null,
        prevMcap: dashboardItem?.prevMcap ?? existingItem?.prevMcap ?? base.prevMcap ?? null,
        prevVolume5m: existingItem?.volume5m != null ? existingItem.volume5m : existingItem?.prevVolume5m ?? base.prevVolume5m ?? null,
        lastAlertAt: existingItem?.lastAlertAt ?? base.lastAlertAt ?? null,
        deadCycles: existingItem?.deadCycles ?? base.deadCycles ?? 0,
        _hvncFired: existingItem?._hvncFired ?? base._hvncFired,
        _oldSurgeFired: existingItem?._oldSurgeFired ?? base._oldSurgeFired,
        _oldSurgeSessionBase1h: existingItem?._oldSurgeSessionBase1h ?? base._oldSurgeSessionBase1h ?? null,
        _oldSurgeSessionBase6h: existingItem?._oldSurgeSessionBase6h ?? base._oldSurgeSessionBase6h ?? null,
        _volAlertAboveThreshold: existingItem?._volAlertAboveThreshold ?? base._volAlertAboveThreshold ?? false,
        _mcapAlertAboveThreshold: existingItem?._mcapAlertAboveThreshold ?? base._mcapAlertAboveThreshold ?? false,
        _lastVolAlertPct: existingItem?._lastVolAlertPct ?? base._lastVolAlertPct ?? null,
        _lastMcapAlertPct: existingItem?._lastMcapAlertPct ?? base._lastMcapAlertPct ?? null,
        _lastAlertKind: existingItem?._lastAlertKind ?? base._lastAlertKind ?? null,
      };
    }

    const alertCandidates = new Set<string>();

    const manualTokens = sortAddresses(payload.tokens)
      .filter((item) => !blockedSet.has(item.address))
      .map((item) => {
        const existingItem = existing.get(item.address);
        const dashboardItem = dashboardByAddress.get(item.address);
        if (existingItem) {
          alertCandidates.add(item.address);
        }
        return mergeDashboardFields(existingItem, dashboardItem, {
          ...existingItem,
          address: item.address,
          label: item.label ?? null,
          manual: true,
          _userManual: true,
        });
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
      monitoredMap.set(item.address, mergeDashboardFields(existingItem, item, {
        ...existingItem,
        address: item.address,
        label: existingItem?.label ?? item.symbol ?? 'Eligible',
        manual: false,
        _userManual: false,
      }));
    }
    state.data.manualTokens = manualTokens;
    state.data.monitoredTokens = [...monitoredMap.values()];
    state.data.recentTokens = [];
    state.data.oldWeekTokens = [];
    state.bars.manual = manualTokens.length;
    deriveAgeBuckets();
    if (state.runtime.mode === 'active' && alertCandidates.size > 0) {
      for (const token of state.data.monitoredTokens) {
        if (!alertCandidates.has(token.address)) continue;
        maybeFireSpecialAlerts(token);
        maybeFireLocalAlert(token);
      }
    }
    refreshMonitoredPanelCounts();
  }

  async function refreshMonitoredDashboard() {
    const token = state.session.token;
    if (!token || monitoredRefreshInFlight) {
      return;
    }

    monitoredRefreshInFlight = true;
    try {
      const monitoredDashboardTokens = await fetchDashboardMonitored(token);
      applyMonitoredDashboard(monitoredDashboardTokens);
      emit();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh monitored dashboard');
      emit();
    } finally {
      monitoredRefreshInFlight = false;
    }
  }

  function runMonitoringCycle() {
    state.runtime.cycle += 1;
    sweepMinMcapRemove();
    refreshMonitoredPanelCounts();
    computeUptimeLabel();
    void refreshMonitoredDashboard();
    emit();
  }

  function startMonitoringTimers() {
    if (monitoringInterval) return;
    state.runtime.mode = 'active';
    startedAt = Date.now();
    computeUptimeLabel();
    runMonitoringCycle();
    monitoringInterval = setInterval(runMonitoringCycle, MONITORED_REFRESH_INTERVAL_MS);
    pumpGcInterval = setInterval(() => {
      runPumpGarbageCollection();
      emit();
    }, PUMP_GC_INTERVAL_MS);
    uptimeInterval = setInterval(() => {
      computeUptimeLabel();
      emit();
    }, 1000);
  }

  function stopMonitoringTimers() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    if (uptimeInterval) clearInterval(uptimeInterval);
    if (pumpGcInterval) clearInterval(pumpGcInterval);
    monitoringInterval = null;
    uptimeInterval = null;
    pumpGcInterval = null;
    startedAt = null;
    state.runtime.mode = 'stopped';
    state.runtime.uptimeLabel = '0m';
  }

  function connectRealtime() {
    bindSocketLifecycle({
      onStatus(message) {
        state.ui.notice = message;
        emit();
      },
      onRevoked(reason) {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        setError(`Session revoked by server: ${reason}`);
        emit();
      },
      onPumpStatus(payload) {
        state.pumpfun.connected = Boolean(payload.connected);
        state.pumpfun.statusLabel = state.pumpfun.connected ? 'connected' : 'disconnected';
        emit();
      },
      onSolPrice(payload) {
        if (state.runtime.mode !== 'active') {
          return;
        }
        const price = Number(payload.price);
        if (Number.isFinite(price) && price > 0) {
          state.pumpfun.solPriceUsd = price;
        }
        emit();
      },
      onPumpNewToken(payload) {
        if (state.runtime.mode !== 'active') {
          return;
        }
        createOrUpdatePumpToken(payload, 'new');
        const mint = String(payload.mint || '').trim();
        if (mint) {
          subscribePumpMint(mint);
        }
        emit();
      },
      onPumpTrade(payload) {
        if (state.runtime.mode !== 'active') {
          return;
        }
        createOrUpdatePumpToken(payload, 'trade');
        emit();
      },
      onPumpMigrate(payload) {
        if (state.runtime.mode !== 'active') {
          return;
        }
        const mint = String(payload.mint || '').trim();
        if (!mint) return;
        const token = state.data.pumpTokens.find((item) => item.mint === mint);
        if (!token || token._migrated) return;
        token._migrated = true;
        recordPumpMigration(token);
        reportPumpMigration(token);
        enqueuePumpToast(token);
        state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== mint);
        refreshPumpPanelCounts();
        setNotice(`PumpFun migration: ${token.symbol || mint.slice(0, 6)}`);
        emit();
      },
    });
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
    connectRealtime();
  }

  function clearSession() {
    state.session.status = 'anonymous';
    state.session.token = null;
    state.session.username = null;
    state.session.email = null;
    state.session.role = null;
    state.session.isEmailVerified = false;
    state.session.emailVerifiedAt = null;
    state.runtime.cycle = 0;
    state.runtime.alerts = 0;
    state.panels.alerts = 0;
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
      monitoredTokens: [],
      manualTokens: [],
      recentTokens: [],
      oldWeekTokens: [],
      dismissedRecent: [],
      dismissedOldWeek: [],
      dismissedPump: [],
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
    };
    state.bars.manual = 0;
    state.bars.recent = 0;
    state.bars.oldWeek = 0;
    state.bars.blocklist = 0;
    state.panels.monitored = 0;
    state.ui.authPanel = 'none';
    state.ui.pendingVerificationEmail = null;
    state.ui.pendingPasswordResetToken = null;
    state.ui.pendingLoginOtpChallengeToken = null;
    state.ui.pendingLoginOtpEmailHint = null;
    state.ui.recentPage = 0;
    state.ui.oldWeekPage = 0;
    state.ui.recentPerPage = 30;
    state.ui.oldWeekPerPage = 30;
    state.ui.manualSorts = getDefaultBucketSorts('manual');
    state.ui.recentSorts = getDefaultBucketSorts('recent');
    state.ui.oldWeekSorts = getDefaultBucketSorts('old-week');
    state.ui.monitoredSorts = getDefaultMonitoredSorts();
    hydrateSoundSettings();
  }

  function applyMonitoredDashboard(monitoredDashboardTokens: DashboardMonitoredToken[] = [], manualTokensOverride?: Array<{ address: string; label?: string | null }>) {
    const manualPayload: ConfigPayload = {
      configs: state.data.configs,
      tokens: (manualTokensOverride ?? state.data.manualTokens.map((item) => ({ address: item.address, label: item.label ?? null }))),
      blocklist: state.data.blocklist.map((item) => ({ address: item.address, label: item.label ?? null })),
      starredTokens: state.data.starredTokens.map((address) => ({ address })),
    };

    for (const item of monitoredDashboardTokens) {
      if (!item?.address || !item.meteora) continue;
      state.data.meteoraByAddress[item.address] = {
        ...(state.data.meteoraByAddress[item.address] || { history: [] }),
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

    state.configSummary.eligibleCatalogTokens = monitoredDashboardTokens.length;
    state.data.eligibleCatalogTokens = monitoredDashboardTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
    rebuildTrackedState(manualPayload, monitoredDashboardTokens);
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
    writeConfigDebug('applyConfig', {
      loadedMinVol: payload.configs?.['min-vol'],
      configKeys: Object.keys(payload.configs || {}),
    });
    state.pumpfun.bondTargetMcap = getConfigNumber('pump-bond-mcap', state.pumpfun.bondTargetMcap || 35000);
    applyUiPreferencesFromConfigs();
    persistSoundSettings();
    state.data.blocklist = sortAddresses(payload.blocklist);
    state.data.starredTokens = payload.starredTokens.map((item) => item.address).sort((a, b) => a.localeCompare(b));
    state.data.alerts = state.data.alerts.filter((item) => !isBlocked(item.address));
    state.bars.blocklist = payload.blocklist.length;
    applyMonitoredDashboard(monitoredDashboardTokens, payload.tokens);
    refreshPumpPanelCounts();
  }

  async function reloadConfigInternal(token: string) {
    const payload = await fetchConfig(token);
    let monitoredDashboardTokens: DashboardMonitoredToken[] = [];

    try {
      monitoredDashboardTokens = await fetchDashboardMonitored(token);
    } catch (error) {
      writeConfigDebug('reloadConfigInternal:dashboard-failed', {
        error: error instanceof Error ? error.message : 'unknown_dashboard_error',
      });
    }

    writeConfigDebug('reloadConfigInternal:fetched', {
      fetchedMinVol: payload.configs?.['min-vol'],
    });
    applyConfig(payload, monitoredDashboardTokens);
  }

  async function handleAuthRouteIntent() {
    if (typeof window === 'undefined') {
      return;
    }

    const pathname = window.location.pathname || '/';
    const search = new URLSearchParams(window.location.search);
    const token = String(search.get('token') || '').trim();
    const mode = String(search.get('mode') || '').trim();
    const wantsVerify = pathname === '/auth/verify-email' || mode === 'verify-email';
    const wantsReset = pathname === '/auth/reset-password' || mode === 'reset-password';

    if (wantsVerify) {
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
        if (state.session.status === 'authenticated') {
          applySession(result.user);
        }
        state.ui.authPanel = 'email-verified-success';
        setNotice(result.message || 'Email verified successfully.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Email verification failed');
      } finally {
        clearAuthUrl();
        setBusy(false);
        emit();
      }

      return;
    }

    if (wantsReset) {
      state.ui.pendingPasswordResetToken = token || null;
      state.ui.authPanel = 'password-reset';
      setError(token ? null : 'Reset link is missing or invalid.');
      setNotice(token ? 'Set a new password to finish the reset.' : null);
      clearAuthUrl();
      emit();
    }
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    clearNotice() {
      state.ui.notice = null;
      state.ui.error = null;
      emit();
    },
    clearError() {
      if (!state.ui.error) {
        return;
      }
      state.ui.error = null;
      state.ui.loginErrorCount = 0;
      emit();
    },
    openAuthPanel(panel: 'change-password' | 'register' | 'invite-assistance' | 'password-reset' | 'email-verification' | 'password-change-success' | 'email-verified-success' | 'email-otp') {
      if (panel === 'change-password') {
        monitoringPausedForAuthPanel = state.runtime.mode === 'active';
        if (monitoringPausedForAuthPanel) {
          stopMonitoringTimers();
        }
        state.ui.error = null;
        state.ui.notice = null;
      }
      state.ui.authPanel = panel;
      emit();
    },
    closeAuthPanel() {
      if (state.ui.authPanel === 'none') {
        return;
      }
      const shouldResumeMonitoring = state.ui.authPanel === 'change-password'
        && monitoringPausedForAuthPanel
        && state.session.status === 'authenticated';
      state.ui.authPanel = 'none';
      state.ui.pendingVerificationEmail = null;
      state.ui.pendingPasswordResetToken = null;
      state.ui.pendingLoginOtpChallengeToken = null;
      state.ui.pendingLoginOtpEmailHint = null;
      monitoringPausedForAuthPanel = false;
      if (shouldResumeMonitoring) {
        startMonitoringTimers();
      }
      emit();
    },
    removePumpToken(mint: string) {
      if (!state.data.dismissedPump.includes(mint)) {
        state.data.dismissedPump = [...state.data.dismissedPump, mint];
      }
      state.data.pumpTokens = state.data.pumpTokens.filter((item) => item.mint !== mint);
      unsubscribePumpMint(mint);
      refreshPumpPanelCounts();
      setNotice('PumpFun token removed from the live panel for this session.');
      emit();
    },
    dismissRecentToken(address: string) {
      if (!state.data.dismissedRecent.includes(address)) {
        state.data.dismissedRecent = [...state.data.dismissedRecent, address];
        state.data.recentTokens = state.data.recentTokens.filter((item) => item.address !== address);
        state.bars.recent = state.data.recentTokens.length;
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Recent token dismissed.');
        emit();
      }
    },
    dismissOldWeekToken(address: string) {
      if (!state.data.dismissedOldWeek.includes(address)) {
        state.data.dismissedOldWeek = [...state.data.dismissedOldWeek, address];
        state.data.oldWeekTokens = state.data.oldWeekTokens.filter((item) => item.address !== address);
        state.bars.oldWeek = state.data.oldWeekTokens.length;
        syncRoutedPagination();
        persistBarStorage();
        setNotice('Old Week token dismissed.');
        emit();
      }
    },
    clearRecentRemovalLog() {
      state.data.recentRemovalLog = [];
      persistBarStorage();
      emit();
    },
    clearOldWeekRemovalLog() {
      state.data.oldWeekRemovalLog = [];
      persistBarStorage();
      emit();
    },
    clearDismissedRecent() {
      state.data.dismissedRecent = [];
      deriveAgeBuckets();
      persistBarStorage();
      setNotice('Recent dismissed set cleared.');
      emit();
    },
    clearDismissedOldWeek() {
      state.data.dismissedOldWeek = [];
      deriveAgeBuckets();
      persistBarStorage();
      setNotice('Old Week dismissed set cleared.');
      emit();
    },
    setRecentPage(page: number) {
      state.ui.recentPage = clampPage(page, state.data.recentTokens.length, state.ui.recentPerPage);
      emit();
    },
    setOldWeekPage(page: number) {
      state.ui.oldWeekPage = clampPage(page, state.data.oldWeekTokens.length, state.ui.oldWeekPerPage);
      emit();
    },
    setRecentPerPage(perPage: number) {
      state.ui.recentPerPage = Math.max(10, Math.floor(perPage) || 30);
      state.ui.recentPage = clampPage(state.ui.recentPage, state.data.recentTokens.length, state.ui.recentPerPage);
      state.data.configs['old-per-page'] = state.ui.recentPerPage;
      void persistUiConfigs({ 'old-per-page': state.ui.recentPerPage });
      emit();
    },
    setOldWeekPerPage(perPage: number) {
      state.ui.oldWeekPerPage = Math.max(10, Math.floor(perPage) || 30);
      state.ui.oldWeekPage = clampPage(state.ui.oldWeekPage, state.data.oldWeekTokens.length, state.ui.oldWeekPerPage);
      state.data.configs['old-week-per-page'] = state.ui.oldWeekPerPage;
      void persistUiConfigs({ 'old-week-per-page': state.ui.oldWeekPerPage });
      emit();
    },
    setManualSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.manualSorts = toggleSortCriterion(
        state.ui.manualSorts,
        normalizeBucketCriterion(mode, window),
      );
      emit();
    },
    setRecentSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.recentSorts = toggleSortCriterion(
        state.ui.recentSorts,
        normalizeBucketCriterion(mode, window),
      );
      emit();
    },
    setOldWeekSort(mode: BucketSortMode, window?: BucketSortWindow) {
      state.ui.oldWeekSorts = toggleSortCriterion(
        state.ui.oldWeekSorts,
        normalizeBucketCriterion(mode, window),
      );
      emit();
    },
    setMonitoredSort(mode: MonitoredSortMode, window?: MonitoredSortWindow) {
      state.ui.monitoredSorts = toggleSortCriterion(
        state.ui.monitoredSorts,
        normalizeMonitoredCriterion(mode, window),
      );
      emit();
    },
    setSoundEnabled(enabled: boolean) {
      state.ui.soundEnabled = enabled;
      state.data.configs['sound-mode'] = enabled ? 'on' : 'off';
      persistSoundSettings();
      void persistUiConfigs({ 'sound-mode': enabled ? 'on' : 'off' });
      emit();
    },
    async toggleStarredToken(address: string) {
      const wasStarred = state.data.starredTokens.includes(address);
      state.data.starredTokens = wasStarred
        ? state.data.starredTokens.filter((item) => item !== address)
        : [...state.data.starredTokens, address].sort((a, b) => a.localeCompare(b));
      emit();
      queueStarredTokensPersist();
    },
    setSoundVolume(volume: number) {
      const nextVolume = clampUiVolume(volume);
      state.ui.soundVolume = nextVolume;
      state.data.configs['sound-volume'] = Math.round(nextVolume * 100);
      persistSoundSettings();
      void persistUiConfigs({ 'sound-volume': Math.round(nextVolume * 100) });
      emit();
    },
    startMonitoring() {
      startMonitoringTimers();
      emit();
    },
    stopMonitoring() {
      stopMonitoringTimers();
      emit();
    },
    async init() {
      setBusy(true);
      setError(null);
      setNotice(AUTH_NOTICE_RESTORING);
      emit();

      try {
        const session = await fetchCurrentSession();
        applySession(session.user);
        await reloadConfigInternal(COOKIE_SESSION_MARKER);
        setNotice(AUTH_NOTICE_SESSION_RESTORED);
      } catch (error) {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        state.ui.loginErrorCount = 0;
        const message = normalizeAuthError(error, 'restore');
        if (message.includes('no longer valid') || message.includes('Unable to restore')) {
          setNotice(AUTH_NOTICE_NO_SESSION);
          setError(null);
        } else {
          setError(message);
        }
      } finally {
        setBusy(false);
        emit();
      }

      await handleAuthRouteIntent();
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
        if (result.otpRequired && result.challengeToken) {
          disconnectSocket();
          stopMonitoringTimers();
          clearSession();
          state.ui.pendingLoginOtpChallengeToken = result.challengeToken;
          state.ui.pendingLoginOtpEmailHint = result.otpEmailHint || validated.email;
          state.ui.authPanel = 'email-otp';
          state.ui.loginErrorCount = 0;
          setNotice(result.message || 'Verification code sent. Check your email to finish signing in.');
          return;
        }
        const session = await fetchCurrentSession();
        applySession(session.user);
        await reloadConfigInternal(COOKIE_SESSION_MARKER);
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
        applySession(result.user);
        await reloadConfigInternal(COOKIE_SESSION_MARKER);
        state.ui.loginErrorCount = 0;
        setNotice(result.message || AUTH_NOTICE_LOGIN_SUCCESS);
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
        state.ui.pendingLoginOtpChallengeToken = result.challengeToken || challengeToken;
        state.ui.pendingLoginOtpEmailHint = result.otpEmailHint || state.ui.pendingLoginOtpEmailHint;
        setNotice(result.message || 'A new verification code has been sent.');
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
        state.ui.pendingVerificationEmail = validated.input.email;
        state.ui.authPanel = 'email-verification';
        setNotice(result.verificationEmailError
          ? 'Account created, but the verification email could not be sent. Fix email delivery and resend.'
          : result.emailVerificationRequired
            ? 'Account created. Check your inbox to verify your email.'
            : 'Account created. Workspace synced.');
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
        setNotice(result.message || 'Verification email sent.');
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
        setNotice(result.message || 'Password reset email sent.');
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
        if (token) {
          await logout(token);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Logout failed');
      } finally {
        disconnectSocket();
        stopMonitoringTimers();
        clearSession();
        setBusy(false);
        setNotice('Logged out.');
        emit();
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

      setBusy(true);
      setError(null);
      setNotice('Saving monitoring config...');
      emit();

      try {
        writeConfigDebug('saveMonitoringConfig:before-patch', {
          outgoingConfigs: configs,
          outgoingMinVol: configs['min-vol'],
        });
        const patchResult = await patchConfig(configs, token);
        writeConfigDebug('saveMonitoringConfig:after-patch', {
          outgoingMinVol: configs['min-vol'],
          responseMinVol: patchResult.configs?.['min-vol'],
        });
        state.data.configs = { ...state.data.configs, ...patchResult.configs };
        applyUiPreferencesFromConfigs();
        persistSoundSettings();
        sweepMinMcapRemove();
        deriveAgeBuckets();
        setNotice('Monitoring config updated.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to save config');
      } finally {
        setBusy(false);
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

      const existingManual = state.data.manualTokens.find((item) => item.address === normalizedAddress);
      const existingTracked = state.data.monitoredTokens.find((item) => item.address === normalizedAddress);
      const nextManual: ManualTokenEntry = {
        ...(existingTracked || existingManual || {}),
        address: normalizedAddress,
        label: label ?? existingTracked?.label ?? existingManual?.label ?? null,
        manual: true,
        _userManual: true,
      };

      state.data.manualTokens = state.data.manualTokens.some((item) => item.address === normalizedAddress)
        ? state.data.manualTokens.map((item) => item.address === normalizedAddress ? { ...item, ...nextManual } : item)
        : [...state.data.manualTokens, nextManual];

      state.data.monitoredTokens = state.data.monitoredTokens.some((item) => item.address === normalizedAddress)
        ? state.data.monitoredTokens.map((item) => item.address === normalizedAddress ? { ...item, ...nextManual } : item)
        : [...state.data.monitoredTokens, nextManual];

      state.configSummary.manualTokens = state.data.manualTokens.length;
      state.bars.manual = state.data.manualTokens.length;
      refreshMonitoredPanelCounts();
      deriveAgeBuckets();
      emit();

      try {
        const result = await addManualTokenRequest(normalizedAddress, label ?? null, token);
        if (result?.token) {
          state.data.manualTokens = state.data.manualTokens.map((item) => item.address === normalizedAddress
            ? { ...item, label: result.token.label ?? item.label ?? null }
            : item);
        }
        await trackManualToken(normalizedAddress, token);
        await reloadConfigInternal(token);
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
        state.data.manualTokens = state.data.manualTokens.filter((item) => item.address !== address);
        state.data.monitoredTokens = state.data.monitoredTokens.map((item) => item.address === address ? { ...item, manual: false, _userManual: false } : item);
        state.configSummary.manualTokens = state.data.manualTokens.length;
        state.bars.manual = state.data.manualTokens.length;
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
        state.data.monitoredTokens = state.data.monitoredTokens.filter((item) => item.address !== address);
        state.data.manualTokens = state.data.manualTokens.filter((item) => item.address !== address);
        removeAlertsForAddress(address);
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
