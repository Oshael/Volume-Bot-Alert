import type { AppController } from '../../state/app-controller';
import { getChainCapabilityNotice, getManualTokens, getOldWeekTokens, getRecentTokens, getTrackedToken, type AppState, type ManualTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, renderTokenCard } from './shared';
import { bindMonitoredTickerPeerPanelClose } from './monitored-section';
import { bindRadarIdentityBadges } from './radar-identity-badges';
import { escapeHtml } from './html-safety';
import { buildTokenIdentityKey, parseTokenIdentityKey, type TokenChain } from '../../utils/token-chain';

export function renderStarredSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'surface-card action-card';
  const capabilityNotice = getChainCapabilityNotice(state, 'starred');
  if (capabilityNotice) {
    section.innerHTML = `
      <div class="card-topline"><span class="section-tag">STARRED</span><span class="count-pill">0</span></div>
      <div class="chain-readiness-empty" data-chain-readiness-surface="starred">${escapeHtml(capabilityNotice)}</div>
    `;
    return section;
  }
  const visibleIdentities = state.data.starredTokenIdentities.filter((identityKey) => (
    state.ui.chainFilters.enabledChains.includes(parseTokenIdentityKey(identityKey).chain)
  ));
  const manualAddressSet = new Set(getManualTokens(state).map((token) => (
    buildTokenIdentityKey(token.chain || 'solana', token.address)
  )));
  const recentAddressSet = new Set(getRecentTokens(state).map((token) => (
    buildTokenIdentityKey(token.chain || 'solana', token.address)
  )));
  const oldWeekAddressSet = new Set(getOldWeekTokens(state).map((token) => (
    buildTokenIdentityKey(token.chain || 'solana', token.address)
  )));

  section.innerHTML = `
    <div class="card-topline"><span class="section-tag">STARRED</span><span class="count-pill">${visibleIdentities.length}</span></div>
    <h2>Starred Tokens Slice</h2>
    <p>Starred tokens are synced through the existing backend config payload. This section keeps them visible without changing the ordering rules of the routed bars.</p>
    ${visibleIdentities.length === 0 ? '<p class="muted-block">No starred tokens for the selected chains.</p>' : '<div class="token-card-grid"></div>'}
  `;

  const renderedTokens: ManualTokenEntry[] = [];
  const grid = section.querySelector<HTMLElement>('.token-card-grid');
  if (grid) {
    for (const identityKey of visibleIdentities) {
      const identity = parseTokenIdentityKey(identityKey);
      const address = identity.address;
      const item = getTrackedToken(state, address, identity.chain);
      if (item) {
        renderedTokens.push(item);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = renderTokenCard(item, state.ui.busy, {
          mode: manualAddressSet.has(identityKey) || item._userManual ? 'manual' : recentAddressSet.has(identityKey) ? 'recent' : oldWeekAddressSet.has(identityKey) ? 'old-week' : 'monitored',
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

      grid.append(buildAddressOnlyStarredCard(identity.chain, address, state));
    }
  }

  bindRadarIdentityBadges(section, renderedTokens);
  bindMonitoredTickerPeerPanelClose(section);
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function buildAddressOnlyStarredCard(chain: TokenChain, address: string, state: AppState) {
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
  starredButton.dataset.chain = chain;
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
    buildActionButton('Copy CA', 'action-button small', 'copy-address', chain, address),
    buildActionButton('Block', 'action-button danger small', 'block-token', chain, address, address.slice(0, 8), state.ui.busy),
  );

  if (state.session.role === 'admin' && chain === 'solana') {
    actionRow.append(
      buildActionButton('Admin Block', 'action-button danger small', 'admin-block-token', chain, address, address.slice(0, 8), state.ui.busy),
    );
  }

  article.append(head, tagRow, actionRow);
  return article;
}

function buildActionButton(
  label: string,
  className: string,
  action: string,
  chain: TokenChain,
  address: string,
  dataLabel?: string | null,
  disabled = false,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  button.dataset.chain = chain;
  if (dataLabel) {
    button.dataset.label = dataLabel;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}
