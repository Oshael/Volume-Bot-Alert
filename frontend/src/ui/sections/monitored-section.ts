import type { AppController } from '../../state/app-controller';
import { getChainCapabilityNotice, getMockTradingPositionView, getMonitoredTokens, getTokenSparkline, isTokenStarred, type AppState, type ManualTokenEntry, type MeteoraEntry } from '../../state/app-state';
import { bindCompactSearch, bindCopyButtons, bindMonitoredSortControls, bindPagedMonitoredControls, bindSparklineHover, bindSparklineRangeControls, bindTokenActions, bindTokenImagePreview, bindTopEdgePageScrollBridge, buildTickerPeerMcapLabel, buildTradeTerminalMenuElement, buildXSearchUrl, fmtAge, fmtAgeFromDurationMs, fmtMoney, fmtPct, getAgeToneClassFromAgeMs, getAgeToneClassFromCreatedAt, renderManualQuickAddAction, renderSparklineFigure, renderSparklineRangeControl, renderTokenLaunchpadBadge, renderTotalLiquidityCell, resolveTokenAgeMs, resolveTokenHolderDisplay } from './shared';
import { escapeHtml, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { fmtMockSol, resolveLiveMockSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';
import { resolveMonitoredTableRows } from '../../utils/token-table';
import { buildTokenExplorerUrl, buildTokenIdentityKey, buildTokenMarketUrl, normalizeTokenChain, type TokenChain } from '../../utils/token-chain';
import { resolveCoveredMetric, resolveTokenValuation, type ResolvedCoveredMetric, type TokenMetricCoverage } from '../../utils/token-valuation';
import { buildTokenIdentityBadgeGroup } from '../token-chain-badge';
import { fetchTickerPeers, type TickerPeerListItem, type TickerPeerListPayload } from '../../services/api/catalog';
import { resolveMonitoredEmptyStateContent } from '../../utils/monitored-empty-state';
import { calculateCanonicalVolume5mDelta } from '../../utils/canonical-volume';

const TICKER_PEERS_PANEL_GAP_PX = 8;
const TICKER_PEERS_VIEWPORT_MARGIN_PX = 12;
const TICKER_PEERS_CACHE_TTL_MS = 60 * 1000;
const TICKER_PEERS_MAX_HEIGHT_PX = 360;
const TICKER_PEERS_MIN_HEIGHT_PX = 120;
const MONITORED_PIN_CLICK_DELAY_MS = 320;
const MONITORED_PIN_DRAG_THRESHOLD_PX = 10;
const MONITORED_PIN_DROP_DIRECTION_DEADZONE_PX = 6;
const MONITORED_PIN_DROP_PREVIEW_BIAS_RATIO = 0.26;
const MONITORED_PIN_DROP_VISUAL_SETTLE_MS = 80;
const MONITORED_SPARKLINE_QUICK_RANGES = [
  { label: '1h', hours: 1 },
  { label: '4h', hours: 4 },
  { label: '12h', hours: 12 },
  { label: '1d', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '14d', hours: 336 },
  { label: 'all', hours: 0 },
] as const;
const MONITORED_PANEL_TITLE_MARKUP = `
  <span class="monitored-panel-title">
    <span class="monitored-panel-title-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M4 10a7.31 7.31 0 0 0 10 10Z"></path>
        <path d="m9 15 3-3"></path>
        <path d="M17 13a6 6 0 0 0-6-6"></path>
        <path d="M21 13A10 10 0 0 0 11 3"></path>
      </svg>
    </span>
    <span class="monitored-panel-title-copy"><span>MONITORED</span><span>TOKENS</span></span>
  </span>
`;
let monitoredFiltersOpen = false;
type MonitoredValuationFilterDraft = {
  minMcap: number;
  maxMcap: number;
  minFdv: number;
  maxFdv: number;
};

let monitoredFiltersDraft: MonitoredValuationFilterDraft | null = null;
let activeMonitoredFilters: HTMLElement | null = null;
let commitActiveMonitoredFilters: (() => void) | null = null;
let monitoredFiltersDocumentBound = false;

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const view = resolveMonitoredSectionView(state);
  section.className = `panel legacy-panel monitored-panel${view.isCollapsed ? ' panel-collapsed' : ''}${view.miniChartEnabled ? ' monitored-panel-mini-chart-enabled' : ''}`;
  if (view.capabilityNotice) {
    section.innerHTML = `
      <div class="panel-header monitored-panel-header">
        ${MONITORED_PANEL_TITLE_MARKUP}
        <span class="count monitored-token-count-pill">0</span>
      </div>
      <div class="chain-readiness-empty" data-chain-readiness-surface="monitored">${escapeHtml(view.capabilityNotice)}</div>
    `;
    return section;
  }
  section.innerHTML = view.isCollapsed
    ? renderCollapsedMonitoredHeader(view.filteredTracked.length, view.pinCount)
    : renderExpandedMonitoredMarkup(state, view);

  if (view.isCollapsed) {
    bindMonitoredCollapseToggle(section, controller);
    bindMonitoredPinControls(section, state, controller);
    return section;
  }

  renderMonitoredRows(section, state, view);
  bindMonitoredSectionControls(section, state, controller, view);
  return section;
}

type MonitoredSectionView = ReturnType<typeof resolveMonitoredSectionView>;

function resolveMonitoredSectionView(state: AppState) {
  const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
  const searchQuery = String(state.ui.monitoredSearchQuery || '').trim().toLowerCase();
  const filteredTracked = resolveMonitoredTableRows(getMonitoredTokens(state), {
    searchQuery,
    sortCriteria: state.ui.monitoredSorts,
  });
  const filteredTotalPages = Math.max(1, Math.ceil(filteredTracked.length / safePerPage));
  const filteredSafePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), filteredTotalPages - 1);
  const filteredPageStart = filteredSafePage * safePerPage;
  return {
    capabilityNotice: getChainCapabilityNotice(state, 'monitored'),
    isCollapsed: state.ui.collapsed.monitored,
    searchQuery,
    loadError: state.ui.monitoredLoadError,
    safePerPage,
    filteredTracked,
    filteredTotalPages,
    filteredSafePage,
    pageItems: filteredTracked.slice(filteredPageStart, filteredPageStart + safePerPage),
    sortClasses: resolveMonitoredSortClasses(state),
    miniChartEnabled: state.ui.livePanelLayout.spans.monitored > 1,
    pinCount: state.data.pinnedMonitoredTokenIdentities.length,
    minMcap: resolveMonitoredFilterValue(state, 'monitored-mcap-min', 30000),
    maxMcap: resolveMonitoredFilterValue(state, 'monitored-view-mcap-max', 0),
    minFdv: resolveMonitoredFilterValue(state, 'monitored-fdv-min', 30000),
    maxFdv: resolveMonitoredFilterValue(state, 'monitored-view-fdv-max', 0),
  };
}

