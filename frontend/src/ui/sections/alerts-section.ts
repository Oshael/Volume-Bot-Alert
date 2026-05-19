import type { AppController } from '../../state/app-controller';
import type { AlertEntry, AppState, TokenSparklineEntry } from '../../state/app-state';
import { getAlertImpactTier, getAlertToneClass, getAlertVisualClasses, isHighCapDumpAlert, isHvncAlert, type AlertImpactTier } from '../../services/alerts/impact-tier';
import { bindCompactSearch, bindCopyButtons, bindSparklineHover, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtMoney, fmtPct, renderSparklineFigure } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

const ALERT_FX_SETTLE_MS = 1_600;
const ALERTS_PER_PAGE = 40;
const ALERT_CONTENT_MAX_WIDTH_PX = 640;
const ALERT_CONTENT_BUFFER_PX = 20;
const ALERT_CHART_MIN_WIDTH_PX = 200;
const ALERT_RAIL_EXTRA_WIDTH_PX = 12;
const ALERT_RAIL_GAP_FALLBACK_PX = 36;
const ALERT_SCROLL_BRIDGE_DELAY_MS = 400;

type AlertRowView = {
  element: HTMLElement;
  renderKey: string;
};

type AlertFxTier = AlertImpactTier | 'special';
type AlertFxPhase = 'entering' | 'settled';
type AlertFxState = {
  enteredAt: number;
  tier: AlertFxTier;
  phase: AlertFxPhase;
  settleTimer: ReturnType<typeof window.setTimeout> | null;
  enterPlayedAt: number | null;
};

type AlertsSectionView = {
  section: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  searchInput: HTMLInputElement;
  searchWrap: HTMLElement;
  pageJumpInput: HTMLInputElement;
  pageTotal: HTMLElement;
  prevButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  emptyState: HTMLElement;
  fxGhostHost: HTMLElement;
  controller: AppController;
  rowViews: Map<string, AlertRowView>;
  fxStates: Map<string, AlertFxState>;
  layoutMeasureRaf: number | null;
  resizeObserver: ResizeObserver | null;
};

let alertsSectionView: AlertsSectionView | null = null;
const alertRowShakeAnimations = new WeakMap<HTMLElement, Animation>();

export function renderAlertsSection(state: AppState, controller: AppController) {
  const renderNow = Date.now();
  const view = getOrCreateAlertsSectionView(controller);
  const cardEffectsEnabled = areAlertCardEffectsEnabled(state);
  view.controller = controller;
  syncAlertFxStates(view, state.data.alerts, renderNow);
  if (!cardEffectsEnabled && view.fxGhostHost.childElementCount > 0) {
    view.fxGhostHost.replaceChildren();
  }

  const searchQuery = String(state.ui.alertSearchQuery || '');
  const filteredAlerts = filterAlerts(state, searchQuery);
  const pagination = paginateAlerts(filteredAlerts, state.ui.alertPage);

  syncSearchInput(view, searchQuery);
  syncPaginationControls(view, pagination.safePage, pagination.totalPages);
  reconcileAlertRows(view, pagination.pageItems, state, renderNow, cardEffectsEnabled);
  bindSparklineHover(view.section, state.data.alertSparklineById);
  view.count.textContent = String(filteredAlerts.length);

  return view.section;
}

function bindAlertsScrollBridge(list: HTMLElement) {
  if (list.dataset.scrollBridgeBound === 'true') {
    return;
  }

  list.dataset.scrollBridgeBound = 'true';
  let topEdgeEnteredAt = 0;
  list.addEventListener('wheel', (event) => {
    if (!(event.deltaY < 0)) {
      topEdgeEnteredAt = 0;
      return;
    }

    if (list.scrollTop > 0) {
      topEdgeEnteredAt = 0;
      return;
    }

    const documentScrollElement = list.ownerDocument.scrollingElement;
    if (!(documentScrollElement instanceof HTMLElement)) {
      return;
    }

    if (documentScrollElement.scrollTop <= 0) {
      return;
    }

    const now = Date.now();
    if (topEdgeEnteredAt <= 0) {
      topEdgeEnteredAt = now;
      event.preventDefault();
      return;
    }

    if ((now - topEdgeEnteredAt) < ALERT_SCROLL_BRIDGE_DELAY_MS) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    documentScrollElement.scrollTop = Math.max(0, documentScrollElement.scrollTop + event.deltaY);
  }, { passive: false });
}

function getOrCreateAlertsSectionView(controller: AppController) {
  if (alertsSectionView) {
    return alertsSectionView;
  }

  const section = document.createElement('section');
  section.className = 'panel legacy-panel alerts-panel';
  section.innerHTML = `
    <div class="panel-header">
      <span>\u{1F514} ALERTS</span>
      <div class="alerts-panel-header-controls">
        <button type="button" class="action-button small" data-action="alerts-clear-all">Clean All</button>
        <div class="alerts-page-controls" aria-label="Alerts pages">
          <button type="button" class="action-button small" data-action="alerts-prev">Prev</button>
          <label class="legacy-mini-field alerts-page-field">PAGE <input type="number" min="1" step="1" data-action="alerts-page-jump" /></label>
          <span class="bucket-page-total alerts-page-total">1</span>
          <button type="button" class="action-button small" data-action="alerts-next">Next</button>
        </div>
        <div class="compact-search compact-search-fixed">
          <button type="button" class="compact-search-toggle" data-action="alerts-search-focus" aria-label="Search alerts">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="alerts-search" data-search-input="alerts">
        </div>
        <span class="count alerts-panel-count">0</span>
      </div>
    </div>
    <div class="alerts-list"></div>
  `;

  const list = section.querySelector<HTMLElement>('.alerts-list');
  const count = section.querySelector<HTMLElement>('.alerts-panel-count');
  const searchInput = section.querySelector<HTMLInputElement>('[data-action="alerts-search"]');
  const searchWrap = section.querySelector<HTMLElement>('.compact-search');
  const pageJumpInput = section.querySelector<HTMLInputElement>('[data-action="alerts-page-jump"]');
  const pageTotal = section.querySelector<HTMLElement>('.alerts-page-total');
  const prevButton = section.querySelector<HTMLButtonElement>('[data-action="alerts-prev"]');
  const nextButton = section.querySelector<HTMLButtonElement>('[data-action="alerts-next"]');
  if (!list || !count || !searchInput || !searchWrap || !pageJumpInput || !pageTotal || !prevButton || !nextButton) {
    throw new Error('Alerts section view failed to initialize.');
  }

  bindAlertsScrollBridge(list);

  const emptyState = buildEmptyState();
  alertsSectionView = {
    section,
    list,
    count,
    searchInput,
    searchWrap,
    pageJumpInput,
    pageTotal,
    prevButton,
    nextButton,
    emptyState,
    fxGhostHost: getOrCreateAlertFxGhostHost(),
    controller,
    rowViews: new Map<string, AlertRowView>(),
    fxStates: new Map<string, AlertFxState>(),
    layoutMeasureRaf: null,
    resizeObserver: null,
  };

  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      scheduleAlertLayoutMetrics(alertsSectionView);
    });
    resizeObserver.observe(section);
    alertsSectionView.resizeObserver = resizeObserver;
  }

  bindCompactSearch(section, {
    toggleAction: 'alerts-search-focus',
    inputAction: 'alerts-search',
  });

  searchInput.addEventListener('input', (event) => {
    alertsSectionView?.controller.setAlertSearchQuery((event.currentTarget as HTMLInputElement).value);
  });

  section.querySelector<HTMLButtonElement>('[data-action="alerts-clear-all"]')?.addEventListener('click', () => {
    alertsSectionView?.controller.clearAllAlerts();
  });

  prevButton.addEventListener('click', () => {
    alertsSectionView?.controller.setAlertPage((alertsSectionView?.controller.state.ui.alertPage || 0) - 1);
  });

  nextButton.addEventListener('click', () => {
    alertsSectionView?.controller.setAlertPage((alertsSectionView?.controller.state.ui.alertPage || 0) + 1);
  });

  const commitPageJump = () => {
    const value = Number(pageJumpInput.value);
    if (!Number.isFinite(value)) {
      return;
    }
    alertsSectionView?.controller.setAlertPage(value - 1);
  };
  pageJumpInput.addEventListener('change', commitPageJump);
  pageJumpInput.addEventListener('blur', commitPageJump);
  pageJumpInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    commitPageJump();
  });

  section.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-action="remove-alert"]');
    const alertId = button?.dataset.alertId;
    if (!button || !alertId || !alertsSectionView) {
      return;
    }

    removeAlertRowImmediately(alertsSectionView, button);
    alertsSectionView.controller.removeAlert(alertId);
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.alert-ticker-peers-panel')) {
      return;
    }
    closeOpenTickerPeerPanels(section);
  });

  list.replaceChildren(emptyState);
  return alertsSectionView;
}

