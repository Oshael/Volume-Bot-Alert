import type { AppController } from '../../state/app-controller';
import type { AppState, BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry, MeteoraEntry, MonitoredSortMode, MonitoredSortWindow, RemovalLogEntry } from '../../state/app-state';
import { getAuthFeedbackKind, getAuthFlashBadge } from './auth-feedback';
import { escapeHtml, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

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
      try {
        await navigator.clipboard.writeText(address);
        const original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        button.textContent = 'Copy failed';
      }
    });
  }
}

export function renderTradeTerminalMenu(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null },
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);

  return `
    <div class="trade-wrap" data-trade-wrap>
      <button type="button" class="action-glyph trade-btn" title="Open in trading terminal">&#128279;</button>
      <div class="trade-dd" data-trade-menu>
        ${links.map((link) => `<a class="trade-link ${link.cls}" href="${sanitizeHttpUrl(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join('')}
      </div>
    </div>
  `;
}

export function buildTradeTerminalMenuElement(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null },
) {
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

  for (const link of getTradeTerminalLinks(address, mintAddress, pairAddress, options)) {
    const anchor = document.createElement('a');
    anchor.className = `trade-link ${link.cls}`;
    anchor.href = sanitizeHttpUrl(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = link.label;
    menu.append(anchor);
  }

  wrapper.append(button, menu);
  return wrapper;
}

function getTradeTerminalLinks(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null },
) {
  const tokenAddress = mintAddress || address;
  const terminalAddress = pairAddress || mintAddress || address;
  const axiomAddress = options?.axiomAddress || pairAddress || tokenAddress;
  return [
    { label: 'Axiom', href: `https://axiom.trade/meme/${axiomAddress}?chain=sol`, cls: 'axiom' },
    { label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${tokenAddress}`, cls: 'photon' },
    { label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`, cls: 'bullx' },
    { label: 'GMGN', href: `https://gmgn.ai/sol/token/${tokenAddress}`, cls: 'gmgn' },
    { label: 'Padre', href: `https://trade.padre.gg/trade/solana/${terminalAddress}`, cls: 'padre' },
  ];
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

  const open = () => wrap.classList.add('open');
  const closeIfEmpty = () => {
    if (!String(input.value || '').trim()) {
      wrap.classList.remove('open');
    }
  };

  toggle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    open();
    window.requestAnimationFrame(() => {
      input.focus();
      window.requestAnimationFrame(() => input.focus());
    });
  });

  input.addEventListener('focus', open);
  input.addEventListener('blur', closeIfEmpty);
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

export function renderLogSummary(title: string, entries: RemovalLogEntry[], clearAction: string, tone: 'recent' | 'old-week') {
  if (entries.length === 0) return '';
  const safeTitle = escapeHtml(title);
  const visibleEntries = entries.slice(0, 20);
  return `
    <div class="log-hover ${tone}" data-log-hover>
      <button type="button" class="legacy-removal-badge" data-log-hover-toggle aria-expanded="false" aria-haspopup="dialog">${entries.length} removed</button>
      <div class="log-hover-panel ${tone}">
        <div class="log-hover-head">
          <div class="log-hover-title-wrap">
            <span>${safeTitle}</span>
            <small>${visibleEntries.length} latest token${visibleEntries.length === 1 ? '' : 's'}</small>
          </div>
          <div class="log-hover-actions">
            <button type="button" class="action-button small" data-action="${clearAction}">Clear All</button>
            <button type="button" class="action-button small" data-log-hover-close>Close</button>
          </div>
        </div>
        <div class="removal-log-list">${visibleEntries.map((entry) => renderRemovalLogEntry(entry)).join('')}</div>
      </div>
    </div>
  `;
}