function resolveMonitoredFilterValue(state: AppState, key: string, fallback: number) {
  const value = Number(state.data.configs[key]);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function resolveMonitoredSortClasses(state: AppState) {
  const sorts = state.ui.monitoredSorts;
  const hasMode = (mode: string) => sorts.some((item) => item.mode === mode);
  const hasCriterion = (mode: string, window: string) => sorts.some((item) => item.mode === mode && item.window === window);
  return {
    volActive: hasMode('vol') ? 'active' : '',
    mcapActive: hasMode('mcap') ? 'active' : '',
    ageActive: hasMode('age') ? 'active' : '',
    vol5m: hasCriterion('vol', '5m') ? 'active' : '',
    vol1h: hasCriterion('vol', '1h') ? 'active' : '',
    vol6h: hasCriterion('vol', '6h') ? 'active' : '',
    vol24h: hasCriterion('vol', '24h') ? 'active' : '',
    mcapHighest: hasCriterion('mcap', 'highest') ? 'active' : '',
    mcapLowest: hasCriterion('mcap', 'lowest') ? 'active' : '',
    ageNewest: hasCriterion('age', 'newest') ? 'active' : '',
    ageOldest: hasCriterion('age', 'oldest') ? 'active' : '',
  };
}

function renderCollapsedMonitoredHeader(count: number, pinCount: number) {
  return `
    <div class="panel-header monitored-panel-header">
      ${MONITORED_PANEL_TITLE_MARKUP}
      <div class="panel-header-controls monitored-header-controls">
        <div class="monitored-header-top">
          <span class="monitored-token-pill-wrap">
            <span class="panel-header-label">TOKENS</span>
            <span class="count monitored-token-count-pill">${count}</span>
          </span>
          ${renderMonitoredResetPinsButton(pinCount)}
          <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="monitored" aria-label="Expand monitored tokens"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderMonitoredFilters(view: MonitoredSectionView) {
  const sortClasses = view.sortClasses;
  const draft = monitoredFiltersOpen && monitoredFiltersDraft
    ? monitoredFiltersDraft
    : {
      minMcap: view.minMcap,
      maxMcap: view.maxMcap,
      minFdv: view.minFdv,
      maxFdv: view.maxFdv,
    };
  return `
    <div class="monitored-filters${monitoredFiltersOpen ? ' is-open' : ''}" data-monitored-filters>
      <button type="button" class="old-filter-btn active monitored-filters-toggle ui-control-tooltip" data-action="monitored-filters-toggle" data-tooltip="Configure sorting and valuation limits for Monitored tokens." aria-haspopup="dialog" aria-expanded="${monitoredFiltersOpen}">FILTERS</button>
      <div class="monitored-filters-popover" role="dialog" aria-label="Monitored filters" ${monitoredFiltersOpen ? '' : 'hidden'}>
        <section class="monitored-filter-section" aria-labelledby="monitored-sort-order-label">
          <span class="monitored-filter-section-title" id="monitored-sort-order-label">SORT ORDER</span>
          <div class="monitored-filter-row">
            <span class="monitored-filter-row-label">VOLUME WINDOW</span>
            <div class="monitored-filter-options">
              <button type="button" class="monitored-filter-option ${sortClasses.vol5m}" data-monitored-sort-mode="vol" data-monitored-sort-window="5m">5M</button>
              <button type="button" class="monitored-filter-option ${sortClasses.vol1h}" data-monitored-sort-mode="vol" data-monitored-sort-window="1h">1H</button>
              <button type="button" class="monitored-filter-option ${sortClasses.vol6h}" data-monitored-sort-mode="vol" data-monitored-sort-window="6h">6H</button>
              <button type="button" class="monitored-filter-option ${sortClasses.vol24h}" data-monitored-sort-mode="vol" data-monitored-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="monitored-filter-row">
            <span class="monitored-filter-row-label">MCAP / FDV ORDER</span>
            <div class="monitored-filter-options">
              <button type="button" class="monitored-filter-option ${sortClasses.mcapHighest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="highest">HIGHEST</button>
              <button type="button" class="monitored-filter-option ${sortClasses.mcapLowest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="monitored-filter-row">
            <span class="monitored-filter-row-label">AGE ORDER</span>
            <div class="monitored-filter-options">
              <button type="button" class="monitored-filter-option ${sortClasses.ageNewest}" data-monitored-sort-mode="age" data-monitored-sort-window="newest">NEWEST</button>
              <button type="button" class="monitored-filter-option ${sortClasses.ageOldest}" data-monitored-sort-mode="age" data-monitored-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </section>
        <section class="monitored-filter-section monitored-filter-limits" aria-labelledby="monitored-valuation-limits-label">
          <span class="monitored-filter-section-title" id="monitored-valuation-limits-label">VALUATION LIMITS</span>
          <div class="monitored-filter-limit-row">
            <span class="monitored-filter-limit-label">MCAP</span>
            <div class="monitored-filter-limit-fields">
              <label class="legacy-mini-field">MIN <input type="number" min="0" step="1000" value="${draft.minMcap}" data-action="monitored-mcap-min" aria-label="Minimum market cap" /></label>
              <label class="legacy-mini-field">MAX <input type="number" min="0" step="1000" value="${draft.maxMcap || ''}" placeholder="NO MAX" data-action="monitored-mcap-max" aria-label="Maximum market cap" /></label>
            </div>
          </div>
          <div class="monitored-filter-limit-row">
            <span class="monitored-filter-limit-label">FDV</span>
            <div class="monitored-filter-limit-fields">
              <label class="legacy-mini-field">MIN <input type="number" min="0" step="1000" value="${draft.minFdv}" data-action="monitored-fdv-min" aria-label="Minimum fully diluted valuation" /></label>
              <label class="legacy-mini-field">MAX <input type="number" min="0" step="1000" value="${draft.maxFdv || ''}" placeholder="NO MAX" data-action="monitored-fdv-max" aria-label="Maximum fully diluted valuation" /></label>
            </div>
          </div>
          <span class="monitored-filters-error" data-monitored-filters-error role="alert" hidden></span>
        </section>
        <span class="monitored-filters-hint">CLICK OUTSIDE OR ENTER TO SAVE · ESC TO CANCEL LIMIT CHANGES</span>
      </div>
    </div>
  `;
}

function renderExpandedMonitoredMarkup(state: AppState, view: MonitoredSectionView) {
  return `
    <div class="panel-header monitored-panel-header">
      ${MONITORED_PANEL_TITLE_MARKUP}
      <div class="panel-header-controls monitored-header-controls">
        <div class="monitored-header-top">
          ${renderMonitoredFilters(view)}
          <span class="monitored-token-pill-wrap monitored-token-pill-wrap-top">
            <span class="panel-header-label">TOKENS</span>
            <span class="count monitored-token-count-pill">${view.filteredTracked.length}</span>
          </span>
          ${renderMonitoredResetPinsButton(view.pinCount)}
        </div>
        <div class="monitored-header-bottom">
          <div class="monitored-inline-pagination">
            <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle monitored-inline-collapse" data-action="toggle-section-collapse" data-section="monitored" aria-label="Collapse monitored tokens"><span class="compact-icon-glyph">−</span></button>
            <div class="compact-search compact-search-fixed ${view.searchQuery ? 'has-query open' : ''}">
              <button type="button" class="compact-search-toggle" data-action="monitored-search-focus" aria-label="Search monitored tokens">&#128269;</button>
              <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="monitored-search" data-search-input="monitored">
            </div>
            <div class="monitored-inline-controls">
              ${view.miniChartEnabled ? renderSparklineRangeControl(state, 'monitored') : ''}
              <label class="legacy-mini-field monitored-per-page-field">PER PAGE <input type="number" min="10" step="1" data-action="monitored-per-page" /></label>
              <label class="legacy-mini-field monitored-page-field">
                PAGE
                <span class="monitored-page-box">
                  <input type="number" min="1" max="${view.filteredTotalPages}" step="1" data-action="monitored-page-jump" aria-label="Current monitored page" />
                  <span class="monitored-page-separator" aria-hidden="true">/</span>
                  <span class="bucket-page-total monitored-page-total">${view.filteredTotalPages}</span>
                </span>
              </label>
              <div class="button-row compact bucket-footer-actions">
                <button type="button" class="action-button small" data-action="monitored-prev" ${view.filteredSafePage === 0 ? 'disabled' : ''}>Prev</button>
                <button type="button" class="action-button small" data-action="monitored-next" ${view.filteredSafePage >= view.filteredTotalPages - 1 ? 'disabled' : ''}>Next</button>
              </div>
              <span class="monitored-token-pill-wrap monitored-token-pill-wrap-inline">
                <span class="panel-header-label">TOKENS</span>
                <span class="count monitored-token-count-pill">${view.filteredTracked.length}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="monitored-list"></div>
  `;
}

function renderMonitoredResetPinsButton(pinCount: number) {
  if (pinCount < 2) return '';
  return `<button type="button" class="monitored-reset-pins" data-action="reset-monitored-pins" title="Reset all pinned tokens" aria-label="Reset all pinned tokens"><span aria-hidden="true">&#8634;</span> PINS</button>`;
}

function renderMonitoredRows(
  section: ParentNode,
  state: AppState,
  view: MonitoredSectionView,
) {
  const monitoredList = section.querySelector<HTMLElement>('.monitored-list');
  if (!monitoredList) {
    return;
  }

  if (view.pageItems.length === 0) {
    monitoredList.append(buildMonitoredEmptyState(view.loadError, Boolean(view.searchQuery)));
    return;
  }

  const mockSolUsdcRate = resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs);
  for (const item of view.pageItems) {
    const chain = item.chain || 'solana';
    const isSolana = chain === 'solana';
    const miniChartEnabled = state.ui.livePanelLayout.spans.monitored > 1
      && state.data.chainReadiness[chain]?.capabilities.charts === true;
    monitoredList.append(buildMonitoredRow(
      item,
      state.data.manualTokenFolders,
      state.ui.busy,
      isTokenStarred(state, item.address, item.chain || 'solana'),
      state.session.role === 'admin',
      chain === 'robinhood'
        ? state.ui.enabledRobinhoodTradeTerminals
        : state.ui.enabledTradeTerminals,
      miniChartEnabled ? getTokenSparkline(state, item.address, chain) : null,
      miniChartEnabled,
      state.ui.monitoredSparklineHoursByAddress,
      isSolana ? getMockTradingPositionView(state, item.address) : null,
      isSolana ? state.data.mockTradingTradesByAddress[item.address] : [],
      mockSolUsdcRate,
    ));
  }
}

