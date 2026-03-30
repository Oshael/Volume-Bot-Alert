import type { AppController, AppRenderRegion } from '../state/app-controller';
import { getManualTokens, getMonitoredTokens, getOldWeekTokens, getRecentTokens, isProfileAuthPanel, type AppState } from '../state/app-state';
import { renderAlertsSection } from './sections/alerts-section';
import { renderLegacyShell, renderWorkspaceHeader, renderWorkspaceProfileOverlay } from './sections/layout-sections';
import { renderBidZoneSection } from './sections/bid-zone-section';
import { renderManualTokensSection } from './sections/manual-section';
import { renderLateralizedSection } from './sections/lateralized-section';
import { renderMonitoredSection } from './sections/monitored-section';
import { renderPumpfunSection } from './sections/pumpfun-section';
import { renderPumpToasts } from './sections/pumpfun-toasts';
import { renderOldWeekSection, renderRecentSection } from './sections/routed-sections';

type ConfigDraft = {
  values: Record<string, string>;
  focusedName: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type PanelScrollDraft = {
  monitored: number;
  lateralized: number;
  bidZone: number;
  pumpfun: number;
  alerts: number;
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
  monitoredSlot: HTMLElement;
  lateralizedSlot: HTMLElement;
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
const APP_MONITORED_SLOT_SELECTOR = '[data-app-render-slot="monitored"]';
const APP_LATERALIZED_SLOT_SELECTOR = '[data-app-render-slot="lateralized"]';
const APP_BID_ZONE_SLOT_SELECTOR = '[data-app-render-slot="bid-zone"]';
const APP_PUMPFUN_SLOT_SELECTOR = '[data-app-render-slot="pumpfun"]';
const APP_ALERTS_SLOT_SELECTOR = '[data-app-render-slot="alerts"]';
const APP_OVERLAY_SLOT_SELECTOR = '[data-app-render-slot="overlay"]';

export function renderAppShell(
  root: HTMLElement,
  state: AppState,
  controller: AppController,
  dirtyRegions: ReadonlySet<AppRenderRegion> = new Set<AppRenderRegion>(['all']),
) {
  const configDraft = captureConfigDraft(root);
  const panelScrollDraft = capturePanelScrollDraft(root);
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
  renderFrame.panels.dataset.workspace = state.ui.workspace;

  updateRegionSlot(renderFrame.headerSlot, 'header', dirtyRegions, getHeaderRenderKey(state), () => (
    state.session.status === 'authenticated'
      ? [renderWorkspaceHeader(state, controller)]
      : []
  ));

  renderFrame.toastsSlot.hidden = !isLiveWorkspace;
  if (isLiveWorkspace) {
    updateRegionSlot(renderFrame.toastsSlot, 'toasts', dirtyRegions, getToastsRenderKey(state), () => [renderPumpToasts(state)]);
  } else {
    updateRenderSlot(renderFrame.toastsSlot, 'hidden', () => []);
  }
  updateRegionSlot(renderFrame.legacySlot, 'legacy', dirtyRegions, getLegacyRenderKey(state), () => [renderLegacyShell(state, controller)]);

  if (state.session.status === 'authenticated') {
    renderFrame.oldWeekSlot.hidden = !isHistoryWorkspace;
    renderFrame.recentSlot.hidden = !isHistoryWorkspace;
    renderFrame.manualSlot.hidden = !isLiveWorkspace;
    renderFrame.panels.hidden = false;

    if (isHistoryWorkspace) {
      updateRegionSlot(renderFrame.oldWeekSlot, 'old-week', dirtyRegions, getOldWeekRenderKey(state), () => [renderOldWeekSection(state, controller)]);
      updateRegionSlot(renderFrame.recentSlot, 'recent', dirtyRegions, getRecentRenderKey(state), () => [renderRecentSection(state, controller)]);
    } else {
      updateRenderSlot(renderFrame.oldWeekSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.recentSlot, 'hidden', () => []);
    }

    if (isLiveWorkspace) {
      updateRegionSlot(renderFrame.manualSlot, 'manual', dirtyRegions, getManualRenderKey(state), () => [renderManualTokensSection(state, controller)]);
      updateRegionSlot(renderFrame.monitoredSlot, 'monitored', dirtyRegions, getMonitoredRenderKey(state), () => [renderMonitoredSection(state, controller)]);
      updateRegionSlot(renderFrame.pumpfunSlot, 'pumpfun', dirtyRegions, getPumpfunRenderKey(state), () => [renderPumpfunSection(state, controller)]);
      updateRegionSlot(renderFrame.alertsSlot, 'alerts', dirtyRegions, getAlertsRenderKey(state), () => [renderAlertsSection(state, controller)]);
    } else {
      updateRenderSlot(renderFrame.manualSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.monitoredSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.pumpfunSlot, 'hidden', () => []);
      updateRenderSlot(renderFrame.alertsSlot, 'hidden', () => []);
    }

    renderFrame.monitoredSlot.hidden = !isLiveWorkspace;
    renderFrame.pumpfunSlot.hidden = !isLiveWorkspace;
    renderFrame.alertsSlot.hidden = !isLiveWorkspace;
    renderFrame.lateralizedSlot.hidden = !isHistoryWorkspace;
    renderFrame.bidZoneSlot.hidden = !isHistoryWorkspace;

    if (isHistoryWorkspace) {
      updateRegionSlot(renderFrame.lateralizedSlot, 'lateralized', dirtyRegions, getLateralizedRenderKey(state), () => [renderLateralizedSection(state, controller)]);
      updateRegionSlot(renderFrame.bidZoneSlot, 'bid-zone', dirtyRegions, getBidZoneRenderKey(state), () => [renderBidZoneSection(state, controller)]);
    } else {
      updateRenderSlot(renderFrame.lateralizedSlot, 'hidden', () => []);
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
    renderFrame.lateralizedSlot.replaceChildren();
    renderFrame.bidZoneSlot.replaceChildren();
    renderFrame.pumpfunSlot.replaceChildren();
    renderFrame.alertsSlot.replaceChildren();
  }

  updateRegionSlot(renderFrame.overlaySlot, 'overlay', dirtyRegions, getOverlayRenderKey(state), () => {
    const profileOverlay = state.session.status === 'authenticated'
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
  wireHoverPersistence(root);
  wireTradeMenus(root);
  wireSortMenus(root);
  wireLogHovers(root);
  wireUserMenus(root);
  wireProfileModals(root, controller);
  applyHoverState(root);
}

function ensureAppRenderFrame(root: HTMLElement): AppRenderFrame {
  const existingFrame = root.querySelector<HTMLElement>(APP_RENDER_FRAME_SELECTOR);
  const existingHeaderSlot = existingFrame?.querySelector<HTMLElement>(APP_HEADER_SLOT_SELECTOR);
  const existingShell = existingFrame?.querySelector<HTMLElement>(APP_SHELL_SELECTOR);
  const existingToastsSlot = existingFrame?.querySelector<HTMLElement>(APP_TOASTS_SLOT_SELECTOR);
  const existingLegacySlot = existingFrame?.querySelector<HTMLElement>(APP_LEGACY_SLOT_SELECTOR);
  const existingOldWeekSlot = existingFrame?.querySelector<HTMLElement>(APP_OLD_WEEK_SLOT_SELECTOR);
  const existingRecentSlot = existingFrame?.querySelector<HTMLElement>(APP_RECENT_SLOT_SELECTOR);
  const existingManualSlot = existingFrame?.querySelector<HTMLElement>(APP_MANUAL_SLOT_SELECTOR);
  const existingPanels = existingFrame?.querySelector<HTMLElement>(APP_PANELS_SELECTOR);
  const existingMonitoredSlot = existingFrame?.querySelector<HTMLElement>(APP_MONITORED_SLOT_SELECTOR);
  const existingLateralizedSlot = existingFrame?.querySelector<HTMLElement>(APP_LATERALIZED_SLOT_SELECTOR);
  const existingBidZoneSlot = existingFrame?.querySelector<HTMLElement>(APP_BID_ZONE_SLOT_SELECTOR);
  const existingPumpfunSlot = existingFrame?.querySelector<HTMLElement>(APP_PUMPFUN_SLOT_SELECTOR);
  const existingAlertsSlot = existingFrame?.querySelector<HTMLElement>(APP_ALERTS_SLOT_SELECTOR);
  const existingOverlaySlot = existingFrame?.querySelector<HTMLElement>(APP_OVERLAY_SLOT_SELECTOR);

  if (
    existingFrame
    && existingHeaderSlot
    && existingShell
    && existingToastsSlot
    && existingLegacySlot
    && existingOldWeekSlot
    && existingRecentSlot
    && existingManualSlot
    && existingPanels
    && existingMonitoredSlot
    && existingLateralizedSlot
    && existingBidZoneSlot
    && existingPumpfunSlot
    && existingAlertsSlot
    && existingOverlaySlot
  ) {
    return {
      frame: existingFrame,
      headerSlot: existingHeaderSlot,
      shell: existingShell,
      toastsSlot: existingToastsSlot,
      legacySlot: existingLegacySlot,
      oldWeekSlot: existingOldWeekSlot,
      recentSlot: existingRecentSlot,
      manualSlot: existingManualSlot,
      panels: existingPanels,
      monitoredSlot: existingMonitoredSlot,
      lateralizedSlot: existingLateralizedSlot,
      bidZoneSlot: existingBidZoneSlot,
      pumpfunSlot: existingPumpfunSlot,
      alertsSlot: existingAlertsSlot,
      overlaySlot: existingOverlaySlot,
    };
  }

  const frame = document.createElement('div');
  frame.dataset.appRenderFrame = 'true';

  const headerSlot = document.createElement('div');
  headerSlot.dataset.appRenderSlot = 'header';

  const shell = document.createElement('div');
  shell.dataset.appRenderSlot = 'shell';
  shell.className = 'app-shell';

  const toastsSlot = document.createElement('div');
  toastsSlot.dataset.appRenderSlot = 'toasts';

  const legacySlot = document.createElement('div');
  legacySlot.dataset.appRenderSlot = 'legacy';

  const oldWeekSlot = document.createElement('div');
  oldWeekSlot.dataset.appRenderSlot = 'old-week';

  const recentSlot = document.createElement('div');
  recentSlot.dataset.appRenderSlot = 'recent';

  const manualSlot = document.createElement('div');
  manualSlot.dataset.appRenderSlot = 'manual';

  const panels = document.createElement('div');
  panels.dataset.appRenderSlot = 'panels';
  panels.className = 'legacy-panels';

  const monitoredStack = document.createElement('div');
  monitoredStack.className = 'panel-stack monitored-stack';

  const monitoredSlot = document.createElement('div');
  monitoredSlot.dataset.appRenderSlot = 'monitored';

  const lateralizedSlot = document.createElement('div');
  lateralizedSlot.dataset.appRenderSlot = 'lateralized';

  const bidZoneSlot = document.createElement('div');
  bidZoneSlot.dataset.appRenderSlot = 'bid-zone';

  const pumpfunSlot = document.createElement('div');
  pumpfunSlot.dataset.appRenderSlot = 'pumpfun';

  const alertsSlot = document.createElement('div');
  alertsSlot.dataset.appRenderSlot = 'alerts';

  monitoredStack.append(monitoredSlot, lateralizedSlot, bidZoneSlot);
  panels.append(monitoredStack, pumpfunSlot, alertsSlot);
  shell.append(toastsSlot, legacySlot, oldWeekSlot, recentSlot, manualSlot, panels);

  const overlaySlot = document.createElement('div');
  overlaySlot.dataset.appRenderSlot = 'overlay';

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
    monitoredSlot,
    lateralizedSlot,
    bidZoneSlot,
    pumpfunSlot,
    alertsSlot,
    overlaySlot,
  };
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
) {
  if (!shouldRefreshRegion(slot, region, dirtyRegions)) {
    return;
  }

  updateRenderSlot(slot, nextKey, build);
}

function serializePrimitiveList(values: Array<string | number | boolean | null | undefined>) {
  return values.map((value) => value == null ? '' : String(value)).join('~');
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

function getHeaderRenderKey(state: AppState) {
  return serializePrimitiveList([
    state.session.status,
    state.session.username,
    state.session.email,
    state.runtime.mode,
    state.ui.workspace,
  ]);
}

function getToastsRenderKey(state: AppState) {
  return [
    state.data.pumpToasts.length,
    ...state.data.pumpToasts.map((toast) => serializePrimitiveList([
      toast.id,
      toast.mint,
      toast.symbol,
      toast.createdAt,
      toast.migratedAt,
      toast.mcap,
      toast.vol5m,
    ])),
  ].join('|');
}

function getLegacyRenderKey(state: AppState) {
  return JSON.stringify({
    sessionStatus: state.session.status,
    busy: state.ui.busy,
    authPanel: state.ui.authPanel,
    error: state.ui.error,
    notice: state.ui.notice,
    pendingVerificationEmail: state.ui.pendingVerificationEmail,
    pendingPasswordResetToken: state.ui.pendingPasswordResetToken,
    pendingLoginOtpChallengeToken: state.ui.pendingLoginOtpChallengeToken,
    pendingLoginOtpEmailHint: state.ui.pendingLoginOtpEmailHint,
  });
}

function getMonitoredRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.monitored,
    busy: state.ui.busy,
    role: state.session.role,
    search: state.ui.monitoredSearchQuery,
    page: state.ui.monitoredPage,
    perPage: state.ui.monitoredPerPage,
    sorts: state.ui.monitoredSorts,
    starred: state.data.starredTokens,
    tokens: getMonitoredTokens(state).map(serializeTrackedTokenForView),
  });
}

function getManualRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.manual,
    busy: state.ui.busy,
    role: state.session.role,
    search: state.ui.manualSearchQuery,
    starredOnly: state.ui.manualStarredOnly,
    sorts: state.ui.manualSorts,
    starred: state.data.starredTokens,
    meteoraMinPool: Number(state.data.configs['meteora-min-pool']) || 5000,
    tokens: getManualTokens(state).map(serializeTrackedTokenForView),
  });
}

function getRecentRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.recent,
    busy: state.ui.busy,
    role: state.session.role,
    runtimeMode: state.runtime.mode,
    search: state.ui.recentSearchQuery,
    starredOnly: state.ui.recentStarredOnly,
    page: state.ui.recentPage,
    perPage: state.ui.recentPerPage,
    sorts: state.ui.recentSorts,
    barsRecent: state.bars.recent,
    oldMcapMin: state.data.configs['old-mcap-min'],
    oldMcapMax: state.data.configs['old-mcap-max'],
    log: state.data.recentRemovalLog.map((entry) => serializePrimitiveList([entry.address, entry.reason, entry.ts])),
    starred: state.data.starredTokens,
    tokens: getRecentTokens(state).map(serializeTrackedTokenForView),
  });
}

function getOldWeekRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.oldWeek,
    busy: state.ui.busy,
    role: state.session.role,
    search: state.ui.oldWeekSearchQuery,
    starredOnly: state.ui.oldWeekStarredOnly,
    page: state.ui.oldWeekPage,
    perPage: state.ui.oldWeekPerPage,
    sorts: state.ui.oldWeekSorts,
    barsOldWeek: state.bars.oldWeek,
    oldWeekMcapMin: state.data.configs['old-week-mcap-min'],
    oldWeekMcapMax: state.data.configs['old-week-mcap-max'],
    log: state.data.oldWeekRemovalLog.map((entry) => serializePrimitiveList([entry.address, entry.reason, entry.ts])),
    starred: state.data.starredTokens,
    tokens: getOldWeekTokens(state).map(serializeTrackedTokenForView),
  });
}

function getLateralizedRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.lateralized,
    busy: state.ui.busy,
    role: state.session.role,
    freshness: state.runtime.lateralizedFreshnessLabel,
    starred: state.data.starredTokens,
    tracked: state.data.lateralizedTokens.map((item) => serializePrimitiveList([
      item.address,
      item.symbol,
      item.name,
      item.mcap,
      item.volume1h,
      item.volume24h,
      item.ageHours,
      item.score,
      state.data.trackedTokensByAddress[item.address]?.symbol,
      state.data.trackedTokensByAddress[item.address]?.name,
      state.data.trackedTokensByAddress[item.address]?.imageUrl,
      state.data.trackedTokensByAddress[item.address]?.pairUrl,
    ])),
  });
}

function getBidZoneRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.bidZone,
    busy: state.ui.busy,
    role: state.session.role,
    freshness: state.runtime.bidZoneFreshnessLabel,
    starred: state.data.starredTokens,
    tracked: state.data.bidZoneTokens.map((item) => serializePrimitiveList([
      item.address,
      item.symbol,
      item.name,
      item.mcap,
      item.volume1h,
      item.volume24h,
      item.ageHours,
      item.score,
      item.supportDistancePct,
      item.supportTouchClusters,
      item.recentRangePct,
      item.closeDriftPct,
      state.data.trackedTokensByAddress[item.address]?.symbol,
      state.data.trackedTokensByAddress[item.address]?.name,
      state.data.trackedTokensByAddress[item.address]?.imageUrl,
      state.data.trackedTokensByAddress[item.address]?.pairUrl,
    ])),
  });
}

