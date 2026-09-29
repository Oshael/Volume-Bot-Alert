import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { ApiResponseError } from '../../services/api/base';
import {
  fetchRobinhoodTopWallets,
  type TopWalletPage,
  type TopWalletRow,
  type TopWalletWindow,
} from '../../services/api/robinhood-top-wallets';
import { formatRankingGain, rankingIsPartial } from '../../utils/robinhood-top-wallets';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';

const WINDOWS: TopWalletWindow[] = ['24h', '7d', '30d', 'ALL'];
const ADDRESS = /^0x[0-9a-f]{40}$/i;

interface RankingView {
  window: TopWalletWindow;
  pageIndex: number;
  cursors: Array<string | null>;
  asOf: string | null;
  page: TopWalletPage | null;
  loading: boolean;
  error: string | null;
  token: string | null;
  revision: number;
  section: HTMLElement | null;
}

const views = new WeakMap<AppState, RankingView>();

function viewFor(state: AppState): RankingView {
  let view = views.get(state);
  if (!view) {
    view = { window: '24h', pageIndex: 0, cursors: [null], asOf: null, page: null,
      loading: false, error: null, token: state.session.token, revision: 0,
      section: null };
    views.set(state, view);
  }
  if (view.token !== state.session.token) {
    view.token = state.session.token;
    view.pageIndex = 0;
    view.cursors = [null];
    view.asOf = null;
    view.page = null;
    view.error = null;
    view.loading = false;
    view.revision += 1;
  }
  if (!available(state) && (view.page || view.loading)) reset(view);
  return view;
}

function available(state: AppState) {
  return state.data.availableChains.includes('robinhood')
    && state.data.chainReadiness.robinhood?.capabilities.history === true;
}

function walletRow(row: TopWalletRow) {
  if (!ADDRESS.test(row.walletAddress) || row.chainKey !== 'robinhood') return '';
  const address = row.walletAddress.toLowerCase();
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const profile = row.profile;
  const name = profile?.displayName || profile?.username || short;
  const platform = profile?.platform || 'Wallet';
  const avatarUrl = sanitizeOptionalHttpUrl(profile?.profilePictureUrl);
  const avatar = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
  const path = `/radar/wallet/robinhood/${address}`;
  return `<tr>
    <td class="radar-top-rank">${escapeHtml(row.rank)}</td>
    <td><span class="radar-top-wallet">
      <span class="radar-top-avatar">${avatar}</span>
      <span class="radar-top-wallet-label">
        <a href="${path}" data-top-wallet-link>${escapeHtml(name)}</a>
        <small title="${address}">${escapeHtml(short)} · ${escapeHtml(platform)}</small>
      </span>
      <button type="button" data-top-wallet-copy="${address}" aria-label="Copy ${address}" title="Copy address">⧉</button>
      <a class="radar-top-explorer" href="https://robinhoodchain.blockscout.com/address/${address}" target="_blank" rel="noopener noreferrer" aria-label="Open ${address} in explorer" title="Explorer">↗</a>
    </span></td>
    <td class="radar-top-gain ${Number(row.gainUsd) < 0 ? 'is-negative' : ''}">${escapeHtml(formatRankingGain(row.gainUsd))}</td>
  </tr>`;
}

function rankingBody(state: AppState, view: RankingView) {
  const page = view.page;
  const partial = page && rankingIsPartial(page);
  if (!available(state)) return '<p class="radar-top-message" role="status">Robinhood wallet ranking is unavailable.</p>';
  if (view.loading) return '<p class="radar-top-message" role="status">Loading wallet ranking…</p>';
  if (view.error) return `<p class="radar-top-message" role="alert">${escapeHtml(view.error)}</p>`;
  if (!page?.items.length) return '<p class="radar-top-message" role="status">No verified wallets for this period.</p>';
  return `<div class="radar-top-scroll"><table>
    <thead><tr><th scope="col">#</th><th scope="col">Wallet</th><th scope="col">${partial ? 'Verified gain' : 'UPNL'} (USD)</th></tr></thead>
    <tbody>${page.items.map(walletRow).join('')}</tbody>
  </table></div>`;
}

function rankingMeta(view: RankingView) {
  const page = view.page;
  if (!page) return '';
  const partial = rankingIsPartial(page);
  const asOf = page && Number.isFinite(Date.parse(page.asOf))
    ? new Date(page.asOf).toLocaleString() : null;
  return `<div class="radar-top-meta">
    <span class="radar-top-coverage ${partial ? 'is-partial' : ''}">${partial ? 'Partial ranking' : 'Verified ranking'}</span>
    ${asOf ? `<span>As of ${escapeHtml(asOf)}</span>` : ''}
    ${page.rankingListTruncated === true ? '<span>Top 100 limit</span>' : ''}
    ${page.profileStatus === 'unavailable' ? '<span>Profiles unavailable</span>' : ''}
  </div>
  ${partial ? `<p class="radar-top-caveat" role="status">Coverage is incomplete. Listed gains cover only verified positions; wallets and their order may be missing or change.${page.excludedWalletCount > 0 ? ` ${escapeHtml(page.excludedWalletCount)} wallet(s) excluded.` : ''}</p>` : ''}`;
}