function buildMonitoredEmptyState(loadError: string | null, hasSearchQuery: boolean) {
  const content = resolveMonitoredEmptyStateContent({ loadError, hasSearchQuery });
  const emptyState = document.createElement('div');
  emptyState.className = `empty-state${content.isError ? ' load-error' : ''}`;
  const emptyIcon = document.createElement('div');
  emptyIcon.className = 'empty-icon';
  emptyIcon.textContent = content.icon;
  const emptyText = document.createElement('div');
  emptyText.className = 'empty-text';
  emptyText.textContent = content.text;
  emptyState.append(emptyIcon, emptyText);
  return emptyState;
}

function bindMonitoredSectionControls(
  section: ParentNode,
  state: AppState,
  controller: AppController,
  view: MonitoredSectionView,
) {
  const searchInput = section.querySelector<HTMLInputElement>('[data-action="monitored-search"]');
  if (searchInput) {
    searchInput.value = state.ui.monitoredSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'monitored-search-focus',
    inputAction: 'monitored-search',
  });
  const perPageInput = section.querySelector<HTMLInputElement>('[data-action="monitored-per-page"]');
  if (perPageInput) {
    perPageInput.value = String(view.safePerPage);
  }
  const pageJumpInput = section.querySelector<HTMLInputElement>('[data-action="monitored-page-jump"]');
  if (pageJumpInput) {
    pageJumpInput.value = String(view.filteredSafePage + 1);
  }
  bindMonitoredCollapseToggle(section, controller);
  bindMonitoredSearchInput(searchInput, controller);
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindTokenImagePreview(section);
  bindTopEdgePageScrollBridge(section.querySelector<HTMLElement>('.monitored-list'));
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindMonitoredSparklineQuickRanges(section, controller);
  bindSparklineRangeControls(section, controller);
  bindMonitoredTickerPeerPanelClose(section);
  bindMonitoredSortControls(section, controller);
  bindPagedMonitoredControls(section, controller);
  bindMonitoredPinControls(section, state, controller);
  bindMonitoredFilters(section, controller, view);
}

function bindMonitoredSparklineQuickRanges(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-action="set-monitored-sparkline-range-hours"]').forEach((button) => {
    button.addEventListener('click', () => {
      const address = String(button.dataset.address || '').trim();
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      controller.setMonitoredTokenSparklineRangeHours(
        address,
        Number(button.dataset.sparklineRangeHours),
        chain,
      );
      button.dispatchEvent(new CustomEvent('monitored-sparkline-range-commit', { bubbles: true }));
    });
  });
}

function ensureMonitoredFiltersDocumentClose() {
  if (monitoredFiltersDocumentBound) return;
  monitoredFiltersDocumentBound = true;
  document.addEventListener('pointerdown', (event) => {
    if (!monitoredFiltersOpen || !activeMonitoredFilters || !(event.target instanceof Node)) return;
    if (!activeMonitoredFilters.contains(event.target)) commitActiveMonitoredFilters?.();
  }, true);
}

function bindMonitoredFilters(
  section: ParentNode,
  controller: AppController,
  view: MonitoredSectionView,
) {
  const wrapper = section.querySelector<HTMLElement>('[data-monitored-filters]');
  const toggle = wrapper?.querySelector<HTMLButtonElement>('[data-action="monitored-filters-toggle"]');
  const popover = wrapper?.querySelector<HTMLElement>('.monitored-filters-popover');
  const mcapMinInput = section.querySelector<HTMLInputElement>('[data-action="monitored-mcap-min"]');
  const mcapMaxInput = section.querySelector<HTMLInputElement>('[data-action="monitored-mcap-max"]');
  const fdvMinInput = section.querySelector<HTMLInputElement>('[data-action="monitored-fdv-min"]');
  const fdvMaxInput = section.querySelector<HTMLInputElement>('[data-action="monitored-fdv-max"]');
  const errorMessage = section.querySelector<HTMLElement>('[data-monitored-filters-error]');
  if (!wrapper || !toggle || !popover || !mcapMinInput || !mcapMaxInput
    || !fdvMinInput || !fdvMaxInput || !errorMessage) {
    monitoredFiltersOpen = false;
    monitoredFiltersDraft = null;
    activeMonitoredFilters = null;
    commitActiveMonitoredFilters = null;
    return;
  }
  ensureMonitoredFiltersDocumentClose();
  activeMonitoredFilters = wrapper;
  monitoredFiltersDraft ??= {
    minMcap: view.minMcap,
    maxMcap: view.maxMcap,
    minFdv: view.minFdv,
    maxFdv: view.maxFdv,
  };

  const readValue = (input: HTMLInputElement, fallback: number) => {
    const value = Number(input.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const setOpen = (next: boolean, focusToggle = false) => {
    monitoredFiltersOpen = next;
    wrapper.classList.toggle('is-open', next);
    popover.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    if (focusToggle) toggle.focus();
  };
  const setError = (message = '') => {
    errorMessage.textContent = message;
    errorMessage.hidden = !message;
  };
  const readDraft = (): MonitoredValuationFilterDraft => ({
    minMcap: readValue(mcapMinInput, view.minMcap),
    maxMcap: readValue(mcapMaxInput, 0),
    minFdv: readValue(fdvMinInput, view.minFdv),
    maxFdv: readValue(fdvMaxInput, 0),
  });
  const cancelFilters = () => {
    monitoredFiltersDraft = null;
    mcapMinInput.value = String(view.minMcap);
    mcapMaxInput.value = view.maxMcap > 0 ? String(view.maxMcap) : '';
    fdvMinInput.value = String(view.minFdv);
    fdvMaxInput.value = view.maxFdv > 0 ? String(view.maxFdv) : '';
    setError();
    setOpen(false, true);
  };
  const applyFilters = (focusToggle = false) => {
    const draft = readDraft();
    monitoredFiltersDraft = draft;
    if (draft.maxMcap > 0 && draft.maxMcap < draft.minMcap) {
      setError('MCAP MAX MUST BE GREATER THAN OR EQUAL TO MIN');
      mcapMaxInput.focus();
      return;
    }
    if (draft.maxFdv > 0 && draft.maxFdv < draft.minFdv) {
      setError('FDV MAX MUST BE GREATER THAN OR EQUAL TO MIN');
      fdvMaxInput.focus();
      return;
    }
    monitoredFiltersDraft = null;
    setError();
    setOpen(false, focusToggle);
    void controller.saveMonitoringConfig({
      'monitored-mcap-min': draft.minMcap,
      'monitored-view-mcap-max': draft.maxMcap,
      'monitored-fdv-min': draft.minFdv,
      'monitored-view-fdv-max': draft.maxFdv,
    });
  };
  commitActiveMonitoredFilters = () => applyFilters();
  toggle.addEventListener('click', () => {
    if (monitoredFiltersOpen) {
      applyFilters(true);
      return;
    }
    monitoredFiltersDraft = {
      minMcap: view.minMcap,
      maxMcap: view.maxMcap,
      minFdv: view.minFdv,
      maxFdv: view.maxFdv,
    };
    setOpen(true);
  });
  const updateDraft = () => {
    monitoredFiltersDraft = readDraft();
    setError();
  };
  mcapMinInput.addEventListener('input', updateDraft);
  mcapMaxInput.addEventListener('input', updateDraft);
  fdvMinInput.addEventListener('input', updateDraft);
  fdvMaxInput.addEventListener('input', updateDraft);
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelFilters();
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      applyFilters(true);
    }
  });
}