function getPumpfunRenderKey(state: AppState) {
  return JSON.stringify({
    collapsed: state.ui.collapsed.pumpfun,
    busy: state.ui.busy,
    role: state.session.role,
    statusLabel: state.pumpfun.statusLabel,
    connected: state.pumpfun.connected,
    configs: {
      pumpEntryVol: state.data.configs['pump-entry-vol'],
      pumpMinVol: state.data.configs['pump-min-vol'],
    },
    migrations: state.data.recentPumpMigrations.map((item) => serializePrimitiveList([
      item.mint,
      item.symbol,
      item.createdAt,
      item.migratedAt,
      item.mcap,
      item.vol5m,
    ])),
    tokens: state.data.pumpTokens.map((token) => serializePrimitiveList([
      token.mint,
      token.symbol,
      token.createdAt,
      token.lastTradeAt,
      token.mcap,
      token.volTotal,
      token.hidden,
      token._migrated,
      token.vol5m?.length ?? 0,
    ])),
  });
}

function getAlertsRenderKey(state: AppState) {
  return JSON.stringify({
    busy: state.ui.busy,
    role: state.session.role,
    search: state.ui.alertSearchQuery,
    starred: state.data.starredTokens,
    alerts: state.data.alerts.map((alert) => serializePrimitiveList([
      alert.id,
      alert.kind,
      alert.address,
      alert.symbol,
      alert.name,
      alert.createdAt,
      alert.volume5m,
      alert.volume1h,
      alert.volume6h,
      alert.volume24h,
      alert.prevMcap,
      alert.mcap,
      alert.pct,
      alert.label,
      alert.isHvnc,
      alert.isOldSurge,
    ])),
  });
}

