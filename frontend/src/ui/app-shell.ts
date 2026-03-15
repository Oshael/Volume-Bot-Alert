import type { AppController } from '../state/app-controller';
import type { AppState } from '../state/app-state';
import { renderAlertsSection } from './sections/alerts-section';
import { renderBlocklistSection } from './sections/blocklist-section';
import { renderLegacyShell } from './sections/layout-sections';
import { renderManualTokensSection } from './sections/manual-section';
import { renderMonitoredSection } from './sections/monitored-section';
import { renderPumpfunSection } from './sections/pumpfun-section';
import { renderPumpToasts } from './sections/pumpfun-toasts';
import { renderOldWeekSection, renderRecentSection } from './sections/routed-sections';

type ConfigDraft = {
  values: Record<string, string>;
  focusedName: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
};

type PanelScrollDraft = {
  monitored: number;
  pumpfun: number;
  alerts: number;
};


export function renderAppShell(root: HTMLElement, state: AppState, controller: AppController) {
  const configDraft = captureConfigDraft(root);
  const panelScrollDraft = capturePanelScrollDraft(root);
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  shell.append(renderPumpToasts(state), renderLegacyShell(state, controller));

  if (state.session.status === 'authenticated') {
    if (state.data.blocklist.length > 0) {
      shell.append(renderBlocklistSection(state, controller));
    }
    shell.append(
      renderOldWeekSection(state, controller),
      renderRecentSection(state, controller),
      renderManualTokensSection(state, controller),
    );

    const panels = document.createElement('div');
    panels.className = 'legacy-panels';
    panels.append(
      renderMonitoredSection(state, controller),
      renderPumpfunSection(state, controller),
      renderAlertsSection(state, controller),
    );
    shell.append(panels);
  }

  root.append(shell);
  applyConfigDraft(root, configDraft, state);
  applyPanelScrollDraft(root, panelScrollDraft);
  wireHoverPersistence(root);
  wireTradeMenus(root);
  wireSortMenus(root);
  wireUserMenus(root);
  applyHoverState(root);
}




let currentHoverKey: string | null = null;
let hoverWired = false;
let tradeWired = false;
let sortMenusWired = false;
let userMenusWired = false;

function wireHoverPersistence(root: HTMLElement) {
  if (hoverWired) return;
  hoverWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    currentHoverKey = row?.dataset.hoverKey ?? null;
    applyHoverState(root);
  });

  root.addEventListener('mouseout', (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('[data-hover-key]');
    if (!row) return;

    const related = event.relatedTarget as HTMLElement | null;
    if (related && row.contains(related)) return;

    if (currentHoverKey === row.dataset.hoverKey) {
      currentHoverKey = null;
      applyHoverState(root);
    }
  });
}

function applyHoverState(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.forced-hover')) {
    el.classList.remove('forced-hover');
  }
  if (!currentHoverKey) return;
  const hovered = root.querySelector<HTMLElement>(`[data-hover-key="${currentHoverKey}"]`);
  if (hovered) hovered.classList.add('forced-hover');
}

function wireTradeMenus(root: HTMLElement) {
  if (tradeWired) return;
  tradeWired = true;

  root.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const wrap = target?.closest<HTMLElement>('[data-trade-wrap]');
    if (!wrap) return;

    const menu = wrap.querySelector<HTMLElement>('[data-trade-menu]');
    if (!menu) return;

    menu.classList.remove('open-up', 'open-down', 'open-left', 'open-right');
    const rect = wrap.getBoundingClientRect();
    const boundary = wrap.closest<HTMLElement>('.token-table-wrap, .monitored-list, .pump-list, .alerts-list, .panel, .legacy-panel');
    const boundaryRect = boundary?.getBoundingClientRect();
    const estimatedHeight = Math.max(menu.offsetHeight || 0, 118);
    const estimatedWidth = Math.max(menu.offsetWidth || 0, 90);
    const availableBottom = boundaryRect ? boundaryRect.bottom - rect.bottom : window.innerHeight - rect.bottom;
    const availableTop = boundaryRect ? rect.top - boundaryRect.top : rect.top;
    const availableRight = boundaryRect ? boundaryRect.right - rect.right : window.innerWidth - rect.right;
    const availableLeft = boundaryRect ? rect.left - boundaryRect.left : rect.left;
    const shouldOpenUp = availableBottom < estimatedHeight + 12 && availableTop > availableBottom;
    const shouldOpenLeft = availableRight < estimatedWidth + 16 && availableLeft > availableRight;

    menu.classList.add(shouldOpenUp ? 'open-up' : 'open-down');
    menu.classList.add(shouldOpenLeft ? 'open-left' : 'open-right');
  });
}

