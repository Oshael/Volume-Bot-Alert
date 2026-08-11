import type { AppController } from '../../state/app-controller';
import { getAlertFeedAlerts, getManualTokens, getMonitoredTokens, getOldWeekTokens, getRecentTokens, isChainSelectedForSurface, isTokenStarred, type AdminTokenReviewAlertEntry, type AlertEntry, type AppState, type CustomAlertCapabilityEntry, type CustomAlertRuleEntry, type ManualTokenEntry, type TokenSparklineEntry } from '../../state/app-state';
import { getAlertImpactTier, getAlertToneClass, getAlertVisualClasses, isHvncAlert, type AlertImpactTier } from '../../services/alerts/impact-tier';
import { formatClaimFee } from '../../services/alerts/claim-fee-format';
import { bindCompactSearch, bindCopyButtons, bindSparklineHover, bindTokenActions, bindTokenImagePreview, bindTopEdgePageScrollBridge, buildTickerPeerMcapLabel, buildTradeTerminalMenuElement, buildXSearchUrl, fmtAge, fmtAgeFromDurationMs, fmtMoney, fmtPct, formatPriceUsd, getAgeToneClassFromAgeMs, getAgeToneClassFromCreatedAt, renderSparklineFigure, renderTokenLaunchpadBadge, resolveTokenAgeMs } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { buildTokenExplorerUrl, buildTokenMarketUrl, createLegacyCompatibleTokenIdentity, normalizeTokenChain, type TokenChain } from '../../utils/token-chain';
import { resolveTokenValuation } from '../../utils/token-valuation';
import { buildTokenIdentityBadgeGroup } from '../token-chain-badge';

const ALERT_FX_SETTLE_MS = 1_600;
const ALERTS_PER_PAGE = 40;
const ALERT_CONTENT_MAX_WIDTH_PX = 640;
const ALERT_CONTENT_BUFFER_PX = 20;
const ALERT_CHART_MIN_WIDTH_PX = 200;
const ALERT_RAIL_EXTRA_WIDTH_PX = 12;
const ALERT_RAIL_GAP_FALLBACK_PX = 36;
const TICKER_PEERS_PANEL_GAP_PX = 8;
const TICKER_PEERS_VIEWPORT_MARGIN_PX = 12;
const TICKER_PEERS_MAX_HEIGHT_PX = 360;
const TICKER_PEERS_MIN_HEIGHT_PX = 120;
const CUSTOM_ALERT_SOUND_MAX_BYTES = 5 * 1024 * 1024;
const ROBINHOOD_HVNC_RULE_KEY = 'robinhood-hvnc-v2';

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
  customAlertModal: HTMLElement;
  customAlertTokenInput: HTMLInputElement;
  customAlertPreview: HTMLElement;
  pageJumpInput: HTMLInputElement;
  pageTotal: HTMLElement;
  prevButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  emptyState: HTMLElement;
  fxGhostHost: HTMLElement;
  controller: AppController;
  latestState: AppState | null;
  rowViews: Map<string, AlertRowView>;
  fxStates: Map<string, AlertFxState>;
  layoutMeasureRaf: number | null;
  resizeObserver: ResizeObserver | null;
};

let alertsSectionView: AlertsSectionView | null = null;
const alertRowShakeAnimations = new WeakMap<HTMLElement, Animation>();
const customAlertSoundAssets = new WeakMap<HTMLElement, { name: string; dataUrl: string }>();

export function renderAlertsSection(state: AppState, controller: AppController) {
  const renderNow = Date.now();
  const view = getOrCreateAlertsSectionView(controller);
  const cardEffectsEnabled = areAlertCardEffectsEnabled(state);
  const pinnedReviewAlerts = buildPinnedAdminReviewAlerts(state);
  const feedAlerts = getAlertFeedAlerts(state);
  const visibleAlerts = [...pinnedReviewAlerts, ...feedAlerts];
  view.controller = controller;
  view.latestState = state;
  if (!view.customAlertModal.hidden) {
    syncCustomAlertCapabilityControls(view.customAlertModal);
    renderCustomAlertRulesList();
  }
  syncAlertFxStates(view, visibleAlerts, renderNow);
  if (!cardEffectsEnabled && view.fxGhostHost.childElementCount > 0) {
    view.fxGhostHost.replaceChildren();
  }

  const searchQuery = String(state.ui.alertSearchQuery || '');
  const filteredAlerts = filterAlerts(feedAlerts, searchQuery);
  const pagination = paginateAlerts(filteredAlerts, state.ui.alertPage);
  const displayedAlerts = [...pinnedReviewAlerts, ...pagination.pageItems];

  syncSearchInput(view, searchQuery);
  syncPaginationControls(view, pagination.safePage, pagination.totalPages);
  reconcileAlertRows(view, displayedAlerts, visibleAlerts, state, renderNow, cardEffectsEnabled);
  bindSparklineHover(view.section, state.data.alertSparklineById, { controller });
  bindTokenImagePreview(view.section);
  view.count.textContent = String(pinnedReviewAlerts.length + filteredAlerts.length);

  return view.section;
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
        <div class="compact-search compact-search-fixed">
          <button type="button" class="compact-search-toggle" data-action="alerts-search-focus" aria-label="Search alerts">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="alerts-search" data-search-input="alerts">
        </div>
        <button type="button" class="action-button small custom-alert-open-button" data-action="open-custom-alert-prototype">Custom</button>
        <button type="button" class="action-button small" data-action="alerts-clear-all">Clean Alerts</button>
        <div class="alerts-page-controls" aria-label="Alerts pages">
          <button type="button" class="action-button small" data-action="alerts-prev">Prev</button>
          <label class="legacy-mini-field alerts-page-field">
            PAGE
            <span class="alerts-page-box">
              <input type="number" min="1" step="1" data-action="alerts-page-jump" aria-label="Current alerts page" />
              <span class="alerts-page-separator" aria-hidden="true">/</span>
              <span class="bucket-page-total alerts-page-total">1</span>
            </span>
          </label>
          <button type="button" class="action-button small" data-action="alerts-next">Next</button>
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
  const customAlertModal = buildCustomAlertPrototypeModal();
  const customAlertTokenInput = customAlertModal.querySelector<HTMLInputElement>('[data-custom-alert-field="tokenQuery"]');
  const customAlertPreview = customAlertModal.querySelector<HTMLElement>('[data-custom-alert-preview]');
  const pageJumpInput = section.querySelector<HTMLInputElement>('[data-action="alerts-page-jump"]');
  const pageTotal = section.querySelector<HTMLElement>('.alerts-page-total');
  const prevButton = section.querySelector<HTMLButtonElement>('[data-action="alerts-prev"]');
  const nextButton = section.querySelector<HTMLButtonElement>('[data-action="alerts-next"]');
  if (!list || !count || !searchInput || !searchWrap || !customAlertTokenInput || !customAlertPreview || !pageJumpInput || !pageTotal || !prevButton || !nextButton) {
    throw new Error('Alerts section view failed to initialize.');
  }

  bindTopEdgePageScrollBridge(list);

  const emptyState = buildEmptyState();
  alertsSectionView = {
    section,
    list,
    count,
    searchInput,
    searchWrap,
    customAlertModal,
    customAlertTokenInput,
    customAlertPreview,
    pageJumpInput,
    pageTotal,
    prevButton,
    nextButton,
    emptyState,
    fxGhostHost: getOrCreateAlertFxGhostHost(),
    controller,
    latestState: null,
    rowViews: new Map<string, AlertRowView>(),
    fxStates: new Map<string, AlertFxState>(),
    layoutMeasureRaf: null,
    resizeObserver: null,
  };

  section.append(customAlertModal);

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

  bindCustomAlertPrototypeModal(customAlertModal);

  section.querySelector<HTMLButtonElement>('[data-action="open-custom-alert-prototype"]')?.addEventListener('click', () => {
    openCustomAlertPrototypeModal();
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

    const reviewAlertId = Number(button.dataset.reviewAlertId || '0');
    if (Number.isInteger(reviewAlertId) && reviewAlertId > 0) {
      void alertsSectionView.controller.resolveAdminTokenReviewAlert(reviewAlertId, 'dismiss');
      return;
    }

    removeAlertRowImmediately(alertsSectionView, button);
    alertsSectionView.controller.removeAlert(alertId);
  });

  section.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-action="resolve-token-review-alert"]');
    if (!button || !alertsSectionView) {
      return;
    }

    const reviewAlertId = Number(button.dataset.alertId || '0');
    const resolution = button.dataset.resolution;
    if (!Number.isInteger(reviewAlertId) || reviewAlertId <= 0 || !isTokenReviewResolution(resolution)) {
      return;
    }
    if (resolution === 'block' && typeof window !== 'undefined' && !window.confirm('Block this token in the backend?')) {
      return;
    }
    void alertsSectionView.controller.resolveAdminTokenReviewAlert(reviewAlertId, resolution);
  });

  section.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-action="open-alert-chart"]');
    const alertId = String(button?.dataset.alertId || '').trim();
    const address = String(button?.dataset.address || '').trim();
    if (!button || !alertId || !address || !alertsSectionView) {
      return;
    }
    alertsSectionView.controller.openAlertExpandedSparkline(alertId, address);
  });

  section.addEventListener('toggle', (event) => {
    const panel = (event.target as HTMLElement | null)?.closest<HTMLDetailsElement>('.alert-ticker-peers-panel');
    if (!panel) {
      return;
    }
    if (!panel.open) {
      delete panel.dataset.positioned;
      return;
    }
    delete panel.dataset.positioned;
    closeOpenTickerPeerPanels(section, panel);
    positionTickerPeerPanel(panel);
  }, true);

  section.addEventListener('wheel', (event) => {
    isolateTickerPeerListWheel(event);
  }, { capture: true, passive: false });

  section.addEventListener('scroll', () => {
    positionOpenTickerPeerPanels(section);
  }, true);

  window.addEventListener('resize', () => {
    positionOpenTickerPeerPanels(section);
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

function closeOpenTickerPeerPanels(root: ParentNode, exceptPanel: HTMLDetailsElement | null = null) {
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('.alert-ticker-peers-panel[open]')) {
    if (panel !== exceptPanel) {
      delete panel.dataset.positioned;
      panel.open = false;
    }
  }
}

function positionOpenTickerPeerPanels(root: ParentNode) {
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('.alert-ticker-peers-panel[open]')) {
    positionTickerPeerPanel(panel);
  }
}