type MonitoredPinClickDraft = {
  chain: TokenChain;
  address: string;
  pinned: boolean;
  timer: ReturnType<typeof window.setTimeout>;
};

type MonitoredPinDropTarget = {
  centerY: number;
};

type MonitoredPinDragDraft = {
  chain: TokenChain;
  address: string;
  handle: HTMLButtonElement;
  list: HTMLElement;
  row: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  directionAnchorY: number;
  dragDirection: -1 | 0 | 1;
  offsetY: number;
  rowHeight: number;
  ghost: HTMLElement | null;
  active: boolean;
  pendingClientY: number | null;
  previewFrame: number | null;
  previewIndex: number;
  dropTargets: MonitoredPinDropTarget[];
  rows: HTMLElement[];
  movableRows: HTMLElement[];
  rowTops: Map<HTMLElement, number>;
  slotTops: number[];
};

function bindMonitoredPinControls(section: ParentNode, state: AppState, controller: AppController) {
  section.querySelector<HTMLButtonElement>('[data-action="reset-monitored-pins"]')?.addEventListener('click', () => {
    void controller.resetMonitoredTokenPins();
    dispatchMonitoredPinCommit(section);
  });

  let pendingClick: MonitoredPinClickDraft | null = null;
  const registerPinTap = (chain: TokenChain, address: string, pinned: boolean) => {
    if (pendingClick?.chain === chain && pendingClick.address === address) {
      window.clearTimeout(pendingClick.timer);
      pendingClick = null;
      if (pinned) {
        void controller.unpinMonitoredToken(address, chain);
        dispatchMonitoredPinCommit(section);
      }
      return;
    }

    if (pendingClick) window.clearTimeout(pendingClick.timer);
    const timer = window.setTimeout(() => {
      pendingClick = null;
      if (!pinned) {
        void controller.pinMonitoredToken(address, 0, chain);
        dispatchMonitoredPinCommit(section);
      }
    }, MONITORED_PIN_CLICK_DELAY_MS);
    pendingClick = { chain, address, pinned, timer };
  };

  section.addEventListener('click', (event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.detail !== 0) return;
    const handle = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.monitored-pin-handle');
    const address = handle?.dataset.address || '';
    const chain = normalizeTokenChain(handle?.dataset.chain) || 'solana';
    if (handle && address) registerPinTap(chain, address, handle.dataset.pinned === 'true');
  });

  let dragDraft: MonitoredPinDragDraft | null = null;
  const cleanupDrag = (commit: boolean) => {
    const draft = dragDraft;
    if (!draft) return;
    dragDraft = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (draft.previewFrame != null) {
      window.cancelAnimationFrame(draft.previewFrame);
      draft.previewFrame = null;
    }
    try {
      draft.handle.releasePointerCapture(draft.pointerId);
    } catch (_) {
      // Pointer capture may already be released when the window loses the gesture.
    }

    const shouldCommitDrag = commit && draft.active;
    if (shouldCommitDrag && draft.pendingClientY != null) {
      previewMonitoredPinDrop(draft, draft.pendingClientY);
      draft.pendingClientY = null;
    }
    if (shouldCommitDrag) {
      const position = resolveMonitoredAbsoluteDropPosition(state, draft.chain, draft.address, draft.previewIndex);
      void controller.pinMonitoredToken(draft.address, position, draft.chain);
      dispatchMonitoredPinCommit(section);
      window.setTimeout(() => finishMonitoredPinDragVisuals(draft), MONITORED_PIN_DROP_VISUAL_SETTLE_MS);
      return;
    }

    finishMonitoredPinDragVisuals(draft);
  };

  const onPointerMove = (event: PointerEvent) => {
    const draft = dragDraft;
    if (!draft || event.pointerId !== draft.pointerId) return;
    const distance = Math.hypot(event.clientX - draft.startX, event.clientY - draft.startY);
    if (!draft.active && distance >= MONITORED_PIN_DRAG_THRESHOLD_PX) {
      if (pendingClick) window.clearTimeout(pendingClick.timer);
      pendingClick = null;
      beginMonitoredPinDrag(draft);
    }
    if (!draft.active || !draft.ghost) return;
    event.preventDefault();
    draft.ghost.style.top = `${Math.round(event.clientY - draft.offsetY)}px`;
    const cardCenterY = event.clientY - draft.offsetY + (draft.rowHeight / 2);
    const directionDelta = event.clientY - draft.directionAnchorY;
    const dragDirection = Math.sign(directionDelta) as -1 | 0 | 1;
    if (dragDirection !== 0 && Math.abs(directionDelta) >= MONITORED_PIN_DROP_DIRECTION_DEADZONE_PX) {
      draft.dragDirection = dragDirection;
      draft.directionAnchorY = event.clientY;
    }
    const previewY = cardCenterY + (draft.dragDirection * draft.rowHeight * MONITORED_PIN_DROP_PREVIEW_BIAS_RATIO);
    scheduleMonitoredPinDropPreview(draft, previewY);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!dragDraft || event.pointerId !== dragDraft.pointerId) return;
    const completedDraft = dragDraft;
    const wasDrag = completedDraft.active;
    cleanupDrag(true);
    if (!wasDrag) registerPinTap(completedDraft.chain, completedDraft.address, completedDraft.handle.dataset.pinned === 'true');
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (dragDraft && event.pointerId === dragDraft.pointerId) cleanupDrag(false);
  };

  section.addEventListener('pointerdown', (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.button !== 0 || dragDraft) return;
    const handle = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.monitored-pin-handle');
    const row = handle?.closest<HTMLElement>('.monitored-token-row');
    const list = row?.closest<HTMLElement>('.monitored-list');
    const address = handle?.dataset.address || '';
    const chain = normalizeTokenChain(handle?.dataset.chain) || 'solana';
    if (!handle || !row || !list || !address) return;

    const rect = row.getBoundingClientRect();
    dragDraft = {
      chain,
      address,
      handle,
      list,
      row,
      pointerId: pointerEvent.pointerId,
      startX: pointerEvent.clientX,
      startY: pointerEvent.clientY,
      directionAnchorY: pointerEvent.clientY,
      dragDirection: 0,
      offsetY: pointerEvent.clientY - rect.top,
      rowHeight: rect.height,
      ghost: null,
      active: false,
      pendingClientY: null,
      previewFrame: null,
      previewIndex: 0,
      dropTargets: [],
      rows: [],
      movableRows: [],
      rowTops: new Map(),
      slotTops: [],
    };
    handle.setPointerCapture(pointerEvent.pointerId);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  });
}

function dispatchMonitoredPinCommit(section: ParentNode) {
  if (!(section instanceof HTMLElement)) {
    return;
  }
  section.dispatchEvent(new CustomEvent('monitored-pin-commit', { bubbles: true }));
}

function finishMonitoredPinDragVisuals(draft: MonitoredPinDragDraft) {
  clearMonitoredPinPreviewTransforms(draft);
  draft.row.classList.remove('monitored-token-row-drag-source');
  draft.list.classList.remove('monitored-pin-drag-active');
  draft.ghost?.remove();
}

function beginMonitoredPinDrag(draft: MonitoredPinDragDraft) {
  const rect = draft.row.getBoundingClientRect();
  const ghost = draft.row.cloneNode(true) as HTMLElement;
  ghost.classList.add('monitored-token-row-drag-ghost');
  ghost.classList.remove('monitored-token-row-drag-source');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.left = `${Math.round(rect.left)}px`;
  ghost.style.top = `${Math.round(rect.top)}px`;
  ghost.style.width = `${Math.round(rect.width)}px`;
  ghost.style.height = `${Math.round(rect.height)}px`;
  ghost.style.gridTemplateColumns = window.getComputedStyle(draft.row).gridTemplateColumns;
  document.body.append(ghost);
  draft.ghost = ghost;
  draft.active = true;
  draft.row.classList.add('monitored-token-row-drag-source');
  draft.list.classList.add('monitored-pin-drag-active');
  refreshMonitoredPinDropTargets(draft);
}

