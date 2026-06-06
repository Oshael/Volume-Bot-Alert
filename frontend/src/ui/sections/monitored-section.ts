import type { AppController } from '../../state/app-controller';
import { getMockTradingPositionView, getMonitoredTokens, type AppState, type ManualTokenEntry } from '../../state/app-state';
import { renderManualTokenEntryForm } from './manual-section';
import { bindCompactSearch, bindCopyButtons, bindMonitoredSortControls, bindPagedMonitoredControls, bindSparklineHover, bindTokenActions, bindTokenImagePreview, buildTradeTerminalMenuElement, fmtAge, fmtMoney, fmtPct, renderSparklineFigure } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { fmtMockSol, resolveLiveMockSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';
import { resolveMonitoredTableRows } from '../../utils/token-table';

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const view = resolveMonitoredSectionView(state);
  section.className = `panel legacy-panel monitored-panel${view.isCollapsed ? ' panel-collapsed' : ''}${view.miniChartEnabled ? ' monitored-panel-mini-chart-enabled' : ''}`;
  section.innerHTML = view.isCollapsed
    ? renderCollapsedMonitoredHeader(view.filteredTracked.length)
    : renderExpandedMonitoredMarkup(view);

  if (view.isCollapsed) {
    bindMonitoredCollapseToggle(section, controller);
    return section;
  }

  renderMonitoredRows(section, state, view.pageItems);
  section.append(renderManualTokenEntryForm(state, controller));
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

function renderCollapsedMonitoredHeader(count: number) {
  return `
    <div class="panel-header monitored-panel-header">
      <span class="monitored-panel-title">MONITORED<br>TOKENS</span>
      <div class="panel-header-controls monitored-header-controls">
        <div class="monitored-header-top">
          <span class="monitored-token-pill-wrap">
            <span class="panel-header-label">TOKENS</span>
            <span class="count monitored-token-count-pill">${count}</span>
          </span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="monitored" aria-label="Expand monitored tokens"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    </div>
  `;
}

function renderExpandedMonitoredMarkup(view: MonitoredSectionView) {
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
          <span class="monitored-token-pill-wrap">
            <span class="panel-header-label">TOKENS</span>
            <span class="count monitored-token-count-pill">${view.filteredTracked.length}</span>
          </span>
        </div>
        <div class="monitored-header-bottom">
          <div class="monitored-inline-pagination">
            <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle monitored-inline-collapse" data-action="toggle-section-collapse" data-section="monitored" aria-label="Collapse monitored tokens"><span class="compact-icon-glyph">−</span></button>
            <div class="compact-search compact-search-fixed ${view.searchQuery ? 'has-query open' : ''}">
              <button type="button" class="compact-search-toggle" data-action="monitored-search-focus" aria-label="Search monitored tokens">&#128269;</button>
              <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="monitored-search" data-search-input="monitored">
            </div>
            <div class="monitored-inline-controls">
              <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="monitored-per-page" /></label>
              <label class="legacy-mini-field">PAGE <input type="number" min="1" max="${view.filteredTotalPages}" step="1" data-action="monitored-page-jump" /></label>
              <span class="bucket-page-total">${view.filteredTotalPages}</span>
              <div class="button-row compact bucket-footer-actions">
                <button type="button" class="action-button small" data-action="monitored-prev" ${view.filteredSafePage === 0 ? 'disabled' : ''}>Prev</button>
                <button type="button" class="action-button small" data-action="monitored-next" ${view.filteredSafePage >= view.filteredTotalPages - 1 ? 'disabled' : ''}>Next</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="monitored-list"></div>
  `;
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
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindMonitoredSortControls(section, controller);
  bindPagedMonitoredControls(section, controller);
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

function buildMonitoredRow(item: ManualTokenEntry, busy: boolean, isStarred: boolean, isAdmin: boolean, enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'], sparkline: AppState['data']['sparklineByAddress'][string] | null, miniChartEnabled: boolean, mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null, mockTradingTrades: AppState['data']['mockTradingTradesByAddress'][string] = [], mockSolUsdcRate?: number) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const subtitle = String(item.name || item.label || '');
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = buildXSearchUrl(symbol, item.address);
  const socialLinks = splitTokenSocialUrls(item.twitterUrl, item.communityUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const volDeltaBaseline = item.prevVolume5mCanonical ?? null;
  const volDelta = volDeltaBaseline && volDeltaBaseline > 0 && item.volume5m != null
    ? ((item.volume5m - volDeltaBaseline) / volDeltaBaseline) * 100
    : null;
  const article = document.createElement('article');
  article.className = `token-row monitored-token-row monitored-token-row-v68${isStarred ? ' token-starred' : ''}`;
  article.dataset.hoverKey = `monitored:${item.address}`;

  article.append(buildMonitoredAvatar(symbol, imageUrl));

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
  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = subtitle;
  titleLine.append(tokenName, tokenAddr);

  const metaLine = document.createElement('div');
  metaLine.className = 'panel-row-meta monitored-meta-line';
  metaLine.append(
    buildMetaMetric('MCAP', fmtMoney(item.mcap)),
    buildMetaMetric('AGE', age),
    buildMetaMetric('VOL 1H', fmtMoney(item.volume1h)),
    buildMetaMetric('VOL 6H', fmtMoney(item.volume6h)),
    buildMetaMetric('VOL 24H', fmtMoney(item.volume24h)),
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

function buildMonitoredAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'tok-avatar';
    image.dataset.tokenImagePreview = 'true';
    image.dataset.tokenImagePreviewSrc = imageUrl;
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'tok-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
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

function buildMetaMetric(label: string, value: string) {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'meta-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'meta-value';
  valueEl.textContent = value;
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
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
