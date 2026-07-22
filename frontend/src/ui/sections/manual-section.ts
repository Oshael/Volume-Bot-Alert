import type { AppController } from '../../state/app-controller';
import { getChainCapabilityNotice, getManualTokens, getMockTradingPositionsViewByAddress, getVisibleManualTokens, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindSparklineHover, bindTokenActions, bindTokenImagePreview, renderManualTokenTable } from './shared';
import { resolveManualTableRows } from '../../utils/token-table';
import { resolveLiveMockSolUsdcRate } from '../../utils/mock-trading-display';
import { escapeHtml } from './html-safety';
import { normalizeTokenChain, type TokenChain } from '../../utils/token-chain';
import { buildTokenChainIcon, getTokenChainTitle } from '../token-chain-badge';

let manualFolderCreateModalOpen = false;
let manualFolderCreateDraft = '';
let manualFolderDeleteModalState: { open: boolean; folderId: number | null } = {
  open: false,
  folderId: null,
};
let manualFolderOpenMenuId: number | null = null;
let clearManualEntryOutsideListener: (() => void) | null = null;

export function renderManualTokensSection(state: AppState, controller: AppController) {
  clearManualEntryOutsideListener?.();
  clearManualEntryOutsideListener = null;
  const section = document.createElement('section');
  section.id = 'manual-tokens-section';
  section.className = 'legacy-token-bar manual-bar';
  const capabilityNotice = getChainCapabilityNotice(state, 'manualTokens');
  if (capabilityNotice) {
    section.innerHTML = `
      <div class="legacy-bar-head">
        <span class="legacy-bar-title manual">\u{1F4CC} MANUAL TOKENS</span>
        <span class="count-pill">0</span>
      </div>
      <p class="chain-readiness-empty" data-chain-readiness-surface="manual">${escapeHtml(capabilityNotice)}</p>
    `;
    return section;
  }
  const isCollapsed = state.ui.collapsed.manual;
  const sortClasses = getManualSortClasses(state);
  const searchQuery = String(state.ui.manualSearchQuery || '').trim();
  const manualTableMarkup = renderManualFolderAwareTable(state, searchQuery);
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
        ${renderManualTokenEntryFormMarkup(state)}
        <button type="button" class="compact-icon-toggle manual-folder-create-icon" data-action="manual-folder-create-root" aria-label="Create manual token folder" title="Create folder"><span class="compact-icon-glyph manual-folder-glyph" aria-hidden="true"></span></button>
        <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="manual" aria-label="Collapse manual tokens"><span class="compact-icon-glyph">−</span></button>
        <div class="compact-search ${searchQuery ? 'has-query open' : ''}">
          <button type="button" class="compact-search-toggle" data-action="manual-search-focus" aria-label="Search manual tokens">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="manual-search" data-search-input="manual">
        </div>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <button type="button" class="compact-icon-toggle ${state.ui.manualStarredOnly ? 'active' : ''}" data-action="manual-starred-only" aria-label="Show only starred manual tokens"><span class="compact-icon-glyph">&#9733;</span></button>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${sortClasses.manualVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${sortClasses.manualVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${sortClasses.manualMcapActive}" data-sort-toggle="mcap">MCAP</button>
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
        <span class="legacy-bar-note">Pinned &middot; always monitored</span>
      </div>
    </div>
    ${renderManualFolderControls(state)}
    ${manualTableMarkup}
    ${renderManualFolderCreateModal(state)}
    ${renderManualFolderDeleteModal()}
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
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindTokenImagePreview(section);
  bindBucketSortControls(section, controller, 'manual');
  mountManualChainIcons(section);
  bindManualTokenEntryForm(section, controller);
  bindManualFolderControls(section, state, controller);
  bindManualEntryOutsideDismiss(section);
  bindManualFolderCreateModal(section, controller);
  bindManualFolderDeleteModal(section, controller);
  return section;
}