function scheduleMonitoredPinDropPreview(draft: MonitoredPinDragDraft, clientY: number) {
  draft.pendingClientY = clientY;
  if (draft.previewFrame != null) {
    return;
  }

  draft.previewFrame = window.requestAnimationFrame(() => {
    draft.previewFrame = null;
    const nextClientY = draft.pendingClientY;
    draft.pendingClientY = null;
    if (nextClientY == null || !draft.active || !draft.row.isConnected) {
      return;
    }
    previewMonitoredPinDrop(draft, nextClientY);
  });
}

function previewMonitoredPinDrop(draft: MonitoredPinDragDraft, clientY: number) {
  for (const [index, target] of draft.dropTargets.entries()) {
    if (clientY < target.centerY) {
      applyMonitoredPinPreviewIndex(draft, index);
      return;
    }
  }
  applyMonitoredPinPreviewIndex(draft, draft.movableRows.length);
}

function applyMonitoredPinPreviewIndex(draft: MonitoredPinDragDraft, previewIndex: number) {
  if (draft.previewIndex === previewIndex) {
    return;
  }
  draft.previewIndex = previewIndex;
  const finalRows = getMonitoredPinPreviewRows(draft);
  const finalIndexByRow = new Map(finalRows.map((row, index) => [row, index]));

  for (const row of draft.movableRows) {
    const finalIndex = finalIndexByRow.get(row);
    if (finalIndex == null) continue;
    const startTop = draft.rowTops.get(row) ?? 0;
    const targetTop = draft.slotTops[finalIndex] ?? startTop;
    const deltaY = targetTop - startTop;
    row.style.transform = Math.abs(deltaY) < 1 ? '' : `translateY(${Math.round(deltaY)}px)`;
  }
}

function refreshMonitoredPinDropTargets(draft: MonitoredPinDragDraft) {
  draft.rows = [...draft.list.querySelectorAll<HTMLElement>('.monitored-token-row')];
  draft.movableRows = draft.rows.filter((row) => row !== draft.row);
  draft.previewIndex = Math.max(0, draft.rows.indexOf(draft.row));
  draft.rowTops = new Map(draft.rows.map((row) => [row, row.getBoundingClientRect().top]));
  draft.slotTops = draft.rows.map((row) => draft.rowTops.get(row) ?? 0);
  draft.dropTargets = draft.movableRows.map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      centerY: rect.top + (rect.height / 2),
    };
  });
}

function getMonitoredPinPreviewRows(draft: MonitoredPinDragDraft) {
  const rows = [...draft.movableRows];
  rows.splice(Math.min(Math.max(0, draft.previewIndex), rows.length), 0, draft.row);
  return rows;
}

function clearMonitoredPinPreviewTransforms(draft: MonitoredPinDragDraft) {
  for (const row of draft.movableRows) {
    row.style.transform = '';
  }
}

function resolveMonitoredAbsoluteDropPosition(
  state: AppState,
  chain: TokenChain,
  address: string,
  previewIndex: number,
) {
  const draggedIdentity = buildTokenIdentityKey(chain, address);
  const fullRows = resolveMonitoredTableRows(getMonitoredTokens(state), {
    searchQuery: '',
    sortCriteria: state.ui.monitoredSorts,
  }).map((item) => buildTokenIdentityKey(item.chain || 'solana', item.address))
    .filter((identity) => identity !== draggedIdentity);
  const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
  const searchQuery = String(state.ui.monitoredSearchQuery || '').trim().toLowerCase();
  const filteredRows = resolveMonitoredTableRows(getMonitoredTokens(state), {
    searchQuery,
    sortCriteria: state.ui.monitoredSorts,
  }).map((item) => buildTokenIdentityKey(item.chain || 'solana', item.address))
    .filter((identity) => identity !== draggedIdentity);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), totalPages - 1);
  const requestedIndex = Math.min(Math.max(0, (safePage * safePerPage) + previewIndex), filteredRows.length);
  const nextIdentity = filteredRows[requestedIndex];
  const previousIdentity = filteredRows[requestedIndex - 1];
  const nextIndex = nextIdentity ? fullRows.indexOf(nextIdentity) : -1;
  if (nextIndex >= 0) return nextIndex;
  const previousIndex = previousIdentity ? fullRows.indexOf(previousIdentity) : -1;
  return previousIndex >= 0 ? previousIndex + 1 : 0;
}

export function bindMonitoredTickerPeerPanelClose(section: ParentNode) {
  section.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    closeOpenMonitoredTickerPeerPanels(section, target?.closest<HTMLDetailsElement>('.monitored-ticker-peers-panel') || null);
  });

  section.addEventListener('toggle', (event) => {
    const panel = (event.target as HTMLElement | null)?.closest<HTMLDetailsElement>('.monitored-ticker-peers-panel');
    if (!panel) {
      return;
    }
    if (!panel.open) {
      delete panel.dataset.positioned;
      return;
    }
    delete panel.dataset.positioned;
    closeOpenMonitoredTickerPeerPanels(section, panel);
    positionMonitoredTickerPeerPanel(panel);
    loadFullTickerPeerList(panel);
  }, true);

  section.addEventListener('wheel', (event) => {
    isolateMonitoredTickerPeerListWheel(event as WheelEvent);
  }, { capture: true, passive: false });

  section.addEventListener('scroll', () => {
    positionOpenMonitoredTickerPeerPanels(section);
  }, true);
}

function closeOpenMonitoredTickerPeerPanels(root: ParentNode, exceptPanel: HTMLDetailsElement | null) {
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('.monitored-ticker-peers-panel[open]')) {
    if (panel !== exceptPanel) {
      delete panel.dataset.positioned;
      panel.open = false;
    }
  }
}

function positionOpenMonitoredTickerPeerPanels(root: ParentNode) {
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('.monitored-ticker-peers-panel[open]')) {
    positionMonitoredTickerPeerPanel(panel);
  }
}

function positionMonitoredTickerPeerPanel(panel: HTMLDetailsElement) {
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

function isolateMonitoredTickerPeerListWheel(event: WheelEvent) {
  const list = (event.target as HTMLElement | null)
    ?.closest<HTMLElement>('.monitored-ticker-peers-list');
  if (!list?.closest('.monitored-ticker-peers-panel[open]')) {
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

function bindMonitoredCollapseToggle(section: ParentNode, controller: AppController) {
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('monitored');
  });
}

function bindMonitoredSearchInput(searchInput: HTMLInputElement | null, controller: AppController) {
  if (!searchInput) {
    return;
  }

  const syncSearchInput = (event: Event) => {
    controller.setMonitoredSearchQuery((event.currentTarget as HTMLInputElement).value);
  };

  searchInput.addEventListener('input', syncSearchInput);
  searchInput.addEventListener('change', syncSearchInput);
  searchInput.addEventListener('search', syncSearchInput);
  searchInput.addEventListener('keyup', syncSearchInput);
  searchInput.addEventListener('cut', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    window.setTimeout(() => controller.setMonitoredSearchQuery(input.value), 0);
  });
}

function resolveMonitoredIdentityPresentation(item: ManualTokenEntry) {
  const chain = item.chain || 'solana';
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const subtitle = String(item.name || item.label || 'Metadata pending');
  const primaryUrl = sanitizeHttpUrl(
    buildTokenMarketUrl(chain, item.address, item.pairUrl)
      || buildTokenExplorerUrl(chain, item.address),
  );
  return { chain, primaryUrl, subtitle, symbol };
}

