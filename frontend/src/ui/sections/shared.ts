import type { AppController } from '../../state/app-controller';
import type { AppState, BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry, MeteoraEntry, MonitoredSortMode, MonitoredSortWindow, TokenSparklineEntry, TradeTerminalKey } from '../../state/app-state';
import { getAuthFeedbackKind, getAuthFlashBadge } from './auth-feedback';
import { escapeHtml, sanitizeAssetUrl, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { sortBucketTokens } from '../../utils/token-table';

const DEFAULT_TRADE_TERMINALS: TradeTerminalKey[] = ['axiom', 'photon', 'bullx', 'gmgn', 'padre'];
const TRADE_TERMINAL_ICON_URLS: Record<TradeTerminalKey, string> = {
  axiom: new URL('../../../terminal-axiom.ico', import.meta.url).href,
  photon: new URL('../../../terminal-photon.svg', import.meta.url).href,
  bullx: new URL('../../../terminal-bullx.png', import.meta.url).href,
  gmgn: new URL('../../../terminal-gmgn.svg', import.meta.url).href,
  padre: new URL('../../../terminal-padre.svg', import.meta.url).href,
};

type TradeTerminalLink = {
  key: TradeTerminalKey;
  label: string;
  href: string;
  cls: TradeTerminalKey;
  iconHref: string;
};

const SPARKLINE_SVG_WIDTH = 144;
const SPARKLINE_SVG_HEIGHT = 56;
const SPARKLINE_PADDING_X = 3;
const SPARKLINE_PADDING_Y = 5;

export function bindTokenActions(section: ParentNode, controller: AppController) {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-manual"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) void controller.removeManualToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="block-token"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const label = button.dataset.label || null;
      if (address) void controller.addBlockedToken(address, label);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="admin-block-token"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const label = button.dataset.label || null;
      if (address) void controller.adminBlockToken(address, label);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="dismiss-recent"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) controller.dismissRecentToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="dismiss-old-week"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) controller.dismissOldWeekToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="toggle-star"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (!address) return;

      const willBeStarred = !button.classList.contains('active');
      const root = button.ownerDocument || document;
      const selector = `[data-action="toggle-star"][data-address="${CSS.escape(address)}"]`;

      for (const starButton of root.querySelectorAll<HTMLButtonElement>(selector)) {
        starButton.classList.toggle('active', willBeStarred);
        starButton.textContent = willBeStarred ? '★' : '☆';

        const tokenRow = starButton.closest('.token-starred, tr, article, .token-row, .alert-row');
        if (tokenRow instanceof HTMLElement) {
          tokenRow.classList.toggle('token-starred', willBeStarred);
        }
      }

      void controller.toggleStarredToken(address);
    });
  }
}

export function bindCopyButtons(section: ParentNode) {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="copy-address"]')) {
    button.addEventListener('click', async () => {
      const address = button.dataset.address;
      if (!address) return;
      const original = button.dataset.copyOriginalLabel ?? button.textContent ?? '';
      button.dataset.copyOriginalLabel = original;
      const keepTextFeedback = button.classList.contains('alert-action-button') || Boolean(button.closest('.alerts-panel'));

      try {
        await navigator.clipboard.writeText(address);
        button.textContent = keepTextFeedback ? 'Copied' : '✓';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        button.textContent = keepTextFeedback ? 'Copy failed' : '✕';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      }
    });
  }
}

export function renderTradeTerminalMenu(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 1) {
    const link = links[0];
    return `
      <a class="action-glyph trade-btn trade-btn-direct" href="${sanitizeHttpUrl(link.href)}" target="_blank" rel="noreferrer" title="Open in ${escapeHtml(link.label)}">${renderTradeTerminalButtonIcon(link)}</a>
    `;
  }

  return `
    <div class="trade-wrap" data-trade-wrap>
      <button type="button" class="action-glyph trade-btn" title="Open in trading terminal">&#128279;</button>
      <div class="trade-dd" data-trade-menu>
        ${links.map((link) => `<a class="trade-link ${link.cls}" href="${sanitizeHttpUrl(link.href)}" target="_blank" rel="noreferrer">${renderTradeTerminalLinkInner(link)}</a>`).join('')}
      </div>
    </div>
  `;
}