function getBucketMetric(item: ManualTokenEntry, mode: BucketSortMode, window: BucketSortWindow) {
  if (mode === 'age') return item.createdAt || 0;
  if (mode === 'mcap') return item.mcap || 0;
  if (mode === 'pchange') {
    if (window === '1h') return item.priceChange1h || 0;
    if (window === '6h') return item.priceChange6h || 0;
    return item.priceChange24h || 0;
  }
  if (window === '1h') return item.volume1h || 0;
  if (window === '6h') return item.volume6h || 0;
  return item.volume24h || 0;
}

function compareBucketCriterion(a: ManualTokenEntry, b: ManualTokenEntry, criterion: BucketSortCriterion) {
  const aMetric = getBucketMetric(a, criterion.mode, criterion.window);
  const bMetric = getBucketMetric(b, criterion.mode, criterion.window);
  if ((criterion.mode === 'age' && criterion.window === 'oldest') || (criterion.mode === 'mcap' && criterion.window === 'lowest')) {
    return aMetric - bMetric;
  }
  return bMetric - aMetric;
}

function sortBucketTokens(tokens: ManualTokenEntry[], criteria: BucketSortCriterion[]) {
  return [...tokens].sort((a, b) => {
    for (const criterion of criteria) {
      const delta = compareBucketCriterion(a, b, criterion);
      if (delta !== 0) return delta;
    }
    const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDelta !== 0) return createdDelta;
    return (b.mcap || 0) - (a.mcap || 0);
  });
}

export function renderManualTokenTable(tokens: ManualTokenEntry[], busy: boolean, starredTokens: string[] = [], sortCriteria: BucketSortCriterion[] = [{ mode: 'mcap', window: 'highest' }], meteoraByAddress: Record<string, MeteoraEntry> = {}, meteoraMinPool = 5000, isAdmin = false) {
  if (tokens.length === 0) return '<p class="muted-block">No manual tokens loaded for this account yet.</p>';
  const starredSet = new Set(starredTokens);
  const sorted = sortBucketTokens(tokens, sortCriteria);
  return renderTokenTableShell({ tone: 'manual', mode: 'manual', rows: sorted, busy, starredSet, meteoraByAddress, meteoraMinPool, isAdmin });
}