function getOverlayRenderKey(state: AppState) {
  return JSON.stringify({
    sessionStatus: state.session.status,
    authPanel: state.ui.authPanel,
    busy: state.ui.busy,
    error: state.ui.error,
    notice: state.ui.notice,
    role: state.session.role,
    accessStatus: state.session.accessStatus,
    accessExpiresAt: state.session.accessExpiresAt,
    accessDaysRemaining: state.session.accessDaysRemaining,
    accessSource: state.session.accessSource,
    username: state.ui.authPanel === 'user-settings' ? state.session.username : null,
    email: state.ui.authPanel === 'user-settings' ? state.session.email : null,
    isEmailVerified: state.ui.authPanel === 'user-settings' ? state.session.isEmailVerified : null,
    emailVerifiedAt: state.ui.authPanel === 'user-settings' ? state.session.emailVerifiedAt : null,
    billingLoaded: state.ui.authPanel === 'user-settings' ? state.billing.loaded : null,
    billingEnabled: state.ui.authPanel === 'user-settings' ? state.billing.enabled : null,
    billingProviderReady: state.ui.authPanel === 'user-settings' ? state.billing.providerReady : null,
    billingPlans: state.ui.authPanel === 'user-settings' ? state.billing.plans : null,
    billingOrders: state.ui.authPanel === 'user-settings' ? state.billing.orders : null,
    billingPendingPlanKey: state.ui.authPanel === 'user-settings' ? state.billing.pendingPlanKey : null,
    billingError: state.ui.authPanel === 'user-settings' ? state.billing.error : null,
    configs: state.ui.authPanel === 'bot-settings' ? state.data.configs : null,
    blocklist: state.ui.authPanel === 'blocked-tokens' ? state.data.blocklist : null,
  });
}

