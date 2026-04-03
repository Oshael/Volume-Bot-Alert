import type { AppController } from '../../state/app-controller';
import { getTrackedToken, type AppState } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, renderTokenCard } from './shared';

export function renderStarredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';
  const manualAddressSet = new Set(state.data.manualTokenAddresses);
  const recentAddressSet = new Set(state.data.recentTokenAddresses);
  const oldWeekAddressSet = new Set(state.data.oldWeekTokenAddresses);

  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">STARRED</span><span class="count-pill">${state.data.starredTokens.length}</span></div>
    <h2>Starred Tokens Slice</h2>
    <p>Starred tokens are synced through the existing backend config payload. This section keeps them visible without changing the ordering rules of the routed bars.</p>
    ${state.data.starredTokens.length === 0 ? '<p class="muted-block">No starred tokens for this account yet.</p>' : '<div class="token-card-grid"></div>'}
  `;

  const grid = section.querySelector<HTMLElement>('.token-card-grid');
  if (grid) {
    for (const address of state.data.starredTokens) {
      const item = getTrackedToken(state, address);
      if (item) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = renderTokenCard(item, state.ui.busy, {
          mode: manualAddressSet.has(address) || item._userManual ? 'manual' : recentAddressSet.has(address) ? 'recent' : oldWeekAddressSet.has(address) ? 'old-week' : 'monitored',
          isStarred: true,
          isAdmin: state.session.role === 'admin',
          enabledTradeTerminals: state.ui.enabledTradeTerminals,
        });
        const card = wrapper.firstElementChild;
        if (card) {
          grid.append(card);
        }
        continue;
      }

      grid.append(buildAddressOnlyStarredCard(address, state));
    }
  }

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function buildAddressOnlyStarredCard(address: string, state: AppState) {
  const article = document.createElement('article');
  article.className = 'token-card starred-card';

  const head = document.createElement('div');
  head.className = 'token-card-head';

  const headLeft = document.createElement('div');
  headLeft.className = 'token-head-left';

  const avatar = document.createElement('div');
  avatar.className = 'token-avatar placeholder';
  avatar.textContent = 'ST';

  const textWrap = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = address.slice(0, 8);
  const subtitle = document.createElement('span');
  subtitle.textContent = address;
  textWrap.append(title, subtitle);
  headLeft.append(avatar, textWrap);

  const starredButton = document.createElement('button');
  starredButton.type = 'button';
  starredButton.className = 'action-button small starred-button';
  starredButton.dataset.action = 'toggle-star';
  starredButton.dataset.address = address;
  starredButton.disabled = state.ui.busy;
  starredButton.textContent = 'STARRED';

  head.append(headLeft, starredButton);

  const tagRow = document.createElement('div');
  tagRow.className = 'button-row compact tag-row';
  const starredChip = document.createElement('div');
  starredChip.className = 'metric-chip alert-chip highlight';
  starredChip.textContent = 'STARRED';
  const addressOnlyChip = document.createElement('div');
  addressOnlyChip.className = 'metric-chip';
  addressOnlyChip.textContent = 'Address-only';
  tagRow.append(starredChip, addressOnlyChip);

  const actionRow = document.createElement('div');
  actionRow.className = 'button-row compact';
  actionRow.append(
    buildActionButton('Copy CA', 'action-button small', 'copy-address', address),
    buildActionButton('Block', 'action-button danger small', 'block-token', address, address.slice(0, 8), state.ui.busy),
  );

  if (state.session.role === 'admin') {
    actionRow.append(
      buildActionButton('Admin Block', 'action-button danger small', 'admin-block-token', address, address.slice(0, 8), state.ui.busy),
    );
  }

  article.append(head, tagRow, actionRow);
  return article;
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
