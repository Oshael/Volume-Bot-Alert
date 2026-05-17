import './styles/local-fonts.css';
import './styles/app.css';
import { playAlertSound, playMigrateSound, primeAlertAudio } from './services/alerts/sound';
import { maybeNotifyAlert, resetBrowserNotificationSession } from './services/alerts/browser-notifications';
import { updateLivePresence } from './services/socket/client';
import { isProfileAuthPanel, type AppState } from './state/app-state';
import { createAppController, type AppRenderRegion } from './state/app-controller';
import { renderAppShell } from './ui/app-shell';
import {
  installRuntimePerfDebugConsole,
  isRuntimePerfDebugEnabled,
  measureRuntimePerf,
  observeRuntimeLongTasks,
  readRuntimePerfMemory,
  recordRuntimePerfDebugEntry,
} from './utils/runtime-perf-debug';

const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('App root #app was not found.');
}

const root: HTMLDivElement = rootElement;

const controller = createAppController();
const playedAlertIds = new Set<string>();
const handledBrowserNotificationAlertIds = new Set<string>();
const playedPumpToastIds = new Set<string>();
const pendingAlertSoundIds = new Set<string>();
const pendingPumpToastSoundIds = new Set<string>();
const HIDDEN_RUNTIME_STOP_MS = 20 * 60 * 1000;
const LIVE_PRESENCE_HEARTBEAT_MS = 15 * 1000;
const PERF_DEBUG_SAMPLE_INTERVAL_MS = 10 * 1000;
const FOREGROUND_STATE_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
let pendingState: AppState | null = null;
let pendingDirtyRegions: Set<AppRenderRegion> | null = null;
let hiddenPendingState: AppState | null = null;
let hiddenDirtyRegions: Set<AppRenderRegion> | null = null;
let latestState: AppState | null = null;
let lastObservedSessionStatus: AppState['session']['status'] | null = null;
let lastObservedAuthPanel: AppState['ui']['authPanel'] | null = null;
let lastObservedAuthModalKey: string | null = null;
let lastObservedRouteKey: string | null = null;
let suppressNextFocusFlush = false;
let interactionLockUntil = 0;
let currentListInteractionZone: HTMLElement | null = null;
let restoreRenderQueued = false;
let isDocumentHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
let hiddenSinceAt: number | null = isDocumentHidden ? Date.now() : null;
let hiddenRuntimeStopTimer: ReturnType<typeof setTimeout> | null = null;
let hiddenMonitoringWasActive = false;
let hiddenAutoStopTriggered = false;
let lastLivePresenceSignature: string | null = null;
let lastForegroundStateRefreshAt = 0;
let foregroundStateRefreshInFlight = false;
let suppressCatchupAlertAudioUntil = 0;
let suppressCatchupAlertCreatedBefore = 0;
let browserNotificationActiveSince = Date.now();
let lastBrowserNotificationRuntimeActive = false;
let lastBrowserNotificationsEnabled = false;

const FULL_LIST_INTERACTION_LOCK_SELECTOR = '.monitored-list, .bid-zone-list, .pump-list, .pump-migration-strip, .alerts-list';
const TABLE_INTERACTION_LOCK_ZONE_SELECTOR = [
  '.token-actions-inline',
  '.action-col',
  '.bucket-footer',
  '.compact-search',
  '[data-sort-wrap]',
  '[data-trade-wrap]',
  'button',
  'a',
  'input',
  'select',
  'textarea',
  '[data-action]',
].join(', ');

controller.setDocumentHidden(isDocumentHidden);
installRuntimePerfDebugConsole();

function isRuntimePerfDebugActive(state: AppState | null = latestState) {
  return Boolean(state?.session.role === 'admin' && isRuntimePerfDebugEnabled());
}

function formatDirtyRegions(dirtyRegions: ReadonlySet<AppRenderRegion>) {
  return dirtyRegions.has('all') ? 'all' : [...dirtyRegions].sort().join(',');
}

