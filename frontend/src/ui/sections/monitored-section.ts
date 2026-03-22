import type { AppController } from '../../state/app-controller';
import type { AppState, ManualTokenEntry } from '../../state/app-state';
import { renderManualTokenEntryForm } from './manual-section';
import { bindCopyButtons, bindMonitoredSortControls, bindPagedMonitoredControls, bindTokenActions, fmtAge, fmtMoney, fmtPct, renderTradeTerminalMenu } from './shared';
import { escapeHtml, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

export function renderMonitoredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'panel legacy-panel';
  const sorts = state.ui.monitoredSorts;
  const hasMode = (mode: string) => sorts.some((item) => item.mode === mode);
  const hasCriterion = (mode: string, window: string) => sorts.some((item) => item.mode === mode && item.window === window);
  const monitoredVolActive = hasMode('vol') ? 'active' : '';
  const monitoredMcapActive = hasMode('mcap') ? 'active' : '';
  const monitoredAgeActive = hasMode('age') ? 'active' : '';
  const monitoredVol5m = hasCriterion('vol', '5m') ? 'active' : '';
  const monitoredVol1h = hasCriterion('vol', '1h') ? 'active' : '';
  const monitoredVol6h = hasCriterion('vol', '6h') ? 'active' : '';
  const monitoredVol24h = hasCriterion('vol', '24h') ? 'active' : '';
  const monitoredMcapHighest = hasCriterion('mcap', 'highest') ? 'active' : '';
  const monitoredMcapLowest = hasCriterion('mcap', 'lowest') ? 'active' : '';
  const monitoredAgeNewest = hasCriterion('age', 'newest') ? 'active' : '';
  const monitoredAgeOldest = hasCriterion('age', 'oldest') ? 'active' : '';
  const tracked = [...state.data.monitoredTokens]
    .filter((item) => item._userManual || !((item.mcap ?? 0) > 0 && (item.mcap ?? 0) < 30000))
    .sort((a, b) => {
      const metric = (entry: ManualTokenEntry, mode: string, window: string) => {
        if (mode === 'age') return entry.createdAt || 0;
        if (mode === 'mcap') return entry.mcap || 0;
        if (window === '1h') return entry.volume1h || 0;
        if (window === '6h') return entry.volume6h || 0;
        if (window === '24h') return entry.volume24h || 0;
        return entry.volume5m || 0;
      };
      for (const criterion of sorts) {
        const aMetric = metric(a, criterion.mode, criterion.window);
        const bMetric = metric(b, criterion.mode, criterion.window);
        const delta = ((criterion.mode === 'age' && criterion.window === 'oldest') || (criterion.mode === 'mcap' && criterion.window === 'lowest'))
          ? aMetric - bMetric
          : bMetric - aMetric;
        if (delta !== 0) return delta;
      }
      const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
      if (createdDelta !== 0) return createdDelta;
      return (b.mcap || 0) - (a.mcap || 0);
    });
  const safePerPage = Math.max(10, Math.floor(state.ui.monitoredPerPage) || 30);
  const totalPages = Math.max(1, Math.ceil(tracked.length / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(state.ui.monitoredPage) || 0), totalPages - 1);
  const pageStart = safePage * safePerPage;
  const pageItems = tracked.slice(pageStart, pageStart + safePerPage);
  section.innerHTML = `
    <div class="panel-header">
      <span>MONITORED TOKENS</span>
      <div class="panel-header-controls">
        <span class="panel-header-label">SORT BY</span>
        <div class="sort-pill-group monitored-sort-group">
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${monitoredVolActive}" data-sort-toggle="monitored-vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${monitoredVol5m}" data-monitored-sort-mode="vol" data-monitored-sort-window="5m">5M</button>
              <button type="button" class="sort-menu-item ${monitoredVol1h}" data-monitored-sort-mode="vol" data-monitored-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${monitoredVol6h}" data-monitored-sort-mode="vol" data-monitored-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${monitoredVol24h}" data-monitored-sort-mode="vol" data-monitored-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${monitoredMcapActive}" data-sort-toggle="monitored-mcap">MCAP</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${monitoredMcapHighest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${monitoredMcapLowest}" data-monitored-sort-mode="mcap" data-monitored-sort-window="lowest">LOWEST</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${monitoredAgeActive}" data-sort-toggle="monitored-age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${monitoredAgeNewest}" data-monitored-sort-mode="age" data-monitored-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${monitoredAgeOldest}" data-monitored-sort-mode="age" data-monitored-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="panel-header-label">UPDATED ${escapeHtml(state.runtime.monitoredFreshnessLabel || '-')}</span>
        <span class="count">${tracked.length}</span>
      </div>
    </div>
    <div class="panel-subheader monitored-pagination-bar">
      <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="monitored-per-page" value="${safePerPage}" /></label>
      <label class="legacy-mini-field">PAGE <input type="number" min="1" max="${totalPages}" step="1" data-action="monitored-page-jump" value="${safePage + 1}" /></label>
      <span class="bucket-page-total">${totalPages}</span>
      <div class="button-row compact bucket-footer-actions">
        <button type="button" class="action-button small" data-action="monitored-prev" ${safePage === 0 ? 'disabled' : ''}>Prev</button>
        <button type="button" class="action-button small" data-action="monitored-next" ${safePage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
      </div>
    </div>
    <div class="monitored-list">${tracked.length ? pageItems.map((item) => renderMonitoredRow(item, state.ui.busy, state.data.starredTokens.includes(item.address))).join('') : '<div class="empty-state"><div class="empty-icon">?</div><div class="empty-text">Add tokens or load trending</div></div>'}</div>
  `;

  section.append(renderManualTokenEntryForm(state, controller));

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindMonitoredSortControls(section, controller);
  bindPagedMonitoredControls(section, controller);
  return section;
}

