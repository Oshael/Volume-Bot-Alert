import type { AppController } from '../../state/app-controller';
import type { AppState, ManualTokenEntry, RemovalLogEntry } from '../../state/app-state';

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
      button.classList.toggle('active', willBeStarred);
      button.innerHTML = willBeStarred ? '&#9733;' : '&#9734;';

      const tokenRow = button.closest('.token-starred, tr, article, .token-row, .alert-row');
      if (tokenRow instanceof HTMLElement) {
        tokenRow.classList.toggle('token-starred', willBeStarred);
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

export function renderTradeTerminalMenu(address: string, mintAddress?: string | null, pairAddress?: string | null) {
  const tokenAddress = mintAddress || address;
  const terminalAddress = pairAddress || mintAddress || address;
  const links = [
    { label: 'Axiom', href: `https://axiom.trade/meme/${terminalAddress}?chain=sol`, cls: 'axiom' },
    { label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${tokenAddress}`, cls: 'photon' },
    { label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`, cls: 'bullx' },
    { label: 'GMGN', href: `https://gmgn.ai/sol/token/${tokenAddress}`, cls: 'gmgn' },
    { label: 'Padre', href: `https://trade.padre.gg/sol/${terminalAddress}`, cls: 'padre' },
  ];

  return `
    <div class="trade-wrap" data-trade-wrap>
      <button type="button" class="action-glyph trade-btn" title="Open in trading terminal">&#128279;</button>
      <div class="trade-dd" data-trade-menu>
        ${links.map((link) => `<a class="trade-link ${link.cls}" href="${link.href}" target="_blank" rel="noreferrer">${link.label}</a>`).join('')}
      </div>
    </div>
  `;
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

export function bindMonitoredSortControls(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-monitored-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.monitoredSort as '5m' | '1h' | '6h' | '24h' | 'mcap' | undefined;
      if (mode) controller.setMonitoredSort(mode);
    });
  });
}

export function bindPagedBucketControls(section: ParentNode, controller: AppController, mode: 'recent' | 'old-week') {
  const prevAction = mode === 'recent' ? 'recent-prev' : 'old-week-prev';
  const nextAction = mode === 'recent' ? 'recent-next' : 'old-week-next';
  const perPageAction = mode === 'recent' ? 'recent-per-page' : 'old-week-per-page';

  section.querySelector<HTMLButtonElement>(`[data-action="${prevAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage - 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage - 1);
  });

  section.querySelector<HTMLButtonElement>(`[data-action="${nextAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage + 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage + 1);
  });

  section.querySelectorAll<HTMLInputElement>(`[data-action="${perPageAction}"]`).forEach((input) => {
    input.addEventListener('change', (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      if (mode === 'recent') controller.setRecentPerPage(value);
      else controller.setOldWeekPerPage(value);
    });
  });
}

export function renderFlash(state: AppState) {
  if (!state.ui.error && !state.ui.notice) return '';
  const toneClass = state.ui.error ? 'flash error' : 'flash notice';
  const message = state.ui.error ?? state.ui.notice ?? '';
  return `<div class="${toneClass}"><span>${message}</span><button type="button" class="flash-dismiss" data-action="dismiss-flash">Close</button></div>`;
}

export function renderLogSummary(title: string, entries: RemovalLogEntry[], clearAction: string, tone: 'recent' | 'old-week') {
  if (entries.length === 0) return '';
  return `
    <div class="log-hover ${tone}">
      <div class="legacy-removal-badge">${entries.length} removed</div>
      <div class="log-hover-panel ${tone}">
        <div class="log-hover-head">
          <span>${title}</span>
          <button type="button" class="action-button small" data-action="${clearAction}">Clear All</button>
        </div>
        <div class="removal-log-list">${entries.slice(0, 8).map((entry) => renderRemovalLogEntry(entry)).join('')}</div>
      </div>
    </div>
  `;
}

type BucketSortMode = 'vol' | 'mcap' | 'pchange';
type BucketSortWindow = '1h' | '6h' | '24h';