export function buildTradeTerminalMenuElement(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 1) {
    const link = links[0];
    const anchor = document.createElement('a');
    anchor.className = 'action-glyph trade-btn trade-btn-direct';
    anchor.href = sanitizeHttpUrl(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.title = `Open in ${link.label}`;
    anchor.append(buildTradeTerminalIcon(link, 'trade-btn-icon'));
    return anchor;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'trade-wrap';
  wrapper.dataset.tradeWrap = '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-glyph trade-btn';
  button.title = 'Open in trading terminal';
  button.textContent = '🔗';

  const menu = document.createElement('div');
  menu.className = 'trade-dd';
  menu.dataset.tradeMenu = '';

  for (const link of links) {
    const anchor = document.createElement('a');
    anchor.className = `trade-link ${link.cls}`;
    anchor.href = sanitizeHttpUrl(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    const label = document.createElement('span');
    label.className = 'trade-link-label';
    label.textContent = link.label;
    anchor.append(buildTradeTerminalIcon(link), label);
    menu.append(anchor);
  }

  wrapper.append(button, menu);
  return wrapper;
}

function getTradeTerminalLinks(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
): TradeTerminalLink[] {
  const tokenAddress = mintAddress || address;
  const terminalAddress = pairAddress || mintAddress || address;
  const axiomAddress = options?.axiomAddress || pairAddress || tokenAddress;
  const enabledTradeTerminals = normalizeEnabledTradeTerminals(options?.enabledTradeTerminals);
  const links: TradeTerminalLink[] = [
    { key: 'axiom', label: 'Axiom', href: `https://axiom.trade/meme/${axiomAddress}?chain=sol`, cls: 'axiom', iconHref: TRADE_TERMINAL_ICON_URLS.axiom },
    { key: 'photon', label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${tokenAddress}`, cls: 'photon', iconHref: TRADE_TERMINAL_ICON_URLS.photon },
    { key: 'bullx', label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`, cls: 'bullx', iconHref: TRADE_TERMINAL_ICON_URLS.bullx },
    { key: 'gmgn', label: 'GMGN', href: `https://gmgn.ai/sol/token/${tokenAddress}`, cls: 'gmgn', iconHref: TRADE_TERMINAL_ICON_URLS.gmgn },
    { key: 'padre', label: 'Padre', href: `https://trade.padre.gg/trade/solana/${terminalAddress}`, cls: 'padre', iconHref: TRADE_TERMINAL_ICON_URLS.padre },
  ];
  return links.filter((link) => enabledTradeTerminals.includes(link.key));
}

function renderTradeTerminalLinkInner(link: TradeTerminalLink) {
  return `${renderTradeTerminalIconMarkup(link)}<span class="trade-link-label">${escapeHtml(link.label)}</span>`;
}

function renderTradeTerminalButtonIcon(link: TradeTerminalLink) {
  return renderTradeTerminalIconMarkup(link, 'trade-btn-icon');
}

function renderTradeTerminalIconMarkup(link: TradeTerminalLink, className = 'trade-link-icon') {
  const inlineIcon = getInlineTradeTerminalIconMarkup(link, className);
  if (inlineIcon) {
    return inlineIcon;
  }
  return `<img class="${className} terminal-icon terminal-icon-${link.key}" src="${sanitizeAssetUrl(link.iconHref)}" alt="" aria-hidden="true">`;
}

function buildTradeTerminalIcon(link: TradeTerminalLink, className = 'trade-link-icon') {
  const inlineIcon = buildInlineTradeTerminalIcon(link, className);
  if (inlineIcon) {
    return inlineIcon;
  }
  const icon = document.createElement('img');
  icon.className = `${className} terminal-icon terminal-icon-${link.key}`;
  icon.src = sanitizeAssetUrl(link.iconHref);
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function getInlineTradeTerminalIconMarkup(link: TradeTerminalLink, className: string) {
  if (link.key === 'photon') {
    return `
      <svg class="${className} terminal-icon-inline terminal-icon-${link.key}" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="5.75" stroke="#45C7FF" stroke-width="1.8"/>
        <path d="M8 3.2L9.18 5.93L11.9 7.1L9.18 8.27L8 11L6.82 8.27L4.1 7.1L6.82 5.93L8 3.2Z" fill="#7C63FF"/>
        <circle cx="8" cy="8" r="2.15" fill="#0A1220"/>
        <circle cx="8" cy="8" r="1.15" fill="#E8F7FF"/>
      </svg>
    `.trim();
  }

  if (link.key === 'padre') {
    return `
      <svg class="${className} terminal-icon-inline terminal-icon-${link.key}" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.2 10.8L8.9 7.1C10 6 11.7 6 12.8 7.1C13.9 8.2 13.9 9.9 12.8 11L9.1 14.7C8 15.8 6.3 15.8 5.2 14.7C4.1 13.6 4.1 11.9 5.2 10.8Z" stroke="#86EFAC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M6.6 9.4L9.4 6.6" stroke="#C8FFD8" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `.trim();
  }

  return null;
}

function buildInlineTradeTerminalIcon(link: TradeTerminalLink, className: string) {
  const markup = getInlineTradeTerminalIconMarkup(link, className);
  if (!markup) {
    return null;
  }

  const template = document.createElement('template');
  template.innerHTML = markup;
  const icon = template.content.firstElementChild;
  return icon instanceof SVGElement ? icon : null;
}

function normalizeEnabledTradeTerminals(input?: TradeTerminalKey[] | null) {
  if (!Array.isArray(input)) {
    return [...DEFAULT_TRADE_TERMINALS];
  }

  const next: TradeTerminalKey[] = [];
  const seen = new Set<TradeTerminalKey>();
  for (const item of input) {
    if (item !== 'axiom' && item !== 'photon' && item !== 'bullx' && item !== 'gmgn' && item !== 'padre') {
      continue;
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    next.push(item);
  }

  return next.length > 0 ? next : [...DEFAULT_TRADE_TERMINALS];
}

export function bindBucketSortControls(section: ParentNode, controller: AppController, mode: 'manual' | 'recent' | 'old-week') {
  section.querySelectorAll<HTMLButtonElement>('[data-sort-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const sortMode = button.dataset.sortMode as BucketSortMode | undefined;
      const sortWindow = button.dataset.sortWindow as BucketSortWindow | undefined;
      if (!sortMode) return;

      const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
      if (wrap) {
        wrap.classList.remove('open');
      }

      if (mode === 'manual') controller.setManualSort(sortMode, sortWindow);
      else if (mode === 'recent') controller.setRecentSort(sortMode, sortWindow);
      else controller.setOldWeekSort(sortMode, sortWindow);
    });
  });
}

export function bindCompactSearch(
  section: ParentNode,
  options: { toggleAction: string; inputAction: string },
) {
  const input = section.querySelector<HTMLInputElement>(`[data-action="${options.inputAction}"]`);
  const toggle = section.querySelector<HTMLButtonElement>(`[data-action="${options.toggleAction}"]`);
  const wrap = input?.closest<HTMLElement>('.compact-search');
  if (!input || !toggle || !wrap) {
    return;
  }

  let clearButton = wrap.querySelector<HTMLButtonElement>('.compact-search-clear');
  if (!clearButton) {
    clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'compact-search-clear';
    clearButton.setAttribute('aria-label', 'Clear search');
    clearButton.textContent = '×';
    wrap.append(clearButton);
  }

  const syncHasQuery = () => {
    const hasQuery = Boolean(String(input.value || '').trim());
    wrap.classList.toggle('has-query', hasQuery);
    wrap.classList.toggle('open', hasQuery || document.activeElement === input);
  };

  const open = () => wrap.classList.add('open');
  const closeIfEmpty = () => {
    if (!String(input.value || '').trim()) {
      wrap.classList.remove('open');
    }
  };

  syncHasQuery();

  toggle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    open();
    window.requestAnimationFrame(() => {
      input.focus();
      window.requestAnimationFrame(() => input.focus());
    });
  });

  clearButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    input.value = '';
    syncHasQuery();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    wrap.classList.remove('open');
    input.blur();
  });

  input.addEventListener('focus', open);
  input.addEventListener('blur', () => {
    syncHasQuery();
    closeIfEmpty();
  });
  input.addEventListener('input', syncHasQuery);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      return;
    }

    if (event.key === 'Escape') {
      if (!String(input.value || '').trim()) {
        wrap.classList.remove('open');
      }
      input.blur();
    }
  });
}