function wireSortMenus(root: HTMLElement) {
  if (sortMenusWired) return;
  sortMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-sort-toggle]');
    const wrap = target?.closest<HTMLElement>('[data-sort-wrap]');

    for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
      if (openWrap !== wrap) openWrap.classList.remove('open');
    }

    if (toggle && wrap) {
      event.preventDefault();
      wrap.classList.toggle('open');
      return;
    }

    if (!wrap) {
      for (const openWrap of root.querySelectorAll<HTMLElement>('[data-sort-wrap].open')) {
        openWrap.classList.remove('open');
      }
    }
  });
}

function wireUserMenus(root: HTMLElement) {
  if (userMenusWired) return;
  userMenusWired = true;

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggle = target?.closest<HTMLElement>('[data-action="toggle-user-menu"]');
    const menu = target?.closest<HTMLElement>('[data-user-menu]');

    for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
      if (openMenu !== menu) openMenu.classList.remove('open');
    }

    if (toggle && menu) {
      event.preventDefault();
      menu.classList.toggle('open');
      return;
    }

    if (!menu) {
      for (const openMenu of root.querySelectorAll<HTMLElement>('[data-user-menu].open')) {
        openMenu.classList.remove('open');
      }
    }
  });
}

function capturePanelScrollDraft(root: HTMLElement): PanelScrollDraft {
  return {
    monitored: root.querySelector<HTMLElement>('.monitored-list')?.scrollTop ?? 0,
    pumpfun: root.querySelector<HTMLElement>('.pump-list')?.scrollTop ?? 0,
    alerts: root.querySelector<HTMLElement>('.alerts-list')?.scrollTop ?? 0,
  };
}

function applyPanelScrollDraft(root: HTMLElement, draft: PanelScrollDraft) {
  const monitored = root.querySelector<HTMLElement>('.monitored-list');
  const pumpfun = root.querySelector<HTMLElement>('.pump-list');
  const alerts = root.querySelector<HTMLElement>('.alerts-list');

  if (monitored) monitored.scrollTop = draft.monitored;
  if (pumpfun) pumpfun.scrollTop = draft.pumpfun;
  if (alerts) alerts.scrollTop = draft.alerts;
}

function captureConfigDraft(root: HTMLElement): ConfigDraft | null {
  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) {
    return null;
  }

  const values: Record<string, string> = {};
  for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    values[field.name] = field.value;
  }

  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement) || !configSection.contains(active) || !active.name) {
    return { values, focusedName: null, selectionStart: null, selectionEnd: null };
  }

  return {
    values,
    focusedName: active.name,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
  };
}

function applyConfigDraft(root: HTMLElement, draft: ConfigDraft | null, state: AppState) {
  if (!draft) return;

  const configSection = root.querySelector('.legacy-config-grid');
  if (!configSection) return;

  if (!draft.focusedName && state.ui.busy) {
    for (const field of configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
      const value = draft.values[field.name];
      if (value != null) {
        field.value = value;
      }
    }
    return;
  }

  if (!draft.focusedName) return;
  const focused = configSection.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${draft.focusedName}"]`);
  if (!focused) return;

  const value = draft.values[draft.focusedName];
  if (value != null) {
    focused.value = value;
  }

  focused.focus();
  if (focused instanceof HTMLInputElement && draft.selectionStart != null && draft.selectionEnd != null) {
    focused.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}
