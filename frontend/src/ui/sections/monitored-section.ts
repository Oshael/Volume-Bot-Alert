import type { AppController } from '../../state/app-controller';
import { getMockTradingPositionView, getMonitoredTokens, type AppState, type ManualTokenEntry } from '../../state/app-state';
import { renderManualTokenEntryForm } from './manual-section';
import { bindCompactSearch, bindCopyButtons, bindMonitoredSortControls, bindPagedMonitoredControls, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtMoney, fmtPct } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { fmtMockSol, resolveLiveMockSolUsdcRate } from '../../utils/mock-trading-display';

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const isCollapsed = state.ui.collapsed.monitored;
  section.className = `panel legacy-panel monitored-panel${isCollapsed ? ' panel-collapsed' : ''}`;
  const sorts = state.ui.monitoredSorts;
  const hasMode = (mode: string) => sorts.some((item) => item.mode === mode);
  const hasCriterion = (mode: string, window: string) => sorts.some((item) => item.mode === mode && item.window === window);
  const monitoredVolActive = hasMode('vol') ? 'active' : '';
  const monitoredMcapActive = hasMode('mcap') ? 'active' : '';
  const monitoredAgeActive = hasMode('age') ? 'active' : '';
  const monitoredVol5m = hasCriterion('vol', '5m') ? 'active' : '';
  const monitoredVol1h = hasCriterion('vol', '1h') ? 'active' : '';
  const monitoredVol6h = hasCriterion('vol', '6h') ? 'active' : '';
  const monitoredVol24h = hasCriterion('vol', '24h') ? 'active' : '';
  const monitoredMcapHighest = hasCriterion('mcap', 'highest') ? 'active' : '';
  const monitoredMcapLowest = hasCriterion('mcap', 'lowest') ? 'active' : '';
  const monitoredAgeNewest = hasCriterion('age', 'newest') ? 'active' : '';
  const monitoredAgeOldest = hasCriterion('age', 'oldest') ? 'active' : '';
  const tracked = [...getMonitoredTokens(state)]
    .filter((item) => item._userManual || !((item.mcap ?? 0) > 0 && (item.mcap ?? 0) < 30000))
    .sort((a, b) => {
      const metric = (entry: ManualTokenEntry, mode: string, window: string) => {
        if (mode === 'age') return entry.createdAt || 0;
        if (mode === 'mcap') return entry.mcap || 0;
        if (window === '1h') return entry.volume1h || 0;
        if (window === '6h') return entry.volume6h || 0;
        if (window === '24h') return entry.volume24h || 0;
        return entry.volume5m || 0;
      };
      for (const criterion of sorts) {
        const aMetric = metric(a, criterion.mode, criterion.window);
        const bMetric = metric(b, criterion.mode, criterion.window);
        const delta = ((criterion.mode === 'age' && criterion.window === 'oldest') || (criterion.mode === 'mcap' && criterion.window === 'lowest'))
          ? aMetric - bMetric
          : bMetric - aMetric;
        if (delta !== 0) return delta;
      }
      const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
      if (createdDelta !== 0) return createdDelta;
      return (b.mcap || 0) - (a.mcap || 0);
    });
  const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
  const searchQuery = String(state.ui.monitoredSearchQuery || '').trim().toLowerCase();
  const filteredTracked = searchQuery
    ? tracked.filter((item) => {
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(searchQuery) || name.includes(searchQuery) || address.includes(searchQuery);
    })
    : tracked;
  const filteredTotalPages = Math.max(1, Math.ceil(filteredTracked.length / safePerPage));
  const filteredSafePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), filteredTotalPages - 1);
  const filteredPageStart = filteredSafePage * safePerPage;
  const pageItems = filteredTracked.slice(filteredPageStart, filteredPageStart + safePerPage);
  if (isCollapsed) {
    section.innerHTML = `
      <div class="panel-header monitored-panel-header">
        <span class="monitored-panel-title">MONITORED<br>TOKENS</span>
        <div class="panel-header-controls monitored-header-controls">
          <div class="monitored-header-top">
            <span class="monitored-token-pill-wrap">
              <span class="panel-header-label">TOKENS</span>
              <span class="count monitored-token-count-pill">${filteredTracked.length}</span>
            </span>
            <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="monitored" aria-label="Expand monitored tokens"><span class="compact-icon-glyph">+</span></button>
          </div>
        </div>
      </div>
    `;
    section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
      controller.toggleSectionCollapsed('monitored');
    });
    return section;
  }
  section.innerHTML = `
    <div class="panel-header monitored-panel-header">
      <span class="monitored-panel-title">MONITORED<br>TOKENS</span>
      <div class="panel-header-controls monitored-header-controls">
        <div class="monitored-header-top">
          <span class="panel-header-label">SORT BY</span>
          <div class="sort-pill-group monitored-sort-group">
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${monitoredVolActive}" data-sort-toggle="monitored-vol">VOL</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${monitoredVol5m}" data-monitored-sort-mode="vol" data-monitored-sort-window="5m">5M</button>
                <button type="button" class="sort-menu-item ${monitoredVol1h}" data-monitored-sort-mode="vol" data-monitored-sort-window="1h">1H</button>
                <button type="button" class="sort-menu-item ${monitoredVol6h}" data-monitored-sort-mode="vol" data-monitored-sort-window="6h">6H</button>
                <button type="button" class="sort-menu-item ${monitoredVol24h}" data-monitored-sort-mode="vol" data-monitored-sort-window="24h">24H</button>
              </div>
            </div>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${monitoredMcapActive}" data-sort-toggle="monitored-mcap">MCAP</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${monitoredMcapHighest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="highest">HIGHEST</button>
                <button type="button" class="sort-menu-item ${monitoredMcapLowest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="lowest">LOWEST</button>
              </div>
            </div>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${monitoredAgeActive}" data-sort-toggle="monitored-age">AGE</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${monitoredAgeNewest}" data-monitored-sort-mode="age" data-monitored-sort-window="newest">NEWEST</button>
                <button type="button" class="sort-menu-item ${monitoredAgeOldest}" data-monitored-sort-mode="age" data-monitored-sort-window="oldest">OLDEST</button>
              </div>
            </div>
          </div>
          <span class="monitored-token-pill-wrap">
            <span class="panel-header-label">TOKENS</span>
            <span class="count monitored-token-count-pill">${filteredTracked.length}</span>
          </span>
        </div>
        <div class="monitored-header-bottom">
          <div class="monitored-inline-pagination">
            <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle monitored-inline-collapse" data-action="toggle-section-collapse" data-section="monitored" aria-label="Collapse monitored tokens"><span class="compact-icon-glyph">−</span></button>
            <div class="compact-search compact-search-fixed ${searchQuery ? 'has-query open' : ''}">
              <button type="button" class="compact-search-toggle" data-action="monitored-search-focus" aria-label="Search monitored tokens">&#128269;</button>
              <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="monitored-search" data-search-input="monitored">
            </div>
            <div class="monitored-inline-controls">
              <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="monitored-per-page" /></label>
              <label class="legacy-mini-field">PAGE <input type="number" min="1" max="${filteredTotalPages}" step="1" data-action="monitored-page-jump" /></label>
              <span class="bucket-page-total">${filteredTotalPages}</span>
              <div class="button-row compact bucket-footer-actions">
                <button type="button" class="action-button small" data-action="monitored-prev" ${filteredSafePage === 0 ? 'disabled' : ''}>Prev</button>
                <button type="button" class="action-button small" data-action="monitored-next" ${filteredSafePage >= filteredTotalPages - 1 ? 'disabled' : ''}>Next</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="monitored-list"></div>
  `;

  const monitoredList = section.querySelector<HTMLElement>('.monitored-list');
  if (monitoredList) {
    if (filteredTracked.length) {
      const mockSolUsdcRate = resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs);
      for (const item of pageItems) {
        monitoredList.append(buildMonitoredRow(
          item,
          state.ui.busy,
          state.data.starredTokens.includes(item.address),
          state.session.role === 'admin',
          state.ui.enabledTradeTerminals,
          getMockTradingPositionView(state, item.address),
          mockSolUsdcRate,
        ));
      }
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const emptyIcon = document.createElement('div');
      emptyIcon.className = 'empty-icon';
      emptyIcon.textContent = '?';
      const emptyText = document.createElement('div');
      emptyText.className = 'empty-text';
      emptyText.textContent = 'No monitored tokens match the current search.';
      emptyState.append(emptyIcon, emptyText);
      monitoredList.append(emptyState);
    }
  }

  section.append(renderManualTokenEntryForm(state, controller));

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
    perPageInput.value = String(safePerPage);
  }
  const pageJumpInput = section.querySelector<HTMLInputElement>('[data-action="monitored-page-jump"]');
  if (pageJumpInput) {
    pageJumpInput.value = String(filteredSafePage + 1);
  }
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('monitored');
  });
  bindMonitoredSearchInput(searchInput, controller);
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindMonitoredSortControls(section, controller);
  bindPagedMonitoredControls(section, controller);
  return section;
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

