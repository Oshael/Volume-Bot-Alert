import {
  fetchRobinhoodHoldersPage,
  type RobinhoodHoldersPage,
} from '../services/api/robinhood-holders';
import { subscribeRobinhoodHolderUpdates } from '../services/socket/client';
import { formatUsd } from './robinhood-trades-format';
import { escapeHtml } from './sections/html-safety';

interface MountOptions {
  token: string;
  authToken?: string | null;
  fdv?: number | null;
}

let activeCleanup: (() => void) | null = null;
const MIN_HOLDER_PANEL_HEIGHT = 220;
const MIN_CHART_AREA_HEIGHT = 250;

interface HolderDataCache {
  pages: Map<string, RobinhoodHoldersPage>;
  pageRequests: Map<string, Promise<RobinhoodHoldersPage>>;
  cursorStack: Array<string | null>;
}

const holderDataCacheByToken = new Map<string, HolderDataCache>();

function getHolderDataCache(token: string): HolderDataCache {
  const existing = holderDataCacheByToken.get(token);
  if (existing) return existing;
  const created: HolderDataCache = {
    pages: new Map(),
    pageRequests: new Map(),
    cursorStack: [null],
  };
  holderDataCacheByToken.set(token, created);
  return created;
}

function count(value: number | null) {
  return value == null ? '—' : value.toLocaleString('en-US');
}

function displayedHolderCount(live: number | null, fallback: number | null) {
  return live == null ? fallback : live;
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function renderRobinhoodExpandedHolderViews(
  chartHtml: string,
  _holderCount: number | null | undefined,
) {
  return `<div class="robinhood-holder-views" data-robinhood-holder-views>
    <div class="robinhood-holder-chart-shell" data-holder-chart-view>${chartHtml}</div>
    <section class="robinhood-holder-panel" data-holder-panel aria-label="Token holders">
      <div class="robinhood-holder-resize-handle" data-holder-resize-handle role="separator" tabindex="0"
        aria-orientation="horizontal" aria-label="Resize holders panel" aria-valuemin="${MIN_HOLDER_PANEL_HEIGHT}" aria-valuemax="720" aria-valuenow="340">
        <span class="robinhood-holder-resize-grip" aria-hidden="true"></span>
      </div>
      <div class="robinhood-holder-panel-body">
        <div class="robinhood-holder-page" data-holder-page><p>Loading holders…</p></div>
      </div>
    </section>
  </div>`;
}

function nativeBalanceCell(value?: string | null) {
  if (value == null) {
    return '<td class="rh-col-num rh-pending" title="Native balance is unavailable">—</td>';
  }
  try {
    const wei = BigInt(value);
    const amount = Number(wei) / 1e18;
    const formatted = Number.isFinite(amount)
      ? amount.toLocaleString('en-US', { maximumFractionDigits: amount < 1 ? 6 : 4 })
      : (wei / (10n ** 18n)).toLocaleString('en-US');
    return `<td class="rh-col-num rh-native-balance" title="${escapeHtml(value)} wei">${escapeHtml(formatted)} <span aria-label="ETH">Ξ</span></td>`;
  } catch {
    return '<td class="rh-col-num rh-pending" title="Native balance is invalid">—</td>';
  }
}

function numberValue(value?: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signedUsd(value?: string | null): string {
  const parsed = numberValue(value);
  if (parsed == null) return '—';
  if (parsed === 0) return '$0';
  const formatted = formatUsd(Math.abs(parsed));
  return `${parsed > 0 ? '+' : '-'}${formatted}`;
}

function positionCell(value: string | null | undefined, averageMcap: string | null | undefined,
  transactions: number | null | undefined) {
  if (value == null || transactions == null) {
    return '<td class="rh-col-num rh-pending" title="Financial position is unavailable">—</td>';
  }
  const average = transactions > 0 && averageMcap != null
    ? `@${formatUsd(numberValue(averageMcap)).replace(/^\$/, '')}` : '';
  return `<td class="rh-col-num rh-financial-cell">
      <span>${escapeHtml(formatUsd(numberValue(value)))}</span><small>${escapeHtml(average)}</small>
    </td>`;
}

function supplyPct(balanceRaw: string, totalSupplyRaw: string | null) {
  try {
    const supply = totalSupplyRaw ? BigInt(totalSupplyRaw) : 0n;
    if (supply <= 0n) return '—';
    return formatSupplyPct((Number(BigInt(balanceRaw)) / Number(supply)) * 100);
  } catch { return '—'; }
}

function pnlRemainingCell(value: string | null | undefined, balanceRaw: string,
  totalSupplyRaw: string | null) {
  const parsed = numberValue(value);
  const tone = parsed == null ? 'rh-pending' : parsed > 0 ? 'is-positive' : parsed < 0 ? 'is-negative' : 'is-flat';
  return `<td class="rh-col-num rh-financial-cell rh-pnl ${tone}">
      <span>${escapeHtml(signedUsd(value))}</span><small class="rh-remaining-pct">${escapeHtml(supplyPct(balanceRaw, totalSupplyRaw))}</small>
    </td>`;
}

function formatSupplyPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 0.01) return '<0.01%';
  return `${Number(pct.toFixed(pct >= 1 ? 2 : 3))}%`;
}