function buildMonitoredRow(item: ManualTokenEntry, manualTokenFolders: AppState['data']['manualTokenFolders'], busy: boolean, isStarred: boolean, isAdmin: boolean, enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'], sparkline: AppState['data']['sparklineByAddress'][string] | null, miniChartEnabled: boolean, monitoredSparklineHoursByAddress: AppState['ui']['monitoredSparklineHoursByAddress'], mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null, mockTradingTrades: AppState['data']['mockTradingTradesByAddress'][string] = [], mockSolUsdcRate?: number) {
  const { chain, primaryUrl, subtitle, symbol } = resolveMonitoredIdentityPresentation(item);
  const valuation = resolveTokenValuation(item);
  const xSearch = buildXSearchUrl(symbol, item.address, resolveTokenAgeMs(item.createdAt));
  const socialLinks = splitTokenSocialUrls(item.twitterUrl, item.communityUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const ageToneClass = getAgeToneClassFromCreatedAt(item.createdAt);
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const volDelta = calculateCanonicalVolume5mDelta(
    item.volume5m, item.prevVolume5mCanonical,
    chain === 'robinhood' ? item.volume5mDeltaCoverage : 'complete',
  );
  const article = document.createElement('article');
  article.className = buildMonitoredRowClassName(
    isStarred,
    Boolean(item._isPinnedMonitored),
    item.activityState,
  );
  const identityKey = buildTokenIdentityKey(chain, item.address);
  article.dataset.hoverKey = `monitored:${identityKey}`;
  article.dataset.identity = identityKey;
  article.dataset.chain = chain;
  article.dataset.address = item.address;

  article.append(buildMonitoredPinHandle(item));
  article.append(buildMonitoredAvatar(
    symbol, imageUrl, item.address, chain, item.launchpadId, item.pairDexId,
  ));

  const main = document.createElement('div');
  main.className = 'panel-row-main monitored-row-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'panel-row-title monitored-title-line';
  const tokenName = document.createElement('a');
  tokenName.className = 'token-name';
  tokenName.href = primaryUrl;
  tokenName.target = '_blank';
  tokenName.rel = 'noreferrer';
  tokenName.textContent = symbol;
  const tickerPeerBadge = buildTickerPeerBadge(item.tickerPeers, item.chain, item.address);
  const identityBadges = buildTokenIdentityBadgeGroup(tickerPeerBadge, chain, item.address);
  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = subtitle;
  titleLine.append(tokenName, tokenAddr, identityBadges);

  const metaLine = document.createElement('div');
  metaLine.className = 'panel-row-meta monitored-meta-line';
  metaLine.append(
    buildValuationMetric(valuation),
    buildMetaMetric('AGE', age, ageToneClass),
    buildCoveredMoneyMetric('VOL 1H', item.volume1h, item.coverage?.['1h']),
    buildCoveredMoneyMetric('VOL 6H', item.volume6h, item.coverage?.['6h']),
    buildCoveredMoneyMetric('VOL 24H', item.volume24h, item.coverage?.['24h']),
    buildMetaMetric('LIQ', buildMonitoredTotalLiquidityValue(item)),
    buildMetaMetric('HLD', buildMonitoredHolderValue(item)),
  );

  const actions = document.createElement('div');
  actions.className = 'panel-row-actions monitored-actions-line';
  actions.append(buildInlineActionLink('X', sanitizeHttpUrl(xSearch), 'x-search', 'Search contract or ticker on X'));
  if (socialLinks.twitterUrl) {
    actions.append(buildInlineActionLink('👤', socialLinks.twitterUrl, 'x-profile', 'X profile'));
  }
  if (socialLinks.communityUrl) {
    actions.append(buildInlineActionLink('👥', socialLinks.communityUrl, 'x-profile', 'Community'));
  }
  actions.append(
    buildGlyphButton('⧉', 'action-glyph copy-button', 'copy-address', item.address, null, false, 'Copy contract'),
  );
  actions.append(buildTradeTerminalMenuElement(item.address, item.mintAddress, item.pairAddress, {
    chain: item.chain,
    enabledTradeTerminals,
  }));
  const blockButton = buildGlyphButton(
    '⊗', 'action-glyph danger-glyph', 'block-token', item.address, symbol, busy, 'Block token',
  );
  blockButton.dataset.chain = chain;
  actions.append(
    buildManualQuickAddElement(item.address, chain, busy, manualTokenFolders),
    buildStarButton(item.address, chain, isStarred, busy),
    blockButton,
  );
  if (chain === 'solana') {
    appendMonitoredAdminActions(actions, item, symbol, busy, isAdmin, mockTradingPosition);
  }

  main.append(titleLine, metaLine, actions);
  appendMonitoredMockTradingLine(main, mockTradingPosition, mockTradingTrades, mockSolUsdcRate);

  const side = document.createElement('div');
  side.className = 'panel-row-side monitored-side-v68';
  const volLabel = document.createElement('div');
  volLabel.className = 'vol5m-label';
  volLabel.textContent = 'VOL 5M';
  const mainMetric = document.createElement('div');
  const volume5m = resolveCoveredMetric(item.volume5m, item.coverage?.['5m']);
  mainMetric.className = `panel-main-metric monitored-main-metric ${buildCoverageClassName(volume5m)}`;
  mainMetric.textContent = formatCoveredMoney(volume5m);
  mainMetric.title = buildCoverageTitle(volume5m);
  const delta = document.createElement('div');
  delta.className = `panel-side-delta ${volDelta != null && volDelta < 0 ? 'down' : 'up'}`;
  delta.textContent = fmtPct(volDelta);
  side.append(volLabel, mainMetric, delta);

  article.append(main);
  if (miniChartEnabled) {
    article.append(buildMonitoredMiniChart(item, sparkline, monitoredSparklineHoursByAddress));
  }
  article.append(side);
  return article;
}

function buildValuationMetric(valuation: ReturnType<typeof resolveTokenValuation>) {
  const freshnessClass = valuation.freshness === 'stale' ? 'monitored-valuation-stale' : '';
  const metric = buildMetaMetric(valuation.label, fmtMoney(valuation.value), freshnessClass);
  if (valuation.observedAt) metric.title = `Observed at ${valuation.observedAt}`;
  return metric;
}

function buildCoveredMoneyMetric(label: string, value: number | null | undefined, coverage?: TokenMetricCoverage) {
  const metric = resolveCoveredMetric(value, coverage);
  const element = buildMetaMetric(label, formatCoveredMoney(metric), buildCoverageClassName(metric));
  element.title = buildCoverageTitle(metric);
  return element;
}

function formatCoveredMoney(metric: ResolvedCoveredMetric) {
  if (!metric.available) return '-';
  return `${metric.isPartial ? '~' : ''}${fmtMoney(metric.value)}`;
}

function buildCoverageClassName(metric: ResolvedCoveredMetric) {
  return `monitored-coverage-${metric.coverage}`;
}

function buildCoverageTitle(metric: ResolvedCoveredMetric) {
  if (metric.coverage === 'complete') return 'Complete rolling-window coverage';
  if (metric.coverage === 'partial') return 'Partial rolling-window coverage';
  return 'Rolling-window value unavailable';
}

function buildMonitoredRowClassName(
  isStarred: boolean,
  isPinned: boolean,
  activityState?: ManualTokenEntry['activityState'],
) {
  return `token-row monitored-token-row monitored-token-row-v68${isStarred ? ' token-starred' : ''}${isPinned ? ' monitored-token-pinned' : ''}${activityState === 'stale' ? ' monitored-activity-stale' : ''}`;
}

function buildMonitoredPinHandle(item: ManualTokenEntry) {
  const pinned = Boolean(item._isPinnedMonitored);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'monitored-pin-handle';
  button.dataset.action = 'monitored-pin-handle';
  button.dataset.address = item.address;
  button.dataset.chain = item.chain || 'solana';
  button.dataset.pinned = String(pinned);
  button.setAttribute('aria-label', pinned ? 'Move pinned token; double click to unpin' : 'Pin or move token');
  button.setAttribute('aria-pressed', String(pinned));
  button.title = pinned ? 'Drag to move; double click to unpin' : 'Click to pin at top; drag to place';
  return button;
}

function buildMonitoredMiniChart(
  item: ManualTokenEntry,
  sparkline: AppState['data']['sparklineByAddress'][string] | null,
  monitoredSparklineHoursByAddress: AppState['ui']['monitoredSparklineHoursByAddress'],
) {
  const chain = item.chain || 'solana';
  const identityKey = buildTokenIdentityKey(chain, item.address);
  const selectedHours = monitoredSparklineHoursByAddress[identityKey]
    ?? Number(sparkline?.hours);
  const miniChart = document.createElement('div');
  miniChart.className = 'monitored-mini-chart';
  const figure = document.createElement('div');
  figure.className = 'monitored-mini-chart-figure';
  figure.innerHTML = renderSparklineFigure(sparkline, item.address, {
    areaFill: true,
    expandable: true,
    showTokenRangeControl: false,
    lookupKey: identityKey,
    liveMcap: resolveTokenValuation(item).value,
  });
  const controls = document.createElement('div');
  controls.className = 'monitored-sparkline-quick-ranges';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Monitored chart range');
  for (const option of MONITORED_SPARKLINE_QUICK_RANGES) {
    const button = document.createElement('button');
    const active = selectedHours === option.hours;
    button.type = 'button';
    button.className = `monitored-sparkline-quick-range${active ? ' is-active' : ''}`;
    button.dataset.action = 'set-monitored-sparkline-range-hours';
    button.dataset.address = item.address;
    button.dataset.chain = chain;
    button.dataset.sparklineRangeHours = String(option.hours);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = option.label;
    controls.append(button);
  }
  miniChart.append(figure, controls);
  return miniChart;
}

function appendMonitoredAdminActions(
  actions: HTMLElement,
  item: ManualTokenEntry,
  symbol: string,
  busy: boolean,
  isAdmin: boolean,
  mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null,
) {
  if (!isAdmin) {
    return;
  }

  actions.append(buildGlyphButton('B', 'action-glyph', 'mock-buy-token', item.address, symbol, busy, 'Mock buy'));
  if (mockTradingPosition) {
    const sellButton = buildGlyphButton('S', 'action-glyph', 'mock-sell-token', item.address, symbol, busy, 'Mock sell 100%');
    sellButton.dataset.percent = '100';
    actions.append(sellButton);
  }
  actions.append(buildGlyphButton('☠', 'action-glyph danger-glyph', 'admin-block-token', item.address, symbol, busy, 'Admin block permanently'));
}

function appendMonitoredMockTradingLine(
  main: HTMLElement,
  mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null,
  mockTradingTrades: AppState['data']['mockTradingTradesByAddress'][string] = [],
  mockSolUsdcRate?: number,
) {
  if (!mockTradingPosition) {
    return;
  }
  const { pnlUsd: pnl, pnlPct: pct } = resolveMockTradingPositionPnl(mockTradingPosition, mockTradingTrades);
  const takeProfit = mockTradingPosition.takeProfitOrders?.length
    ? ` · ${formatMockTradingTakeProfitSummary(mockTradingPosition.takeProfitOrders)}`
    : '';
  const mockLine = document.createElement('button');
  mockLine.type = 'button';
  mockLine.dataset.action = 'open-mock-trading-pnl';
  mockLine.dataset.address = mockTradingPosition.tokenAddress;
  mockLine.className = `panel-row-meta mock-trading-line mock-trading-pnl-trigger ${pnl != null && pnl < 0 ? 'down' : 'up'}`;
  mockLine.title = 'Open PnL resume';
  mockLine.textContent = `PnL ${fmtMockSol(pnl, { signed: true, usdcRate: mockSolUsdcRate })} (${fmtPct(pct)})${takeProfit}`;
  main.append(mockLine);
}

function formatMockTradingTakeProfitSummary(orders: NonNullable<AppState['data']['mockTradingPositionsByAddress'][string]['takeProfitOrders']>) {
  const openOrders = orders.filter((order) => order.status === 'open');
  if (openOrders.length === 0) {
    return '';
  }
  const preview = openOrders
    .slice(0, 2)
    .map((order) => `${fmtMoney(order.targetMcapUsd)} / ${fmtPct(order.sellPercent)}`)
    .join(', ');
  const extra = openOrders.length > 2 ? ` +${openOrders.length - 2}` : '';
  return `TP ${preview}${extra}`;
}

function buildMonitoredAvatar(
  symbol: string,
  imageUrl: string | null,
  address: string,
  chain: unknown,
  launchpadId: string | null | undefined,
  pairDexId: string | null | undefined,
) {
  const wrapper = document.createElement('span');
  wrapper.className = 'token-avatar-wrap monitored-avatar-wrap';
  wrapper.dataset.tokenAddress = address;
  wrapper.dataset.tokenFallback = symbol.slice(0, 2).toUpperCase();

  if (imageUrl) {
    wrapper.dataset.tokenImageState = 'pending';
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = '';
    image.setAttribute('aria-label', symbol);
    image.className = 'tok-avatar';
    image.dataset.tokenImagePreview = 'true';
    image.dataset.tokenImagePreviewSrc = imageUrl;
    image.dataset.tokenAddress = address;
    wrapper.append(image);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'tok-avatar-placeholder';
    placeholder.textContent = symbol.slice(0, 2).toUpperCase();
    placeholder.dataset.tokenAddress = address;
    wrapper.append(placeholder);
  }

  wrapper.insertAdjacentHTML(
    'beforeend', renderTokenLaunchpadBadge(address, chain, launchpadId, pairDexId),
  );
  return wrapper;
}

function buildInlineActionLink(label: string, href: string, className: string, title: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = `action-glyph ${className}`;
  link.textContent = label;
  link.title = title;
  return link;
}

function buildMetaMetric(label: string, value: string | HTMLElement, valueClassName = '') {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'meta-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = `meta-value${valueClassName ? ` ${valueClassName}` : ''}`;
  if (typeof value === 'string') {
    valueEl.textContent = value;
  } else {
    valueEl.append(value);
  }
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
}

function buildMonitoredTotalLiquidityValue(item: ManualTokenEntry) {
  const value = document.createElement('span');
  const meteoraEntry = normalizeMonitoredMeteoraEntry(item);
  if (!meteoraEntry && !(Number(item.liquidityUsd) > 0)) {
    value.textContent = '-';
    return value;
  }

  value.innerHTML = renderTotalLiquidityCell(item, meteoraEntry, 0);
  return value;
}

function buildMonitoredHolderValue(item: ManualTokenEntry) {
  const display = resolveTokenHolderDisplay(item);
  const value = document.createElement('span');
  value.textContent = display.value;
  value.title = display.title;
  return value;
}

function hasMonitoredMeteoraPool(item: ManualTokenEntry) {
  const meteora = item.meteora;
  return Boolean(meteora && !meteora.noPool && (meteora.poolAddress || Number(meteora.poolCount) > 0));
}

function normalizeMonitoredMeteoraEntry(item: ManualTokenEntry): MeteoraEntry | undefined {
  if (!hasMonitoredMeteoraPool(item) || !item.meteora) {
    return undefined;
  }

  return {
    tvl: Number(item.meteora.tvl) || 0,
    poolAddress: item.meteora.poolAddress ?? null,
    poolCount: Number(item.meteora.poolCount) || 0,
    noPool: Boolean(item.meteora.noPool),
    lastCheckedAt: item.meteora.lastCheckedAt ?? null,
    lastSnapshotAt: item.meteora.lastSnapshotAt ?? null,
    change1h: item.meteora.change1h ?? null,
    change4h: item.meteora.change4h ?? null,
    change6h: item.meteora.change6h ?? null,
    change24h: item.meteora.change24h ?? null,
    volume1h: item.meteora.volume1h ?? null,
    volume4h: item.meteora.volume4h ?? null,
    volume24h: item.meteora.volume24h ?? null,
  };
}

function resolveTickerPeerRole(tickerPeers: ManualTokenEntry['tickerPeers']) {
  if (tickerPeers?.sourcePeerRole === 'og') {
    return 'og';
  }
  if (tickerPeers?.sourcePeerRole === 'mcap_leader') {
    return 'mcap_leader';
  }
  return 'peer_warning';
}

function getTickerPeerBadgeMark(role: 'og' | 'mcap_leader' | 'peer_warning') {
  if (role === 'og') {
    return 'OG';
  }
  if (role === 'mcap_leader') {
    return '#1';
  }
  return '!';
}

function getTickerPeerBadgeTitle(tickerPeers: ManualTokenEntry['tickerPeers'], role: 'og' | 'mcap_leader' | 'peer_warning') {
  if (role === 'og') {
    return 'OG ticker peer: oldest known exact ticker match';
  }
  if (role === 'mcap_leader') {
    return tickerPeers?.chain === 'robinhood'
      ? 'FDV leader among exact ticker peers'
      : 'Market-cap leader among exact ticker peers';
  }
  return `${Number(tickerPeers?.count) || 0} exact ticker peers`;
}


function resolveTickerPeerAgeMs(
  item: NonNullable<NonNullable<ManualTokenEntry['tickerPeers']>['items']>[number],
) {
  const ageMsAtAlert = Number(item.ageMsAtAlert);
  if (Number.isFinite(ageMsAtAlert) && ageMsAtAlert >= 0) {
    return ageMsAtAlert;
  }

  const tokenCreatedAt = Number(item.tokenCreatedAt);
  if (Number.isFinite(tokenCreatedAt) && tokenCreatedAt > 0) {
    return Math.max(0, Date.now() - tokenCreatedAt);
  }

  return null;
}

function buildTickerPeerAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'alert-avatar';
    image.dataset.tokenImagePreview = 'true';
    image.dataset.tokenImagePreviewSrc = imageUrl;
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'alert-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildTickerPeerList(
  tickerPeers: ManualTokenEntry['tickerPeers'],
  overrideItems?: TickerPeerListItem[],
) {
  const list = document.createElement('div');
  list.className = 'alert-ticker-peers-list monitored-ticker-peers-list';
  const items = overrideItems
    ?? (Array.isArray(tickerPeers?.items) ? tickerPeers.items : []);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'alert-ticker-peers-row';

    const identity = document.createElement('div');
    identity.className = 'alert-ticker-peers-identity';
    identity.append(buildTickerPeerAvatar(String(item.symbol || '?'), sanitizeOptionalHttpUrl(item.imageUrl)));

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
    symbol.append(symbolText, ...buildTickerPeerRowBadges(tickerPeers, item.address));

    const address = document.createElement('div');
    address.className = 'alert-ticker-peers-address';
    address.textContent = `${item.address.slice(0, 4)}...${item.address.slice(-4)}`;

    identityText.append(symbol, address);
    identity.append(identityText, copy);

    const stats = document.createElement('div');
    stats.className = 'alert-ticker-peers-stats';
    const mcapLabel = buildTickerPeerMcapLabel(
      item, tickerPeers?.chain === 'robinhood' ? 'FDV' : 'Market cap',
    );
    const separator = document.createElement('span');
    separator.textContent = ' • ';
    const ageMs = resolveTickerPeerAgeMs(item);
    const age = document.createElement('span');
    age.className = `alert-ticker-peers-age ${getAgeToneClassFromAgeMs(ageMs)}`;
    age.textContent = fmtAgeFromDurationMs(ageMs);
    stats.append(mcapLabel, separator, age);

    row.append(identity, stats);
    list.append(row);
  }

  return list;
}

