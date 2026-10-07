import type { AppState } from '../../state/app-state';
import { fetchRobinhoodRadarGainers, type GainersCoverage, type RadarGainer } from '../../services/api/robinhood-radar-gainers';
import { createRadarGainersLoader, gainersPercent } from '../../utils/radar-gainers';
import { robinhoodIdentities } from '../../utils/radar-unified';
import { buildTokenExplorerUrl } from '../../utils/token-chain';
import { bindCopyButtons, bindTokenImagePreview, fmtMoney, renderTradeTerminalMenu } from './shared';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';

interface View { section: HTMLElement | null; loader: ReturnType<typeof createRadarGainersLoader> }
const views = new WeakMap<AppState, View>();
const connections = new WeakMap<AppState, boolean>();

export function invalidateRobinhoodRadarGainersSection(state: AppState, payload: unknown) {
  views.get(state)?.loader.invalidate(payload);
}

export function recoverRobinhoodRadarGainersSection(state: AppState) {
  views.get(state)?.loader.recover();
}

export function updateRobinhoodRadarGainersConnection(state: AppState, message: string) {
  if (message !== 'Socket connected.' && !/^Socket (disconnected|error):/.test(message)) return;
  const connected = message === 'Socket connected.';
  connections.set(state, connected);
  views.get(state)?.loader.connection(connected);
}

export function radarGainersExclusions(state: AppState) {
  return robinhoodIdentities([...state.data.dismissedRecentIdentities, ...state.data.dismissedOldWeekIdentities,
    ...state.data.blocklist.filter((item) => item.chain === 'robinhood')
      .map((item) => `robinhood:${item.address}`)]).sort();
}

function inputFor(state: AppState) {
  return { token: state.session.token, dismissedIdentities: radarGainersExclusions(state),
    available: state.data.availableChains.includes('robinhood')
      && state.data.chainReadiness.robinhood?.capabilities.history === true };
}

function money(value: number | null, coverage: GainersCoverage) {
  const available = value != null && Number.isFinite(value) && value >= 0 && coverage !== 'unavailable';
  return `<span class="radar-coverage-${escapeHtml(coverage)}" title="${escapeHtml(coverage)} coverage">${available ? `${coverage === 'partial' ? '~' : ''}${fmtMoney(value)}` : '-'}</span>`;
}

function rowHtml(row: RadarGainer, state: AppState) {
  const address = row.identity.address;
  const symbol = row.symbol || address.slice(0, 6);
  const image = sanitizeOptionalHttpUrl(row.imageUrl);
  const holder = Number.isSafeInteger(row.holderCount) && Number(row.holderCount) >= 0 && row.holderFreshness !== 'unavailable'
    ? `${row.holderFreshness === 'stale' ? '~' : ''}${Number(row.holderCount).toLocaleString('en-US')}` : '-';
  return `<tr data-token-identity="${escapeHtml(row.identity.key)}">
    <td><div class="radar-gainer-token">
      ${image ? `<img class="token-avatar" src="${escapeHtml(image)}" alt="" width="28" height="28" data-token-image-preview="true" data-token-image-preview-src="${escapeHtml(image)}" />` : `<span class="radar-top-avatar">${escapeHtml(symbol.slice(0, 2))}</span>`}
      <div><a class="token-symbol" href="${escapeHtml(buildTokenExplorerUrl('robinhood', address))}" target="_blank" rel="noopener noreferrer" title="Open token in explorer">${escapeHtml(symbol)}</a>
        <small class="radar-gainer-gain" title="First available price at ${escapeHtml(row.priceBasis.observedAt)}">${gainersPercent(row.priceChangePct)} since first price</small>
        <div class="token-actions-inline"><button type="button" class="action-glyph compact-copy-button" data-action="copy-address" data-address="${address}" aria-label="Copy ${escapeHtml(symbol)} contract">⧉</button>
        ${renderTradeTerminalMenu(address, null, null, { chain: 'robinhood', enabledTradeTerminals: state.ui.enabledRobinhoodTradeTerminals })}</div>
      </div></div></td>
    <td>${money(row.volume24hUsd, row.volume24hCoverage)}<small title="Volume change coverage: ${escapeHtml(row.volume24hChangeCoverage)}">${row.volume24hChangeCoverage === 'unavailable' ? '-' : gainersPercent(row.volume24hChangePct)}</small></td>
    <td title="${escapeHtml(row.holderFreshness)} holder snapshot · Observed ${escapeHtml(row.holderObservedAt || '-')} · Checked ${escapeHtml(row.holderCheckedAt || '-')}">${holder}</td>
    <td title="Updated ${escapeHtml(row.liquidityProjectionCommittedAt || '-')}">${money(row.liquidityUsd, row.liquidityCoverage)}</td></tr>`;
}

function draw(state: AppState, view: View) {
  if (!view.section) return;
  const { page, loading, message, connected, stale } = view.loader.state;
  const notice = message ? `<p class="radar-top-message" role="status">${escapeHtml(message)}</p>`
    : loading && !page ? '<p class="radar-top-message" role="status">Loading gainers…</p>' : '';
  const body = page?.items.length ? `<div class="radar-top-scroll"><table><thead><tr><th>Token / gain</th><th>Volume 24H</th><th>Holders</th><th>LP</th></tr></thead>
    <tbody>${page.items.map((row) => rowHtml(row, state)).join('')}</tbody></table></div>`
    : page ? '<p class="radar-top-message" role="status">No verified gainers with known creation in the last 24 hours.</p>' : '';
  view.section.innerHTML = `<div class="legacy-bar-head radar-top-head"><span class="legacy-bar-title">TOP GAINERS</span>
    <button type="button" data-gainers-refresh ${loading || !inputFor(state).available ? 'disabled' : ''}>Refresh</button></div>
    <p class="radar-top-caveat">Age ≤24h · Since first available price; launch coverage may be incomplete.</p>
    <p class="radar-top-message" data-gainers-live role="status">${!connected ? 'Live disconnected · snapshot may be outdated.'
      : loading ? 'Live connected · updating…' : stale ? 'Live connected · snapshot may be outdated.' : 'Live connected · updates on price changes.'}</p>
    ${notice}${body}${page ? `<p class="radar-top-message">${page.items.length} of ${page.total} gainers · ${page.unpricedCount} candidate(s) without comparable prices · Ranking as of ${escapeHtml(page.asOf)}${page.volumeAsOf ? ` · Volume window ends ${escapeHtml(page.volumeAsOf)}` : ''}</p>` : ''}`;
  view.section.querySelector('[data-gainers-refresh]')?.addEventListener('click', () => {
    void view.loader.update(inputFor(state), true);
  });
  bindCopyButtons(view.section);
  bindTokenImagePreview(view.section);
}

export function renderRobinhoodRadarGainersSection(state: AppState) {
  let view = views.get(state);
  if (!view) {
    const created: View = { section: null, loader: createRadarGainersLoader(
      (input, signal) => fetchRobinhoodRadarGainers(input.dismissedIdentities, input.token, signal),
      () => draw(state, created),
      Date.now, { visible: () => created.section?.isConnected === true && document.visibilityState === 'visible' },
    ) };
    created.loader.connection(connections.get(state) === true);
    document.addEventListener('visibilitychange', () => created.loader.resume());
    views.set(state, created); view = created;
  }
  const returning = view.section?.isConnected !== true;
  view.section = document.createElement('section');
  view.section.className = 'legacy-token-bar radar-gainers';
  draw(state, view);
  void view.loader.update(inputFor(state));
  const current = view;
  queueMicrotask(() => current.loader.resume(returning));
  return view.section;
}