function getManualSortClasses(state: AppState) {
  const sorts = state.ui.manualSorts;
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

function renderManualFolderAwareTable(state: AppState, searchQuery: string) {
  const filteredManualTokens = resolveManualTableRows(getVisibleManualTokens(state), {
    starredOnly: state.ui.manualStarredOnly,
    starredTokens: state.data.starredTokenIdentities,
    searchQuery,
    sortCriteria: state.ui.manualSorts,
  });

  if (filteredManualTokens.length === 0 && getManualTokens(state).length > 0) {
    return '<p class="muted-block">No tokens in the selected manual folder view.</p>';
  }

  return renderManualTokenTable(
    filteredManualTokens,
    state.ui.busy,
    state.data.starredTokenIdentities,
    state.ui.manualSorts,
    state.data.meteoraByAddress,
    Number(state.data.configs['meteora-min-pool']) || 5000,
    state.session.role === 'admin',
    state.ui.enabledTradeTerminals,
    {
      showSparkline: true,
      sparklineByAddress: state.data.sparklineByAddress,
      mockTradingPositionsByAddress: getMockTradingPositionsViewByAddress(state),
      mockTradingTradesByAddress: state.data.mockTradingTradesByAddress,
      mockSolUsdcRate: resolveLiveMockSolUsdcRate(state.data.mockTradingSummary, state.data.configs),
    },
  );
}

function getManualFolderItemCount(state: AppState, folderId: number) {
  const enabledChains = new Set(state.ui.chainFilters.enabledChains);
  return state.data.manualTokenFolderItems.filter((item) => (
    item.folderId === folderId && enabledChains.has(item.chain)
  )).length;
}

function renderFolderFilterButton(label: string, count: number, active: boolean, action: string, folderId?: number) {
  const folderAttr = folderId == null ? '' : ` data-folder-id="${folderId}"`;
  return `
    <button type="button" class="manual-folder-chip ${active ? 'active' : ''}" data-action="${action}"${folderAttr}>
      <span>${escapeHtml(label)}</span>
      <small>${count}</small>
    </button>
  `;
}

function renderManualFolderControls(state: AppState) {
  const selectedIds = state.ui.manualVisibleFolderIds;
  const selectedSet = new Set(selectedIds);
  const allActive = selectedIds.length === 0;
  const folders = state.data.manualTokenFolders;
  if (folders.length === 0) {
    return '';
  }

  return `
    <div class="manual-folder-panel">
      <div class="manual-folder-filter-list">
        ${renderFolderFilterButton('All', getManualTokens(state).length, allActive, 'manual-folder-all')}
        ${folders.map((folder) => {
          const active = selectedSet.has(folder.id);
          const open = manualFolderOpenMenuId === folder.id;
          return `
            <span class="manual-folder-chip-wrap ${active ? 'active' : ''}${open ? ' open' : ''}" data-folder-id="${folder.id}">
              <button type="button" class="manual-folder-chip manual-folder-chip-inner" data-action="manual-folder-toggle" data-folder-id="${folder.id}">
                <span>${escapeHtml(folder.name)}</span>
                <small>${getManualFolderItemCount(state, folder.id)}</small>
              </button>
              <span class="manual-folder-menu-wrap">
                <button type="button" class="manual-folder-menu-toggle" aria-label="Open actions for ${escapeHtml(folder.name)}" title="Folder actions" aria-expanded="${open ? 'true' : 'false'}">^</button>
                <span class="manual-folder-actions" role="menu">
                  <span class="manual-folder-add-inline manual-token-entry" data-folder-id="${folder.id}">
                    <input type="text" placeholder="Token address (CA)..." aria-label="Token contract address for ${escapeHtml(folder.name)}" data-action="manual-folder-token-input" ${state.ui.busy ? 'disabled' : ''}>
                    ${renderManualChainPicker(state, `Token chain for ${folder.name}`)}
                    <button type="button" class="manual-token-entry-trigger" data-action="manual-folder-add-token" aria-label="Add token to ${escapeHtml(folder.name)}" aria-expanded="false" ${state.ui.busy ? 'disabled' : ''}>ADD TOKEN</button>
                  </span>
                  <button type="button" class="manual-folder-action danger" data-action="manual-folder-delete" data-folder-id="${folder.id}" data-folder-name="${escapeHtml(folder.name)}" role="menuitem" aria-label="Delete ${escapeHtml(folder.name)}" title="Delete folder and manual tokens"><b>X</b><span>Delete Folder</span></button>
                </span>
              </span>
            </span>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function getManualEntryChains(state: AppState) {
  return state.ui.chainFilters.enabledChains.filter((chain): chain is TokenChain => (
    chain === 'solana' || chain === 'robinhood'
  ));
}

function renderManualChainPicker(state: AppState, ariaLabel: string) {
  const chains = getManualEntryChains(state);
  const selected = chains.includes('solana') ? 'solana' : chains[0] || 'solana';
  const hasMenu = chains.length > 1;
  return `
    <span class="manual-token-chain-picker" data-role="manual-token-chain-picker" data-selected-chain="${selected}">
      <input type="hidden" data-action="manual-token-chain" value="${selected}">
      <button type="button" class="manual-token-chain-trigger" data-action="manual-token-chain-toggle" aria-label="${escapeHtml(ariaLabel)}: ${getTokenChainTitle(selected)}" aria-haspopup="${hasMenu ? 'menu' : 'false'}" aria-expanded="false">
        <span data-manual-chain-icon="${selected}"></span>
      </button>
      ${hasMenu ? `
        <span class="manual-token-chain-menu" role="menu">
          ${chains.map((chain) => `
            <button type="button" class="manual-token-chain-option${chain === selected ? ' active' : ''}" data-action="manual-token-chain-option" data-chain="${chain}" role="menuitemradio" aria-checked="${chain === selected ? 'true' : 'false'}" aria-label="${getTokenChainTitle(chain)}">
              <span data-manual-chain-icon="${chain}"></span>
            </button>
          `).join('')}
        </span>
      ` : ''}
    </span>
  `;
}

function renderManualTokenEntryFormMarkup(state: AppState) {
  return `
    <form class="manual-token-form manual-token-inline-form manual-token-entry" data-role="manual-token-form">
      <input name="address" type="text" placeholder="Token address (CA)..." aria-label="Token address" required ${state.ui.busy ? 'disabled' : ''} />
      ${renderManualChainPicker(state, 'Token chain')}
      <button type="button" class="manual-token-entry-trigger manual-token-inline-trigger" data-action="manual-add" aria-label="Add manual token" aria-expanded="false" ${state.ui.busy ? 'disabled' : ''}>ADD TOKEN</button>
    </form>
  `;
}

function mountManualChainIcons(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-manual-chain-icon]').forEach((placeholder) => {
    const chain = normalizeTokenChain(placeholder.dataset.manualChainIcon);
    if (chain) placeholder.replaceChildren(buildTokenChainIcon(chain));
  });
}