function renderMonitoredRow(item: AppState['data']['monitoredTokens'][number], busy: boolean, isStarred: boolean) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const safeAddress = escapeHtml(item.address);
  const safeSymbol = escapeHtml(symbol);
  const safeSubtitle = escapeHtml(item.name || item.label || '');
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = `https://x.com/search?q=%24${encodeURIComponent(symbol)}`;
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const avatar = imageUrl ? `<img src="${imageUrl}" alt="${safeSymbol}" class="tok-avatar" />` : `<div class="tok-avatar-placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;
  const volDelta = item.prevVolume5m && item.prevVolume5m > 0 && item.volume5m != null ? ((item.volume5m - item.prevVolume5m) / item.prevVolume5m) * 100 : null;

  return `
    <article class="token-row monitored-token-row monitored-token-row-v68 ${isStarred ? 'token-starred' : ''}" data-hover-key="monitored:${safeAddress}">
      ${avatar}
      <div class="panel-row-main monitored-row-main">
        <div class="panel-row-title monitored-title-line">
          <span class="token-name">${safeSymbol}</span>
          <span class="token-addr">${safeSubtitle}</span>
          <a href="${dexUrl}" target="_blank" rel="noreferrer" class="inline-link">/ DEX</a>
          <a href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" class="inline-link">X</a>
        </div>
        <div class="panel-row-meta monitored-meta-line">
          <span><span class="meta-label">MCAP</span> <span class="meta-value">${fmtMoney(item.mcap)}</span></span>
          <span><span class="meta-label">AGE</span> <span class="meta-value">${age}</span></span>
          <span><span class="meta-label">VOL 1H</span> <span class="meta-value">${fmtMoney(item.volume1h)}</span></span>
          <span><span class="meta-label">VOL 6H</span> <span class="meta-value">${fmtMoney(item.volume6h)}</span></span>
          <span><span class="meta-label">VOL 24H</span> <span class="meta-value">${fmtMoney(item.volume24h)}</span></span>
        </div>
        <div class="panel-row-actions monitored-actions-line">
          <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeAddress}" title="Copy contract">&#10697;</button>
          ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress)}
          <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
          <button type="button" class="action-glyph danger-glyph" data-action="block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''} title="Block token">&#8855;</button>
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