function buildTickerPeerRowBadges(tickerPeers: ManualTokenEntry['tickerPeers'], address: string) {
  const normalizedAddress = String(address || '').trim();
  const badges: HTMLElement[] = [];
  if (normalizedAddress && normalizedAddress === String(tickerPeers?.oldestExactAddress || '').trim()) {
    badges.push(buildTickerPeerRowBadge('OG', 'og', 'Oldest exact ticker match'));
  }
  if (normalizedAddress && normalizedAddress === String(tickerPeers?.highestMcapExactAddress || '').trim()) {
    const title = tickerPeers?.chain === 'robinhood'
      ? 'FDV leader among exact ticker peers'
      : 'Market-cap leader among exact ticker peers';
    badges.push(buildTickerPeerRowBadge('#1', 'mcap_leader', title));
  }
  return badges;
}

function buildTickerPeerRowBadge(label: string, role: 'og' | 'mcap_leader', title: string) {
  const badge = document.createElement('span');
  badge.className = 'alert-ticker-peers-row-badge';
  badge.dataset.peerRole = role;
  badge.title = title;
  badge.textContent = label;
  return badge;
}

export function buildTickerPeerBadge(
  tickerPeers: ManualTokenEntry['tickerPeers'],
  chain?: TokenChain | null,
  address?: string | null,
) {
  if (!tickerPeers || (Number(tickerPeers.count) || 0) <= 1) {
    return null;
  }

  const role = resolveTickerPeerRole(tickerPeers);
  const details = document.createElement('details');
  details.className = 'alert-ticker-peers-panel monitored-ticker-peers-panel';
  const peerChain = normalizeTokenChain(chain) || 'solana';
  const identity = address ? buildTokenIdentityKey(peerChain, address) : '';
  if (identity) {
    // Read back when the panel opens, to swap the embedded excerpt for the full list.
    details.dataset.peerChain = peerChain;
    details.dataset.peerAddress = address || '';
  }

  const summary = document.createElement('summary');
  summary.className = 'monitored-ticker-peer-badge';
  summary.dataset.peerRole = role;
  summary.title = getTickerPeerBadgeTitle(tickerPeers, role);
  summary.textContent = getTickerPeerBadgeMark(role);

  const cached = readCachedTickerPeers(identity);
  details.append(summary, buildTickerPeerList(cached ?? tickerPeers, cached?.items));
  return details;
}

