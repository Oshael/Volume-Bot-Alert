import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { bindCopyButtons } from './shared';
import { filterItemsByEnabledChains } from '../../utils/token-chain';

export function renderBlocklistSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'blocklist-inline-bar';

  const title = document.createElement('span');
  title.className = 'blocklist-inline-title';
  title.textContent = 'Blocked:';

  const tags = document.createElement('div');
  tags.className = 'blocklist-inline-tags';

  const visibleBlocklist = filterItemsByEnabledChains(state.data.blocklist, state.ui.chainFilters);
  for (const item of visibleBlocklist) {
    const tag = document.createElement('span');
    tag.className = 'blocklist-tag';
    tag.append(document.createTextNode(item.label || item.address.slice(0, 8)));

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'blocklist-tag-remove';
    removeButton.dataset.action = 'remove-blocked';
    removeButton.dataset.address = item.address;
    removeButton.dataset.chain = item.chain || 'solana';
    removeButton.disabled = state.ui.busy;
    removeButton.textContent = 'x';
    tag.append(removeButton);

    tags.append(tag);
  }

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'action-button small';
  clearButton.dataset.action = 'clear-blocklist-visual';
  clearButton.textContent = 'Clear All';

  section.append(title, tags, clearButton);

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-blocked"]')) {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const chain = button.dataset.chain === 'robinhood' ? 'robinhood' : 'solana';
      if (address) void controller.removeBlockedToken(address, chain);
    });
  }

  section.querySelector<HTMLButtonElement>('[data-action="clear-blocklist-visual"]')?.addEventListener('click', () => {
    for (const item of visibleBlocklist) {
      void controller.removeBlockedToken(item.address, item.chain || 'solana');
    }
  });

  bindCopyButtons(section);
  return section;
}