export function bindMonitoredSortControls(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-monitored-sort-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.monitoredSortMode as MonitoredSortMode | undefined;
      const window = button.dataset.monitoredSortWindow as MonitoredSortWindow | undefined;
      if (!mode) return;

      const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
      if (wrap) {
        wrap.classList.remove('open');
      }

      controller.setMonitoredSort(mode, window);
    });
  });
}

function bindCommittedNumberInput(
  input: HTMLInputElement | null | undefined,
  onCommit: (value: number) => void,
) {
  if (!input) return;

  const commit = () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    onCommit(value);
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  });
}

export function bindPagedMonitoredControls(section: ParentNode, controller: AppController) {
  section.querySelector<HTMLButtonElement>('[data-action="monitored-prev"]')?.addEventListener('click', () => {
    controller.setMonitoredPage(controller.state.ui.monitoredPage - 1);
  });

  section.querySelector<HTMLButtonElement>('[data-action="monitored-next"]')?.addEventListener('click', () => {
    controller.setMonitoredPage(controller.state.ui.monitoredPage + 1);
  });

  bindCommittedNumberInput(section.querySelector<HTMLInputElement>('[data-action="monitored-per-page"]'), (value) => {
    controller.setMonitoredPerPage(value);
  });

  bindCommittedNumberInput(section.querySelector<HTMLInputElement>('[data-action="monitored-page-jump"]'), (value) => {
    controller.setMonitoredPage(value - 1);
  });
}

