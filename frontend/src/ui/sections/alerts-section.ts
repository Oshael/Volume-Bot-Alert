import type { AppController } from '../../state/app-controller';
import type { AlertEntry, AppState } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, fmtAge, fmtMoney, fmtPct, renderTradeTerminalMenu } from './shared';
import { escapeHtml, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

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
        <input class="panel-search" type="text" placeholder="Search ticker..." value="${escapeHtml(state.ui.alertSearchQuery || '')}" data-action="alerts-search" data-search-input="alerts">
        <span class="count">${filteredAlerts.length}</span>
      </div>
    </div>
    <div class="alerts-list">${filteredAlerts.length ? filteredAlerts.map((alert) => renderAlertRow(alert, state.ui.busy, state.data.starredTokens.includes(alert.address), state.session.role === 'admin')).join('') : '<div class="empty-state"><div class="empty-text">No alerts match the current search.</div></div>'}</div>
  `;

  section.querySelector<HTMLInputElement>('[data-action="alerts-search"]')?.addEventListener('input', (event) => {
    controller.setAlertSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function renderAlertRow(alert: AlertEntry, busy: boolean, isStarred: boolean, isAdmin: boolean) {
  const dexUrl = sanitizeHttpUrl(alert.pairUrl || `https://dexscreener.com/solana/${alert.address}`);
  const symbol = alert.symbol;
  const safeAddress = escapeHtml(alert.address);
  const safeSymbol = escapeHtml(symbol);
  const safeName = escapeHtml(alert.name || '');
  const imageUrl = sanitizeOptionalHttpUrl(alert.imageUrl);
  const avatar = imageUrl
    ? `<img src="${imageUrl}" alt="${safeSymbol}" class="alert-avatar" />`
    : `<div class="alert-avatar-placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;
  const xSearch = `https://x.com/search?q=%24${encodeURIComponent(symbol)}`;
  const topClass = getAlertToneClass(alert);
  const titleBlock = renderAlertHeadline(alert, topClass);
  const flowLine = renderAlertFlowLine(alert);
  const statsLine = renderAlertStatsLine(alert);
  const profileLink = sanitizeOptionalHttpUrl(alert.twitterUrl)
    ? `<a href="${sanitizeHttpUrl(alert.twitterUrl)}" target="_blank" rel="noreferrer" class="alert-inline-link">X Perfil</a>`
    : '<span class="alert-inline-link disabled">X Perfil</span>';
  const timeLabel = new Date(alert.createdAt).toLocaleTimeString('en-US');

  return `
    <article class="alert-row ${topClass} ${isStarred ? 'token-starred starred-card' : ''}" data-hover-key="alert:${escapeHtml(alert.id)}">
      <div class="alert-grid">
        <div class="alert-body-v68">
          <div class="alert-main-v68">
            ${avatar}
            <div class="alert-copy-block">
              <div class="alert-top-v68">
                <span class="alert-token-v68">${safeSymbol} <span class="alert-token-name">${safeName}</span></span>
                ${titleBlock}
              </div>
              <div class="alert-flow-v68">${flowLine}</div>
            </div>
          </div>
          <div class="alert-stats-v68">${statsLine}</div>
          <div class="alert-links-v68">
            <a href="${dexUrl}" target="_blank" rel="noreferrer" class="alert-inline-link">Dex Screener</a>
            <span>/</span>
            <a href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" class="alert-inline-link">X Buscar $${safeSymbol}</a>
            <span>/</span>
            ${profileLink}
          </div>
          <div class="alert-actions-v68">
            <button type="button" class="alert-action-button copy-button" data-action="copy-address" data-address="${safeAddress}">Copiar CA</button>
            ${renderTradeTerminalMenu(alert.address, alert.mintAddress, alert.pairAddress)}
            <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
            <button type="button" class="alert-action-button danger" data-action="block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''}>Block</button>
            ${isAdmin ? `<button type="button" class="alert-action-button danger" data-action="admin-block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''}>Admin Block</button>` : ''}
          </div>
        </div>
        <div class="alert-time-v68">${escapeHtml(timeLabel)}</div>
      </div>
    </article>
  `;
}

function renderAlertHeadline(alert: AlertEntry, toneClass: string) {
  if (alert.isOldSurge) {
    const tokenAgeMs = alert.tokenCreatedAt ? Date.now() - alert.tokenCreatedAt : Number.POSITIVE_INFINITY;
    const surgeTitle = tokenAgeMs <= RECENT_TOKEN_MAX_AGE_MS ? 'RECENT TOKEN SURGE' : 'OLD TOKEN SURGE';
    return `<span class="alert-badge-v68 ${toneClass}">\u{1F525} ${escapeHtml(surgeTitle)}<br><span class="alert-badge-sub">${escapeHtml(fmtPct(alert.pct))} ${escapeHtml(alert.label || 'PCHANGE')}</span></span>`;
  }
  if (alert.kind === 'meteora-surge') {
    return `<span class="alert-badge-v68 ${toneClass}">\u{1F30A} Meteora Alert 1h<br><span class="alert-badge-sub">${escapeHtml(fmtPct(alert.pct))} ${escapeHtml(alert.label || 'METEORA 1H')}</span></span>`;
  }
  if (alert.isHvnc) {
    return `<span class="alert-badge-v68 mega">\u{1F6A8} High Volume New Coin<br><span class="alert-badge-sub">${escapeHtml(fmtMoney(alert.volume24h))} total vol</span></span>`;
  }
  return `<span class="alert-pct-v68 ${toneClass}">${escapeHtml(fmtPct(alert.pct))} <span>${escapeHtml(alert.label || 'VOL')}</span></span>`;
}

function renderAlertFlowLine(alert: AlertEntry) {
  const currentVol = fmtMoney(alert.volume5m);
  const currentMcap = fmtMoney(alert.mcap);
  const prevVol = alert.prevVolume5m != null ? fmtMoney(alert.prevVolume5m) : null;
  const prevMcap = alert.prevMcap != null ? fmtMoney(alert.prevMcap) : null;
  const mcapTone = alert.prevMcap != null && alert.mcap != null && alert.mcap < alert.prevMcap ? 'down' : 'up';

  if (alert.isOldSurge) {
    return `<span><span class="label">MCAP</span> <span class="value up">${currentMcap}</span></span><span><span class="label">AGE</span> <span class="value white">${alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-'}</span></span>`;
  }

  const volHtml = prevVol
    ? `<span><span class="label">VOL 5M</span> ${prevVol} \u2192 <span class="value up">${currentVol}</span></span>`
    : `<span><span class="label">VOL 5M</span> <span class="value up">${currentVol}</span></span>`;
  const mcapHtml = prevMcap
    ? `<span><span class="label">MCAP</span> ${prevMcap} \u2192 <span class="value ${mcapTone}">${currentMcap}</span></span>`
    : `<span><span class="label">MCAP</span> <span class="value ${mcapTone}">${currentMcap}</span></span>`;
  return `${volHtml}<span class="flow-gap"></span>${mcapHtml}`;
}

function renderAlertStatsLine(alert: AlertEntry) {
  return [
    `<span><span class="label">MCAP</span> <span class="value up current-mcap">${fmtMoney(alert.mcap)}</span></span>`,
    `<span><span class="label">AGE</span> <span class="value white">${alert.tokenCreatedAt ? fmtAge(alert.tokenCreatedAt) : '-'}</span></span>`,
    `<span><span class="label">1H</span> <span class="value white">${fmtMoney(alert.volume1h)}</span></span>`,
    `<span><span class="label">6H</span> <span class="value white">${fmtMoney(alert.volume6h)}</span></span>`,
    `<span><span class="label">24H</span> <span class="value white">${fmtMoney(alert.volume24h)}</span></span>`,
  ].join('');
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
