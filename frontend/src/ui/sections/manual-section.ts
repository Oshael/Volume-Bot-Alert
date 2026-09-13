import type { AppController } from '../../state/app-controller';
import { getChainCapabilityNotice, getWatchlistTokens, getMockTradingPositionsViewByAddress, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindSparklineHover, bindTokenActions, bindTokenImagePreview, renderWatchlistTokenTable } from './shared';
import { bindMonitoredTickerPeerPanelClose } from './monitored-section';
import { bindRadarIdentityBadges } from './radar-identity-badges';
import { resolveWatchlistTableRows } from '../../utils/token-table';
import { resolveLiveMockSolUsdcRate } from '../../utils/mock-trading-display';
import { escapeHtml } from './html-safety';
import { bindRobinhoodHolderHover } from '../robinhood-holder-hover';

export function renderWatchlistSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.id = 'watchlist-section';
  section.className = 'legacy-token-bar manual-bar';
  const capabilityNotice = getChainCapabilityNotice(state, 'watchlist');
  if (capabilityNotice) {
    section.innerHTML = `
      <div class="legacy-bar-head">
        <span class="legacy-bar-title manual">&#9733; WATCHLIST</span>
        <span class="count-pill">0</span>
      </div>
      <p class="chain-readiness-empty" data-chain-readiness-surface="watchlist">${escapeHtml(capabilityNotice)}</p>
    `;
    return section;
  }
  const isCollapsed = state.ui.collapsed.manual;
  const sortClasses = getManualSortClasses(state);
  const searchQuery = String(state.ui.watchlistSearchQuery || '').trim();
  const watchlistTableMarkup = renderWatchlistTable(state, searchQuery);
  if (isCollapsed) {
    section.innerHTML = `
      <div class="legacy-bar-head legacy-bar-head-collapsed">
        <div class="legacy-bar-title-wrap">
          <span class="legacy-bar-title manual">&#9733; WATCHLIST</span>
        </div>
        <div class="legacy-bar-controls legacy-bar-collapse-controls">
          <span class="count-pill">${getWatchlistTokens(state).length}</span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="manual" aria-label="Expand Watchlist"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    `;
    section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
      controller.toggleSectionCollapsed('manual');
    });
    return section;
  }
  section.innerHTML = `
    <div class="legacy-bar-head">
      <span class="legacy-bar-title manual">&#9733; WATCHLIST</span>
      <div class="legacy-bar-controls">
        <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="manual" aria-label="Collapse Watchlist"><span class="compact-icon-glyph">−</span></button>
        <div class="compact-search ${searchQuery ? 'has-query open' : ''}">
          <button type="button" class="compact-search-toggle" data-action="watchlist-search-focus" aria-label="Search Watchlist">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="watchlist-search" data-search-input="watchlist">
        </div>
        <div class="sort-pill-group compact-sort-cluster">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${sortClasses.manualVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualMcapActive}" data-sort-toggle="mcap">MCAP / FDV</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${sortClasses.manualMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${sortClasses.manualPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${sortClasses.manualAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    ${watchlistTableMarkup}
  `;

  const searchInput = section.querySelector<HTMLInputElement>('[data-action="watchlist-search"]');
  if (searchInput) {
    searchInput.value = state.ui.watchlistSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'watchlist-search-focus',
    inputAction: 'watchlist-search',
  });
  searchInput?.addEventListener('input', (event) => {
    controller.setWatchlistSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('manual');
  });
  bindRadarIdentityBadges(section, getWatchlistTokens(state));
  bindMonitoredTickerPeerPanelClose(section);
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindTokenImagePreview(section);
  bindRobinhoodHolderHover(section, state.session.token);
  bindBucketSortControls(section, controller, 'manual');
  return section;
}

function getManualSortClasses(state: AppState) {
  const sorts = state.ui.watchlistSorts;
  const hasMode = (mode: string) => sorts.some((item) => item.mode === mode);
  const hasCriterion = (mode: string, window: string) => sorts.some((item) => item.mode === mode && item.window === window);
  return {
    manualVolActive: hasMode('vol') ? 'active' : '',
    manualMcapActive: hasMode('mcap') ? 'active' : '',
    manualPchangeActive: hasMode('pchange') ? 'active' : '',
    manualAgeActive: hasMode('age') ? 'active' : '',
    manualVol1h: hasCriterion('vol', '1h') ? 'active' : '',
    manualVol6h: hasCriterion('vol', '6h') ? 'active' : '',
    manualVol24h: hasCriterion('vol', '24h') ? 'active' : '',
    manualMcapHighest: hasCriterion('mcap', 'highest') ? 'active' : '',
    manualMcapLowest: hasCriterion('mcap', 'lowest') ? 'active' : '',
    manualPchange1h: hasCriterion('pchange', '1h') ? 'active' : '',
    manualPchange6h: hasCriterion('pchange', '6h') ? 'active' : '',
    manualPchange24h: hasCriterion('pchange', '24h') ? 'active' : '',
    manualAgeNewest: hasCriterion('age', 'newest') ? 'active' : '',
    manualAgeOldest: hasCriterion('age', 'oldest') ? 'active' : '',
  };
}

function renderWatchlistTable(state: AppState, searchQuery: string) {
  const filteredWatchlistTokens = resolveWatchlistTableRows(getWatchlistTokens(state), {
    searchQuery,
    sortCriteria: state.ui.watchlistSorts,
  });

  if (filteredWatchlistTokens.length === 0 && getWatchlistTokens(state).length > 0) {
    return '<p class="muted-block">No Watchlist tokens match your search.</p>';
  }

  return renderWatchlistTokenTable(
    filteredWatchlistTokens,
    state.ui.busy,
    state.data.watchlistTokenIdentities,
    state.ui.watchlistSorts,
    state.data.meteoraByAddress,
    Number(state.data.configs['meteora-min-pool']) || 5000,
    state.session.role === 'admin',
    state.ui.enabledTradeTerminals,
    {
      enabledRobinhoodTradeTerminals: state.ui.enabledRobinhoodTradeTerminals,
      showSparkline: true,
      sparklineByAddress: state.data.sparklineByAddress,
      mockTradingPositionsByAddress: getMockTradingPositionsViewByAddress(state),
      mockTradingTradesByAddress: state.data.mockTradingTradesByAddress,
      mockSolUsdcRate: resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs),
    },
  );
}