export function bindPagedBucketControls(section: ParentNode, controller: AppController, mode: 'recent' | 'old-week') {
  const prevAction = mode === 'recent' ? 'recent-prev' : 'old-week-prev';
  const nextAction = mode === 'recent' ? 'recent-next' : 'old-week-next';
  const perPageAction = mode === 'recent' ? 'recent-per-page' : 'old-week-per-page';
  const pageJumpAction = mode === 'recent' ? 'recent-page-jump' : 'old-week-page-jump';

  section.querySelector<HTMLButtonElement>(`[data-action="${prevAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage - 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage - 1);
  });

  section.querySelector<HTMLButtonElement>(`[data-action="${nextAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage + 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage + 1);
  });

  section.querySelectorAll<HTMLInputElement>(`[data-action="${perPageAction}"]`).forEach((input) => {
    bindCommittedNumberInput(input, (value) => {
      if (mode === 'recent') controller.setRecentPerPage(value);
      else controller.setOldWeekPerPage(value);
    });
  });

  section.querySelectorAll<HTMLInputElement>(`[data-action="${pageJumpAction}"]`).forEach((input) => {
    bindCommittedNumberInput(input, (value) => {
      if (mode === 'recent') controller.setRecentPage(value - 1);
      else controller.setOldWeekPage(value - 1);
    });
  });
}

export function renderFlash(state: AppState) {
  if (!state.ui.error && !state.ui.notice) return '';
  const message = state.ui.error ?? state.ui.notice ?? '';
  const flashKind = getAuthFeedbackKind(state, message);
  const shouldPulse = Boolean(
    state.ui.error
    && state.ui.loginErrorCount > 1
    && state.ui.error.includes('Incorrect email or password'),
  );
  const toneClass = `${state.ui.error ? 'flash error' : 'flash notice'} flash-${flashKind}${shouldPulse ? ' flash-pulse' : ''}`;
  const badge = getAuthFlashBadge(flashKind);
  const liveRole = state.ui.error ? 'alert' : 'status';
  return `<div class="${toneClass}" role="${liveRole}" aria-live="polite"><span class="flash-copy">${badge ? `<strong class="flash-badge">${escapeHtml(badge)}</strong>` : ''}<span>${escapeHtml(message)}</span></span><button type="button" class="flash-dismiss" data-action="dismiss-flash">Close</button></div>`;
}

function getAgeBucketEmptyState(mode: 'recent' | 'old-week') {
  return `<p class="muted-block">No ${mode === 'recent' ? 'recent' : 'old-week'} tokens currently match the routed MCAP and age filters.</p>`;
}

function resolveAgeBucketRows(
  tokens: ManualTokenEntry[],
  sortCriteria: BucketSortCriterion[],
  options?: { skipClientSort?: boolean },
) {
  return options?.skipClientSort ? [...tokens] : sortBucketTokens(tokens, sortCriteria);
}