const tickerPeerListCache = new Map<string, { payload: TickerPeerListPayload; fetchedAt: number }>();
const tickerPeerListPending = new Set<string>();

/**
 * The market caps in this list are exactly the kind of value that goes stale, so
 * the cache only spares the user a refetch while reopening the same panel.
 */
function readCachedTickerPeers(identity: string) {
  const entry = identity ? tickerPeerListCache.get(identity) : undefined;
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.fetchedAt > TICKER_PEERS_CACHE_TTL_MS) {
    tickerPeerListCache.delete(identity);
    return undefined;
  }
  return entry.payload;
}

/**
 * The polled payload only carries an excerpt of the peers, so the panel asks for
 * the full list the first time it is opened and reuses it from then on.
 */
function loadFullTickerPeerList(panel: HTMLDetailsElement) {
  const chain = normalizeTokenChain(panel.dataset.peerChain);
  const address = panel.dataset.peerAddress;
  if (!chain || !address) {
    return;
  }

  const identity = buildTokenIdentityKey(chain, address);
  if (readCachedTickerPeers(identity) || tickerPeerListPending.has(identity)) {
    return;
  }

  tickerPeerListPending.add(identity);
  panel.dataset.peersLoading = 'true';
  void fetchTickerPeers(chain, address)
    .then((payload) => {
      tickerPeerListCache.set(identity, { payload, fetchedAt: Date.now() });
      applyFullTickerPeerList(panel, payload);
    })
    .catch(() => {
      delete panel.dataset.peersLoading;
    })
    .finally(() => {
      tickerPeerListPending.delete(identity);
    });
}

function applyFullTickerPeerList(panel: HTMLDetailsElement, payload: TickerPeerListPayload) {
  delete panel.dataset.peersLoading;
  const list = panel.querySelector<HTMLElement>('.alert-ticker-peers-list');
  if (!list || !panel.isConnected || !payload.items?.length) {
    return;
  }

  list.replaceChildren(...buildTickerPeerList(payload, payload.items).childNodes);
  positionMonitoredTickerPeerPanel(panel);
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


function buildGlyphButton(
  label: string,
  className: string,
  action: string,
  address: string,
  dataLabel?: string | null,
  disabled = false,
  title?: string,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (dataLabel) {
    button.dataset.label = dataLabel;
  }
  if (title) {
    button.title = title;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function buildManualQuickAddElement(
  address: string,
  chain: TokenChain,
  busy: boolean,
  folders: AppState['data']['manualTokenFolders'],
) {
  const template = document.createElement('template');
  template.innerHTML = renderManualQuickAddAction(escapeHtml(address), busy, folders, chain).trim();
  const element = template.content.firstElementChild;
  if (element instanceof HTMLElement) {
    return element;
  }

  const fallback = buildGlyphButton(
    '+', 'action-glyph manual-quick-add-button', 'manual-quick-add', address, null, busy,
    'Add to manual tokens',
  );
  fallback.dataset.chain = chain;
  return fallback;
}

function buildStarButton(address: string, chain: TokenChain, isStarred: boolean, disabled: boolean) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.dataset.chain = chain;
  button.disabled = disabled;
  button.title = 'Star token';
  button.textContent = isStarred ? '★' : '☆';
  return button;
}
