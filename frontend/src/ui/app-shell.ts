import type { AppController, AppRenderRegion } from '../state/app-controller';
import { getManualTokens, getMockTradingPositionView, getMockTradingSummaryView, getMonitoredTokens, getOldWeekTokens, getRecentTokens, getTrackedToken, isProfileAuthPanel, type AppState } from '../state/app-state';
import { renderAlertsSection } from './sections/alerts-section';
import { renderLegacyShell, renderWorkspaceHeader, renderWorkspaceProfileOverlay } from './sections/layout-sections';
import { renderBidZoneSection } from './sections/bid-zone-section';
import { renderManualTokensSection } from './sections/manual-section';
import { renderMonitoredSection } from './sections/monitored-section';
import { patchOldWeekSection, patchRecentSection, renderOldWeekSection, renderRecentSection } from './sections/routed-sections';
import { resolveManualTableRows } from '../utils/token-table';

type ConfigDraft = {
  values: Record<string, string>;
  focusedName: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type PanelScrollDraft = {
  monitored: number;
  bidZone: number;
  pumpfun: number;
  pumpMigrations: number;
  alerts: number;
};

type ProfileModalScrollDraft = {
  panel: string | null;
  scrollTop: number;
};

type LoginDraft = {
  email: string;
  password: string;
  passwordVisible: boolean;
};

type ChangePasswordDraft = {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  currentVisible: boolean;
  newVisible: boolean;
  confirmVisible: boolean;
};

type RegisterDraft = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  inviteCode: string;
  passwordVisible: boolean;
  confirmVisible: boolean;
};

type InviteAssistanceDraft = {
  inviteCode: string;
};

type PasswordResetDraft = {
  email: string;
  newPassword: string;
  confirmNewPassword: string;
  passwordVisible: boolean;
  confirmVisible: boolean;
};

type EmailVerificationDraft = {
  email: string;
};

type EmailOtpDraft = {
  code: string;
};

type UserMenuDraft = {
  open: boolean;
};