function buildMonitoredRow(item: ManualTokenEntry, busy: boolean, isStarred: boolean, isAdmin: boolean, enabledTradeTerminals: AppState['ui']['enabledTradeTerminals'], mockTradingPosition: AppState['data']['mockTradingPositionsByAddress'][string] | null, mockSolUsdcRate?: number) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const subtitle = String(item.name || item.label || '');
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = buildXSearchUrl(symbol, item.address);
  const twitterUrl = sanitizeOptionalHttpUrl(item.twitterUrl);
  const twitterMeta = getXDestinationMeta(twitterUrl);
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
  if (twitterUrl) {
    actions.append(buildInlineActionLink(twitterMeta.icon, twitterUrl, 'x-profile', twitterMeta.title));
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
  appendMonitoredMockTradingLine(main, mockTradingPosition, mockSolUsdcRate);

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

  article.append(main, side);
  return article;
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
  mockSolUsdcRate?: number,
) {
  if (!mockTradingPosition) {
    return;
  }
  const pnl = mockTradingPosition.unrealizedPnlUsd ?? null;
  const pct = mockTradingPosition.priceReturnPct ?? mockTradingPosition.unrealizedPnlPct ?? null;
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

function isXCommunityUrl(url: string | null | undefined) {
  const value = String(url || '').trim().toLowerCase();
  return value.includes('x.com/i/communities/') || value.includes('twitter.com/i/communities/');
}

function getXDestinationMeta(url: string | null | undefined) {
  if (isXCommunityUrl(url)) {
    return {
      title: 'X community',
      icon: '👥',
    };
  }

  return {
    title: 'X profile',
    icon: '👤',
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