function positionTickerPeerPanel(panel: HTMLDetailsElement) {
  if (!panel.open || typeof window === 'undefined') {
    return;
  }

  const summary = panel.querySelector<HTMLElement>('summary');
  const list = panel.querySelector<HTMLElement>('.alert-ticker-peers-list');
  if (!summary || !list) {
    return;
  }

  const summaryRect = summary.getBoundingClientRect();
  const naturalHeight = Math.max(TICKER_PEERS_MIN_HEIGHT_PX, Math.min(list.scrollHeight, TICKER_PEERS_MAX_HEIGHT_PX));
  const spaceBelow = window.innerHeight - summaryRect.bottom - TICKER_PEERS_VIEWPORT_MARGIN_PX;
  const spaceAbove = summaryRect.top - TICKER_PEERS_VIEWPORT_MARGIN_PX;
  const placement = spaceBelow >= Math.min(naturalHeight, TICKER_PEERS_MIN_HEIGHT_PX) || spaceBelow >= spaceAbove
    ? 'bottom'
    : 'top';
  const availableHeight = Math.max(
    TICKER_PEERS_MIN_HEIGHT_PX,
    Math.floor((placement === 'bottom' ? spaceBelow : spaceAbove) - TICKER_PEERS_PANEL_GAP_PX),
  );
  const panelHeight = Math.min(naturalHeight, availableHeight);
  const panelWidth = Math.min(Math.max(list.scrollWidth, 280), 340);
  const left = Math.min(
    Math.max(TICKER_PEERS_VIEWPORT_MARGIN_PX, summaryRect.left),
    Math.max(TICKER_PEERS_VIEWPORT_MARGIN_PX, window.innerWidth - panelWidth - TICKER_PEERS_VIEWPORT_MARGIN_PX),
  );
  const top = placement === 'bottom'
    ? summaryRect.bottom + TICKER_PEERS_PANEL_GAP_PX
    : summaryRect.top - panelHeight - TICKER_PEERS_PANEL_GAP_PX;

  panel.dataset.placement = placement;
  list.style.setProperty('--ticker-peers-left', `${Math.round(left)}px`);
  list.style.setProperty('--ticker-peers-top', `${Math.max(TICKER_PEERS_VIEWPORT_MARGIN_PX, Math.round(top))}px`);
  list.style.setProperty('--ticker-peers-max-height', `${Math.round(panelHeight)}px`);
  panel.dataset.positioned = 'true';
}

