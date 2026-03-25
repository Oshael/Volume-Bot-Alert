import type { AppController } from '../../state/app-controller';
import { getTrackedToken, type AppState, type LateralizedTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtMoney } from './shared';
import { sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';

export function renderLateralizedSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'panel legacy-panel lateralized-panel';
  const freshness = state.runtime.lateralizedFreshnessLabel !== '-'
    ? `SCAN ${state.runtime.lateralizedFreshnessLabel}`
    : 'SCAN pending';

  section.innerHTML = `
    <div class="panel-header">
      <span>LATERALIZATION COINS</span>
      <div class="lateralized-header-meta">
        <span class="lateralized-freshness">${freshness}</span>
        <span class="count">${state.data.lateralizedTokens.length}</span>
      </div>
    </div>
    <div class="lateralized-list"></div>
  `;

  const list = section.querySelector<HTMLElement>('.lateralized-list');
  if (list) {
    if (state.data.lateralizedTokens.length > 0) {
      state.data.lateralizedTokens.forEach((item, index) => {
        list.append(buildLateralizedRow(state, item, index, state.ui.busy, state.data.starredTokens.includes(item.address), state.session.role === 'admin'));
      });
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const emptyText = document.createElement('div');
      emptyText.className = 'empty-text';
      emptyText.textContent = 'No lateralized coins available yet.';
      emptyState.append(emptyText);
      list.append(emptyState);
    }
  }

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function buildLateralizedRow(
  state: AppState,
  item: LateralizedTokenEntry,
  index: number,
  busy: boolean,
  isStarred: boolean,
  isAdmin: boolean,
) {
  const tracked = getTrackedToken(state, item.address);
  const symbol = tracked?.symbol || item.symbol || item.address.slice(0, 6);
  const subtitle = String(tracked?.name || item.name || '');
  const pairUrl = sanitizeHttpUrl(tracked?.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearchUrl = sanitizeHttpUrl(`https://x.com/search?q=%24${encodeURIComponent(symbol)}`);
  const imageUrl = sanitizeOptionalHttpUrl(tracked?.imageUrl);
  const volume1h = item.volume1h ?? tracked?.volume1h ?? null;
  const volume24h = item.volume24h ?? tracked?.volume24h ?? null;
  const age = formatLateralizedAge(item.ageHours, tracked?.createdAt ?? null);
  const article = document.createElement('article');
  article.className = `token-row lateralized-token-row${isStarred ? ' token-starred' : ''}`;
  article.dataset.hoverKey = `lateralized:${item.address}`;

  const rank = document.createElement('div');
  rank.className = 'lateralized-rank';
  rank.textContent = `#${index + 1}`;

  article.append(rank, buildAvatar(symbol, imageUrl));

  const main = document.createElement('div');
  main.className = 'lateralized-row-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'lateralized-title-line';

  const tokenName = document.createElement('span');
  tokenName.className = 'token-name';
  tokenName.textContent = symbol;

  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = subtitle;

  titleLine.append(
    tokenName,
    tokenAddr,
    buildInlineLink('/ DEX', pairUrl),
    buildInlineLink('X', xSearchUrl),
  );

  const actions = document.createElement('span');
  actions.className = 'lateralized-inline-actions';
  actions.append(
    buildGlyphButton('⧉', 'action-glyph copy-button', 'copy-address', item.address, null, false, 'Copy contract'),
    buildTradeTerminalMenuElement(item.address, tracked?.mintAddress || item.address, tracked?.pairAddress || null),
    buildStarButton(item.address, isStarred, busy),
    buildGlyphButton('⊗', 'action-glyph danger-glyph', 'block-token', item.address, symbol, busy, 'Block token'),
  );

  if (isAdmin) {
    actions.append(buildGlyphButton('☠', 'action-glyph danger-glyph', 'admin-block-token', item.address, symbol, busy, 'Admin block permanently'));
  }

  titleLine.append(actions);

  const metaLine = document.createElement('div');
  metaLine.className = 'lateralized-meta-line';
  metaLine.append(
    buildMetaMetric('MCAP', fmtMoney(item.mcap ?? tracked?.mcap ?? null)),
    buildMetaMetric('AGE', age),
    buildMetaMetric('VOL 1H', fmtMoney(volume1h)),
    buildMetaMetric('VOL 24H', fmtMoney(volume24h)),
  );

  main.append(titleLine, metaLine);
  article.append(main);
  return article;
}

function buildAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'tok-avatar';
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'tok-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildInlineLink(label: string, href: string) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'inline-link';
  link.textContent = label;
  return link;
}

function buildMetaMetric(label: string, value: string) {
  const wrapper = document.createElement('span');
  const labelEl = document.createElement('span');
  labelEl.className = 'meta-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'meta-value';
  valueEl.textContent = value;
  wrapper.append(labelEl, ' ', valueEl);
  return wrapper;
}

function buildGlyphButton(
  label: string,
  className: string,
  action: string,
  address: string,
  tokenLabel: string | null,
  busy: boolean,
  title: string,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (tokenLabel) {
    button.dataset.label = tokenLabel;
  }
  button.title = title;
  button.textContent = label;
  button.disabled = busy;
  return button;
}

function buildStarButton(address: string, isStarred: boolean, busy: boolean) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-glyph starred-button${isStarred ? ' active' : ''}`;
  button.dataset.action = 'toggle-star';
  button.dataset.address = address;
  button.textContent = isStarred ? '★' : '☆';
  button.title = isStarred ? 'Remove star' : 'Star token';
  button.disabled = busy;
  return button;
}

function formatPlainPct(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '-';
  }
  return `${num.toFixed(1)}%`;
}

function formatHours(value?: number | null) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return '-';
  }
  return `${Math.round(num)}H`;
}

function formatLateralizedAge(ageHours?: number | null, createdAt?: number | null) {
  if (typeof createdAt === 'number' && createdAt > 0) {
    return fmtAge(createdAt);
  }

  const hours = Number(ageHours);
  if (!Number.isFinite(hours) || hours < 0) {
    return '-';
  }

  return fmtAge(Date.now() - (hours * 60 * 60 * 1000));
}
