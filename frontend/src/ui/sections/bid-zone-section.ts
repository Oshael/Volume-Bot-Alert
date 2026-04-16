import type { AppController } from '../../state/app-controller';
import { getTrackedToken, type AppState, type BidZoneTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtMoney } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

export function renderBidZoneSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const isCollapsed = state.ui.collapsed.bidZone;
  const lastUpdated = formatAbsoluteTimestamp(state.runtime.bidZoneUpdatedAt);
  const refreshCooldownLabel = state.runtime.bidZoneRefreshCooldownLabel;
  const refreshDisabled = state.runtime.bidZoneRefreshInFlight || refreshCooldownLabel !== 'ready';
  const refreshLabel = state.runtime.bidZoneRefreshInFlight
    ? 'REFRESHING...'
    : refreshCooldownLabel === 'ready'
      ? 'REFRESH'
      : `WAIT ${refreshCooldownLabel.toUpperCase()}`;
  section.className = `panel legacy-panel lateralized-panel bid-zone-panel${isCollapsed ? ' panel-collapsed' : ''}`;
  const freshness = state.runtime.bidZoneFreshnessLabel !== '-'
    ? `SCAN ${state.runtime.bidZoneFreshnessLabel}`
    : 'SCAN pending';

  section.innerHTML = `
    <div class="panel-header">
      <span>⌖ BID ZONE COINS</span>
      <div class="lateralized-header-meta">
        <span class="lateralized-freshness">${freshness}</span>
        <span class="bid-zone-last-updated">LAST ${lastUpdated}</span>
        <button type="button" class="compact-refresh-button" data-action="refresh-bid-zone" ${refreshDisabled ? 'disabled' : ''}>${refreshLabel}</button>
        <span class="count">${state.data.bidZoneTokens.length}</span>
        <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="bidZone" aria-label="${isCollapsed ? 'Expand bid-zone panel' : 'Collapse bid-zone panel'}"><span class="compact-icon-glyph">${isCollapsed ? '+' : '−'}</span></button>
      </div>
    </div>
    ${isCollapsed ? '' : '<div class="lateralized-list bid-zone-list"></div>'}
  `;

  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('bidZone');
  });
  section.querySelector<HTMLButtonElement>('[data-action="refresh-bid-zone"]')?.addEventListener('click', () => {
    void controller.refreshBidZoneSnapshot();
  });

  if (isCollapsed) {
    return section;
  }

  const list = section.querySelector<HTMLElement>('.bid-zone-list');
  if (list) {
    if (state.data.bidZoneTokens.length > 0) {
      state.data.bidZoneTokens.forEach((item, index) => {
        list.append(buildBidZoneRow(state, item, index, state.ui.busy, state.data.starredTokens.includes(item.address), state.session.role === 'admin'));
      });
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const emptyText = document.createElement('div');
      emptyText.className = 'empty-text';
      emptyText.textContent = 'No bid-zone coins available yet.';
      emptyState.append(emptyText);
      list.append(emptyState);
    }
  }

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function buildBidZoneRow(
  state: AppState,
  item: BidZoneTokenEntry,
  index: number,
  busy: boolean,
  isStarred: boolean,
  isAdmin: boolean,
) {
  const view = buildBidZoneRowView(state, item);

  const article = document.createElement('article');
  article.className = `token-row lateralized-token-row bid-zone-token-row${isStarred ? ' token-starred' : ''}`;
  article.dataset.hoverKey = `bid-zone:${item.address}`;

  const rank = document.createElement('div');
  rank.className = 'lateralized-rank';
  rank.textContent = `#${index + 1}`;

  article.append(rank, buildAvatar(view.symbol, view.imageUrl));

  const main = document.createElement('div');
  main.className = 'lateralized-row-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'lateralized-title-line';

  const tokenName = document.createElement('span');
  tokenName.className = 'token-name';
  tokenName.textContent = view.symbol;

  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = view.subtitle;

  titleLine.append(
    tokenName,
    tokenAddr,
    buildInlineLink('/ DEX', view.pairUrl),
    buildInlineLink('X', view.xSearchUrl),
  );

  const actions = buildBidZoneActions(state, item, view, isStarred, busy, isAdmin);

  const metaLine = document.createElement('div');
  metaLine.className = 'lateralized-meta-line';
  metaLine.append(
    buildMetaMetric('MCAP', fmtMoney(view.mcap)),
    buildMetaMetric('AGE', view.age),
    buildMetaMetric('VOL 1H', fmtMoney(view.volume1h)),
    buildMetaMetric('VOL 24H', fmtMoney(view.volume24h)),
  );

  const leftStack = document.createElement('div');
  leftStack.className = 'lateralized-left-stack';
  leftStack.append(titleLine, metaLine, actions);

  const statsRail = document.createElement('div');
  statsRail.className = 'lateralized-stats-rail bid-zone-stats-rail';
  statsRail.append(
    buildRailMetric('SCORE', formatScore(item.score)),
    buildRailMetric('SUPPORT', formatSignedPct(item.supportDistancePct)),
    buildRailMetric('RANGE', formatPlainPct(item.recentRangePct)),
    buildRailMetric('TOUCH', formatTouchCount(item.supportTouchClusters)),
  );

  main.append(leftStack, statsRail);
  article.append(main);
  return article;
}

