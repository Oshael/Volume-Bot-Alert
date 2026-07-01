import type { AppController } from '../../state/app-controller';
import { getManualTokens, getMockTradingPositionsViewByAddress, getVisibleManualTokens, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindSparklineHover, bindTokenActions, bindTokenImagePreview, renderManualTokenTable } from './shared';
import { resolveManualTableRows } from '../../utils/token-table';
import { resolveLiveMockSolUsdcRate } from '../../utils/mock-trading-display';
import { escapeHtml } from './html-safety';

let manualFolderCreateModalOpen = false;
let manualFolderCreateDraft = '';
let manualFolderDeleteModalState: { open: boolean; folderId: number | null } = {
  open: false,
  folderId: null,
};
let manualFolderOpenMenuId: number | null = null;

export function renderManualTokensSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.id = 'manual-tokens-section';
  section.className = 'legacy-token-bar manual-bar';
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
  bindManualTokenEntryForm(section, controller);
  bindManualFolderControls(section, state, controller);
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
    starredTokens: state.data.starredTokens,
    searchQuery,
    sortCriteria: state.ui.manualSorts,
  });

  if (filteredManualTokens.length === 0 && getManualTokens(state).length > 0) {
    return '<p class="muted-block">No tokens in the selected manual folder view.</p>';
  }

  return renderManualTokenTable(
    filteredManualTokens,
    state.ui.busy,
    state.data.starredTokens,
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
  return state.data.manualTokenFolderItems.filter((item) => item.folderId === folderId).length;
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
                  <span class="manual-folder-add-inline" data-folder-id="${folder.id}">
                    <input type="text" placeholder="Token CA" aria-label="Token contract address for ${escapeHtml(folder.name)}" data-action="manual-folder-token-input" ${state.ui.busy ? 'disabled' : ''}>
                    <button type="button" data-action="manual-folder-add-token" aria-label="Add token to ${escapeHtml(folder.name)}" title="Add token to folder" ${state.ui.busy ? 'disabled' : ''}>+</button>
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

function renderManualTokenEntryFormMarkup(state: AppState) {
  return `
    <form class="manual-token-form manual-token-inline-form" data-role="manual-token-form">
      <input name="address" type="text" placeholder="Token address (CA)..." aria-label="Token address" required ${state.ui.busy ? 'disabled' : ''} />
      <button type="button" class="compact-icon-toggle manual-token-inline-trigger" data-action="manual-add" aria-label="Add manual token" title="Add token" ${state.ui.busy ? 'disabled' : ''}><span class="compact-icon-glyph">+</span></button>
    </form>
  `;
}

function bindManualTokenEntryForm(root: ParentNode, controller: AppController) {
  const form = root.querySelector<HTMLFormElement>('form[data-role="manual-token-form"]');
  const input = root.querySelector<HTMLInputElement>('input[name="address"]');
  const button = root.querySelector<HTMLButtonElement>('button[data-action="manual-add"]');

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
    void controller.addManualToken(value, null);
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitManual();
  });

  button?.addEventListener('click', () => {
    submitManual();
  });
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
    const submit = () => {
      const folderId = Number(inline.dataset.folderId);
      const address = String(input?.value || '').trim();
      if (!Number.isInteger(folderId) || folderId <= 0 || !address) {
        input?.focus();
        return;
      }
      if (input) {
        input.value = '';
      }
      closeFolderMenus();
      void controller.addManualTokenToFolder(folderId, address);
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
        input.blur();
      }
    });
    button?.addEventListener('click', (event) => {
      event.stopPropagation();
      submit();
    });
  });
}