function closeOpenTickerPeerPanels(root: ParentNode) {
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('.alert-ticker-peers-panel[open]')) {
    panel.open = false;
  }
}

function buildEmptyState() {
  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  const emptyText = document.createElement('div');
  emptyText.className = 'empty-text';
  emptyText.textContent = 'No alerts match the current search.';
  emptyState.append(emptyText);
  return emptyState;
}

function filterAlerts(state: AppState, searchQuery: string) {
  const normalizedQuery = String(searchQuery || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return state.data.alerts;
  }

  return state.data.alerts.filter((alert) => {
    const symbol = String(alert.symbol || '').toLowerCase();
    const name = String(alert.name || '').toLowerCase();
    const address = String(alert.address || '').toLowerCase();
    return symbol.includes(normalizedQuery) || name.includes(normalizedQuery) || address.includes(normalizedQuery);
  });
}

function paginateAlerts(alerts: AlertEntry[], page: number) {
  const totalPages = Math.max(1, Math.ceil(alerts.length / ALERTS_PER_PAGE));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  const pageStart = safePage * ALERTS_PER_PAGE;

  return {
    totalPages,
    safePage,
    pageItems: alerts.slice(pageStart, pageStart + ALERTS_PER_PAGE),
  };
}

function syncSearchInput(view: AlertsSectionView, searchQuery: string) {
  if (view.searchInput.value !== searchQuery) {
    view.searchInput.value = searchQuery;
  }

  const hasQuery = Boolean(String(searchQuery || '').trim());
  view.searchWrap.classList.toggle('has-query', hasQuery);
  view.searchWrap.classList.toggle('open', hasQuery || document.activeElement === view.searchInput);
}

function syncPaginationControls(view: AlertsSectionView, safePage: number, totalPages: number) {
  view.pageJumpInput.max = String(totalPages);
  view.pageJumpInput.value = String(safePage + 1);
  view.pageTotal.textContent = String(totalPages);
  view.prevButton.disabled = safePage === 0;
  view.nextButton.disabled = safePage >= totalPages - 1;
}

function reconcileAlertRows(
  view: AlertsSectionView,
  filteredAlerts: AlertEntry[],
  state: AppState,
  renderNow: number,
  cardEffectsEnabled: boolean,
) {
  const liveAlertIds = new Set(state.data.alerts.map((alert) => alert.id));
  const desiredNodes: HTMLElement[] = [];
  const pendingEnterFx: Array<{ row: HTMLElement; fxState: AlertFxState }> = [];

  for (const alert of filteredAlerts) {
    const fxState = getOrCreateAlertFxState(view, alert, renderNow);
    const isStarred = state.data.starredTokens.includes(alert.address);
    const sparkline = state.data.alertSparklineById[alert.id] || null;
    const renderKey = getAlertRowRenderKey(
      alert,
      state.ui.busy,
      isStarred,
      state.session.role === 'admin',
      state.ui.enabledTradeTerminals,
      renderNow,
      sparkline,
    );

    let rowView = view.rowViews.get(alert.id);
    if (!rowView) {
      const row = createAlertRowShell(alert.id);
      rowView = {
        element: row,
        renderKey: '',
      };
      view.rowViews.set(alert.id, rowView);
    }

    syncAlertRowShell(rowView.element, alert, isStarred, renderNow, fxState);
    applyAlertFxStateToRow(rowView.element, fxState);
    queuePendingAlertEnterFx(pendingEnterFx, rowView.element, fxState, renderNow, cardEffectsEnabled);

    if (rowView.renderKey !== renderKey) {
      rowView.element.querySelector<HTMLElement>('.alert-grid')?.remove();
      rowView.element.append(buildAlertRowContent(
        alert,
        state.ui.busy,
        isStarred,
        state.session.role === 'admin',
        state.ui.enabledTradeTerminals,
        renderNow,
        sparkline,
        fxState,
      ));
      bindTokenActions(rowView.element, view.controller);
      bindCopyButtons(rowView.element);
      rowView.renderKey = renderKey;
    }

    desiredNodes.push(rowView.element);
  }

  for (const [alertId] of view.rowViews.entries()) {
    if (!liveAlertIds.has(alertId)) {
      view.rowViews.delete(alertId);
    }
  }

  if (desiredNodes.length === 0) {
    view.list.replaceChildren(view.emptyState);
    return;
  }

  if (view.emptyState.parentElement === view.list) {
    view.emptyState.remove();
  }

  for (let index = 0; index < desiredNodes.length; index += 1) {
    const node = desiredNodes[index];
    const currentAtIndex = view.list.children.item(index);
    if (currentAtIndex !== node) {
      view.list.insertBefore(node, currentAtIndex);
    }
  }

  while (view.list.children.length > desiredNodes.length) {
    view.list.lastElementChild?.remove();
  }

  scheduleAlertLayoutMetrics(view);

  for (const { row, fxState } of pendingEnterFx) {
    playAlertFxEnter(view.fxGhostHost, row, fxState);
  }
}

function scheduleAlertLayoutMetrics(view: AlertsSectionView | null) {
  if (!view || typeof window === 'undefined') {
    return;
  }

  if (view.layoutMeasureRaf != null) {
    window.cancelAnimationFrame(view.layoutMeasureRaf);
  }

  view.layoutMeasureRaf = window.requestAnimationFrame(() => {
    view.layoutMeasureRaf = null;
    applyAlertLayoutMetrics(view);
  });
}

function applyAlertLayoutMetrics(view: AlertsSectionView) {
  for (const rowView of view.rowViews.values()) {
    syncAlertLayoutMetrics(rowView.element);
  }
}

