import './styles/app.css';
import { playAlertSound, playMigrateSound } from './services/alerts/sound';
import { getDesiredPumpSubscriptionCount } from './services/socket/client';
import type { AppState } from './state/app-state';
import { createAppController } from './state/app-controller';
import { renderAppShell } from './ui/app-shell';
import { createDebugMemoryCollector } from './utils/debug-memory';

const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('App root #app was not found.');
}

const root: HTMLDivElement = rootElement;

const controller = createAppController();
const memoryCollector = createDebugMemoryCollector();
const playedAlertIds = new Set<string>();
const playedPumpToastIds = new Set<string>();
let pendingState: AppState | null = null;
let latestState: AppState | null = null;
let lastObservedSessionStatus: AppState['session']['status'] | null = null;
let lastObservedAuthPanel: AppState['ui']['authPanel'] | null = null;
let lastObservedAuthModalKey: string | null = null;
let suppressNextFocusFlush = false;
let interactionLockUntil = 0;
let listInteractionDepth = 0;

declare global {
  interface Window {
  }
}
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
    if (playedAlertIds.has(alert.id)) {
      continue;
    }

    playedAlertIds.add(alert.id);
    void playAlertSound(alert, {
      enabled: state.ui.soundEnabled,
      volume: state.ui.soundVolume,
      scope: state.session.email || state.session.username || 'anonymous',
      configs: state.data.configs,
    });
  }

  for (const toast of state.data.pumpToasts) {
    if (playedPumpToastIds.has(toast.id)) {
      continue;
    }

    playedPumpToastIds.add(toast.id);
    void playMigrateSound({
      enabled: state.ui.soundEnabled,
      volume: state.ui.soundVolume,
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

function isInteractionLocked() {
  return Date.now() < interactionLockUntil;
}

function isListInteractionLocked() {
  return listInteractionDepth > 0;
}

function isSortMenuOpen() {
  return Boolean(root.querySelector('[data-sort-wrap].open'));
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
  });
}

function flushPendingRender() {
  if (!pendingState || isEditingInteractiveField() || isInteractionLocked() || isListInteractionLocked() || isSortMenuOpen()) {
    return;
  }

  performRender(pendingState);
  pendingState = null;
}

function updateDebugMemoryMetrics(state: AppState) {
  if (!memoryCollector.isEnabled()) {
    return;
  }

  const debug = controller.getDebugStats();
  memoryCollector.updateMetrics({
    sessionStatus: state.session.status,
    runtimeMode: state.runtime.mode,
    trackedTokens: Object.keys(state.data.trackedTokensByAddress).length,
    monitoredTokenAddresses: state.data.monitoredTokenAddresses.length,
    manualTokenAddresses: state.data.manualTokenAddresses.length,
    pumpTokens: state.data.pumpTokens.length,
    recentPumpMigrations: state.data.recentPumpMigrations.length,
    alerts: state.data.alerts.length,
    recentAlertFingerprints: debug.recentAlertFingerprints,
    desiredPumpSubscriptions: getDesiredPumpSubscriptionCount(),
    emitCount: debug.emitCount,
  });
}

function performRender(state: AppState) {
  const startedAt = performance.now();
  renderAppShell(root, state, controller);
  memoryCollector.noteRender(performance.now() - startedAt);
}

root.addEventListener('pointerdown', (event) => {
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

root.addEventListener('pointerover', (event) => {
  const target = event.target as HTMLElement | null;
  const list = target?.closest('.token-table-wrap, .monitored-list, .lateralized-list, .pump-list, .alerts-list');
  if (!list) {
    return;
  }

  const related = event.relatedTarget as HTMLElement | null;
  if (related && list.contains(related)) {
    return;
  }

  listInteractionDepth += 1;
});

root.addEventListener('pointerout', (event) => {
  const target = event.target as HTMLElement | null;
  const list = target?.closest('.token-table-wrap, .monitored-list, .lateralized-list, .pump-list, .alerts-list');
  if (!list) {
    return;
  }

  const related = event.relatedTarget as HTMLElement | null;
  if (related && list.contains(related)) {
    return;
  }

  listInteractionDepth = Math.max(0, listInteractionDepth - 1);
  if (listInteractionDepth == 0) {
    window.setTimeout(() => flushPendingRender(), 0);
  }
});

root.addEventListener('focusout', () => {
  if (suppressNextFocusFlush) {
    return;
  }
  window.setTimeout(() => flushPendingRender(), 0);
});

controller.subscribe((state) => {
  const previousSessionStatus = lastObservedSessionStatus;
  const previousAuthPanel = lastObservedAuthPanel;
  const previousAuthModalKey = lastObservedAuthModalKey;
  const sessionJustBecameAuthenticated = previousSessionStatus !== 'authenticated' && state.session.status === 'authenticated';
  latestState = state;
  lastObservedSessionStatus = state.session.status;
  lastObservedAuthPanel = state.ui.authPanel;
  lastObservedAuthModalKey = getAuthModalRenderKey(state);

  if (sessionJustBecameAuthenticated) {
    for (const alert of state.data.alerts) {
      playedAlertIds.add(alert.id);
    }
  }

  syncAudioSideEffects(state);
  updateDebugMemoryMetrics(state);

  if (previousSessionStatus !== state.session.status && state.session.status === 'authenticated') {
    performRender(state);
    pendingState = null;
    return;
  }

  if (previousAuthPanel !== state.ui.authPanel && state.ui.authPanel !== 'none') {
    performRender(state);
    pendingState = null;
    return;
  }

  if (state.ui.authPanel !== 'none') {
    if (previousAuthModalKey !== lastObservedAuthModalKey) {
      performRender(state);
    }
    pendingState = null;
    return;
  }

  if (isEditingInteractiveField() || isInteractionLocked() || isListInteractionLocked() || isSortMenuOpen()) {
    pendingState = state;
    return;
  }

  performRender(state);
  pendingState = null;
});

window.setInterval(() => {
  if (!latestState) {
    return;
  }
  flushPendingRender();
}, 250);

void controller.init();