function syncProfileModalScrollLock(state: AppState) {
  document.body.classList.toggle('profile-modal-open', isProfileAuthPanel(state.ui.authPanel));
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
let logHoverWired = false;
let profileModalWired = false;

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

function wireLogHovers(root: HTMLElement) {
  if (logHoverWired) return;
  logHoverWired = true;

  const syncLogHoverToggles = () => {
    for (const wrap of root.querySelectorAll<HTMLElement>('[data-log-hover]')) {
      const toggle = wrap.querySelector<HTMLElement>('[data-log-hover-toggle]');
      if (toggle) {
        toggle.setAttribute('aria-expanded', wrap.classList.contains('open') ? 'true' : 'false');
      }
    }
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-log-hover-toggle]');
    const closeButton = target?.closest<HTMLElement>('[data-log-hover-close]');
    const wrap = target?.closest<HTMLElement>('[data-log-hover]');

    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-log-hover].open')) {
      if (openWrap !== wrap) openWrap.classList.remove('open');
    }

    if (toggle && wrap) {
      event.preventDefault();
      wrap.classList.toggle('open');
      syncLogHoverToggles();
      return;
    }

    if (closeButton && wrap) {
      event.preventDefault();
      wrap.classList.remove('open');
      syncLogHoverToggles();
      return;
    }

    if (!wrap) {
      for (const openWrap of root.querySelectorAll<HTMLElement>('[data-log-hover].open')) {
        openWrap.classList.remove('open');
      }
      syncLogHoverToggles();
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    let changed = false;
    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-log-hover].open')) {
      openWrap.classList.remove('open');
      changed = true;
    }
    if (changed) {
      syncLogHoverToggles();
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

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const profileModal = target?.closest<HTMLElement>('[data-auth-modal-scope="profile"]');
    const closeButton = target?.closest<HTMLElement>(closeSelector);
    const backdrop = target?.closest<HTMLElement>('.legacy-auth-modal-backdrop');
    if (!profileModal || (!closeButton && !backdrop)) {
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
    const hasProfileModal = root.querySelector('[data-auth-modal-scope="profile"]');
    if (!hasProfileModal) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    controller.closeAuthPanel();
  });
}

function capturePanelScrollDraft(root: HTMLElement): PanelScrollDraft {
  return {
    monitored: root.querySelector<HTMLElement>('.monitored-list')?.scrollTop ?? 0,
    lateralized: root.querySelector<HTMLElement>('.lateralized-list')?.scrollTop ?? 0,
    bidZone: root.querySelector<HTMLElement>('.bid-zone-list')?.scrollTop ?? 0,
    pumpfun: root.querySelector<HTMLElement>('.pump-list')?.scrollTop ?? 0,
    alerts: root.querySelector<HTMLElement>('.alerts-list')?.scrollTop ?? 0,
  };
}