function parsePixelValue(value: string | null | undefined, fallback = 0) {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function syncAlertLayoutMetrics(row: HTMLElement) {
  const body = row.querySelector<HTMLElement>('.alert-body-v68');
  const content = row.querySelector<HTMLElement>('.alert-content-v68');
  const rail = row.querySelector<HTMLElement>('.alert-rail-v68');
  const side = row.querySelector<HTMLElement>('.alert-side-v68');
  if (!body || !content || !rail || !side || !body.isConnected) {
    return;
  }

  const alertsPanel = row.closest<HTMLElement>('.alerts-panel');
  const alertsSlot = row.closest<HTMLElement>('.live-panel-item[data-panel-key="alerts"]');
  if (alertsPanel?.dataset.alertsLayout === 'compact' || alertsSlot?.dataset.span === '1') {
    body.style.removeProperty('--alert-content-width');
    body.style.removeProperty('--alert-rail-min-width');
    return;
  }

  const railComputed = window.getComputedStyle(rail);
  const railGap = parsePixelValue(railComputed.columnGap || railComputed.gap, ALERT_RAIL_GAP_FALLBACK_PX);
  const contentWidth = Math.ceil(content.scrollWidth);
  const sideWidth = Math.ceil(side.scrollWidth);
  const railMinWidth = sideWidth + ALERT_CHART_MIN_WIDTH_PX + railGap + ALERT_RAIL_EXTRA_WIDTH_PX;
  const bodyWidth = Math.ceil(body.clientWidth);
  const maxContentWidth = Math.max(220, bodyWidth - railMinWidth);
  const measuredContentWidth = Math.min(
    ALERT_CONTENT_MAX_WIDTH_PX,
    maxContentWidth,
    contentWidth + ALERT_CONTENT_BUFFER_PX,
  );

  body.style.setProperty('--alert-content-width', `${Math.max(220, measuredContentWidth)}px`);
  body.style.setProperty('--alert-rail-min-width', `${Math.max(280, railMinWidth)}px`);
}

function areAlertCardEffectsEnabled(state: AppState) {
  return String(state.data.configs['card-effects-mode'] ?? 'on').trim().toLowerCase() !== 'off';
}

function queuePendingAlertEnterFx(
  pendingEnterFx: Array<{ row: HTMLElement; fxState: AlertFxState }>,
  row: HTMLElement,
  fxState: AlertFxState,
  renderNow: number,
  cardEffectsEnabled: boolean,
) {
  if (fxState.phase !== 'entering' || fxState.enterPlayedAt != null) {
    return;
  }

  if (!cardEffectsEnabled) {
    fxState.enterPlayedAt = renderNow;
    return;
  }

  pendingEnterFx.push({ row, fxState });
}

function syncAlertFxStates(view: AlertsSectionView, alerts: AlertEntry[], now: number) {
  const liveAlertIds = new Set(alerts.map((alert) => alert.id));
  for (const alert of alerts) {
    const fxState = getOrCreateAlertFxState(view, alert, now);
    if (fxState.phase === 'entering' && now - fxState.enteredAt >= ALERT_FX_SETTLE_MS) {
      settleAlertFxState(view, alert.id);
    }
  }

  for (const [alertId, fxState] of view.fxStates.entries()) {
    if (liveAlertIds.has(alertId)) {
      continue;
    }

    if (fxState.settleTimer) {
      clearTimeout(fxState.settleTimer);
    }
    view.fxStates.delete(alertId);
  }
}

function getOrCreateAlertFxState(view: AlertsSectionView, alert: AlertEntry, now: number) {
  const existing = view.fxStates.get(alert.id);
  if (existing) {
    return existing;
  }

  const enteredAt = normalizeAlertFxEnteredAt(alert, now);
  const shouldStartSettled = now - enteredAt >= ALERT_FX_SETTLE_MS;
  const nextState: AlertFxState = {
    enteredAt,
    tier: getAlertFxTier(alert),
    phase: shouldStartSettled ? 'settled' : 'entering',
    settleTimer: null,
    enterPlayedAt: shouldStartSettled ? enteredAt : null,
  };
  if (!shouldStartSettled) {
    nextState.settleTimer = window.setTimeout(() => {
      settleAlertFxState(view, alert.id);
    }, Math.max(0, ALERT_FX_SETTLE_MS - (now - enteredAt)));
  }
  view.fxStates.set(alert.id, nextState);
  return nextState;
}

function normalizeAlertFxEnteredAt(alert: AlertEntry, now: number) {
  const createdAt = Number(alert.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return now;
  }

  return Math.min(createdAt, now);
}

function getAlertFxTier(alert: AlertEntry): AlertFxTier {
  if (isHighCapDumpAlert(alert) || isHvncAlert(alert) || alert.kind === 'meteora-surge' || alert.isOldSurge) {
    return 'special';
  }

  return getAlertImpactTier(alert);
}

function settleAlertFxState(view: AlertsSectionView, alertId: string) {
  const fxState = view.fxStates.get(alertId);
  if (!fxState || fxState.phase === 'settled') {
    return;
  }

  if (fxState.settleTimer) {
    clearTimeout(fxState.settleTimer);
    fxState.settleTimer = null;
  }
  fxState.phase = 'settled';

  const rowView = view.rowViews.get(alertId);
  if (rowView) {
    applyAlertFxStateToRow(rowView.element, fxState);
  }
}

function applyAlertFxStateToRow(row: HTMLElement, fxState: AlertFxState) {
  row.dataset.fxPhase = fxState.phase;
  row.dataset.fxTier = fxState.tier;
  row.classList.toggle('alert-fx-entering', fxState.phase === 'entering');
  row.classList.toggle('alert-fx-settled', fxState.phase === 'settled');
}

function playAlertFxEnter(host: HTMLElement, row: HTMLElement, fxState: AlertFxState) {
  if (fxState.phase !== 'entering' || fxState.enterPlayedAt != null) {
    return;
  }

  const rect = row.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  fxState.enterPlayedAt = Date.now();
  const profile = getAlertFxOverlayProfile(fxState.tier);
  const ghost = buildAlertFxGhost(fxState.tier, rect, row.style.getPropertyValue('--alert-fx-color'));
  const stage = ghost.querySelector<HTMLElement>('.alert-fx-ghost-stage');
  const glow = ghost.querySelector<HTMLElement>('.alert-fx-ghost-glow');
  const rail = ghost.querySelector<HTMLElement>('.alert-fx-ghost-rail');
  const flare = ghost.querySelector<HTMLElement>('.alert-fx-ghost-flare');
  const haze = ghost.querySelector<HTMLElement>('.alert-fx-ghost-haze');
  if (!stage || !glow || !rail || !flare || !haze) {
    return;
  }

  host.append(ghost);

  stage.animate(
    [
      {
        offset: 0,
        opacity: 0,
        transform: 'scale(0.992)',
        boxShadow: '0 0 0 0 transparent, 0 0 0 transparent',
      },
      {
        offset: 0.18,
        opacity: 1,
        transform: `scale(${profile.pulseScale})`,
        boxShadow: `0 0 0 1px color-mix(in srgb, var(--alert-fx-color) ${profile.pulseEdgeAlpha}%, transparent), 0 0 ${profile.pulseBlur}px color-mix(in srgb, var(--alert-fx-color) ${profile.pulseGlowAlpha}%, transparent)`,
      },
      {
        offset: 0.82,
        opacity: 0.86,
        transform: 'scale(1)',
        boxShadow: `0 0 0 1px color-mix(in srgb, var(--alert-fx-color) ${Math.max(profile.pulseEdgeAlpha - 20, 10)}%, transparent), 0 0 ${Math.max(profile.pulseBlur - 12, 10)}px color-mix(in srgb, var(--alert-fx-color) ${Math.max(profile.pulseGlowAlpha - 24, 10)}%, transparent)`,
      },
      {
        offset: 1,
        opacity: 0,
        transform: 'scale(1)',
        boxShadow: '0 0 0 0 transparent, 0 0 0 transparent',
      },
    ],
    {
      duration: profile.pulseDuration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none',
    },
  );

  if (profile.shakeAmplitudePx > 0) {
    const existingShake = alertRowShakeAnimations.get(row);
    if (existingShake) {
      existingShake.cancel();
      alertRowShakeAnimations.delete(row);
    }

    const shakeAnimation = row.animate(
      [
        { offset: 0, transform: 'translate3d(0, 0, 0)' },
        { offset: 0.12, transform: `translate3d(-${profile.shakeAmplitudePx}px, 0, 0)` },
        { offset: 0.24, transform: `translate3d(${profile.shakeAmplitudePx}px, 0, 0)` },
        { offset: 0.38, transform: `translate3d(-${Math.max(profile.shakeAmplitudePx - 2, 1)}px, 0, 0)` },
        { offset: 0.52, transform: `translate3d(${Math.max(profile.shakeAmplitudePx - 2, 1)}px, 0, 0)` },
        { offset: 0.68, transform: `translate3d(-${Math.max(profile.shakeAmplitudePx - 4, 1)}px, 0, 0)` },
        { offset: 0.84, transform: `translate3d(${Math.max(profile.shakeAmplitudePx - 4, 1)}px, 0, 0)` },
        { offset: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      {
        duration: profile.shakeDuration,
        easing: 'linear',
        fill: 'none',
      },
    );

    alertRowShakeAnimations.set(row, shakeAnimation);
    shakeAnimation.addEventListener('finish', () => {
      if (alertRowShakeAnimations.get(row) !== shakeAnimation) {
        return;
      }
      alertRowShakeAnimations.delete(row);
      row.style.transform = '';
    });
    shakeAnimation.addEventListener('cancel', () => {
      if (alertRowShakeAnimations.get(row) !== shakeAnimation) {
        return;
      }
      alertRowShakeAnimations.delete(row);
      row.style.transform = '';
    });
  }

  glow.animate(
    [
      { offset: 0, opacity: 0, transform: 'translate3d(-10%, 0, 0) scaleX(0.94)' },
      { offset: 0.18, opacity: profile.glowPeakOpacity, transform: 'translate3d(0, 0, 0) scaleX(1)' },
      { offset: 0.84, opacity: profile.glowTailOpacity, transform: 'translate3d(6%, 0, 0) scaleX(1.02)' },
      { offset: 1, opacity: 0, transform: 'translate3d(8%, 0, 0) scaleX(1.02)' },
    ],
    {
      duration: profile.glowDuration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none',
    },
  );

  rail.animate(
    [
      { offset: 0, opacity: profile.railLeadOpacity, transform: 'scaleY(0.82) scaleX(0.8)' },
      { offset: 0.16, opacity: 1, transform: 'scaleY(1) scaleX(1.35)' },
      { offset: 0.86, opacity: profile.railTailOpacity, transform: 'scaleY(1) scaleX(1)' },
      { offset: 1, opacity: 0, transform: 'scaleY(1) scaleX(0.96)' },
    ],
    {
      duration: profile.railDuration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none',
    },
  );

  flare.animate(
    profile.doubleFlare
      ? [
        { offset: 0, opacity: 0, transform: 'translate3d(-36%, 0, 0) skewX(-14deg)' },
        { offset: 0.28, opacity: profile.flarePeakOpacity, transform: 'translate3d(-2%, 0, 0) skewX(-14deg)' },
        { offset: 0.62, opacity: 0.14, transform: 'translate3d(18%, 0, 0) skewX(-14deg)' },
        { offset: 0.9, opacity: profile.flarePeakOpacity * 0.72, transform: 'translate3d(30%, 0, 0) skewX(-14deg)' },
        { offset: 1, opacity: 0, transform: 'translate3d(48%, 0, 0) skewX(-14deg)' },
      ]
      : [
        { offset: 0, opacity: 0, transform: 'translate3d(-36%, 0, 0) skewX(-14deg)' },
        { offset: 0.34, opacity: profile.flarePeakOpacity, transform: 'translate3d(0%, 0, 0) skewX(-14deg)' },
        { offset: 0.9, opacity: profile.flarePeakOpacity * 0.18, transform: 'translate3d(32%, 0, 0) skewX(-14deg)' },
        { offset: 1, opacity: 0, transform: 'translate3d(42%, 0, 0) skewX(-14deg)' },
      ],
    {
      duration: profile.flareDuration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none',
    },
  );

  haze.animate(
    [
      { offset: 0, opacity: 0, filter: 'blur(0px)', transform: 'scale(0.998)' },
      { offset: 0.24, opacity: profile.hazePeakOpacity, filter: `blur(${profile.hazeBlurPx}px)`, transform: 'scale(1.003)' },
      { offset: 0.82, opacity: profile.hazeTailOpacity, filter: `blur(${Math.max(profile.hazeBlurPx - 3, 2)}px)`, transform: 'scale(1.002)' },
      { offset: 1, opacity: 0, filter: 'blur(0px)', transform: 'scale(1)' },
    ],
    {
      duration: profile.hazeDuration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'none',
    },
  );

  window.setTimeout(() => {
    ghost.remove();
  }, profile.removeAfterMs);
}

function getAlertFxOverlayProfile(tier: AlertFxTier) {
  switch (tier) {
    case 'critical':
      return {
        glowPeakOpacity: 0.56,
        glowTailOpacity: 0.2,
        glowDuration: 1_020,
        railLeadOpacity: 0.54,
        railTailOpacity: 0.88,
        railDuration: 940,
        flarePeakOpacity: 0.48,
        flareDuration: 1_200,
        pulseScale: 1.006,
        pulseDuration: 880,
        pulseEdgeAlpha: 52,
        pulseGlowAlpha: 38,
        pulseBlur: 26,
        doubleFlare: false,
        shakeAmplitudePx: 2,
        shakeDuration: 300,
        hazePeakOpacity: 0.16,
        hazeTailOpacity: 0.08,
        hazeBlurPx: 10,
        hazeDuration: 1_300,
        removeAfterMs: 1_520,
      } as const;
    case 'mega':
      return {
        glowPeakOpacity: 0.66,
        glowTailOpacity: 0.3,
        glowDuration: 1_520,
        railLeadOpacity: 0.62,
        railTailOpacity: 0.94,
        railDuration: 1_460,
        flarePeakOpacity: 0.58,
        flareDuration: 1_560,
        pulseScale: 1.009,
        pulseDuration: 1_620,
        pulseEdgeAlpha: 60,
        pulseGlowAlpha: 46,
        pulseBlur: 34,
        doubleFlare: true,
        shakeAmplitudePx: 14,
        shakeDuration: 760,
        hazePeakOpacity: 0.24,
        hazeTailOpacity: 0.12,
        hazeBlurPx: 14,
        hazeDuration: 1_560,
        removeAfterMs: 1_920,
      } as const;
    case 'special':
      return {
        glowPeakOpacity: 0.72,
        glowTailOpacity: 0.34,
        glowDuration: 1_640,
        railLeadOpacity: 0.68,
        railTailOpacity: 0.96,
        railDuration: 1_560,
        flarePeakOpacity: 0.64,
        flareDuration: 1_700,
        pulseScale: 1.01,
        pulseDuration: 1_760,
        pulseEdgeAlpha: 66,
        pulseGlowAlpha: 54,
        pulseBlur: 40,
        doubleFlare: true,
        shakeAmplitudePx: 18,
        shakeDuration: 880,
        hazePeakOpacity: 0.28,
        hazeTailOpacity: 0.14,
        hazeBlurPx: 16,
        hazeDuration: 1_720,
        removeAfterMs: 2_040,
      } as const;
    case 'normal':
    default:
      return {
        glowPeakOpacity: 0.44,
        glowTailOpacity: 0.2,
        glowDuration: 1_260,
        railLeadOpacity: 0.45,
        railTailOpacity: 0.86,
        railDuration: 1_180,
        flarePeakOpacity: 0.38,
        flareDuration: 1_360,
        pulseScale: 1.004,
        pulseDuration: 1_320,
        pulseEdgeAlpha: 40,
        pulseGlowAlpha: 28,
        pulseBlur: 20,
        doubleFlare: false,
        shakeAmplitudePx: 0,
        shakeDuration: 0,
        hazePeakOpacity: 0.12,
        hazeTailOpacity: 0.06,
        hazeBlurPx: 8,
        hazeDuration: 1_180,
        removeAfterMs: 1_560,
      } as const;
  }
}

function removeAlertRowImmediately(view: AlertsSectionView, button: HTMLButtonElement) {
  const row = button.closest<HTMLElement>('.alert-row');
  row?.remove();

  const alertId = button.dataset.alertId;
  if (alertId) {
    view.rowViews.delete(alertId);
    const fxState = view.fxStates.get(alertId);
    if (fxState?.settleTimer) {
      clearTimeout(fxState.settleTimer);
    }
    view.fxStates.delete(alertId);
  }

  const nextCount = view.list.querySelectorAll('.alert-row').length;
  view.count.textContent = String(nextCount);

  if (nextCount === 0) {
    view.list.replaceChildren(view.emptyState);
  }
}

function getAlertRowRenderKey(
  alert: AlertEntry,
  busy: boolean,
  isStarred: boolean,
  isAdmin: boolean,
  enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'],
  renderNow: number,
  sparkline: TokenSparklineEntry | null,
) {
  const series = Array.isArray(sparkline?.series) ? sparkline.series : [];
  return JSON.stringify({
    id: alert.id,
    kind: alert.kind,
    address: alert.address,
    mintAddress: alert.mintAddress,
    pairAddress: alert.pairAddress,
    symbol: alert.symbol,
    name: alert.name,
    createdAt: alert.createdAt,
    label: alert.label,
    pct: alert.pct,
    volume1m: alert.volume1m,
    volume5m: alert.volume5m,
    volume1h: alert.volume1h,
    volume6h: alert.volume6h,
    volume24h: alert.volume24h,
    prevVolume1m: alert.prevVolume1m,
    prevVolume5m: alert.prevVolume5m,
    prevMcap: alert.prevMcap,
    mcap: alert.mcap,
    baselineMcap: alert.baselineMcap,
    windowLowMcap: alert.windowLowMcap,
    tokenCreatedAt: alert.tokenCreatedAt,
    imageUrl: alert.imageUrl,
    pairUrl: alert.pairUrl,
    twitterUrl: alert.twitterUrl,
    isHvnc: alert.isHvnc,
    isOldSurge: alert.isOldSurge,
    surgeWindow: alert.surgeWindow,
    meteoraCurrentTvl: alert.meteoraCurrentTvl,
    meteoraBaselineTvl24h: alert.meteoraBaselineTvl24h,
    tickerPeers: alert.tickerPeers ?? null,
    busy,
    isStarred,
    isAdmin,
    enabledTradeTerminals,
    toneClass: getAlertToneClass(alert, renderNow),
    sparklineGeneratedAt: sparkline?.generatedAt ?? null,
    sparklineLatestBucketAt: sparkline?.latestBucketAt ?? null,
    sparklinePoints: series.length,
    sparklineLast: series.length > 0 ? series[series.length - 1] : null,
  });
}

function createAlertRowShell(alertId: string) {
  const article = document.createElement('article');
  article.dataset.alertId = alertId;
  article.append(buildAlertFxLayer());
  return article;
}

function getOrCreateAlertFxGhostHost() {
  const existing = document.body.querySelector<HTMLElement>('.alert-fx-ghost-host');
  if (existing) {
    return existing;
  }

  const host = document.createElement('div');
  host.className = 'alert-fx-ghost-host';
  document.body.append(host);
  return host;
}

function syncAlertRowShell(
  article: HTMLElement,
  alert: AlertEntry,
  isStarred: boolean,
  renderNow: number,
  fxState: AlertFxState,
) {
  const toneClass = getAlertToneClass(alert, renderNow);
  const visualClasses = getAlertVisualClasses(alert, renderNow, fxState.phase === 'entering');
  article.className = `alert-row ${visualClasses}${isStarred ? ' token-starred starred-card' : ''}`;
  article.dataset.hoverKey = `alert:${alert.id}`;
  article.dataset.alertId = alert.id;
  article.style.setProperty('--alert-fx-color', getAlertAccentColor(toneClass));
}

function buildAlertRowContent(
  alert: AlertEntry,
  busy: boolean,
  isStarred: boolean,
  isAdmin: boolean,
  enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'],
  renderNow: number,
  sparkline: TokenSparklineEntry | null,
  _fxState: AlertFxState,
) {
  const dexUrl = sanitizeHttpUrl(alert.pairUrl || `https://dexscreener.com/solana/${alert.address}`);
  const symbol = String(alert.symbol || '');
  const safeName = String(alert.name || '');
  const imageUrl = sanitizeOptionalHttpUrl(alert.imageUrl);
  const xSearch = buildXSearchUrl(symbol, alert.address);
  const topClass = getAlertToneClass(alert, renderNow);
  const timeLabel = new Date(alert.createdAt).toLocaleTimeString('en-US');
  const grid = document.createElement('div');
  grid.className = 'alert-grid';
  const body = document.createElement('div');
  body.className = 'alert-body-v68';
  const time = document.createElement('div');
  time.className = 'alert-time-v68';
  time.textContent = timeLabel;

  const main = document.createElement('div');
  main.className = 'alert-main-v68';
  main.append(buildAlertAvatar(symbol, imageUrl));

  const copyBlock = document.createElement('div');
  copyBlock.className = 'alert-copy-block';

  const top = document.createElement('div');
  top.className = 'alert-top-v68';
  const tokenLine = document.createElement('span');
  tokenLine.className = 'alert-token-v68';
  tokenLine.append(symbol);
  const tokenName = document.createElement('span');
  tokenName.className = 'alert-token-name';
  tokenName.textContent = safeName;
  const tickerPeersControl = buildTickerPeersControl(alert);
  if (tickerPeersControl) {
    tokenLine.append(' ', tickerPeersControl);
  }
  tokenLine.append(' ', tokenName);
  top.append(tokenLine);

  const flowLine = document.createElement('div');
  flowLine.className = 'alert-flow-v68';
  appendAlertFlowLine(flowLine, alert);

  copyBlock.append(top, flowLine);
  main.append(copyBlock);

  const statsLine = document.createElement('div');
  statsLine.className = 'alert-stats-v68';
  appendAlertStatsLine(statsLine, alert);

  const content = document.createElement('div');
  content.className = 'alert-content-v68';

  const chart = buildAlertSparklineBlock(alert.id, alert.address, sparkline);
  const side = document.createElement('div');
  side.className = 'alert-side-v68';
  side.append(buildAlertHeadline(alert, topClass), buildAlertDismissButton(alert.id));
  const rail = document.createElement('div');
  rail.className = 'alert-rail-v68';
  rail.append(chart, side);

  const links = document.createElement('div');
  links.className = 'alert-links-v68';
  links.append(
    buildInlineLink('Dex Screener', dexUrl),
    buildTextSeparator(),
    buildInlineLink('X Buscar CA / ', sanitizeHttpUrl(xSearch)),
    buildTextSeparator(),
    buildProfileLink(alert.twitterUrl),
  );

  const actions = document.createElement('div');
  actions.className = 'alert-actions-v68';
  actions.append(
    buildActionButton('Copiar CA', 'alert-action-button copy-button', 'copy-address', alert.address),
    buildTradeTerminalMenuElement(alert.address, alert.mintAddress, alert.pairAddress, {
      enabledTradeTerminals,
    }),
    buildStarButton(alert.address, isStarred, busy, 'Star token'),
    buildActionButton('Block', 'alert-action-button danger', 'block-token', alert.address, symbol, busy),
  );

  if (isAdmin) {
    actions.append(buildActionButton('Admin Block', 'alert-action-button danger', 'admin-block-token', alert.address, symbol, busy));
  }

  content.append(main, statsLine, links, actions);
  body.append(content, rail);
  grid.append(body, time);
  return grid;
}

function buildAlertSparklineBlock(alertId: string, address: string, sparkline: TokenSparklineEntry | null) {
  const chart = document.createElement('div');
  chart.className = 'alert-chart-v1';
  chart.innerHTML = renderSparklineFigure(sparkline, address, { areaFill: true, lookupKey: alertId, variant: 'alert' });
  return chart;
}

function buildAlertFxLayer() {
  const layer = document.createElement('div');
  layer.className = 'alert-fx-layer';

  const rail = document.createElement('div');
  rail.className = 'alert-fx-rail';

  const glow = document.createElement('div');
  glow.className = 'alert-fx-glow';

  const flare = document.createElement('div');
  flare.className = 'alert-fx-flare';

  layer.append(rail, glow, flare);
  return layer;
}

function buildAlertFxGhost(tier: AlertFxTier, rect: DOMRect, accentColor: string) {
  const ghost = document.createElement('div');
  ghost.className = 'alert-fx-ghost';
  ghost.dataset.fxTier = tier;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  if (accentColor) {
    ghost.style.setProperty('--alert-fx-color', accentColor);
  }

  const stage = document.createElement('div');
  stage.className = 'alert-fx-ghost-stage';

  const rail = document.createElement('div');
  rail.className = 'alert-fx-ghost-rail';

  const glow = document.createElement('div');
  glow.className = 'alert-fx-ghost-glow';

  const flare = document.createElement('div');
  flare.className = 'alert-fx-ghost-flare';

  const haze = document.createElement('div');
  haze.className = 'alert-fx-ghost-haze';

  stage.append(rail, glow, flare, haze);
  ghost.append(stage);
  return ghost;
}

function getAlertAccentColor(toneClass: string) {
  switch (toneClass) {
    case 'critical':
      return 'var(--yellow)';
    case 'dump-alert':
      return 'var(--red)';
    case 'meteora-surge':
      return '#b06aff';
    case 'mega':
    case 'old-surge':
      return '#ff6b00';
    case 'pump-alert':
      return 'var(--pump-color)';
    case 'recent-surge':
      return 'var(--green)';
    case 'normal':
    default:
      return '#2ea8ff';
  }
}

function buildAlertAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'alert-avatar';
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'alert-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildAlertHeadline(alert: AlertEntry, toneClass: string) {
  const badge = document.createElement('span');
  if (isHighCapDumpAlert(alert)) {
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append('💥 Dump Alert!', document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'MCAP 5M')));
    return badge;
  }
  if (alert.isOldSurge) {
    const surgeTitle = toneClass === 'recent-surge' ? 'RECENT TOKEN SURGE' : 'OLD TOKEN SURGE';
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append(`🔥 ${surgeTitle}`, document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'PCHANGE')));
    return badge;
  }
  if (alert.kind === 'meteora-surge') {
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append('🌊 Meteora Alert 1h', document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'METEORA 1H')));
    return badge;
  }
  if (alert.isHvnc) {
    badge.className = 'alert-badge-v68 mega';
    badge.append('🚨 High Volume New Coin', document.createElement('br'), buildAlertBadgeSub(fmtMoney(alert.volume24h), 'total vol'));
    return badge;
  }
  badge.className = `alert-pct-v68 ${toneClass}`;
  badge.append(`${fmtPct(alert.pct)} `);
  const label = document.createElement('span');
  label.textContent = String(alert.label || 'VOL');
  badge.append(label);
  return badge;
}

