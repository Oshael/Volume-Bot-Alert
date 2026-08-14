import { fetchRobinhoodHoldersPage, type RobinhoodHoldersPage } from '../services/api/robinhood-holders';
import { escapeHtml } from './sections/html-safety';

interface MountOptions {
  token: string;
  authToken?: string | null;
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

function rawBalance(value: string) {
  try { return BigInt(value).toLocaleString('en-US'); } catch { return value; }
}

function shortAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function renderRobinhoodExpandedHolderViews(
  chartHtml: string,
  holderCount: number | null | undefined,
) {
  return `<div class="robinhood-holder-views" data-robinhood-holder-views>
    <div class="robinhood-holder-chart-shell" data-holder-chart-view>${chartHtml}</div>
    <section class="robinhood-holder-panel" data-holder-panel aria-label="Token holders">
      <div class="robinhood-holder-resize-handle" data-holder-resize-handle role="separator" tabindex="0"
        aria-orientation="horizontal" aria-label="Resize holders panel" aria-valuemin="${MIN_HOLDER_PANEL_HEIGHT}" aria-valuemax="720" aria-valuenow="340">
        <span class="robinhood-holder-panel-label">HOLDERS <strong data-holder-count>${count(holderCount ?? null)}</strong></span>
        <span class="robinhood-holder-resize-grip" aria-hidden="true"></span>
      </div>
      <div class="robinhood-holder-panel-body">
        <div class="robinhood-holder-page" data-holder-page><p>Loading holders…</p></div>
      </div>
    </section>
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
  let disposed = false;
  let requestId = 0;
  let currentPage: RobinhoodHoldersPage | null = null;
  const cache = getHolderDataCache(options.token);
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
      root.querySelector<HTMLElement>('[data-holder-count]')!.textContent = count(result.summary.holderCount);
      pageContainer.innerHTML = holderPageHtml(result, cursors.length, cursors.length > 1);
    } catch { if (!disposed && id === requestId) pageContainer.innerHTML = errorHtml(); }
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
    stopDragging();
  };
}
