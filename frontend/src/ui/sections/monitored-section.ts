import type { AppController } from '../../state/app-controller';
import { getMockTradingPositionView, getMonitoredTokens, type AppState, type ManualTokenEntry, type MeteoraEntry } from '../../state/app-state';
import { bindCompactSearch, bindCopyButtons, bindMonitoredSortControls, bindPagedMonitoredControls, bindSparklineHover, bindSparklineRangeControls, bindTokenActions, bindTokenImagePreview, bindTopEdgePageScrollBridge, buildTradeTerminalMenuElement, fmtAge, fmtMoney, fmtPct, getAgeToneClassFromAgeMs, getAgeToneClassFromCreatedAt, renderManualQuickAddAction, renderMeteoraCell, renderSparklineFigure, renderSparklineRangeControl, renderTokenLaunchpadBadge } from './shared';
import { escapeHtml, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { fmtMockSol, resolveLiveMockSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';
import { resolveMonitoredTableRows } from '../../utils/token-table';

const TICKER_PEERS_PANEL_GAP_PX = 8;
const TICKER_PEERS_VIEWPORT_MARGIN_PX = 12;
const TICKER_PEERS_MAX_HEIGHT_PX = 360;
const TICKER_PEERS_MIN_HEIGHT_PX = 120;
const MONITORED_PIN_CLICK_DELAY_MS = 320;
const MONITORED_PIN_DRAG_THRESHOLD_PX = 10;
const MONITORED_PIN_DROP_DIRECTION_DEADZONE_PX = 6;
const MONITORED_PIN_DROP_PREVIEW_BIAS_RATIO = 0.26;
const MONITORED_PIN_DROP_VISUAL_SETTLE_MS = 80;

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const view = resolveMonitoredSectionView(state);
  section.className = `panel legacy-panel monitored-panel${view.isCollapsed ? ' panel-collapsed' : ''}${view.miniChartEnabled ? ' monitored-panel-mini-chart-enabled' : ''}`;
  section.innerHTML = view.isCollapsed
    ? renderCollapsedMonitoredHeader(view.filteredTracked.length, view.pinCount)
    : renderExpandedMonitoredMarkup(state, view);

  if (view.isCollapsed) {
    bindMonitoredCollapseToggle(section, controller);
    bindMonitoredPinControls(section, state, controller);
    return section;
  }

  renderMonitoredRows(section, state, view.pageItems);
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
    isCollapsed: state.ui.collapsed.monitored,
    searchQuery,
    safePerPage,
    filteredTracked,
    filteredTotalPages,
    filteredSafePage,
    pageItems: filteredTracked.slice(filteredPageStart, filteredPageStart + safePerPage),
    sortClasses: resolveMonitoredSortClasses(state),
    miniChartEnabled: state.ui.livePanelLayout.spans.monitored > 1,
    pinCount: state.data.pinnedMonitoredTokenAddresses.length,
  };
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
      <span class="monitored-panel-title">MONITORED<br>TOKENS</span>
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

function renderExpandedMonitoredMarkup(state: AppState, view: MonitoredSectionView) {
  const sortClasses = view.sortClasses;
  return `
    <div class="panel-header monitored-panel-header">
      <span class="monitored-panel-title">MONITORED<br>TOKENS</span>
      <div class="panel-header-controls monitored-header-controls">
        <div class="monitored-header-top">
          <span class="panel-header-label">SORT BY</span>
          <div class="sort-pill-group monitored-sort-group">
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${sortClasses.volActive}" data-sort-toggle="monitored-vol">VOL</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${sortClasses.vol5m}" data-monitored-sort-mode="vol" data-monitored-sort-window="5m">5M</button>
                <button type="button" class="sort-menu-item ${sortClasses.vol1h}" data-monitored-sort-mode="vol" data-monitored-sort-window="1h">1H</button>
                <button type="button" class="sort-menu-item ${sortClasses.vol6h}" data-monitored-sort-mode="vol" data-monitored-sort-window="6h">6H</button>
                <button type="button" class="sort-menu-item ${sortClasses.vol24h}" data-monitored-sort-mode="vol" data-monitored-sort-window="24h">24H</button>
              </div>
            </div>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${sortClasses.mcapActive}" data-sort-toggle="monitored-mcap">MCAP</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${sortClasses.mcapHighest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="highest">HIGHEST</button>
                <button type="button" class="sort-menu-item ${sortClasses.mcapLowest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="lowest">LOWEST</button>
              </div>
            </div>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${sortClasses.ageActive}" data-sort-toggle="monitored-age">AGE</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${sortClasses.ageNewest}" data-monitored-sort-mode="age" data-monitored-sort-window="newest">NEWEST</button>
                <button type="button" class="sort-menu-item ${sortClasses.ageOldest}" data-monitored-sort-mode="age" data-monitored-sort-window="oldest">OLDEST</button>
              </div>
            </div>
          </div>
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

function renderMonitoredRows(section: ParentNode, state: AppState, pageItems: ManualTokenEntry[]) {
  const monitoredList = section.querySelector<HTMLElement>('.monitored-list');
  if (!monitoredList) {
    return;
  }

  if (pageItems.length === 0) {
    monitoredList.append(buildMonitoredEmptyState());
    return;
  }

  const mockSolUsdcRate = resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs);
  for (const item of pageItems) {
    monitoredList.append(buildMonitoredRow(
      item,
      state.data.manualTokenFolders,
      state.ui.busy,
      state.data.starredTokens.includes(item.address),
      state.session.role === 'admin',
      state.ui.enabledTradeTerminals,
      state.ui.livePanelLayout.spans.monitored > 1 ? state.data.sparklineByAddress[item.address] || null : null,
      state.ui.livePanelLayout.spans.monitored > 1,
      getMockTradingPositionView(state, item.address),
      state.data.mockTradingTradesByAddress[item.address],
      mockSolUsdcRate,
    ));
  }
}

function buildMonitoredEmptyState() {
  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  const emptyIcon = document.createElement('div');
  emptyIcon.className = 'empty-icon';
  emptyIcon.textContent = '?';
  const emptyText = document.createElement('div');
  emptyText.className = 'empty-text';
  emptyText.textContent = 'No monitored tokens match the current search.';
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
  bindSparklineRangeControls(section, controller);
  bindMonitoredTickerPeerPanelClose(section);
  bindMonitoredSortControls(section, controller);
  bindPagedMonitoredControls(section, controller);
  bindMonitoredPinControls(section, state, controller);
}

type MonitoredPinClickDraft = {
  address: string;
  pinned: boolean;
  timer: ReturnType<typeof window.setTimeout>;
};

type MonitoredPinDropTarget = {
  centerY: number;
};

type MonitoredPinDragDraft = {
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
  const registerPinTap = (address: string, pinned: boolean) => {
    if (pendingClick?.address === address) {
      window.clearTimeout(pendingClick.timer);
      pendingClick = null;
      if (pinned) {
        void controller.unpinMonitoredToken(address);
        dispatchMonitoredPinCommit(section);
      }
      return;
    }

    if (pendingClick) window.clearTimeout(pendingClick.timer);
    const timer = window.setTimeout(() => {
      pendingClick = null;
      if (!pinned) {
        void controller.pinMonitoredToken(address, 0);
        dispatchMonitoredPinCommit(section);
      }
    }, MONITORED_PIN_CLICK_DELAY_MS);
    pendingClick = { address, pinned, timer };
  };

  section.addEventListener('click', (event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.detail !== 0) return;
    const handle = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.monitored-pin-handle');
    const address = handle?.dataset.address || '';
    if (handle && address) registerPinTap(address, handle.dataset.pinned === 'true');
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
      const position = resolveMonitoredAbsoluteDropPosition(state, draft.address, draft.previewIndex);
      void controller.pinMonitoredToken(draft.address, position);
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
    if (!wasDrag) registerPinTap(completedDraft.address, completedDraft.handle.dataset.pinned === 'true');
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
    if (!handle || !row || !list || !address) return;

    const rect = row.getBoundingClientRect();
    dragDraft = {
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

function resolveMonitoredAbsoluteDropPosition(state: AppState, address: string, previewIndex: number) {
  const fullRows = resolveMonitoredTableRows(getMonitoredTokens(state), {
    searchQuery: '',
    sortCriteria: state.ui.monitoredSorts,
  }).map((item) => item.address).filter((item) => item !== address);
  const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
  const searchQuery = String(state.ui.monitoredSearchQuery || '').trim().toLowerCase();
  const filteredRows = resolveMonitoredTableRows(getMonitoredTokens(state), {
    searchQuery,
    sortCriteria: state.ui.monitoredSorts,
  }).map((item) => item.address).filter((item) => item !== address);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), totalPages - 1);
  const requestedIndex = Math.min(Math.max(0, (safePage * safePerPage) + previewIndex), filteredRows.length);
  const nextAddress = filteredRows[requestedIndex];
  const previousAddress = filteredRows[requestedIndex - 1];
  const nextIndex = nextAddress ? fullRows.indexOf(nextAddress) : -1;
  if (nextIndex >= 0) return nextIndex;
  const previousIndex = previousAddress ? fullRows.indexOf(previousAddress) : -1;
  return previousIndex >= 0 ? previousIndex + 1 : 0;
}

function bindMonitoredTickerPeerPanelClose(section: ParentNode) {
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

function buildMonitoredRow(item: ManualTokenEntry, manualTokenFolders: AppState['data']['manualTokenFolders'], busy: boolean, isStarred: boolean, isAdmin: boolean, enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'], sparkline: AppState['data']['sparklineByAddress'][string] | null, miniChartEnabled: boolean, mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null, mockTradingTrades: AppState['data']['mockTradingTradesByAddress'][string] = [], mockSolUsdcRate?: number) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const subtitle = String(item.name || item.label || '');
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = buildXSearchUrl(symbol, item.address);
  const socialLinks = splitTokenSocialUrls(item.twitterUrl, item.communityUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const ageToneClass = getAgeToneClassFromCreatedAt(item.createdAt);
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const volDeltaBaseline = item.prevVolume5mCanonical ?? null;
  const volDelta = volDeltaBaseline && volDeltaBaseline > 0 && item.volume5m != null
    ? ((item.volume5m - volDeltaBaseline) / volDeltaBaseline) * 100
    : null;
  const article = document.createElement('article');
  article.className = buildMonitoredRowClassName(isStarred, Boolean(item._isPinnedMonitored));
  article.dataset.hoverKey = `monitored:${item.address}`;
  article.dataset.address = item.address;

  article.append(buildMonitoredPinHandle(item));
  article.append(buildMonitoredAvatar(symbol, imageUrl, item.address));

  const main = document.createElement('div');
  main.className = 'panel-row-main monitored-row-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'panel-row-title monitored-title-line';
  const tokenName = document.createElement('a');
  tokenName.className = 'token-name';
  tokenName.href = dexUrl;
  tokenName.target = '_blank';
  tokenName.rel = 'noreferrer';
  tokenName.textContent = symbol;
  const tickerPeerBadge = buildTickerPeerBadge(item.tickerPeers);
  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = subtitle;
  titleLine.append(...[tokenName, tokenAddr, tickerPeerBadge].filter((item): item is HTMLElement => Boolean(item)));

  const metaLine = document.createElement('div');
  metaLine.className = 'panel-row-meta monitored-meta-line';
  metaLine.append(
    buildMetaMetric('MCAP', fmtMoney(item.mcap)),
    buildMetaMetric('AGE', age, ageToneClass),
    buildMetaMetric('VOL 1H', fmtMoney(item.volume1h)),
    buildMetaMetric('VOL 6H', fmtMoney(item.volume6h)),
    buildMetaMetric('VOL 24H', fmtMoney(item.volume24h)),
    buildMetaMetric('METEORA', buildMonitoredMeteoraPoolValue(item)),
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
    buildTradeTerminalMenuElement(item.address, item.mintAddress, item.pairAddress, {
      enabledTradeTerminals,
    }),
    buildManualQuickAddElement(item.address, busy, manualTokenFolders),
    buildStarButton(item.address, isStarred, busy),
    buildGlyphButton('⊗', 'action-glyph danger-glyph', 'block-token', item.address, symbol, busy, 'Block token'),
  );
  appendMonitoredAdminActions(actions, item, symbol, busy, isAdmin, mockTradingPosition);

  main.append(titleLine, metaLine, actions);
  appendMonitoredMockTradingLine(main, mockTradingPosition, mockTradingTrades, mockSolUsdcRate);

  const side = document.createElement('div');
  side.className = 'panel-row-side monitored-side-v68';
  const volLabel = document.createElement('div');
  volLabel.className = 'vol5m-label';
  volLabel.textContent = 'VOL 5M';
  const mainMetric = document.createElement('div');
  mainMetric.className = 'panel-main-metric monitored-main-metric';
  mainMetric.textContent = fmtMoney(item.volume5m);
  const delta = document.createElement('div');
  delta.className = `panel-side-delta ${volDelta != null && volDelta < 0 ? 'down' : 'up'}`;
  delta.textContent = fmtPct(volDelta);
  side.append(volLabel, mainMetric, delta);

  article.append(main);
  if (miniChartEnabled) {
    article.append(buildMonitoredMiniChart(item, sparkline));
  }
  article.append(side);
  return article;
}

function buildMonitoredRowClassName(isStarred: boolean, isPinned: boolean) {
  return `token-row monitored-token-row monitored-token-row-v68${isStarred ? ' token-starred' : ''}${isPinned ? ' monitored-token-pinned' : ''}`;
}

function buildMonitoredPinHandle(item: ManualTokenEntry) {
  const pinned = Boolean(item._isPinnedMonitored);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'monitored-pin-handle';
  button.dataset.action = 'monitored-pin-handle';
  button.dataset.address = item.address;
  button.dataset.pinned = String(pinned);
  button.setAttribute('aria-label', pinned ? 'Move pinned token; double click to unpin' : 'Pin or move token');
  button.setAttribute('aria-pressed', String(pinned));
  button.title = pinned ? 'Drag to move; double click to unpin' : 'Click to pin at top; drag to place';
  return button;
}

function buildMonitoredMiniChart(item: ManualTokenEntry, sparkline: AppState['data']['sparklineByAddress'][string] | null) {
  const miniChart = document.createElement('div');
  miniChart.className = 'monitored-mini-chart';
  miniChart.innerHTML = renderSparklineFigure(sparkline, item.address, {
    areaFill: true,
    expandable: true,
    liveMcap: item.mcap,
  });
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

function buildMonitoredAvatar(symbol: string, imageUrl: string | null, address: string) {
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

  wrapper.insertAdjacentHTML('beforeend', renderTokenLaunchpadBadge(address));
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

function buildMonitoredMeteoraPoolValue(item: ManualTokenEntry) {
  const value = document.createElement('span');
  const meteoraEntry = normalizeMonitoredMeteoraEntry(item);
  if (!meteoraEntry) {
    value.textContent = '-';
    return value;
  }

  value.innerHTML = renderMeteoraCell(item.address, meteoraEntry, 0);
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
    change6h: item.meteora.change6h ?? null,
    change24h: item.meteora.change24h ?? null,
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
    return 'Market-cap leader among exact ticker peers';
  }
  return `${Number(tickerPeers?.count) || 0} exact ticker peers`;
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

function buildTickerPeerList(tickerPeers: ManualTokenEntry['tickerPeers']) {
  const list = document.createElement('div');
  list.className = 'alert-ticker-peers-list monitored-ticker-peers-list';
  const items = Array.isArray(tickerPeers?.items) ? tickerPeers.items : [];

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
    const mcapLabel = document.createElement('span');
    mcapLabel.className = 'alert-ticker-peers-mcap';
    mcapLabel.textContent = fmtMoney(item.mcap);
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
    badges.push(buildTickerPeerRowBadge('#1', 'mcap_leader', 'Market-cap leader among exact ticker peers'));
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

function buildTickerPeerBadge(tickerPeers: ManualTokenEntry['tickerPeers']) {
  if (!tickerPeers || (Number(tickerPeers.count) || 0) <= 1) {
    return null;
  }

  const role = resolveTickerPeerRole(tickerPeers);
  const details = document.createElement('details');
  details.className = 'alert-ticker-peers-panel monitored-ticker-peers-panel';

  const summary = document.createElement('summary');
  summary.className = 'monitored-ticker-peer-badge';
  summary.dataset.peerRole = role;
  summary.title = getTickerPeerBadgeTitle(tickerPeers, role);
  summary.textContent = getTickerPeerBadgeMark(role);

  details.append(summary, buildTickerPeerList(tickerPeers));
  return details;
}

function buildXSearchUrl(symbol: string, address: string) {
  const queryParts = [String(address || '').trim(), `$${String(symbol || '').trim()}`]
    .filter(Boolean);
  return `https://x.com/search?q=${encodeURIComponent(queryParts.join(' OR '))}`;
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
  busy: boolean,
  folders: AppState['data']['manualTokenFolders'],
) {
  const template = document.createElement('template');
  template.innerHTML = renderManualQuickAddAction(escapeHtml(address), busy, folders).trim();
  const element = template.content.firstElementChild;
  if (element instanceof HTMLElement) {
    return element;
  }

  return buildGlyphButton('+', 'action-glyph manual-quick-add-button', 'manual-quick-add', address, null, busy, 'Add to manual tokens');
}

function buildStarButton(address: string, isStarred: boolean, disabled: boolean) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.disabled = disabled;
  button.title = 'Star token';
  button.textContent = isStarred ? '★' : '☆';
  return button;
}
