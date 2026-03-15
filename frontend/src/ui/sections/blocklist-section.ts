import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { bindCopyButtons } from './shared';

export function renderBlocklistSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'blocklist-inline-bar';
  section.innerHTML = `
    <span class="blocklist-inline-title">Blocked:</span>
    <div class="blocklist-inline-tags">${state.data.blocklist.map((item) => `
      <span class="blocklist-tag">${item.label || item.address.slice(0, 8)}<button type="button" class="blocklist-tag-remove" data-action="remove-blocked" data-address="${item.address}" ${state.ui.busy ? 'disabled' : ''}>x</button></span>
    `).join('')}</div>
    <button type="button" class="action-button small" data-action="clear-blocklist-visual">Clear All</button>
  `;

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-blocked"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) void controller.removeBlockedToken(address);
    });
  }

  section.querySelector<HTMLButtonElement>('[data-action="clear-blocklist-visual"]')?.addEventListener('click', () => {
    for (const item of state.data.blocklist) {
      void controller.removeBlockedToken(item.address);
    }
  });

  bindCopyButtons(section);
  return section;
}