type SearchInputDraft = {
  key: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type LiveResizablePanelKey = 'monitored' | 'alerts';
type LiveWorkspacePanelKey = 'monitored' | 'pumpfun' | 'alerts';

type LivePanelResizeDraft = {
  panelKey: LiveResizablePanelKey;
  item: HTMLElement;
  panels: HTMLElement;
  startX: number;
  startSpan: 1 | 2 | 3;
  previewSpan: 1 | 2 | 3;
  direction: -1 | 1;
  anchor: 'left' | 'right';
  anchorLine: number;
  preferredRow: number;
  originalOrder: LiveWorkspacePanelKey[];
  previewOrder: LiveWorkspacePanelKey[];
};

type LivePanelResizePendingDraft = {
  item: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  zone: 'right' | 'left';
};

type LivePanelReorderDraft = {
  panelKey: LiveWorkspacePanelKey;
  item: HTMLElement;
  panels: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  originalOrder: LiveWorkspacePanelKey[];
  previewOrder: LiveWorkspacePanelKey[];
};

type LivePanelReorderPendingDraft = {
  item: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
};

type AppRenderFrame = {
  frame: HTMLElement;
  headerSlot: HTMLElement;
  shell: HTMLElement;
  toastsSlot: HTMLElement;
  legacySlot: HTMLElement;
  oldWeekSlot: HTMLElement;
  recentSlot: HTMLElement;
  manualSlot: HTMLElement;
  panels: HTMLElement;
  monitoredStack: HTMLElement;
  monitoredSlot: HTMLElement;
  bidZoneSlot: HTMLElement;
  pumpfunSlot: HTMLElement;
  alertsSlot: HTMLElement;
  overlaySlot: HTMLElement;
};

const APP_RENDER_FRAME_SELECTOR = '[data-app-render-frame]';
const APP_HEADER_SLOT_SELECTOR = '[data-app-render-slot="header"]';
const APP_SHELL_SELECTOR = '[data-app-render-slot="shell"]';
const APP_TOASTS_SLOT_SELECTOR = '[data-app-render-slot="toasts"]';
const APP_LEGACY_SLOT_SELECTOR = '[data-app-render-slot="legacy"]';
const APP_OLD_WEEK_SLOT_SELECTOR = '[data-app-render-slot="old-week"]';
const APP_RECENT_SLOT_SELECTOR = '[data-app-render-slot="recent"]';
const APP_MANUAL_SLOT_SELECTOR = '[data-app-render-slot="manual"]';
const APP_PANELS_SELECTOR = '[data-app-render-slot="panels"]';
const APP_MONITORED_STACK_SELECTOR = '.monitored-stack';
const LIVE_PANEL_DRAG_HANDLE_SELECTOR = '[data-live-panel-drag-handle="true"]';
const LIVE_PANEL_RESIZE_FRAME_SELECTOR = '[data-live-panel-resize-frame="true"]';
const LIVE_PANEL_RESIZE_ZONE_SELECTOR = '[data-live-panel-resize-zone]';
const LIVE_PANEL_COLLAPSED_STACK_SELECTOR = '[data-live-panel-collapsed-stack="true"]';
const APP_MONITORED_SLOT_SELECTOR = '[data-app-render-slot="monitored"]';
const APP_BID_ZONE_SLOT_SELECTOR = '[data-app-render-slot="bid-zone"]';
const APP_PUMPFUN_SLOT_SELECTOR = '[data-app-render-slot="pumpfun"]';
const APP_ALERTS_SLOT_SELECTOR = '[data-app-render-slot="alerts"]';
const APP_OVERLAY_SLOT_SELECTOR = '[data-app-render-slot="overlay"]';
const ALERTS_RENDER_DEBUG_STORAGE_KEY = 'trendscope-alert-render-debug-enabled';
const LIVE_PANEL_REORDER_ACTIVATION_DISTANCE = 14;
const LIVE_PANEL_RESIZE_ACTIVATION_DISTANCE = 16;

export function renderAppShell(
  root: HTMLElement,
  state: AppState,
  controller: AppController,
  dirtyRegions: ReadonlySet<AppRenderRegion> = new Set<AppRenderRegion>(['all']),
) {
  const configDraft = captureConfigDraft(root);
  const panelScrollDraft = capturePanelScrollDraft(root);
  const profileModalScrollDraft = captureProfileModalScrollDraft(root);
  const loginDraft = captureLoginDraft(root);
  const changePasswordDraft = captureChangePasswordDraft(root);
  const registerDraft = captureRegisterDraft(root);
  const emailVerificationDraft = captureEmailVerificationDraft(root);
  const emailOtpDraft = captureEmailOtpDraft(root);
  const inviteAssistanceDraft = captureInviteAssistanceDraft(root);
  const passwordResetDraft = capturePasswordResetDraft(root);
  const userMenuDraft = captureUserMenuDraft(root);
  const searchInputDraft = captureSearchInputDraft(root);
  const renderFrame = ensureAppRenderFrame(root);
  const isLiveWorkspace = state.ui.workspace === 'live';
  const isHistoryWorkspace = state.ui.workspace === 'history';
  const pathname = typeof window !== 'undefined' ? window.location.pathname || '/' : '/';
  const isAccountSecurityRoute = pathname === '/account-security' || pathname.startsWith('/account-security/');
  updateRegionSlot(renderFrame.headerSlot, 'header', dirtyRegions, getHeaderRenderKey(state), () => (
    state.session.status === 'authenticated' && !isAccountSecurityRoute
      ? [renderWorkspaceHeader(state, controller)]
      : []
  ));

  renderFrame.toastsSlot.hidden = true;
  updateRenderSlot(renderFrame.toastsSlot, 'hidden', () => []);
  updateRegionSlot(renderFrame.legacySlot, 'legacy', dirtyRegions, getLegacyRenderKey(state), () => [renderLegacyShell(state, controller)]);

  if (state.session.status === 'authenticated' && !isAccountSecurityRoute) {
    renderFrame.oldWeekSlot.hidden = !isHistoryWorkspace;
    renderFrame.recentSlot.hidden = !isHistoryWorkspace;
    renderFrame.manualSlot.hidden = !isLiveWorkspace;
    renderFrame.panels.hidden = false;

    if (isHistoryWorkspace) {
      updateRegionSlot(
        renderFrame.oldWeekSlot,
        'old-week',
        dirtyRegions,
        getOldWeekRenderKey(state),
        () => [renderOldWeekSection(state, controller)],
        () => patchOldWeekSection(renderFrame.oldWeekSlot, state, controller),
      );
      updateRegionSlot(
        renderFrame.recentSlot,
        'recent',
        dirtyRegions,
        getRecentRenderKey(state),
        () => [renderRecentSection(state, controller)],
        () => patchRecentSection(renderFrame.recentSlot, state, controller),
      );
    } else {
      updateRenderSlot(renderFrame.oldWeekSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.recentSlot, 'hidden', () => []);
    }

    if (isLiveWorkspace) {
      updateRegionSlot(renderFrame.manualSlot, 'manual', dirtyRegions, getManualRenderKey(state), () => [renderManualTokensSection(state, controller)]);
      updateRegionSlot(renderFrame.monitoredSlot, 'monitored', dirtyRegions, getMonitoredRenderKey(state), () => [renderMonitoredSection(state, controller)]);
      updateRenderSlot(renderFrame.pumpfunSlot, 'hidden', () => []);
      logAlertsRenderDebug(renderFrame.alertsSlot, state, dirtyRegions);
      updateRegionSlot(renderFrame.alertsSlot, 'alerts', dirtyRegions, getAlertsRenderKey(state), () => [renderAlertsSection(state, controller)]);
    } else {
      updateRenderSlot(renderFrame.manualSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.monitoredSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.pumpfunSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.alertsSlot, 'hidden', () => []);
    }

    renderFrame.monitoredSlot.hidden = !isLiveWorkspace;
    renderFrame.pumpfunSlot.hidden = true;
    renderFrame.alertsSlot.hidden = !isLiveWorkspace;
    renderFrame.bidZoneSlot.hidden = !isHistoryWorkspace;

    if (isHistoryWorkspace) {
      updateRegionSlot(renderFrame.bidZoneSlot, 'bid-zone', dirtyRegions, getBidZoneRenderKey(state), () => [renderBidZoneSection(state, controller)]);
    } else {
      updateRenderSlot(renderFrame.bidZoneSlot, 'hidden', () => []);
    }
  } else {
    renderFrame.oldWeekSlot.hidden = true;
    renderFrame.recentSlot.hidden = true;
    renderFrame.manualSlot.hidden = true;
    renderFrame.panels.hidden = true;

    updateRenderSlot(renderFrame.oldWeekSlot, 'hidden', () => []);
    updateRenderSlot(renderFrame.recentSlot, 'hidden', () => []);
    updateRenderSlot(renderFrame.manualSlot, 'hidden', () => []);
    renderFrame.monitoredSlot.replaceChildren();
    renderFrame.bidZoneSlot.replaceChildren();
    renderFrame.pumpfunSlot.replaceChildren();
    renderFrame.alertsSlot.replaceChildren();
  }

  syncLivePanelLayout(renderFrame, state);

  updateRegionSlot(renderFrame.overlaySlot, 'overlay', dirtyRegions, getOverlayRenderKey(state), () => {
    const profileOverlay = state.session.status === 'authenticated' && !isAccountSecurityRoute
      ? renderWorkspaceProfileOverlay(state, controller)
      : null;
    return profileOverlay ? [profileOverlay] : [];
  });
  syncProfileModalScrollLock(state);
  applyLoginDraft(root, loginDraft, state);
  applyLoginFocus(root, state);
  applyChangePasswordDraft(root, changePasswordDraft);
  applyChangePasswordFocus(root, state, changePasswordDraft);
  applyRegisterDraft(root, registerDraft);
  applyRegisterFocus(root, state);
  applyEmailVerificationDraft(root, emailVerificationDraft, state);
  applyEmailVerificationFocus(root, state);
  applyEmailOtpDraft(root, emailOtpDraft);
  applyEmailOtpFocus(root, state);
  applyInviteAssistanceDraft(root, inviteAssistanceDraft);
  applyInviteAssistanceFocus(root, state);
  applyPasswordResetDraft(root, passwordResetDraft);
  applyPasswordResetFocus(root, state);
  applyUserMenuDraft(root, userMenuDraft);
  applySearchInputDraft(root, searchInputDraft);
  applyConfigDraft(root, configDraft, state);
  applyPanelScrollDraft(root, panelScrollDraft);
  applyProfileModalScrollDraft(root, profileModalScrollDraft);
  wireHoverPersistence(root);
  wireTradeMenus(root);
  wireSortMenus(root);
  wireUserMenus(root);
  wireProfileModals(root, controller);
  wireSectionCollapseToggles(root, controller);
  wireLivePanelReorder(root, controller);
  wireLivePanelResize(root, controller);
  applyHoverState(root);
}

function tryGetExistingAppRenderFrame(root: HTMLElement): AppRenderFrame | null {
  const existingFrame = root.querySelector<HTMLElement>(APP_RENDER_FRAME_SELECTOR);
  const existingRenderFrame = {
    frame: existingFrame,
    headerSlot: existingFrame?.querySelector<HTMLElement>(APP_HEADER_SLOT_SELECTOR),
    shell: existingFrame?.querySelector<HTMLElement>(APP_SHELL_SELECTOR),
    toastsSlot: existingFrame?.querySelector<HTMLElement>(APP_TOASTS_SLOT_SELECTOR),
    legacySlot: existingFrame?.querySelector<HTMLElement>(APP_LEGACY_SLOT_SELECTOR),
    oldWeekSlot: existingFrame?.querySelector<HTMLElement>(APP_OLD_WEEK_SLOT_SELECTOR),
    recentSlot: existingFrame?.querySelector<HTMLElement>(APP_RECENT_SLOT_SELECTOR),
    manualSlot: existingFrame?.querySelector<HTMLElement>(APP_MANUAL_SLOT_SELECTOR),
    panels: existingFrame?.querySelector<HTMLElement>(APP_PANELS_SELECTOR),
    monitoredStack: existingFrame?.querySelector<HTMLElement>(APP_MONITORED_STACK_SELECTOR),
    monitoredSlot: existingFrame?.querySelector<HTMLElement>(APP_MONITORED_SLOT_SELECTOR),
    bidZoneSlot: existingFrame?.querySelector<HTMLElement>(APP_BID_ZONE_SLOT_SELECTOR),
    pumpfunSlot: existingFrame?.querySelector<HTMLElement>(APP_PUMPFUN_SLOT_SELECTOR),
    alertsSlot: existingFrame?.querySelector<HTMLElement>(APP_ALERTS_SLOT_SELECTOR),
    overlaySlot: existingFrame?.querySelector<HTMLElement>(APP_OVERLAY_SLOT_SELECTOR),
  };

  if (Object.values(existingRenderFrame).every(Boolean)) {
    return existingRenderFrame as AppRenderFrame;
  }

  return null;
}

function createRenderSlot(name: string) {
  const slot = document.createElement('div');
  slot.dataset.appRenderSlot = name;
  return slot;
}

function createAppRenderFrame(root: HTMLElement): AppRenderFrame {
  const frame = document.createElement('div');
  frame.dataset.appRenderFrame = 'true';

  const headerSlot = createRenderSlot('header');

  const shell = createRenderSlot('shell');
  shell.className = 'app-shell';

  const toastsSlot = createRenderSlot('toasts');
  const legacySlot = createRenderSlot('legacy');
  const oldWeekSlot = createRenderSlot('old-week');
  const recentSlot = createRenderSlot('recent');
  const manualSlot = createRenderSlot('manual');
  const panels = createRenderSlot('panels');
  panels.className = 'legacy-panels';

  const monitoredStack = document.createElement('div');
  monitoredStack.className = 'panel-stack monitored-stack';

  const monitoredSlot = createRenderSlot('monitored');
  const bidZoneSlot = createRenderSlot('bid-zone');
  const pumpfunSlot = createRenderSlot('pumpfun');
  const alertsSlot = createRenderSlot('alerts');

  monitoredStack.append(monitoredSlot, bidZoneSlot);
  panels.append(monitoredStack, pumpfunSlot, alertsSlot);
  shell.append(toastsSlot, legacySlot, oldWeekSlot, recentSlot, manualSlot, panels);

  const overlaySlot = createRenderSlot('overlay');

  frame.append(headerSlot, shell, overlaySlot);
  root.replaceChildren(frame);

  return {
    frame,
    headerSlot,
    shell,
    toastsSlot,
    legacySlot,
    oldWeekSlot,
    recentSlot,
    manualSlot,
    panels,
    monitoredStack,
    monitoredSlot,
    bidZoneSlot,
    pumpfunSlot,
    alertsSlot,
    overlaySlot,
  };
}

function ensureAppRenderFrame(root: HTMLElement): AppRenderFrame {
  return tryGetExistingAppRenderFrame(root) ?? createAppRenderFrame(root);
}

function syncLivePanelDragHandle(element: HTMLElement, panelKey: LiveWorkspacePanelKey, enabled: boolean) {
  const existingHandle = element.querySelector<HTMLElement>(LIVE_PANEL_DRAG_HANDLE_SELECTOR);
  if (!enabled) {
    existingHandle?.remove();
    return;
  }

  if (existingHandle) {
    existingHandle.dataset.panelKey = panelKey;
    return;
  }

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'live-panel-drag-handle';
  handle.dataset.livePanelDragHandle = 'true';
  handle.dataset.panelKey = panelKey;
  handle.setAttribute('aria-label', `Reorder ${panelKey} panel`);
  element.append(handle);
}

function syncLivePanelResizeFrame(element: HTMLElement, panelKey: string, enabled: boolean) {
  const existingFrame = element.querySelector<HTMLElement>(LIVE_PANEL_RESIZE_FRAME_SELECTOR);
  if (!enabled) {
    existingFrame?.remove();
    return;
  }

  if (existingFrame) {
    existingFrame.dataset.panelKey = panelKey;
    for (const zone of existingFrame.querySelectorAll<HTMLElement>(LIVE_PANEL_RESIZE_ZONE_SELECTOR)) {
      zone.dataset.panelKey = panelKey;
    }
    return;
  }

  const frame = document.createElement('div');
  frame.className = 'live-panel-resize-frame';
  frame.dataset.livePanelResizeFrame = 'true';
  frame.dataset.panelKey = panelKey;
  frame.setAttribute('aria-hidden', 'true');

  for (const edge of ['right', 'left']) {
    const zone = document.createElement('button');
    zone.type = 'button';
    zone.className = `live-panel-resize-zone live-panel-resize-zone--${edge}`;
    zone.dataset.livePanelResizeZone = edge;
    zone.dataset.panelKey = panelKey;
    zone.tabIndex = -1;
    zone.setAttribute('aria-hidden', 'true');
    frame.append(zone);
  }

  element.append(frame);
}

function syncLivePanelLayout(renderFrame: AppRenderFrame, state: AppState) {
  renderFrame.panels.dataset.workspace = state.ui.workspace;

  const monitoredItem = renderFrame.monitoredStack;
  const livePanelItems = {
    monitored: monitoredItem,
    pumpfun: renderFrame.pumpfunSlot,
    alerts: renderFrame.alertsSlot,
  };

  const resetItem = (element: HTMLElement, panelKey: string) => {
    element.classList.add('live-panel-item', `live-panel-item--${panelKey}`);
    element.dataset.panelKey = panelKey;
    delete element.dataset.span;
    delete element.dataset.reordering;
    delete element.dataset.resizing;
    element.style.pointerEvents = '';
    if (panelKey === 'monitored' || panelKey === 'alerts') {
      element.dataset.resizable = 'true';
      element.classList.add('live-panel-item--resizable');
    } else {
      delete element.dataset.resizable;
      element.classList.remove('live-panel-item--resizable');
    }
  };

  resetItem(monitoredItem, 'monitored');
  resetItem(renderFrame.alertsSlot, 'alerts');
  renderFrame.pumpfunSlot.classList.remove('live-panel-item', 'live-panel-item--pumpfun', 'live-panel-item--resizable');
  delete renderFrame.pumpfunSlot.dataset.panelKey;
  delete renderFrame.pumpfunSlot.dataset.span;
  delete renderFrame.pumpfunSlot.dataset.resizable;

  if (state.ui.workspace !== 'live') {
    syncLivePanelDragHandle(monitoredItem, 'monitored', false);
    syncLivePanelDragHandle(renderFrame.pumpfunSlot, 'pumpfun', false);
    syncLivePanelDragHandle(renderFrame.alertsSlot, 'alerts', false);
    syncLivePanelResizeFrame(monitoredItem, 'monitored', false);
    syncLivePanelResizeFrame(renderFrame.pumpfunSlot, 'pumpfun', false);
    syncLivePanelResizeFrame(renderFrame.alertsSlot, 'alerts', false);
    renderFrame.panels.replaceChildren(monitoredItem, renderFrame.alertsSlot, renderFrame.pumpfunSlot);
    return;
  }

  const previewOrder = (livePanelReorderDraft?.previewOrder
    ?? livePanelResizeDraft?.previewOrder
    ?? state.ui.livePanelLayout.order).filter((panelKey) => panelKey !== 'pumpfun');
  const monitoredSpan = livePanelResizeDraft?.panelKey === 'monitored'
    ? livePanelResizeDraft.previewSpan
    : state.ui.livePanelLayout.spans.monitored;
  const alertsSpan = livePanelResizeDraft?.panelKey === 'alerts'
    ? livePanelResizeDraft.previewSpan
    : state.ui.livePanelLayout.spans.alerts;
  const spanMap = new Map<LiveWorkspacePanelKey, 1 | 2 | 3>([
    ['monitored', monitoredSpan],
    ['alerts', alertsSpan],
  ]);

  monitoredItem.dataset.span = String(monitoredSpan);
  renderFrame.alertsSlot.dataset.span = String(alertsSpan);

  const collapsedStackLayout = resolveLivePanelCollapsedStackLayout(previewOrder, spanMap, state);
  if (collapsedStackLayout) {
    const stack = getOrCreateLivePanelCollapsedStack(renderFrame.panels);
    stack.replaceChildren(...collapsedStackLayout.stackKeys.map((panelKey) => livePanelItems[panelKey]));
    renderFrame.panels.replaceChildren(
      ...(collapsedStackLayout.placeStackBefore
        ? [stack, livePanelItems[collapsedStackLayout.mainKey]]
        : [livePanelItems[collapsedStackLayout.mainKey], stack]),
    );
  } else {
    flattenLivePanelCollapsedStack(renderFrame.panels);
    renderFrame.panels.replaceChildren(...previewOrder.map((panelKey) => livePanelItems[panelKey]));
  }

  if (!renderFrame.panels.contains(renderFrame.pumpfunSlot)) {
    renderFrame.panels.append(renderFrame.pumpfunSlot);
  }

  if (livePanelReorderDraft) {
    const previewItem = livePanelItems[livePanelReorderDraft.panelKey];
    previewItem.dataset.reordering = 'true';
    previewItem.style.pointerEvents = 'none';
    renderFrame.frame.classList.add('live-panel-reorder-active');
  }

  if (livePanelResizeDraft) {
    const previewItem = livePanelItems[livePanelResizeDraft.panelKey];
    previewItem.dataset.resizing = 'true';
    renderFrame.frame.classList.add('live-panel-resize-active');
  }

  syncLivePanelDragHandle(monitoredItem, 'monitored', true);
  syncLivePanelDragHandle(renderFrame.alertsSlot, 'alerts', true);
  syncLivePanelResizeFrame(monitoredItem, 'monitored', true);
  syncLivePanelResizeFrame(renderFrame.alertsSlot, 'alerts', true);
}

function updateRenderSlot(slot: HTMLElement, nextKey: string, build: () => Node[]) {
  if (slot.dataset.renderKey === nextKey) {
    return;
  }

  slot.dataset.renderKey = nextKey;
  slot.replaceChildren(...build());
}

function shouldRefreshRegion(slot: HTMLElement, region: AppRenderRegion, dirtyRegions: ReadonlySet<AppRenderRegion>) {
  if (!slot.dataset.renderKey) {
    return true;
  }

  if (dirtyRegions.has('all')) {
    return true;
  }

  return dirtyRegions.has(region);
}

function updateRegionSlot(
  slot: HTMLElement,
  region: AppRenderRegion,
  dirtyRegions: ReadonlySet<AppRenderRegion>,
  nextKey: string,
  build: () => Node[],
  patch?: () => boolean,
) {
  if (!shouldRefreshRegion(slot, region, dirtyRegions)) {
    return;
  }

  const previousKey = slot.dataset.renderKey || '';
  const keyChanged = previousKey !== nextKey;
  if (previousKey && keyChanged && patch) {
    const patched = patch();
    if (patched) {
      slot.dataset.renderKey = nextKey;
      return;
    }
  }

  updateRenderSlot(slot, nextKey, build);
}

function serializePrimitiveList(values: Array<string | number | boolean | null | undefined>) {
  return values.map((value) => value == null ? '' : String(value)).join('~');
}

function isAlertsRenderDebugEnabled() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  return window.localStorage.getItem(ALERTS_RENDER_DEBUG_STORAGE_KEY) === '1';
}