function applyPanelScrollDraft(root: HTMLElement, draft: PanelScrollDraft) {
  const monitored = root.querySelector<HTMLElement>('.monitored-list');
  const lateralized = root.querySelector<HTMLElement>('.lateralized-list');
  const bidZone = root.querySelector<HTMLElement>('.bid-zone-list');
  const pumpfun = root.querySelector<HTMLElement>('.pump-list');
  const alerts = root.querySelector<HTMLElement>('.alerts-list');

  if (monitored) monitored.scrollTop = draft.monitored;
  if (lateralized) lateralized.scrollTop = draft.lateralized;
  if (bidZone) bidZone.scrollTop = draft.bidZone;
  if (pumpfun) pumpfun.scrollTop = draft.pumpfun;
  if (alerts) alerts.scrollTop = draft.alerts;
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

function applyLoginDraft(root: HTMLElement, draft: LoginDraft | null, state: AppState) {
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
  const currentPassword = form?.querySelector<HTMLInputElement>('input[name="currentPassword"]');
  const newPassword = form?.querySelector<HTMLInputElement>('input[name="newPassword"]');
  const active = document.activeElement;

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  if (
    draft
    && (
      draft.currentPassword.length > 0
      || draft.newPassword.length > 0
      || draft.confirmNewPassword.length > 0
    )
  ) {
    return;
  }

  if (state.ui.error === 'Current password is required.') {
    currentPassword?.focus();
    currentPassword?.select();
    return;
  }
  if (state.ui.error === 'Current password is incorrect') {
    currentPassword?.focus();
    currentPassword?.select();
    return;
  }
  if (
    state.ui.error === 'New password is required.'
    || state.ui.error === 'New password must be at least 8 characters.'
    || state.ui.error === 'New password must be different from the current password.'
  ) {
    newPassword?.focus();
    newPassword?.select();
    return;
  }

  if (
    state.ui.error === 'Please confirm the new password.'
    || state.ui.error === 'The new passwords do not match. Please check them and try again.'
  ) {
    const confirmNewPassword = form?.querySelector<HTMLInputElement>('input[name="confirmNewPassword"]');
    confirmNewPassword?.focus();
    confirmNewPassword?.select();
    return;
  }
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

function applyRegisterFocus(root: HTMLElement, state: AppState) {
  if (state.ui.authPanel !== 'register' || state.ui.busy) {
    return;
  }

  const form = root.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  const username = form?.querySelector<HTMLInputElement>('input[name="username"]');
  const email = form?.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const password = form?.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const inviteCode = form?.querySelector<HTMLInputElement>('input[name="inviteCode"]');
  const active = document.activeElement;
  const focusAndSelect = (input: HTMLInputElement | null | undefined) => {
    if (!input) {
      return;
    }
    input.focus();
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  if (active instanceof HTMLElement && form?.contains(active)) {
    return;
  }

  if (
    state.ui.error === 'Username is required.'
    || state.ui.error === 'Username must be at least 3 characters.'
    || state.ui.error === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || state.ui.error === 'Username already taken'
  ) {
    focusAndSelect(username);
    return;
  }
  if (
    state.ui.error === 'Email is required.'
    || state.ui.error === 'Enter a valid email address.'
    || state.ui.error === 'Email already registered'
    || state.ui.error === 'Invalid email format'
  ) {
    focusAndSelect(email);
    return;
  }
  if (
    state.ui.error === 'Password is required.'
    || state.ui.error === 'Password must be at least 8 characters.'
    || state.ui.error === 'Password must be 8-128 characters.'
  ) {
    focusAndSelect(password);
    return;
  }
  if (
    state.ui.error === 'Invite code is required.'
    || state.ui.error?.includes('Invite')
    || state.ui.error?.includes('invite')
  ) {
    focusAndSelect(inviteCode);
    return;
  }

  username?.focus();
}

function captureInviteAssistanceDraft(root: HTMLElement): InviteAssistanceDraft | null {
  const form = root.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form) {
    return null;
  }

  const email = form.querySelector<HTMLInputElement>('input[name="assistanceEmail"]');
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