function buildRuntimePerfSample(state: AppState) {
  return {
    workspace: state.ui.workspace,
    runtimeMode: state.runtime.mode,
    trackedTokens: Object.keys(state.data.trackedTokensByAddress).length,
    monitored: state.data.monitoredTokenAddresses.length,
    manual: state.data.manualTokenAddresses.length,
    recent: state.data.recentTokenAddresses.length,
    oldWeek: state.data.oldWeekTokenAddresses.length,
    recentHead: state.data.recentTokenAddresses.slice(0, 8),
    oldWeekHead: state.data.oldWeekTokenAddresses.slice(0, 8),
    alerts: state.data.alerts.length,
    pumpTokens: state.data.pumpTokens.length,
    pumpToasts: state.data.pumpToasts.length,
    sparklines: Object.keys(state.data.sparklineByAddress).length,
    meteora: Object.keys(state.data.meteoraByAddress).length,
    pendingRender: Boolean(pendingState),
    pendingRegions: pendingDirtyRegions ? formatDirtyRegions(pendingDirtyRegions) : '',
  };
}

function recordRestoreLifecycleDebug(label: string, meta: Record<string, unknown> = {}) {
  const active = latestState ? isRuntimePerfDebugActive(latestState) : isRuntimePerfDebugEnabled();
  if (!active) {
    return;
  }

  recordRuntimePerfDebugEntry({
    ts: Date.now(),
    kind: 'sample',
    label,
    meta: {
      ...(latestState ? buildRuntimePerfSample(latestState) : {}),
      visibilityState: document.visibilityState,
      ...meta,
    },
    memory: readRuntimePerfMemory(),
  }, active);
}

observeRuntimeLongTasks(() => isRuntimePerfDebugActive());

function isEditingInteractiveField() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement)) {
    return false;
  }

  const isReadOnlyField = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? active.readOnly : false;
  if (active.disabled || isReadOnlyField) {
    return false;
  }

  return Boolean(active.closest('#app'));
}

function syncAudioSideEffects(state: AppState) {
  for (const alert of state.data.alerts) {
    if (playedAlertIds.has(alert.id) || pendingAlertSoundIds.has(alert.id)) {
      continue;
    }

    if (!isDocumentHidden
      && suppressCatchupAlertAudioUntil > Date.now()
      && Number(alert.createdAt) > 0
      && Number(alert.createdAt) <= suppressCatchupAlertCreatedBefore) {
      playedAlertIds.add(alert.id);
      continue;
    }

    const attemptedWhileHidden = isDocumentHidden;
    pendingAlertSoundIds.add(alert.id);
    void playAlertSound(alert, {
      enabled: state.ui.soundEnabled,
      volume: state.ui.soundVolume,
      scope: state.session.email || state.session.username || 'anonymous',
      configs: state.data.configs,
    })
      .then((result) => {
        if (result !== 'blocked' || attemptedWhileHidden) {
          playedAlertIds.add(alert.id);
        }
      })
      .finally(() => {
        pendingAlertSoundIds.delete(alert.id);
      });
  }

  for (const toast of state.data.pumpToasts) {
    if (playedPumpToastIds.has(toast.id) || pendingPumpToastSoundIds.has(toast.id)) {
      continue;
    }

    const attemptedWhileHidden = isDocumentHidden;
    pendingPumpToastSoundIds.add(toast.id);
    void playMigrateSound({
      enabled: state.ui.soundEnabled,
      volume: state.ui.soundVolume,
    })
      .then((result) => {
        if (result !== 'blocked' || attemptedWhileHidden) {
          playedPumpToastIds.add(toast.id);
        }
      })
      .finally(() => {
        pendingPumpToastSoundIds.delete(toast.id);
      });
  }

  const liveIds = new Set(state.data.alerts.map((alert) => alert.id));
  for (const id of [...playedAlertIds]) {
    if (!liveIds.has(id)) {
      playedAlertIds.delete(id);
    }
  }

  const liveToastIds = new Set(state.data.pumpToasts.map((toast) => toast.id));
  for (const id of [...playedPumpToastIds]) {
    if (!liveToastIds.has(id)) {
      playedPumpToastIds.delete(id);
    }
  }
}