function closeManualChainPicker(entry: Element) {
  const picker = entry.querySelector<HTMLElement>('[data-role="manual-token-chain-picker"]');
  picker?.classList.remove('open');
  picker?.querySelector<HTMLButtonElement>('[data-action="manual-token-chain-toggle"]')
    ?.setAttribute('aria-expanded', 'false');
}

function closeManualTokenEntry(entry: HTMLElement) {
  entry.classList.remove('open');
  entry.closest<HTMLElement>('.manual-folder-actions')?.classList.remove('manual-entry-expanded');
  entry.querySelector<HTMLButtonElement>('.manual-token-entry-trigger')?.setAttribute('aria-expanded', 'false');
  closeManualChainPicker(entry);
}

function openManualTokenEntry(entry: HTMLElement, input: HTMLInputElement | null) {
  entry.classList.add('open');
  entry.closest<HTMLElement>('.manual-folder-actions')?.classList.add('manual-entry-expanded');
  entry.querySelector<HTMLButtonElement>('.manual-token-entry-trigger')?.setAttribute('aria-expanded', 'true');
  window.requestAnimationFrame(() => input?.focus());
}

function bindManualChainPicker(entry: HTMLElement) {
  const picker = entry.querySelector<HTMLElement>('[data-role="manual-token-chain-picker"]');
  const input = picker?.querySelector<HTMLInputElement>('[data-action="manual-token-chain"]');
  const trigger = picker?.querySelector<HTMLButtonElement>('[data-action="manual-token-chain-toggle"]');
  const options = [...(picker?.querySelectorAll<HTMLButtonElement>('[data-action="manual-token-chain-option"]') || [])];

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (options.length < 2) return;
    const open = picker?.classList.toggle('open') === true;
    trigger.setAttribute('aria-expanded', String(open));
  });
  options.forEach((option) => {
    option.addEventListener('click', (event) => {
      event.stopPropagation();
      const chain = normalizeTokenChain(option.dataset.chain);
      if (!chain || !input || !picker || !trigger) return;
      input.value = chain;
      picker.dataset.selectedChain = chain;
      trigger.setAttribute('aria-label', `Token chain: ${getTokenChainTitle(chain)}`);
      trigger.replaceChildren(buildTokenChainIcon(chain));
      options.forEach((item) => {
        const active = item === option;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
      closeManualChainPicker(entry);
    });
  });

  return () => normalizeTokenChain(input?.value) || 'solana';
}

function bindManualTokenEntryForm(root: ParentNode, controller: AppController) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="manual-token-form"]');
  const input = root.querySelector<HTMLInputElement>('input[name="address"]');
  const button = root.querySelector<HTMLButtonElement>('button[data-action="manual-add"]');
  if (!form) return;
  const getChain = bindManualChainPicker(form);

  const submitManual = () => {
    const value = String(input?.value || '').trim();
    if (!value) {
      input?.focus();
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
    const chain = getChain();
    closeManualTokenEntry(form);
    void controller.addManualToken(value, null, chain);
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitManual();
  });

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeManualTokenEntry(form);
      button?.focus();
    }
  });
  button?.addEventListener('click', () => {
    if (!form.classList.contains('open')) {
      openManualTokenEntry(form, input);
      return;
    }
    submitManual();
  });
}