function getBucketMetric(item: ManualTokenEntry, mode: BucketSortMode, window: BucketSortWindow) {
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

function sortBucketTokens(tokens: ManualTokenEntry[], mode: BucketSortMode, window: BucketSortWindow) {
  return [...tokens].sort((a, b) => {
    const delta = getBucketMetric(b, mode, window) - getBucketMetric(a, mode, window);
    if (delta !== 0) return delta;
    return (b.mcap || 0) - (a.mcap || 0);
  });
}

export function renderManualTokenTable(tokens: ManualTokenEntry[], busy: boolean, starredTokens: string[] = [], sortMode: BucketSortMode = 'mcap', sortWindow: BucketSortWindow = '24h') {
  if (tokens.length === 0) return '<p class="muted-block">No manual tokens loaded for this account yet.</p>';
  const starredSet = new Set(starredTokens);
  const sorted = sortBucketTokens(tokens, sortMode, sortWindow);
  return renderTokenTableShell({ tone: 'manual', mode: 'manual', rows: sorted, busy, starredSet });
}

export function renderPagedAgeBucketList(tokens: ManualTokenEntry[], busy: boolean, mode: 'recent' | 'old-week', page: number, perPage: number, starredTokens: string[] = [], sortMode: BucketSortMode = 'vol', sortWindow: BucketSortWindow = '24h') {
  if (tokens.length === 0) return `<p class="muted-block">No ${mode === 'recent' ? 'recent' : 'old-week'} tokens currently match the routed MCAP and age filters.</p>`;

  const starredSet = new Set(starredTokens);
  const sorted = sortBucketTokens(tokens, sortMode, sortWindow);
  const safePerPage = Math.max(10, Math.floor(perPage) || 30);
  const totalPages = Math.max(1, Math.ceil(sorted.length / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  const pageStart = safePage * safePerPage;
  const pageItems = sorted.slice(pageStart, pageStart + safePerPage);

  return `
    ${renderTokenTableShell({ tone: mode, mode, rows: pageItems, busy, starredSet, startRank: pageStart + 1 })}
    <div class="bucket-footer">
      <label class="compact-inline"><span>Per Page</span><input type="number" min="10" step="1" data-action="${mode === 'recent' ? 'recent-per-page' : 'old-week-per-page'}" value="${safePerPage}" /></label>
      <div class="bucket-page-indicator">Page ${safePage + 1} / ${totalPages}</div>
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
  startRank?: number;
}) {
  return `
    <div class="token-table-wrap token-table-${options.tone}">
      <table class="token-table ${options.tone}">
        <thead>
          <tr>
            ${options.mode === 'manual' ? '' : '<th class="rank-col">#</th>'}
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
          ${options.rows.map((item, index) => renderTokenTableRow(item, options.mode, options.busy, options.starredSet.has(item.address), (options.startRank ?? 1) + index)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTokenTableRow(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week', busy: boolean, isStarred: boolean, rank: number) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const dexUrl = item.pairUrl || `https://dexscreener.com/solana/${item.address}`;
  const xSearch = `https://x.com/search?q=%24${encodeURIComponent(symbol)}`;
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const mcapDelta = item.prevMcap && item.prevMcap > 0 && item.mcap != null ? ((item.mcap - item.prevMcap) / item.prevMcap) * 100 : null;
  const actionButton = mode === 'manual'
    ? `<button type="button" class="inline-icon danger" data-action="remove-manual" data-address="${item.address}" ${busy ? 'disabled' : ''}>X</button>`
    : `<button type="button" class="inline-icon danger" data-action="${mode === 'recent' ? 'dismiss-recent' : 'dismiss-old-week'}" data-address="${item.address}" ${busy ? 'disabled' : ''}>X</button>`;

  return `
    <tr class="${isStarred ? 'token-starred' : ''}" data-hover-key="${mode}:${item.address}">
      ${mode === 'manual' ? '' : `<td class="rank-col">#${rank}</td>`}
      <td>
        <div class="token-cell">
          ${renderAvatar(item, symbol)}
          <div class="token-main">
            <div class="token-line">
              <a class="token-symbol" href="${dexUrl}" target="_blank" rel="noreferrer">${symbol}</a>
              <div class="token-actions-inline">
                <a class="action-glyph x-search" href="${xSearch}" target="_blank" rel="noreferrer" title="Search ticker on X">X</a>
                ${item.twitterUrl ? `<a class="action-glyph x-profile" href="${item.twitterUrl}" target="_blank" rel="noreferrer" title="X profile">&#128100;</a>` : `<span class="action-glyph x-profile disabled" title="No X profile">&#128100;</span>`}
                <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${item.address}" title="Copy contract">&#10697;</button>
                ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress)}
                <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${item.address}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
              </div>
            </div>
            <div class="token-subline">${item.name || item.label || item.address}</div>
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
      <td class="num-col meteora-col">-</td>
      <td class="action-col">${actionButton}</td>
    </tr>
  `;
}

function renderRemovalLogEntry(entry: RemovalLogEntry) {
  const mcap = fmtMoney(entry.mcap);
  const droppedTo = extractDroppedMcap(entry.reason) ?? mcap;
  const avatar = entry.imageUrl ? `<img src="${entry.imageUrl}" alt="${entry.symbol}" class="log-entry-avatar" />` : `<div class="log-entry-avatar placeholder">${entry.symbol.slice(0, 2).toUpperCase()}</div>`;
  return `
    <article class="log-entry-card">
      <div class="log-entry-head">${avatar}<div><div class="log-entry-title">${entry.symbol} <span>MCAP ${mcap}</span></div><div class="log-entry-body">MCAP dropped to ${droppedTo} - below min $120K</div><div class="log-entry-time">${fmtLogDate(entry.ts)}</div></div></div>
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
  return item.imageUrl ? `<img src="${item.imageUrl}" alt="${symbol}" class="token-avatar" />` : `<div class="token-avatar placeholder">${symbol.slice(0, 2).toUpperCase()}</div>`;
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

export function renderTokenCard(item: ManualTokenEntry, busy: boolean, options: { mode: 'manual' | 'monitored' | 'recent' | 'old-week'; isStarred?: boolean }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderManualTokenTable([item], busy, options.isStarred ? [item.address] : []);
  return wrapper.innerHTML;
}