function syncBrowserNotificationSideEffects(state: AppState) {
  const runtimeActive = state.session.status === 'authenticated' && state.runtime.mode === 'active';
  const notificationsEnabled = state.ui.browserNotifications.enabled;

  if (!runtimeActive) {
    lastBrowserNotificationRuntimeActive = false;
    return;
  }

  if (!lastBrowserNotificationRuntimeActive) {
    browserNotificationActiveSince = Date.now();
    for (const alert of state.data.alerts) {
      handledBrowserNotificationAlertIds.add(alert.id);
    }
  }
  lastBrowserNotificationRuntimeActive = true;

  if (!notificationsEnabled) {
    lastBrowserNotificationsEnabled = false;
    return;
  }

  if (!lastBrowserNotificationsEnabled) {
    for (const alert of state.data.alerts) {
      handledBrowserNotificationAlertIds.add(alert.id);
    }
    lastBrowserNotificationsEnabled = true;
    return;
  }

  for (const alert of state.data.alerts) {
    if (handledBrowserNotificationAlertIds.has(alert.id)) {
      continue;
    }

    if (Number(alert.createdAt) > 0 && Number(alert.createdAt) <= browserNotificationActiveSince) {
      handledBrowserNotificationAlertIds.add(alert.id);
      continue;
    }

    maybeNotifyAlert(alert, {
      enabled: notificationsEnabled,
      notifyWhenVisible: state.ui.browserNotifications.notifyWhenVisible,
      documentHidden: isDocumentHidden,
      configs: state.data.configs,
    });
    handledBrowserNotificationAlertIds.add(alert.id);
  }

  const liveIds = new Set(state.data.alerts.map((alert) => alert.id));
  for (const id of [...handledBrowserNotificationAlertIds]) {
    if (!liveIds.has(id)) {
      handledBrowserNotificationAlertIds.delete(id);
    }
  }
}

function isInteractionLocked() {
  return Date.now() < interactionLockUntil;
}

function isListInteractionLocked() {
  if (!currentListInteractionZone?.isConnected) {
    currentListInteractionZone = null;
    return false;
  }

  return true;
}

function isSortMenuOpen() {
  return Boolean(root.querySelector('[data-sort-wrap].open'));
}

function getBotSettingsBrowserNotificationsRenderKey(state: AppState) {
  return state.ui.authPanel === 'bot-settings' ? state.ui.browserNotifications : null;
}

function getAuthModalRenderKey(state: AppState) {
  if (state.ui.authPanel === 'none') {
    return null;
  }

  return JSON.stringify({
    panel: state.ui.authPanel,
    busy: state.ui.busy,
    error: state.ui.error,
    notice: state.ui.notice,
    pendingVerificationEmail: state.ui.pendingVerificationEmail,
    pendingPasswordResetToken: state.ui.pendingPasswordResetToken,
    pendingLoginOtpChallengeToken: state.ui.pendingLoginOtpChallengeToken,
    pendingLoginOtpEmailHint: state.ui.pendingLoginOtpEmailHint,
    sessionStatus: state.session.status,
    sessionEmail: state.session.email,
    sessionUsername: state.session.username,
    accessStatus: isProfileAuthPanel(state.ui.authPanel) ? state.session.accessStatus : null,
    accessExpiresAt: isProfileAuthPanel(state.ui.authPanel) ? state.session.accessExpiresAt : null,
    accessDaysRemaining: isProfileAuthPanel(state.ui.authPanel) ? state.session.accessDaysRemaining : null,
    accessSource: isProfileAuthPanel(state.ui.authPanel) ? state.session.accessSource : null,
    isEmailVerified: state.ui.authPanel === 'user-settings' ? state.session.isEmailVerified : null,
    emailVerifiedAt: state.ui.authPanel === 'user-settings' ? state.session.emailVerifiedAt : null,
    identityProviders: state.ui.authPanel === 'user-settings' ? state.identities.providers : null,
    identityError: state.ui.authPanel === 'user-settings' ? state.identities.error : null,
    pendingIdentityUnlinkProvider: state.ui.authPanel === 'user-settings' ? state.ui.pendingIdentityUnlinkProvider : null,
    billingLoaded: state.ui.authPanel === 'user-settings' ? state.billing.loaded : null,
    billingEnabled: state.ui.authPanel === 'user-settings' ? state.billing.enabled : null,
    billingProviderReady: state.ui.authPanel === 'user-settings' ? state.billing.providerReady : null,
    billingPlans: state.ui.authPanel === 'user-settings' ? state.billing.plans : null,
    billingOrders: state.ui.authPanel === 'user-settings' ? state.billing.orders : null,
    billingPendingPlanKey: state.ui.authPanel === 'user-settings' ? state.billing.pendingPlanKey : null,
    billingError: state.ui.authPanel === 'user-settings' ? state.billing.error : null,
    browserNotifications: getBotSettingsBrowserNotificationsRenderKey(state),
  });
}

