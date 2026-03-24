import type { AppController } from '../../state/app-controller';
import { getOldWeekTokens, getRecentTokens, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindPagedBucketControls, bindTokenActions, fmtConfig, renderLogSummary, renderPagedAgeBucketList } from './shared';

export function renderRecentSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar recent-bar';
  const min = fmtConfig(state, 'old-mcap-min', 120000);
  const max = fmtConfig(state, 'old-mcap-max', 100000000);
  const recentSorts = state.ui.recentSorts;
  const hasRecentMode = (mode: string) => recentSorts.some((item) => item.mode === mode);
  const hasRecentCriterion = (mode: string, window: string) => recentSorts.some((item) => item.mode === mode && item.window === window);
  const recentVolActive = hasRecentMode('vol') ? 'active' : '';
  const recentMcapActive = hasRecentMode('mcap') ? 'active' : '';
  const recentPchangeActive = hasRecentMode('pchange') ? 'active' : '';
  const recentAgeActive = hasRecentMode('age') ? 'active' : '';
  const recentVol1h = hasRecentCriterion('vol', '1h') ? 'active' : '';
  const recentVol6h = hasRecentCriterion('vol', '6h') ? 'active' : '';
  const recentVol24h = hasRecentCriterion('vol', '24h') ? 'active' : '';
  const recentMcapHighest = hasRecentCriterion('mcap', 'highest') ? 'active' : '';
  const recentMcapLowest = hasRecentCriterion('mcap', 'lowest') ? 'active' : '';
  const recentPchange1h = hasRecentCriterion('pchange', '1h') ? 'active' : '';
  const recentPchange6h = hasRecentCriterion('pchange', '6h') ? 'active' : '';
  const recentPchange24h = hasRecentCriterion('pchange', '24h') ? 'active' : '';
  const recentAgeNewest = hasRecentCriterion('age', 'newest') ? 'active' : '';
  const recentAgeOldest = hasRecentCriterion('age', 'oldest') ? 'active' : '';
  const recentSearchQuery = String(state.ui.recentSearchQuery || '').trim().toLowerCase();
  const filteredRecentTokens = getRecentTokens(state).filter((item) => {
    if (state.ui.recentStarredOnly && !state.data.starredTokens.includes(item.address)) {
      return false;
    }
    if (!recentSearchQuery) {
      return true;
    }
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(recentSearchQuery) || name.includes(recentSearchQuery) || address.includes(recentSearchQuery);
    });
  const safeRecentPerPage = Math.max(10, Math.floor(state.ui.recentPerPage) || 30);
  const recentTotalPages = Math.max(1, Math.ceil(filteredRecentTokens.length / safeRecentPerPage));
  const safeRecentPage = Math.min(Math.max(0, Math.floor(state.ui.recentPage) || 0), recentTotalPages - 1);
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title recent"><span class="recent-live-emoji ${state.runtime.mode === 'active' ? 'live' : ''}">\u{1F7E2}</span> RECENT TOKENS</span>
        ${renderLogSummary('Recent Removal Log', state.data.recentRemovalLog, 'clear-recent-log', 'recent')}
      </div>
      <div class="legacy-bar-controls">
        <div class="compact-search ${recentSearchQuery ? 'has-query' : ''}">
          <button type="button" class="compact-search-toggle" data-action="recent-search-focus" aria-label="Search recent tokens">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="recent-search" data-search-input="recent">
        </div>
        <button type="button" class="compact-icon-toggle ${state.ui.recentStarredOnly ? 'active' : ''}" data-action="recent-starred-only" aria-label="Show only starred recent tokens"><span class="compact-icon-glyph">&#9733;</span></button>
        <label class="legacy-mini-field">MCAP MIN <input type="number" name="old-mcap-min"></label>
        <label class="legacy-mini-field">MCAP MAX <input type="number" name="old-mcap-max"></label>
        <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="recent-per-page" /></label>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${recentVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${recentVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentMcapActive}" data-sort-toggle="mcap">MCAP</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${recentMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${recentPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${recentPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${recentAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">1d - 7d &middot; recent</span>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      filteredRecentTokens,
      state.ui.busy,
      'recent',
      state.ui.recentPage,
      state.ui.recentPerPage,
      state.data.starredTokens,
      state.ui.recentSorts,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin',
    )}
  `;
  bindCompactSearch(section, {
    toggleAction: 'recent-search-focus',
    inputAction: 'recent-search',
  });
  const recentSearchInput = section.querySelector<HTMLInputElement>('[data-action="recent-search"]');
  if (recentSearchInput) {
    recentSearchInput.value = state.ui.recentSearchQuery || '';
  }
  const recentMinInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-min"]');
  if (recentMinInput) {
    recentMinInput.value = String(min);
  }
  const recentMaxInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-max"]');
  if (recentMaxInput) {
    recentMaxInput.value = String(max);
  }
  const recentPerPageInput = section.querySelector<HTMLInputElement>('[data-action="recent-per-page"]');
  if (recentPerPageInput) {
    recentPerPageInput.value = String(safeRecentPerPage);
  }
  const recentPageJumpInput = section.querySelector<HTMLInputElement>('[data-action="recent-page-jump"]');
  if (recentPageJumpInput) {
    recentPageJumpInput.value = String(safeRecentPage + 1);
  }
  recentSearchInput?.addEventListener('input', (event) => {
    controller.setRecentSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="recent-starred-only"]')?.addEventListener('click', () => {
    controller.setRecentStarredOnly(!state.ui.recentStarredOnly);
  });
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindPagedBucketControls(section, controller, 'recent');
  bindBucketSortControls(section, controller, 'recent');
  section.querySelectorAll<HTMLInputElement>('input[name="old-mcap-min"], input[name="old-mcap-max"]').forEach((input) => {
    input.addEventListener('change', () => {
      const minInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-min"]');
      const maxInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-max"]');
      void controller.saveMonitoringConfig({
        'old-mcap-min': Number(minInput?.value || 120000),
        'old-mcap-max': Number(maxInput?.value || 100000000),
      });
    });
  });
  section.querySelector<HTMLButtonElement>('[data-action="clear-recent-log"]')?.addEventListener('click', () => controller.clearRecentRemovalLog());
  return section;
}

export function renderOldWeekSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar old-week-bar';
  const min = fmtConfig(state, 'old-week-mcap-min', 120000);
  const max = fmtConfig(state, 'old-week-mcap-max', 100000000);
  const oldWeekSorts = state.ui.oldWeekSorts;
  const hasOldWeekMode = (mode: string) => oldWeekSorts.some((item) => item.mode === mode);
  const hasOldWeekCriterion = (mode: string, window: string) => oldWeekSorts.some((item) => item.mode === mode && item.window === window);
  const oldWeekVolActive = hasOldWeekMode('vol') ? 'active' : '';
  const oldWeekMcapActive = hasOldWeekMode('mcap') ? 'active' : '';
  const oldWeekPchangeActive = hasOldWeekMode('pchange') ? 'active' : '';
  const oldWeekAgeActive = hasOldWeekMode('age') ? 'active' : '';
  const oldWeekVol1h = hasOldWeekCriterion('vol', '1h') ? 'active' : '';
  const oldWeekVol6h = hasOldWeekCriterion('vol', '6h') ? 'active' : '';
  const oldWeekVol24h = hasOldWeekCriterion('vol', '24h') ? 'active' : '';
  const oldWeekMcapHighest = hasOldWeekCriterion('mcap', 'highest') ? 'active' : '';
  const oldWeekMcapLowest = hasOldWeekCriterion('mcap', 'lowest') ? 'active' : '';
  const oldWeekPchange1h = hasOldWeekCriterion('pchange', '1h') ? 'active' : '';
  const oldWeekPchange6h = hasOldWeekCriterion('pchange', '6h') ? 'active' : '';
  const oldWeekPchange24h = hasOldWeekCriterion('pchange', '24h') ? 'active' : '';
  const oldWeekAgeNewest = hasOldWeekCriterion('age', 'newest') ? 'active' : '';
  const oldWeekAgeOldest = hasOldWeekCriterion('age', 'oldest') ? 'active' : '';
  const oldWeekSearchQuery = String(state.ui.oldWeekSearchQuery || '').trim().toLowerCase();
  const filteredOldWeekTokens = getOldWeekTokens(state).filter((item) => {
    if (state.ui.oldWeekStarredOnly && !state.data.starredTokens.includes(item.address)) {
      return false;
    }
    if (!oldWeekSearchQuery) {
      return true;
    }
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(oldWeekSearchQuery) || name.includes(oldWeekSearchQuery) || address.includes(oldWeekSearchQuery);
    });
  const safeOldWeekPerPage = Math.max(10, Math.floor(state.ui.oldWeekPerPage) || 30);
  const oldWeekTotalPages = Math.max(1, Math.ceil(filteredOldWeekTokens.length / safeOldWeekPerPage));
  const safeOldWeekPage = Math.min(Math.max(0, Math.floor(state.ui.oldWeekPage) || 0), oldWeekTotalPages - 1);
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title old-week">\u{1F4C5} OLD TOKENS 1 WEEK+</span>
        ${renderLogSummary('Old Week Removal Log', state.data.oldWeekRemovalLog, 'clear-old-week-log', 'old-week')}
      </div>
      <div class="legacy-bar-controls">
        <div class="compact-search ${oldWeekSearchQuery ? 'has-query' : ''}">
          <button type="button" class="compact-search-toggle" data-action="old-week-search-focus" aria-label="Search old tokens">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="old-week-search" data-search-input="old-week">
        </div>
        <button type="button" class="compact-icon-toggle ${state.ui.oldWeekStarredOnly ? 'active' : ''}" data-action="old-week-starred-only" aria-label="Show only starred old tokens"><span class="compact-icon-glyph">&#9733;</span></button>
        <label class="legacy-mini-field">MCAP MIN <input type="number" name="old-week-mcap-min"></label>
        <label class="legacy-mini-field">MCAP MAX <input type="number" name="old-week-mcap-max"></label>
        <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="old-week-per-page" /></label>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${oldWeekVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${oldWeekVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekMcapActive}" data-sort-toggle="mcap">MCAP</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${oldWeekMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${oldWeekPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${oldWeekPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${oldWeekAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">7d+ &middot; no max age</span>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      filteredOldWeekTokens,
      state.ui.busy,
      'old-week',
      state.ui.oldWeekPage,
      state.ui.oldWeekPerPage,
      state.data.starredTokens,
      state.ui.oldWeekSorts,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin',
    )}
  `;
  bindCompactSearch(section, {
    toggleAction: 'old-week-search-focus',
    inputAction: 'old-week-search',
  });
  const oldWeekSearchInput = section.querySelector<HTMLInputElement>('[data-action="old-week-search"]');
  if (oldWeekSearchInput) {
    oldWeekSearchInput.value = state.ui.oldWeekSearchQuery || '';
  }
  const oldWeekMinInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-min"]');
  if (oldWeekMinInput) {
    oldWeekMinInput.value = String(min);
  }
  const oldWeekMaxInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-max"]');
  if (oldWeekMaxInput) {
    oldWeekMaxInput.value = String(max);
  }
  const oldWeekPerPageInput = section.querySelector<HTMLInputElement>('[data-action="old-week-per-page"]');
  if (oldWeekPerPageInput) {
    oldWeekPerPageInput.value = String(safeOldWeekPerPage);
  }
  const oldWeekPageJumpInput = section.querySelector<HTMLInputElement>('[data-action="old-week-page-jump"]');
  if (oldWeekPageJumpInput) {
    oldWeekPageJumpInput.value = String(safeOldWeekPage + 1);
  }
  oldWeekSearchInput?.addEventListener('input', (event) => {
    controller.setOldWeekSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="old-week-starred-only"]')?.addEventListener('click', () => {
    controller.setOldWeekStarredOnly(!state.ui.oldWeekStarredOnly);
  });
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindPagedBucketControls(section, controller, 'old-week');
  bindBucketSortControls(section, controller, 'old-week');
  section.querySelectorAll<HTMLInputElement>('input[name="old-week-mcap-min"], input[name="old-week-mcap-max"]').forEach((input) => {
    input.addEventListener('change', () => {
      const minInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-min"]');
      const maxInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-max"]');
      void controller.saveMonitoringConfig({
        'old-week-mcap-min': Number(minInput?.value || 120000),
        'old-week-mcap-max': Number(maxInput?.value || 100000000),
      });
    });
  });
  section.querySelector<HTMLButtonElement>('[data-action="clear-old-week-log"]')?.addEventListener('click', () => controller.clearOldWeekRemovalLog());
  return section;
}