function bindManualEntryOutsideDismiss(root: HTMLElement) {
  const listener = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.manual-token-entry')) return;
    root.querySelectorAll<HTMLElement>('.manual-token-entry.open').forEach(closeManualTokenEntry);
    if (!(target instanceof Element) || !target.closest('.manual-folder-menu-wrap')) {
      closeManualFolderMenus(root);
    }
  };
  document.addEventListener('pointerdown', listener);
  clearManualEntryOutsideListener = () => document.removeEventListener('pointerdown', listener);
}

function renderManualFolderCreateModal(state: AppState) {
  const openClass = manualFolderCreateModalOpen ? ' open' : '';
  const ariaHidden = manualFolderCreateModalOpen ? 'false' : 'true';
  return `
    <div class="manual-folder-modal${openClass}" data-role="manual-folder-create-modal" aria-hidden="${ariaHidden}">
      <button type="button" class="manual-folder-modal-backdrop" data-action="manual-folder-modal-close" aria-label="Close create folder dialog"></button>
      <form class="manual-folder-modal-panel" data-role="manual-folder-create-form" role="dialog" aria-modal="true" aria-labelledby="manual-folder-create-title">
        <div class="manual-folder-modal-head">
          <span class="manual-folder-modal-icon"><span class="manual-folder-glyph" aria-hidden="true"></span></span>
          <div>
            <h3 id="manual-folder-create-title">New Folder</h3>
            <p>Organize manual tokens in a custom view.</p>
          </div>
        </div>
        <label class="manual-folder-modal-field">
          <span>Folder name</span>
          <input name="folderName" type="text" maxlength="48" autocomplete="off" placeholder="Utility coins" value="${escapeHtml(manualFolderCreateDraft)}" ${state.ui.busy ? 'disabled' : ''}>
        </label>
        <div class="manual-folder-modal-actions">
          <button type="button" class="manual-folder-modal-btn ghost" data-action="manual-folder-modal-close">Cancel</button>
          <button type="submit" class="manual-folder-modal-btn primary" ${state.ui.busy ? 'disabled' : ''}>Create</button>
        </div>
      </form>
    </div>
  `;
}