function mergeDirtyRegions(target: Set<AppRenderRegion> | null, next: ReadonlySet<AppRenderRegion>) {
  if (next.has('all')) {
    return new Set<AppRenderRegion>(['all']);
  }

  const merged = target ? new Set(target) : new Set<AppRenderRegion>();
  if (merged.has('all')) {
    return merged;
  }

  for (const region of next) {
    merged.add(region);
  }

  return merged;
}

function flushPendingRender() {
  if (isDocumentHidden || !pendingState || isEditingInteractiveField() || isInteractionLocked() || isListInteractionLocked() || isSortMenuOpen()) {
    return;
  }

  performRender(pendingState, pendingDirtyRegions ?? new Set<AppRenderRegion>(['all']));
  pendingState = null;
  pendingDirtyRegions = null;
}

function getRestorePriorityRegions(state: AppState) {
  if (state.session.status !== 'authenticated') {
    return ['header', 'overlay', 'legacy'] satisfies AppRenderRegion[];
  }

  if (state.ui.workspace === 'live') {
    return ['header', 'overlay', 'legacy', 'manual', 'alerts', 'monitored', 'pumpfun', 'toasts'] satisfies AppRenderRegion[];
  }

  if (state.ui.workspace === 'history') {
    return ['header', 'overlay', 'legacy', 'recent', 'old-week', 'bid-zone'] satisfies AppRenderRegion[];
  }

  return ['header', 'overlay', 'legacy'] satisfies AppRenderRegion[];
}

function buildRestoreRenderSets(state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) {
  if (dirtyRegions.has('all')) {
    return {
      immediate: new Set<AppRenderRegion>(getRestorePriorityRegions(state)),
      deferred: new Set<AppRenderRegion>(['all']),
    };
  }

  const priority = new Set(getRestorePriorityRegions(state));
  const immediate = new Set<AppRenderRegion>();
  const deferred = new Set<AppRenderRegion>();

  for (const region of dirtyRegions) {
    if (region === 'all') {
      continue;
    }
    if (priority.has(region)) {
      immediate.add(region);
    } else {
      deferred.add(region);
    }
  }

  if (immediate.size === 0 && deferred.size > 0) {
    const firstDeferred = deferred.values().next().value as AppRenderRegion | undefined;
    if (firstDeferred) {
      deferred.delete(firstDeferred);
      immediate.add(firstDeferred);
    }
  }

  return { immediate, deferred };
}

