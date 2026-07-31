import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { escapeHtml } from './html-safety';

function safeTelegramUrl(value: string | null) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 't.me' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function statusLabel(status: AppState['telegram']['status']) {
  return {
    disconnected: 'Disconnected',
    active: 'Active',
    paused: 'Paused',
    access_suspended: 'Access suspended',
  }[status];
}

function renderMessages(telegram: AppState['telegram'], pendingUrl: string | null) {
  return [
    telegram.loading && !telegram.loaded
      ? '<p class="telegram-settings-note">Loading Telegram status...</p>' : '',
    telegram.error
      ? `<p class="telegram-settings-error" role="alert">${escapeHtml(telegram.error)}</p>` : '',
    telegram.loaded && !telegram.available
      ? '<p class="telegram-settings-note">Telegram integration is not available in this environment.</p>' : '',
    pendingUrl
      ? '<p class="telegram-settings-note">Link ready. Open Telegram and press Start before it expires.</p>' : '',
  ].join('');
}

function renderDetails(telegram: AppState['telegram'], identity: string, connected: boolean) {
  if (!connected) return '';
  return `
    <dl class="telegram-settings-details">
      <div><dt>Account</dt><dd>${escapeHtml(identity)}</dd></div>
      <div><dt>Last delivery</dt><dd>${escapeHtml(telegram.lastDeliveryAt || 'No deliveries yet')}</dd></div>
      <div><dt>Last error</dt><dd>${escapeHtml(telegram.lastError?.code || 'None')}</dd></div>
    </dl>
  `;
}

function renderActions(
  telegram: AppState['telegram'],
  connected: boolean,
  pendingUrl: string | null,
  botUrl: string | null,
) {
  const actions = [];
  if (telegram.available && !connected && !pendingUrl) {
    actions.push(`<button type="button" class="legacy-btn legacy-btn-primary" data-action="create-telegram-link" ${telegram.mutating ? 'disabled' : ''}>Connect Telegram</button>`);
  }
  if (pendingUrl) actions.push(`<a class="legacy-btn legacy-btn-primary" href="${escapeHtml(pendingUrl)}" target="_blank" rel="noopener noreferrer">Open Telegram</a>`);
  if (connected && botUrl) actions.push(`<a class="legacy-btn" href="${escapeHtml(botUrl)}" target="_blank" rel="noopener noreferrer">Open Telegram</a>`);
  if (connected) actions.push(`<button type="button" class="legacy-btn" data-action="disconnect-telegram" ${telegram.mutating ? 'disabled' : ''}>Disconnect</button>`);
  actions.push(`<button type="button" class="legacy-btn" data-action="refresh-telegram" ${telegram.loading ? 'disabled' : ''}>Refresh</button>`);
  return actions.join('');
}

export function renderTelegramSettings(state: AppState) {
  const telegram = state.telegram;
  const pendingUrl = safeTelegramUrl(telegram.pendingDeepLink);
  const botUrl = safeTelegramUrl(telegram.botUrl);
  const identity = telegram.identity?.username
    ? `@${telegram.identity.username}`
    : telegram.identity?.firstName || 'Private Telegram chat';
  const connected = telegram.status !== 'disconnected';

  return `
    <div class="telegram-settings-card" data-telegram-settings>
      <div class="telegram-settings-head">
        <div>
          <strong>Telegram alerts</strong>
          <span>Telegram rules are configured in the bot and stay independent from dashboard alerts.</span>
        </div>
        <span class="telegram-settings-status" data-status="${escapeHtml(telegram.status)}">${escapeHtml(statusLabel(telegram.status))}</span>
      </div>
      ${renderMessages(telegram, pendingUrl)}
      ${renderDetails(telegram, identity, connected)}
      <div class="telegram-settings-actions">
        ${renderActions(telegram, connected, pendingUrl, botUrl)}
      </div>
    </div>
  `;
}

export function bindTelegramSettings(section: ParentNode, controller: AppController) {
  section.querySelector<HTMLButtonElement>('[data-action="create-telegram-link"]')
    ?.addEventListener('click', () => void controller.createTelegramLink());
  section.querySelector<HTMLButtonElement>('[data-action="refresh-telegram"]')
    ?.addEventListener('click', () => void controller.refreshTelegram());
  section.querySelector<HTMLButtonElement>('[data-action="disconnect-telegram"]')
    ?.addEventListener('click', () => {
      if (window.confirm('Disconnect Telegram and revoke pending links?')) {
        void controller.disconnectTelegram();
      }
    });
}