function isolateTickerPeerListWheel(event: WheelEvent) {
  const list = (event.target as HTMLElement | null)
    ?.closest<HTMLElement>('.alert-ticker-peers-list');
  if (!list?.closest('.alert-ticker-peers-panel[open]')) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const deltaMultiplier = event.deltaMode === 1
    ? 16
    : event.deltaMode === 2
      ? list.clientHeight
      : 1;
  list.scrollTop += event.deltaY * deltaMultiplier;
  list.scrollLeft += event.deltaX * deltaMultiplier;
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

function buildCustomAlertPrototypeModal() {
  const modal = document.createElement('div');
  modal.className = 'custom-alert-prototype-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="custom-alert-prototype-backdrop" data-action="close-custom-alert-prototype"></div>
    <section class="custom-alert-prototype-dialog" role="dialog" aria-modal="true" aria-label="Custom alert prototype">
      <header class="custom-alert-prototype-header">
        <div>
          <span class="custom-alert-prototype-kicker">Custom rule</span>
          <h2>Custom Alert</h2>
        </div>
        <button type="button" class="alert-dismiss-button" data-action="close-custom-alert-prototype" aria-label="Close custom alert prototype">×</button>
      </header>
      <div class="custom-alert-prototype-grid">
        <div class="custom-alert-prototype-form">
          <div class="custom-alert-identity-grid">
            <label class="custom-alert-field">
              <span>Network</span>
              <select data-custom-alert-field="chain" aria-label="Custom alert network"></select>
            </label>
            <div class="custom-alert-field custom-alert-token-field">
              <span>Token</span>
              <div class="custom-alert-token-picker">
                <img class="custom-alert-token-image" data-custom-alert-token-image alt="" hidden>
                <input data-custom-alert-field="tokenQuery" type="text" placeholder="Ticker or contract address" autocomplete="off" spellcheck="false">
                <input data-custom-alert-field="token" type="hidden">
              </div>
              <div class="custom-alert-token-suggestions" data-custom-alert-token-suggestions hidden></div>
            </div>
          </div>
          <small class="custom-alert-capability-note" data-custom-alert-capability-note role="status"></small>
          <label class="custom-alert-field">
            <span>Alert name</span>
            <input data-custom-alert-field="title" type="text" value="Custom breakout" maxlength="48">
          </label>
          <div class="custom-alert-condition-grid">
            <label class="custom-alert-field">
              <span>Metric</span>
              <select data-custom-alert-field="metric"></select>
            </label>
            <label class="custom-alert-field">
              <span>Window</span>
              <select data-custom-alert-field="window" disabled>
                <option value="spot">Spot</option>
              </select>
            </label>
            <label class="custom-alert-field">
              <span>When it hits</span>
              <input data-custom-alert-field="target" type="text" value="$250k" maxlength="24" placeholder="$100k / $2m / $1b">
            </label>
            <label class="custom-alert-field">
              <span>Expires</span>
              <select data-custom-alert-field="expires">
                <option value="never">Never</option>
                <option value="1">1 hour</option>
                <option value="6">6 hours</option>
                <option value="12">12 hours</option>
                <option value="24">24 hours</option>
                <option value="72">3 days</option>
                <option value="168">7 days</option>
              </select>
            </label>
          </div>
          <div class="custom-alert-inline-grid">
            <div class="custom-alert-field custom-alert-sound-field">
              <span>Alert sound (optional)</span>
              <label class="custom-alert-file-button">
                Choose MP3
                <input data-custom-alert-field="soundFile" type="file" accept="audio/mpeg,.mp3">
              </label>
              <small data-custom-alert-sound-status>Default alert sound - MP3 up to 5 MB</small>
            </div>
            <div class="custom-alert-field">
              <span>Color</span>
              <div class="custom-alert-color-row">
                <button type="button" class="custom-alert-swatch" data-color="#22c55e" style="--swatch:#22c55e" aria-label="Green"></button>
                <button type="button" class="custom-alert-swatch" data-color="#2ea8ff" style="--swatch:#2ea8ff" aria-label="Blue"></button>
                <button type="button" class="custom-alert-swatch" data-color="#facc15" style="--swatch:#facc15" aria-label="Yellow"></button>
                <button type="button" class="custom-alert-swatch" data-color="#fb7185" style="--swatch:#fb7185" aria-label="Red"></button>
                <button type="button" class="custom-alert-swatch" data-color="#c084fc" style="--swatch:#c084fc" aria-label="Purple"></button>
                <input data-custom-alert-field="colorHex" type="color" value="#22c55e" aria-label="Custom alert color">
              </div>
            </div>
          </div>
        </div>
        <aside class="custom-alert-prototype-preview">
          <span class="custom-alert-prototype-kicker">Preview</span>
          <div data-custom-alert-preview></div>
        </aside>
      </div>
      <div class="custom-alert-rules-section">
        <span class="custom-alert-prototype-kicker">My alerts</span>
        <div class="custom-alert-rules-list" data-custom-alert-rules></div>
      </div>
      <footer class="custom-alert-prototype-footer">
        <button type="button" class="action-button small" data-action="close-custom-alert-prototype">Cancel</button>
        <button type="button" class="action-button small" data-action="test-custom-alert-prototype">Test Alert</button>
        <button type="button" class="action-button small" data-action="save-custom-alert-prototype">Save Alert</button>
      </footer>
    </section>
  `;
  return modal;
}

function openCustomAlertPrototypeModal() {
  if (!alertsSectionView) return;
  alertsSectionView.customAlertModal.hidden = false;
  syncCustomAlertCapabilityControls(alertsSectionView.customAlertModal);
  updateCustomAlertPrototypePreview();
  renderCustomAlertRulesList();
  void alertsSectionView.controller.loadCustomAlertRules();
  alertsSectionView.customAlertTokenInput.focus();
}

function closeCustomAlertPrototypeModal() {
  if (!alertsSectionView) return;
  const modal = alertsSectionView.customAlertModal;
  delete modal.dataset.savingCustomAlert;
  endCustomAlertRuleEdit(modal);
  modal.hidden = true;
}

function getCustomAlertSaveButton(modal: HTMLElement) {
  return modal.querySelector<HTMLButtonElement>('[data-action="save-custom-alert-prototype"]');
}

function getCustomAlertMetricLabel(metric: string) {
  if (metric === 'price') return 'Price USD';
  if (metric === 'fdv') return 'FDV USD';
  return 'Market Cap USD';
}

function getCustomAlertChainLabel(chain: TokenChain) {
  return chain === 'robinhood' ? 'Robinhood' : 'Solana';
}

function formatCustomAlertCapabilityReason(reason: string | null | undefined) {
  return String(reason || 'runtime_not_ready').replace(/_/g, ' ');
}

function buildCustomAlertOption(value: string, label: string) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function syncCustomAlertChainSelect(
  state: AppState,
  select: HTMLSelectElement,
  editingRule: CustomAlertRuleEntry | undefined,
) {
  const previousChain = editingRule?.chain || normalizeTokenChain(select.value)
    || state.ui.chainFilters.enabledChains.find((chain) => chain === 'solana' || chain === 'robinhood')
    || 'solana';
  const chains: TokenChain[] = state.data.availableChains.filter((chain) => chain === 'solana' || chain === 'robinhood');
  select.replaceChildren(...chains.map((chain) => buildCustomAlertOption(chain, getCustomAlertChainLabel(chain))));
  select.value = chains.includes(previousChain) ? previousChain : chains[0] || '';
  select.disabled = Boolean(editingRule);
  return normalizeTokenChain(select.value) || 'solana';
}

function syncCustomAlertMetricSelect(
  select: HTMLSelectElement,
  capability: CustomAlertCapabilityEntry | undefined,
  editingRule: CustomAlertRuleEntry | undefined,
) {
  const previousMetric = editingRule?.metric || select.value;
  select.replaceChildren(...(capability?.metrics || []).map((metric) => (
    buildCustomAlertOption(metric, getCustomAlertMetricLabel(metric))
  )));
  select.value = capability?.metrics.includes(previousMetric as 'price' | 'mcap' | 'fdv')
    ? previousMetric
    : capability?.metrics[0] || '';
}

function getCustomAlertCapabilityMessage(capability: CustomAlertCapabilityEntry | undefined) {
  if (!capability) return 'Loading custom-alert capabilities...';
  if (!capability.supported) return 'Custom alerts are unsupported for this network.';
  const supported = capability.metrics.map(getCustomAlertMetricLabel).join(' and ');
  const unsupported = (['price', 'mcap', 'fdv'] as const)
    .filter((metric) => !capability.metrics.includes(metric))
    .map(getCustomAlertMetricLabel)
    .join(' and ');
  const metricSummary = `${supported} supported${unsupported ? `; ${unsupported} unsupported` : ''}`;
  if (!capability.ready) {
    return `Temporarily unavailable: ${formatCustomAlertCapabilityReason(capability.reason)}. ${metricSummary}.`;
  }
  return `${getCustomAlertChainLabel(capability.chain)}: ${metricSummary} at Spot.`;
}

function syncCustomAlertAvailability(
  modal: HTMLElement,
  ready: boolean,
  editingRule: CustomAlertRuleEntry | undefined,
) {
  const tokenInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="tokenQuery"]');
  if (tokenInput) tokenInput.disabled = Boolean(editingRule);
  const unavailable = !ready || !readCustomAlertField('token');
  const saveButton = getCustomAlertSaveButton(modal);
  const testButton = modal.querySelector<HTMLButtonElement>('[data-action="test-custom-alert-prototype"]');
  if (saveButton) saveButton.disabled = unavailable || modal.dataset.savingCustomAlert === 'true';
  if (testButton) testButton.disabled = unavailable;
}

function syncCustomAlertCapabilityControls(modal: HTMLElement) {
  const state = alertsSectionView?.latestState;
  const chainSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="chain"]');
  const metricSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="metric"]');
  const windowSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="window"]');
  const note = modal.querySelector<HTMLElement>('[data-custom-alert-capability-note]');
  if (!state || !chainSelect || !metricSelect || !windowSelect || !note) return;
  const editingRule = state.data.customAlertRules.find((rule) => String(rule.id) === modal.dataset.editingRuleId);
  const chain = syncCustomAlertChainSelect(state, chainSelect, editingRule);
  const capability = state.data.customAlertCapabilities[chain];
  syncCustomAlertMetricSelect(metricSelect, capability, editingRule);
  windowSelect.value = capability?.windows.includes('spot') ? 'spot' : '';
  const ready = capability?.supported === true && capability.ready === true;
  note.classList.toggle('unavailable', !ready);
  note.textContent = getCustomAlertCapabilityMessage(capability);
  metricSelect.disabled = !ready || Boolean(editingRule && editingRule.status === 'triggered');
  syncCustomAlertAvailability(modal, ready, editingRule);
}

function endCustomAlertRuleEdit(modal: HTMLElement) {
  delete modal.dataset.editingRuleId;
  const saveButton = getCustomAlertSaveButton(modal);
  if (saveButton) saveButton.textContent = 'Save Alert';
  const expiresSelect = getCustomAlertExpiresSelect(modal);
  if (expiresSelect) removeCustomAlertKeepExpiryOption(expiresSelect);
  const tokenInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="tokenQuery"]');
  if (tokenInput) tokenInput.disabled = false;
}

function formatCustomAlertRuleTarget(rule: CustomAlertRuleEntry) {
  if (rule.metric === 'price') {
    return `$${rule.targetValue}`;
  }
  return formatCustomAlertCompactMoney(rule.targetValue);
}

function describeCustomAlertRuleCondition(rule: CustomAlertRuleEntry) {
  return `${getCustomAlertMetricLabel(rule.metric)} hits ${formatCustomAlertRuleTarget(rule)}`;
}

function fillCustomAlertEditToken(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  const { queryInput, hiddenInput, image } = getCustomAlertTokenElements(modal);
  const candidate = getCustomAlertTokenCandidate(rule.chain, rule.tokenAddress);
  const chainSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="chain"]');
  if (chainSelect) chainSelect.value = rule.chain;
  if (hiddenInput) hiddenInput.value = rule.tokenAddress;
  if (queryInput) queryInput.value = candidate?.symbol || rule.tokenAddress;
  setCustomAlertTokenImage(image, candidate?.imageUrl ?? null);
  hideCustomAlertTokenSuggestions(modal);
  return queryInput;
}

function fillCustomAlertEditFields(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  const titleInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="title"]');
  if (titleInput) titleInput.value = rule.title;

  const metricSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="metric"]');
  if (metricSelect) metricSelect.value = rule.metric;

  const targetInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="target"]');
  if (targetInput) {
    targetInput.dataset.targetMode = rule.metric === 'price' ? 'price' : 'valuation';
    targetInput.value = formatCustomAlertRuleTarget(rule);
  }

  const colorInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="colorHex"]');
  if (colorInput) colorInput.value = normalizeCustomAlertColor(rule.colorHex);
}

function fillCustomAlertEditExpiry(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  const expiresSelect = getCustomAlertExpiresSelect(modal);
  if (!expiresSelect) return;
  removeCustomAlertKeepExpiryOption(expiresSelect);
  if (rule.expiresAt && !isCustomAlertRuleExpired(rule)) {
    const keep = document.createElement('option');
    keep.value = 'keep';
    keep.textContent = `Keep (until ${formatCustomAlertExpiryDate(rule.expiresAt)})`;
    expiresSelect.prepend(keep);
    expiresSelect.value = 'keep';
  } else {
    expiresSelect.value = 'never';
  }
}

function fillCustomAlertEditSound(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  const soundInput = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="soundFile"]');
  if (soundInput) soundInput.value = '';
  customAlertSoundAssets.delete(modal);
  setCustomAlertSoundStatus(modal, rule.soundName ? `Keeps ${rule.soundName} unless you pick a new MP3` : 'Default alert sound - MP3 up to 5 MB');
}

function beginCustomAlertRuleEdit(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  modal.dataset.editingRuleId = String(rule.id);
  syncCustomAlertCapabilityControls(modal);
  const queryInput = fillCustomAlertEditToken(modal, rule);
  fillCustomAlertEditFields(modal, rule);
  fillCustomAlertEditExpiry(modal, rule);
  fillCustomAlertEditSound(modal, rule);
  syncCustomAlertCapabilityControls(modal);

  const saveButton = getCustomAlertSaveButton(modal);
  if (saveButton) saveButton.textContent = 'Update Alert';
  updateCustomAlertPrototypePreview();
  queryInput?.focus();
}

function buildCustomAlertRuleRow(modal: HTMLElement, rule: CustomAlertRuleEntry) {
  const row = document.createElement('div');
  row.className = 'custom-alert-rule-row';
  row.style.setProperty('--custom-alert-color', normalizeCustomAlertColor(rule.colorHex));

  const image = document.createElement('img');
  image.alt = '';
  setCustomAlertTokenImage(image, getCustomAlertTokenCandidate(rule.chain, rule.tokenAddress)?.imageUrl ?? null);

  const main = document.createElement('div');
  main.className = 'custom-alert-rule-main';
  const title = document.createElement('strong');
  const symbol = getCustomAlertTokenCandidate(rule.chain, rule.tokenAddress)?.symbol || `${rule.tokenAddress.slice(0, 4)}...${rule.tokenAddress.slice(-4)}`;
  title.textContent = `${symbol} - ${rule.title}`;
  const condition = document.createElement('small');
  const expired = isCustomAlertRuleExpired(rule);
  const expirySuffix = rule.expiresAt && !expired ? ` · expires ${formatCustomAlertExpiryDate(rule.expiresAt)}` : '';
  condition.textContent = `${getCustomAlertChainLabel(rule.chain)} · ${describeCustomAlertRuleCondition(rule)}${expirySuffix}`;
  main.append(title, condition);

  const status = document.createElement('span');
  status.className = `custom-alert-rule-status ${expired ? 'expired' : rule.status}`;
  status.textContent = expired ? 'EXPIRED' : rule.status === 'triggered' ? 'TRIGGERED' : 'ACTIVE';

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'action-button small';
  editButton.textContent = 'Edit';
  editButton.addEventListener('click', () => beginCustomAlertRuleEdit(modal, rule));

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'action-button small custom-alert-rule-cancel';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    cancelButton.disabled = true;
    // disableCustomAlert removes the rule from state synchronously before the API
    // call; re-rendering the modal list right away makes the row vanish instantly
    // instead of waiting for the app render queue (which defers during pointer
    // interaction).
    const request = alertsSectionView?.controller.disableCustomAlert(rule.id);
    renderCustomAlertRulesList();
    void request
      ?.then(() => showCustomAlertToast('Custom alert canceled.'))
      .catch((error) => {
        renderCustomAlertRulesList();
        showCustomAlertToast(getCustomAlertToastError(error, 'Failed to cancel custom alert.'), 'error');
      });
  });

  row.append(image, main, status, editButton, cancelButton);
  return row;
}

function renderCustomAlertRulesList() {
  const view = alertsSectionView;
  if (!view) return;
  const list = view.customAlertModal.querySelector<HTMLElement>('[data-custom-alert-rules]');
  if (!list) return;
  const rules = view.latestState?.data.customAlertRules ?? [];
  if (!rules.length) {
    list.replaceChildren();
    const empty = document.createElement('small');
    empty.className = 'custom-alert-rules-empty';
    empty.textContent = 'No custom alerts yet. Saved alerts show up here.';
    list.append(empty);
    return;
  }
  list.replaceChildren(...rules.map((rule) => buildCustomAlertRuleRow(view.customAlertModal, rule)));
}

const CUSTOM_ALERT_TOAST_MS = 2_600;
const CUSTOM_ALERT_ERROR_TOAST_MS = 4_200;

function showCustomAlertToast(message: string, tone: 'success' | 'error' = 'success') {
  if (typeof document === 'undefined') return;
  const durationMs = tone === 'error' ? CUSTOM_ALERT_ERROR_TOAST_MS : CUSTOM_ALERT_TOAST_MS;
  const toast = document.createElement('div');
  toast.className = `custom-alert-toast${tone === 'error' ? ' error' : ''}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.classList.add('fade-out'), durationMs - 400);
  window.setTimeout(() => toast.remove(), durationMs);
}

function getCustomAlertToastError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function parseCustomAlertTargetText(text: string) {
  const clean = String(text || '').trim().replace(/[$,\s]/g, '');
  const shorthand = /^(\d+(?:\.\d+)?)([kmb])$/i.exec(clean);
  const multipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
  const parsed = shorthand
    ? Number(shorthand[1]) * multipliers[shorthand[2].toLowerCase()]
    : Number(clean);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCustomAlertCompactMoney(value: number) {
  const units = [
    { limit: 1e9, suffix: 'b' },
    { limit: 1e6, suffix: 'm' },
    { limit: 1e3, suffix: 'k' },
  ];
  for (const { limit, suffix } of units) {
    if (value >= limit) {
      const scaled = value / limit;
      return `$${Number(scaled.toFixed(scaled >= 100 ? 0 : 2))}${suffix}`;
    }
  }
  return `$${Number(value.toFixed(6))}`;
}

function reformatCustomAlertTargetInput(modal: HTMLElement) {
  const target = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="target"]');
  if (!target) return;
  const value = parseCustomAlertTargetText(target.value);
  if (value == null) return;
  const isPrice = readCustomAlertField('metric') === 'price';
  target.value = isPrice ? `$${value}` : formatCustomAlertCompactMoney(value);
}

function resetCustomAlertTokenPicker(modal: HTMLElement) {
  const { queryInput, hiddenInput, image } = getCustomAlertTokenElements(modal);
  if (queryInput) queryInput.value = '';
  if (hiddenInput) hiddenInput.value = '';
  setCustomAlertTokenImage(image, null);
  hideCustomAlertTokenSuggestions(modal);
}