function buildBidZoneRowView(state: AppState, item: BidZoneTokenEntry) {
  const tracked = getTrackedToken(state, item.address);
  const symbol = resolveBidZoneSymbol(tracked, item);
  const links = resolveBidZoneLinks(item.pairUrl || tracked?.pairUrl, item.address, symbol);
  const metrics = resolveBidZoneMetrics(tracked, item);
  return {
    tracked,
    symbol,
    subtitle: String(item.name || tracked?.name || ''),
    pairUrl: links.pairUrl,
    xSearchUrl: links.xSearchUrl,
    imageUrl: sanitizeOptionalHttpUrl(item.imageUrl || tracked?.imageUrl),
    volume1h: metrics.volume1h,
    volume24h: metrics.volume24h,
    age: metrics.age,
    mcap: metrics.mcap,
  };
}

function buildBidZoneActions(
  state: AppState,
  item: BidZoneTokenEntry,
  view: ReturnType<typeof buildBidZoneRowView>,
  isStarred: boolean,
  busy: boolean,
  isAdmin: boolean,
) {
  const actions = document.createElement('span');
  actions.className = 'lateralized-inline-actions';
  actions.append(
    buildGlyphButton('⧉', 'action-glyph copy-button', 'copy-address', item.address, null, false, 'Copy contract'),
    buildTradeTerminalMenuElement(item.address, view.tracked?.mintAddress || item.address, view.tracked?.pairAddress || item.pairAddress || null, {
      enabledTradeTerminals: state.ui.enabledTradeTerminals,
    }),
    buildStarButton(item.address, isStarred, busy),
    buildGlyphButton('⊗', 'action-glyph danger-glyph', 'block-token', item.address, view.symbol, busy, 'Block token'),
  );

  if (isAdmin) {
    actions.append(buildGlyphButton('☠', 'action-glyph danger-glyph', 'admin-block-token', item.address, view.symbol, busy, 'Admin block permanently'));
  }

  return actions;
}

function resolveBidZoneSymbol(tracked: ReturnType<typeof getTrackedToken>, item: BidZoneTokenEntry) {
  return item.symbol || tracked?.symbol || item.address.slice(0, 6);
}

function resolveBidZoneLinks(pairUrl: string | null | undefined, address: string, symbol: string) {
  return {
    pairUrl: sanitizeHttpUrl(pairUrl || `https://dexscreener.com/solana/${address}`),
    xSearchUrl: sanitizeHttpUrl(buildXSearchUrl(symbol, address)),
  };
}

function resolveBidZoneMetrics(tracked: ReturnType<typeof getTrackedToken>, item: BidZoneTokenEntry) {
  return {
    volume1h: item.volume1h ?? tracked?.volume1h ?? null,
    volume24h: item.volume24h ?? tracked?.volume24h ?? null,
    age: formatBidZoneAge(item.ageHours, tracked?.createdAt ?? null),
    mcap: item.mcap ?? tracked?.mcap ?? null,
  };
}

function buildAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'tok-avatar';
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'tok-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildInlineLink(label: string, href: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'inline-link';
  link.textContent = label;
  return link;
}

function buildMetaMetric(label: string, value: string) {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'meta-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'meta-value';
  valueEl.textContent = value;
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
}

function buildRailMetric(label: string, value: string) {
  const wrapper = document.createElement('div');
  wrapper.className = 'lateralized-rail-metric';
  const labelEl = document.createElement('span');
  labelEl.className = 'rail-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'rail-value';
  valueEl.textContent = value;
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function buildGlyphButton(
  label: string,
  className: string,
  action: string,
  address: string,
  tokenLabel: string | null,
  busy: boolean,
  title: string,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (tokenLabel) {
    button.dataset.label = tokenLabel;
  }
  button.title = title;
  button.textContent = label;
  button.disabled = busy;
  return button;
}

function buildStarButton(address: string, isStarred: boolean, busy: boolean) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.textContent = isStarred ? '★' : '☆';
  button.title = isStarred ? 'Remove star' : 'Star token';
  button.disabled = busy;
  return button;
}

function formatPlainPct(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '-';
  }
  return `${num.toFixed(1)}%`;
}

function formatSignedPct(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '-';
  }
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
}

function formatTouchCount(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return '-';
  }
  return String(Math.round(num));
}

function formatScore(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '-';
  }
  return num >= 100 ? Math.round(num).toString() : num.toFixed(1);
}

function formatAbsoluteTimestamp(timestamp: string | null) {
  if (!timestamp) {
    return '--:--:--';
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function buildXSearchUrl(symbol: string, address: string) {
  const queryParts = [String(address || '').trim(), `$${String(symbol || '').trim()}`]
    .filter(Boolean);
  return `https://x.com/search?q=${encodeURIComponent(queryParts.join(' OR '))}`;
}

function formatBidZoneAge(ageHours?: number | null, createdAt?: number | null) {
  if (typeof createdAt === 'number' && createdAt > 0) {
    return fmtAge(createdAt);
  }

  const hours = Number(ageHours);
  if (!Number.isFinite(hours) || hours < 0) {
    return '-';
  }

  return fmtAge(Date.now() - (hours * 60 * 60 * 1000));
}