function scheduleRestoreRender() {
  if (restoreRenderQueued || isDocumentHidden) {
    return;
  }

  restoreRenderQueued = true;
  const flushRestore = () => {
    restoreRenderQueued = false;

    if (isDocumentHidden) {
      return;
    }

    const nextState = hiddenPendingState ?? pendingState ?? latestState;
    const nextDirtyRegions = mergeDirtyRegions(
      mergeDirtyRegions(hiddenDirtyRegions, pendingDirtyRegions ?? new Set<AppRenderRegion>()),
      new Set<AppRenderRegion>(),
    ) ?? new Set<AppRenderRegion>(['all']);

    hiddenPendingState = null;
    hiddenDirtyRegions = null;
    pendingState = null;
    pendingDirtyRegions = null;

    if (!nextState) {
      return;
    }

    const restoreSets = buildRestoreRenderSets(
      nextState,
      nextDirtyRegions.size > 0 ? nextDirtyRegions : new Set<AppRenderRegion>(['all']),
    );

    const immediateRegions = restoreSets.immediate.size > 0 ? restoreSets.immediate : new Set<AppRenderRegion>(['all']);
    performRender(nextState, immediateRegions);
    if (restoreSets.deferred.size === 0) {
      return;
    }

    window.setTimeout(() => {
      if (isDocumentHidden) {
        return;
      }
      performRender(latestState ?? nextState, restoreSets.deferred);
    }, 0);
  };

  if (typeof window.requestAnimationFrame === 'function') {
    // Let the browser paint the previously visible DOM first when the tab becomes
    // visible again, then reconcile the hidden-time state update in a follow-up task.
    window.requestAnimationFrame(() => {
      window.setTimeout(() => flushRestore(), 0);
    });
    return;
  }

  window.setTimeout(() => flushRestore(), 0);
}

function performRender(
  state: AppState,
  dirtyRegions: ReadonlySet<AppRenderRegion> = new Set<AppRenderRegion>(['all']),
) {
  measureRuntimePerf(
    'frontend.render',
    isRuntimePerfDebugActive(state),
    {
      workspace: state.ui.workspace,
      regions: formatDirtyRegions(dirtyRegions),
      monitored: state.data.monitoredTokenAddresses.length,
      manual: state.data.manualTokenAddresses.length,
      alerts: state.data.alerts.length,
    },
    () => renderAppShell(root, state, controller, dirtyRegions),
  );
}

function clearHiddenRuntimeStopTimer() {
  if (hiddenRuntimeStopTimer) {
    clearTimeout(hiddenRuntimeStopTimer);
    hiddenRuntimeStopTimer = null;
  }
}

function shouldTreatMonitoringAsActive(state: AppState | null) {
  return Boolean(state && state.session.status === 'authenticated' && state.runtime.mode === 'active');
}

function buildDesiredLivePresence(state: AppState | null) {
  if (
    !state
    || state.session.status !== 'authenticated'
    || state.runtime.mode !== 'active'
  ) {
    return {
      workspace: 'live' as const,
      mode: 'inactive' as const,
    };
  }

  if (isDocumentHidden) {
    return {
      workspace: 'live' as const,
      mode: 'hidden' as const,
      hiddenGraceMs: HIDDEN_RUNTIME_STOP_MS,
    };
  }

  return {
    workspace: 'live' as const,
    mode: 'foreground' as const,
  };
}

function getLivePresenceSignature(payload: ReturnType<typeof buildDesiredLivePresence>) {
  return `${payload.workspace}:${payload.mode}:${payload.hiddenGraceMs ?? 0}`;
}

function syncLivePresence(state: AppState | null, options?: { force?: boolean }) {
  const payload = buildDesiredLivePresence(state);
  const signature = getLivePresenceSignature(payload);
  if (!options?.force && signature === lastLivePresenceSignature) {
    return;
  }

  updateLivePresence(payload);
  lastLivePresenceSignature = signature;
}