function renderManualFolderDeleteModal() {
  const openClass = manualFolderDeleteModalState.open ? ' open' : '';
  const ariaHidden = manualFolderDeleteModalState.open ? 'false' : 'true';
  const folderId = manualFolderDeleteModalState.folderId ?? '';
  return `
    <div class="manual-folder-modal manual-folder-modal-danger${openClass}" data-role="manual-folder-delete-modal" aria-hidden="${ariaHidden}">
      <button type="button" class="manual-folder-modal-backdrop" data-action="manual-folder-delete-modal-close" aria-label="Close delete folder dialog"></button>
      <form class="manual-folder-modal-panel" data-role="manual-folder-delete-form" role="dialog" aria-modal="true" aria-labelledby="manual-folder-delete-title">
        <div class="manual-folder-modal-head">
          <div>
            <h3 id="manual-folder-delete-title">Delete Folder</h3>
            <p data-role="manual-folder-delete-copy">Tokens inside this folder will be removed from your Manual Tokens list.</p>
          </div>
        </div>
        <input type="hidden" name="folderId" value="${escapeHtml(folderId)}">
        <label class="manual-folder-modal-check">
          <input type="checkbox" name="skipDeleteWarning">
          <span>Do not show this warning again</span>
        </label>
        <div class="manual-folder-modal-actions">
          <button type="button" class="manual-folder-modal-btn ghost" data-action="manual-folder-delete-modal-close">Cancel</button>
          <button type="submit" class="manual-folder-modal-btn danger">Delete</button>
        </div>
      </form>
    </div>
  `;
}

function bindManualFolderCreateModal(root: ParentNode, controller: AppController) {
  const modal = root.querySelector<HTMLElement>('[data-role="manual-folder-create-modal"]');
  const form = root.querySelector<HTMLFormElement>('[data-role="manual-folder-create-form"]');
  const input = form?.querySelector<HTMLInputElement>('input[name="folderName"]');

  const close = () => {
    manualFolderCreateModalOpen = false;
    manualFolderCreateDraft = '';
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden', 'true');
    form?.reset();
  };

  const open = () => {
    manualFolderCreateModalOpen = true;
    modal?.classList.add('open');
    modal?.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => input?.focus());
  };

  if (manualFolderCreateModalOpen) {
    window.requestAnimationFrame(() => input?.focus());
  }
  root.querySelector<HTMLButtonElement>('[data-action="manual-folder-create-root"]')?.addEventListener('click', open);
  root.querySelectorAll<HTMLButtonElement>('[data-action="manual-folder-modal-close"]').forEach((button) => {
    button.addEventListener('click', close);
  });
  input?.addEventListener('input', () => {
    manualFolderCreateDraft = input.value;
  });
  modal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = String(input?.value || '').trim();
    if (!name) {
      input?.focus();
      return;
    }
    close();
    void controller.createManualTokenFolder(name);
  });
}

function bindManualFolderDeleteModal(root: ParentNode, controller: AppController) {
  const modal = root.querySelector<HTMLElement>('[data-role="manual-folder-delete-modal"]');
  const form = root.querySelector<HTMLFormElement>('[data-role="manual-folder-delete-form"]');
  const input = form?.querySelector<HTMLInputElement>('input[name="folderId"]');
  const skipWarningInput = form?.querySelector<HTMLInputElement>('input[name="skipDeleteWarning"]');
  const copy = form?.querySelector<HTMLElement>('[data-role="manual-folder-delete-copy"]');

  const close = () => {
    manualFolderDeleteModalState = { open: false, folderId: null };
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden', 'true');
    form?.reset();
  };

  const open = (folderId: number) => {
    manualFolderDeleteModalState = { open: true, folderId };
    if (input) {
      input.value = String(folderId);
    }
    if (copy) {
      copy.textContent = 'Tokens inside this folder will be removed from your Manual Tokens list.';
    }
    modal?.classList.add('open');
    modal?.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => {
      form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
    });
  };

  if (manualFolderDeleteModalState.open) {
    window.requestAnimationFrame(() => {
      form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
    });
  }
  root.querySelectorAll<HTMLButtonElement>('[data-action="manual-folder-delete-modal-close"]').forEach((button) => {
    button.addEventListener('click', close);
  });
  modal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const folderId = Number(input?.value);
    if (!Number.isInteger(folderId) || folderId <= 0) {
      close();
      return;
    }
    const skipFutureWarnings = Boolean(skipWarningInput?.checked);
    close();
    if (skipFutureWarnings) {
      controller.setManualFolderDeleteWarningDismissed(true);
    }
    void controller.deleteManualTokenFolder(folderId);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="manual-folder-delete"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeManualFolderMenus(root);
      const folderId = Number(button.dataset.folderId);
      if (!Number.isInteger(folderId) || folderId <= 0) {
        return;
      }
      if (controller.state.ui.manualFolderDeleteWarningDismissed) {
        void controller.deleteManualTokenFolder(folderId);
        return;
      }
      open(folderId);
    });
  });
}