function buildAlertBadgeSub(primary: string, secondary: string) {
  const sub = document.createElement('span');
  sub.className = 'alert-badge-sub';
  sub.textContent = `${primary} ${secondary}`;
  return sub;
}

function buildXSearchUrl(symbol: string, address: string) {
  const queryParts = [String(address || '').trim(), `$${String(symbol || '').trim()}`]
    .filter(Boolean);
  return `https://x.com/search?q=${encodeURIComponent(queryParts.join(' OR '))}`;
}

function appendAlertFlowLine(container: HTMLElement, alert: AlertEntry) {
  if (isHighCapDumpAlert(alert)) {
    appendHighCapDumpFlowLine(container, alert);
    return;
  }

  const isGmgnVol1m = alert.ruleKey === 'gmgn-vol-1m';
  const currentVol = fmtMoney(isGmgnVol1m ? alert.volume1m : alert.volume5m);
  const currentMcap = fmtMoney(alert.mcap);
  const prevVolRaw = isGmgnVol1m ? alert.prevVolume1m : alert.prevVolume5m;
  const prevVol = prevVolRaw != null ? fmtMoney(prevVolRaw) : null;
  const prevMcap = alert.prevMcap != null ? fmtMoney(alert.prevMcap) : null;
  const mcapTone = alert.prevMcap != null && alert.mcap != null && alert.mcap < alert.prevMcap ? 'down' : 'up';
  const volumeLabel = isGmgnVol1m ? 'VOL 1M' : 'VOL 5M';

  if (alert.isOldSurge) {
    container.append(
      buildMetricPair('MCAP', currentMcap, 'up'),
      buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', getAlertAgeToneClass(alert)),
    );
    return;
  }

  if (alert.isHvnc) {
    container.classList.add('alert-flow-v68-hvnc');
  }

  container.append(
    prevVol
      ? buildFlowTransition(volumeLabel, prevVol, currentVol, 'up')
      : buildMetricPair(volumeLabel, currentVol, 'up'),
  );
  if (!alert.isHvnc) {
    const gap = document.createElement('span');
    gap.className = 'flow-gap';
    container.append(gap);
  }
  container.append(
    prevMcap
      ? buildFlowTransition('MCAP', prevMcap, currentMcap, mcapTone)
      : buildMetricPair('MCAP', currentMcap, mcapTone),
  );
}

