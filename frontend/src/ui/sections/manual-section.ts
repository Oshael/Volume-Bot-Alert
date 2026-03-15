import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCopyButtons, bindTokenActions, renderManualTokenTable } from './shared';

export function renderManualTokensSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.id = 'manual-tokens-section';
  section.className = 'legacy-token-bar manual-bar';
  const manualVolActive = state.ui.manualSort === 'vol' ? 'active' : '';
  const manualMcapActive = state.ui.manualSort === 'mcap' ? 'active' : '';
  const manualPchangeActive = state.ui.manualSort === 'pchange' ? 'active' : '';
  const manualVol1h = state.ui.manualSort === 'vol' && state.ui.manualSortWindow === '1h' ? 'active' : '';
  const manualVol6h = state.ui.manualSort === 'vol' && state.ui.manualSortWindow === '6h' ? 'active' : '';
  const manualVol24h = state.ui.manualSort === 'vol' && state.ui.manualSortWindow === '24h' ? 'active' : '';
  const manualPchange1h = state.ui.manualSort === 'pchange' && state.ui.manualSortWindow === '1h' ? 'active' : '';
  const manualPchange6h = state.ui.manualSort === 'pchange' && state.ui.manualSortWindow === '6h' ? 'active' : '';
  const manualPchange24h = state.ui.manualSort === 'pchange' && state.ui.manualSortWindow === '24h' ? 'active' : '';
  section.innerHTML = `
    <div class="legacy-bar-head">
      <span class="legacy-bar-title manual">\u{1F4CC} MANUAL TOKENS</span>
      <div class="legacy-bar-controls">
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
          <button type="button" class="old-filter-btn ${manualMcapActive}" data-sort-mode="mcap">MCAP</button>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${manualPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${manualPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${manualPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${manualPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">Pinned &middot; always monitored</span>
      </div>
    </div>
    ${renderManualTokenTable(
      state.data.manualTokens,
      state.ui.busy,
      state.data.starredTokens,
      state.ui.manualSort,
      state.ui.manualSortWindow,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
    )}
  `;

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
    console.info('[manual:form] submit-attempt', { value });
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

