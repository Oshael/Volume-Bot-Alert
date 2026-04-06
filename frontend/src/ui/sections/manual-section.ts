import type { AppController } from '../../state/app-controller';
import { getManualTokens, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindTokenActions, renderManualTokenTable } from './shared';

export function renderManualTokensSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.id = 'manual-tokens-section';
  section.className = 'legacy-token-bar manual-bar';
  const isCollapsed = state.ui.collapsed.manual;
  const sorts = state.ui.manualSorts;
  const hasMode = (mode: string) => sorts.some((item) => item.mode === mode);
  const hasCriterion = (mode: string, window: string) => sorts.some((item) => item.mode === mode && item.window === window);
  const manualVolActive = hasMode('vol') ? 'active' : '';
  const manualMcapActive = hasMode('mcap') ? 'active' : '';
  const manualPchangeActive = hasMode('pchange') ? 'active' : '';
  const manualAgeActive = hasMode('age') ? 'active' : '';
  const manualVol1h = hasCriterion('vol', '1h') ? 'active' : '';
  const manualVol6h = hasCriterion('vol', '6h') ? 'active' : '';
  const manualVol24h = hasCriterion('vol', '24h') ? 'active' : '';
  const manualMcapHighest = hasCriterion('mcap', 'highest') ? 'active' : '';
  const manualMcapLowest = hasCriterion('mcap', 'lowest') ? 'active' : '';
  const manualPchange1h = hasCriterion('pchange', '1h') ? 'active' : '';
  const manualPchange6h = hasCriterion('pchange', '6h') ? 'active' : '';
  const manualPchange24h = hasCriterion('pchange', '24h') ? 'active' : '';
  const manualAgeNewest = hasCriterion('age', 'newest') ? 'active' : '';
  const manualAgeOldest = hasCriterion('age', 'oldest') ? 'active' : '';
  const searchQuery = String(state.ui.manualSearchQuery || '').trim().toLowerCase();
  const filteredManualTokens = getManualTokens(state).filter((item) => {
    if (state.ui.manualStarredOnly && !state.data.starredTokens.includes(item.address)) {
      return false;
    }
    if (!searchQuery) {
      return true;
    }
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(searchQuery) || name.includes(searchQuery) || address.includes(searchQuery);
    });
  if (isCollapsed) {
    section.innerHTML = `
      <div class="legacy-bar-head legacy-bar-head-collapsed">
        <div class="legacy-bar-title-wrap">
          <span class="legacy-bar-title manual">\u{1F4CC} MANUAL TOKENS</span>
        </div>
        <div class="legacy-bar-controls legacy-bar-collapse-controls">
          <span class="count-pill">${getManualTokens(state).length}</span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="manual" aria-label="Expand manual tokens"><span class="compact-icon-glyph">+</span></button>
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
      <span class="legacy-bar-title manual">\u{1F4CC} MANUAL TOKENS</span>
      <div class="legacy-bar-controls">
        <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="manual" aria-label="Collapse manual tokens"><span class="compact-icon-glyph">−</span></button>
        <div class="compact-search ${searchQuery ? 'has-query open' : ''}">
          <button type="button" class="compact-search-toggle" data-action="manual-search-focus" aria-label="Search manual tokens">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="manual-search" data-search-input="manual">
        </div>
        <button type="button" class="compact-icon-toggle ${state.ui.manualStarredOnly ? 'active' : ''}" data-action="manual-starred-only" aria-label="Show only starred manual tokens"><span class="compact-icon-glyph">&#9733;</span></button>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${manualVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${manualVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${manualVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${manualVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${manualMcapActive}" data-sort-toggle="mcap">MCAP</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${manualMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${manualMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${manualPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${manualPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${manualPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${manualPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${manualAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${manualAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${manualAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">Pinned &middot; always monitored</span>
      </div>
    </div>
    ${renderManualTokenTable(
      filteredManualTokens,
      state.ui.busy,
      state.data.starredTokens,
      state.ui.manualSorts,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin',
      state.ui.enabledTradeTerminals,
    )}
  `;

  const searchInput = section.querySelector<HTMLInputElement>('[data-action="manual-search"]');
  if (searchInput) {
    searchInput.value = state.ui.manualSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'manual-search-focus',
    inputAction: 'manual-search',
  });
  searchInput?.addEventListener('input', (event) => {
    controller.setManualSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="manual-starred-only"]')?.addEventListener('click', () => {
    controller.setManualStarredOnly(!state.ui.manualStarredOnly);
  });
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('manual');
  });
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindBucketSortControls(section, controller, 'manual');
  return section;
}

export function renderManualTokenEntryForm(state: AppState, controller: AppController) {
  const wrap = document.createElement('div');
  wrap.className = 'panel-manual-entry';
  wrap.innerHTML = `
    <form class="manual-token-form panel-manual-form" data-role="manual-token-form">
      <input name="address" type="text" placeholder="Token address (CA)..." required ${state.ui.busy ? 'disabled' : ''} />
      <button type="button" class="legacy-btn legacy-btn-accent" data-action="manual-add" ${state.ui.busy ? 'disabled' : ''}>ADD</button>
    </form>
  `;

  const form = wrap.querySelector<HTMLFormElement>('form[data-role="manual-token-form"]');
  const input = wrap.querySelector<HTMLInputElement>('input[name="address"]');
  const button = wrap.querySelector<HTMLButtonElement>('button[data-action="manual-add"]');

  const submitManual = () => {
    const value = String(input?.value || '').trim();
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
    void controller.addManualToken(value, null);
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitManual();
  });

  button?.addEventListener('click', () => {
    submitManual();
  });

  return wrap;
}
