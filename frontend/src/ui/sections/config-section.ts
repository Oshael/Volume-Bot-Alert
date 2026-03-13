import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';

export function renderConfigSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';
  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">CONFIG</span><span class="count-pill">${state.configSummary.loaded ? 'SYNCED' : 'EMPTY'}</span></div>
    <h2>Config Hydration</h2>
    <p>The new frontend is consuming the account-scoped payload from <code>/api/config</code>, including manual tokens, bootstrap tokens, and the bar MCAP ranges used for age routing.</p>
    <div class="summary-grid">
      <div class="summary-box"><span>Config Keys</span><strong>${state.configSummary.configCount}</strong></div>
      <div class="summary-box"><span>Manual Tokens</span><strong>${state.configSummary.manualTokens}</strong></div>
      <div class="summary-box"><span>Blocklist</span><strong>${state.configSummary.blocklist}</strong></div>
      <div class="summary-box"><span>Starred</span><strong>${state.configSummary.starredTokens}</strong></div>
      <div class="summary-box"><span>Bootstrap</span><strong>${state.configSummary.bootstrapTokens}</strong></div>
    </div>
    <div class="button-row"><button type="button" class="action-button" data-action="reload-config" ${state.session.status === 'authenticated' && !state.ui.busy ? '' : 'disabled'}>Reload /api/config</button></div>
  `;
  section.querySelector<HTMLButtonElement>('[data-action="reload-config"]')?.addEventListener('click', () => void controller.reloadConfig());
  return section;
}