function refreshForegroundState(options: { force?: boolean } = {}) {
  if (!latestState || latestState.session.status !== 'authenticated') {
    recordRestoreLifecycleDebug('restore.refresh-foreground.skip-unauthenticated', {
      force: Boolean(options.force),
      hasState: Boolean(latestState),
      sessionStatus: latestState?.session.status ?? null,
    });
    return;
  }

  const now = Date.now();
  if (foregroundStateRefreshInFlight || (!options.force && now - lastForegroundStateRefreshAt < FOREGROUND_STATE_REFRESH_MIN_INTERVAL_MS)) {
    recordRestoreLifecycleDebug('restore.refresh-foreground.skip-throttled', {
      force: Boolean(options.force),
      inFlight: foregroundStateRefreshInFlight,
      elapsedMs: now - lastForegroundStateRefreshAt,
    });
    return;
  }

  lastForegroundStateRefreshAt = now;
  foregroundStateRefreshInFlight = true;
  recordRestoreLifecycleDebug('restore.refresh-foreground.start', {
    force: Boolean(options.force),
  });
  void controller.refreshRestoredSessionState(options)
    .then(() => {
      recordRestoreLifecycleDebug('restore.refresh-foreground.complete', {
        force: Boolean(options.force),
      });
    })
    .catch((error) => {
      recordRestoreLifecycleDebug('restore.refresh-foreground.error', {
        force: Boolean(options.force),
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      foregroundStateRefreshInFlight = false;
    });
}

function resolveListInteractionZone(target: HTMLElement | null) {
  const broadList = target?.closest<HTMLElement>(FULL_LIST_INTERACTION_LOCK_SELECTOR);
  if (broadList) {
    return broadList;
  }

  const tableWrap = target?.closest<HTMLElement>('.token-table-wrap');
  if (!tableWrap) {
    return null;
  }

  const interactionZone = target?.closest<HTMLElement>(TABLE_INTERACTION_LOCK_ZONE_SELECTOR);
  if (!interactionZone || !tableWrap.contains(interactionZone)) {
    return null;
  }

  return interactionZone;
}

function armHiddenRuntimeStopTimer() {
  clearHiddenRuntimeStopTimer();
  if (!isDocumentHidden || !hiddenMonitoringWasActive) {
    return;
  }

  const startedAt = hiddenSinceAt ?? Date.now();
  const remainingMs = Math.max(0, HIDDEN_RUNTIME_STOP_MS - (Date.now() - startedAt));
  hiddenRuntimeStopTimer = window.setTimeout(() => {
    hiddenRuntimeStopTimer = null;
    if (!isDocumentHidden || !hiddenMonitoringWasActive || hiddenAutoStopTriggered) {
      return;
    }
    controller.stopMonitoring();
    hiddenAutoStopTriggered = true;
  }, remainingMs);
}

root.addEventListener('pointerdown', (event) => {
  void primeAlertAudio();
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, [data-action], [data-trade-wrap]')) {
    interactionLockUntil = Date.now() + 300;
    suppressNextFocusFlush = true;
    window.setTimeout(() => {
      suppressNextFocusFlush = false;
      flushPendingRender();
    }, 320);
  }
});

root.addEventListener('keydown', () => {
  void primeAlertAudio();
});

root.addEventListener('pointerover', (event) => {
  const target = event.target as HTMLElement | null;
  const interactionZone = resolveListInteractionZone(target);
  if (!interactionZone) {
    return;
  }

  const related = event.relatedTarget as HTMLElement | null;
  if (related && interactionZone.contains(related)) {
    return;
  }

  currentListInteractionZone = interactionZone;
});

root.addEventListener('pointerout', (event) => {
  if (!currentListInteractionZone) {
    return;
  }

  const related = event.relatedTarget as HTMLElement | null;
  if (related && currentListInteractionZone.contains(related)) {
    return;
  }

  currentListInteractionZone = null;
  window.setTimeout(() => flushPendingRender(), 0);
});

root.addEventListener('focusout', () => {
  if (suppressNextFocusFlush) {
    return;
  }
  window.setTimeout(() => flushPendingRender(), 0);
});

function clearPendingRenderState() {
  pendingState = null;
  pendingDirtyRegions = null;
}

function queuePendingRenderState(state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) {
  pendingState = state;
  pendingDirtyRegions = mergeDirtyRegions(pendingDirtyRegions, dirtyRegions);
}

function getCurrentRouteKey() {
  return typeof window !== 'undefined'
    ? `${window.location.pathname || '/'}${window.location.search || ''}${window.location.hash || ''}`
    : '/';
}

function shouldForceRenderForSessionTransition(
  previousSessionStatus: AppState['session']['status'] | null,
  state: AppState,
) {
  return previousSessionStatus !== state.session.status
    && (state.session.status === 'authenticated' || state.session.status === 'pre_access');
}

function shouldForceRenderForAuthPanelOpen(
  previousAuthPanel: AppState['ui']['authPanel'] | null,
  state: AppState,
) {
  return previousAuthPanel !== state.ui.authPanel && state.ui.authPanel !== 'none';
}

function shouldQueueRenderDuringInteraction() {
  return isEditingInteractiveField()
    || isInteractionLocked()
    || isListInteractionLocked()
    || isSortMenuOpen();
}

function includesOverlayRegion(dirtyRegions: ReadonlySet<AppRenderRegion>) {
  return dirtyRegions.has('all') || dirtyRegions.has('overlay');
}

function buildDeferredRegionsAfterImmediateOverlay(dirtyRegions: ReadonlySet<AppRenderRegion>) {
  if (dirtyRegions.has('all')) {
    return new Set<AppRenderRegion>(['all']);
  }

  const deferred = new Set<AppRenderRegion>(dirtyRegions);
  deferred.delete('overlay');
  return deferred.size > 0 ? deferred : null;
}

function primePlayedAlertsOnAuthentication(state: AppState, sessionJustBecameAuthenticated: boolean) {
  if (!sessionJustBecameAuthenticated) {
    return;
  }

  resetBrowserNotificationSession();
  browserNotificationActiveSince = Date.now();
  lastBrowserNotificationRuntimeActive = state.runtime.mode === 'active';
  lastBrowserNotificationsEnabled = state.ui.browserNotifications.enabled;
  for (const alert of state.data.alerts) {
    playedAlertIds.add(alert.id);
    handledBrowserNotificationAlertIds.add(alert.id);
  }
}

function syncObservedState(state: AppState, currentRouteKey: string) {
  const previous = {
    sessionStatus: lastObservedSessionStatus,
    authPanel: lastObservedAuthPanel,
    authModalKey: lastObservedAuthModalKey,
    routeKey: lastObservedRouteKey,
  };

  latestState = state;
  lastObservedSessionStatus = state.session.status;
  lastObservedAuthPanel = state.ui.authPanel;
  lastObservedAuthModalKey = getAuthModalRenderKey(state);
  lastObservedRouteKey = currentRouteKey;

  return previous;
}

function handleAuthPanelRender(
  state: AppState,
  dirtyRegions: ReadonlySet<AppRenderRegion>,
  previousAuthModalKey: string | null,
) {
  if (state.ui.authPanel === 'none') {
    return false;
  }

  if (previousAuthModalKey !== lastObservedAuthModalKey) {
    performRender(state, dirtyRegions);
  }

  clearPendingRenderState();
  return true;
}

controller.subscribe((state, dirtyRegions) => {
  const currentRouteKey = getCurrentRouteKey();
  const previous = syncObservedState(state, currentRouteKey);
  const sessionJustBecameAuthenticated = previous.sessionStatus !== 'authenticated' && state.session.status === 'authenticated';
  syncLivePresence(state);
  primePlayedAlertsOnAuthentication(state, sessionJustBecameAuthenticated);
  syncAudioSideEffects(state);
  syncBrowserNotificationSideEffects(state);

  if (isDocumentHidden) {
    hiddenPendingState = state;
    hiddenDirtyRegions = mergeDirtyRegions(hiddenDirtyRegions, dirtyRegions);
    clearPendingRenderState();
    return;
  }

  if (shouldForceRenderForSessionTransition(previous.sessionStatus, state)) {
    performRender(state, dirtyRegions);
    clearPendingRenderState();
    return;
  }

  if (previous.routeKey !== currentRouteKey) {
    performRender(state, dirtyRegions);
    clearPendingRenderState();
    return;
  }

  if (shouldForceRenderForAuthPanelOpen(previous.authPanel, state)) {
    performRender(state, dirtyRegions);
    clearPendingRenderState();
    return;
  }

  if (handleAuthPanelRender(state, dirtyRegions, previous.authModalKey)) {
    return;
  }

  if (shouldQueueRenderDuringInteraction()) {
    if (includesOverlayRegion(dirtyRegions) && !isEditingInteractiveField()) {
      performRender(state, new Set<AppRenderRegion>(['overlay']));
      const deferredRegions = buildDeferredRegionsAfterImmediateOverlay(dirtyRegions);
      if (deferredRegions) {
        queuePendingRenderState(state, deferredRegions);
      }
      return;
    }

    queuePendingRenderState(state, dirtyRegions);
    return;
  }

  performRender(state, dirtyRegions);
  clearPendingRenderState();
});

document.addEventListener('visibilitychange', () => {
  isDocumentHidden = document.visibilityState === 'hidden';
  if (isDocumentHidden) {
    controller.setDocumentHidden(true);
    hiddenSinceAt = Date.now();
    hiddenMonitoringWasActive = shouldTreatMonitoringAsActive(latestState);
    hiddenAutoStopTriggered = false;
    syncLivePresence(latestState, { force: true });
    armHiddenRuntimeStopTimer();
    return;
  }

  clearHiddenRuntimeStopTimer();
  controller.setDocumentHidden(false);
  const hiddenDurationMs = hiddenSinceAt ? Date.now() - hiddenSinceAt : 0;
  if (hiddenSinceAt) {
    suppressCatchupAlertCreatedBefore = Date.now();
    suppressCatchupAlertAudioUntil = Date.now() + 2_000;
  }
  const shouldAutoStopOnReturn = hiddenMonitoringWasActive && hiddenDurationMs >= HIDDEN_RUNTIME_STOP_MS;
  hiddenSinceAt = null;
  const shouldReloadAfterHidden = hiddenAutoStopTriggered || shouldAutoStopOnReturn;
  hiddenMonitoringWasActive = false;
  hiddenAutoStopTriggered = false;
  recordRestoreLifecycleDebug('restore.visibility.visible', {
    hiddenDurationMs,
    shouldReloadAfterHidden,
    shouldAutoStopOnReturn,
  });
  if (shouldReloadAfterHidden) {
    controller.stopMonitoring();
    window.location.reload();
    return;
  }

  interactionLockUntil = 0;
  currentListInteractionZone = null;
  suppressNextFocusFlush = false;
  if (latestState) {
    syncAudioSideEffects(latestState);
  }
  syncLivePresence(latestState, { force: true });
  refreshForegroundState({ force: hiddenDurationMs >= 5_000 });
  scheduleRestoreRender();
});

window.addEventListener('pageshow', (event) => {
  recordRestoreLifecycleDebug('restore.pageshow', {
    persisted: event.persisted,
  });
  refreshForegroundState({ force: event.persisted });
});

window.addEventListener('focus', () => {
  refreshForegroundState();
});

window.addEventListener('popstate', () => {
  controller.syncWorkspaceFromLocation();
});

window.setInterval(() => {
  if (!latestState || isDocumentHidden) {
    return;
  }
  flushPendingRender();
}, 250);

window.setInterval(() => {
  if (!latestState || isDocumentHidden) {
    return;
  }

  if (!shouldTreatMonitoringAsActive(latestState) || latestState.ui.workspace !== 'live') {
    return;
  }

  syncLivePresence(latestState, { force: true });
}, LIVE_PRESENCE_HEARTBEAT_MS);

window.setInterval(() => {
  if (!latestState || !isRuntimePerfDebugActive(latestState)) {
    return;
  }

  recordRuntimePerfDebugEntry({
    ts: Date.now(),
    kind: 'sample',
    label: 'frontend.runtime-sample',
    meta: buildRuntimePerfSample(latestState),
    memory: readRuntimePerfMemory(),
  }, true);
}, PERF_DEBUG_SAMPLE_INTERVAL_MS);

void controller.init();
