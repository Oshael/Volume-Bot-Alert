import {
  fetchRobinhoodHolderHistory,
  fetchRobinhoodHoldersPage,
  type RobinhoodHolderHistory,
  type RobinhoodHoldersPage,
} from '../services/api/robinhood-holders';
import { escapeHtml } from './sections/html-safety';

interface MountOptions {
  token: string;
  authToken?: string | null;
  onShowChart: () => void;
  onShowHolders: () => void;
}

let activeCleanup: (() => void) | null = null;

function count(value: number | null) {
  return value == null ? '—' : value.toLocaleString('en-US');
}

function signed(value: number | null) {
  if (value == null) return 'comparison unavailable';
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-US')}`;
}

function rawBalance(value: string) {
  try { return BigInt(value).toLocaleString('en-US'); } catch { return value; }
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function renderRobinhoodExpandedHolderViews(
  chartHtml: string,
  footnoteHtml: string,
  holderCount: number | null | undefined,
) {
  return `<div class="robinhood-holder-views" data-robinhood-holder-views>
    <nav class="robinhood-holder-tabs" role="tablist" aria-label="Expanded token data">
      <button type="button" class="active" role="tab" aria-selected="true" data-holder-tab="chart">CHART</button>
      <button type="button" role="tab" aria-selected="false" data-holder-tab="holders">HOLDERS (<span data-holder-tab-count>${count(holderCount ?? null)}</span>)</button>
    </nav>
    <div data-holder-chart-view>${chartHtml}${footnoteHtml}</div>
    <section class="robinhood-holder-panel" data-holder-panel hidden aria-label="Token holders">
      <div class="robinhood-holder-history" data-holder-history><p>Loading holder history…</p></div>
      <div class="robinhood-holder-page" data-holder-page><p>Loading holders…</p></div>
    </section>
  </div>`;
}

function historyHtml(history: RobinhoodHolderHistory) {
  if (!history.baseline || history.points.length === 0) {
    return '<header><div><small>30 DAY HISTORY</small><strong>No daily history yet</strong></div></header>';
  }
  const all = [history.baseline.holderCount, ...history.points.map((point) => point.holderCount)];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const spread = Math.max(max - min, 1);
  const width = Math.max(560, history.points.length * 34);
  const y = (value: number) => 118 - ((value - min) / spread) * 86;
  let previous = history.baseline.holderCount;
  const sticks = history.points.map((point, index) => {
    const x = 26 + index * ((width - 52) / Math.max(history.points.length - 1, 1));
    const tone = point.delta24h == null ? 'missing' : point.delta24h > 0 ? 'up' : point.delta24h < 0 ? 'down' : 'flat';
    const pct = point.delta24hPct == null ? '' : ` (${point.delta24hPct > 0 ? '+' : ''}${point.delta24hPct.toFixed(2)}%)`;
    const title = `${point.date} · Total ${count(point.holderCount)} · ${signed(point.delta24h)}${pct}`;
    const line = point.comparison === 'complete'
      ? `<line x1="${x}" y1="${y(previous)}" x2="${x}" y2="${y(point.holderCount)}"></line>`
      : `<circle cx="${x}" cy="${y(point.holderCount)}" r="3"></circle>`;
    previous = point.holderCount;
    return `<g class="holder-stick is-${tone}"><title>${escapeHtml(title)}</title>${line}</g>`;
  }).join('');
  const latest = history.points.at(-1)!;
  return `<header><div><small>30 DAY HISTORY</small><strong>${count(latest.holderCount)} holders</strong></div>
      <span class="is-${latest.delta24h == null ? 'missing' : latest.delta24h >= 0 ? 'up' : 'down'}">${signed(latest.delta24h)} / 24h</span></header>
    <div class="robinhood-holder-stick-chart" role="img" aria-label="Daily total holder changes">
      <svg viewBox="0 0 ${width} 140" width="${width}" height="140">${sticks}</svg>
    </div>`;
}

function holderPageHtml(page: RobinhoodHoldersPage, pageNumber: number, hasPrevious: boolean) {
  const observed = new Date(page.observedAt).toLocaleString();
  const rows = page.holders.map((holder) => `<tr>
    <td>${holder.rank}</td>
    <td><a href="https://robinhoodchain.blockscout.com/address/${escapeHtml(holder.address)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(holder.address)}">${escapeHtml(holder.label || shortAddress(holder.address))}</a></td>
    <td>${escapeHtml(holder.addressType)}${holder.isVerifiedContract ? ' · verified' : ''}</td>
    <td title="Raw on-chain balance">${escapeHtml(rawBalance(holder.balanceRaw))}</td>
  </tr>`).join('');
  return `<header><div><small>TOP HOLDERS</small><strong>${count(page.summary.holderCount)} total</strong></div>
      <span class="holder-freshness is-${page.summary.freshness}">${escapeHtml(page.summary.freshness)} · ${escapeHtml(observed)}</span></header>
    <div class="robinhood-holder-table-wrap"><table><thead><tr><th>#</th><th>Holder</th><th>Type</th><th>Raw balance</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No holders returned.</td></tr>'}</tbody></table></div>
    <footer><button type="button" data-holder-page-action="previous" ${hasPrevious ? '' : 'disabled'}>Previous</button>
      <span>Page ${pageNumber}</span><button type="button" data-holder-page-action="next" ${page.hasMore ? '' : 'disabled'}>Next</button></footer>`;
}

function errorHtml(kind: 'history' | 'page') {
  return `<div class="robinhood-holder-error">Failed to load ${kind === 'history' ? 'holder history' : 'holders'}.
    <button type="button" data-holder-retry="${kind}">Retry</button></div>`;
}

export function destroyRobinhoodExpandedHolders() {
  activeCleanup?.();
  activeCleanup = null;
}

export function mountRobinhoodExpandedHolders(section: ParentNode, options: MountOptions) {
  destroyRobinhoodExpandedHolders();
  const root = section.querySelector<HTMLElement>('[data-robinhood-holder-views]');
  if (!root) return;
  const chartView = root.querySelector<HTMLElement>('[data-holder-chart-view]')!;
  const panel = root.querySelector<HTMLElement>('[data-holder-panel]')!;
  const history = root.querySelector<HTMLElement>('[data-holder-history]')!;
  const pageContainer = root.querySelector<HTMLElement>('[data-holder-page]')!;
  let disposed = false;
  let loaded = false;
  let requestId = 0;
  let currentPage: RobinhoodHoldersPage | null = null;
  const cursors: Array<string | null> = [null];

  const loadHistory = async () => {
    try {
      const result = await fetchRobinhoodHolderHistory(options.token, options.authToken);
      if (!disposed) history.innerHTML = historyHtml(result);
    } catch { if (!disposed) history.innerHTML = errorHtml('history'); }
  };
  const loadPage = async () => {
    const id = ++requestId;
    pageContainer.innerHTML = '<p>Loading holders…</p>';
    try {
      const result = await fetchRobinhoodHoldersPage(options.token, cursors.at(-1), options.authToken);
      if (disposed || id !== requestId) return;
      currentPage = result;
      root.querySelector<HTMLElement>('[data-holder-tab-count]')!.textContent = count(result.summary.holderCount);
      pageContainer.innerHTML = holderPageHtml(result, cursors.length, cursors.length > 1);
    } catch { if (!disposed && id === requestId) pageContainer.innerHTML = errorHtml('page'); }
  };
  const show = (tab: 'chart' | 'holders') => {
    const holders = tab === 'holders';
    chartView.hidden = holders;
    panel.hidden = !holders;
    root.closest('.legacy-auth-panel-expanded-sparkline')?.classList.toggle('is-holder-view', holders);
    root.querySelectorAll<HTMLButtonElement>('[data-holder-tab]').forEach((button) => {
      const active = button.dataset.holderTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (holders) {
      options.onShowHolders();
      if (!loaded) { loaded = true; void loadHistory(); void loadPage(); }
    } else {
      options.onShowChart();
    }
  };
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const tab = target?.closest<HTMLButtonElement>('[data-holder-tab]')?.dataset.holderTab;
    if (tab === 'chart' || tab === 'holders') return show(tab);
    const retry = target?.closest<HTMLButtonElement>('[data-holder-retry]')?.dataset.holderRetry;
    if (retry === 'history') return void loadHistory();
    if (retry === 'page') return void loadPage();
    const action = target?.closest<HTMLButtonElement>('[data-holder-page-action]')?.dataset.holderPageAction;
    if (action === 'next' && currentPage?.nextCursor) cursors.push(currentPage.nextCursor);
    else if (action === 'previous' && cursors.length > 1) cursors.pop();
    else return;
    void loadPage();
  };
  root.addEventListener('click', onClick);
  activeCleanup = () => { disposed = true; requestId += 1; root.removeEventListener('click', onClick); };
}
