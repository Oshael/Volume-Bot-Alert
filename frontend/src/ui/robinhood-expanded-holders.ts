import {
  fetchRobinhoodHoldersPage,
  type RobinhoodHolder,
  type RobinhoodHolderDistributionMetric,
  type RobinhoodHolderFilter,
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
  cursorStacks: Map<RobinhoodHolderFilter, Array<string | null>>;
}

const holderDataCacheByToken = new Map<string, HolderDataCache>();

function getHolderDataCache(token: string): HolderDataCache {
  const existing = holderDataCacheByToken.get(token);
  if (existing) return existing;
  const created: HolderDataCache = {
    pages: new Map(),
    pageRequests: new Map(),
    cursorStacks: new Map([['top', [null]]]),
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

function pageCacheKey(filter: RobinhoodHolderFilter, cursor: string | null) {
  return `${filter}:${cursor || 'first'}`;
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

function holderGlyph(holder: RobinhoodHolder) {
  const fallbackTag = holder.addressType === 'pool' ? 'lp' : 'unknown';
  const tag = holder.primaryTag === 'unknown' ? fallbackTag : holder.primaryTag;
  const glyphs = {
    sniper: ['◎', 'SNIPER', 'is-sniper'], fresh: ['✦', 'FRESH', 'is-fresh'],
    bundled: ['◈', 'BUNDLED', 'is-bundled'],
    cex: ['⇄', 'CEX', 'is-cex'], lp: ['≋', 'LP', 'is-lp'],
    unknown: ['·', 'Unknown', 'is-unknown'],
  } as const;
  const [glyph, label, tone] = glyphs[tag === 'insider' ? 'unknown' : tag];
  const reasons = holder.classifications
    .filter(({ tag: classificationTag }) => classificationTag === tag)
    .map(({ reasonCode }) => reasonCode)
    .join(', ');
  const title = reasons ? `${label} · ${reasons}` : label;
  return `<span class="rh-holder-glyph ${tone}" title="${escapeHtml(title)}">${glyph}</span>`;
}

function distributionMetric(label: string, value: number | null, tone: string, sub: string) {
  return `<div class="rh-distribution-metric"><div><span>${label}</span><strong>${value == null ? '—' : formatSupplyPct(value)}</strong><small>${sub}</small></div><i><b class="${tone}" style="width:${value == null ? 0 : value}%"></b></i></div>`;
}

function materializedPct(metric?: RobinhoodHolderDistributionMetric) {
  if (!metric?.value || !['ready', 'stale'].includes(metric.status)) return null;
  try {
    const numerator = BigInt(metric.value.numeratorRaw);
    const denominator = BigInt(metric.value.denominatorRaw);
    if (denominator <= 0n) return null;
    return Math.min(100, Number((numerator * 10_000n) / denominator) / 100);
  } catch { return null; }
}

function metricSub(metric?: RobinhoodHolderDistributionMetric) {
  if (!metric || metric.status === 'unavailable') return '—';
  if (metric.metric === 'bundled' && metric.groupCount) return `${metric.groupCount} grp`;
  return metric.walletCount == null ? '—' : `${metric.walletCount} wlt`;
}

function flagValue(metric?: RobinhoodHolderDistributionMetric) {
  const pct = materializedPct(metric);
  if (pct != null) return formatSupplyPct(pct);
  if (metric?.metric === 'bundled' && metric.walletCount != null) return `${metric.walletCount} wlt`;
  return '—';
}

function distributionHtml(page: RobinhoodHoldersPage) {
  const metrics = new Map(page.distribution.map((metric) => [metric.metric, metric]));
  const top10 = metrics.get('top10');
  const top50 = metrics.get('top50');
  return `<aside class="rh-holder-distribution"><header>DISTRIBUIÇÃO</header><div class="rh-distribution-body">
    ${distributionMetric('Top 10', materializedPct(top10), 'is-top', metricSub(top10))}
    ${distributionMetric('Top 50', materializedPct(top50), 'is-top', metricSub(top50))}
    ${distributionMetric('Snipers', materializedPct(metrics.get('snipers')), 'is-sniper', metricSub(metrics.get('snipers')))}
    ${distributionMetric('Fresh wallets', materializedPct(metrics.get('fresh_wallets')), 'is-fresh', metricSub(metrics.get('fresh_wallets')))}
    <div class="rh-distribution-flags">${[
      ['DEV HOLD', metrics.get('dev_hold')], ['INSIDERS', metrics.get('insiders')],
      ['LP LOCKED', metrics.get('lp_locked')], ['BUNDLED', metrics.get('bundled')],
    ].map(([label, metric]) => `<div><span>${label}</span><strong>${flagValue(metric as RobinhoodHolderDistributionMetric | undefined)}</strong></div>`).join('')}</div>
  </div></aside>`;
}

function holderToolbarHtml(page: RobinhoodHoldersPage, pageNumber: number, hasPrevious: boolean,
  holderCount: number | null, activeFilter: RobinhoodHolderFilter) {
  const observed = new Date(page.observedAt).toLocaleTimeString([], { hour12: false });
  const pages = Math.max(pageNumber, Math.ceil((holderCount || 0) / 50));
  const glyphs = [['◎', 'SNIPER', 'is-sniper'], ['◈', 'BUNDLED', 'is-bundled'],
    ['✦', 'FRESH', 'is-fresh'], ['⇄', 'CEX', 'is-cex'], ['≋', 'LP', 'is-lp']];
  return `<header class="rh-holder-toolbar"><strong>TOP HOLDERS</strong><span data-holder-panel-count>${count(holderCount)}</span><i></i>
    <div class="rh-holder-filters">
      <button data-holder-filter="top" class="${activeFilter === 'top' ? 'active' : ''}">TOP</button>
      <button data-holder-filter="snipers" class="${activeFilter === 'snipers' ? 'active' : ''}">SNIPERS</button>
      <button data-holder-filter="bundled" class="${activeFilter === 'bundled' ? 'active' : ''}">BUNDLED</button>
      ${['INSIDERS', 'FRESH'].map((label) => `<button disabled title="Classification unavailable">${label}</button>`).join('')}
    </div>
    <div class="rh-holder-legend">${glyphs.map(([glyph, label, tone]) => `<span><b class="${tone}">${glyph}</b>${label}</span>`).join('')}</div>
    <span class="holder-freshness is-${page.summary.freshness}">${escapeHtml(page.summary.freshness)} · ${escapeHtml(observed)}</span>
    <nav><button aria-label="Previous" data-holder-page-action="previous" ${hasPrevious ? '' : 'disabled'}>‹</button><span>${pageNumber}/${Math.max(1, pages)}</span><button aria-label="Next" data-holder-page-action="next" ${page.hasMore ? '' : 'disabled'}>›</button></nav>
  </header>`;
}

function holderPageHtml(
  page: RobinhoodHoldersPage, pageNumber: number, hasPrevious: boolean,
  holderCount: number | null, distributionPage: RobinhoodHoldersPage,
  activeFilter: RobinhoodHolderFilter,
) {
  const rows = page.holders.map((holder) => `<tr>
    <td class="rh-col-rank">${holder.rank}</td>
    <td class="rh-col-holder">
      <a href="https://robinhoodchain.blockscout.com/address/${escapeHtml(holder.address)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(holder.address)}">${escapeHtml(holder.label || shortAddress(holder.address))}</a>
      ${holderGlyph(holder)}
    </td>
    ${nativeBalanceCell(holder.nativeBalanceRaw)}
    ${positionCell(holder.buyVolumeUsd, holder.avgBuyMcapUsd, holder.buyTxCount)}
    ${positionCell(holder.sellProceedsUsd, holder.avgSellMcapUsd, holder.sellTxCount)}
    ${pnlRemainingCell(holder.unrealizedPnlUsd, holder.balanceRaw, page.summary.totalSupplyRaw)}
  </tr>`).join('');
  return `${holderToolbarHtml(page, pageNumber, hasPrevious, holderCount, activeFilter)}<div class="rh-holder-content">
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
  let activeFilter: RobinhoodHolderFilter = 'top';
  let distributionPage = cache.pages.get(pageCacheKey('top', null)) || null;
  let liveHolderCount: number | null = null;
  let cursors = [...(cache.cursorStacks.get(activeFilter) || [null])];
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
    const cacheKey = pageCacheKey(activeFilter, cursor);
    pageContainer.innerHTML = '<p>Loading holders…</p>';
    try {
      let pageRequest = cache.pageRequests.get(cacheKey);
      if (!pageRequest && !cache.pages.has(cacheKey)) {
        pageRequest = fetchRobinhoodHoldersPage(
          options.token, cursor, options.authToken, activeFilter,
        )
          .then((result) => {
            cache.pages.set(cacheKey, result);
            return result;
          })
          .finally(() => { cache.pageRequests.delete(cacheKey); });
        cache.pageRequests.set(cacheKey, pageRequest);
      }
      const result = cache.pages.get(cacheKey) || await pageRequest!;
      if (disposed || id !== requestId) return;
      currentPage = result;
      distributionPage = cache.pages.get(pageCacheKey('top', null)) || result;
      if (activeFilter === 'top' && liveHolderCount == null) {
        if (holderCount) holderCount.textContent = count(result.summary.holderCount);
      }
      const panelHolderCount = activeFilter === 'top'
        ? displayedHolderCount(liveHolderCount, result.summary.holderCount)
        : result.summary.holderCount;
      pageContainer.innerHTML = holderPageHtml(
        result, cursors.length, cursors.length > 1,
        panelHolderCount, distributionPage, activeFilter,
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
    cache.pages.delete(pageCacheKey(activeFilter, cursors.at(-1) || null));
    void loadPage();
  };
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const retry = target?.closest<HTMLButtonElement>('[data-holder-retry]')?.dataset.holderRetry;
    if (retry === 'page') return void loadPage();
    const requestedFilter = target?.closest<HTMLButtonElement>('[data-holder-filter]')
      ?.dataset.holderFilter as RobinhoodHolderFilter | undefined;
    if (requestedFilter && requestedFilter !== activeFilter) {
      activeFilter = requestedFilter;
      cursors = [...(cache.cursorStacks.get(activeFilter) || [null])];
      currentPage = null;
      void loadPage();
      return;
    }
    const action = target?.closest<HTMLButtonElement>('[data-holder-page-action]')?.dataset.holderPageAction;
    if (action === 'next' && currentPage?.nextCursor) cursors.push(currentPage.nextCursor);
    else if (action === 'previous' && cursors.length > 1) cursors.pop();
    else return;
    cache.cursorStacks.set(activeFilter, [...cursors]);
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