function holderGlyph(addressType: string) {
  const lp = addressType === 'pool';
  return `<span class="rh-holder-glyph ${lp ? 'is-lp' : 'is-unknown'}" title="${lp ? 'LP' : 'Unknown'}">${lp ? '≋' : '·'}</span>`;
}

function concentrationPct(page: RobinhoodHoldersPage, limit: number) {
  try {
    const supply = page.summary.totalSupplyRaw ? BigInt(page.summary.totalSupplyRaw) : 0n;
    if (supply <= 0n) return null;
    const held = page.holders.slice(0, limit).reduce((sum, holder) => sum + BigInt(holder.balanceRaw), 0n);
    return Math.min(100, Number((held * 10_000n) / supply) / 100);
  } catch { return null; }
}

function distributionMetric(label: string, value: number | null, tone: string, sub: string) {
  return `<div class="rh-distribution-metric"><div><span>${label}</span><strong>${value == null ? '—' : formatSupplyPct(value)}</strong><small>${sub}</small></div><i><b class="${tone}" style="width:${value == null ? 0 : value}%"></b></i></div>`;
}

function distributionHtml(page: RobinhoodHoldersPage) {
  return `<aside class="rh-holder-distribution"><header>DISTRIBUIÇÃO</header><div class="rh-distribution-body">
    ${distributionMetric('Top 10', concentrationPct(page, 10), 'is-top', '10 wlt')}
    ${distributionMetric('Top 50', concentrationPct(page, 50), 'is-top', `${Math.min(50, page.holders.length)} wlt`)}
    ${distributionMetric('Snipers', null, 'is-sniper', '—')}
    ${distributionMetric('Fresh wallets', null, 'is-fresh', '—')}
    <div class="rh-distribution-flags">${[
      ['DEV HOLD', '—'], ['INSIDERS', '—'], ['LP LOCKED', '—'], ['BUNDLED', '—'],
    ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
  </div></aside>`;
}

function holderToolbarHtml(page: RobinhoodHoldersPage, pageNumber: number, hasPrevious: boolean,
  holderCount: number | null) {
  const observed = new Date(page.observedAt).toLocaleTimeString([], { hour12: false });
  const pages = Math.max(pageNumber, Math.ceil((holderCount || 0) / 50));
  const glyphs = [['◎', 'SNIPER', 'is-sniper'], ['✦', 'FRESH', 'is-fresh'], ['⇄', 'CEX', 'is-cex'], ['≋', 'LP', 'is-lp']];
  return `<header class="rh-holder-toolbar"><strong>TOP HOLDERS</strong><span data-holder-panel-count>${count(holderCount)}</span><i></i>
    <div class="rh-holder-filters"><button class="active">TOP</button>${['INSIDERS', 'SNIPERS', 'FRESH'].map((label) => `<button disabled title="Classification unavailable">${label}</button>`).join('')}</div>
    <div class="rh-holder-legend">${glyphs.map(([glyph, label, tone]) => `<span><b class="${tone}">${glyph}</b>${label}</span>`).join('')}</div>
    <span class="holder-freshness is-${page.summary.freshness}">${escapeHtml(page.summary.freshness)} · ${escapeHtml(observed)}</span>
    <nav><button aria-label="Previous" data-holder-page-action="previous" ${hasPrevious ? '' : 'disabled'}>‹</button><span>${pageNumber}/${Math.max(1, pages)}</span><button aria-label="Next" data-holder-page-action="next" ${page.hasMore ? '' : 'disabled'}>›</button></nav>
  </header>`;
}

