import type { AppController } from '../../state/app-controller';
import type { AlertEntry, AppState } from '../../state/app-state';
import { bindCompactSearch, bindCopyButtons, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtMoney, fmtPct } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

const RECENT_TOKEN_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const RECENT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function renderAlertsSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'panel legacy-panel alerts-panel';
  const searchQuery = String(state.ui.alertSearchQuery || '').trim().toLowerCase();
  const filteredAlerts = searchQuery
    ? state.data.alerts.filter((alert) => {
      const symbol = String(alert.symbol || '').toLowerCase();
      const name = String(alert.name || '').toLowerCase();
      const address = String(alert.address || '').toLowerCase();
      return symbol.includes(searchQuery) || name.includes(searchQuery) || address.includes(searchQuery);
    })
    : state.data.alerts;
  section.innerHTML = `
    <div class="panel-header">
      <span>\u{1F514} ALERTS</span>
      <div style="display:flex;align-items:center;gap:6px">
        <button type="button" class="action-button small" data-action="alerts-clear-all">Clean All</button>
        <div class="compact-search compact-search-fixed ${searchQuery ? 'has-query' : ''}">
          <button type="button" class="compact-search-toggle" data-action="alerts-search-focus" aria-label="Search alerts">&#128269;</button>
          <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="alerts-search" data-search-input="alerts">
        </div>
        <span class="count">${filteredAlerts.length}</span>
      </div>
    </div>
    <div class="alerts-list"></div>
  `;

  const alertsList = section.querySelector<HTMLElement>('.alerts-list');
  if (alertsList) {
    if (filteredAlerts.length) {
      for (const alert of filteredAlerts) {
        alertsList.append(buildAlertRow(alert, state.ui.busy, state.data.starredTokens.includes(alert.address), state.session.role === 'admin'));
      }
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const emptyText = document.createElement('div');
      emptyText.className = 'empty-text';
      emptyText.textContent = 'No alerts match the current search.';
      emptyState.append(emptyText);
      alertsList.append(emptyState);
    }
  }

  const searchInput = section.querySelector<HTMLInputElement>('[data-action="alerts-search"]');
  if (searchInput) {
    searchInput.value = state.ui.alertSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'alerts-search-focus',
    inputAction: 'alerts-search',
  });
  searchInput?.addEventListener('input', (event) => {
    controller.setAlertSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="alerts-clear-all"]')?.addEventListener('click', () => {
    controller.clearAllAlerts();
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="remove-alert"]').forEach((button) => {
    button.addEventListener('click', () => {
      const alertId = button.dataset.alertId;
      if (alertId) {
        controller.removeAlert(alertId);
      }
    });
  });
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function buildAlertRow(alert: AlertEntry, busy: boolean, isStarred: boolean, isAdmin: boolean) {
  const dexUrl = sanitizeHttpUrl(alert.pairUrl || `https://dexscreener.com/solana/${alert.address}`);
  const symbol = String(alert.symbol || '');
  const safeName = String(alert.name || '');
  const imageUrl = sanitizeOptionalHttpUrl(alert.imageUrl);
  const xSearch = buildXSearchUrl(symbol, alert.address);
  const topClass = getAlertToneClass(alert);
  const timeLabel = new Date(alert.createdAt).toLocaleTimeString('en-US');
  const article = document.createElement('article');
  article.className = `alert-row ${topClass}${isStarred ? ' token-starred starred-card' : ''}`;
  article.dataset.hoverKey = `alert:${alert.id}`;

  const grid = document.createElement('div');
  grid.className = 'alert-grid';
  const body = document.createElement('div');
  body.className = 'alert-body-v68';
  const time = document.createElement('div');
  time.className = 'alert-time-v68';
  time.textContent = timeLabel;

  const main = document.createElement('div');
  main.className = 'alert-main-v68';
  main.append(buildAlertAvatar(symbol, imageUrl));

  const copyBlock = document.createElement('div');
  copyBlock.className = 'alert-copy-block';

  const top = document.createElement('div');
  top.className = 'alert-top-v68';
  const tokenLine = document.createElement('span');
  tokenLine.className = 'alert-token-v68';
  tokenLine.append(symbol);
  const tokenName = document.createElement('span');
  tokenName.className = 'alert-token-name';
  tokenName.textContent = safeName;
  tokenLine.append(' ', tokenName);
  const topSide = document.createElement('div');
  topSide.className = 'alert-top-side';
  topSide.append(buildAlertHeadline(alert, topClass), buildAlertDismissButton(alert.id));
  top.append(tokenLine, topSide);

  const flowLine = document.createElement('div');
  flowLine.className = 'alert-flow-v68';
  appendAlertFlowLine(flowLine, alert);

  copyBlock.append(top, flowLine);
  main.append(copyBlock);

  const statsLine = document.createElement('div');
  statsLine.className = 'alert-stats-v68';
  appendAlertStatsLine(statsLine, alert);

  const links = document.createElement('div');
  links.className = 'alert-links-v68';
  links.append(
    buildInlineLink('Dex Screener', dexUrl),
    buildTextSeparator(),
    buildInlineLink('X Buscar CA / ', sanitizeHttpUrl(xSearch)),
    buildTextSeparator(),
    buildProfileLink(alert.twitterUrl),
  );

  const actions = document.createElement('div');
  actions.className = 'alert-actions-v68';
  actions.append(
    buildActionButton('Copiar CA', 'alert-action-button copy-button', 'copy-address', alert.address),
    buildTradeTerminalMenuElement(alert.address, alert.mintAddress, alert.pairAddress),
    buildStarButton(alert.address, isStarred, busy, 'Star token'),
    buildActionButton('Block', 'alert-action-button danger', 'block-token', alert.address, symbol, busy),
  );

  if (isAdmin) {
    actions.append(buildActionButton('Admin Block', 'alert-action-button danger', 'admin-block-token', alert.address, symbol, busy));
  }

  body.append(main, statsLine, links, actions);
  grid.append(body, time);
  article.append(grid);
  return article;
}

function buildAlertAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'alert-avatar';
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'alert-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildAlertHeadline(alert: AlertEntry, toneClass: string) {
  const badge = document.createElement('span');
  if (alert.isOldSurge) {
    const tokenAgeMs = alert.tokenCreatedAt ? Date.now() - alert.tokenCreatedAt : Number.POSITIVE_INFINITY;
    const surgeTitle = tokenAgeMs <= RECENT_TOKEN_MAX_AGE_MS ? 'RECENT TOKEN SURGE' : 'OLD TOKEN SURGE';
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append(`🔥 ${surgeTitle}`, document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'PCHANGE')));
    return badge;
  }
  if (alert.kind === 'meteora-surge') {
    badge.className = `alert-badge-v68 ${toneClass}`;
    badge.append('🌊 Meteora Alert 1h', document.createElement('br'), buildAlertBadgeSub(fmtPct(alert.pct), String(alert.label || 'METEORA 1H')));
    return badge;
  }
  if (alert.isHvnc) {
    badge.className = 'alert-badge-v68 mega';
    badge.append('🚨 High Volume New Coin', document.createElement('br'), buildAlertBadgeSub(fmtMoney(alert.volume24h), 'total vol'));
    return badge;
  }
  badge.className = `alert-pct-v68 ${toneClass}`;
  badge.append(`${fmtPct(alert.pct)} `);
  const label = document.createElement('span');
  label.textContent = String(alert.label || 'VOL');
  badge.append(label);
  return badge;
}

function buildAlertBadgeSub(primary: string, secondary: string) {
  const sub = document.createElement('span');
  sub.className = 'alert-badge-sub';
  sub.textContent = `${primary} ${secondary}`;
  return sub;
}

function buildXSearchUrl(symbol: string, address: string) {
  const queryParts = [String(address || '').trim(), `$${String(symbol || '').trim()}`]
    .filter(Boolean);
  return `https://x.com/search?q=${encodeURIComponent(queryParts.join(' OR '))}`;
}