function buildAlertsRenderSnapshot(state: AppState) {
  return {
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: [...state.ui.enabledTradeTerminals],
    search: state.ui.alertSearchQuery || '',
    starredCount: state.data.starredTokens.length,
    topAlertIds: state.data.alerts.slice(0, 5).map((alert) => alert.id),
    topAlerts: state.data.alerts.slice(0, 3).map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      address: alert.address,
      createdAt: alert.createdAt,
      pct: alert.pct,
      mcap: alert.mcap,
      volume5m: alert.volume5m,
      volume1h: alert.volume1h,
      volume6h: alert.volume6h,
      volume24h: alert.volume24h,
    })),
    count: state.data.alerts.length,
  };
}

function readPreviousAlertsDebugSnapshot(slot: HTMLElement) {
  const previousSnapshotRaw = slot.dataset.alertsDebugSnapshot;
  if (!previousSnapshotRaw) {
    return null;
  }

  try {
    return JSON.parse(previousSnapshotRaw) as ReturnType<typeof buildAlertsRenderSnapshot>;
  } catch {
    return null;
  }
}

function collectAlertsDebugChangedFields(
  previousSnapshot: ReturnType<typeof buildAlertsRenderSnapshot> | null,
  nextSnapshot: ReturnType<typeof buildAlertsRenderSnapshot>,
) {
  const changedFields: string[] = [];

  if (!previousSnapshot || previousSnapshot.busy !== nextSnapshot.busy) changedFields.push('busy');
  if (!previousSnapshot || previousSnapshot.role !== nextSnapshot.role) changedFields.push('role');
  if (!previousSnapshot || JSON.stringify(previousSnapshot.tradeTerminals) !== JSON.stringify(nextSnapshot.tradeTerminals)) changedFields.push('tradeTerminals');
  if (!previousSnapshot || previousSnapshot.search !== nextSnapshot.search) changedFields.push('search');
  if (!previousSnapshot || previousSnapshot.starredCount !== nextSnapshot.starredCount) changedFields.push('starredCount');
  if (!previousSnapshot || previousSnapshot.count !== nextSnapshot.count) changedFields.push('count');
  if (!previousSnapshot || JSON.stringify(previousSnapshot.topAlertIds) !== JSON.stringify(nextSnapshot.topAlertIds)) changedFields.push('topAlertIds');
  if (!previousSnapshot || JSON.stringify(previousSnapshot.topAlerts) !== JSON.stringify(nextSnapshot.topAlerts)) changedFields.push('topAlerts');

  return changedFields;
}

function logAlertsRenderDebug(slot: HTMLElement, state: AppState, dirtyRegions: ReadonlySet<AppRenderRegion>) {
  if (!isAlertsRenderDebugEnabled()) {
    return;
  }

  const nextSnapshot = buildAlertsRenderSnapshot(state);
  const nextKey = getAlertsRenderKey(state);
  const previousKey = slot.dataset.renderKey || '';
  const previousSnapshot = readPreviousAlertsDebugSnapshot(slot);
  const changedFields = collectAlertsDebugChangedFields(previousSnapshot, nextSnapshot);
  const shouldRefresh = shouldRefreshRegion(slot, 'alerts', dirtyRegions);
  const keyChanged = previousKey !== nextKey;
  if (dirtyRegions.has('alerts') || keyChanged || changedFields.length > 0) {
    console.debug('[alerts-debug] region', {
      dirtyRegions: [...dirtyRegions],
      shouldRefresh,
      keyChanged,
      changedFields,
      previousTopAlertIds: previousSnapshot?.topAlertIds || [],
      nextTopAlertIds: nextSnapshot.topAlertIds,
      nextCount: nextSnapshot.count,
    });
  }

  slot.dataset.alertsDebugSnapshot = JSON.stringify(nextSnapshot);
}

function serializeTrackedTokenForView(token: ReturnType<typeof getMonitoredTokens>[number]) {
  return serializePrimitiveList([
    token.address,
    token.symbol,
    token.name,
    token.label,
    token.createdAt,
    token.mcap,
    token.volume5m,
    token.volume1h,
    token.volume6h,
    token.volume24h,
    token.priceChange1h,
    token.priceChange6h,
    token.priceChange24h,
    token.prevVolume5m,
    token.prevMcap,
    token.pairUrl,
    token.imageUrl,
    token.twitterUrl,
    token._isRecentRouted,
    token._isOldWeekRouted,
  ]);
}