export function renderPagedAgeBucketList(tokens: ManualTokenEntry[], busy: boolean, mode: 'recent' | 'old-week', page: number, perPage: number, starredTokens: string[] = [], sortCriteria: BucketSortCriterion[] = [{ mode: 'vol', window: '24h' }], meteoraByAddress: Record<string, MeteoraEntry> = {}, meteoraMinPool = 5000, isAdmin = false) {
  if (tokens.length === 0) return `<p class="muted-block">No ${mode === 'recent' ? 'recent' : 'old-week'} tokens currently match the routed MCAP and age filters.</p>`;

  const starredSet = new Set(starredTokens);
  const sorted = sortBucketTokens(tokens, sortCriteria);
  const safePerPage = Math.max(10, Math.floor(perPage) || 30);
  const totalPages = Math.max(1, Math.ceil(sorted.length / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  const pageStart = safePage * safePerPage;
  const pageItems = sorted.slice(pageStart, pageStart + safePerPage);

  return `
    ${renderTokenTableShell({ tone: mode, mode, rows: pageItems, busy, starredSet, meteoraByAddress, meteoraMinPool, startRank: pageStart + 1, isAdmin })}
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
}) {
  return `
    <div class="token-table-wrap token-table-${options.tone}">
      <table class="token-table ${options.tone}">
        <thead>
          <tr>
            <th class="rank-col">#</th>
            <th>Token</th>
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
          ${options.rows.map((item, index) => renderTokenTableRow(item, options.mode, options.busy, options.starredSet.has(item.address), options.meteoraByAddress, options.meteoraMinPool, (options.startRank ?? 1) + index, Boolean(options.isAdmin))).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTokenTableRow(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week', busy: boolean, isStarred: boolean, meteoraByAddress: Record<string, MeteoraEntry>, meteoraMinPool: number, rank: number, isAdmin: boolean) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const safeAddress = escapeHtml(item.address);
  const safeSymbol = escapeHtml(symbol);
  const safeName = escapeHtml(item.name || item.label || item.address);
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = `https://x.com/search?q=%24${encodeURIComponent(symbol)}`;
  const twitterUrl = sanitizeOptionalHttpUrl(item.twitterUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const mcapDelta = item.mcapDelta ?? (item.prevMcap && item.prevMcap > 0 && item.mcap != null ? ((item.mcap - item.prevMcap) / item.prevMcap) * 100 : null);
  const actionButton = mode === 'manual'
    ? `<button type="button" class="inline-icon danger" data-action="remove-manual" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`
    : `<button type="button" class="inline-icon danger" data-action="${mode === 'recent' ? 'dismiss-recent' : 'dismiss-old-week'}" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`;

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
                <a class="action-glyph x-search" href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" title="Search ticker on X">X</a>
                ${twitterUrl ? `<a class="action-glyph x-profile" href="${twitterUrl}" target="_blank" rel="noreferrer" title="X profile">&#128100;</a>` : `<span class="action-glyph x-profile disabled" title="No X profile">&#128100;</span>`}
                <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeAddress}" title="Copy contract">&#10697;</button>
                ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress)}
                <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
                ${isAdmin ? `<button type="button" class="action-glyph danger-glyph" data-action="admin-block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''} title="Admin block permanently">&#9760;</button>` : ''}
              </div>
            </div>
            <div class="token-subline">${safeName}</div>
          </div>
        </div>
      </td>
      <td class="num-col">${age}</td>
      <td class="num-col strong">${fmtMoney(item.mcap)}</td>
      <td class="delta-col">${renderPctSpan(mcapDelta)}</td>
      ${mode === 'manual' ? `<td class="num-col">${fmtMoney(item.volume5m)}</td>` : ''}
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

function renderRemovalLogEntry(entry: RemovalLogEntry) {
  const mcap = fmtMoney(entry.mcap);
  const droppedTo = extractDroppedMcap(entry.reason) ?? mcap;
  const safeSymbol = escapeHtml(entry.symbol);
  const safeAddress = escapeHtml(entry.address);
  const safeShortAddress = escapeHtml(`${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`);
  const imageUrl = sanitizeOptionalHttpUrl(entry.imageUrl);
  const avatar = imageUrl ? `<img src="${imageUrl}" alt="${safeSymbol}" class="log-entry-avatar" />` : `<div class="log-entry-avatar placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;
  const dexUrl = sanitizeHttpUrl(entry.pairUrl || `https://dexscreener.com/solana/${entry.address}`);
  return `
    <article class="log-entry-card">
      <div class="log-entry-head">
        ${avatar}
        <div class="log-entry-copy">
          <div class="log-entry-title">${safeSymbol} <span>MCAP ${escapeHtml(mcap)}</span></div>
          <div class="log-entry-address">${safeShortAddress}</div>
          <div class="log-entry-body">MCAP dropped to ${escapeHtml(droppedTo)} - below min $120K</div>
          <div class="log-entry-meta-row">
            <div class="log-entry-time">${escapeHtml(fmtLogDate(entry.ts))}</div>
            <div class="log-entry-actions">
              <button type="button" class="action-button small" data-action="copy-address" data-address="${safeAddress}">Copy CA</button>
              <a class="action-button small" href="${dexUrl}" target="_blank" rel="noreferrer">DEX</a>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function extractDroppedMcap(reason: string) {
  const match = reason.match(/\$[\d.,]+[KMB]?/i);
  return match ? match[0] : null;
}

function fmtLogDate(ts: number) {
  const date = new Date(ts);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}, ${hours}:${minutes}`;
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

export function renderTokenCard(item: ManualTokenEntry, busy: boolean, options: { mode: 'manual' | 'monitored' | 'recent' | 'old-week'; isStarred?: boolean; isAdmin?: boolean }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderManualTokenTable([item], busy, options.isStarred ? [item.address] : [], [{ mode: 'mcap', window: 'highest' }], {}, 5000, Boolean(options.isAdmin));
  return wrapper.innerHTML;
}