function appendAlertFlowLine(container: HTMLElement, alert: AlertEntry) {
  const currentVol = fmtMoney(alert.volume5m);
  const currentMcap = fmtMoney(alert.mcap);
  const prevVol = alert.prevVolume5m != null ? fmtMoney(alert.prevVolume5m) : null;
  const prevMcap = alert.prevMcap != null ? fmtMoney(alert.prevMcap) : null;
  const mcapTone = alert.prevMcap != null && alert.mcap != null && alert.mcap < alert.prevMcap ? 'down' : 'up';

  if (alert.isOldSurge) {
    container.append(
      buildMetricPair('MCAP', currentMcap, 'up'),
      buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', 'white'),
    );
    return;
  }

  container.append(
    prevVol
      ? buildFlowTransition('VOL 5M', prevVol, currentVol, 'up')
      : buildMetricPair('VOL 5M', currentVol, 'up'),
  );
  const gap = document.createElement('span');
  gap.className = 'flow-gap';
  container.append(gap);
  container.append(
    prevMcap
      ? buildFlowTransition('MCAP', prevMcap, currentMcap, mcapTone)
      : buildMetricPair('MCAP', currentMcap, mcapTone),
  );
}

function appendAlertStatsLine(container: HTMLElement, alert: AlertEntry) {
  container.append(
    buildMetricPair('MCAP', fmtMoney(alert.mcap), 'up current-mcap'),
    buildMetricPair('AGE', alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-', 'white'),
    buildMetricPair('1H', fmtMoney(alert.volume1h), 'white'),
    buildMetricPair('6H', fmtMoney(alert.volume6h), 'white'),
    buildMetricPair('24H', fmtMoney(alert.volume24h), 'white'),
  );
}

function buildMetricPair(label: string, value: string, toneClass: string) {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = `value ${toneClass}`.trim();
  valueEl.textContent = value;
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
}

function buildFlowTransition(label: string, previous: string, next: string, toneClass: string) {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  wrapper.append(labelEl, ` ${previous} → `);
  const valueEl = document.createElement('span');
  valueEl.className = `value ${toneClass}`.trim();
  valueEl.textContent = next;
  wrapper.append(valueEl);
  return wrapper;
}

function buildInlineLink(label: string, href: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'alert-inline-link';
  link.textContent = label;
  return link;
}

function buildProfileLink(url: string | null | undefined) {
  const safeUrl = sanitizeOptionalHttpUrl(url);
  if (!safeUrl) {
    const disabled = document.createElement('span');
    disabled.className = 'alert-inline-link disabled';
    disabled.textContent = '👤';
    return disabled;
  }
  return buildInlineLink(isXCommunityUrl(safeUrl) ? '👥' : '👤', sanitizeHttpUrl(safeUrl));
}

function buildTextSeparator() {
  const separator = document.createElement('span');
  separator.textContent = '/';
  return separator;
}

function buildActionButton(
  label: string,
  className: string,
  action: string,
  address: string,
  dataLabel?: string | null,
  disabled = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (dataLabel) {
    button.dataset.label = dataLabel;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function buildAlertDismissButton(alertId: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'alert-dismiss-button';
  button.dataset.action = 'remove-alert';
  button.dataset.alertId = alertId;
  button.setAttribute('aria-label', 'Remove alert');
  button.textContent = '×';
  return button;
}

function buildStarButton(address: string, isStarred: boolean, disabled: boolean, title: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.disabled = disabled;
  button.title = title;
  button.textContent = isStarred ? '★' : '☆';
  return button;
}

function isXCommunityUrl(url: string | null | undefined) {
  const value = String(url || '').trim().toLowerCase();
  return value.includes('x.com/i/communities/') || value.includes('twitter.com/i/communities/');
}

function getAlertToneClass(alert: AlertEntry) {
  if (alert.isOldSurge) {
    const tokenAgeMs = alert.tokenCreatedAt ? Date.now() - alert.tokenCreatedAt : Number.POSITIVE_INFINITY;
    return tokenAgeMs >= RECENT_TOKEN_MIN_AGE_MS && tokenAgeMs <= RECENT_TOKEN_MAX_AGE_MS ? 'recent-surge' : 'old-surge';
  }
  if (alert.isHvnc) return 'mega';

  if (alert.kind === 'pumpfun-vol') {
    return 'pump-alert';
  }

  if (alert.kind === 'pumpfun-hvnc') {
    return 'mega';
  }
  if (alert.kind === 'meteora-surge') {
    return 'meteora-surge';
  }

  const pct = Math.abs(Number(alert.pct) || 0);
  if (pct >= 200) return 'mega';
  if (pct >= 100) return 'critical';
  return 'normal';
}