function resolveCustomAlertTokenSelection(modal: HTMLElement) {
  const { queryInput, hiddenInput, image } = getCustomAlertTokenElements(modal);
  if (!queryInput || !hiddenInput || hiddenInput.value) return;
  const raw = queryInput.value.trim();
  if (!raw) return;
  const chain = normalizeTokenChain(readCustomAlertField('chain')) || 'solana';

  if (isCustomAlertTokenAddress(raw, chain)) {
    hiddenInput.value = raw;
    setCustomAlertTokenImage(image, getCustomAlertTokenCandidate(chain, raw)?.imageUrl ?? null);
    hideCustomAlertTokenSuggestions(modal);
    syncCustomAlertCapabilityControls(modal);
    return;
  }

  const matches = filterCustomAlertTokenCandidates(raw, chain);
  const exact = matches.find((candidate) => candidate.symbol.toLowerCase() === raw.toLowerCase());
  const candidate = exact || (matches.length === 1 ? matches[0] : null);
  if (candidate) {
    selectCustomAlertToken(modal, candidate);
  }
}

function bindCustomAlertPrototypeModal(modal: HTMLElement) {
  bindCustomAlertTokenPicker(modal);
  modal.addEventListener('input', updateCustomAlertPrototypePreview);
  modal.addEventListener('change', updateCustomAlertPrototypePreview);
  modal.querySelector<HTMLInputElement>('[data-custom-alert-field="target"]')?.addEventListener('change', () => {
    reformatCustomAlertTargetInput(modal);
  });
  modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="chain"]')?.addEventListener('change', () => {
    resetCustomAlertTokenPicker(modal);
    syncCustomAlertCapabilityControls(modal);
  });
  modal.querySelector<HTMLInputElement>('[data-custom-alert-field="soundFile"]')?.addEventListener('change', (event) => {
    readCustomAlertSoundFile(modal, event.currentTarget as HTMLInputElement);
  });
  modal.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const colorButton = target?.closest<HTMLButtonElement>('.custom-alert-swatch');
    if (colorButton) {
      const input = modal.querySelector<HTMLInputElement>('[data-custom-alert-field="colorHex"]');
      if (input && colorButton.dataset.color) {
        input.value = colorButton.dataset.color;
        updateCustomAlertPrototypePreview();
      }
      return;
    }

    if (target?.closest('[data-action="close-custom-alert-prototype"]')) {
      closeCustomAlertPrototypeModal();
      return;
    }

    if (target?.closest('[data-action="test-custom-alert-prototype"]')) {
      handleCustomAlertTestClick();
    }

    if (target?.closest('[data-action="save-custom-alert-prototype"]')) {
      handleCustomAlertSaveClick(modal);
    }
  });
}

function handleCustomAlertTestClick() {
  const payload = readCustomAlertPrototypeInput();
  if (!payload) {
    showCustomAlertToast('Pick a token from the suggestions or paste its contract address.', 'error');
    return;
  }
  alertsSectionView?.controller.previewCustomAlert(payload);
  closeCustomAlertPrototypeModal();
}

function handleCustomAlertSaveClick(modal: HTMLElement) {
  if (modal.dataset.savingCustomAlert === 'true') return;
  const payload = readCustomAlertPrototypeInput();
  if (!payload) {
    showCustomAlertToast('Pick a token from the suggestions or paste its contract address.', 'error');
    return;
  }
  const saveButton = getCustomAlertSaveButton(modal);
  const editingRuleId = Number(modal.dataset.editingRuleId);
  const isEditing = Number.isFinite(editingRuleId) && editingRuleId > 0;
  modal.dataset.savingCustomAlert = 'true';
  if (saveButton) saveButton.disabled = true;
  const request = isEditing
    ? alertsSectionView?.controller.updateCustomAlert(editingRuleId, payload)
    : alertsSectionView?.controller.createCustomAlert(payload);
  void request
    ?.then(() => {
      closeCustomAlertPrototypeModal();
      resetCustomAlertTokenPicker(modal);
      updateCustomAlertPrototypePreview();
      showCustomAlertToast(isEditing ? 'Custom alert updated.' : 'Custom alert saved.');
    })
    .catch((error) => {
      delete modal.dataset.savingCustomAlert;
      showCustomAlertToast(getCustomAlertToastError(error, isEditing ? 'Failed to update custom alert.' : 'Failed to save custom alert.'), 'error');
    })
    .finally(() => {
      syncCustomAlertCapabilityControls(modal);
    });
}

type CustomAlertTokenCandidate = {
  chain: TokenChain;
  identityKey: string;
  address: string;
  symbol: string;
  valuation: number | null;
  imageUrl: string | null;
};

function addTrackedCustomAlertCandidate(
  state: AppState,
  candidates: Map<string, CustomAlertTokenCandidate>,
  token: ManualTokenEntry,
) {
  const chain = normalizeTokenChain(token.chain) || 'solana';
  if (state.data.customAlertCapabilities[chain]?.supported !== true) return;
  const identity = createLegacyCompatibleTokenIdentity(chain, token.address);
  candidates.set(identity.key, {
    chain,
    identityKey: identity.key,
    address: identity.address,
    symbol: String(token.symbol || token.label || identity.address.slice(0, 6)).trim(),
    valuation: chain === 'robinhood' ? token.fdv ?? null : token.mcap ?? null,
    imageUrl: token.imageUrl ?? null,
  });
}

function addPumpCustomAlertCandidates(
  state: AppState,
  candidates: Map<string, CustomAlertTokenCandidate>,
) {
  if (state.data.customAlertCapabilities.solana?.supported !== true) return;
  for (const token of state.data.pumpTokens) {
    const address = String(token.mint || token.mintAddress || '').trim();
    if (!address) continue;
    const identity = createLegacyCompatibleTokenIdentity('solana', address);
    if (candidates.has(identity.key)) continue;
    candidates.set(identity.key, {
      chain: 'solana',
      identityKey: identity.key,
      address: identity.address,
      symbol: String(token.symbol || identity.address.slice(0, 6)).trim(),
      valuation: token.mcap ?? null,
      imageUrl: token.imageUrl ?? null,
    });
  }
}

function buildCustomAlertTokenCandidates(state: AppState): CustomAlertTokenCandidate[] {
  const candidates = new Map<string, CustomAlertTokenCandidate>();
  const trackedTokens = [
    ...getMonitoredTokens(state),
    ...getManualTokens(state),
    ...getRecentTokens(state),
    ...getOldWeekTokens(state),
  ];
  trackedTokens.forEach((token) => addTrackedCustomAlertCandidate(state, candidates, token));
  addPumpCustomAlertCandidates(state, candidates);
  return [...candidates.values()];
}

function isCustomAlertTokenAddress(value: string, chain: TokenChain) {
  return chain === 'robinhood'
    ? /^0x[0-9a-fA-F]{40}$/.test(value)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function sanitizeCustomAlertImageUrl(value: string | null | undefined) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function getCustomAlertTokenCandidate(chain: TokenChain, address: string): CustomAlertTokenCandidate | null {
  const state = alertsSectionView?.latestState;
  if (!state) return null;
  const identity = createLegacyCompatibleTokenIdentity(chain, address);
  return buildCustomAlertTokenCandidates(state).find((candidate) => candidate.identityKey === identity.key) || null;
}

function filterCustomAlertTokenCandidates(query: string, chain: TokenChain) {
  const state = alertsSectionView?.latestState;
  const normalized = query.trim().toLowerCase();
  if (!state || !normalized) return [];
  return buildCustomAlertTokenCandidates(state)
    .filter((candidate) => candidate.chain === chain)
    .filter((candidate) => candidate.symbol.toLowerCase().includes(normalized) || candidate.address.toLowerCase().startsWith(normalized))
    .slice(0, 8);
}

function getCustomAlertTokenElements(modal: HTMLElement) {
  return {
    queryInput: modal.querySelector<HTMLInputElement>('[data-custom-alert-field="tokenQuery"]'),
    hiddenInput: modal.querySelector<HTMLInputElement>('[data-custom-alert-field="token"]'),
    suggestions: modal.querySelector<HTMLElement>('[data-custom-alert-token-suggestions]'),
    image: modal.querySelector<HTMLImageElement>('[data-custom-alert-token-image]'),
  };
}

function setCustomAlertTokenImage(image: HTMLImageElement | null, imageUrl: string | null | undefined) {
  if (!image) return;
  const url = sanitizeCustomAlertImageUrl(imageUrl);
  if (!url) {
    image.hidden = true;
    image.removeAttribute('src');
    return;
  }
  image.hidden = false;
  image.src = url;
  image.onerror = () => {
    image.hidden = true;
  };
}

function hideCustomAlertTokenSuggestions(modal: HTMLElement) {
  const { suggestions } = getCustomAlertTokenElements(modal);
  if (suggestions) {
    suggestions.hidden = true;
    suggestions.replaceChildren();
  }
}

function selectCustomAlertToken(modal: HTMLElement, candidate: CustomAlertTokenCandidate) {
  const { queryInput, hiddenInput, image } = getCustomAlertTokenElements(modal);
  if (!queryInput || !hiddenInput) return;
  const chainSelect = modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="chain"]');
  if (chainSelect) chainSelect.value = candidate.chain;
  hiddenInput.value = candidate.address;
  queryInput.value = candidate.symbol || candidate.address;
  setCustomAlertTokenImage(image, candidate.imageUrl);
  hideCustomAlertTokenSuggestions(modal);
  syncCustomAlertCapabilityControls(modal);
  updateCustomAlertPrototypePreview();
}

function buildCustomAlertTokenSuggestionRow(modal: HTMLElement, candidate: CustomAlertTokenCandidate) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'custom-alert-token-suggestion';

  const image = document.createElement('img');
  image.alt = '';
  setCustomAlertTokenImage(image, candidate.imageUrl);

  const symbol = document.createElement('strong');
  symbol.textContent = candidate.symbol;
  const mcap = document.createElement('span');
  mcap.textContent = `${candidate.chain === 'robinhood' ? 'FDV' : 'MCAP'} ${fmtMoney(candidate.valuation)}`;
  const addr = document.createElement('small');
  addr.textContent = `${getCustomAlertChainLabel(candidate.chain)} · ${candidate.address.slice(0, 4)}...${candidate.address.slice(-4)}`;

  row.append(image, symbol, mcap, addr);
  row.addEventListener('mousedown', (event) => {
    event.preventDefault();
    selectCustomAlertToken(modal, candidate);
  });
  return row;
}

function renderCustomAlertTokenSuggestions(modal: HTMLElement, query: string) {
  const { suggestions } = getCustomAlertTokenElements(modal);
  if (!suggestions) return;
  const chain = normalizeTokenChain(readCustomAlertField('chain')) || 'solana';
  const matches = filterCustomAlertTokenCandidates(query, chain);
  if (!matches.length) {
    hideCustomAlertTokenSuggestions(modal);
    return;
  }
  suggestions.replaceChildren(...matches.map((candidate) => buildCustomAlertTokenSuggestionRow(modal, candidate)));
  suggestions.hidden = false;
}