function holderPageHtml(
  page: RobinhoodHoldersPage, pageNumber: number, hasPrevious: boolean,
  holderCount: number | null, distributionPage: RobinhoodHoldersPage,
) {
  const rows = page.holders.map((holder) => `<tr>
    <td class="rh-col-rank">${holder.rank}</td>
    <td class="rh-col-holder">
      <a href="https://robinhoodchain.blockscout.com/address/${escapeHtml(holder.address)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(holder.address)}">${escapeHtml(holder.label || shortAddress(holder.address))}</a>
      ${holderGlyph(holder.addressType)}
    </td>
    ${nativeBalanceCell(holder.nativeBalanceRaw)}
    ${positionCell(holder.buyVolumeUsd, holder.avgBuyMcapUsd, holder.buyTxCount)}
    ${positionCell(holder.sellProceedsUsd, holder.avgSellMcapUsd, holder.sellTxCount)}
    ${pnlRemainingCell(holder.unrealizedPnlUsd, holder.balanceRaw, page.summary.totalSupplyRaw)}
  </tr>`).join('');
  return `${holderToolbarHtml(page, pageNumber, hasPrevious, holderCount)}<div class="rh-holder-content">
    <div class="rh-holder-list"><div class="robinhood-holder-table-wrap"><table><thead><tr>
        <th class="rh-col-rank">#</th><th class="rh-col-holder">Holder</th>
        <th class="rh-col-num">BAL</th><th class="rh-col-num">AVG BUY <small>· MC</small></th>
        <th class="rh-col-num">AVG SELL <small>· MC</small></th><th class="rh-col-num">U. PNL <small>· REM</small></th></tr></thead>
      <tbody>${rows || '<tr><td>No holders returned.</td></tr>'}</tbody></table></div></div>
    ${distributionHtml(distributionPage)}</div>`;
}

function errorHtml() {
  return '<div class="robinhood-holder-error">Failed to load holders. <button type="button" data-holder-retry="page">Retry</button></div>';
}

export function destroyRobinhoodExpandedHolders() {
  activeCleanup?.();
  activeCleanup = null;
}

