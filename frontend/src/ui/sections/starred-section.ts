import type { AppController } from '../../state/app-controller';
import type { AppState, ManualTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, renderTokenCard } from './shared';
import { escapeHtml } from './html-safety';

export function renderStarredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';

  const knownByAddress = new Map<string, ManualTokenEntry>();
  for (const item of [...state.data.manualTokens, ...state.data.monitoredTokens, ...state.data.recentTokens, ...state.data.oldWeekTokens]) {
    if (!knownByAddress.has(item.address)) {
      knownByAddress.set(item.address, item);
    }
  }

  const rows = state.data.starredTokens.map((address) => {
    const item = knownByAddress.get(address);
    if (item) {
      return renderTokenCard(item, state.ui.busy, {
        mode: item._userManual ? 'manual' : state.data.recentTokens.some((tok) => tok.address === address) ? 'recent' : state.data.oldWeekTokens.some((tok) => tok.address === address) ? 'old-week' : 'monitored',
        isStarred: true,
      });
    }

    const safeAddress = escapeHtml(address);
    const shortAddress = escapeHtml(address.slice(0, 8));

    return `
      <article class="token-card starred-card">
        <div class="token-card-head">
          <div class="token-head-left"><div class="token-avatar placeholder">ST</div><div><strong>${shortAddress}</strong><span>${safeAddress}</span></div></div>
          <button type="button" class="action-button small starred-button" data-action="toggle-star" data-address="${safeAddress}" ${state.ui.busy ? 'disabled' : ''}>STARRED</button>
        </div>
        <div class="button-row compact tag-row"><div class="metric-chip alert-chip highlight">STARRED</div><div class="metric-chip">Address-only</div></div>
        <div class="button-row compact"><button type="button" class="action-button small" data-action="copy-address" data-address="${safeAddress}">Copy CA</button><button type="button" class="action-button danger small" data-action="block-token" data-address="${safeAddress}" data-label="${shortAddress}" ${state.ui.busy ? 'disabled' : ''}>Block</button></div>
      </article>
    `;
  }).join('');

  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">STARRED</span><span class="count-pill">${state.data.starredTokens.length}</span></div>
    <h2>Starred Tokens Slice</h2>
    <p>Starred tokens are synced through the existing backend config payload. This section keeps them visible without changing the ordering rules of the routed bars.</p>
    ${state.data.starredTokens.length === 0 ? '<p class="muted-block">No starred tokens for this account yet.</p>' : `<div class="token-card-grid">${rows}</div>`}
  `;

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}
