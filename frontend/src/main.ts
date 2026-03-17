import './styles/app.css';
import { playAlertSound, playMigrateSound } from './services/alerts/sound';
import type { AppState } from './state/app-state';
import { createAppController } from './state/app-controller';
import { renderAppShell } from './ui/app-shell';

const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('App root #app was not found.');
}

const root: HTMLDivElement = rootElement;

const controller = createAppController();
const playedAlertIds = new Set<string>();
const playedPumpToastIds = new Set<string>();
let pendingState: AppState | null = null;
let latestState: AppState | null = null;
let suppressNextFocusFlush = false;
let interactionLockUntil = 0;
let listInteractionDepth = 0;

declare global {
  interface Window {
    __botDebug?: {
      controller: typeof controller;
      getState: () => AppState | null;
      snapshot: () => {
        manualCount: number;
        monitoredCount: number;
        recentCount: number;
        oldWeekCount: number;
        manualAddresses: string[];
        dexPatchCount?: number;
        lastDexPatchAddress?: string | null;
        lastDexPatchAt?: number | null;
      } | null;
    };
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

function flushPendingRender() {
  if (!pendingState || isEditingInteractiveField() || isInteractionLocked() || isListInteractionLocked() || isSortMenuOpen()) {
    return;
  }

  renderAppShell(root, pendingState, controller);
  pendingState = null;
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
  const list = target?.closest('.token-table-wrap, .monitored-list, .pump-list, .alerts-list');
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
  const list = target?.closest('.token-table-wrap, .monitored-list, .pump-list, .alerts-list');
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
  latestState = state;
  syncAudioSideEffects(state);

  if (isEditingInteractiveField() || isInteractionLocked() || isListInteractionLocked() || isSortMenuOpen()) {
    pendingState = state;
    return;
  }

  renderAppShell(root, state, controller);
  pendingState = null;
});

window.__botDebug = {
  controller,
  getState: () => latestState,
  snapshot: () => {
    if (!latestState) {
      return null;
    }

    const debug = (window as Window & { __botDexDebug?: { patchCount: number; lastAddress: string | null; lastAt: number | null } }).__botDexDebug;
    return {
      manualCount: latestState.data.manualTokens.length,
      monitoredCount: latestState.data.monitoredTokens.length,
      recentCount: latestState.data.recentTokens.length,
      oldWeekCount: latestState.data.oldWeekTokens.length,
      manualAddresses: latestState.data.manualTokens.map((item) => item.address),
      dexPatchCount: debug?.patchCount ?? 0,
      lastDexPatchAddress: debug?.lastAddress ?? null,
      lastDexPatchAt: debug?.lastAt ?? null,
    };
  },
};

window.setInterval(() => {
  if (!latestState) {
    return;
  }
  flushPendingRender();
}, 250);

void controller.init();