export function mountRobinhoodExpandedHolders(section: ParentNode, options: MountOptions) {
  destroyRobinhoodExpandedHolders();
  const root = section.querySelector<HTMLElement>('[data-robinhood-holder-views]');
  if (!root) return;
  const panel = root.querySelector<HTMLElement>('[data-holder-panel]')!;
  const resizeHandle = root.querySelector<HTMLElement>('[data-holder-resize-handle]')!;
  const pageContainer = root.querySelector<HTMLElement>('[data-holder-page]')!;
  const holderCount = section.querySelector<HTMLElement>('[data-holder-count]');
  let disposed = false;
  let requestId = 0;
  let currentPage: RobinhoodHoldersPage | null = null;
  const cache = getHolderDataCache(options.token);
  let distributionPage = cache.pages.get('first') || null;
  let liveHolderCount: number | null = null;
  const cursors = [...cache.cursorStack];
  let dragStartY = 0;
  let dragStartHeight = 0;
  let dragging = false;

  const setHolderPanelHeight = (requestedHeight: number) => {
    const availableHeight = root.getBoundingClientRect().height;
    const maxHeight = Math.max(
      MIN_HOLDER_PANEL_HEIGHT,
      availableHeight - MIN_CHART_AREA_HEIGHT,
    );
    const height = Math.round(Math.min(Math.max(requestedHeight, MIN_HOLDER_PANEL_HEIGHT), maxHeight));
    root.style.setProperty('--holders-height', `${height}px`);
    resizeHandle.setAttribute('aria-valuemax', String(Math.round(maxHeight)));
    resizeHandle.setAttribute('aria-valuenow', String(height));
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    root.removeAttribute('data-holder-resizing');
  };

  const onPointerDown = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.button !== 0) return;
    dragging = true;
    dragStartY = pointerEvent.clientY;
    dragStartHeight = panel.getBoundingClientRect().height;
    resizeHandle.setPointerCapture?.(pointerEvent.pointerId);
    root.setAttribute('data-holder-resizing', 'true');
    pointerEvent.preventDefault();
  };
  const onPointerMove = (event: Event) => {
    if (!dragging) return;
    const pointerEvent = event as PointerEvent;
    setHolderPanelHeight(dragStartHeight - (pointerEvent.clientY - dragStartY));
  };
  const onPointerUp = () => stopDragging();
  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const currentHeight = panel.getBoundingClientRect().height;
    if (keyEvent.key === 'ArrowUp') {
      setHolderPanelHeight(currentHeight + 32);
      keyEvent.preventDefault();
    } else if (keyEvent.key === 'ArrowDown') {
      setHolderPanelHeight(currentHeight - 32);
      keyEvent.preventDefault();
    } else if (keyEvent.key === 'Home') {
      setHolderPanelHeight(Number(resizeHandle.getAttribute('aria-valuemax')) || currentHeight);
      keyEvent.preventDefault();
    } else if (keyEvent.key === 'End') {
      setHolderPanelHeight(MIN_HOLDER_PANEL_HEIGHT);
      keyEvent.preventDefault();
    }
  };

  const loadPage = async () => {
    const id = ++requestId;
    const cursor = cursors.at(-1) || null;
    pageContainer.innerHTML = '<p>Loading holders…</p>';
    try {
      let pageRequest = cache.pageRequests.get(cursor || 'first');
      if (!pageRequest && !cache.pages.has(cursor || 'first')) {
        pageRequest = fetchRobinhoodHoldersPage(options.token, cursor, options.authToken)
          .then((result) => {
            cache.pages.set(cursor || 'first', result);
            return result;
          })
          .finally(() => { cache.pageRequests.delete(cursor || 'first'); });
        cache.pageRequests.set(cursor || 'first', pageRequest);
      }
      const result = cache.pages.get(cursor || 'first') || await pageRequest!;
      if (disposed || id !== requestId) return;
      currentPage = result;
      distributionPage = cache.pages.get('first') || result;
      if (liveHolderCount == null) {
        if (holderCount) holderCount.textContent = count(result.summary.holderCount);
      }
      pageContainer.innerHTML = holderPageHtml(
        result, cursors.length, cursors.length > 1,
        displayedHolderCount(liveHolderCount, result.summary.holderCount), distributionPage,
      );
    } catch { if (!disposed && id === requestId) pageContainer.innerHTML = errorHtml(); }
  };
  const applyLiveCount = (event: { holderCount: number }) => {
    liveHolderCount = event.holderCount;
    if (holderCount) holderCount.textContent = count(event.holderCount);
    const panelCount = panel.querySelector<HTMLElement>('[data-holder-panel-count]');
    if (panelCount) panelCount.textContent = count(event.holderCount);
  };
  const recoverPage = () => {
    if (disposed) return;
    liveHolderCount = null;
    cache.pages.delete(cursors.at(-1) || 'first');
    void loadPage();
  };
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const retry = target?.closest<HTMLButtonElement>('[data-holder-retry]')?.dataset.holderRetry;
    if (retry === 'page') return void loadPage();
    const action = target?.closest<HTMLButtonElement>('[data-holder-page-action]')?.dataset.holderPageAction;
    if (action === 'next' && currentPage?.nextCursor) cursors.push(currentPage.nextCursor);
    else if (action === 'previous' && cursors.length > 1) cursors.pop();
    else return;
    cache.cursorStack = [...cursors];
    void loadPage();
  };
  const onResize = () => {
    const configuredHeight = Number.parseFloat(root.style.getPropertyValue('--holders-height'));
    if (Number.isFinite(configuredHeight)) setHolderPanelHeight(configuredHeight);
  };
  root.addEventListener('click', onClick);
  resizeHandle.addEventListener('pointerdown', onPointerDown);
  resizeHandle.addEventListener('pointermove', onPointerMove);
  resizeHandle.addEventListener('pointerup', onPointerUp);
  resizeHandle.addEventListener('pointercancel', onPointerUp);
  resizeHandle.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  const unsubscribeHolderUpdates = subscribeRobinhoodHolderUpdates(options.token, {
    onCount: applyLiveCount,
    onInvalidate: recoverPage,
    onRecover: recoverPage,
  });
  void loadPage();
  activeCleanup = () => {
    disposed = true;
    requestId += 1;
    root.removeEventListener('click', onClick);
    resizeHandle.removeEventListener('pointerdown', onPointerDown);
    resizeHandle.removeEventListener('pointermove', onPointerMove);
    resizeHandle.removeEventListener('pointerup', onPointerUp);
    resizeHandle.removeEventListener('pointercancel', onPointerUp);
    resizeHandle.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    unsubscribeHolderUpdates?.();
    stopDragging();
  };
}