function closeManualFolderMenus(root: ParentNode) {
  manualFolderOpenMenuId = null;
  root.querySelectorAll<HTMLElement>('.manual-folder-chip-wrap.open').forEach((wrap) => {
    wrap.querySelectorAll<HTMLElement>('.manual-token-entry.open').forEach(closeManualTokenEntry);
    wrap.classList.remove('open');
    wrap.querySelector<HTMLButtonElement>('.manual-folder-menu-toggle')?.setAttribute('aria-expanded', 'false');
  });
}

function bindManualFolderControls(root: ParentNode, state: AppState, controller: AppController) {
  const closeFolderMenus = () => closeManualFolderMenus(root);

  root.querySelectorAll<HTMLButtonElement>('.manual-folder-menu-toggle').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wrap = button.closest<HTMLElement>('.manual-folder-chip-wrap');
      const wasOpen = Boolean(wrap?.classList.contains('open'));
      closeFolderMenus();
      if (wrap && !wasOpen) {
        const folderId = Number(wrap.dataset.folderId);
        manualFolderOpenMenuId = Number.isInteger(folderId) && folderId > 0 ? folderId : null;
        wrap.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
      }
    });
  });

  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.manual-folder-menu-wrap')) {
      closeFolderMenus();
    }
  });

  root.querySelector<HTMLButtonElement>('[data-action="manual-folder-all"]')?.addEventListener('click', () => {
    closeFolderMenus();
    controller.setManualVisibleFolderIds([]);
  });

  root.querySelectorAll<HTMLButtonElement>('[data-action="manual-folder-toggle"]').forEach((button) => {
    button.addEventListener('click', () => {
      closeFolderMenus();
      const folderId = Number(button.dataset.folderId);
      if (!Number.isInteger(folderId) || folderId < 0) {
        return;
      }
      const selected = new Set(state.ui.manualVisibleFolderIds);
      if (selected.has(folderId)) {
        selected.delete(folderId);
      } else {
        selected.add(folderId);
      }
      controller.setManualVisibleFolderIds([...selected]);
    });
  });

  root.querySelectorAll<HTMLElement>('.manual-folder-add-inline').forEach((inline) => {
    const input = inline.querySelector<HTMLInputElement>('[data-action="manual-folder-token-input"]');
    const button = inline.querySelector<HTMLButtonElement>('[data-action="manual-folder-add-token"]');
    const getChain = bindManualChainPicker(inline);
    const submit = () => {
      const folderId = Number(inline.dataset.folderId);
      const address = String(input?.value || '').trim();
      const chain = getChain();
      if (!Number.isInteger(folderId) || folderId <= 0 || !address) {
        input?.focus();
        return;
      }
      if (input) {
        input.value = '';
      }
      closeManualTokenEntry(inline);
      closeFolderMenus();
      void controller.addManualTokenToFolder(folderId, address, chain);
    };

    inline.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeManualTokenEntry(inline);
        button?.focus();
      }
    });
    button?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!inline.classList.contains('open')) {
        openManualTokenEntry(inline, input);
        return;
      }
      submit();
    });
  });
}