function handleCustomAlertTokenQueryInput(modal: HTMLElement) {
  const { queryInput, hiddenInput, image } = getCustomAlertTokenElements(modal);
  if (!queryInput || !hiddenInput) return;
  const raw = queryInput.value.trim();

  const chain = normalizeTokenChain(readCustomAlertField('chain')) || 'solana';
  if (isCustomAlertTokenAddress(raw, chain)) {
    const known = getCustomAlertTokenCandidate(chain, raw);
    hiddenInput.value = raw;
    setCustomAlertTokenImage(image, known?.imageUrl ?? null);
    hideCustomAlertTokenSuggestions(modal);
    syncCustomAlertCapabilityControls(modal);
    return;
  }

  hiddenInput.value = '';
  setCustomAlertTokenImage(image, null);
  renderCustomAlertTokenSuggestions(modal, raw);
  syncCustomAlertCapabilityControls(modal);
}

function bindCustomAlertTokenPicker(modal: HTMLElement) {
  const { queryInput } = getCustomAlertTokenElements(modal);
  if (!queryInput) return;

  queryInput.addEventListener('input', () => {
    handleCustomAlertTokenQueryInput(modal);
  });
  queryInput.addEventListener('focus', () => {
    const { hiddenInput } = getCustomAlertTokenElements(modal);
    if (!hiddenInput?.value) {
      renderCustomAlertTokenSuggestions(modal, queryInput.value.trim());
    }
  });
  queryInput.addEventListener('blur', () => {
    window.setTimeout(() => hideCustomAlertTokenSuggestions(modal), 120);
  });
}