function serializeRenderedMoneyValue(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return '';
  }
  if (Math.abs(value) >= 1000000) {
    return `${(value / 1000000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toFixed(0);
}

function serializeRenderedPctValue(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return '';
  }
  return value.toFixed(2);
}

function resolveRenderedMcapDelta(token: ReturnType<typeof getMonitoredTokens>[number]) {
  if (token.mcapDelta != null) {
    return token.mcapDelta;
  }
  if (!(token.prevMcap && token.prevMcap > 0) || token.mcap == null) {
    return null;
  }
  return ((token.mcap - token.prevMcap) / token.prevMcap) * 100;
}

function serializeSparklineForView(state: AppState, address: string) {
  const entry = state.data.sparklineByAddress[address] || null;
  const series = Array.isArray(entry?.series) ? entry.series : [];
  return serializePrimitiveList([
    entry?.pairAddress,
    entry?.bucketCount,
    entry?.coverageRatio == null ? null : Number(entry.coverageRatio).toFixed(3),
    entry?.effectiveHours == null ? null : Number(entry.effectiveHours).toFixed(2),
    entry?.granularityMinutes,
    entry?.hours,
    entry?.points,
    series.length,
    series.map((value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : '')).join('|'),
  ]);
}

function serializeMeteoraForView(state: AppState, address: string) {
  const entry = state.data.meteoraByAddress[address] || null;
  return serializePrimitiveList([
    entry?.poolAddress,
    entry?.poolCount,
    entry?.noPool,
    serializeRenderedMoneyValue(entry?.tvl),
    entry?.change1h == null ? null : Number(entry.change1h).toFixed(1),
    entry?.change6h == null ? null : Number(entry.change6h).toFixed(1),
    entry?.change24h == null ? null : Number(entry.change24h).toFixed(1),
  ]);
}

function serializeMockTradingForView(state: AppState, address: string) {
  const position = getMockTradingPositionView(state, address);
  const tradesKey = serializeMockTradingTradesForView(state, address);
  if (!position && !tradesKey) {
    return '';
  }
  return serializePrimitiveList([
    position?.tokenAddress,
    serializeRenderedMoneyValue(position?.currentValueUsd),
    serializeRenderedMoneyValue(position?.unrealizedPnlUsd),
    serializeRenderedPctValue(position?.priceReturnPct ?? position?.unrealizedPnlPct),
    serializeRenderedMoneyValue(position?.avgEntryPriceUsd),
    serializeMockTradingTakeProfitOrdersForView(position),
    tradesKey,
  ]);
}

function serializeMockTradingTradesForView(state: AppState, address: string) {
  const trades = state.data.mockTradingTradesByAddress[address] || [];
  if (trades.length === 0) {
    return '';
  }
  return trades.map((trade) => serializePrimitiveList([
    trade.id,
    trade.side,
    trade.executedAt,
    serializeRenderedMoneyValue(trade.marketCapUsd),
    serializeRenderedMoneyValue(trade.notionalUsd),
  ])).join('~');
}

function serializeMockTradingTakeProfitOrdersForView(position: ReturnType<typeof getMockTradingPositionView>) {
  const orders = position?.takeProfitOrders || [];
  if (orders.length === 0) {
    return '';
  }
  return orders.map((order) => serializePrimitiveList([
    order.id,
    order.status,
    serializeRenderedMoneyValue(order.targetMcapUsd),
    serializeRenderedPctValue(order.sellPercent),
  ])).join('~');
}

function serializeRoutedTokenForView(state: AppState, token: ReturnType<typeof getMonitoredTokens>[number]) {
  return serializePrimitiveList([
    token.address,
    token.symbol,
    token.name,
    token.label,
    token.createdAt,
    serializeRenderedMoneyValue(token.mcap),
    serializeRenderedPctValue(resolveRenderedMcapDelta(token)),
    serializeRenderedMoneyValue(token.volume1h),
    serializeRenderedMoneyValue(token.volume6h),
    serializeRenderedMoneyValue(token.volume24h),
    serializeRenderedPctValue(token.priceChange1h),
    serializeRenderedPctValue(token.priceChange6h),
    serializeRenderedPctValue(token.priceChange24h),
    token.pairUrl,
    token.imageUrl,
    token.twitterUrl,
    token._isRecentRouted,
    token._isOldWeekRouted,
    serializeSparklineForView(state, token.address),
    serializeMeteoraForView(state, token.address),
    serializeMockTradingForView(state, token.address),
  ]);
}

function getHeaderRenderKey(state: AppState) {
  const mockTradingSummary = getMockTradingSummaryView(state);
  return serializePrimitiveList([
    state.session.status,
    state.session.username,
    state.session.email,
    state.runtime.mode,
    state.runtime.monitoredUpdatedAt,
    state.runtime.monitoredFreshnessLabel,
    state.ui.workspace,
    mockTradingSummary?.account.cashUsd,
    mockTradingSummary?.openPositionCount,
    mockTradingSummary?.openPositionValueUsd,
    mockTradingSummary?.totalEquityUsd,
    mockTradingSummary?.totalPnlUsd,
    mockTradingSummary?.totalPnlPct,
    serializeMockTradingHeaderPositionsForView(state),
  ]);
}

function serializeMockTradingHeaderPositionsForView(state: AppState) {
  return Object.values(state.data.mockTradingPositionsByAddress)
    .map((position) => {
      const token = getTrackedToken(state, position.tokenAddress);
      const livePosition = getMockTradingPositionView(state, position.tokenAddress) || position;
      return serializePrimitiveList([
        position.tokenAddress,
        token?.symbol,
        token?.imageUrl,
        livePosition.symbol,
        livePosition.imageUrl,
        serializeRenderedMoneyValue(livePosition.currentValueUsd),
        serializeRenderedMoneyValue(livePosition.unrealizedPnlUsd),
        serializeRenderedPctValue(livePosition.priceReturnPct ?? livePosition.unrealizedPnlPct),
        serializeMockTradingTakeProfitOrdersForView(livePosition),
      ]);
    })
    .join('~');
}

function getLegacyRenderKey(state: AppState) {
  const pathname = typeof window !== 'undefined' ? window.location.pathname || '/' : '/';
  return JSON.stringify({
    pathname,
    sessionStatus: state.session.status,
    busy: state.ui.busy,
    authPanel: state.ui.authPanel,
    error: state.ui.error,
    notice: state.ui.notice,
    pendingVerificationEmail: state.ui.pendingVerificationEmail,
    pendingPasswordResetToken: state.ui.pendingPasswordResetToken,
    pendingLoginOtpChallengeToken: state.ui.pendingLoginOtpChallengeToken,
    pendingLoginOtpEmailHint: state.ui.pendingLoginOtpEmailHint,
    billingLoaded: state.billing.loaded,
    billingEnabled: state.billing.enabled,
    billingProviderReady: state.billing.providerReady,
    billingProviderMocked: state.billing.providerMocked,
    billingPlans: state.billing.plans,
    billingPendingPlanKey: state.billing.pendingPlanKey,
    billingError: state.billing.error,
    identitiesLoaded: state.identities.loaded,
    identityProviders: state.identities.providers,
    identityError: state.identities.error,
    accessStatus: state.session.accessStatus,
    accessExpiresAt: state.session.accessExpiresAt,
    accessDaysRemaining: state.session.accessDaysRemaining,
  });
}

function getMonitoredRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.monitored,
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    search: state.ui.monitoredSearchQuery,
    page: state.ui.monitoredPage,
    perPage: state.ui.monitoredPerPage,
    sorts: state.ui.monitoredSorts,
    starred: state.data.starredTokens,
    tokens: getMonitoredTokens(state).map(serializeTrackedTokenForView),
    mockTrading: getMonitoredTokens(state).map((token) => serializeMockTradingForView(state, token.address)),
  });
}

function getManualRenderKey(state: AppState) {
  const filteredManualTokens = resolveManualTableRows(getManualTokens(state), {
    starredOnly: state.ui.manualStarredOnly,
    starredTokens: state.data.starredTokens,
    searchQuery: state.ui.manualSearchQuery,
    sortCriteria: state.ui.manualSorts,
  });

  return JSON.stringify({
    collapsed: state.ui.collapsed.manual,
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    search: state.ui.manualSearchQuery,
    starredOnly: state.ui.manualStarredOnly,
    sorts: state.ui.manualSorts,
    starred: state.data.starredTokens,
    meteoraMinPool: Number(state.data.configs['meteora-min-pool']) || 5000,
    tokens: getManualTokens(state).map(serializeTrackedTokenForView),
    mockTrading: getManualTokens(state).map((token) => serializeMockTradingForView(state, token.address)),
    sparklines: filteredManualTokens.map((token) => {
      const sparkline = state.data.sparklineByAddress[token.address];
      const series = Array.isArray(sparkline?.series) ? sparkline.series : [];
      return {
        address: token.address,
        loading: Boolean(sparkline?.loading),
        generatedAt: sparkline?.generatedAt ?? null,
        latestBucketAt: sparkline?.latestBucketAt ?? null,
        points: series.length,
        last: series.length > 0 ? series[series.length - 1] : null,
      };
    }),
  });
}

function getRecentRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.recent,
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    runtimeMode: state.runtime.mode,
    starredRevision: state.runtime.starredRevision,
    search: state.ui.recentSearchQuery,
    starredOnly: state.ui.recentStarredOnly,
    page: state.ui.recentPage,
    perPage: state.ui.recentPerPage,
    sorts: state.ui.recentSorts,
    barsRecent: state.bars.recent,
    oldMcapMin: state.data.configs['old-mcap-min'],
    oldMcapMax: state.data.configs['old-mcap-max'],
    tokenCount: state.data.recentTokenAddresses.length,
    ageMinute: Math.floor(Date.now() / 60000),
    tokens: getRecentTokens(state).map((token) => serializeRoutedTokenForView(state, token)),
  });
}

function getOldWeekRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.oldWeek,
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    starredRevision: state.runtime.starredRevision,
    search: state.ui.oldWeekSearchQuery,
    starredOnly: state.ui.oldWeekStarredOnly,
    page: state.ui.oldWeekPage,
    perPage: state.ui.oldWeekPerPage,
    sorts: state.ui.oldWeekSorts,
    barsOldWeek: state.bars.oldWeek,
    oldWeekMcapMin: state.data.configs['old-week-mcap-min'],
    oldWeekMcapMax: state.data.configs['old-week-mcap-max'],
    tokenCount: state.data.oldWeekTokenAddresses.length,
    ageMinute: Math.floor(Date.now() / 60000),
    tokens: getOldWeekTokens(state).map((token) => serializeRoutedTokenForView(state, token)),
  });
}

function getBidZoneRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.bidZone,
    busy: state.ui.busy,
    refreshInFlight: state.runtime.bidZoneRefreshInFlight,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    freshness: state.runtime.bidZoneFreshnessLabel,
    lastUpdatedAt: state.runtime.bidZoneUpdatedAt,
    refreshCooldown: state.runtime.bidZoneRefreshCooldownLabel,
    refreshAvailableAt: state.runtime.bidZoneRefreshAvailableAt,
    monitoredRevision: state.runtime.monitoredRevision,
    bidZoneRevision: state.runtime.bidZoneRevision,
    starredRevision: state.runtime.starredRevision,
    tokenCount: state.data.bidZoneTokens.length,
  });
}

function getAlertsRenderKey(state: AppState) {
  return JSON.stringify({
    busy: state.ui.busy,
    role: state.session.role,
    tradeTerminals: state.ui.enabledTradeTerminals,
    search: state.ui.alertSearchQuery,
    page: state.ui.alertPage,
    starred: state.data.starredTokens,
    alertRevision: state.runtime.alertRevision,
    alertCount: state.data.alerts.length,
  });
}

function getOverlayRenderKey(state: AppState) {
  return JSON.stringify({
    sessionStatus: state.session.status,
    authPanel: state.ui.authPanel,
    blockTokenWarning: state.ui.blockTokenWarning,
    mockTradingTicket: getMockTradingTicketOverlaySnapshot(state),
    mockTradingHistory: getMockTradingHistoryOverlaySnapshot(state),
    mockTradingPnl: getMockTradingPnlOverlaySnapshot(state),
    expandedSparkline: getExpandedSparklineOverlaySnapshot(state),
    busy: state.ui.busy,
    error: state.ui.error,
    notice: state.ui.notice,
    role: state.session.role,
    accessStatus: state.session.accessStatus,
    accessExpiresAt: state.session.accessExpiresAt,
    accessDaysRemaining: state.session.accessDaysRemaining,
    accessSource: state.session.accessSource,
    userSettings: getUserSettingsOverlaySnapshot(state),
    botSettingsConfigs: state.ui.authPanel === 'bot-settings' ? state.data.configs : null,
    blockedTokens: state.ui.authPanel === 'blocked-tokens' ? state.data.blocklist : null,
  });
}

function getMockTradingHistoryOverlaySnapshot(state: AppState) {
  if (!state.ui.mockTradingHistoryOpen) {
    return null;
  }
  const orders = Object.values(state.data.mockTradingPositionsByAddress)
    .flatMap((position) => position.takeProfitOrders || [])
    .filter((order) => order.status === 'open')
    .map((order) => serializePrimitiveList([
      order.id,
      order.tokenAddress,
      serializeRenderedMoneyValue(order.targetMcapUsd),
      serializeRenderedPctValue(order.sellPercent),
      order.createdAt,
    ]));
  const trades = Object.values(state.data.mockTradingTradesByAddress)
    .flat()
    .filter((trade) => trade.side === 'sell')
    .map((trade) => serializePrimitiveList([
      trade.id,
      trade.tokenAddress,
      trade.executedAt,
      serializeRenderedMoneyValue(trade.notionalUsd),
      serializeRenderedMoneyValue(trade.realizedPnlUsd),
      serializeRenderedPctValue(trade.realizedPnlPct ?? trade.priceReturnPct),
    ]));
  const summary = getMockTradingSummaryView(state);
  return serializePrimitiveList([
    summary?.account.cashUsd,
    summary?.totalEquityUsd,
    summary?.totalPnlUsd,
    orders.join('~'),
    trades.join('~'),
  ]);
}

function getMockTradingTicketOverlaySnapshot(state: AppState) {
  const ticket = state.ui.mockTradingTicket;
  if (!ticket) {
    return null;
  }
  const token = getTrackedToken(state, ticket.address);
  return {
    ...ticket,
    position: serializeMockTradingForView(state, ticket.address),
    token: token ? serializeTrackedTokenForView(token) : ticket.address,
  };
}

function getMockTradingPnlOverlaySnapshot(state: AppState) {
  const address = String(state.ui.mockTradingPnlAddress || '').trim();
  if (!address) {
    return null;
  }

  const trades = state.data.mockTradingTradesByAddress[address] || [];
  const sparkline = state.data.sparklineByAddress[address] || null;
  const series = Array.isArray(sparkline?.series) ? sparkline.series : [];
  return {
    address,
    position: serializeMockTradingForView(state, address),
    tradeIds: trades.map((trade) => trade.id).join(','),
    sparklinePoints: series.length,
    sparklineLast: series.length > 0 ? series[series.length - 1] : null,
  };
}

function getExpandedSparklineOverlaySnapshot(state: AppState) {
  const address = String(state.ui.expandedSparklineAddress || '').trim();
  if (!address) {
    return null;
  }

  const sparkline = state.data.sparklineByAddress[address] || null;
  const series = Array.isArray(sparkline?.series) ? sparkline.series : [];
  return {
    address,
    points: series.length,
    seriesKey: series.map((value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : value)).join('|'),
  };
}

function getUserSettingsOverlaySnapshot(state: AppState) {
  if (state.ui.authPanel !== 'user-settings') {
    return null;
  }

  return {
    username: state.session.username,
    email: state.session.email,
    isEmailVerified: state.session.isEmailVerified,
    emailVerifiedAt: state.session.emailVerifiedAt,
    identityProviders: state.identities.providers,
    identityError: state.identities.error,
    pendingIdentityUnlinkProvider: state.ui.pendingIdentityUnlinkProvider,
    billingLoaded: state.billing.loaded,
    billingEnabled: state.billing.enabled,
    billingProviderReady: state.billing.providerReady,
    billingPlans: state.billing.plans,
    billingOrders: state.billing.orders,
    billingPendingPlanKey: state.billing.pendingPlanKey,
    billingError: state.billing.error,
  };
}

function syncProfileModalScrollLock(state: AppState) {
  document.body.classList.toggle(
    'profile-modal-open',
    isProfileAuthPanel(state.ui.authPanel)
      || Boolean(state.ui.blockTokenWarning)
      || Boolean(state.ui.expandedSparklineAddress),
  );
}

function captureUserMenuDraft(root: HTMLElement): UserMenuDraft | null {
  const menu = root.querySelector<HTMLElement>('[data-user-menu]');
  if (!menu) {
    return null;
  }

  return {
    open: menu.classList.contains('open'),
  };
}

function applyUserMenuDraft(root: HTMLElement, draft: UserMenuDraft | null) {
  if (!draft?.open) {
    return;
  }

  root.querySelector<HTMLElement>('[data-user-menu]')?.classList.add('open');
}

function captureSearchInputDraft(root: HTMLElement): SearchInputDraft | null {
  const input = document.activeElement instanceof HTMLInputElement
    ? document.activeElement
    : null;
  if (!input || !root.contains(input)) {
    return null;
  }

  const key = input.dataset.searchInput;
  if (!key) {
    return null;
  }

  return {
    key,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  };
}

function applySearchInputDraft(root: HTMLElement, draft: SearchInputDraft | null) {
  if (!draft?.key) {
    return;
  }

  const input = root.querySelector<HTMLInputElement>(`[data-search-input="${CSS.escape(draft.key)}"]`);
  if (!input) {
    return;
  }

  input.focus();
  if (draft.selectionStart != null && draft.selectionEnd != null) {
    input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}




let currentHoverKey: string | null = null;
let hoverWired = false;
let tradeWired = false;
let sortMenusWired = false;
let userMenusWired = false;
let profileModalWired = false;
let sectionCollapseWired = false;
let livePanelResizeWired = false;
let livePanelResizeDraft: LivePanelResizeDraft | null = null;
let livePanelResizePendingDraft: LivePanelResizePendingDraft | null = null;
let livePanelReorderWired = false;
let livePanelReorderDraft: LivePanelReorderDraft | null = null;
let livePanelReorderPendingDraft: LivePanelReorderPendingDraft | null = null;

function wireHoverPersistence(root: HTMLElement) {
  if (hoverWired) return;
  hoverWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    const nextHoverKey = row?.dataset.hoverKey ?? null;
    if (nextHoverKey === currentHoverKey) {
      return;
    }
    currentHoverKey = nextHoverKey;
    applyHoverState(root);
  });

  root.addEventListener('mouseout', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    if (!row) return;

    const related = event.relatedTarget as HTMLElement | null;
    if (related && row.contains(related)) return;

    if (currentHoverKey === row.dataset.hoverKey) {
      currentHoverKey = null;
      applyHoverState(root);
    }
  });

  root.addEventListener('pointerleave', () => {
    if (!currentHoverKey) {
      return;
    }
    currentHoverKey = null;
    applyHoverState(root);
  });
}

function applyHoverState(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.forced-hover')) {
    el.classList.remove('forced-hover');
  }
  if (!currentHoverKey) return;
  const hovered = root.querySelector<HTMLElement>(`[data-hover-key="${CSS.escape(currentHoverKey)}"]`);
  if (hovered) hovered.classList.add('forced-hover');
}

function wireTradeMenus(root: HTMLElement) {
  if (tradeWired) return;
  tradeWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const wrap = target?.closest<HTMLElement>('[data-trade-wrap]');
    if (!wrap) return;

    const menu = wrap.querySelector<HTMLElement>('[data-trade-menu]');
    if (!menu) return;

    menu.classList.remove('open-up', 'open-down', 'open-left', 'open-right');
    const rect = wrap.getBoundingClientRect();
    const boundary = wrap.closest<HTMLElement>('.token-table-wrap, .monitored-list, .pump-list, .alerts-list, .panel, .legacy-panel');
    const boundaryRect = boundary?.getBoundingClientRect();
    const estimatedHeight = Math.max(menu.offsetHeight || 0, 118);
    const estimatedWidth = Math.max(menu.offsetWidth || 0, 90);
    const availableBottom = boundaryRect ? boundaryRect.bottom - rect.bottom : window.innerHeight - rect.bottom;
    const availableTop = boundaryRect ? rect.top - boundaryRect.top : rect.top;
    const availableRight = boundaryRect ? boundaryRect.right - rect.right : window.innerWidth - rect.right;
    const availableLeft = boundaryRect ? rect.left - boundaryRect.left : rect.left;
    const shouldOpenUp = availableBottom < estimatedHeight + 12 && availableTop > availableBottom;
    const shouldOpenLeft = availableRight < estimatedWidth + 16 && availableLeft > availableRight;

    menu.classList.add(shouldOpenUp ? 'open-up' : 'open-down');
    menu.classList.add(shouldOpenLeft ? 'open-left' : 'open-right');
  });
}

function wireSortMenus(root: HTMLElement) {
  if (sortMenusWired) return;
  sortMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-sort-toggle]');
    const wrap = target?.closest<HTMLElement>('[data-sort-wrap]');

    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
      if (openWrap !== wrap) openWrap.classList.remove('open');
    }

    if (toggle && wrap) {
      event.preventDefault();
      wrap.classList.toggle('open');
      return;
    }

    if (!wrap) {
      for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
        openWrap.classList.remove('open');
      }
    }
  });
}

function wireUserMenus(root: HTMLElement) {
  if (userMenusWired) return;
  userMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-action="toggle-user-menu"]');
    const menu = target?.closest<HTMLElement>('[data-user-menu]');

    for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
      if (openMenu !== menu) openMenu.classList.remove('open');
    }

    if (toggle && menu) {
      event.preventDefault();
      menu.classList.toggle('open');
      return;
    }

    if (!menu) {
      for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
        openMenu.classList.remove('open');
      }
    }
  });
}

function wireProfileModals(root: HTMLElement, controller: AppController) {
  if (profileModalWired) return;
  profileModalWired = true;

  const closeSelector = '[data-action="close-profile-modal"]';
  const blockWarningCloseSelector = '[data-action="close-block-token-warning"], [data-action="cancel-block-token-warning"]';
  const expandedSparklineCloseSelector = '[data-action="close-expanded-sparkline"]';
  const mockTradingPnlCloseSelector = '[data-action="close-mock-trading-pnl"]';
  const shouldCloseProfileModal = (target: HTMLElement | null) => {
    const profileModal = target?.closest<HTMLElement>('[data-auth-modal-scope="profile"]');
    const closeButton = target?.closest<HTMLElement>(closeSelector);
    const backdrop = target?.closest<HTMLElement>('.legacy-auth-modal-backdrop');

    return Boolean(profileModal && (closeButton || backdrop));
  };
  const shouldCloseBlockWarning = (target: HTMLElement | null) => {
    const warningModal = target?.closest<HTMLElement>('[data-auth-modal-scope="block-warning"]');
    const closeButton = target?.closest<HTMLElement>(blockWarningCloseSelector);
    const backdrop = target?.closest<HTMLElement>('.legacy-auth-modal-backdrop');

    return Boolean(warningModal && (closeButton || backdrop));
  };
  const shouldCloseExpandedSparkline = (target: HTMLElement | null) => {
    const sparklineModal = target?.closest<HTMLElement>('[data-auth-modal-scope="sparkline"]');
    const closeButton = target?.closest<HTMLElement>(expandedSparklineCloseSelector);
    const backdrop = target?.closest<HTMLElement>('.legacy-auth-modal-backdrop');

    return Boolean(sparklineModal && (closeButton || backdrop));
  };
  const shouldCloseMockTradingPnl = (target: HTMLElement | null) => {
    const modal = target?.closest<HTMLElement>('[data-auth-modal-scope="mock-trading-pnl"]');
    const closeButton = target?.closest<HTMLElement>(mockTradingPnlCloseSelector);
    const backdrop = target?.closest<HTMLElement>('.legacy-auth-modal-backdrop');

    return Boolean(modal && (closeButton || backdrop));
  };

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (shouldCloseMockTradingPnl(target)) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingPnlResume();
      return;
    }
    if (shouldCloseExpandedSparkline(target)) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeExpandedSparkline();
      return;
    }
    if (!shouldCloseProfileModal(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    controller.closeAuthPanel();
  });

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (shouldCloseMockTradingPnl(target)) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingPnlResume();
      return;
    }
    if (shouldCloseBlockWarning(target)) {
      event.preventDefault();
      event.stopPropagation();
      void controller.cancelBlockedTokenWarning();
      return;
    }
    if (shouldCloseExpandedSparkline(target)) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeExpandedSparkline();
      return;
    }
    if (!shouldCloseProfileModal(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    controller.closeAuthPanel();
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    const hasBlockWarning = root.querySelector('[data-auth-modal-scope="block-warning"]');
    if (hasBlockWarning) {
      event.preventDefault();
      event.stopPropagation();
      void controller.cancelBlockedTokenWarning();
      return;
    }
    const hasExpandedSparkline = root.querySelector('[data-auth-modal-scope="sparkline"]');
    const hasMockTradingPnl = root.querySelector('[data-auth-modal-scope="mock-trading-pnl"]');
    if (hasMockTradingPnl) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeMockTradingPnlResume();
      return;
    }
    if (hasExpandedSparkline) {
      event.preventDefault();
      event.stopPropagation();
      controller.closeExpandedSparkline();
      return;
    }
    const hasProfileModal = root.querySelector('[data-auth-modal-scope="profile"]');
    if (!hasProfileModal) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    controller.closeAuthPanel();
  });
}

function wireSectionCollapseToggles(root: HTMLElement, controller: AppController) {
  if (sectionCollapseWired) return;
  sectionCollapseWired = true;

  const resolveCollapseButton = (target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    const button = element?.closest<HTMLElement>('[data-action="toggle-section-collapse"][data-section]');
    const section = button?.dataset.section;
    if (!button || !isCollapsibleSectionKey(section)) {
      return null;
    }
    return { button, section };
  };

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    const resolved = resolveCollapseButton(event.target);
    if (!resolved) {
      return;
    }

    resolved.button.dataset.pointerCollapseHandled = 'true';
    event.preventDefault();
    event.stopPropagation();
    controller.toggleSectionCollapsed(resolved.section);
  }, true);

  root.addEventListener('click', (event) => {
    const resolved = resolveCollapseButton(event.target);
    if (!resolved) {
      return;
    }

    if (resolved.button.dataset.pointerCollapseHandled === 'true') {
      delete resolved.button.dataset.pointerCollapseHandled;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    controller.toggleSectionCollapsed(resolved.section);
  }, true);
}

function isCollapsibleSectionKey(value: string | null | undefined): value is 'manual' | 'recent' | 'oldWeek' | 'monitored' | 'bidZone' | 'pumpfun' {
  return value === 'manual'
    || value === 'recent'
    || value === 'oldWeek'
    || value === 'monitored'
    || value === 'bidZone'
    || value === 'pumpfun';
}

function isLiveResizablePanelKey(value: string | null | undefined): value is LiveResizablePanelKey {
  return value === 'monitored' || value === 'alerts';
}

function isLiveWorkspacePanelKey(value: string | null | undefined): value is LiveWorkspacePanelKey {
  return value === 'monitored' || value === 'alerts';
}

function getLivePanelItems(panels: HTMLElement) {
  return Array.from(panels.querySelectorAll<HTMLElement>('.live-panel-item[data-panel-key]'))
    .filter((item) => isLiveWorkspacePanelKey(item.dataset.panelKey));
}

function findLivePanelsContainer(element: HTMLElement) {
  return element.closest<HTMLElement>(APP_PANELS_SELECTOR);
}

function getOrCreateLivePanelCollapsedStack(panels: HTMLElement) {
  const existing = panels.querySelector<HTMLElement>(LIVE_PANEL_COLLAPSED_STACK_SELECTOR);
  if (existing) {
    return existing;
  }

  const stack = document.createElement('div');
  stack.className = 'live-panel-collapsed-stack';
  stack.dataset.livePanelCollapsedStack = 'true';
  return stack;
}

function flattenLivePanelCollapsedStack(panels: HTMLElement) {
  const stack = panels.querySelector<HTMLElement>(LIVE_PANEL_COLLAPSED_STACK_SELECTOR);
  if (!stack) {
    return;
  }

  while (stack.firstElementChild) {
    panels.insertBefore(stack.firstElementChild, stack);
  }
  stack.remove();
}

function isLivePanelVisuallyCollapsed(panelKey: LiveWorkspacePanelKey, state: AppState) {
  if (panelKey === 'alerts') {
    return false;
  }
  return panelKey === 'monitored' && Boolean(state.ui.collapsed.monitored);
}

function resolveLivePanelCollapsedStackLayout(
  order: LiveWorkspacePanelKey[],
  spanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
  state: AppState,
) {
  const widePanels = order.filter((panelKey) => (spanMap.get(panelKey) ?? 1) === 2);
  if (widePanels.length !== 1) {
    return null;
  }

  const mainKey = widePanels[0];
  const sideKeys = order.filter((panelKey) => panelKey !== mainKey);
  if (sideKeys.length !== 2 || sideKeys.some((panelKey) => (spanMap.get(panelKey) ?? 1) !== 1)) {
    return null;
  }

  const collapsedKeys = sideKeys.filter((panelKey) => isLivePanelVisuallyCollapsed(panelKey, state));
  if (collapsedKeys.length === 0) {
    return null;
  }

  const stackKeys = [...sideKeys].sort((left, right) => {
    const leftCollapsed = isLivePanelVisuallyCollapsed(left, state);
    const rightCollapsed = isLivePanelVisuallyCollapsed(right, state);
    if (leftCollapsed === rightCollapsed) {
      return sideKeys.indexOf(left) - sideKeys.indexOf(right);
    }
    return leftCollapsed ? 1 : -1;
  });

  const placements = simulateLivePanelPlacement(order, spanMap);
  const mainPlacement = placements.get(mainKey);
  if (!mainPlacement) {
    return null;
  }

  return {
    mainKey,
    stackKeys,
    placeStackBefore: mainPlacement.startCol > 0,
  };
}

function getLivePanelOrderFromDom(panels: HTMLElement): LiveWorkspacePanelKey[] {
  return getLivePanelItems(panels)
    .map((item) => item.dataset.panelKey)
    .filter(isLiveWorkspacePanelKey);
}

function beginLivePanelReorder(item: HTMLElement, pointerId: number, startX: number, startY: number) {
  const panelKey = item.dataset.panelKey;
  if (!isLiveWorkspacePanelKey(panelKey)) {
    return false;
  }

  const panels = findLivePanelsContainer(item);
  if (!(panels instanceof HTMLElement)) {
    return false;
  }

  flattenLivePanelCollapsedStack(panels);

  item.setPointerCapture(pointerId);
  livePanelReorderDraft = {
    panelKey,
    item,
    panels,
    pointerId,
    startX,
    startY,
    originalOrder: getLivePanelOrderFromDom(panels),
    previewOrder: getLivePanelOrderFromDom(panels),
  };
  item.dataset.reordering = 'true';
  item.style.pointerEvents = 'none';
  panels.closest<HTMLElement>('[data-app-render-frame]')?.classList.add('live-panel-reorder-active');
  return true;
}

function previewLivePanelReorder(clientX: number, clientY: number) {
  if (!livePanelReorderDraft) {
    return;
  }

  void clientY;
  const draft = livePanelReorderDraft;
  const { panels } = draft;
  const nextOrder = buildLivePanelReorderPreviewOrder(draft, clientX, clientY);
  if (!nextOrder) {
    return;
  }

  if (nextOrder.length === draft.previewOrder.length && nextOrder.every((panelKey, index) => panelKey === draft.previewOrder[index])) {
    return;
  }

  const itemMap = new Map(getLivePanelItems(panels).map((panelItem) => [panelItem.dataset.panelKey, panelItem]));
  for (const panelKey of nextOrder) {
    const panelItem = itemMap.get(panelKey);
    if (panelItem) {
      panels.append(panelItem);
    }
  }
  draft.previewOrder = nextOrder;
}

function buildLivePanelReorderPreviewOrder(draft: LivePanelReorderDraft, clientX: number, clientY: number) {
  const panelRect = draft.panels.getBoundingClientRect();
  const columnWidth = Math.max(panelRect.width / 3, 1);
  const desiredCol = Math.max(0, Math.min(2, Math.floor((clientX - panelRect.left) / columnWidth)));
  const spanMap = getLivePanelSpanMap(draft.panels);
  const permutations = getLivePanelOrderPermutations(draft.panelKey, draft.originalOrder);
  const originalPlacements = simulateLivePanelPlacement(draft.originalOrder, spanMap);
  const deltaY = clientY - draft.startY;
  const verticalIntent = Math.abs(deltaY) >= 28;
  const horizontalIntent = !verticalIntent;
  const originalPlacement = originalPlacements.get(draft.panelKey);
  const desiredRow = verticalIntent && originalPlacement
    ? Math.max(0, originalPlacement.row + (deltaY > 0 ? 1 : -1))
    : null;
  const smartAdjacentSwap = horizontalIntent
    ? resolveLivePanelSmartAdjacentSwap(draft, spanMap, clientX)
    : null;
  if (smartAdjacentSwap) {
    return smartAdjacentSwap;
  }

  const smartVerticalSwap = verticalIntent
    ? resolveLivePanelSmartVerticalSwap(draft, spanMap, clientX, clientY)
    : null;
  if (smartVerticalSwap) {
    return smartVerticalSwap;
  }

  let bestOrder: LiveWorkspacePanelKey[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const order of permutations) {
    const placements = simulateLivePanelPlacement(order, spanMap);
    const placement = placements.get(draft.panelKey);
    if (!placement) {
      continue;
    }

    const colScore = desiredCol < placement.startCol
      ? placement.startCol - desiredCol
      : desiredCol >= placement.endCol
        ? desiredCol - placement.endCol + 1
        : 0;
    const rowScore = desiredRow == null ? 0 : Math.abs(placement.row - desiredRow);
    const movementScore = order.reduce((score, panelKey, index) => {
      const currentIndex = draft.previewOrder.indexOf(panelKey);
      return score + Math.abs(currentIndex - index);
    }, 0);
    const rowPenalty = horizontalIntent
      ? getLivePanelHorizontalIntentPenalty(draft.panelKey, spanMap, originalPlacements, placements)
      : 0;
    const score = desiredRow == null
      ? colScore * 100 + rowPenalty + movementScore
      : rowScore * 1000 + colScore * 20 + movementScore;
    if (score < bestScore) {
      bestScore = score;
      bestOrder = order;
    }
  }

  return bestOrder;
}

function resolveLivePanelSmartAdjacentSwap(
  draft: LivePanelReorderDraft,
  spanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
  clientX: number,
) {
  const draggedSpan = spanMap.get(draft.panelKey) ?? 1;
  if (draggedSpan !== 1) {
    return null;
  }

  const deltaX = clientX - draft.startX;
  if (Math.abs(deltaX) < 18) {
    return null;
  }

  const movingRight = deltaX > 0;
  const order = [...draft.previewOrder];
  const draggedIndex = order.indexOf(draft.panelKey);
  if (draggedIndex < 0) {
    return null;
  }

  const adjacentIndex = movingRight ? draggedIndex + 1 : draggedIndex - 1;
  const adjacentKey = order[adjacentIndex];
  if (!isLiveWorkspacePanelKey(adjacentKey)) {
    return null;
  }

  const adjacentSpan = spanMap.get(adjacentKey) ?? 1;
  if (adjacentSpan < 2) {
    return null;
  }

  const adjacentItem = getLivePanelItems(draft.panels).find((item) => item.dataset.panelKey === adjacentKey);
  if (!adjacentItem) {
    return null;
  }

  const rect = adjacentItem.getBoundingClientRect();
  const trigger = Math.min(Math.max(rect.width * 0.18, 36), 72);
  const crossed = movingRight
    ? clientX >= rect.left + trigger
    : clientX <= rect.right - trigger;
  if (!crossed) {
    return null;
  }

  const next = order.filter((panelKey) => panelKey !== draft.panelKey);
  const insertIndex = movingRight ? adjacentIndex : Math.max(adjacentIndex, 0);
  next.splice(insertIndex, 0, draft.panelKey);
  return next;
}

function resolveLivePanelSmartVerticalSwap(
  draft: LivePanelReorderDraft,
  spanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
  clientX: number,
  clientY: number,
) {
  const draggedSpan = spanMap.get(draft.panelKey) ?? 1;
  if (draggedSpan !== 1) {
    return null;
  }

  const deltaY = clientY - draft.startY;
  if (Math.abs(deltaY) < 20) {
    return null;
  }

  const movingDown = deltaY > 0;
  const currentPlacements = simulateLivePanelPlacement(draft.previewOrder, spanMap);
  const draggedPlacement = currentPlacements.get(draft.panelKey);
  if (!draggedPlacement) {
    return null;
  }

  const targetRow = movingDown ? draggedPlacement.row + 1 : Math.max(0, draggedPlacement.row - 1);
  const preferredCol = draggedPlacement.startCol;
  const siblingItems = getLivePanelItems(draft.panels).filter((item) => {
    const panelKey = item.dataset.panelKey;
    return panelKey !== draft.panelKey
      && isLiveWorkspacePanelKey(panelKey)
      && (spanMap.get(panelKey) ?? 1) === 1
      && currentPlacements.get(panelKey)?.row === targetRow;
  });
  if (siblingItems.length === 0) {
    return null;
  }

  const siblingItem = siblingItems
    .map((item) => {
      const panelKey = item.dataset.panelKey as LiveWorkspacePanelKey;
      const placement = currentPlacements.get(panelKey);
      return {
        item,
        rect: item.getBoundingClientRect(),
        placement,
      };
    })
    .sort((left, right) => {
      const leftColScore = Math.abs((left.placement?.startCol ?? preferredCol) - preferredCol);
      const rightColScore = Math.abs((right.placement?.startCol ?? preferredCol) - preferredCol);
      if (leftColScore !== rightColScore) {
        return leftColScore - rightColScore;
      }
      const leftXScore = left.rect.left <= clientX && clientX <= left.rect.right ? 0 : Math.abs(((left.rect.left + left.rect.right) / 2) - clientX);
      const rightXScore = right.rect.left <= clientX && clientX <= right.rect.right ? 0 : Math.abs(((right.rect.left + right.rect.right) / 2) - clientX);
      if (leftXScore !== rightXScore) {
        return leftXScore - rightXScore;
      }
      return Math.abs(left.rect.top - clientY) - Math.abs(right.rect.top - clientY);
    })[0];
  if (!siblingItem) {
    return null;
  }

  const horizontalBandMiss = clientX < siblingItem.rect.left || clientX > siblingItem.rect.right;
  if (horizontalBandMiss) {
    return null;
  }

  const trigger = Math.min(Math.max(siblingItem.rect.height * 0.3, 20), 44);
  const crossed = movingDown
    ? clientY >= siblingItem.rect.top + trigger
    : clientY <= siblingItem.rect.bottom - trigger;
  if (!crossed) {
    return null;
  }

  const siblingKey = siblingItem.item.dataset.panelKey;
  if (!isLiveWorkspacePanelKey(siblingKey)) {
    return null;
  }

  const next = [...draft.previewOrder];
  const draggedIndex = next.indexOf(draft.panelKey);
  const siblingIndex = next.indexOf(siblingKey);
  if (draggedIndex < 0 || siblingIndex < 0) {
    return null;
  }

  [next[draggedIndex], next[siblingIndex]] = [next[siblingIndex], next[draggedIndex]];
  return next;
}

function getLivePanelHorizontalIntentPenalty(
  draggedPanelKey: LiveWorkspacePanelKey,
  spanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
  originalPlacements: Map<LiveWorkspacePanelKey, { row: number; startCol: number; endCol: number }>,
  nextPlacements: Map<LiveWorkspacePanelKey, { row: number; startCol: number; endCol: number }>,
) {
  let penalty = 0;
  for (const [panelKey, originalPlacement] of originalPlacements.entries()) {
    if (panelKey === draggedPanelKey) {
      continue;
    }

    const nextPlacement = nextPlacements.get(panelKey);
    if (!nextPlacement || nextPlacement.row === originalPlacement.row) {
      continue;
    }

    penalty += (spanMap.get(panelKey) ?? 1) > 1 ? 1200 : 240;
  }
  return penalty;
}

function getLivePanelSpanMap(panels: HTMLElement) {
  const spanMap = new Map<LiveWorkspacePanelKey, 1 | 2 | 3>();
  for (const item of getLivePanelItems(panels)) {
    const panelKey = item.dataset.panelKey;
    if (!isLiveWorkspacePanelKey(panelKey)) {
      continue;
    }
    spanMap.set(panelKey, item.dataset.span === '3' ? 3 : item.dataset.span === '2' ? 2 : 1);
  }
  return spanMap;
}

function getLivePanelOrderPermutations(draggedPanelKey: LiveWorkspacePanelKey, order: LiveWorkspacePanelKey[]) {
  const others = order.filter((panelKey) => panelKey !== draggedPanelKey);
  if (others.length === 1) {
    return [
      [draggedPanelKey, others[0]],
      [others[0], draggedPanelKey],
    ] as LiveWorkspacePanelKey[][];
  }

  return [
    [draggedPanelKey, others[0], others[1]],
    [draggedPanelKey, others[1], others[0]],
    [others[0], draggedPanelKey, others[1]],
    [others[1], draggedPanelKey, others[0]],
    [others[0], others[1], draggedPanelKey],
    [others[1], others[0], draggedPanelKey],
  ] as LiveWorkspacePanelKey[][];
}

function simulateLivePanelPlacement(
  order: LiveWorkspacePanelKey[],
  spanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
) {
  const placements = new Map<LiveWorkspacePanelKey, { row: number; startCol: number; endCol: number }>();
  let row = 0;
  let col = 0;

  for (const panelKey of order) {
    const span = spanMap.get(panelKey) ?? 1;
    if (col + span > 3) {
      row += 1;
      col = 0;
    }

    placements.set(panelKey, {
      row,
      startCol: col,
      endCol: col + span,
    });

    col += span;
    if (col >= 3) {
      row += 1;
      col = 0;
    }
  }

  return placements;
}

function endLivePanelReorder(root: HTMLElement, controller: AppController, options?: { commit?: boolean }) {
  if (!livePanelReorderDraft) {
    return;
  }

  const draft = livePanelReorderDraft;
  livePanelReorderDraft = null;
  delete draft.item.dataset.reordering;
  draft.item.style.pointerEvents = '';
  root.querySelector<HTMLElement>('[data-app-render-frame]')?.classList.remove('live-panel-reorder-active');

  if (options?.commit) {
    controller.setLivePanelOrder(draft.previewOrder);
    return;
  }

  const itemMap = new Map(getLivePanelItems(draft.panels).map((item) => [item.dataset.panelKey, item]));
  for (const panelKey of draft.originalOrder) {
    const item = itemMap.get(panelKey);
    if (item) {
      draft.panels.append(item);
    }
  }
}

function wireLivePanelReorder(root: HTMLElement, controller: AppController) {
  if (livePanelReorderWired) return;
  livePanelReorderWired = true;

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || livePanelResizeDraft || livePanelResizePendingDraft) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const handle = target?.closest<HTMLElement>(LIVE_PANEL_DRAG_HANDLE_SELECTOR);
    const item = handle?.closest<HTMLElement>('.live-panel-item[data-panel-key]');
    if (!handle || !item) {
      return;
    }

    item.setPointerCapture(event.pointerId);
    livePanelReorderPendingDraft = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.preventDefault();
    event.stopPropagation();
  });

  root.addEventListener('pointermove', (event) => {
    if (livePanelReorderDraft) {
      previewLivePanelReorder(event.clientX, event.clientY);
      return;
    }

    if (!livePanelReorderPendingDraft || event.pointerId !== livePanelReorderPendingDraft.pointerId) {
      return;
    }

    const distance = Math.hypot(
      event.clientX - livePanelReorderPendingDraft.startX,
      event.clientY - livePanelReorderPendingDraft.startY,
    );
    if (distance < LIVE_PANEL_REORDER_ACTIVATION_DISTANCE) {
      return;
    }

    const pendingDraft = livePanelReorderPendingDraft;
    livePanelReorderPendingDraft = null;
    if (!beginLivePanelReorder(
      pendingDraft.item,
      pendingDraft.pointerId,
      pendingDraft.startX,
      pendingDraft.startY,
    )) {
      releaseLivePanelPointerCapture(pendingDraft.item, pendingDraft.pointerId);
      return;
    }
    previewLivePanelReorder(event.clientX, event.clientY);
  });

  root.addEventListener('pointerup', (event) => {
    if (livePanelReorderDraft) {
      const activeItem = livePanelReorderDraft.item;
      releaseLivePanelPointerCapture(activeItem, event.pointerId);
      endLivePanelReorder(root, controller, { commit: true });
      return;
    }

    if (!livePanelReorderPendingDraft || event.pointerId !== livePanelReorderPendingDraft.pointerId) {
      return;
    }

    releaseLivePanelPointerCapture(livePanelReorderPendingDraft.item, event.pointerId);
    livePanelReorderPendingDraft = null;
  });

  root.addEventListener('pointercancel', (event) => {
    if (livePanelReorderDraft) {
      const activeItem = livePanelReorderDraft.item;
      releaseLivePanelPointerCapture(activeItem, event.pointerId);
      endLivePanelReorder(root, controller, { commit: false });
      return;
    }

    if (!livePanelReorderPendingDraft || event.pointerId !== livePanelReorderPendingDraft.pointerId) {
      return;
    }

    releaseLivePanelPointerCapture(livePanelReorderPendingDraft.item, event.pointerId);
    livePanelReorderPendingDraft = null;
  });
}

function clampLivePanelSpan(value: number): 1 | 2 | 3 {
  if (value >= 3) return 3;
  if (value <= 1) return 1;
  return 2;
}

function getLivePanelResizeAnchor(zone: 'right' | 'left') {
  return zone === 'left' ? 'right' : 'left';
}

function buildLivePanelResizePreviewOrder(
  order: LiveWorkspacePanelKey[],
  panelKey: LiveWorkspacePanelKey,
  span: 1 | 2 | 3,
  anchor: 'left' | 'right',
  anchorLine: number,
  preferredRow: number,
  baseSpanMap: Map<LiveWorkspacePanelKey, 1 | 2 | 3>,
) {
  const spanMap = new Map(baseSpanMap);
  spanMap.set(panelKey, span);
  const permutations = getLivePanelOrderPermutations(panelKey, order);
  let bestOrder = [...order];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of permutations) {
    const placements = simulateLivePanelPlacement(candidate, spanMap);
    const placement = placements.get(panelKey);
    if (!placement) {
      continue;
    }

    const edgeScore = anchor === 'left'
      ? Math.abs(placement.startCol - anchorLine)
      : Math.abs(placement.endCol - anchorLine);
    const rowScore = Math.abs(placement.row - preferredRow);
    const movementScore = candidate.reduce((score, candidatePanelKey, index) => {
      const currentIndex = order.indexOf(candidatePanelKey);
      return score + Math.abs(currentIndex - index);
    }, 0);
    const score = rowScore * 1000 + edgeScore * 100 + movementScore;
    if (score < bestScore) {
      bestScore = score;
      bestOrder = candidate;
    }
  }

  return bestOrder;
}

function resolveLivePanelResizeDirection(
  zone: 'right' | 'left',
): -1 | 1 {
  return zone === 'left' ? -1 : 1;
}

function getLivePanelResizeThreshold(panels: HTMLElement) {
  const styles = window.getComputedStyle(panels);
  const gap = Number.parseFloat(styles.columnGap || styles.gap || '16') || 16;
  const columnWidth = Math.max(0, (panels.getBoundingClientRect().width - gap * 2) / 3);
  return Math.max(72, Math.min(220, columnWidth * 0.55));
}

function getLivePanelResizePreviewSpan(draft: LivePanelResizeDraft, clientX: number): 1 | 2 | 3 {
  const delta = (clientX - draft.startX) * draft.direction;
  const step = Math.round(delta / getLivePanelResizeThreshold(draft.panels));
  return clampLivePanelSpan(draft.startSpan + step);
}

function beginLivePanelResize(
  item: HTMLElement,
  pointerId: number,
  startX: number,
  zone: 'right' | 'left',
) {
  const panelKey = item.dataset.panelKey;
  if (!isLiveResizablePanelKey(panelKey)) {
    return false;
  }

  const panels = findLivePanelsContainer(item);
  if (!(panels instanceof HTMLElement)) {
    return false;
  }

  flattenLivePanelCollapsedStack(panels);

  item.setPointerCapture(pointerId);
  const startSpan = item.dataset.span === '2' ? 2 : item.dataset.span === '3' ? 3 : 1;
  const originalOrder = getLivePanelOrderFromDom(panels);
  const spanMap = getLivePanelSpanMap(panels);
  const placements = simulateLivePanelPlacement(originalOrder, spanMap);
  const anchor = getLivePanelResizeAnchor(zone);
  const originalPlacement = placements.get(panelKey);
  if (!originalPlacement) {
    return false;
  }
  const anchorLine = anchor === 'left'
    ? originalPlacement.startCol
    : originalPlacement.endCol;
  livePanelResizeDraft = {
    panelKey,
    item,
    panels,
    startX,
    startSpan,
    previewSpan: startSpan,
    direction: resolveLivePanelResizeDirection(zone),
    anchor,
    anchorLine,
    preferredRow: originalPlacement.row,
    originalOrder,
    previewOrder: buildLivePanelResizePreviewOrder(
      originalOrder,
      panelKey,
      startSpan,
      anchor,
      anchorLine,
      originalPlacement.row,
      spanMap,
    ),
  };
  item.dataset.resizing = 'true';
  item.closest<HTMLElement>('[data-app-render-frame]')?.classList.add('live-panel-resize-active');
  return true;
}

function releaseLivePanelPointerCapture(item: HTMLElement, pointerId: number) {
  if (item.hasPointerCapture(pointerId)) {
    item.releasePointerCapture(pointerId);
  }
}

function updateLivePanelResize(clientX: number) {
  if (!livePanelResizeDraft) {
    return;
  }

  const draft = livePanelResizeDraft;
  const nextSpan = getLivePanelResizePreviewSpan(draft, clientX);
  const nextOrder = buildLivePanelResizePreviewOrder(
    draft.originalOrder,
    draft.panelKey,
    nextSpan,
    draft.anchor,
    draft.anchorLine,
    draft.preferredRow,
    getLivePanelSpanMap(draft.panels),
  );
  const sameOrder = nextOrder.length === draft.previewOrder.length
    && nextOrder.every((panelKey, index) => panelKey === draft.previewOrder[index]);
  if (nextSpan === draft.previewSpan && sameOrder) {
    return;
  }

  draft.previewSpan = nextSpan;
  draft.previewOrder = nextOrder;
  draft.item.dataset.span = String(nextSpan);
  const itemMap = new Map(getLivePanelItems(draft.panels).map((panelItem) => [panelItem.dataset.panelKey, panelItem]));
  for (const panelKey of nextOrder) {
    const panelItem = itemMap.get(panelKey);
    if (panelItem) {
      draft.panels.append(panelItem);
    }
  }
}

function endLivePanelResize(root: HTMLElement, controller: AppController, options?: { commit?: boolean }) {
  if (!livePanelResizeDraft) {
    return;
  }

  const draft = livePanelResizeDraft;
  livePanelResizeDraft = null;
  delete draft.item.dataset.resizing;
  root.querySelector<HTMLElement>('[data-app-render-frame]')?.classList.remove('live-panel-resize-active');

  if (options?.commit) {
    controller.setLivePanelOrder(draft.previewOrder);
    controller.setLivePanelSpan(draft.panelKey, draft.previewSpan);
    return;
  }

  draft.item.dataset.span = String(draft.startSpan);
  const itemMap = new Map(getLivePanelItems(draft.panels).map((item) => [item.dataset.panelKey, item]));
  for (const panelKey of draft.originalOrder) {
    const panelItem = itemMap.get(panelKey);
    if (panelItem) {
      draft.panels.append(panelItem);
    }
  }
}

function wireLivePanelResize(root: HTMLElement, controller: AppController) {
  if (livePanelResizeWired) return;
  livePanelResizeWired = true;

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || livePanelReorderDraft || livePanelReorderPendingDraft) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const zone = target?.closest<HTMLElement>(LIVE_PANEL_RESIZE_ZONE_SELECTOR);
    const item = zone?.closest<HTMLElement>('.live-panel-item--resizable[data-panel-key]');
    if (!zone || !item) {
      return;
    }

    const zoneName = zone.dataset.livePanelResizeZone;
    if (zoneName !== 'right' && zoneName !== 'left') {
      return;
    }

    item.setPointerCapture(event.pointerId);
    livePanelResizePendingDraft = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      zone: zoneName,
    };
    event.preventDefault();
    event.stopPropagation();
  });

  root.addEventListener('pointermove', (event) => {
    if (livePanelResizeDraft) {
      updateLivePanelResize(event.clientX);
      return;
    }

    if (!livePanelResizePendingDraft || event.pointerId !== livePanelResizePendingDraft.pointerId) {
      return;
    }

    const deltaX = event.clientX - livePanelResizePendingDraft.startX;
    const deltaY = event.clientY - livePanelResizePendingDraft.startY;
    if (Math.abs(deltaX) < LIVE_PANEL_RESIZE_ACTIVATION_DISTANCE || Math.abs(deltaX) < Math.abs(deltaY)) {
      return;
    }

    const pendingDraft = livePanelResizePendingDraft;
    livePanelResizePendingDraft = null;
    if (!beginLivePanelResize(
      pendingDraft.item,
      pendingDraft.pointerId,
      pendingDraft.startX,
      pendingDraft.zone,
    )) {
      releaseLivePanelPointerCapture(pendingDraft.item, pendingDraft.pointerId);
      return;
    }
    updateLivePanelResize(event.clientX);
  });

  root.addEventListener('pointerup', (event) => {
    if (livePanelResizeDraft) {
      const activeItem = livePanelResizeDraft.item;
      releaseLivePanelPointerCapture(activeItem, event.pointerId);
      endLivePanelResize(root, controller, { commit: true });
      return;
    }

    if (!livePanelResizePendingDraft || event.pointerId !== livePanelResizePendingDraft.pointerId) {
      return;
    }

    releaseLivePanelPointerCapture(livePanelResizePendingDraft.item, event.pointerId);
    livePanelResizePendingDraft = null;
  });

  root.addEventListener('pointercancel', (event) => {
    if (livePanelResizeDraft) {
      const activeItem = livePanelResizeDraft.item;
      releaseLivePanelPointerCapture(activeItem, event.pointerId);
      endLivePanelResize(root, controller, { commit: false });
      return;
    }

    if (!livePanelResizePendingDraft || event.pointerId !== livePanelResizePendingDraft.pointerId) {
      return;
    }

    releaseLivePanelPointerCapture(livePanelResizePendingDraft.item, event.pointerId);
    livePanelResizePendingDraft = null;
  });
}

function capturePanelScrollDraft(root: HTMLElement): PanelScrollDraft {
  return {
    monitored: root.querySelector<HTMLElement>('.monitored-list')?.scrollTop ?? 0,
    bidZone: root.querySelector<HTMLElement>('.bid-zone-list')?.scrollTop ?? 0,
    pumpfun: root.querySelector<HTMLElement>('.pump-list')?.scrollTop ?? 0,
    pumpMigrations: root.querySelector<HTMLElement>('.pump-migration-strip')?.scrollLeft ?? 0,
    alerts: root.querySelector<HTMLElement>('.alerts-list')?.scrollTop ?? 0,
  };
}

function applyPanelScrollDraft(root: HTMLElement, draft: PanelScrollDraft) {
  const monitored = root.querySelector<HTMLElement>('.monitored-list');
  const bidZone = root.querySelector<HTMLElement>('.bid-zone-list');
  const pumpfun = root.querySelector<HTMLElement>('.pump-list');
  const pumpMigrations = root.querySelector<HTMLElement>('.pump-migration-strip');
  const alerts = root.querySelector<HTMLElement>('.alerts-list');

  if (monitored) monitored.scrollTop = draft.monitored;
  if (bidZone) bidZone.scrollTop = draft.bidZone;
  if (pumpfun) pumpfun.scrollTop = draft.pumpfun;
  if (pumpMigrations) pumpMigrations.scrollLeft = draft.pumpMigrations;
  if (alerts) alerts.scrollTop = draft.alerts;
}

function captureProfileModalScrollDraft(root: HTMLElement): ProfileModalScrollDraft | null {
  const panel = root.querySelector<HTMLElement>('[data-auth-modal-scope="profile"] [data-auth-panel]');
  if (!panel) {
    return null;
  }

  return {
    panel: panel.dataset.authPanel || null,
    scrollTop: panel.scrollTop,
  };
}

function applyProfileModalScrollDraft(root: HTMLElement, draft: ProfileModalScrollDraft | null) {
  if (!draft || !draft.panel) {
    return;
  }

  const selector = `[data-auth-modal-scope="profile"] [data-auth-panel="${draft.panel}"]`;
  const panel = root.querySelector<HTMLElement>(selector);
  if (!panel) {
    return;
  }

  panel.scrollTop = draft.scrollTop;
}

function captureLoginDraft(root: HTMLElement): LoginDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const password = form.querySelector<HTMLInputElement>('input[name="password"]');

  return {
    email: email?.value ?? '',
    password: password?.value ?? '',
    passwordVisible: password?.type === 'text',
  };
}

function applyLoginDraft(root: HTMLElement, draft: LoginDraft | null, _state: AppState) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="email"]');
  const password = form.querySelector<HTMLInputElement>('input[name="password"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-password-visibility"]');

  if (email && draft?.email) {
    email.value = draft.email;
  }
  if (password && draft?.password) {
    password.value = draft.password;
  }
  if (password && draft?.passwordVisible) {
    password.type = 'text';
  }

  if (toggle && password) {
    toggle.textContent = password.type === 'text' ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', password.type === 'text' ? 'Hide password' : 'Show password');
  }
}

function applyLoginFocus(root: HTMLElement, state: AppState) {
  if (state.session.status === 'authenticated' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  if (!form) {
    return;
  }

  const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]');
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]');

  if (!state.ui.error) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !form.contains(active)) {
      emailInput?.focus();
    }
    return;
  }

  if (state.ui.error === 'Email is required.' || state.ui.error === 'Enter a valid email address.') {
    emailInput?.focus();
    emailInput?.select();
    return;
  }

  if (
    state.ui.error.includes('Incorrect email or password')
  ) {
    emailInput?.focus();
    emailInput?.select();
    return;
  }

  if (
    state.ui.error === 'Password is required.'
  ) {
    passwordInput?.focus();
    passwordInput?.select();
  }
}

function focusInputAndSelect(input: HTMLInputElement | null | undefined) {
  if (!input) {
    return;
  }
  input.focus();
  input.select();
}

function formContainsActiveElement(form: HTMLFormElement | null | undefined) {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(form?.contains(active));
}

function hasChangePasswordDraftContent(draft: ChangePasswordDraft | null) {
  return Boolean(
    draft
    && (
      draft.currentPassword.length > 0
      || draft.newPassword.length > 0
      || draft.confirmNewPassword.length > 0
    )
  );
}

function resolveChangePasswordFocusTarget(
  form: HTMLFormElement | null,
  error: string | null,
) {
  const currentPassword = form?.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form?.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const confirmNewPassword = form?.querySelector<HTMLInputElement>('input[name="confirmNewPassword"]');

  if (error === 'Current password is required.' || error === 'Current password is incorrect') {
    return currentPassword;
  }

  if (
    error === 'New password is required.'
    || error === 'New password must be at least 8 characters.'
    || error === 'New password must be different from the current password.'
  ) {
    return newPassword;
  }

  if (
    error === 'Please confirm the new password.'
    || error === 'The new passwords do not match. Please check them and try again.'
  ) {
    return confirmNewPassword;
  }

  return null;
}

function captureChangePasswordDraft(root: HTMLElement): ChangePasswordDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  if (!form) {
    return null;
  }

  const currentPassword = form.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const confirmNewPassword = form.querySelector<HTMLInputElement>('input[name="confirmNewPassword"]');

  return {
    currentPassword: currentPassword?.value ?? '',
    newPassword: newPassword?.value ?? '',
    confirmNewPassword: confirmNewPassword?.value ?? '',
    currentVisible: currentPassword?.type === 'text',
    newVisible: newPassword?.type === 'text',
    confirmVisible: confirmNewPassword?.type === 'text',
  };
}

function applyChangePasswordDraft(root: HTMLElement, draft: ChangePasswordDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  if (!form || !draft) {
    return;
  }

  const currentPassword = form.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const confirmNewPassword = form.querySelector<HTMLInputElement>('input[name="confirmNewPassword"]');
  const currentToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-current-password-visibility"]');
  const newToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-new-password-visibility"]');
  const confirmToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-confirm-new-password-visibility"]');

  if (currentPassword) {
    currentPassword.value = draft.currentPassword;
    if (draft.currentVisible) {
      currentPassword.type = 'text';
    }
  }
  if (newPassword) {
    newPassword.value = draft.newPassword;
    if (draft.newVisible) {
      newPassword.type = 'text';
    }
  }
  if (confirmNewPassword) {
    confirmNewPassword.value = draft.confirmNewPassword;
    if (draft.confirmVisible) {
      confirmNewPassword.type = 'text';
    }
  }

  if (currentToggle && currentPassword) {
    currentToggle.textContent = currentPassword.type === 'text' ? 'Hide' : 'Show';
  }
  if (newToggle && newPassword) {
    newToggle.textContent = newPassword.type === 'text' ? 'Hide' : 'Show';
  }
  if (confirmToggle && confirmNewPassword) {
    confirmToggle.textContent = confirmNewPassword.type === 'text' ? 'Hide' : 'Show';
  }
}

function applyChangePasswordFocus(root: HTMLElement, state: AppState, draft: ChangePasswordDraft | null) {
  if (state.ui.authPanel !== 'change-password' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  if (formContainsActiveElement(form)) {
    return;
  }

  if (hasChangePasswordDraftContent(draft)) {
    return;
  }

  focusInputAndSelect(resolveChangePasswordFocusTarget(form, state.ui.error));
}

function captureRegisterDraft(root: HTMLElement): RegisterDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (!form) {
    return null;
  }

  const username = form.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const confirmPassword = form.querySelector<HTMLInputElement>('input[name="registerConfirmPassword"]');
  const inviteCode = form.querySelector<HTMLInputElement>('input[name="inviteCode"]');

  return {
    username: username?.value ?? '',
    email: email?.value ?? '',
    password: password?.value ?? '',
    confirmPassword: confirmPassword?.value ?? '',
    inviteCode: inviteCode?.value ?? '',
    passwordVisible: password?.type === 'text',
    confirmVisible: confirmPassword?.type === 'text',
  };
}

function captureEmailOtpDraft(root: HTMLElement): EmailOtpDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="email-otp-form"]');
  if (!form) {
    return null;
  }

  const code = form.querySelector<HTMLInputElement>('input[name="emailOtpCode"]');
  return {
    code: code?.value ?? '',
  };
}

function applyEmailOtpDraft(root: HTMLElement, draft: EmailOtpDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="email-otp-form"]');
  if (!form || !draft) {
    return;
  }

  const code = form.querySelector<HTMLInputElement>('input[name="emailOtpCode"]');
  if (code) {
    code.value = draft.code;
  }
}

function applyEmailOtpFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'email-otp' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="email-otp-form"]');
  const codeInput = form?.querySelector<HTMLInputElement>('input[name="emailOtpCode"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  codeInput?.focus();
}

function applyRegisterDraft(root: HTMLElement, draft: RegisterDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (!form || !draft) {
    return;
  }

  const username = form.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const confirmPassword = form.querySelector<HTMLInputElement>('input[name="registerConfirmPassword"]');
  const inviteCode = form.querySelector<HTMLInputElement>('input[name="inviteCode"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-register-password-visibility"]');
  const confirmToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-register-confirm-password-visibility"]');

  if (username) username.value = draft.username;
  if (email) email.value = draft.email;
  if (inviteCode) inviteCode.value = draft.inviteCode;
  if (password) {
    password.value = draft.password;
    if (draft.passwordVisible) {
      password.type = 'text';
    }
  }
  if (confirmPassword) {
    confirmPassword.value = draft.confirmPassword;
    if (draft.confirmVisible) {
      confirmPassword.type = 'text';
    }
  }

  if (toggle && password) {
    toggle.textContent = password.type === 'text' ? 'Hide' : 'Show';
  }
  if (confirmToggle && confirmPassword) {
    confirmToggle.textContent = confirmPassword.type === 'text' ? 'Hide' : 'Show';
  }
}

function focusInputWithSelection(input: HTMLInputElement | null | undefined) {
  if (!input) {
    return;
  }
  input.focus();
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function isRegisterUsernameError(error: string | null) {
  return error === 'Username is required.'
    || error === 'Username must be at least 3 characters.'
    || error === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || error === 'Username already taken';
}

function isRegisterEmailError(error: string | null) {
  return error === 'Email is required.'
    || error === 'Enter a valid email address.'
    || error === 'Email already registered'
    || error === 'Invalid email format';
}

function isRegisterPasswordError(error: string | null) {
  return error === 'Password is required.'
    || error === 'Password must be at least 8 characters.'
    || error === 'Password must be 8-128 characters.';
}

function isRegisterInviteError(error: string | null) {
  return Boolean(
    error === 'Invite code is required.'
    || error?.includes('Invite')
    || error?.includes('invite')
  );
}

function resolveRegisterFocusTarget(form: HTMLFormElement | null, error: string | null) {
  const username = form?.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form?.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form?.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const inviteCode = form?.querySelector<HTMLInputElement>('input[name="inviteCode"]');

  if (isRegisterUsernameError(error)) {
    return username;
  }
  if (isRegisterEmailError(error)) {
    return email;
  }
  if (isRegisterPasswordError(error)) {
    return password;
  }
  if (isRegisterInviteError(error)) {
    return inviteCode;
  }

  return username;
}

function applyRegisterFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'register' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (formContainsActiveElement(form)) {
    return;
  }

  focusInputWithSelection(resolveRegisterFocusTarget(form, state.ui.error));
}

function captureInviteAssistanceDraft(root: HTMLElement): InviteAssistanceDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form) {
    return null;
  }

  const inviteCode = form.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');

  return {
    inviteCode: inviteCode?.value ?? '',
  };
}

function captureEmailVerificationDraft(root: HTMLElement): EmailVerificationDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="email-verification-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="verificationEmail"]');
  return {
    email: email?.value ?? '',
  };
}

function applyEmailVerificationDraft(root: HTMLElement, draft: EmailVerificationDraft | null, state: AppState) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="email-verification-form"]');
  if (!form) {
    return;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="verificationEmail"]');
  if (email) {
    email.value = draft?.email || state.ui.pendingVerificationEmail || '';
  }
}

function applyEmailVerificationFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'email-verification' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="email-verification-form"]');
  const email = form?.querySelector<HTMLInputElement>('input[name="verificationEmail"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  email?.focus();
}

function applyInviteAssistanceDraft(root: HTMLElement, draft: InviteAssistanceDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form || !draft) {
    return;
  }

  const inviteCode = form.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');

  if (inviteCode) inviteCode.value = draft.inviteCode;
}

function applyInviteAssistanceFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'invite-assistance' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  const inviteCode = form?.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  inviteCode?.focus();
}

function capturePasswordResetDraft(root: HTMLElement): PasswordResetDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="password-reset-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="resetEmail"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="resetNewPassword"]');
  const confirmNewPassword = form.querySelector<HTMLInputElement>('input[name="resetConfirmNewPassword"]');

  return {
    email: email?.value ?? '',
    newPassword: newPassword?.value ?? '',
    confirmNewPassword: confirmNewPassword?.value ?? '',
    passwordVisible: newPassword?.type === 'text',
    confirmVisible: confirmNewPassword?.type === 'text',
  };
}

function applyPasswordResetDraft(root: HTMLElement, draft: PasswordResetDraft | null) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="password-reset-form"]');
  if (!form || !draft) {
    return;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="resetEmail"]');
  const newPassword = form.querySelector<HTMLInputElement>('input[name="resetNewPassword"]');
  const confirmNewPassword = form.querySelector<HTMLInputElement>('input[name="resetConfirmNewPassword"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-reset-password-visibility"]');
  const confirmToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-reset-confirm-password-visibility"]');

  if (email) {
    email.value = draft.email;
  }
  if (newPassword) {
    newPassword.value = draft.newPassword;
    if (draft.passwordVisible) {
      newPassword.type = 'text';
    }
  }
  if (confirmNewPassword) {
    confirmNewPassword.value = draft.confirmNewPassword;
    if (draft.confirmVisible) {
      confirmNewPassword.type = 'text';
    }
  }

  if (toggle && newPassword) {
    toggle.textContent = newPassword.type === 'text' ? 'Hide' : 'Show';
  }
  if (confirmToggle && confirmNewPassword) {
    confirmToggle.textContent = confirmNewPassword.type === 'text' ? 'Hide' : 'Show';
  }
}

function applyPasswordResetFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'password-reset' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="password-reset-form"]');
  const email = form?.querySelector<HTMLInputElement>('input[name="resetEmail"]');
  const newPassword = form?.querySelector<HTMLInputElement>('input[name="resetNewPassword"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  if (state.ui.pendingPasswordResetToken) {
    newPassword?.focus();
    return;
  }

  email?.focus();
}

function captureConfigDraft(root: HTMLElement): ConfigDraft | null {
  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) {
    return null;
  }

  const values: Record<string, string> = {};
  for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    values[field.name] = field.value;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement) || !configSection.contains(active) || !active.name) {
    return { values, focusedName: null, selectionStart: null, selectionEnd: null };
  }

  return {
    values,
    focusedName: active.name,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
  };
}

function applyConfigDraft(root: HTMLElement, draft: ConfigDraft | null, state: AppState) {
  if (!draft) return;

  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) return;

  if (!draft.focusedName && state.ui.busy) {
    for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
      const value = draft.values[field.name];
      if (value != null) {
        field.value = value;
      }
    }
    return;
  }

  if (!draft.focusedName) return;
  const focused = configSection.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${draft.focusedName}"]`);
  if (!focused) return;

  const value = draft.values[draft.focusedName];
  if (value != null) {
    focused.value = value;
  }

  focused.focus();
  if (focused instanceof HTMLInputElement && draft.selectionStart != null && draft.selectionEnd != null) {
    focused.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}