function paginateAgeBucketRows(
  rows: ManualTokenEntry[],
  page: number,
  perPage: number,
  totalCount: number,
  options?: { skipClientSort?: boolean },
) {
  const safePerPage = Math.max(10, Math.floor(perPage) || 15);
  const resolvedTotalCount = Math.max(rows.length, totalCount);
  const totalPages = Math.max(1, Math.ceil(resolvedTotalCount / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  const pageStart = safePage * safePerPage;
  return {
    totalPages,
    safePage,
    pageStart,
    pageItems: options?.skipClientSort ? rows : rows.slice(pageStart, pageStart + safePerPage),
  };
}

export function renderManualTokenTable(
  tokens: ManualTokenEntry[],
  busy: boolean,
  starredTokens: string[] = [],
  _sortCriteria: BucketSortCriterion[] = [{ mode: 'mcap', window: 'highest' }],
  meteoraByAddress: Record<string, MeteoraEntry> = {},
  meteoraMinPool = 5000,
  isAdmin = false,
  enabledTradeTerminals: TradeTerminalKey[] = DEFAULT_TRADE_TERMINALS,
  options?: {
    showSparkline?: boolean;
    sparklineByAddress?: Record<string, TokenSparklineEntry>;
  },
) {
  if (tokens.length === 0) return '<p class="muted-block">No manual tokens yet.</p>';
  const starredSet = new Set(starredTokens);
  return renderTokenTableShell({
    tone: 'manual',
    mode: 'manual',
    rows: tokens,
    busy,
    starredSet,
    meteoraByAddress,
    meteoraMinPool,
    isAdmin,
    enabledTradeTerminals,
    showSparkline: options?.showSparkline,
    sparklineByAddress: options?.sparklineByAddress,
  });
}

export function renderPagedAgeBucketList(
  tokens: ManualTokenEntry[],
  busy: boolean,
  mode: 'recent' | 'old-week',
  page: number,
  perPage: number,
  starredTokens: string[] = [],
  sortCriteria: BucketSortCriterion[] = [{ mode: 'vol', window: '24h' }],
  meteoraByAddress: Record<string, MeteoraEntry> = {},
  meteoraMinPool = 5000,
  isAdmin = false,
  enabledTradeTerminals: TradeTerminalKey[] = DEFAULT_TRADE_TERMINALS,
  options?: {
    totalCount?: number;
    skipClientSort?: boolean;
    showSparkline?: boolean;
    sparklineByAddress?: Record<string, TokenSparklineEntry>;
  },
) {
  const totalCount = Math.max(0, Number(options?.totalCount) || 0);
  if (tokens.length === 0 && totalCount === 0) {
    return getAgeBucketEmptyState(mode);
  }

  const starredSet = new Set(starredTokens);
  const rows = resolveAgeBucketRows(tokens, sortCriteria, options);
  const { totalPages, safePage, pageStart, pageItems } = paginateAgeBucketRows(rows, page, perPage, totalCount, options);

  return `
    ${renderTokenTableShell({
      tone: mode,
      mode,
      rows: pageItems,
      busy,
      starredSet,
      meteoraByAddress,
      meteoraMinPool,
      startRank: pageStart + 1,
      isAdmin,
      enabledTradeTerminals,
      showSparkline: options?.showSparkline,
      sparklineByAddress: options?.sparklineByAddress,
    })}
    <div class="bucket-footer">
      <div class="bucket-page-controls">
        <label class="legacy-mini-field">PAGE <input type="number" min="1" max="${totalPages}" step="1" data-action="${mode === 'recent' ? 'recent-page-jump' : 'old-week-page-jump'}" /></label>
        <span class="bucket-page-total">${totalPages}</span>
      </div>
      <div class="button-row compact bucket-footer-actions">
        <button type="button" class="action-button small" data-action="${mode === 'recent' ? 'recent-prev' : 'old-week-prev'}" ${safePage === 0 ? 'disabled' : ''}>Prev</button>
        <button type="button" class="action-button small" data-action="${mode === 'recent' ? 'recent-next' : 'old-week-next'}" ${safePage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function renderTokenTableShell(options: {
  tone: 'manual' | 'recent' | 'old-week';
  mode: 'manual' | 'recent' | 'old-week';
  rows: ManualTokenEntry[];
  busy: boolean;
  starredSet: Set<string>;
  meteoraByAddress: Record<string, MeteoraEntry>;
  meteoraMinPool: number;
  startRank?: number;
  isAdmin?: boolean;
  enabledTradeTerminals: TradeTerminalKey[];
  showSparkline?: boolean;
  sparklineByAddress?: Record<string, TokenSparklineEntry>;
}) {
  const showSparkline = Boolean(options.showSparkline);
  return `
    <div class="token-table-wrap token-table-${options.tone}">
      <table class="token-table ${options.tone}">
        <thead>
          <tr>
            <th class="rank-col">#</th>
            <th>Token</th>
            ${showSparkline ? '<th class="sparkline-col">Chart</th>' : ''}
            <th class="num-col">Age</th>
            <th class="num-col">MCAP</th>
            <th class="delta-col">D</th>
            ${options.mode === 'manual' ? '<th class="num-col">Vol 5M</th>' : ''}
            <th class="num-col">Vol 1H</th>
            <th class="num-col">Vol 6H</th>
            <th class="num-col">Vol 24H</th>
            <th class="num-col">PChg 1H</th>
            <th class="num-col">PChg 6H</th>
            <th class="num-col">PChg 24H</th>
            <th class="num-col">Meteora</th>
            <th class="action-col"></th>
          </tr>
        </thead>
        <tbody>
          ${options.rows.map((item, index) => renderTokenTableRow(
            item,
            options.mode,
            options.busy,
            options.starredSet.has(item.address),
            options.meteoraByAddress,
            options.meteoraMinPool,
            (options.startRank ?? 1) + index,
            Boolean(options.isAdmin),
            options.enabledTradeTerminals,
            showSparkline ? options.sparklineByAddress?.[item.address] || null : null,
          )).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function normalizeSparklineSeries(series: number[] | null | undefined) {
  return Array.isArray(series) ? series.filter((value) => Number.isFinite(value)) : [];
}

function buildSparklinePolyline(series: number[]) {
  if (series.length < 2) {
    return '';
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  const innerWidth = SPARKLINE_SVG_WIDTH - (SPARKLINE_PADDING_X * 2);
  const innerHeight = SPARKLINE_SVG_HEIGHT - (SPARKLINE_PADDING_Y * 2);

  return series.map((value, index) => {
    const x = SPARKLINE_PADDING_X + ((innerWidth * index) / Math.max(1, series.length - 1));
    const normalized = range > 0 ? (value - min) / range : 0.5;
    const y = SPARKLINE_PADDING_Y + innerHeight - (normalized * innerHeight);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function buildSparklineTitle(entry: TokenSparklineEntry, series: number[]) {
  const parts = [`Mini chart`, `${series.length} pts`];
  parts.push(`${formatSparklineSpan(entry.effectiveHours)} span`);
  parts.push(`${formatSparklineGranularity(entry.granularityMinutes)} resolution`);

  if (entry.coverageRatio != null && Number.isFinite(entry.coverageRatio)) {
    parts.push(`${Math.round(entry.coverageRatio * 100)}% cov`);
  }
  if (entry.generatedAt) {
    parts.push(`updated ${new Date(entry.generatedAt).toLocaleString()}`);
  }

  return parts.join(' · ');
}

function formatSparklineSpan(hours?: number | null) {
  const safeHours = Number(hours);
  if (!Number.isFinite(safeHours) || safeHours <= 0) {
    return '7D max';
  }

  if (safeHours >= 24) {
    const days = Math.max(1, Math.round(safeHours / 24));
    return `${days}D of 7D max`;
  }

  return `${Math.max(1, Math.round(safeHours))}H of 7D max`;
}

function formatSparklineGranularity(granularityMinutes?: number | null) {
  const safeGranularity = Number(granularityMinutes);
  if (!Number.isFinite(safeGranularity) || safeGranularity <= 0) {
    return '15m';
  }

  return `${Math.round(safeGranularity)}m`;
}

function renderSparklineCell(entry: TokenSparklineEntry | null) {
  if (!entry) {
    return '<span class="sparkline-empty" title="Chart not loaded for this row">-</span>';
  }

  const series = normalizeSparklineSeries(entry.series);
  if (series.length < 2) {
    return '<span class="sparkline-empty" title="Chart unavailable for this row yet">-</span>';
  }

  const start = series[0];
  const end = series[series.length - 1];
  const trendClass = end > start ? 'up' : end < start ? 'down' : 'flat';
  const title = escapeHtml(buildSparklineTitle(entry, series));
  const polyline = buildSparklinePolyline(series);

  return `
    <div class="sparkline-wrap ${trendClass}" title="${title}">
      <svg class="token-sparkline" viewBox="0 0 ${SPARKLINE_SVG_WIDTH} ${SPARKLINE_SVG_HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <polyline class="token-sparkline-glow" points="${polyline}"></polyline>
        <polyline class="token-sparkline-line" points="${polyline}"></polyline>
      </svg>
    </div>
  `;
}

function resolveTokenMcapDelta(item: ManualTokenEntry) {
  if (item.mcapDelta != null) {
    return item.mcapDelta;
  }
  if (!(item.prevMcap && item.prevMcap > 0) || item.mcap == null) {
    return null;
  }

  return ((item.mcap - item.prevMcap) / item.prevMcap) * 100;
}

function renderBucketDismissButton(mode: 'manual' | 'recent' | 'old-week', safeAddress: string, busy: boolean) {
  if (mode === 'manual') {
    return `<button type="button" class="inline-icon danger" data-action="remove-manual" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`;
  }

  const action = mode === 'recent' ? 'dismiss-recent' : 'dismiss-old-week';
  return `<button type="button" class="inline-icon danger" data-action="${action}" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`;
}

function renderTokenTwitterAction(twitterUrl: string | null, twitterMeta: { title: string; icon: string }) {
  if (!twitterUrl) {
    return '<span class="action-glyph x-profile disabled" title="No X profile">&#128100;</span>';
  }

  return `<a class="action-glyph x-profile" href="${twitterUrl}" target="_blank" rel="noreferrer" title="${escapeHtml(twitterMeta.title)}">${twitterMeta.icon}</a>`;
}

function renderTokenAdminAction(isAdmin: boolean, safeAddress: string, safeSymbol: string, busy: boolean) {
  if (!isAdmin) {
    return '';
  }

  return `<button type="button" class="action-glyph danger-glyph" data-action="admin-block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''} title="Admin block permanently">&#9760;</button>`;
}

function renderBucketVolumeCell(mode: 'manual' | 'recent' | 'old-week', item: ManualTokenEntry) {
  if (mode !== 'manual') {
    return '';
  }

  return `<td class="num-col">${fmtMoney(item.volume5m)}</td>`;
}

function renderBucketSparklineCell(mode: 'manual' | 'recent' | 'old-week', sparkline: TokenSparklineEntry | null) {
  return `<td class="sparkline-col">${renderSparklineCell(sparkline)}</td>`;
}

function renderTokenTableRow(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week', busy: boolean, isStarred: boolean, meteoraByAddress: Record<string, MeteoraEntry>, meteoraMinPool: number, rank: number, isAdmin: boolean, enabledTradeTerminals: TradeTerminalKey[], sparkline: TokenSparklineEntry | null = null) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const safeAddress = escapeHtml(item.address);
  const safeSymbol = escapeHtml(symbol);
  const safeName = escapeHtml(item.name || item.label || item.address);
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = buildXSearchUrl(symbol, item.address);
  const twitterUrl = sanitizeOptionalHttpUrl(item.twitterUrl);
  const twitterMeta = getXDestinationMeta(twitterUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const mcapDelta = resolveTokenMcapDelta(item);
  const actionButton = renderBucketDismissButton(mode, safeAddress, busy);

  return `
    <tr class="${isStarred ? 'token-starred' : ''}" data-hover-key="${mode}:${safeAddress}">
      <td class="rank-col">#${rank}</td>
      <td>
        <div class="token-cell">
          ${renderAvatar(item, symbol)}
          <div class="token-main">
            <div class="token-line">
              <a class="token-symbol" href="${dexUrl}" target="_blank" rel="noreferrer">${safeSymbol}</a>
              <div class="token-actions-inline">
                <a class="action-glyph x-search" href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" title="Search contract or ticker on X">X</a>
                ${renderTokenTwitterAction(twitterUrl, twitterMeta)}
                <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeAddress}" title="Copy contract">&#10697;</button>
                ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress, { enabledTradeTerminals })}
                <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
                ${renderTokenAdminAction(isAdmin, safeAddress, safeSymbol, busy)}
              </div>
            </div>
            <div class="token-subline">${safeName}</div>
          </div>
        </div>
      </td>
      ${renderBucketSparklineCell(mode, sparkline)}
      <td class="num-col">${age}</td>
      <td class="num-col strong">${fmtMoney(item.mcap)}</td>
      <td class="delta-col">${renderPctSpan(mcapDelta)}</td>
      ${renderBucketVolumeCell(mode, item)}
      <td class="num-col">${fmtMoney(item.volume1h)}</td>
      <td class="num-col">${fmtMoney(item.volume6h)}</td>
      <td class="num-col">${fmtMoney(item.volume24h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange1h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange6h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange24h)}</td>
      <td class="num-col meteora-col">${renderMeteoraCell(item.address, meteoraByAddress[item.address], meteoraMinPool)}</td>
      <td class="action-col">${actionButton}</td>
    </tr>
  `;
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
      icon: '&#128101;',
    };
  }

  return {
    title: 'X profile',
    icon: '&#128100;',
  };
}

const METEORA_TVL_HISTORY_1H = 3600000;
const METEORA_TVL_HISTORY_6H = 21600000;
const METEORA_TVL_HISTORY_24H = 86400000;

function getMeteoraTvlChange(entry: MeteoraEntry, windowMs: number) {
  if (windowMs === METEORA_TVL_HISTORY_1H && entry.change1h != null) {
    return entry.change1h;
  }
  if (windowMs === METEORA_TVL_HISTORY_6H && entry.change6h != null) {
    return entry.change6h;
  }
  if (windowMs === METEORA_TVL_HISTORY_24H && entry.change24h != null) {
    return entry.change24h;
  }

  const history = entry.history || [];
  if (history.length < 2 || !(entry.tvl > 0)) {
    return null;
  }

  const now = Date.now();
  const targetTs = now - windowMs;
  let baseline: { tvl: number; ts: number } | null = null;

  for (const point of history) {
    if (point.ts <= targetTs) {
      baseline = point;
    } else if (!baseline) {
      baseline = point;
      break;
    } else {
      break;
    }
  }

  if (!baseline || !(baseline.tvl > 0)) {
    return null;
  }

  const pct = ((entry.tvl - baseline.tvl) / baseline.tvl) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function renderMeteoraDelta(label: string, value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return `<div class="meteora-tip-line"><span>${escapeHtml(label)}</span><span class="muted">-</span></div>`;
  }

  const cls = value >= 0 ? 'pct-pos' : 'pct-neg';
  return `<div class="meteora-tip-line"><span>${escapeHtml(label)}</span><span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(1)}%</span></div>`;
}

function renderMeteoraCell(address: string, entry: MeteoraEntry | undefined, minPool: number) {
  if (!entry || entry.noPool || !(entry.tvl > 0) || (minPool > 0 && entry.tvl < minPool)) {
    return '-';
  }

  const ch1h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_1H);
  const ch6h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_6H);
  const ch24h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_24H);
  const poolLabel = escapeHtml((entry.poolCount || 0) > 1 ? `${entry.poolCount} pools` : '1 pool');

  return `
    <div class="met-tip-wrap">
      <span class="meteora-value">$${fmtCompact(entry.tvl)}</span>
      <div class="met-tip-dd">
        <div class="meteora-tip-head"><span>🌊 Meteora TVL</span><span>${poolLabel}</span></div>
        ${renderMeteoraDelta('1H', ch1h)}
        ${renderMeteoraDelta('6H', ch6h)}
        ${renderMeteoraDelta('24H', ch24h)}
      </div>
    </div>
  `;
}

function renderAvatar(item: ManualTokenEntry, symbol: string) {
  const safeSymbol = escapeHtml(symbol);
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  return imageUrl ? `<img src="${imageUrl}" alt="${safeSymbol}" class="token-avatar" />` : `<div class="token-avatar placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;
}

function renderPctSpan(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '<span class="pct-neutral">-</span>';
  const cls = value >= 0 ? 'pct-pos' : 'pct-neg';
  return `<span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(2)}%</span>`;
}

export function fmtMoney(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtCompact(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return value.toFixed(0);
}

export function fmtPct(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function fmtAge(createdAt: number) {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const monthDays = 30;
  const months = Math.floor(ageMs / (monthDays * 86400000));
  if (months >= 12) {
    return `${Math.floor(months / 12)}y`;
  }
  if (months >= 1) {
    return `${months}mo`;
  }

  const days = Math.floor(ageMs / 86400000);
  if (days >= 1) return `${days}d`;

  const hours = Math.floor(ageMs / 3600000);
  if (hours >= 1) return `${hours}h`;

  const minutes = Math.floor(ageMs / 60000);
  if (minutes >= 1) return `${minutes}m`;

  const seconds = Math.floor(ageMs / 1000);
  return `${seconds}s`;
}

export function fmtConfig(state: AppState, key: string, fallback: number) {
  const value = Number(state.data.configs[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function renderTokenCard(item: ManualTokenEntry, busy: boolean, options: { mode: 'manual' | 'monitored' | 'recent' | 'old-week'; isStarred?: boolean; isAdmin?: boolean; enabledTradeTerminals?: TradeTerminalKey[] }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderManualTokenTable([item], busy, options.isStarred ? [item.address] : [], [{ mode: 'mcap', window: 'highest' }], {}, 5000, Boolean(options.isAdmin), options.enabledTradeTerminals ?? DEFAULT_TRADE_TERMINALS);
  return wrapper.innerHTML;
}