function readCustomAlertField(name: string) {
  const field = alertsSectionView?.customAlertModal.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-custom-alert-field="${name}"]`);
  return String(field?.value || '').trim();
}

function readCustomAlertFieldOr(name: string, fallback: string) {
  return readCustomAlertField(name) || fallback;
}

function readCustomAlertFilters() {
  return 'none';
}

function setCustomAlertSoundStatus(modal: HTMLElement, message: string) {
  const status = modal.querySelector<HTMLElement>('[data-custom-alert-sound-status]');
  if (status) {
    status.textContent = message;
  }
}

function resetCustomAlertSound(modal: HTMLElement, input: HTMLInputElement, message: string) {
  input.value = '';
  customAlertSoundAssets.delete(modal);
  setCustomAlertSoundStatus(modal, message);
  updateCustomAlertPrototypePreview();
}

function isCustomAlertMp3(file: File) {
  return file.type === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3');
}

function readCustomAlertSoundFile(modal: HTMLElement, input: HTMLInputElement) {
  const file = input.files?.[0] || null;
  if (!file) {
    resetCustomAlertSound(modal, input, 'Default alert sound - MP3 up to 5 MB');
    return;
  }

  if (!isCustomAlertMp3(file)) {
    resetCustomAlertSound(modal, input, 'Use an MP3 file.');
    return;
  }

  if (file.size > CUSTOM_ALERT_SOUND_MAX_BYTES) {
    resetCustomAlertSound(modal, input, 'MP3 must be 5 MB or smaller.');
    return;
  }

  setCustomAlertSoundStatus(modal, `Loading ${file.name}...`);
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl.startsWith('data:audio/')) {
      resetCustomAlertSound(modal, input, 'Could not read this MP3.');
      return;
    }

    customAlertSoundAssets.set(modal, { name: file.name, dataUrl });
    setCustomAlertSoundStatus(modal, `Using ${file.name}`);
    updateCustomAlertPrototypePreview();
  });
  reader.addEventListener('error', () => {
    resetCustomAlertSound(modal, input, 'Could not read this MP3.');
  });
  reader.readAsDataURL(file);
}

function syncCustomAlertTargetMetric() {
  const modal = alertsSectionView?.customAlertModal;
  const target = modal?.querySelector<HTMLInputElement>('[data-custom-alert-field="target"]');
  if (!target) return;
  const priceMode = readCustomAlertField('metric') === 'price';
  const nextMode = priceMode ? 'price' : 'valuation';
  const previousMode = target.dataset.targetMode;
  if (previousMode === 'price') target.dataset.priceValue = target.value;
  if (previousMode === 'valuation') target.dataset.valuationValue = target.value;
  if (target.dataset.targetMode !== nextMode) {
    target.value = priceMode
      ? target.dataset.priceValue || '$0.0001'
      : target.dataset.valuationValue || '$250k';
    target.dataset.targetMode = nextMode;
  }
}

function readCustomAlertPrototypeInput() {
  if (!alertsSectionView) return null;
  resolveCustomAlertTokenSelection(alertsSectionView.customAlertModal);
  syncCustomAlertTargetMetric();
  const tokenAddress = readCustomAlertField('token');
  const chain = normalizeTokenChain(readCustomAlertField('chain'));
  if (!tokenAddress || !chain || !isCustomAlertTokenAddress(tokenAddress, chain)) return null;
  const sound = customAlertSoundAssets.get(alertsSectionView.customAlertModal) || null;
  return {
    chain,
    tokenAddress,
    title: readCustomAlertFieldOr('title', 'Custom alert'),
    metric: readCustomAlertField('metric'),
    window: 'spot' as const,
    operator: 'hits',
    target: readCustomAlertFieldOr('target', '$250k'),
    repeatMode: 'trigger once',
    expires: readCustomAlertFieldOr('expires', 'never'),
    colorHex: normalizeCustomAlertColor(readCustomAlertField('colorHex')),
    filters: readCustomAlertFilters(),
    soundName: sound?.name || null,
    soundDataUrl: sound?.dataUrl || null,
  };
}

function updateCustomAlertPrototypePreview() {
  const input = readCustomAlertPrototypeInput();
  const preview = alertsSectionView?.customAlertPreview;
  if (!preview) return;
  if (!input) {
    preview.textContent = 'Load or pick a token to preview this alert.';
    return;
  }
  const candidate = getCustomAlertTokenCandidate(input.chain || 'solana', input.tokenAddress);
  const symbol = candidate?.symbol || input.tokenAddress.slice(0, 8);
  preview.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'custom-alert-preview-card';
  card.style.setProperty('--custom-alert-color', input.colorHex);
  const titleRow = document.createElement('div');
  titleRow.className = 'custom-alert-preview-title';
  const tokenImage = document.createElement('img');
  tokenImage.alt = '';
  setCustomAlertTokenImage(tokenImage, candidate?.imageUrl ?? null);
  const title = document.createElement('strong');
  title.textContent = input.title;
  titleRow.append(tokenImage, title);
  const condition = document.createElement('div');
  condition.textContent = `${getCustomAlertChainLabel(input.chain || 'solana')} · ${symbol}: ${getCustomAlertMetricLabel(input.metric)} ${input.operator} ${input.target}`;
  const behavior = document.createElement('small');
  behavior.textContent = `${input.repeatMode} / expires ${getCustomAlertExpiresLabel(input.expires)}`;
  const filters = document.createElement('small');
  filters.textContent = `${input.filters} / sound ${input.soundName || 'default'}`;
  card.append(titleRow, condition, behavior, filters);
  preview.append(card);
}

function getCustomAlertExpiresSelect(modal: HTMLElement) {
  return modal.querySelector<HTMLSelectElement>('[data-custom-alert-field="expires"]');
}

function getCustomAlertExpiresLabel(value: string) {
  const select = alertsSectionView ? getCustomAlertExpiresSelect(alertsSectionView.customAlertModal) : null;
  const option = select ? Array.from(select.options).find((item) => item.value === value) : null;
  return (option?.textContent || value || 'never').toLowerCase();
}

function removeCustomAlertKeepExpiryOption(select: HTMLSelectElement) {
  const keep = Array.from(select.options).find((option) => option.value === 'keep');
  if (keep) {
    if (select.value === 'keep') select.value = 'never';
    keep.remove();
  }
}

function formatCustomAlertExpiryDate(expiresAt: string) {
  return new Date(expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isCustomAlertRuleExpired(rule: CustomAlertRuleEntry, now = Date.now()) {
  return Boolean(rule.expiresAt && new Date(rule.expiresAt).getTime() <= now);
}

function normalizeCustomAlertColor(value: string | null | undefined) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : '#22c55e';
}

function buildPinnedAdminReviewAlerts(state: AppState): AlertEntry[] {
  if (state.session.role !== 'admin' || state.data.adminTokenReviewAlerts.length === 0) {
    return [];
  }

  const reviewAlerts = state.data.adminTokenReviewAlerts
    .filter((alert) => String(alert.status || 'open').toLowerCase() === 'open')
    .map(buildAdminReviewAlertEntry)
    .filter((alert): alert is AlertEntry => Boolean(
      alert && isChainSelectedForSurface(state, 'alertFeedChains', alert.chain),
    ));

  return reviewAlerts;
}

function buildAdminReviewAlertEntry(review: AdminTokenReviewAlertEntry): AlertEntry | null {
  const address = String(review.tokenAddress || '').trim();
  if (!address) {
    return null;
  }

  const snapshots = getAdminReviewSnapshots(review);
  const identity = getAdminReviewIdentity(review, address, snapshots.assessment, snapshots.market);
  const socialFields = getAdminReviewSocialFields(snapshots.social);
  const createdAt = parseReviewTimestamp(review.createdAt) ?? parseReviewTimestamp(review.updatedAt) ?? Date.now();

  return {
    id: `admin-review:${review.id}`,
    chain: review.chain || 'solana',
    kind: 'admin-token-review',
    address,
    ...identity,
    ...socialFields,
    reviewAlertId: review.id,
    reviewPriority: review.priority,
    reviewReasons: Array.isArray(review.reasonCodes) ? review.reasonCodes : [],
    reviewTop10Pct: getRecordNumber(snapshots.risk, 'top10Pct'),
    reviewTop20Pct: getRecordNumber(snapshots.risk, 'top20Pct'),
    createdAt,
    pct: 0,
    label: String(review.label || review.alertKind || 'MANUAL REVIEW'),
  } satisfies AlertEntry;
}

function getAdminReviewSnapshots(review: AdminTokenReviewAlertEntry) {
  return {
    social: review.socialSnapshot || {},
    market: review.marketSnapshot || {},
    risk: review.riskSnapshot || {},
    assessment: review.assessment || {},
  };
}

function getAdminReviewIdentity(
  review: AdminTokenReviewAlertEntry,
  address: string,
  assessment: Record<string, unknown>,
  market: Record<string, unknown>,
) {
  return {
    symbol: getRecordString(assessment, 'symbol') || getRecordString(market, 'symbol') || address.slice(0, 6),
    name: getRecordString(assessment, 'name') || String(review.label || review.alertKind || 'Manual review'),
    mcap: getRecordNumber(market, 'mcap') ?? getRecordNumber(market, 'marketCap') ?? getRecordNumber(assessment, 'marketCap'),
    volume24h: getRecordNumber(market, 'vol24h') ?? getRecordNumber(market, 'volume24h'),
  };
}

function getAdminReviewSocialFields(social: Record<string, unknown>) {
  return {
    pairAddress: getRecordString(social, 'pairAddress'),
    pairUrl: getRecordString(social, 'pairUrl'),
    imageUrl: getRecordString(social, 'imageUrl'),
    twitterUrl: getRecordString(social, 'twitterUrl'),
    communityUrl: getRecordString(social, 'communityUrl'),
    reviewWebsiteUrl: getRecordString(social, 'websiteUrl'),
  };
}

function parseReviewTimestamp(value: string | null | undefined) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getRecordString(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getRecordNumber(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatReviewPct(value?: number | null) {
  return value != null && Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

function isTokenReviewResolution(value: string | undefined): value is 'dismiss' | 'block' | 'mark_valid' | 'mark_weak' {
  return value === 'dismiss' || value === 'block' || value === 'mark_valid' || value === 'mark_weak';
}

function filterAlerts(alerts: AlertEntry[], searchQuery: string) {
  const normalizedQuery = String(searchQuery || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return alerts;
  }

  return alerts.filter((alert) => {
    const symbol = String(alert.symbol || '').toLowerCase();
    const name = String(alert.name || '').toLowerCase();
    const address = String(alert.address || '').toLowerCase();
    const customTitle = String(alert.customTitle || '').toLowerCase();
    const reasons = (alert.reviewReasons || []).join(' ').toLowerCase();
    return symbol.includes(normalizedQuery) || name.includes(normalizedQuery) || address.includes(normalizedQuery) || customTitle.includes(normalizedQuery) || reasons.includes(normalizedQuery);
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
  visibleAlerts: AlertEntry[],
  state: AppState,
  renderNow: number,
  cardEffectsEnabled: boolean,
) {
  const liveAlertIds = new Set(visibleAlerts.map((alert) => alert.id));
  const desiredNodes: HTMLElement[] = [];
  const pendingEnterFx: Array<{ row: HTMLElement; fxState: AlertFxState }> = [];

  for (const alert of filteredAlerts) {
    const fxState = getOrCreateAlertFxState(view, alert, renderNow);
    const isStarred = isTokenStarred(state, alert.address, alert.chain);
    const sparkline = state.data.alertSparklineById[alert.id] || null;
    const enabledTradeTerminals = alert.chain === 'robinhood'
      ? state.ui.enabledRobinhoodTradeTerminals
      : state.ui.enabledTradeTerminals;
    const renderKey = getAlertRowRenderKey(
      alert,
      state.ui.busy,
      isStarred,
      state.session.role === 'admin',
      enabledTradeTerminals,
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
        enabledTradeTerminals,
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
  if (isHvncAlert(alert) || alert.kind === 'meteora-surge' || alert.kind === 'gmgn-claim-signal' || alert.isOldSurge) {
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
    prevFdv: alert.prevFdv,
    mcap: alert.mcap,
    fdv: alert.fdv,
    valuationType: alert.valuationType,
    tokenCreatedAt: alert.tokenCreatedAt,
    imageUrl: alert.imageUrl,
    pairUrl: alert.pairUrl,
    twitterUrl: alert.twitterUrl,
    isHvnc: alert.isHvnc,
    isOldSurge: alert.isOldSurge,
    surgeWindow: alert.surgeWindow,
    meteoraCurrentTvl: alert.meteoraCurrentTvl,
    meteoraBaselineTvl24h: alert.meteoraBaselineTvl24h,
    reviewAlertId: alert.reviewAlertId,
    reviewPriority: alert.reviewPriority,
    reviewReasons: alert.reviewReasons,
    reviewWebsiteUrl: alert.reviewWebsiteUrl,
    reviewTop10Pct: alert.reviewTop10Pct,
    reviewTop20Pct: alert.reviewTop20Pct,
    customColorHex: alert.customColorHex,
    customTitle: alert.customTitle,
    customMetric: alert.customMetric,
    customOperator: alert.customOperator,
    customTarget: alert.customTarget,
    customRepeatMode: alert.customRepeatMode,
    customExpires: alert.customExpires,
    customFilters: alert.customFilters,
    customSoundName: alert.customSoundName,
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

function resolveAlertMarketLink(alert: Pick<AlertEntry, 'chain' | 'address' | 'pairUrl'>) {
  const marketUrl = buildTokenMarketUrl(alert.chain, alert.address, alert.pairUrl);
  return {
    label: marketUrl ? 'Market' : 'Explorer',
    url: sanitizeHttpUrl(marketUrl || buildTokenExplorerUrl(alert.chain, alert.address)),
  };
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
  const customColor = alert.kind === 'custom-alert' ? normalizeCustomAlertColor(alert.customColorHex) : null;
  article.style.setProperty('--alert-fx-color', customColor || getAlertAccentColor(toneClass));
  if (customColor) {
    article.style.setProperty('--custom-alert-color', customColor);
  } else {
    article.style.removeProperty('--custom-alert-color');
  }
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
  const marketLink = resolveAlertMarketLink(alert);
  const symbol = String(alert.symbol || alert.address.slice(0, 8));
  const safeName = String(alert.name || 'Metadata pending');
  const imageUrl = sanitizeOptionalHttpUrl(alert.imageUrl);
  const xSearch = buildXSearchUrl(symbol, alert.address, resolveTokenAgeMs(alert.tokenCreatedAt));
  const topClass = getAlertToneClass(alert, renderNow);
  const timeLabel = new Date(alert.createdAt).toLocaleTimeString('en-US');
  if (alert.kind === 'admin-token-review') {
    return buildAdminReviewAlertRowContent(alert, busy, isStarred, enabledTradeTerminals, timeLabel, topClass);
  }

  const grid = document.createElement('div');
  grid.className = 'alert-grid';
  const body = document.createElement('div');
  body.className = 'alert-body-v68';
  const time = document.createElement('div');
  time.className = 'alert-time-v68';
  time.textContent = timeLabel;

  const main = document.createElement('div');
  main.className = 'alert-main-v68';
  main.append(buildAlertAvatar(
    symbol, imageUrl, alert.address, alert.chain, alert.launchpadId, alert.pairDexId,
  ));

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
  tokenLine.append(' ', buildTokenIdentityBadgeGroup(tickerPeersControl, alert.chain, alert.address), ' ', tokenName);
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
  side.append(buildAlertHeadline(alert, topClass));
  const rail = document.createElement('div');
  rail.className = 'alert-rail-v68';
  rail.append(chart, side);

  const links = document.createElement('div');
  links.className = 'alert-links-v68';
  const socialLinks = splitTokenSocialUrls(alert.twitterUrl, alert.communityUrl);
  links.append(
    buildInlineLink(marketLink.label, marketLink.url),
    buildTextSeparator(),
    buildInlineLink('X Buscar CA / ', sanitizeHttpUrl(xSearch)),
    buildTextSeparator(),
    buildProfileLink(socialLinks.twitterUrl),
    ...(socialLinks.communityUrl ? [buildTextSeparator(), buildCommunityLink(socialLinks.communityUrl)] : []),
  );

  const actions = document.createElement('div');
  actions.className = 'alert-actions-v68';
  actions.append(
    buildAlertCopyButton(alert.address),
    buildAlertChartButton(alert),
    buildTradeTerminalMenuElement(alert.address, alert.mintAddress, alert.pairAddress, {
      chain: alert.chain,
      enabledTradeTerminals,
    }),
    buildStarButton(alert.chain, alert.address, isStarred, busy, 'Star token'),
    buildActionButton('Block', 'alert-action-button danger', 'block-token', alert.address, symbol, busy, alert.chain),
  );

  if (isAdmin && alert.chain === 'solana') {
    actions.append(buildActionButton('Admin Block', 'alert-action-button danger', 'admin-block-token', alert.address, symbol, busy));
  }

  content.append(main, statsLine, links, actions);
  body.append(content, rail);
  grid.append(body, time, buildAlertDismissButton(alert.id));
  return grid;
}

function buildAdminReviewAlertRowContent(
  alert: AlertEntry,
  busy: boolean,
  isStarred: boolean,
  enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'],
  timeLabel: string,
  topClass: string,
) {
  const marketLink = resolveAlertMarketLink(alert);
  const symbol = String(alert.symbol || alert.address.slice(0, 8));
  const imageUrl = sanitizeOptionalHttpUrl(alert.imageUrl);
  const reviewAlertId = Number(alert.reviewAlertId || 0);
  const reasons = Array.isArray(alert.reviewReasons) ? alert.reviewReasons : [];
  const firstReason = reasons[0] ? String(reasons[0]).replace(/_/g, ' ') : String(alert.label || 'manual review');
  const socialCount = [
    alert.reviewWebsiteUrl,
    alert.twitterUrl,
    alert.communityUrl,
  ].filter(Boolean).length;
  const priority = String(alert.reviewPriority || 'normal').toUpperCase();

  const grid = document.createElement('div');
  grid.className = 'alert-grid';
  const body = document.createElement('div');
  body.className = 'alert-body-v68';
  const time = document.createElement('div');
  time.className = 'alert-time-v68';
  time.textContent = timeLabel;

  const main = document.createElement('div');
  main.className = 'alert-main-v68';
  main.append(buildAlertAvatar(
    symbol, imageUrl, alert.address, alert.chain, alert.launchpadId, alert.pairDexId,
  ));

  const copyBlock = document.createElement('div');
  copyBlock.className = 'alert-copy-block';

  const top = document.createElement('div');
  top.className = 'alert-top-v68';
  const tokenLine = document.createElement('span');
  tokenLine.className = 'alert-token-v68';
  const tokenName = document.createElement('span');
  tokenName.className = 'alert-token-name';
  tokenName.textContent = String(alert.name || 'Metadata pending');
  tokenLine.append(symbol, ' ', buildTokenIdentityBadgeGroup(null, alert.chain, alert.address), ' ', tokenName);
  top.append(tokenLine);

  const flowLine = document.createElement('div');
  flowLine.className = 'alert-flow-v68';
  flowLine.append(
    buildMetricPair('MCAP', fmtMoney(alert.mcap), 'warn'),
    buildMetricPair('SOCIAL', socialCount > 0 ? `${socialCount}` : '-', socialCount > 0 ? 'up' : 'white'),
    buildMetricPair('REVIEW', priority, 'warn'),
  );

  copyBlock.append(top, flowLine);
  main.append(copyBlock);

  const statsLine = document.createElement('div');
  statsLine.className = 'alert-stats-v68';
  appendMetricRow(statsLine, [
    buildMetricPair('TOP10', formatReviewPct(alert.reviewTop10Pct), 'warn'),
    buildMetricPair('TOP20', formatReviewPct(alert.reviewTop20Pct), 'warn'),
    buildMetricPair('VOL24H', fmtMoney(alert.volume24h), 'white'),
    buildMetricPair('WHY', firstReason, 'white'),
  ]);

  const links = document.createElement('div');
  links.className = 'alert-links-v68';
  const socialLinks = splitTokenSocialUrls(alert.twitterUrl, alert.communityUrl);
  links.append(
    buildInlineLink(marketLink.label, marketLink.url),
    buildTextSeparator(),
    buildInlineLink('Website', sanitizeHttpUrl(alert.reviewWebsiteUrl || marketLink.url)),
    buildTextSeparator(),
    buildInlineLink('X Buscar CA / ', sanitizeHttpUrl(buildXSearchUrl(symbol, alert.address, resolveTokenAgeMs(alert.tokenCreatedAt)))),
    buildTextSeparator(),
    buildProfileLink(socialLinks.twitterUrl),
    ...(socialLinks.communityUrl ? [buildTextSeparator(), buildCommunityLink(socialLinks.communityUrl)] : []),
  );

  const actions = document.createElement('div');
  actions.className = 'alert-actions-v68';
  actions.append(
    buildAlertCopyButton(alert.address),
    buildAlertChartButton(alert),
    buildTradeTerminalMenuElement(alert.address, alert.mintAddress, alert.pairAddress, {
      chain: alert.chain,
      enabledTradeTerminals,
    }),
    buildStarButton(alert.chain, alert.address, isStarred, busy, 'Star token'),
    buildReviewActionButton('Valid', 'mark_valid', reviewAlertId, busy),
    buildReviewActionButton('Weak', 'mark_weak', reviewAlertId, busy),
    buildReviewActionButton('Dismiss', 'dismiss', reviewAlertId, busy),
    buildReviewActionButton('Block', 'block', reviewAlertId, busy, true),
  );

  const content = document.createElement('div');
  content.className = 'alert-content-v68';
  content.append(main, statsLine, links, actions);

  const side = document.createElement('div');
  side.className = 'alert-side-v68';
  side.append(buildAlertHeadline(alert, topClass));
  const rail = document.createElement('div');
  rail.className = 'alert-rail-v68';
  rail.append(side);

  body.append(content, rail);
  grid.append(body, time, buildAlertDismissButton(alert.id, reviewAlertId));
  return grid;
}

function buildAlertSparklineBlock(alertId: string, address: string, sparkline: TokenSparklineEntry | null) {
  const chart = document.createElement('div');
  chart.className = 'alert-chart-v1';
  chart.innerHTML = renderSparklineFigure(sparkline, address, {
    areaFill: true,
    expandable: true,
    lookupKey: alertId,
    variant: 'alert',
  });
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
    case 'meteora-surge':
      return '#b06aff';
    case 'mega':
    case 'old-surge':
      return '#ff6b00';
    case 'pump-alert':
      return 'var(--pump-color)';
    case 'gmgn-claim-pump':
      return '#60c888';
    case 'gmgn-claim-bags':
      return '#53fc18';
    case 'recent-surge':
      return 'var(--green)';
    case 'custom-alert':
      return 'var(--custom-alert-color, #22c55e)';
    case 'normal':
    default:
      return '#2ea8ff';
  }
}

function buildAlertAvatar(
  symbol: string,
  imageUrl: string | null,
  address: string,
  chain: unknown,
  launchpadId?: string | null,
  pairDexId?: string | null,
) {
  const wrapper = document.createElement('span');
  wrapper.className = 'token-avatar-wrap alert-avatar-wrap';
  wrapper.dataset.tokenAddress = address;
  wrapper.dataset.tokenFallback = symbol.slice(0, 2).toUpperCase();

  if (imageUrl) {
    wrapper.dataset.tokenImageState = 'pending';
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = '';
    image.setAttribute('aria-label', symbol);
    image.className = 'alert-avatar';
    image.dataset.tokenImagePreview = 'true';
    image.dataset.tokenImagePreviewSrc = imageUrl;
    image.dataset.tokenAddress = address;
    wrapper.append(image);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'alert-avatar-placeholder';
    placeholder.textContent = symbol.slice(0, 2).toUpperCase();
    placeholder.dataset.tokenAddress = address;
    wrapper.append(placeholder);
  }

  wrapper.insertAdjacentHTML(
    'beforeend', renderTokenLaunchpadBadge(address, chain, launchpadId, pairDexId),
  );
  return wrapper;
}

function getOldSurgeAlertTitle(alert: AlertEntry, toneClass: string) {
  if (alert.ruleKey === 'surge-continuation-6h') {
    return 'SURGE CONTINUATION 6H';
  }
  return toneClass === 'recent-surge' ? 'RECENT TOKEN SURGE' : 'OLD TOKEN SURGE';
}

function isSurgeContinuation6hAlert(alert: AlertEntry) {
  return alert.ruleKey === 'surge-continuation-6h';
}

function buildSurgeContinuationIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('surge-continuation-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'M5 19 18 6');

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  head.setAttribute('d', 'M9 6h9v9');

  svg.append(line, head);
  return svg;
}

function buildTimeframeBoltIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('alert-timeframe-bolt');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const bolt = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bolt.setAttribute('d', 'M5.52.359A.5.5 0 0 1 6 0h4a.5.5 0 0 1 .474.658L8.694 6H12.5a.5.5 0 0 1 .395.807l-7 9a.5.5 0 0 1-.873-.454L6.823 9.5H3.5a.5.5 0 0 1-.48-.641l2.5-8.5z');
  bolt.setAttribute('fill', 'currentColor');

  svg.append(bolt);
  return svg;
}

function buildOldSurgeAlertHeadline(alert: AlertEntry, toneClass: string) {
  const surgeTitle = getOldSurgeAlertTitle(alert, toneClass);
  const badge = document.createElement('span');
  badge.className = `alert-badge-v68 ${toneClass}`;
  const surgeWindow = alert.ruleKey === 'surge-continuation-6h'
    ? null
    : alert.surgeWindow === '1H' || alert.surgeWindow === '6H' ? alert.surgeWindow : null;
  if (surgeWindow) {
    badge.className = `alert-badge-v68 ${toneClass} has-timeframe-chip`;
    const chip = document.createElement('span');
    chip.className = `alert-timeframe-chip${surgeWindow === '6H' ? ' timeframe-6h' : ''}`;
    if (surgeWindow === '1H') {
      chip.append(buildTimeframeBoltIcon(), '1H');
    } else {
      chip.textContent = '6H';
    }
    const titleRow = document.createElement('span');
    titleRow.className = 'alert-badge-title-row';
    titleRow.append(surgeTitle, chip);
    const subLabel = String(alert.label || 'PCHANGE').replace(/\s*(1H|6H)\s*$/i, '') || 'PCHANGE';
    badge.append(titleRow, buildAlertBadgeSub(fmtPct(alert.pct), subLabel));
    return badge;
  }
  if (isSurgeContinuation6hAlert(alert)) {
    badge.className = `alert-badge-v68 ${toneClass} surge-continuation-badge`;
    const iconCell = document.createElement('span');
    iconCell.className = 'surge-continuation-icon-cell';
    iconCell.append(buildSurgeContinuationIcon());
    const copy = document.createElement('span');
    copy.className = 'surge-continuation-copy';
    const titleRow = document.createElement('span');
    titleRow.className = 'surge-continuation-title-row';
    const title = document.createElement('span');
    title.className = 'surge-continuation-title';
    title.textContent = 'SURGE CONTINUATION';
    const titleWindow = document.createElement('span');
    titleWindow.className = 'surge-continuation-window';
    titleWindow.textContent = '6H';
    titleRow.append(title, titleWindow);
    const subRow = document.createElement('span');
    subRow.className = 'surge-continuation-sub-row';
    const subPct = document.createElement('span');
    subPct.className = 'surge-continuation-sub-pct';
    subPct.textContent = fmtPct(alert.pct);
    const subLabel = document.createElement('span');
    subLabel.className = 'surge-continuation-sub-label';
    subLabel.textContent = 'SURGE CONTINUATION';
    const subWindow = document.createElement('span');
    subWindow.className = 'surge-continuation-window';
    subWindow.textContent = '6H';
    subRow.append(subPct, subLabel, subWindow);
    copy.append(titleRow, subRow);
    badge.append(iconCell, copy);
    return badge;
  }
  badge.append(`🔥 ${surgeTitle}`, document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'PCHANGE')));
  return badge;
}

function buildAlertHeadline(alert: AlertEntry, toneClass: string) {
  const badge = document.createElement('span');
  if (alert.kind === 'admin-token-review') {
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append('Admin Review', document.createElement('br'), buildAlertBadgeSub(String(alert.reviewPriority || 'normal').toUpperCase(), 'manual queue'));
    return badge;
  }
  if (alert.isOldSurge) {
    return buildOldSurgeAlertHeadline(alert, toneClass);
  }
  if (alert.kind === 'meteora-surge') {
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append('🌊 Meteora Alert 1h', document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'METEORA 1H')));
    return badge;
  }
  if (alert.kind === 'gmgn-claim-signal') {
    badge.className = `alert-badge-v68 ${toneClass}`;
    const title = alert.signalType === 18 ? 'PUMP CLAIM' : 'BAGS CLAIM';
    badge.append(title, document.createElement('br'), buildAlertBadgeSub(`#${alert.claimSequence || '?'}`, String(alert.label || 'CLAIM')));
    return badge;
  }
  if (alert.kind === 'custom-alert') {
    badge.className = 'alert-badge-v68 custom-alert';
    badge.append('CUSTOM ALERT', document.createElement('br'), buildAlertBadgeSub(String(alert.customTitle || alert.label || 'Custom'), getCustomAlertMetricLabel(String(alert.customMetric || 'condition'))));
    return badge;
  }
  if (alert.isHvnc) {
    return buildHvncAlertHeadline(alert, badge);
  }
  badge.className = `alert-pct-v68 ${toneClass}`;
  badge.append(`${fmtPct(alert.pct)} `);
  const label = document.createElement('span');
  label.textContent = String(alert.label || 'VOL');
  badge.append(label);
  return badge;
}