function appendAlertStatsLine(container: HTMLElement, alert: AlertEntry) {
  if (isHighCapDumpAlert(alert)) {
    appendHighCapDumpStatsLine(container, alert);
    return;
  }

  if (alert.isOldSurge) {
    appendMetricRow(container, [
      buildMetricPair('1H', fmtMoney(alert.volume1h), 'white'),
      buildMetricPair('6H', fmtMoney(alert.volume6h), 'white'),
      buildMetricPair('24H', fmtMoney(alert.volume24h), 'white'),
    ]);
  } else {
    const shouldShowCompactMcap = alert.kind !== 'monitored-vol' && alert.kind !== 'monitored-mcap';
    const compactMcap = shouldShowCompactMcap ? buildMetricPair('MCAP', fmtMoney(alert.mcap), 'up', '', 'current-mcap') : null;
    compactMcap?.classList.add('compact-only-metric');
    const row = appendMetricRow(container, [
      compactMcap,
      buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', getAlertAgeToneClass(alert)),
      buildMetricPair('1H', fmtMoney(alert.volume1h), 'white'),
      buildMetricPair('6H', fmtMoney(alert.volume6h), 'white'),
      buildMetricPair('24H', fmtMoney(alert.volume24h), 'white'),
    ]);
    if (alert.isHvnc) {
      row?.classList.add('alert-stats-row-v68-hvnc');
    }
  }

  if (alert.kind !== 'meteora-surge') {
    return;
  }

  const currentPool = Number(alert.meteoraCurrentTvl);
  const baselinePool24h = Number(alert.meteoraBaselineTvl24h);
  if (!(currentPool > 0)) {
    return;
  }

  if (Number.isFinite(baselinePool24h) && baselinePool24h > 0) {
    appendMetricRow(container, [
      buildFlowTransition('POOL', fmtMoney(baselinePool24h), fmtMoney(currentPool), 'up', 'meteora-pool-label', 'meteora-pool-value'),
    ]);
    return;
  }

  appendMetricRow(container, [
    buildMetricPair('POOL', fmtMoney(currentPool), 'up', 'meteora-pool-label', 'meteora-pool-value'),
  ]);
}

