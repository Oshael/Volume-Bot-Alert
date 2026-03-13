import type { AppController } from '../../state/app-controller';
import type { AppState, ManualTokenEntry } from '../../state/app-state';
import { renderManualTokenEntryForm } from './manual-section';
import { bindCopyButtons, bindMonitoredSortControls, bindTokenActions, fmtAge, fmtMoney, fmtPct, renderTradeTerminalMenu } from './shared';

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'panel legacy-panel';
  const tracked = [...state.data.monitoredTokens]
    .filter((item) => item._userManual || !((item.mcap ?? 0) > 0 && (item.mcap ?? 0) < 30000))
    .sort((a, b) => {
      const mode = state.ui.monitoredSort;
      const metric = (entry: ManualTokenEntry) => {
        if (mode === 'mcap') return entry.mcap || 0;
        if (mode === '1h') return entry.volume1h || 0;
        if (mode === '6h') return entry.volume6h || 0;
        if (mode === '24h') return entry.volume24h || 0;
        return entry.volume5m || 0;
      };
      const delta = metric(b) - metric(a);
      if (delta !== 0) return delta;
      return (b.mcap || 0) - (a.mcap || 0);
    });
  section.innerHTML = `
    <div class="panel-header">
      <span>MONITORED TOKENS</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:9px;color:var(--muted)">SORT BY</span>
        <div class="sort-tabs">
          <button type="button" class="sort-tab ${state.ui.monitoredSort === '5m' ? 'active' : ''}" data-monitored-sort="5m">5M</button>
          <button type="button" class="sort-tab ${state.ui.monitoredSort === '1h' ? 'active' : ''}" data-monitored-sort="1h">1H</button>
          <button type="button" class="sort-tab ${state.ui.monitoredSort === '6h' ? 'active' : ''}" data-monitored-sort="6h">6H</button>
          <button type="button" class="sort-tab ${state.ui.monitoredSort === '24h' ? 'active' : ''}" data-monitored-sort="24h">24H</button>
          <button type="button" class="sort-tab ${state.ui.monitoredSort === 'mcap' ? 'active' : ''}" data-monitored-sort="mcap">MCAP</button>
        </div>
        <span class="count">${tracked.length}</span>
      </div>
    </div>
    <div class="monitored-list">${tracked.length ? tracked.map((item) => renderMonitoredRow(item, state.ui.busy, state.data.starredTokens.includes(item.address))).join('') : '<div class="empty-state"><div class="empty-icon">?</div><div class="empty-text">Add tokens or load trending</div></div>'}</div>
  `;

  section.append(renderManualTokenEntryForm(state, controller));

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindMonitoredSortControls(section, controller);
  return section;
}

function renderMonitoredRow(item: AppState['data']['monitoredTokens'][number], busy: boolean, isStarred: boolean) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const dexUrl = item.pairUrl || `https://dexscreener.com/solana/${item.address}`;
  const xSearch = `https://x.com/search?q=%24${encodeURIComponent(symbol)}`;
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const avatar = item.imageUrl ? `<img src="${item.imageUrl}" alt="${symbol}" class="tok-avatar" />` : `<div class="tok-avatar-placeholder">${symbol.slice(0, 2).toUpperCase()}</div>`;
  const volDelta = item.prevVolume5m && item.prevVolume5m > 0 && item.volume5m != null ? ((item.volume5m - item.prevVolume5m) / item.prevVolume5m) * 100 : null;

  return `
    <article class="token-row monitored-token-row monitored-token-row-v68 ${isStarred ? 'token-starred' : ''}" data-hover-key="monitored:${item.address}">
      ${avatar}
      <div class="panel-row-main monitored-row-main">
        <div class="panel-row-title monitored-title-line">
          <span class="token-name">${symbol}</span>
          <span class="token-addr">${item.name || item.label || ''}</span>
          <a href="${dexUrl}" target="_blank" rel="noreferrer" class="inline-link">/ DEX</a>
          <a href="${xSearch}" target="_blank" rel="noreferrer" class="inline-link">X</a>
        </div>
        <div class="panel-row-meta monitored-meta-line">
          <span><span class="meta-label">MCAP</span> <span class="meta-value">${fmtMoney(item.mcap)}</span></span>
          <span><span class="meta-label">AGE</span> <span class="meta-value">${age}</span></span>
          <span><span class="meta-label">VOL 1H</span> <span class="meta-value">${fmtMoney(item.volume1h)}</span></span>
          <span><span class="meta-label">VOL 6H</span> <span class="meta-value">${fmtMoney(item.volume6h)}</span></span>
          <span><span class="meta-label">VOL 24H</span> <span class="meta-value">${fmtMoney(item.volume24h)}</span></span>
        </div>
        <div class="panel-row-actions monitored-actions-line">
          <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${item.address}" title="Copy contract">&#10697;</button>
          ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress)}
          <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${item.address}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
          <button type="button" class="action-glyph danger-glyph" data-action="block-token" data-address="${item.address}" data-label="${symbol}" ${busy ? 'disabled' : ''} title="Block token">&#8855;</button>
        </div>
      </div>
      <div class="panel-row-side monitored-side-v68">
        <div class="vol5m-label">VOL 5M</div>
        <div class="panel-main-metric monitored-main-metric">${fmtMoney(item.volume5m)}</div>
        <div class="panel-side-delta ${volDelta != null && volDelta < 0 ? 'down' : 'up'}">${fmtPct(volDelta)}</div>
      </div>
    </article>
  `;
}