function buildHvncAlertHeadline(alert: AlertEntry, badge: HTMLSpanElement) {
  const isRobinhoodHvnc = alert.chain === 'robinhood' && alert.ruleKey === ROBINHOOD_HVNC_RULE_KEY;
  badge.className = 'alert-badge-v68 mega';
  badge.append(
    '🚨 High Volume New Coin',
    document.createElement('br'),
    buildAlertBadgeSub(
      fmtMoney(isRobinhoodHvnc ? alert.volume5m : alert.volume24h),
      isRobinhoodHvnc ? '5m vol' : 'total vol',
    ),
  );
  return badge;
}

function buildAlertBadgeSub(primary: string, secondary: string) {
  const sub = document.createElement('span');
  sub.className = 'alert-badge-sub';
  sub.textContent = `${primary} ${secondary}`;
  return sub;
}

function appendSpecialAlertFlowLine(container: HTMLElement, alert: AlertEntry) {
  if (alert.kind === 'gmgn-claim-signal') {
    container.append(
      buildMetricPair('FEE', formatClaimFee(alert) ?? '-', 'up'),
      buildMetricPair('MCAP', fmtMoney(alert.mcap), 'up'),
      buildMetricPair('CLAIM', alert.claimSequence ? `#${alert.claimSequence}` : '-', 'white'),
    );
    return true;
  }

  return false;
}