function appendMetricRow(container: HTMLElement, items: Array<HTMLElement | null | undefined>) {
  const row = document.createElement('div');
  row.className = 'alert-stats-row-v68';

  for (const item of items) {
    if (!item) {
      continue;
    }
    row.append(item);
  }

  if (row.childElementCount > 0) {
    container.append(row);
    return row;
  }

  return null;
}

function buildMetricPair(label: string, value: string, toneClass: string, labelClass = '', valueClass = '') {
  const wrapper = document.createElement('span');
  wrapper.className = getAlertMetricClass(label);
  const labelEl = document.createElement('span');
  labelEl.className = ['label', labelClass].filter(Boolean).join(' ');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = ['value', toneClass, valueClass].filter(Boolean).join(' ');
  valueEl.textContent = value;
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
}

function buildFlowTransition(label: string, previous: string, next: string, toneClass: string, labelClass = '', valueClass = '') {
  const wrapper = document.createElement('span');
  wrapper.className = getAlertMetricClass(label);
  const labelEl = document.createElement('span');
  labelEl.className = ['label', labelClass].filter(Boolean).join(' ');
  labelEl.textContent = label;
  wrapper.append(labelEl, ` ${previous} → `);
  const valueEl = document.createElement('span');
  valueEl.className = ['value', toneClass, valueClass].filter(Boolean).join(' ');
  valueEl.textContent = next;
  wrapper.append(valueEl);
  return wrapper;
}