function rankingPages(view: RankingView) {
  const page = view.page;
  if (!page || view.loading || view.error || (view.pageIndex === 0 && !page.hasMore)) return '';
  return `<div class="radar-top-pages">
    <button type="button" data-top-prev ${view.pageIndex === 0 ? 'disabled' : ''}>Previous</button>
    <span>Page ${view.pageIndex + 1}</span>
    <button type="button" data-top-next ${!page.hasMore || !page.nextCursor ? 'disabled' : ''}>Next</button>
  </div>`;
}

function draw(state: AppState, view: RankingView) {
  const section = view.section;
  if (!section) return;
  section.innerHTML = `
    <div class="legacy-bar-head radar-top-head">
      <span class="legacy-bar-title">TOP WALLETS</span>
      <div class="radar-top-controls" role="group" aria-label="Ranking period">
        ${WINDOWS.map((window) => `<button type="button" data-top-window="${window}" aria-pressed="${view.window === window}">${window}</button>`).join('')}
      </div>
      <button type="button" data-top-refresh ${view.loading || !available(state) ? 'disabled' : ''}>Refresh</button>
    </div>
    ${rankingMeta(view)}
    ${rankingBody(state, view)}
    ${rankingPages(view)}`;
}

function reset(view: RankingView) {
  view.pageIndex = 0;
  view.cursors = [null];
  view.asOf = null;
  view.page = null;
  view.error = null;
  view.revision += 1;
  view.loading = false;
}

async function load(state: AppState, view: RankingView) {
  if (!available(state) || view.loading) return;
  const revision = ++view.revision;
  view.loading = true;
  view.error = null;
  view.page = null;
  draw(state, view);
  try {
    const page = await fetchRobinhoodTopWallets({
      window: view.window,
      asOf: view.asOf,
      cursor: view.cursors[view.pageIndex],
    }, view.token);
    if (revision !== view.revision) return;
    // Keep the first page's snapshot fixed while traversing its cursor.
    if (view.pageIndex === 0) view.asOf = page.asOf;
    view.page = page;
  } catch (failure) {
    if (revision !== view.revision) return;
    if (failure instanceof ApiResponseError && failure.status === 409) {
      reset(view);
      view.error = 'Ranking changed while paging. Refresh to start again.';
    } else {
      view.error = failure instanceof ApiResponseError && failure.status === 503
        ? 'Wallet ranking is not ready yet.'
        : 'Could not load wallet ranking. Please refresh.';
    }
  } finally {
    if (revision === view.revision || !view.loading) {
      view.loading = false;
      draw(state, view);
    }
  }
}

function handleRankingClick(event: MouseEvent, state: AppState, view: RankingView, controller: AppController) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const windowButton = target.closest<HTMLButtonElement>('[data-top-window]');
  if (windowButton) {
    const next = windowButton.dataset.topWindow as TopWalletWindow;
    if (WINDOWS.includes(next) && next !== view.window) {
      view.window = next;
      reset(view);
      void load(state, view);
    }
    return;
  }
  if (target.closest('[data-top-refresh]')) {
    reset(view);
    void load(state, view);
    return;
  }
  if (target.closest('[data-top-next]') && view.page?.nextCursor) {
    view.pageIndex += 1;
    view.cursors[view.pageIndex] = view.page.nextCursor;
    void load(state, view);
    return;
  }
  if (target.closest('[data-top-prev]') && view.pageIndex > 0) {
    view.pageIndex -= 1;
    void load(state, view);
    return;
  }
  const copy = target.closest<HTMLButtonElement>('[data-top-wallet-copy]');
  if (copy?.dataset.topWalletCopy) {
    void navigator.clipboard.writeText(copy.dataset.topWalletCopy);
    return;
  }
  const link = target.closest<HTMLAnchorElement>('[data-top-wallet-link]');
  if (link && isPlainClick(event)) {
    event.preventDefault();
    window.history.pushState({}, document.title, link.pathname);
    controller.syncWorkspaceFromLocation();
  }
}

function isPlainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey
    && !event.shiftKey && !event.altKey;
}

export function renderRobinhoodTopWalletsSection(state: AppState, controller: AppController) {
  const view = viewFor(state);
  const section = document.createElement('section');
  section.className = 'legacy-token-bar radar-top-wallets';
  view.section = section;
  section.addEventListener('click', (event) => handleRankingClick(event, state, view, controller));
  draw(state, view);
  if (!view.page && !view.loading && !view.error) void load(state, view);
  return section;
}