function formatCustomAlertTargetDisplay(alert: AlertEntry) {
  const value = Number(alert.customTarget);
  if (!Number.isFinite(value) || value <= 0) {
    return String(alert.customTarget || '-');
  }
  const isPrice = String(alert.customMetric || '').toLowerCase().includes('price');
  return isPrice ? `$${value}` : formatCustomAlertCompactMoney(value);
}

function appendCustomAlertFlowLine(container: HTMLElement, alert: AlertEntry) {
  if (alert.kind !== 'custom-alert') return false;
  const metric = String(alert.customMetric || '').toLowerCase();
  const metricLabel = metric === 'price' ? 'PRICE' : metric === 'fdv' ? 'FDV' : 'MCAP';
  const valuation = resolveTokenValuation(alert);
  container.append(
    buildMetricPair(metricLabel, `${alert.customOperator || 'hits'} ${formatCustomAlertTargetDisplay(alert)}`, 'up'),
    buildMetricPair(valuation.label, fmtMoney(valuation.value), 'up'),
  );
  return true;
}

function buildAlertValuationFlowMetric(alert: AlertEntry, tone: 'up' | 'down') {
  const valuation = resolveTokenValuation(alert);
  const previousValue = valuation.type === 'fdv' ? alert.prevFdv : alert.prevMcap;
  const previousValuation = previousValue != null ? fmtMoney(previousValue) : null;
  const currentValuation = fmtMoney(valuation.value);

  return previousValuation
    ? buildFlowTransition(valuation.label, previousValuation, currentValuation, tone)
    : buildMetricPair(valuation.label, currentValuation, tone);
}

function appendAlertFlowLine(container: HTMLElement, alert: AlertEntry) {
  if (appendSpecialAlertFlowLine(container, alert) || appendCustomAlertFlowLine(container, alert)) {
    return;
  }

  const isGmgnVol1m = alert.ruleKey === 'gmgn-vol-1m';
  const currentVol = fmtMoney(isGmgnVol1m ? alert.volume1m : alert.volume5m);
  const prevVolRaw = isGmgnVol1m ? alert.prevVolume1m : alert.prevVolume5m;
  const prevVol = prevVolRaw != null ? fmtMoney(prevVolRaw) : null;
  const valuation = resolveTokenValuation(alert);
  const previousValuation = valuation.type === 'fdv' ? alert.prevFdv : alert.prevMcap;
  const mcapTone = previousValuation != null && valuation.value != null
    && valuation.value < previousValuation ? 'down' : 'up';
  const volumeLabel = isGmgnVol1m ? 'VOL 1M' : 'VOL 5M';

  if (alert.isOldSurge) {
    container.append(
      buildAlertValuationFlowMetric(alert, 'up'),
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
    buildAlertValuationFlowMetric(alert, mcapTone),
  );
}

function appendSpecialAlertStatsLine(container: HTMLElement, alert: AlertEntry) {
  if (alert.kind === 'gmgn-claim-signal') {
    appendMetricRow(container, [
      buildMetricPair('SOURCE', alert.signalType === 17 ? 'BAGS' : 'PUMP', 'white'),
      buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', getAlertAgeToneClass(alert)),
      buildMetricPair('AT', alert.claimedAt ? new Date(alert.claimedAt).toLocaleTimeString() : '-', 'white'),
    ]);
    return true;
  }

  if (alert.chain === 'robinhood' && alert.ruleKey === ROBINHOOD_HVNC_RULE_KEY) {
    appendMetricRow(container, [
      buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', getAlertAgeToneClass(alert)),
      buildMetricPair('PRICE', formatPriceUsd(alert.priceUsd), 'white'),
      buildMetricPair('LP', fmtMoney(alert.liquidityUsd), 'white'),
      buildMetricPair('TX 5M', alert.transactions == null ? '-' : String(alert.transactions), 'white'),
    ]);
    return true;
  }

  return false;
}

function appendAlertStatsLine(container: HTMLElement, alert: AlertEntry) {
  if (appendSpecialAlertStatsLine(container, alert)) return;

  if (alert.isOldSurge) {
    appendMetricRow(container, [
      buildMetricPair('1H', fmtMoney(alert.volume1h), 'white'),
      buildMetricPair('6H', fmtMoney(alert.volume6h), 'white'),
      buildMetricPair('24H', fmtMoney(alert.volume24h), 'white'),
    ]);
  } else {
    const shouldShowCompactMcap = alert.kind !== 'monitored-vol' && alert.kind !== 'monitored-mcap' && alert.kind !== 'monitored-fdv' && alert.kind !== 'meteora-surge' && alert.kind !== 'custom-alert';
    const valuation = resolveTokenValuation(alert);
    const compactMcap = shouldShowCompactMcap ? buildMetricPair(valuation.label, fmtMoney(valuation.value), 'up', '', 'current-mcap') : null;
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
  const link = buildInlineLink('👤', sanitizeHttpUrl(safeUrl));
  link.classList.add('alert-inline-link-social');
  link.classList.add('alert-inline-link-social-profile');
  return link;
}

function buildCommunityLink(url: string | null | undefined) {
  const safeUrl = sanitizeOptionalHttpUrl(url);
  if (!safeUrl) {
    return document.createTextNode('');
  }
  const link = buildInlineLink('👥', sanitizeHttpUrl(safeUrl));
  link.classList.add('alert-inline-link-social');
  link.classList.add('alert-inline-link-social-community');
  return link;
}

function isCommunityUrl(url: string | null | undefined) {
  const safeUrl = sanitizeOptionalHttpUrl(url);
  if (!safeUrl) {
    return false;
  }
  try {
    const parsed = new URL(safeUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    return ((host === 'x.com' || host === 'twitter.com') && path.startsWith('/i/communities/'))
      || (host === 'coincommunities.org' && path.startsWith('/communities/'));
  } catch {
    return false;
  }
}

function splitTokenSocialUrls(twitterUrl: string | null | undefined, communityUrl: string | null | undefined) {
  const safeTwitterUrl = sanitizeOptionalHttpUrl(twitterUrl);
  const safeCommunityUrl = sanitizeOptionalHttpUrl(communityUrl);
  if (isCommunityUrl(safeTwitterUrl)) {
    return {
      twitterUrl: null,
      communityUrl: safeCommunityUrl || safeTwitterUrl,
    };
  }
  return {
    twitterUrl: safeTwitterUrl,
    communityUrl: safeCommunityUrl,
  };
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
  chain?: TokenChain,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (dataLabel) {
    button.dataset.label = dataLabel;
  }
  if (chain) {
    button.dataset.chain = chain;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function buildReviewActionButton(
  label: string,
  resolution: 'dismiss' | 'block' | 'mark_valid' | 'mark_weak',
  reviewAlertId: number,
  disabled: boolean,
  danger = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `alert-action-button${danger ? ' danger' : ''}`;
  button.dataset.action = 'resolve-token-review-alert';
  button.dataset.resolution = resolution;
  button.dataset.alertId = String(reviewAlertId);
  button.disabled = disabled || !(reviewAlertId > 0);
  button.textContent = label;
  return button;
}

function buildAlertCopyButton(address: string) {
  const button = buildActionButton('CA', 'alert-action-button copy-button compact-copy-button', 'copy-address', address);
  button.title = 'Copiar CA';
  button.setAttribute('aria-label', 'Copiar CA');
  return button;
}

function buildAlertChartButton(alert: AlertEntry) {
  const button = buildActionButton('', 'alert-action-button alert-chart-button', 'open-alert-chart', alert.address);
  const glyph = document.createElement('span');
  glyph.className = 'alert-chart-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  button.append(glyph);
  button.dataset.alertId = alert.id;
  button.title = 'Abrir chart';
  button.setAttribute('aria-label', `Abrir chart de ${alert.symbol || alert.address}`);
  return button;
}

function buildAlertDismissButton(alertId: string, reviewAlertId?: number | null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'alert-dismiss-button';
  button.dataset.action = 'remove-alert';
  button.dataset.alertId = alertId;
  if (reviewAlertId && reviewAlertId > 0) {
    button.dataset.reviewAlertId = String(reviewAlertId);
  }
  button.setAttribute('aria-label', 'Remove alert');
  button.textContent = '×';
  return button;
}

function buildStarButton(chain: TokenChain, address: string, isStarred: boolean, disabled: boolean, title: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.chain = chain;
  button.dataset.address = address;
  button.disabled = disabled;
  button.title = title;
  button.textContent = isStarred ? '★' : '☆';
  return button;
}

function getAlertAgeToneClass(alert: AlertEntry) {
  return getAgeToneClassFromCreatedAt(alert.tokenCreatedAt);
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
    identity.append(buildAlertAvatar(
      String(item.symbol || '?'), sanitizeOptionalHttpUrl(item.imageUrl), item.address, alert.chain,
    ));

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
    const symbolText = document.createElement('span');
    symbolText.textContent = item.symbol || item.address.slice(0, 8);
    symbol.append(symbolText, ...buildTickerPeersRowBadges(alert.tickerPeers, item.address));

    const address = document.createElement('div');
    address.className = 'alert-ticker-peers-address';
    address.textContent = `${item.address.slice(0, 4)}...${item.address.slice(-4)}`;

    identityText.append(symbol, address);
    identity.append(identityText, copy);

    const stats = document.createElement('div');
    stats.className = 'alert-ticker-peers-stats';
    const mcapLabel = buildTickerPeerMcapLabel(
      item, alert.chain === 'robinhood' ? 'FDV' : 'Market cap',
    );
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

function buildTickerPeersRowBadges(tickerPeers: AlertEntry['tickerPeers'], address: string) {
  const normalizedAddress = String(address || '').trim();
  const badges: HTMLElement[] = [];
  if (normalizedAddress && normalizedAddress === String(tickerPeers?.oldestExactAddress || '').trim()) {
    badges.push(buildTickerPeersRowBadge('OG', 'og', 'Oldest exact ticker match'));
  }
  if (normalizedAddress && normalizedAddress === String(tickerPeers?.highestMcapExactAddress || '').trim()) {
    const title = tickerPeers?.chain === 'robinhood'
      ? 'FDV leader among exact ticker peers'
      : 'Market-cap leader among exact ticker peers';
    badges.push(buildTickerPeersRowBadge('#1', 'mcap_leader', title));
  }
  return badges;
}

function buildTickerPeersRowBadge(label: string, role: 'og' | 'mcap_leader', title: string) {
  const badge = document.createElement('span');
  badge.className = 'alert-ticker-peers-row-badge';
  badge.dataset.peerRole = role;
  badge.title = title;
  badge.textContent = label;
  return badge;
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
    return tickerPeers?.chain === 'robinhood'
      ? 'FDV leader among exact ticker peers'
      : 'Market-cap leader among exact ticker peers';
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