function getAlertMetricClass(label: string) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized.startsWith('vol')) {
    return 'alert-flow-vol';
  }
  if (normalized === 'mcap') {
    return 'alert-flow-mcap';
  }
  return '';
}

function buildInlineLink(label: string, href: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'alert-inline-link';
  link.textContent = label;
  return link;
}

function buildProfileLink(url: string | null | undefined) {
  const safeUrl = sanitizeOptionalHttpUrl(url);
  if (!safeUrl) {
    const disabled = document.createElement('span');
    disabled.className = 'alert-inline-link alert-inline-link-social alert-inline-link-social-profile disabled';
    disabled.textContent = '👤';
    return disabled;
  }
  const isCommunity = isXCommunityUrl(safeUrl);
  const link = buildInlineLink(isCommunity ? '👥' : '👤', sanitizeHttpUrl(safeUrl));
  link.classList.add('alert-inline-link-social');
  link.classList.add(isCommunity ? 'alert-inline-link-social-community' : 'alert-inline-link-social-profile');
  return link;
}

function buildTextSeparator() {
  const separator = document.createElement('span');
  separator.textContent = '/';
  return separator;
}

function buildActionButton(
  label: string,
  className: string,
  action: string,
  address: string,
  dataLabel?: string | null,
  disabled = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (dataLabel) {
    button.dataset.label = dataLabel;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function buildAlertDismissButton(alertId: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'alert-dismiss-button';
  button.dataset.action = 'remove-alert';
  button.dataset.alertId = alertId;
  button.setAttribute('aria-label', 'Remove alert');
  button.textContent = '×';
  return button;
}

function buildStarButton(address: string, isStarred: boolean, disabled: boolean, title: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.disabled = disabled;
  button.title = title;
  button.textContent = isStarred ? '★' : '☆';
  return button;
}

function isXCommunityUrl(url: string | null | undefined) {
  const value = String(url || '').trim().toLowerCase();
  return value.includes('x.com/i/communities/') || value.includes('twitter.com/i/communities/');
}

function appendHighCapDumpFlowLine(container: HTMLElement, alert: AlertEntry) {
  const baselineMcap = fmtMoney(alert.baselineMcap ?? alert.prevMcap ?? null);
  const currentMcap = fmtMoney(alert.mcap);
  const dropAmount = fmtMoney(getHighCapDumpDropAmount(alert));

  container.append(buildFlowTransition('MCAP', baselineMcap, currentMcap, 'down'));
  const gap = document.createElement('span');
  gap.className = 'flow-gap';
  container.append(gap);
  container.append(buildMetricPair('DROP', dropAmount, 'down'));
}

function appendHighCapDumpStatsLine(container: HTMLElement, alert: AlertEntry) {
  appendMetricRow(container, [
    buildMetricPair('CURRENT', fmtMoney(alert.mcap), 'down current-mcap'),
    buildMetricPair('DROP', fmtMoney(getHighCapDumpDropAmount(alert)), 'down'),
    buildMetricPair('LOW 5M', fmtMoney(alert.windowLowMcap ?? null), 'down'),
    buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', getAlertAgeToneClass(alert)),
  ]);
  appendMetricRow(container, [
    buildMetricPair('1H', fmtMoney(alert.volume1h), 'white'),
    buildMetricPair('6H', fmtMoney(alert.volume6h), 'white'),
    buildMetricPair('24H', fmtMoney(alert.volume24h), 'white'),
  ]);
}

function getHighCapDumpDropAmount(alert: AlertEntry) {
  const baseline = Number(alert.baselineMcap ?? alert.prevMcap);
  const windowLow = Number(alert.windowLowMcap);
  if (!Number.isFinite(baseline) || !Number.isFinite(windowLow)) {
    return null;
  }

  return Math.max(0, baseline - windowLow);
}

function getAlertAgeToneClass(alert: AlertEntry) {
  const tokenCreatedAt = Number(alert.tokenCreatedAt);
  if (!(tokenCreatedAt > 0)) {
    return 'white';
  }

  return getAgeToneClassFromAgeMs(Math.max(0, Date.now() - tokenCreatedAt));
}

function getAgeToneClassFromAgeMs(ageMs: number | null | undefined) {
  if (!(Number(ageMs) >= 0)) {
    return 'white';
  }

  return Number(ageMs) < 24 * 60 * 60 * 1000 ? 'up' : 'down';
}

function fmtAgeFromDurationMs(ageMs: number | null | undefined) {
  if (ageMs == null) {
    return '-';
  }

  const duration = Number(ageMs);
  if (!Number.isFinite(duration) || duration < 0) {
    return '-';
  }

  const monthDays = 30;
  const months = Math.floor(duration / (monthDays * 86400000));
  if (months >= 12) {
    return `${Math.floor(months / 12)}y`;
  }
  if (months >= 1) {
    return `${months}mo`;
  }

  const days = Math.floor(duration / 86400000);
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(duration / 3600000);
  if (hours >= 1) {
    return `${hours}h`;
  }
  const minutes = Math.floor(duration / 60000);
  if (minutes >= 1) {
    return `${minutes}m`;
  }
  return '0m';
}

function buildTickerPeersControl(alert: AlertEntry) {
  const count = Number(alert.tickerPeers?.count) || 0;
  if (count <= 1) {
    return null;
  }

  const peerRole = resolveTickerPeersBadgeRole(alert.tickerPeers);
  const details = document.createElement('details');
  details.className = 'alert-ticker-peers-panel';

  const summary = document.createElement('summary');
  summary.className = 'alert-ticker-peers-badge';
  summary.title = buildTickerPeersBadgeTitle(alert.tickerPeers, count, peerRole);
  const badgeMark = document.createElement('span');
  badgeMark.className = 'alert-ticker-peers-badge-mark';
  badgeMark.dataset.peerRole = peerRole;
  badgeMark.textContent = getTickerPeersBadgeMark(peerRole);
  summary.append(badgeMark);

  const list = document.createElement('div');
  list.className = 'alert-ticker-peers-list';
  const items = Array.isArray(alert.tickerPeers?.items) ? alert.tickerPeers.items : [];

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'alert-ticker-peers-row';

    const identity = document.createElement('div');
    identity.className = 'alert-ticker-peers-identity';
    identity.append(buildAlertAvatar(String(item.symbol || '?'), sanitizeOptionalHttpUrl(item.imageUrl)));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'action-glyph copy-button alert-ticker-peers-copy';
    copy.dataset.action = 'copy-address';
    copy.dataset.address = item.address;
    copy.title = 'Copy contract';
    copy.textContent = '⧉';

    const identityText = document.createElement('div');
    identityText.className = 'alert-ticker-peers-text';

    const symbol = document.createElement('div');
    symbol.className = 'alert-ticker-peers-symbol';
    symbol.textContent = item.symbol || item.address.slice(0, 8);

    const address = document.createElement('div');
    address.className = 'alert-ticker-peers-address';
    address.textContent = `${item.address.slice(0, 4)}...${item.address.slice(-4)}`;

    identityText.append(symbol, address);
    identity.append(identityText, copy);

    const stats = document.createElement('div');
    stats.className = 'alert-ticker-peers-stats';
    const mcapLabel = document.createElement('span');
    mcapLabel.textContent = fmtMoney(item.mcap);
    const separator = document.createElement('span');
    separator.textContent = ' • ';
    const ageMs = resolveTickerPeerAgeMs(alert, item);
    const age = document.createElement('span');
    age.className = `alert-ticker-peers-age ${getAgeToneClassFromAgeMs(ageMs)}`;
    age.textContent = fmtAgeFromDurationMs(ageMs);
    stats.append(mcapLabel, separator, age);

    row.append(identity, stats);
    list.append(row);
  }

  details.append(summary, list);
  return details;
}

function resolveTickerPeersBadgeRole(tickerPeers: AlertEntry['tickerPeers']) {
  if (tickerPeers?.sourcePeerRole === 'og') {
    return 'og';
  }
  if (tickerPeers?.sourcePeerRole === 'mcap_leader') {
    return 'mcap_leader';
  }
  return 'peer_warning';
}

function getTickerPeersBadgeMark(role: 'og' | 'mcap_leader' | 'peer_warning') {
  if (role === 'og') {
    return 'OG';
  }
  if (role === 'mcap_leader') {
    return '#1';
  }
  return '!';
}

function buildTickerPeersBadgeTitle(
  tickerPeers: AlertEntry['tickerPeers'],
  count: number,
  role: 'og' | 'mcap_leader' | 'peer_warning',
) {
  if (role === 'og') {
    return 'OG ticker peer: oldest known exact ticker match';
  }
  if (role === 'mcap_leader') {
    return 'Market-cap leader among exact ticker peers';
  }
  return tickerPeers?.hasSubtickerMatch
    ? `${count} ticker/subticker peers snapshot`
    : `${count} ticker peers snapshot`;
}

function resolveTickerPeerAgeMs(
  alert: AlertEntry,
  item: NonNullable<NonNullable<AlertEntry['tickerPeers']>['items']>[number],
) {
  const ageMsAtAlert = Number(item.ageMsAtAlert);
  if (Number.isFinite(ageMsAtAlert) && ageMsAtAlert >= 0) {
    return ageMsAtAlert;
  }

  const tokenCreatedAt = Number(item.tokenCreatedAt);
  const alertCreatedAt = Number(alert.createdAt);
  if (Number.isFinite(tokenCreatedAt) && tokenCreatedAt > 0 && Number.isFinite(alertCreatedAt) && alertCreatedAt > 0) {
    return Math.max(0, alertCreatedAt - tokenCreatedAt);
  }

  return null;
}
