import type { AppController } from '../../state/app-controller';
import { getTrackedToken, isProfileAuthPanel, type AppState, type ProfileAuthPanel } from '../../state/app-state';
import { loadCustomSoundAsset, saveCustomSoundAsset, type CustomSoundSlot } from '../../utils/sound-storage';
import {
  getAuthExtensionCounts,
  getAuthExtensionDefinitions,
  getAuthExtensionFields,
  getAuthSupportHeading,
  getAuthSurfaceMode,
} from './auth-extensions';
import { getAuthFeedbackKind, getAuthSupportCopy, shouldClearAuthFeedbackOnEdit } from './auth-feedback';
import {
  adjustCaretAfterEmailSanitize,
  clampLoginPasswordValue,
  LOGIN_EMAIL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_LENGTH,
  sanitizeLoginEmailValue,
} from './login-form-utils';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';
import { renderFlash } from './shared';

const SITE_LOGO_URL = new URL('../../../logofinal1.png', import.meta.url).href;
const INVITE_SECURITY_WARNING = 'NEVER share your information with anyone in DMs. The team will never ask for your details via DM. Reach out for help only through tickets in our official server.';
const REGISTER_TRANSIENT_NOTICES = new Set([
  'Creating account...',
  'Account created. Workspace synced.',
  'Account created. Check your inbox to verify your email.',
]);
const CHANGE_PASSWORD_TRANSIENT_NOTICES = new Set([
  'Changing password...',
  'Password changed. Please login again.',
]);
const PASSWORD_RESET_TRANSIENT_NOTICES = new Set([
  'Sending verification email...',
  'Sending password reset email...',
  'Set a new password to finish the reset.',
  'Resetting password...',
]);
const LOGIN_OTP_TRANSIENT_NOTICES = new Set([
  'Sending verification code...',
  'Verifying code...',
]);
const LOGIN_RELEVANT_NOTICES = new Set([
  'No saved session. Sign in to continue.',
  'Restoring session...',
  'Signing in...',
  'Login successful. Workspace synced.',
  'Session restored. Workspace synced.',
  'Email verified successfully',
  'Password reset successful. Please login again.',
]);

function isChangePasswordErrorMessage(message: string) {
  return message === 'Current password is required.'
    || message === 'New password is required.'
    || message === 'New password must be at least 8 characters.'
    || message === 'Please confirm the new password.'
    || message === 'The new passwords do not match. Please check them and try again.'
    || message === 'New password must be different from the current password.'
    || message === 'Current password is incorrect'
    || message.includes('Change-password failed')
    || message.includes('Internal server error')
    || message.includes('Unable to reach the server');
}

function isChangePasswordNoticeMessage(message: string) {
  return message === 'Changing password...'
    || message === 'Password changed. Please login again.'
    || message === 'Password changed successfully. Please login again with your new password.';
}

function bindFocusTrap(panel: HTMLElement | null) {
  if (!panel || panel.dataset.focusTrapBound === 'true') {
    return;
  }

  panel.dataset.focusTrapBound = 'true';
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') {
      return;
    }

    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => {
      if (element.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      if (element instanceof HTMLInputElement && element.type === 'hidden') {
        return false;
      }
      return element.offsetParent !== null;
    });

    if (focusables.length === 0) {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active ? focusables.indexOf(active) : -1;
    const lastIndex = focusables.length - 1;

    if (event.shiftKey) {
      if (currentIndex <= 0) {
        event.preventDefault();
        focusables[lastIndex]?.focus();
      }
      return;
    }

    if (currentIndex === -1 || currentIndex >= lastIndex) {
      event.preventDefault();
      focusables[0]?.focus();
    }
  });
}

const CONFIG_FIELDS: Array<{ key: string; label: string; type?: 'number' | 'text'; min?: number; placeholder?: string }> = [
  { key: 'threshold', label: 'Alert when 5m volume rises (%)', min: 1 },
  { key: 'mcap-threshold', label: 'Alert when MKT CAP rises (%) in 5m', min: 0, placeholder: '0 = disabled' },
  { key: 'min-vol', label: 'Min 5m volume to alert ($)', min: 0 },
  { key: 'min-mcap', label: 'Min market cap to alert ($)', min: 30000 },
  { key: 'max-mcap', label: 'Max market cap to alert ($)', min: 0, placeholder: '0 = no limit' },
  { key: 'meteora-alert-1h-threshold', label: 'Meteora pool alert 1h (%)', min: 0, placeholder: '0 = disabled' },
  { key: 'hvnc-min-vol', label: 'High Vol New Coin min total vol ($)', min: 0 },
];

const ALERT_TOGGLE_FIELDS = [
  { key: 'alert-vol-enabled', label: 'VOL' },
  { key: 'alert-mcap-enabled', label: 'MCAP' },
  { key: 'alert-hvnc-enabled', label: 'HIGH VOLUME NEW COIN' },
  { key: 'alert-old-surge-1h-enabled', label: 'SURGE 1H' },
  { key: 'alert-old-surge-6h-enabled', label: 'SURGE 6H' },
  { key: 'alert-meteora-surge-enabled', label: 'METEORA 1H' },
  { key: 'alert-pumpfun-vol-enabled', label: 'PUMPFUN VOL' },
  { key: 'alert-pumpfun-hvnc-enabled', label: 'PUMPFUN HVNC' },
] as const;

const SOUND_TOGGLE_FIELDS = [
  { key: 'sound-vol-enabled', label: 'VOL' },
  { key: 'sound-mcap-enabled', label: 'MCAP' },
  { key: 'sound-hvnc-enabled', label: 'HIGH VOLUME NEW COIN' },
  { key: 'sound-old-surge-1h-enabled', label: 'SURGE 1H' },
  { key: 'sound-old-surge-6h-enabled', label: 'SURGE 6H' },
  { key: 'sound-meteora-surge-enabled', label: 'METEORA 1H' },
  { key: 'sound-pumpfun-vol-enabled', label: 'PUMPFUN VOL' },
  { key: 'sound-pumpfun-hvnc-enabled', label: 'PUMPFUN HVNC' },
] as const;

export function renderLegacyShell(state: AppState, controller: AppController) {
  const wrapper = document.createElement('section');
  wrapper.className = 'legacy-shell';

  if (state.session.status === 'loading') {
    wrapper.append(renderLegacyBootstrap(state));
    return wrapper;
  }

  if (state.session.status === 'pre_access') {
    wrapper.append(renderPreAccessFlow(state, controller));
    return wrapper;
  }

  if (state.session.status !== 'authenticated') {
    wrapper.append(renderLegacyLogin(state, controller));
    return wrapper;
  }

  wrapper.append(renderLegacyActions(state, controller));

  return wrapper;
}

function renderLegacyBootstrap(state: AppState) {
  const section = document.createElement('section');
  const pathname = typeof window !== 'undefined' ? window.location.pathname || '/' : '/';
  const isPreAccessBootstrap = pathname === '/access' || pathname.startsWith('/access/');
  const eyebrow = isPreAccessBootstrap ? 'Access Setup' : 'Secure Session';
  const title = isPreAccessBootstrap ? 'Preparing Your Access Workspace' : 'Restoring Your Workspace';
  const copy = state.ui.notice
    || (isPreAccessBootstrap
      ? 'Checking your access session before opening the payment and onboarding flow.'
      : 'Checking your saved session before loading the workspace.');

  section.className = 'legacy-login-shell';
  section.innerHTML = `
    <div class="legacy-login-box legacy-bootstrap-box" data-auth-surface="bootstrap" aria-busy="true">
      ${renderLoginHeader()}
      <div class="legacy-bootstrap-copy">
        <span class="legacy-bootstrap-eyebrow">${escapeHtml(eyebrow)}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(copy)}</p>
        <div class="legacy-bootstrap-progress" aria-hidden="true">
          <span></span>
        </div>
      </div>
    </div>
  `;
  return section;
}

function renderPreAccessFlow(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const waiting = state.preAccess.awaitingConfirmation;
  const ready = state.session.accessHasProductAccess;
  const heroTitle = ready
    ? 'Access Confirmed. Enter The Bot.'
    : waiting
      ? 'Confirming Your Access'
      : 'Unlock The Full Alert Stack';
  const heroCopy = ready
    ? 'Your payment has been confirmed. Continue into the bot and start using the live alert workflow.'
    : waiting
      ? 'The payment already came back from checkout. We are waiting for backend confirmation before opening the workspace.'
      : 'Track live Solana volume spikes, monitor migration signals, keep your personal watchlists in sync, and review historical movement in one place.';

  section.className = 'legacy-login-shell legacy-pre-access-shell';
  section.innerHTML = `
    <div class="legacy-pre-access-landing">
      <div class="legacy-pre-access-topbar">
        <div class="legacy-pre-access-brand">
          <img class="workspace-brand-mark" src="${SITE_LOGO_URL}" alt="TrendScope logo" />
          <div class="legacy-pre-access-brand-copy">
            <strong>TrendScope</strong>
            <span>Volume Bot Access</span>
          </div>
        </div>
        <div class="legacy-pre-access-topbar-actions">
          ${ready ? `<button type="button" class="legacy-btn legacy-btn-primary" data-action="complete-pre-access" ${state.ui.busy ? 'disabled' : ''}>ENTER BOT</button>` : ''}
          <button type="button" class="legacy-userbar-link" data-action="logout-pre-access" ${state.ui.busy ? 'disabled' : ''}>LOGOUT</button>
        </div>
      </div>

      <div class="legacy-pre-access-hero-shell">
        <div class="legacy-pre-access-hero-panel">
          <div class="legacy-pre-access-hero-copy">
            <span class="legacy-pre-access-eyebrow">${ready ? 'Payment Confirmed' : waiting ? 'Payment Processing' : 'Premium Access Required'}</span>
            <h1>${escapeHtml(heroTitle)}</h1>
            <p>${escapeHtml(heroCopy)}</p>
            ${state.ui.error ? `<div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.ui.error)}</div>` : ''}
            ${state.ui.notice ? `<div class="legacy-auth-panel-note">${escapeHtml(state.ui.notice)}</div>` : ''}
            <div class="legacy-pre-access-hero-actions">
              ${ready ? `<button type="button" class="legacy-btn legacy-btn-primary" data-action="complete-pre-access" ${state.ui.busy ? 'disabled' : ''}>ENTER BOT</button>` : `
                <button type="button" class="legacy-btn legacy-btn-primary" data-action="focus-billing-plans">COMPARE PLANS</button>
              `}
              ${!ready ? `<button type="button" class="legacy-pre-access-secondary-btn" data-action="focus-benefits">WHAT YOU GET</button>` : ''}
            </div>
          </div>
          ${renderPreAccessIdentityCard(state)}
        </div>
      </div>

      <section class="legacy-pre-access-benefits" data-role="benefits-section">
        <div class="legacy-pre-access-section-head">
          <span class="legacy-pre-access-section-kicker">Inside The Bot</span>
          <h2>Why this access exists</h2>
          <p>The paid flow unlocks the live operational workspace instead of a generic dashboard. These are the pieces you are paying to use.</p>
        </div>
        <div class="legacy-pre-access-feature-grid">
          ${renderPreAccessFeatureTiles()}
        </div>
      </section>

      <section class="legacy-pre-access-plans-section">
        <div class="legacy-pre-access-section-head">
          <span class="legacy-pre-access-section-kicker">Choose Your Access</span>
          <h2>Pick the plan that fits your testing window</h2>
          <p>Shorter plans are better for validating workflow and alerts. Longer plans reduce renewal friction once the setup is already part of your routine.</p>
        </div>
        ${renderPreAccessPlansCard(state)}
      </section>

      <section class="legacy-pre-access-history-section">
        ${renderPreAccessOrdersCard(state)}
      </section>
    </div>
  `;

  section.querySelector<HTMLButtonElement>('[data-action="complete-pre-access"]')?.addEventListener('click', () => {
    void controller.completePreAccess();
  });
  section.querySelector<HTMLButtonElement>('[data-action="logout-pre-access"]')?.addEventListener('click', () => {
    void controller.logout();
  });
  section.querySelector<HTMLButtonElement>('[data-action="focus-billing-plans"]')?.addEventListener('click', () => {
    section.querySelector<HTMLElement>('[data-role="billing-plans-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  section.querySelector<HTMLButtonElement>('[data-action="focus-benefits"]')?.addEventListener('click', () => {
    section.querySelector<HTMLElement>('[data-role="benefits-section"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="start-pre-access-checkout"]').forEach((button) => {
    button.addEventListener('click', () => {
      const planKey = String(button.dataset.planKey || '').trim();
      if (!planKey) {
        return;
      }
      void controller.startPreAccessCheckout(planKey);
    });
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="resume-pre-access-checkout"]').forEach((button) => {
    button.addEventListener('click', () => {
      const checkoutUrl = String(button.dataset.checkoutUrl || '').trim();
      if (!checkoutUrl || typeof window === 'undefined') {
        return;
      }
      window.location.href = checkoutUrl;
    });
  });

  return section;
}

function renderPreAccessFeatureTiles() {
  const features = [
    {
      title: 'Real-Time Volume Alerts',
      body: 'Catch sudden market-cap and volume movement without manually scanning the market all day.',
    },
    {
      title: 'Historical Monitor View',
      body: 'Review monitored tokens, past movement, and follow-up behavior after the initial signal.',
    },
    {
      title: 'PumpFun Migration Signals',
      body: 'Track migration-related movement and keep the fast-moving meme flow inside the same workspace.',
    },
    {
      title: 'Personal Watchlists',
      body: 'Keep your own manual token set, blocklist, and workspace preferences attached to the account.',
    },
    {
      title: 'Meteora And Side Panels',
      body: 'Use auxiliary panels and richer token context instead of making decisions from a single raw alert.',
    },
    {
      title: 'Operational Workflow',
      body: 'The product is meant to be used as a working bot console, not just a passive feed of notifications.',
    },
  ];

  return features.map((feature, index) => `
    <article class="legacy-pre-access-feature-card">
      <span class="legacy-pre-access-feature-index">0${index + 1}</span>
      <strong>${escapeHtml(feature.title)}</strong>
      <p>${escapeHtml(feature.body)}</p>
    </article>
  `).join('');
}

function renderPreAccessIdentityCard(state: AppState) {
  const username = state.session.username || '-';
  const email = state.session.email || '-';
  const monogram = String(username || email || '?').trim().charAt(0).toUpperCase() || '?';
  const emailStatus = state.session.isEmailVerified ? 'Email verified' : 'Email pending';
  return `
    <aside class="legacy-pre-access-account-card">
      <div class="legacy-pre-access-account-head">
        <span class="legacy-pre-access-section-kicker">Account Target</span>
        <strong>Payment binds to this account</strong>
      </div>
      <div class="legacy-pre-access-identity-hero">
        <div class="legacy-pre-access-identity-avatar" aria-hidden="true">${escapeHtml(monogram)}</div>
        <div class="legacy-pre-access-identity-copy">
          <strong>${escapeHtml(username)}</strong>
          <span>${escapeHtml(email)}</span>
        </div>
        <div class="legacy-pre-access-identity-badges">
          <span class="legacy-pre-access-badge">${escapeHtml(emailStatus)}</span>
          <span class="legacy-pre-access-badge subtle">Access target</span>
        </div>
      </div>
      <div class="legacy-pre-access-identity-grid">
        <div class="legacy-pre-access-identity-item">
          <span>Username</span>
          <strong>${escapeHtml(username)}</strong>
        </div>
        <div class="legacy-pre-access-identity-item">
          <span>Email</span>
          <strong>${escapeHtml(email)}</strong>
        </div>
      </div>
    </aside>
  `;
}

export function renderWorkspaceHeader(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-topbar workspace-topbar';
  const isLiveWorkspace = state.ui.workspace === 'live';
  const isHistoryWorkspace = state.ui.workspace === 'history';
  section.innerHTML = `
    <div class="workspace-topbar-inner">
      <div class="workspace-brand">
        <img class="workspace-brand-mark" src="${SITE_LOGO_URL}" alt="TrendScope logo" />
        <div class="workspace-brand-copy">
          <strong class="workspace-brand-title">TrendScope</strong>
          <span class="workspace-brand-sub">Volume Bot Tracker</span>
        </div>
        <button type="button" class="legacy-btn btn-start workspace-monitor-btn ${state.runtime.mode === 'active' ? 'running' : ''}" data-action="toggle-monitoring">
          ${state.runtime.mode === 'active' ? '&#9632; Stop' : '&#9654; Start'}
        </button>
      </div>
      <div class="workspace-route-nav" aria-label="Workspace navigation">
        <button type="button" class="workspace-route-btn ${isLiveWorkspace ? 'active' : ''}" data-action="open-workspace-live">ALERTS</button>
        <button type="button" class="workspace-route-btn ${isHistoryWorkspace ? 'active' : ''}" data-action="open-workspace-history">MONITOR</button>
      </div>
      <div class="workspace-userbar">
        <div class="legacy-user-menu workspace-user-menu" data-user-menu>
          <button type="button" class="workspace-user-trigger" data-action="toggle-user-menu" aria-label="Open user menu">
            <span class="workspace-user-avatar" data-role="user-avatar"></span>
            <span class="workspace-user-meta">
              <span class="workspace-user-name" data-role="user-menu-label"></span>
              <span class="workspace-user-caption">Workspace</span>
            </span>
          </button>
          <div class="legacy-user-dropdown workspace-user-dropdown">
            <button type="button" class="legacy-user-dd-item" data-action="open-user-settings"><span class="workspace-menu-icon">👤</span><span>User Settings</span></button>
            <button type="button" class="legacy-user-dd-item" data-action="open-bot-settings"><span class="workspace-menu-icon workspace-menu-icon-gear">⚙</span><span>Bot Settings</span></button>
            <button type="button" class="legacy-user-dd-item" data-action="open-blocked-tokens"><span class="workspace-menu-icon workspace-menu-icon-danger">✖</span><span class="workspace-menu-label">Blocked Tokens</span></button>
            <button type="button" class="legacy-user-dd-item workspace-user-dd-item-danger" data-action="logout"><span class="workspace-menu-icon workspace-menu-icon-danger">⏻</span><span>Logout</span></button>
          </div>
        </div>
      </div>
    </div>
  `;

  const userMenuLabel = state.session.username ?? state.session.email ?? 'User';
  const avatarLabel = (state.session.username ?? state.session.email ?? 'U').trim().charAt(0).toUpperCase() || 'U';
  section.querySelector<HTMLElement>('[data-role="user-menu-label"]')!.textContent = userMenuLabel;
  section.querySelector<HTMLElement>('[data-role="user-avatar"]')!.textContent = avatarLabel;

  section.querySelector<HTMLButtonElement>('[data-action="toggle-monitoring"]')?.addEventListener('click', () => {
    if (state.runtime.mode === 'active') {
      controller.stopMonitoring();
      return;
    }
    controller.startMonitoring();
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-workspace-live"]')?.addEventListener('click', () => {
    controller.setWorkspace('live');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-workspace-history"]')?.addEventListener('click', () => {
    controller.setWorkspace('history');
  });
  section.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => void controller.logout());
  section.querySelector<HTMLButtonElement>('[data-action="open-user-settings"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.openAuthPanel('user-settings');
    section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-bot-settings"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.openAuthPanel('bot-settings');
    section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-blocked-tokens"]')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    controller.openAuthPanel('blocked-tokens');
    section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
  });
  section.querySelectorAll<HTMLButtonElement>('.legacy-user-dd-item:not([data-action="open-user-settings"]):not([data-action="open-bot-settings"]):not([data-action="open-blocked-tokens"]):not([data-action="logout"])').forEach((button) => {
    button.addEventListener('click', () => {
      section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
    });
  });

  return section;
}

export function renderWorkspaceProfileOverlay(state: AppState, controller: AppController) {
  if (!isProfileAuthPanel(state.ui.authPanel)) {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'workspace-profile-overlay-root';
  if (state.ui.authPanel === 'user-settings') {
    overlay.innerHTML = renderUserSettingsModal(state);
    bindUserSettingsPanel(overlay, controller);
    return overlay;
  }

  if (state.ui.authPanel === 'bot-settings') {
    overlay.innerHTML = renderBotSettingsModal(state);
    bindBotSettingsPanel(overlay, controller, state);
    return overlay;
  }

  if (state.ui.authPanel === 'blocked-tokens') {
    overlay.innerHTML = renderBlockedTokensModal(state);
    bindBlockedTokensPanel(overlay, controller);
    return overlay;
  }

  overlay.innerHTML = renderChangePasswordModal(state);
  bindChangePasswordPanel(overlay, controller, state);
  return overlay;
}

function renderProfileModalShell(options: {
  panel: ProfileAuthPanel;
  title: string;
  description: string;
  labelId: string;
  panelClass?: string;
  content: string;
}) {
  const panelClass = options.panelClass ? ` ${options.panelClass}` : '';
  return `
    <div class="legacy-auth-modal" data-auth-modal="${escapeHtml(options.panel)}" data-auth-modal-scope="profile">
      <div class="legacy-auth-modal-backdrop" data-action="close-profile-modal"></div>
      <div class="legacy-auth-panel${panelClass}" data-auth-panel="${escapeHtml(options.panel)}" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(options.labelId)}">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="${escapeHtml(options.labelId)}">${escapeHtml(options.title)}</strong>
            <span>${escapeHtml(options.description)}</span>
          </div>
          <button type="button" class="legacy-profile-modal-close" data-action="close-profile-modal" aria-label="Close dialog">X</button>
        </div>
        ${options.content}
      </div>
    </div>
  `;
}

function renderLegacyLogin(state: AppState, controller: AppController) {
  const authError = state.ui.error ?? '';
  const authFeedbackMessage = state.ui.error ?? state.ui.notice ?? '';
  const authFeedbackKind = authFeedbackMessage ? getAuthFeedbackKind(state, authFeedbackMessage) : 'idle';
  const authSurfaceMode = getAuthSurfaceMode(state);
  const hasCredentialError = authFeedbackKind === 'credentials';
  const hasValidationError = authFeedbackKind === 'validation';
  const hasAuthError = Boolean(state.ui.error);
  const section = document.createElement('section');
  const showInlineRegisterFeedback = state.ui.authPanel === 'register';
  const loginFlash = renderLoginFlash(state);
  section.className = 'legacy-login-shell';
  section.innerHTML = `
    <div class="legacy-login-box" data-auth-surface="login" data-auth-kind="${authFeedbackKind}" data-auth-mode="${authSurfaceMode}" aria-busy="${state.ui.busy ? 'true' : 'false'}">
      ${renderLoginHeader()}
      <div class="legacy-login-feedback" data-auth-slot="feedback" id="login-auth-feedback">${showInlineRegisterFeedback ? '' : loginFlash}</div>
      ${renderLoginForm(state, { hasCredentialError, hasValidationError, hasAuthError })}
      <div class="legacy-login-support" data-auth-slot="support" data-auth-kind="${authFeedbackKind}">
        ${renderLoginSupport(authFeedbackKind)}
        ${renderLoginExtensionRegion()}
      </div>
    </div>
    ${state.ui.authPanel === 'register' ? renderRegisterModal(state) : ''}
    ${state.ui.authPanel === 'email-verification' ? renderEmailVerificationModal(state) : ''}
    ${state.ui.authPanel === 'email-verified-success' ? renderEmailVerifiedSuccessModal() : ''}
    ${state.ui.authPanel === 'password-change-success' ? renderPasswordChangeSuccessModal() : ''}
    ${state.ui.authPanel === 'invite-assistance' ? renderInviteAssistanceModal(state) : ''}
    ${state.ui.authPanel === 'password-reset' ? renderPasswordResetModal(state) : ''}
    ${state.ui.authPanel === 'email-otp' ? renderEmailOtpModal(state) : ''}
  `;
  hydrateAuthSensitiveText(section, state);

  const form = section.querySelector<HTMLFormElement>('form[data-role="login-form"]');
  const submitLoginForm = () => {
    if (!form || controller.state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    syncImmediateLoginBusyState(form);
    void controller.login(String(data.get('email') || '').trim(), String(data.get('password') || ''));
  };
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitLoginForm();
  });

  form?.querySelector<HTMLButtonElement>('[data-action="toggle-password-visibility"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]');
    if (!passwordInput) {
      return;
    }

    const selectionStart = passwordInput.selectionStart;
    const selectionEnd = passwordInput.selectionEnd;
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    passwordInput.focus();
    if (selectionStart !== null && selectionEnd !== null) {
      window.requestAnimationFrame(() => {
        passwordInput.focus();
        passwordInput.setSelectionRange(selectionStart, selectionEnd);
      });
    }
  });
  form?.querySelector<HTMLButtonElement>('[data-action="toggle-password-visibility"]')?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  const passwordInput = form?.querySelector<HTMLInputElement>('input[name="password"]');
  const emailInput = form?.querySelector<HTMLInputElement>('input[name="email"]');
  const capsLockHint = form?.querySelector<HTMLElement>('#login-capslock');
  const sanitizeEmailInput = () => {
    if (!emailInput) {
      return;
    }
    const rawValue = emailInput.value;
    const nextValue = sanitizeLoginEmailValue(rawValue);
    if (nextValue === rawValue) {
      return;
    }
    const caret = emailInput.selectionStart;
    emailInput.value = nextValue;
    const nextCaret = adjustCaretAfterEmailSanitize(rawValue, caret);
    emailInput.setSelectionRange(nextCaret, nextCaret);
  };
  const clampPasswordInput = () => {
    if (!passwordInput) {
      return;
    }
    const nextValue = clampLoginPasswordValue(passwordInput.value);
    if (nextValue !== passwordInput.value) {
      const caret = Math.min(passwordInput.selectionStart ?? nextValue.length, nextValue.length);
      passwordInput.value = nextValue;
      passwordInput.setSelectionRange(caret, caret);
    }
  };
  const syncCapsLock = (event: KeyboardEvent) => {
    if (!capsLockHint) {
      return;
    }
    capsLockHint.textContent = event.getModifierState('CapsLock') ? 'Caps Lock is on' : '';
  };
  passwordInput?.addEventListener('keydown', syncCapsLock);
  passwordInput?.addEventListener('keyup', syncCapsLock);
  passwordInput?.addEventListener('blur', () => {
    if (capsLockHint) {
      capsLockHint.textContent = '';
    }
  });
  passwordInput?.addEventListener('focus', (event) => {
    const keyboardEvent = event as FocusEvent & { getModifierState?: (key: string) => boolean };
    if (capsLockHint && keyboardEvent.getModifierState?.('CapsLock')) {
      capsLockHint.textContent = 'Caps Lock is on';
    }
  });

  const clearErrorOnEdit = () => {
    if (shouldClearAuthFeedbackOnEdit(state.ui.error, state.ui.notice)) {
      controller.clearNotice();
    }
  };
  const submitOnEnter = (event: KeyboardEvent) => {
    const isSubmitKey = event.key === 'Enter'
      || event.key === 'Return'
      || event.code === 'Enter'
      || event.code === 'NumpadEnter'
      || event.keyCode === 13;
    if (!isSubmitKey || event.shiftKey || event.isComposing || controller.state.ui.busy) {
      return;
    }
    event.preventDefault();
    submitLoginForm();
  };
  emailInput?.addEventListener('input', clearErrorOnEdit);
  passwordInput?.addEventListener('input', clearErrorOnEdit);
  passwordInput?.addEventListener('input', clampPasswordInput);
  form?.addEventListener('keydown', submitOnEnter);
  emailInput?.addEventListener('paste', () => {
    window.requestAnimationFrame(() => {
      sanitizeEmailInput();
    });
  });
  emailInput?.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
    }
  });
  emailInput?.addEventListener('blur', () => {
    sanitizeEmailInput();
  });
  emailInput?.addEventListener('input', sanitizeEmailInput);

  section.querySelector<HTMLButtonElement>('[data-action="dismiss-flash"]')?.addEventListener('click', () => {
    if (state.ui.error) controller.clearError();
    else controller.clearNotice();
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-register-panel"]')?.addEventListener('click', () => {
    controller.openAuthPanel('register');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-email-verification-panel"]')?.addEventListener('click', () => {
    controller.openAuthPanel('email-verification');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-invite-assistance-panel"]')?.addEventListener('click', () => {
    controller.openAuthPanel('invite-assistance');
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-password-reset-panel"]')?.addEventListener('click', () => {
    controller.openAuthPanel('password-reset');
  });
  bindRegisterPanel(section, controller, state);
  bindEmailVerificationPanel(section, controller, state);
  bindEmailOtpPanel(section, controller, state);
  bindEmailVerifiedSuccessPanel(section, controller);
  bindPasswordChangeSuccessPanel(section, controller);
  bindInviteAssistancePanel(section, controller, state);
  bindPasswordResetPanel(section, controller, state);
  return section;
}

function setTextContentIfPresent(root: ParentNode, selector: string, value: string) {
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.textContent = value;
  });
}

function hydrateAuthSensitiveText(section: HTMLElement, state: AppState) {
  setTextContentIfPresent(section, '[data-auth-text="pending-verification-email"]', state.ui.pendingVerificationEmail || '');
  setTextContentIfPresent(section, '[data-auth-text="pending-login-otp-email"]', state.ui.pendingLoginOtpEmailHint || '');
}

function renderLoginFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isLoginError = (
    message === 'Email is required.'
    || message === 'Enter a valid email address.'
    || message === 'Password is required.'
    || message === 'Incorrect email or password. Check your credentials and try again.'
    || message.includes('Incorrect email or password')
    || message.includes('temporarily locked')
    || message.includes('deactivated')
    || message.includes('not verified')
    || message.includes('saved session is no longer valid')
    || message.includes('Unable to reach the server')
    || message.includes('You are using the old password')
  );

  const isLoginNotice = LOGIN_RELEVANT_NOTICES.has(message);
  if (!isLoginError && !isLoginNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isLoginError ? state.ui.error : null,
      notice: isLoginNotice ? state.ui.notice : null,
    },
  });
}

function syncImmediateLoginBusyState(form: HTMLFormElement) {
  form.dataset.busy = 'true';

  for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
    field.disabled = true;
  }

  const submitCopy = form.querySelector<HTMLElement>('.legacy-login-submit-copy');
  if (submitCopy) {
    submitCopy.textContent = 'SIGNING IN...';
  }

  const submitButton = form.querySelector<HTMLElement>('.legacy-login-submit');
  if (submitButton) {
    submitButton.classList.add('is-busy');
  }
}

function renderLoginHeader() {
  return `
    <div class="legacy-login-head" data-auth-slot="header">
      <div class="legacy-login-brand-block">
        <span class="legacy-login-logo" aria-hidden="true">
          <img src="${SITE_LOGO_URL}" alt="" />
        </span>
        <div class="legacy-login-brand-copy">
          <h2 class="legacy-login-title"><span class="legacy-login-brand">TrendScope</span></h2>
          <div class="legacy-login-product">Volume Bot Tracker</div>
          <div class="legacy-login-sub">Solana Real-time Monitor</div>
        </div>
      </div>
    </div>
  `;
}

function renderLoginForm(state: AppState, options: { hasCredentialError: boolean; hasValidationError: boolean; hasAuthError: boolean }) {
  const { hasCredentialError, hasValidationError, hasAuthError } = options;
  const emailFieldClass = hasCredentialError || state.ui.error === 'Email is required.' || state.ui.error === 'Enter a valid email address.'
    ? `field-error ${hasValidationError && !hasCredentialError ? 'field-error-soft' : ''}`.trim()
    : '';
  const passwordFieldClass = hasCredentialError || state.ui.error === 'Password is required.'
    ? `field-error ${hasValidationError && !hasCredentialError ? 'field-error-soft' : ''}`.trim()
    : '';
  const isRestoring = state.ui.busy && state.session.status === 'loading';
  const submitLabel = isRestoring ? 'RESTORING SESSION...' : state.ui.busy ? 'SIGNING IN...' : 'LOGIN';
  return `
    <form class="legacy-login-form" data-role="login-form" data-auth-slot="form" data-busy="${state.ui.busy ? 'true' : 'false'}" aria-busy="${state.ui.busy ? 'true' : 'false'}" novalidate>
      <label for="login-email">Email</label>
      <input id="login-email" class="${emailFieldClass}" name="email" type="email" inputmode="email" enterkeyhint="next" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" placeholder="testeuser5@example.com" autocomplete="username" required aria-invalid="${hasAuthError ? 'true' : 'false'}" aria-describedby="login-help login-auth-feedback" ${state.ui.busy ? 'disabled' : ''} />
      <label for="login-password">Password</label>
      <div class="legacy-password-wrap">
        <input id="login-password" class="${passwordFieldClass}" name="password" type="password" enterkeyhint="go" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" placeholder="SenhaForte123!" autocomplete="current-password" required aria-invalid="${hasAuthError ? 'true' : 'false'}" aria-describedby="login-help login-capslock login-auth-feedback" ${state.ui.busy ? 'disabled' : ''} />
        <button type="button" class="legacy-password-toggle" data-action="toggle-password-visibility" aria-controls="login-password" aria-label="Show password" ${state.ui.busy ? 'disabled' : ''}>Show</button>
      </div>
      <div class="legacy-login-capslock" id="login-capslock" aria-live="polite"></div>
      <div class="legacy-login-inline-actions">
        <button type="button" class="legacy-login-inline-action" data-action="open-register-panel" ${state.ui.busy ? 'disabled' : ''}>Create Account</button>
        <span class="legacy-login-inline-separator" aria-hidden="true">|</span>
        <button type="button" class="legacy-login-inline-action" data-action="open-password-reset-panel" ${state.ui.busy ? 'disabled' : ''}>Forgot Password</button>
      </div>
      <div class="legacy-login-help" id="login-help">Secure sign-in restores your TrendScope workspace and monitoring preferences.</div>
      <button type="submit" class="legacy-btn legacy-btn-primary legacy-login-submit ${state.ui.busy ? 'is-busy' : ''}" ${state.ui.busy ? 'disabled' : ''}>
        <span class="legacy-login-submit-copy">${submitLabel}</span>
      </button>
    </form>
  `;
}

function renderLoginSupport(authFeedbackKind: ReturnType<typeof getAuthFeedbackKind> | 'idle') {
  const supportKind = authFeedbackKind === 'idle' ? 'notice' : authFeedbackKind;
  const supportHeading = escapeHtml(getAuthSupportHeading(authFeedbackKind));
  const supportCopy = escapeHtml(getAuthSupportCopy(authFeedbackKind === 'idle' ? 'notice' : authFeedbackKind));
  if (authFeedbackKind === 'idle') {
    return `
      <div class="legacy-login-recovery">
        <div class="legacy-login-recovery-tag">${supportHeading}</div>
        <div class="legacy-login-recovery-copy">${supportCopy}</div>
        <div class="legacy-login-support-actions">
          <button type="button" class="legacy-login-support-action" data-action="open-invite-assistance-panel">Access help</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="legacy-login-recovery" data-auth-support-kind="${supportKind}">
      <div class="legacy-login-recovery-tag">${supportHeading}</div>
      <div class="legacy-login-recovery-copy">${supportCopy}</div>
      <div class="legacy-login-support-actions">
        <button type="button" class="legacy-login-support-action" data-action="open-invite-assistance-panel">Access help</button>
      </div>
    </div>
  `;
}

function renderRegisterFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isRegisterError = (
    message === 'Username is required.'
    || message === 'Username must be at least 3 characters.'
    || message === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || message === 'Username already taken'
    || message === 'Email is required.'
    || message === 'Enter a valid email address.'
    || message === 'Email already registered'
    || message === 'Invalid email format'
    || message === 'Password is required.'
    || message === 'Password must be at least 8 characters.'
    || message === 'Password must be 8-128 characters.'
    || message === 'Please confirm your password.'
    || message === 'The passwords do not match. Please check them and try again.'
    || message === 'Invite code is required.'
    || message.includes('Invite')
    || message.includes('invite')
    || message.includes('registered')
    || message.includes('Internal server error')
    || message.includes('Unable to reach the server')
  );

  const isRegisterNotice = REGISTER_TRANSIENT_NOTICES.has(message);
  if (!isRegisterError && !isRegisterNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isRegisterError ? state.ui.error : null,
      notice: isRegisterNotice ? state.ui.notice : null,
    },
  });
}

function renderChangePasswordFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isChangePasswordError = isChangePasswordErrorMessage(message);
  const isChangePasswordNotice = isChangePasswordNoticeMessage(message);

  if (!isChangePasswordError && !isChangePasswordNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isChangePasswordError ? state.ui.error : null,
      notice: isChangePasswordNotice ? state.ui.notice : null,
    },
  });
}

function renderPasswordResetFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isPasswordResetError = (
    message === 'Email is required.'
    || message === 'Enter a valid email address.'
    || message === 'Reset link is missing or invalid.'
    || message === 'New password is required.'
    || message === 'New password must be at least 8 characters.'
    || message === 'New password must be 8-128 characters.'
    || message === 'Please confirm the new password.'
    || message === 'The new passwords do not match. Please check them and try again.'
    || message.includes('Reset token is invalid or expired')
    || message.includes('Reset token is invalid or already used')
    || message.includes('Password reset request failed')
    || message.includes('Password reset failed')
    || message.includes('not verified')
    || message.includes('verification email could not be sent')
    || message.includes('Internal server error')
    || message.includes('Unable to reach the server')
  );

  const isPasswordResetNotice = PASSWORD_RESET_TRANSIENT_NOTICES.has(message)
    || message.includes('password reset link has been sent')
    || message.includes('verification link has been sent')
    || message.includes('Check your inbox to verify your email')
    || message.includes('Password reset successful');

  if (!isPasswordResetError && !isPasswordResetNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isPasswordResetError ? state.ui.error : null,
      notice: isPasswordResetNotice ? state.ui.notice : null,
    },
  });
}

function renderLoginOtpFlash(state: AppState) {
  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isLoginOtpError = (
    message === 'Verification challenge is missing. Please sign in again.'
    || message === 'Verification code is required.'
    || message === 'Enter the 6-digit verification code.'
    || message.includes('Verification code is incorrect')
    || message.includes('Verification code is invalid or expired')
    || message.includes('Too many invalid verification attempts')
    || message.includes('Unable to reach the server')
    || message.includes('Internal server error')
  );

  const isLoginOtpNotice = LOGIN_OTP_TRANSIENT_NOTICES.has(message)
    || message.includes('Verification code sent')
    || message.includes('A new verification code has been sent');

  if (!isLoginOtpError && !isLoginOtpNotice) {
    return '';
  }

  return renderFlash({
    ...state,
    ui: {
      ...state.ui,
      error: isLoginOtpError ? state.ui.error : null,
      notice: isLoginOtpNotice ? state.ui.notice : null,
    },
  });
}

function renderDashboardFlash(state: AppState) {
  if (state.ui.authPanel === 'change-password') {
    return '';
  }

  const message = state.ui.error ?? state.ui.notice ?? '';
  if (!message) {
    return '';
  }

  const isLoginOnlyMessage = LOGIN_RELEVANT_NOTICES.has(message)
    || message === 'Incorrect email or password. Check your credentials and try again.'
    || message === 'Email is required.'
    || message === 'Enter a valid email address.'
    || message === 'Password is required.'
    || message.includes('old password changed on');
  const isRegisterOnlyMessage = (
    message === 'Username is required.'
    || message === 'Username must be at least 3 characters.'
    || message === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || message === 'Username already taken'
    || message === 'Email already registered'
    || message === 'Invalid email format'
    || message === 'Password must be 8-128 characters.'
    || message === 'Please confirm your password.'
    || message === 'The passwords do not match. Please check them and try again.'
    || message === 'Invite code is required.'
    || REGISTER_TRANSIENT_NOTICES.has(message)
    || message.includes('Invite')
    || message.includes('invite')
    || message.includes('registered')
  );
  const isChangePasswordOnlyMessage = (
    isChangePasswordErrorMessage(message)
    || isChangePasswordNoticeMessage(message)
    || CHANGE_PASSWORD_TRANSIENT_NOTICES.has(message)
  );

  if (isLoginOnlyMessage || isRegisterOnlyMessage || isChangePasswordOnlyMessage) {
    return '';
  }

  return renderFlash(state);
}

function renderRegisterModal(state: AppState) {
  const usernameError = state.ui.error === 'Username is required.'
    || state.ui.error === 'Username must be at least 3 characters.'
    || state.ui.error === 'Username must be 3-32 characters and use only letters, numbers, or underscores.'
    || state.ui.error === 'Username already taken';
  const emailError = state.ui.error === 'Email is required.'
    || state.ui.error === 'Enter a valid email address.'
    || state.ui.error === 'Email already registered'
    || state.ui.error === 'Invalid email format';
  const passwordError = state.ui.error === 'Password is required.'
    || state.ui.error === 'Password must be at least 8 characters.'
    || state.ui.error === 'Password must be 8-128 characters.'
    || state.ui.error === 'Please confirm your password.'
    || state.ui.error === 'The passwords do not match. Please check them and try again.';
  const inviteError = state.ui.error === 'Invite code is required.'
    || state.ui.error?.includes('Invite')
    || state.ui.error?.includes('invite');

  return `
    <div class="legacy-auth-modal" data-auth-modal="register">
      <div class="legacy-auth-modal-backdrop" data-action="close-register-panel"></div>
      <div class="legacy-auth-panel" data-auth-panel="register" role="dialog" aria-modal="true" aria-labelledby="register-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="register-title">Create Account</strong>
            <span>Use a valid invite code to create your TrendScope account and load your workspace.</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-register-panel">Close</button>
        </div>
        <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderRegisterFlash(state)}</div>
        <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="register-form" novalidate>
          <label>
            <span>Username</span>
            <input name="username" type="text" maxlength="32" autocomplete="username" autocapitalize="none" spellcheck="false" class="${usernameError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <label>
            <span>Email</span>
            <input name="registerEmail" type="email" inputmode="email" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" class="${emailError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <label>
            <span>Password</span>
            <div class="legacy-password-wrap">
              <input name="registerPassword" type="password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" class="${passwordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
              <button type="button" class="legacy-password-toggle" data-action="toggle-register-password-visibility" ${state.ui.busy ? 'disabled' : ''}>Show</button>
            </div>
          </label>
          <label>
            <span>Confirm password</span>
            <div class="legacy-password-wrap">
              <input name="registerConfirmPassword" type="password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" class="${passwordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
              <button type="button" class="legacy-password-toggle" data-action="toggle-register-confirm-password-visibility" ${state.ui.busy ? 'disabled' : ''}>Show</button>
            </div>
          </label>
          <label>
            <span>Invite code</span>
            <input name="inviteCode" type="text" maxlength="64" autocapitalize="characters" spellcheck="false" class="${inviteError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <div class="legacy-auth-panel-note" data-role="register-invite-status">Invite code is required for account creation.</div>
          <div class="legacy-auth-panel-actions">
            <button type="button" class="legacy-userbar-link" data-action="close-register-panel" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
            <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'CREATING...' : 'CREATE ACCOUNT'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderEmailVerificationModal(state: AppState) {
  const isPostRegisterNotice = Boolean(
    state.ui.pendingVerificationEmail
    && (
      state.ui.notice?.includes('Account created')
      || state.ui.error?.includes('verification email could not be sent')
    )
  );
  const emailSendFailed = Boolean(state.ui.error?.includes('verification email could not be sent'));
  const hasLocalDevLink = Boolean(state.ui.notice?.includes('Local dev link:'));
  const emailError = state.ui.error === 'Email is required.'
    || state.ui.error === 'Enter a valid email address.';
  return `
    <div class="legacy-auth-modal" data-auth-modal="email-verification">
      <div class="legacy-auth-modal-backdrop" data-action="close-email-verification-panel"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="email-verification" role="dialog" aria-modal="true" aria-labelledby="email-verification-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="email-verification-title">${isPostRegisterNotice ? 'Check Your Email' : 'Verify Email'}</strong>
            <span>${isPostRegisterNotice ? 'We sent a verification link to your registered email. Verify the account before using the bot.' : 'Request a fresh verification link for your account email.'}</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-email-verification-panel">Close</button>
        </div>
        <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderPasswordResetFlash(state)}</div>
        ${isPostRegisterNotice ? `
          <div class="legacy-assistance-grid">
            <div class="legacy-assistance-card">
              <div class="legacy-assistance-card-title">${emailSendFailed ? 'DELIVERY ISSUE' : 'VERIFICATION SENT'}</div>
              <div class="legacy-assistance-card-copy">${emailSendFailed
                ? 'We could not send a confirmation email to '
                : 'We sent a confirmation email to '
              }<strong data-auth-text="pending-verification-email"></strong>${emailSendFailed ? ' just yet.' : '.'}</div>
            </div>
            <div class="legacy-assistance-card">
              <div class="legacy-assistance-card-title">NEXT STEP</div>
              <div class="legacy-assistance-card-copy">${hasLocalDevLink
                ? 'Use the local dev verification link shown above to confirm your address on localhost.'
                : emailSendFailed
                  ? 'Try sending the verification link again after fixing email delivery.'
                  : 'Open the email and confirm your address before trying to log in to the bot.'
              }</div>
            </div>
          </div>
        ` : `
          <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="email-verification-form" novalidate>
            <label>
              <span>Account email</span>
              <input name="verificationEmail" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" class="${emailError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
            </label>
            <div class="legacy-auth-panel-actions">
              <button type="button" class="legacy-userbar-link" data-action="close-email-verification-panel" ${state.ui.busy ? 'disabled' : ''}>Close</button>
              <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'SENDING...' : 'SEND VERIFICATION LINK'}</button>
            </div>
          </form>
        `}
      </div>
    </div>
  `;
}

function renderPasswordChangeSuccessModal() {
  return `
    <div class="legacy-auth-modal" data-auth-modal="password-change-success">
      <div class="legacy-auth-modal-backdrop" data-action="close-password-change-success"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="password-change-success" role="dialog" aria-modal="true" aria-labelledby="password-change-success-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="password-change-success-title">Password Changed</strong>
            <span>Your password was updated successfully.</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-password-change-success">Close</button>
        </div>
        <div class="legacy-assistance-grid">
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">LOGIN REQUIRED</div>
            <div class="legacy-assistance-card-copy">Sign in again using your new password to continue using the bot.</div>
          </div>
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">SECURITY NOTICE</div>
            <div class="legacy-assistance-card-copy">We also sent an email confirmation about this password change.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderEmailVerifiedSuccessModal() {
  return `
    <div class="legacy-auth-modal" data-auth-modal="email-verified-success">
      <div class="legacy-auth-modal-backdrop" data-action="close-email-verified-success"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="email-verified-success" role="dialog" aria-modal="true" aria-labelledby="email-verified-success-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="email-verified-success-title">Email Verified</strong>
            <span>Your email was verified successfully.</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-email-verified-success">Close</button>
        </div>
        <div class="legacy-assistance-grid">
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">SUCCESS</div>
            <div class="legacy-assistance-card-copy">Your account is ready. You can now sign in normally on the front page.</div>
          </div>
        </div>
        <div class="legacy-auth-panel-actions">
          <button type="button" class="legacy-btn legacy-btn-primary" data-action="close-email-verified-success">GO TO LOGIN</button>
        </div>
      </div>
    </div>
  `;
}

function renderInviteAssistanceModal(_state: AppState) {
  return `
    <div class="legacy-auth-modal" data-auth-modal="invite-assistance">
      <div class="legacy-auth-modal-backdrop" data-action="close-invite-assistance-panel"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="invite-assistance" role="dialog" aria-modal="true" aria-labelledby="invite-assistance-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="invite-assistance-title">Access Help</strong>
            <span>Validate an invite code and check what to do if access is blocked, expired, or missing.</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-invite-assistance-panel">Close</button>
        </div>
        <div class="legacy-assistance-grid">
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">Need a new invite?</div>
            <div class="legacy-assistance-card-copy">Ask an administrator for a fresh invite if your code expired, was revoked, or reached max uses.</div>
          </div>
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">Account blocked?</div>
            <div class="legacy-assistance-card-copy">If the account is deactivated or locked out for too long, contact an administrator to review access.</div>
          </div>
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">Before contacting support</div>
            <div class="legacy-assistance-card-copy">Keep your email and invite code ready. That gives the admin enough context to resolve access faster.</div>
          </div>
        </div>
        <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="invite-assistance-form" novalidate>
          <label>
            <span>Invite code</span>
            <input name="assistanceInviteCode" type="text" maxlength="64" autocapitalize="characters" spellcheck="false" />
          </label>
          <div class="legacy-auth-panel-note" data-role="invite-assistance-status">
            Paste an invite code to check whether it is still valid.
          </div>
          <div class="legacy-auth-panel-note legacy-auth-panel-note-secondary" data-role="invite-assistance-summary">
            ${INVITE_SECURITY_WARNING}
          </div>
          <div class="legacy-auth-panel-actions">
            <button type="button" class="legacy-userbar-link" data-action="close-invite-assistance-panel">Close</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderPasswordResetModal(state: AppState) {
  const hasResetToken = Boolean(state.ui.pendingPasswordResetToken);
  const emailError = state.ui.error === 'Email is required.'
    || state.ui.error === 'Enter a valid email address.';
  const passwordError = state.ui.error === 'New password is required.'
    || state.ui.error === 'New password must be at least 8 characters.'
    || state.ui.error === 'New password must be 8-128 characters.'
    || state.ui.error === 'Please confirm the new password.'
    || state.ui.error === 'The new passwords do not match. Please check them and try again.'
    || state.ui.error === 'Reset link is missing or invalid.'
    || state.ui.error?.includes('Reset token');
  return `
    <div class="legacy-auth-modal" data-auth-modal="password-reset">
      <div class="legacy-auth-modal-backdrop"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="password-reset" role="dialog" aria-modal="true" aria-labelledby="password-reset-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="password-reset-title">Forgot Password</strong>
            <span>${hasResetToken ? 'Choose a new password to finish your reset.' : 'Request a reset link for your verified account email.'}</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-password-reset-panel">Close</button>
        </div>
        <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderPasswordResetFlash(state)}</div>
        <div class="legacy-assistance-grid">
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">${hasResetToken ? 'RESET READY' : 'VERIFIED EMAIL ONLY'}</div>
            <div class="legacy-assistance-card-copy">${hasResetToken ? 'This reset link is single-use and should be used immediately. After success, old sessions are revoked.' : 'Reset email is sent only for active, verified accounts. If the address exists and is eligible, the response stays generic.'}</div>
          </div>
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">${hasResetToken ? 'PASSWORD RULES' : 'WHAT TO EXPECT'}</div>
            <div class="legacy-assistance-card-copy">${hasResetToken ? 'Use a fresh password with at least 8 characters. You will need to sign in again after the reset.' : 'Check your inbox for the reset email. If nothing arrives, verify the address first or try again later.'}</div>
          </div>
        </div>
        <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="password-reset-form" novalidate>
          ${hasResetToken ? `
            <label>
              <span>New password</span>
              <div class="legacy-password-wrap">
                <input name="resetNewPassword" type="password" autocomplete="new-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${passwordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
                <button type="button" class="legacy-password-toggle" data-action="toggle-reset-password-visibility" ${state.ui.busy ? 'disabled' : ''}>Show</button>
              </div>
            </label>
            <label>
              <span>Confirm new password</span>
              <div class="legacy-password-wrap">
                <input name="resetConfirmNewPassword" type="password" autocomplete="new-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${passwordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
                <button type="button" class="legacy-password-toggle" data-action="toggle-reset-confirm-password-visibility" ${state.ui.busy ? 'disabled' : ''}>Show</button>
              </div>
            </label>
          ` : `
            <label>
              <span>Account email</span>
              <input name="resetEmail" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${LOGIN_EMAIL_MAX_LENGTH}" class="${emailError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
            </label>
          `}
          <div class="legacy-auth-panel-actions">
            <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${hasResetToken ? (state.ui.busy ? 'RESETTING...' : 'RESET PASSWORD') : (state.ui.busy ? 'SENDING...' : 'SEND RESET LINK')}</button>
          </div>
        </form>
        <div class="legacy-auth-panel-note legacy-auth-panel-note-secondary">
          ${INVITE_SECURITY_WARNING}
        </div>
      </div>
    </div>
  `;
}

function renderEmailOtpModal(state: AppState) {
  const codeError = state.ui.error === 'Verification code is required.'
    || state.ui.error === 'Enter the 6-digit verification code.'
    || state.ui.error?.includes('Verification code is incorrect')
    || state.ui.error?.includes('Verification code is invalid or expired')
    || state.ui.error?.includes('Too many invalid verification attempts')
    || state.ui.error === 'Verification challenge is missing. Please sign in again.';

  return `
    <div class="legacy-auth-modal" data-auth-modal="email-otp">
      <div class="legacy-auth-modal-backdrop" data-action="close-email-otp-panel"></div>
      <div class="legacy-auth-panel legacy-auth-panel-assistance" data-auth-panel="email-otp" role="dialog" aria-modal="true" aria-labelledby="email-otp-title">
        <div class="legacy-auth-panel-head">
          <div>
            <strong id="email-otp-title">Check Your Email</strong>
            <span>Enter the 6-digit verification code to finish signing in.</span>
          </div>
          <button type="button" class="legacy-userbar-link" data-action="close-email-otp-panel">Close</button>
        </div>
        <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderLoginOtpFlash(state)}</div>
        <div class="legacy-assistance-grid">
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">CODE SENT</div>
            <div class="legacy-assistance-card-copy">We sent a verification code to <strong data-auth-text="pending-login-otp-email"></strong>.</div>
          </div>
          <div class="legacy-assistance-card">
            <div class="legacy-assistance-card-title">NEXT STEP</div>
            <div class="legacy-assistance-card-copy">Enter the code below. The sign-in only finishes after this secondary verification.</div>
          </div>
        </div>
        <form class="legacy-auth-panel-form legacy-auth-panel-form-register" data-role="email-otp-form" novalidate>
          <label>
            <span>Verification code</span>
            <input name="emailOtpCode" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="6" class="${codeError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
          </label>
          <div class="legacy-auth-panel-actions">
            <button type="button" class="legacy-userbar-link" data-action="resend-email-otp" ${state.ui.busy ? 'disabled' : ''}>Resend Code</button>
            <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'VERIFYING...' : 'VERIFY CODE'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderLoginExtensionRegion() {
  const extensionDefs = getAuthExtensionDefinitions();
  const extensionCounts = getAuthExtensionCounts();
  return `
    <div
      class="legacy-login-extension-region"
      data-auth-slot="extensions"
      data-auth-extension-count="${extensionCounts.total}"
      data-auth-extension-enabled-count="${extensionCounts.enabled}"
      data-auth-extension-backend-ready-count="${extensionCounts.backendReady}"
      data-auth-extension-ui-ready-count="${extensionCounts.uiReady}"
      hidden
      aria-hidden="true"
    >
      ${extensionDefs.map((item) => `
        <div
          class="legacy-login-extension-item"
          data-auth-extension="${escapeHtml(item.key)}"
          data-auth-extension-enabled="${item.enabled ? 'true' : 'false'}"
          data-auth-extension-backend-ready="${item.backendReady ? 'true' : 'false'}"
          data-auth-extension-ui-ready="${item.uiReady ? 'true' : 'false'}"
          data-auth-extension-route="${escapeHtml(item.route ?? '')}"
          data-auth-extension-priority="${escapeHtml(item.priority)}"
        >
          <span class="legacy-login-extension-label">${escapeHtml(item.label)}</span>
          <span class="legacy-login-extension-description">${escapeHtml(item.description)}</span>
          ${renderLoginExtensionDraft(item.key)}
        </div>
      `).join('')}
    </div>
  `;
}

function renderLoginExtensionDraft(key: Parameters<typeof getAuthExtensionFields>[0]) {
  const fields = getAuthExtensionFields(key);
  return `
    <form
      class="legacy-login-extension-draft"
      data-auth-extension-draft="${key}"
      data-auth-extension-field-count="${fields.length}"
      hidden
      aria-hidden="true"
    >
      ${fields.map((field) => `
        <label class="legacy-login-extension-field" data-auth-extension-field="${escapeHtml(field.name)}">
          <span>${escapeHtml(field.label)}</span>
          <input
            name="${escapeHtml(field.name)}"
            type="${escapeHtml(field.type)}"
            ${field.inputMode ? `inputmode="${escapeHtml(field.inputMode)}"` : ''}
            ${field.autocomplete ? `autocomplete="${escapeHtml(field.autocomplete)}"` : ''}
            ${field.required ? 'required' : ''}
            disabled
          />
        </label>
      `).join('')}
    </form>
  `;
}

function formatAccessDate(value: string | null) {
  if (!value) return 'No expiry';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'No expiry';
  return parsed.toLocaleString('en-US');
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '-';
  return parsed.toLocaleString('en-US');
}

function formatUserRole(value: string | null) {
  if (!value) return '-';
  return value.toUpperCase();
}

function formatEmailVerificationStatus(state: AppState) {
  if (!state.session.isEmailVerified) {
    return 'Pending';
  }
  if (!state.session.emailVerifiedAt) {
    return 'Verified';
  }
  return `Verified on ${formatAccessDate(state.session.emailVerifiedAt)}`;
}

function formatBillingAmount(currencyCode: string, amountMinor: number) {
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount)) {
    return '-';
  }
  return `${String(currencyCode || '').trim().toUpperCase()} ${(amount / 100).toFixed(2)}`;
}

function getBillingOrderStatusLabel(status: AppState['billing']['orders'][number]['status']) {
  if (status === 'awaiting_payment') return 'Awaiting payment';
  if (status === 'paid') return 'Paid';
  if (status === 'failed') return 'Failed';
  if (status === 'expired') return 'Expired';
  if (status === 'cancelled') return 'Cancelled';
  return 'Pending';
}

function getAccessStatusLabel(state: AppState) {
  const status = state.session.accessStatus;
  if (!status) return 'Loading';
  if (status === 'revoked') return 'Revoked';
  if (status === 'inactive') return 'Inactive';
  if (state.session.accessIsExpired) return 'Expired';
  if (status === 'grace') return 'Grace';
  return 'Active';
}

function renderAccessSummary(state: AppState) {
  const statusLabel = getAccessStatusLabel(state);
  const expiryLabel = formatAccessDate(state.session.accessExpiresAt);
  const sourceLabel = state.session.accessSource ? state.session.accessSource.toUpperCase() : '-';
  const remainingLabel = state.session.accessDaysRemaining == null
    ? 'Unlimited'
    : `${state.session.accessDaysRemaining} day${state.session.accessDaysRemaining === 1 ? '' : 's'}`;

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-access">
      <div class="legacy-user-settings-card-head">
        <strong>Access</strong>
        <span>Current entitlement state for this account.</span>
      </div>
      <div class="summary-row">
        <span>Access status</span>
        <strong>${escapeHtml(statusLabel)}</strong>
      </div>
      <div class="summary-row">
        <span>Expires at</span>
        <strong>${escapeHtml(expiryLabel)}</strong>
      </div>
      <div class="summary-row">
        <span>Days remaining</span>
        <strong>${escapeHtml(remainingLabel)}</strong>
      </div>
      <div class="summary-row">
        <span>Access source</span>
        <strong>${escapeHtml(sourceLabel)}</strong>
      </div>
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        <button type="button" class="legacy-btn legacy-btn-primary" data-action="focus-billing-plans">OPEN BILLING</button>
      </div>
    </div>
  `;
}

function renderUserIdentitySummary(state: AppState) {
  return `
    <div class="auth-summary legacy-user-settings-card">
      <div class="legacy-user-settings-card-head">
        <strong>Account</strong>
        <span>Identity and verification details for the signed-in user.</span>
      </div>
      <div class="summary-row">
        <span>Username</span>
        <strong>${escapeHtml(state.session.username ?? '-')}</strong>
      </div>
      <div class="summary-row">
        <span>Email</span>
        <strong>${escapeHtml(state.session.email ?? '-')}</strong>
      </div>
      <div class="summary-row">
        <span>Role</span>
        <strong>${escapeHtml(formatUserRole(state.session.role))}</strong>
      </div>
      <div class="summary-row">
        <span>Email status</span>
        <strong>${escapeHtml(formatEmailVerificationStatus(state))}</strong>
      </div>
    </div>
  `;
}

function renderUserSecurityCard(state: AppState) {
  const otpStatus = state.session.isEmailVerified
    ? 'Login still requires the email verification code step.'
    : 'Verify the account email before using recovery and login features normally.';
  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide">
      <div class="legacy-user-settings-card-head">
        <strong>Security</strong>
        <span>Password changes revoke the current session and require a new login.</span>
      </div>
      <div class="summary-row">
        <span>Login verification</span>
        <strong>${escapeHtml(otpStatus)}</strong>
      </div>
      <div class="legacy-auth-panel-actions legacy-user-settings-actions">
        <button type="button" class="legacy-btn legacy-btn-primary" data-action="open-change-password-from-user-settings" ${state.ui.busy ? 'disabled' : ''}>CHANGE PASSWORD</button>
      </div>
    </div>
  `;
}

function renderBillingPlansCard(state: AppState) {
  const billingUnavailableMessage = !state.billing.loaded
    ? 'Loading billing options...'
    : !state.billing.enabled
      ? 'Billing is disabled in this environment.'
      : !state.billing.providerReady
        ? 'MoonPay Commerce credentials are not configured yet.'
        : state.billing.plans.length === 0
          ? 'No billing plans are configured yet.'
          : null;
  const billingHeading = state.billing.providerMocked
    ? 'Choose a plan and continue in the local mock checkout to simulate the payment.'
    : 'Choose a plan and continue in MoonPay Commerce to complete the payment.';

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide" data-role="billing-plans-card">
      <div class="legacy-user-settings-card-head">
        <strong>Billing</strong>
        <span>${escapeHtml(billingHeading)}</span>
      </div>
      ${state.billing.providerMocked ? `
        <div class="legacy-auth-panel-note">Local billing mock mode is active. Checkout and payment confirmation are simulated on this machine.</div>
      ` : ''}
      ${state.billing.error ? `
        <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.billing.error)}</div>
      ` : ''}
      ${billingUnavailableMessage ? `
        <div class="legacy-auth-panel-note">${escapeHtml(billingUnavailableMessage)}</div>
      ` : `
        <div class="legacy-billing-plan-grid">
          ${state.billing.plans.map((plan) => {
            const pending = state.billing.pendingPlanKey === plan.key;
            return `
              <div class="legacy-billing-plan-card ${plan.featured ? 'featured' : ''}">
                <div class="legacy-billing-plan-copy">
                  <strong>${escapeHtml(plan.label)}</strong>
                  <span>${escapeHtml(plan.description || `${plan.accessDays} days of product access`)}</span>
                </div>
                <div class="legacy-billing-plan-price">${escapeHtml(plan.priceDisplay || formatBillingAmount(plan.currencyCode, plan.amountMinor))}</div>
                <div class="legacy-billing-plan-meta">${plan.accessDays} day${plan.accessDays === 1 ? '' : 's'} access</div>
                ${plan.available ? '' : `<div class="legacy-auth-panel-note">${escapeHtml(plan.availabilityReason || 'Unavailable')}</div>`}
                <div class="legacy-auth-panel-actions legacy-user-settings-actions">
                  <button
                    type="button"
                    class="legacy-btn legacy-btn-primary"
                    data-action="start-billing-checkout"
                    data-plan-key="${escapeHtml(plan.key)}"
                    ${!plan.available || pending ? 'disabled' : ''}
                  >${pending ? 'OPENING...' : state.billing.providerMocked ? 'OPEN LOCAL CHECKOUT' : 'PAY WITH MOONPAY'}</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;
}

function renderPreAccessPlansCard(state: AppState) {
  const billingUnavailableMessage = !state.billing.loaded
    ? 'Loading billing options...'
    : !state.billing.enabled
      ? 'Billing is disabled in this environment.'
      : !state.billing.providerReady
        ? 'MoonPay Commerce credentials are not configured yet.'
        : state.billing.plans.length === 0
          ? 'No billing plans are configured yet.'
          : null;
  const billingHeading = state.billing.providerMocked
    ? 'Choose a plan and continue in the local mock checkout to simulate the payment.'
    : 'Choose a plan and continue in MoonPay Commerce to complete the payment.';

  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-pre-access-plans-card" data-role="billing-plans-card">
      <div class="legacy-user-settings-card-head legacy-pre-access-card-head">
        <strong>Access Plans</strong>
        <span>${escapeHtml(billingHeading)}</span>
      </div>
      ${state.billing.providerMocked ? `
        <div class="legacy-auth-panel-note">Local billing mock mode is active. Checkout and payment confirmation are simulated on this machine.</div>
      ` : ''}
      ${state.billing.error ? `
        <div class="legacy-auth-panel-note" data-state="error">${escapeHtml(state.billing.error)}</div>
      ` : ''}
      ${billingUnavailableMessage ? `
        <div class="legacy-auth-panel-note">${escapeHtml(billingUnavailableMessage)}</div>
      ` : `
        <div class="legacy-billing-plan-grid">
          ${state.billing.plans.map((plan) => {
            const pending = state.billing.pendingPlanKey === plan.key;
            const descriptor = plan.featured
              ? 'Most balanced option'
              : plan.accessDays >= 30
                ? 'Longer runway with fewer renewals'
                : 'Fastest way to validate the workflow';
            return `
              <div class="legacy-billing-plan-card legacy-pre-access-plan-card ${plan.featured ? 'featured' : ''}">
                <div class="legacy-pre-access-plan-topline">
                  <span class="legacy-pre-access-plan-badge ${plan.featured ? 'featured' : ''}">${plan.featured ? 'POPULAR' : 'ACCESS PLAN'}</span>
                  <span class="legacy-pre-access-plan-duration">${plan.accessDays} day${plan.accessDays === 1 ? '' : 's'}</span>
                </div>
                <div class="legacy-billing-plan-copy">
                  <strong>${escapeHtml(plan.label)}</strong>
                  <span>${escapeHtml(plan.description || descriptor)}</span>
                </div>
                <div class="legacy-billing-plan-price">${escapeHtml(plan.priceDisplay || formatBillingAmount(plan.currencyCode, plan.amountMinor))}</div>
                <div class="legacy-billing-plan-meta">${escapeHtml(descriptor)}</div>
                ${plan.available ? '' : `<div class="legacy-auth-panel-note">${escapeHtml(plan.availabilityReason || 'Unavailable')}</div>`}
                <div class="legacy-auth-panel-actions legacy-user-settings-actions">
                  <button
                    type="button"
                    class="legacy-btn legacy-btn-primary"
                    data-action="start-pre-access-checkout"
                    data-plan-key="${escapeHtml(plan.key)}"
                    ${!plan.available || pending || state.session.accessHasProductAccess ? 'disabled' : ''}
                  >${pending ? 'OPENING...' : state.billing.providerMocked ? 'OPEN LOCAL CHECKOUT' : 'CONTINUE TO CHECKOUT'}</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;
}

function renderBillingOrdersCard(state: AppState) {
  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide">
      <div class="legacy-user-settings-card-head">
        <strong>Billing History</strong>
        <span>Recent checkout attempts and completed payments for this account.</span>
      </div>
      ${state.billing.orders.length === 0 ? `
        <div class="legacy-auth-panel-note">No billing orders yet.</div>
      ` : `
        <div class="legacy-billing-order-list">
          ${state.billing.orders.map((order) => `
            <div class="legacy-billing-order-row">
              <div class="legacy-billing-order-main">
                <strong>${escapeHtml(order.planName)}</strong>
                <span>${escapeHtml(getBillingOrderStatusLabel(order.status))} • ${escapeHtml(formatBillingAmount(order.currencyCode, order.currencyAmountMinor))}</span>
              </div>
              <div class="legacy-billing-order-side">
                <span>${escapeHtml(order.paidAt ? formatDateTime(order.paidAt) : formatDateTime(order.createdAt))}</span>
                ${order.providerCheckoutUrl && order.status !== 'paid' ? `
                  <button type="button" class="legacy-userbar-link" data-action="resume-billing-checkout" data-checkout-url="${escapeHtml(order.providerCheckoutUrl)}">Resume Checkout</button>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderPreAccessOrdersCard(state: AppState) {
  return `
    <div class="auth-summary legacy-user-settings-card legacy-user-settings-card-wide legacy-pre-access-orders-card">
      <div class="legacy-user-settings-card-head legacy-pre-access-card-head">
        <strong>Checkout History</strong>
        <span>Recent pre-access checkout attempts and confirmed payments for this account.</span>
      </div>
      ${state.billing.orders.length === 0 ? `
        <div class="legacy-auth-panel-note">No billing orders yet.</div>
      ` : `
        <div class="legacy-billing-order-list">
          ${state.billing.orders.map((order) => `
            <div class="legacy-billing-order-row">
              <div class="legacy-billing-order-main">
                <strong>${escapeHtml(order.planName)}</strong>
                <span>${escapeHtml(getBillingOrderStatusLabel(order.status))} • ${escapeHtml(formatBillingAmount(order.currencyCode, order.currencyAmountMinor))}</span>
              </div>
              <div class="legacy-billing-order-side">
                <span>${escapeHtml(order.paidAt ? formatDateTime(order.paidAt) : formatDateTime(order.createdAt))}</span>
                ${order.providerCheckoutUrl && order.status !== 'paid' ? `
                  <button type="button" class="legacy-userbar-link" data-action="resume-pre-access-checkout" data-checkout-url="${escapeHtml(order.providerCheckoutUrl)}">Resume Checkout</button>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function renderUserSettingsModal(state: AppState) {
  return renderProfileModalShell({
    panel: 'user-settings',
    title: 'User Settings',
    description: 'Review account access, identity state, and security actions without mixing them into bot config.',
    labelId: 'user-settings-title',
    panelClass: 'legacy-auth-panel-user-settings',
    content: `
      <div class="legacy-user-settings-grid">
        ${renderUserIdentitySummary(state)}
        ${renderAccessSummary(state)}
        ${renderUserSecurityCard(state)}
        ${renderBillingPlansCard(state)}
        ${renderBillingOrdersCard(state)}
      </div>
    `,
  });
}

function renderBotSettingsModal(state: AppState) {
  return renderProfileModalShell({
    panel: 'bot-settings',
    title: 'Bot Settings',
    description: 'Adjust alerts, thresholds, sound behavior, and operator preferences for your workspace.',
    labelId: 'bot-settings-title',
    panelClass: 'legacy-auth-panel-settings',
    content: `
      <div class="legacy-config-grid legacy-config-grid-modal">
        ${renderBotSettingsFields(state)}
      </div>
    `,
  });
}

function renderBotSettingsFields(state: AppState) {
  return `
    ${CONFIG_FIELDS.map((field) => renderConfigField(state, field)).join('')}
    <div class="config-item config-item-sound">
      <label>Sound alert</label>
      <select name="sound-mode">
        <option value="on">Enabled</option>
        <option value="off">Disabled</option>
      </select>
    </div>
    ${renderOldSurgeThresholdMenu(state)}
    ${renderConfigToggleMenu(state, 'Alert toggles', 'Choose which alert types can fire', ALERT_TOGGLE_FIELDS)}
    ${renderConfigToggleMenu(state, 'Sound by alert type', 'Choose which alert types can play sound', SOUND_TOGGLE_FIELDS)}
    ${state.session.role === 'admin' ? renderAdminChainField(state) : ''}
    <div class="legacy-sound-row">
      <div class="config-item config-item-sound config-item-sound-volume">
        <label>Sound volume: ${Math.round(state.ui.soundVolume * 100)}%</label>
        <input name="sound-volume" class="legacy-volume-slider" type="range" min="0" max="100" step="1" />
      </div>
      ${renderSoundUploadStrip(state)}
    </div>
  `;
}

function renderBlockedTokensModal(state: AppState) {
  return renderProfileModalShell({
    panel: 'blocked-tokens',
    title: 'Blocked Tokens',
    description: 'Tokens hidden from your workspace and alert flow.',
    labelId: 'blocked-tokens-title',
    panelClass: 'legacy-auth-panel-blocklist',
    content: `
      <div class="blocked-tokens-modal-list">
        ${state.data.blocklist.length === 0 ? `
          <div class="blocked-token-empty">No blocked tokens right now.</div>
        ` : state.data.blocklist.map((item) => `
          <div class="blocked-token-row">
            <div class="blocked-token-main">
              ${renderBlockedTokenAvatar(state, item.address, item.label || item.address.slice(0, 8))}
              <div class="blocked-token-copy">
                <strong>${escapeHtml(item.label || item.address.slice(0, 8))}</strong>
                <span>${escapeHtml(item.address)}</span>
              </div>
            </div>
            <button type="button" class="legacy-user-dd-item blocked-token-unblock" data-action="remove-blocked" data-address="${escapeHtml(item.address)}">Unblock</button>
          </div>
        `).join('')}
      </div>
    `,
  });
}

function renderBlockedTokenAvatar(state: AppState, address: string, fallbackLabel: string) {
  const tracked = getTrackedToken(state, address);
  const imageUrl = sanitizeOptionalHttpUrl(tracked?.imageUrl);
  const safeLabel = escapeHtml(String(fallbackLabel || '').trim() || address.slice(0, 8));
  if (imageUrl) {
    return `<img src="${imageUrl}" alt="${safeLabel}" class="blocked-token-avatar" />`;
  }
  return `<div class="blocked-token-avatar blocked-token-avatar-placeholder">${safeLabel.slice(0, 2).toUpperCase()}</div>`;
}

function renderChangePasswordModal(state: AppState) {
  const currentPasswordError = state.ui.error === 'Current password is required.'
    || state.ui.error === 'Current password is incorrect';
  const newPasswordError = state.ui.error === 'New password is required.'
    || state.ui.error === 'New password must be at least 8 characters.'
    || state.ui.error === 'New password must be different from the current password.';
  const confirmNewPasswordError = state.ui.error === 'Please confirm the new password.'
    || state.ui.error === 'The new passwords do not match. Please check them and try again.';
  return renderProfileModalShell({
    panel: 'change-password',
    title: 'Change Password',
    description: 'Update your account password. You will need to sign in again after the change.',
    labelId: 'change-password-title',
    content: `
      <div class="legacy-auth-panel-feedback" data-auth-slot="feedback">${renderChangePasswordFlash(state)}</div>
      <form class="legacy-auth-panel-form" data-role="change-password-form">
        <label>
          <span>Current password</span>
          <div class="legacy-password-wrap">
            <input name="currentPassword" type="password" autocomplete="current-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${currentPasswordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
            <button type="button" class="legacy-password-toggle" data-action="toggle-current-password-visibility" tabindex="-1" ${state.ui.busy ? 'disabled' : ''}>Show</button>
          </div>
        </label>
        <label>
          <span>New password</span>
          <div class="legacy-password-wrap">
            <input name="newPassword" type="password" autocomplete="new-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${newPasswordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
            <button type="button" class="legacy-password-toggle" data-action="toggle-new-password-visibility" tabindex="-1" ${state.ui.busy ? 'disabled' : ''}>Show</button>
          </div>
        </label>
        <label>
          <span>Confirm new password</span>
          <div class="legacy-password-wrap">
            <input name="confirmNewPassword" type="password" autocomplete="new-password" maxlength="${LOGIN_PASSWORD_MAX_LENGTH}" class="${confirmNewPasswordError ? 'field-error' : ''}" ${state.ui.busy ? 'disabled' : ''} required />
            <button type="button" class="legacy-password-toggle" data-action="toggle-confirm-new-password-visibility" tabindex="-1" ${state.ui.busy ? 'disabled' : ''}>Show</button>
          </div>
        </label>
        <div class="legacy-auth-panel-actions">
          <button type="button" class="legacy-userbar-link" data-action="close-profile-modal" ${state.ui.busy ? 'disabled' : ''}>Cancel</button>
          <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'UPDATING...' : 'UPDATE PASSWORD'}</button>
        </div>
      </form>
    `,
  });
}

function bindChangePasswordPanel(section: ParentNode, controller: AppController, state: AppState) {
  const form = section.querySelector<HTMLFormElement>('form[data-role="change-password-form"]');
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="change-password"]');
  bindFocusTrap(panel);
  section.querySelectorAll<HTMLButtonElement>('.legacy-auth-panel-feedback [data-action="dismiss-flash"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.ui.error) controller.clearError();
      else controller.clearNotice();
    });
  });

  const toggleVisibility = (
    inputName: 'currentPassword' | 'newPassword' | 'confirmNewPassword',
    action: 'toggle-current-password-visibility' | 'toggle-new-password-visibility' | 'toggle-confirm-new-password-visibility',
  ) => {
    form?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const input = form.querySelector<HTMLInputElement>(`input[name="${inputName}"]`);
      if (!input) {
        return;
      }
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? 'Hide' : 'Show';
      input.focus();
      if (start !== null && end !== null) {
        window.requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(start, end);
        });
      }
    });
    form?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
  };

  toggleVisibility('currentPassword', 'toggle-current-password-visibility');
  toggleVisibility('newPassword', 'toggle-new-password-visibility');
  toggleVisibility('confirmNewPassword', 'toggle-confirm-new-password-visibility');

  const clearFeedbackOnEdit = () => {
    if (isChangePasswordErrorMessage(state.ui.error ?? '')
      || isChangePasswordNoticeMessage(state.ui.notice ?? '')) {
      controller.clearError();
      controller.clearNotice();
    }
  };

  form?.querySelectorAll<HTMLInputElement>('input[name="currentPassword"], input[name="newPassword"], input[name="confirmNewPassword"]').forEach((input) => {
    input.addEventListener('input', clearFeedbackOnEdit);
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    void controller.changePassword(
      String(data.get('currentPassword') || ''),
      String(data.get('newPassword') || ''),
      String(data.get('confirmNewPassword') || ''),
    );
  });
}

function bindUserSettingsPanel(section: ParentNode, controller: AppController) {
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="user-settings"]');
  if (!panel) {
    return;
  }

  bindFocusTrap(panel);
  section.querySelector<HTMLButtonElement>('[data-action="focus-billing-plans"]')?.addEventListener('click', () => {
    section.querySelector<HTMLElement>('[data-role="billing-plans-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  section.querySelector<HTMLButtonElement>('[data-action="open-change-password-from-user-settings"]')?.addEventListener('click', () => {
    controller.openAuthPanel('change-password');
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="start-billing-checkout"]').forEach((button) => {
    button.addEventListener('click', () => {
      const planKey = button.dataset.planKey;
      if (!planKey) {
        return;
      }
      void controller.startBillingCheckout(planKey).catch(() => {});
    });
  });
  section.querySelectorAll<HTMLButtonElement>('[data-action="resume-billing-checkout"]').forEach((button) => {
    button.addEventListener('click', () => {
      const checkoutUrl = button.dataset.checkoutUrl;
      if (!checkoutUrl) {
        return;
      }
      window.open(checkoutUrl, '_blank', 'noopener');
    });
  });
}

function bindBotSettingsPanel(section: ParentNode, controller: AppController, state: AppState) {
  const configSection = section.querySelector<HTMLElement>('.legacy-config-grid-modal');
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="bot-settings"]');
  if (!configSection || !panel) {
    return;
  }

  bindFocusTrap(panel);
  hydrateLegacyConfigValues(configSection, state);

  configSection.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach((input) => {
    const name = input.name;
    if (name === 'sound-mode' || name === 'sound-volume') {
      return;
    }
    input.addEventListener('change', () => void submitLegacyConfig(configSection, controller));
  });

  configSection.querySelector<HTMLSelectElement>('select[name="sound-mode"]')?.addEventListener('change', (event) => {
    controller.setSoundEnabled((event.currentTarget as HTMLSelectElement).value !== 'off');
  });

  const volumeInput = configSection.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  const volumeLabel = volumeInput?.closest('.config-item')?.querySelector('label');
  volumeInput?.addEventListener('input', (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value || '0');
    if (volumeLabel) volumeLabel.textContent = `Sound volume: ${value}%`;
    controller.setSoundVolume(value / 100);
  });

  bindConfigToggleMenus(configSection, controller);
  bindSoundUploadStrip(configSection, state);

  configSection.querySelectorAll<HTMLElement>('.config-toggle-list-scroll').forEach((list) => {
    if (list.dataset.wheelBound === 'true') {
      return;
    }
    list.dataset.wheelBound = 'true';
    list.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      list.scrollTop += event.deltaY;
    }, { passive: false });
  });
}

function bindBlockedTokensPanel(section: ParentNode, controller: AppController) {
  const panel = section.querySelector<HTMLElement>('[data-auth-panel="blocked-tokens"]');
  if (!panel) {
    return;
  }

  bindFocusTrap(panel);
  section.querySelectorAll<HTMLButtonElement>('[data-action="remove-blocked"]').forEach((button) => {
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) {
        void controller.removeBlockedToken(address);
      }
    });
  });
}

function bindRegisterPanel(section: ParentNode, controller: AppController, state: AppState) {
  const form = section.querySelector<HTMLFormElement>('form[data-role="register-form"]');
  if (!form) {
    return;
  }
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="register"]'));

  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-register-panel"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
  section.querySelectorAll<HTMLButtonElement>('.legacy-auth-panel-feedback [data-action="dismiss-flash"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.ui.error) controller.clearError();
      else controller.clearNotice();
    });
  });

  const usernameInput = form.querySelector<HTMLInputElement>('input[name="username"]');
  const emailInput = form.querySelector<HTMLInputElement>('input[name="registerEmail"]');
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="registerPassword"]');
  const confirmPasswordInput = form.querySelector<HTMLInputElement>('input[name="registerConfirmPassword"]');
  const inviteInput = form.querySelector<HTMLInputElement>('input[name="inviteCode"]');
  const inviteStatus = form.querySelector<HTMLElement>('[data-role="register-invite-status"]');
  const toggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-register-password-visibility"]');
  const confirmToggle = form.querySelector<HTMLButtonElement>('[data-action="toggle-register-confirm-password-visibility"]');

  const setInviteStatus = (message: string, mode: 'idle' | 'ok' | 'error' = 'idle') => {
    if (!inviteStatus) {
      return;
    }
    inviteStatus.textContent = message;
    inviteStatus.dataset.state = mode;
  };

  const clearFeedbackOnEdit = () => {
    if (shouldClearAuthFeedbackOnEdit(state.ui.error, state.ui.notice)) {
      controller.clearError();
      controller.clearNotice();
    }
  };

  const sanitizeRegisterEmailInput = () => {
    if (!emailInput) {
      return;
    }
    const rawValue = emailInput.value;
    const nextValue = sanitizeLoginEmailValue(rawValue);
    if (nextValue === rawValue) {
      return;
    }
    const caret = emailInput.selectionStart;
    emailInput.value = nextValue;
    const nextCaret = adjustCaretAfterEmailSanitize(rawValue, caret);
    emailInput.setSelectionRange(nextCaret, nextCaret);
  };

  const clampRegisterPassword = () => {
    if (!passwordInput && !confirmPasswordInput) {
      return;
    }
    [passwordInput, confirmPasswordInput].forEach((input) => {
      if (!input) return;
      const nextValue = clampLoginPasswordValue(input.value);
      if (nextValue !== input.value) {
        const caret = Math.min(input.selectionStart ?? nextValue.length, nextValue.length);
        input.value = nextValue;
        input.setSelectionRange(caret, caret);
      }
    });
  };

  toggle?.addEventListener('click', () => {
    if (!passwordInput) {
      return;
    }
    const selectionStart = passwordInput.selectionStart;
    const selectionEnd = passwordInput.selectionEnd;
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    toggle.textContent = visible ? 'Hide' : 'Show';
    passwordInput.focus();
    if (selectionStart !== null && selectionEnd !== null) {
      window.requestAnimationFrame(() => {
        passwordInput.focus();
        passwordInput.setSelectionRange(selectionStart, selectionEnd);
      });
    }
  });
  toggle?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  confirmToggle?.addEventListener('click', () => {
    if (!confirmPasswordInput) {
      return;
    }
    const selectionStart = confirmPasswordInput.selectionStart;
    const selectionEnd = confirmPasswordInput.selectionEnd;
    const visible = confirmPasswordInput.type === 'password';
    confirmPasswordInput.type = visible ? 'text' : 'password';
    confirmToggle.textContent = visible ? 'Hide' : 'Show';
    confirmPasswordInput.focus();
    if (selectionStart !== null && selectionEnd !== null) {
      window.requestAnimationFrame(() => {
        confirmPasswordInput.focus();
        confirmPasswordInput.setSelectionRange(selectionStart, selectionEnd);
      });
    }
  });
  confirmToggle?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  usernameInput?.addEventListener('input', clearFeedbackOnEdit);
  emailInput?.addEventListener('input', () => {
    clearFeedbackOnEdit();
    sanitizeRegisterEmailInput();
  });
  emailInput?.addEventListener('paste', () => {
    window.requestAnimationFrame(sanitizeRegisterEmailInput);
  });
  passwordInput?.addEventListener('input', () => {
    clearFeedbackOnEdit();
    clampRegisterPassword();
  });
  confirmPasswordInput?.addEventListener('input', () => {
    clearFeedbackOnEdit();
    clampRegisterPassword();
  });
  inviteInput?.addEventListener('input', () => {
    clearFeedbackOnEdit();
    setInviteStatus('Invite code is required for account creation.', 'idle');
  });

  inviteInput?.addEventListener('blur', () => {
    const code = String(inviteInput.value || '').trim();
    inviteInput.value = code;
    if (!code || state.ui.busy) {
      return;
    }
    setInviteStatus('Checking invite code...', 'idle');
    void controller.validateInvite(code)
      .then((result) => {
        if (inviteInput.value.trim() !== code) {
          return;
        }
        if (result.valid) {
          setInviteStatus('Invite code looks valid.', 'ok');
          return;
        }
        setInviteStatus(result.reason || 'Invite code is not valid.', 'error');
      })
      .catch(() => {
        setInviteStatus('Unable to validate invite code right now.', 'error');
      });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    void controller.register({
      username: String(data.get('username') || ''),
      email: String(data.get('registerEmail') || ''),
      password: String(data.get('registerPassword') || ''),
      confirmPassword: String(data.get('registerConfirmPassword') || ''),
      inviteCode: String(data.get('inviteCode') || ''),
    });
  });
}

function bindInviteAssistancePanel(section: ParentNode, controller: AppController, state: AppState) {
  const form = section.querySelector<HTMLFormElement>('form[data-role="invite-assistance-form"]');
  if (!form) {
    return;
  }
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="invite-assistance"]'));

  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-invite-assistance-panel"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });

  const inviteInput = form.querySelector<HTMLInputElement>('input[name="assistanceInviteCode"]');
  const status = form.querySelector<HTMLElement>('[data-role="invite-assistance-status"]');
  const summary = form.querySelector<HTMLElement>('[data-role="invite-assistance-summary"]');

  const setStatus = (message: string, mode: 'idle' | 'ok' | 'error') => {
    if (!status) {
      return;
    }
    status.textContent = message;
    status.dataset.state = mode;
  };

  const setSummary = (message: string) => {
    if (summary) {
      summary.textContent = message;
    }
  };

  const validateInvite = () => {
    const code = String(inviteInput?.value || '').trim();
    if (!inviteInput) {
      return;
    }
    inviteInput.value = code;
    if (!code || state.ui.busy) {
      setStatus('Paste an invite code to check whether it is still valid.', 'idle');
      setSummary(INVITE_SECURITY_WARNING);
      return;
    }

    setStatus('Checking invite code...', 'idle');
    void controller.validateInvite(code)
      .then((result) => {
        if (inviteInput.value.trim() !== code) {
          return;
        }
        if (result.valid) {
          setStatus('Invite code is valid and ready to use.', 'ok');
          setSummary(INVITE_SECURITY_WARNING);
          return;
        }

        const reason = result.reason || 'Invite code is not valid.';
        setStatus(reason, 'error');
        if (reason.includes('expired')) {
          setSummary(INVITE_SECURITY_WARNING);
          return;
        }
        if (reason.includes('revoked')) {
          setSummary(INVITE_SECURITY_WARNING);
          return;
        }
        if (reason.includes('max uses')) {
          setSummary(INVITE_SECURITY_WARNING);
          return;
        }
        if (reason.includes('not found')) {
          setSummary(INVITE_SECURITY_WARNING);
          return;
        }
        setSummary(INVITE_SECURITY_WARNING);
      })
      .catch(() => {
        setStatus('Unable to validate invite code right now.', 'error');
        setSummary(INVITE_SECURITY_WARNING);
      });
  };

  inviteInput?.addEventListener('input', () => {
    setStatus('Paste an invite code to check whether it is still valid.', 'idle');
    setSummary(INVITE_SECURITY_WARNING);
  });
  inviteInput?.addEventListener('blur', validateInvite);
}

function bindEmailVerificationPanel(section: ParentNode, controller: AppController, state: AppState) {
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="email-verification"]'));
  const closePanel = () => {
    controller.closeAuthPanel();
    controller.clearNotice();
  };
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-email-verification-panel"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
  const form = section.querySelector<HTMLFormElement>('form[data-role="email-verification-form"]');
  if (!form) {
    return;
  }

  form.querySelector<HTMLInputElement>('input[name="verificationEmail"]')?.addEventListener('input', () => {
    if (shouldClearAuthFeedbackOnEdit(state.ui.error, state.ui.notice) || state.ui.notice === 'Sending verification email...') {
      controller.clearError();
      controller.clearNotice();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    void controller.requestEmailVerification(String(data.get('verificationEmail') || '').trim());
  });
}

function bindPasswordChangeSuccessPanel(section: ParentNode, controller: AppController) {
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="password-change-success"]'));
  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-password-change-success"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
}

function bindEmailVerifiedSuccessPanel(section: ParentNode, controller: AppController) {
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="email-verified-success"]'));
  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-email-verified-success"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
}

function bindEmailOtpPanel(section: ParentNode, controller: AppController, state: AppState) {
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="email-otp"]'));
  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-email-otp-panel"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
  section.querySelectorAll<HTMLButtonElement>('.legacy-auth-panel-feedback [data-action="dismiss-flash"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.ui.error) controller.clearError();
      else controller.clearNotice();
    });
  });

  const form = section.querySelector<HTMLFormElement>('form[data-role="email-otp-form"]');
  const codeInput = form?.querySelector<HTMLInputElement>('input[name="emailOtpCode"]');
  codeInput?.addEventListener('input', () => {
    const digitsOnly = String(codeInput.value || '').replace(/\D+/g, '').slice(0, 6);
    if (digitsOnly !== codeInput.value) {
      codeInput.value = digitsOnly;
    }
    if (
      state.ui.error === 'Verification code is required.'
      || state.ui.error === 'Enter the 6-digit verification code.'
      || state.ui.error?.includes('Verification code is incorrect')
      || state.ui.error?.includes('Verification code is invalid or expired')
      || state.ui.error?.includes('Too many invalid verification attempts')
      || state.ui.notice === 'Sending verification code...'
      || state.ui.notice === 'Verifying code...'
    ) {
      controller.clearError();
      controller.clearNotice();
    }
  });

  section.querySelector<HTMLButtonElement>('[data-action="resend-email-otp"]')?.addEventListener('click', () => {
    void controller.resendLoginOtp();
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    void controller.verifyLoginOtp(String(data.get('emailOtpCode') || ''));
  });
}

function bindPasswordResetPanel(section: ParentNode, controller: AppController, state: AppState) {
  bindFocusTrap(section.querySelector<HTMLElement>('[data-auth-panel="password-reset"]'));
  const closePanel = () => controller.closeAuthPanel();
  section.querySelectorAll<HTMLButtonElement>('[data-action="close-password-reset-panel"]').forEach((button) => {
    button.addEventListener('click', closePanel);
  });
  section.querySelectorAll<HTMLButtonElement>('.legacy-auth-panel-feedback [data-action="dismiss-flash"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.ui.error) controller.clearError();
      else controller.clearNotice();
    });
  });

  const form = section.querySelector<HTMLFormElement>('form[data-role="password-reset-form"]');
  form?.querySelector<HTMLButtonElement>('[data-action="toggle-reset-password-visibility"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const input = form.querySelector<HTMLInputElement>('input[name="resetNewPassword"]');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    input.focus();
    if (start !== null && end !== null) {
      window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start, end);
      });
    }
  });
  form?.querySelector<HTMLButtonElement>('[data-action="toggle-reset-password-visibility"]')?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  form?.querySelector<HTMLButtonElement>('[data-action="toggle-reset-confirm-password-visibility"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const input = form.querySelector<HTMLInputElement>('input[name="resetConfirmNewPassword"]');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    input.focus();
    if (start !== null && end !== null) {
      window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start, end);
      });
    }
  });
  form?.querySelector<HTMLButtonElement>('[data-action="toggle-reset-confirm-password-visibility"]')?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  form?.querySelectorAll<HTMLInputElement>('input[name="resetEmail"], input[name="resetNewPassword"], input[name="resetConfirmNewPassword"]').forEach((input) => {
    input.addEventListener('input', () => {
      if (shouldClearAuthFeedbackOnEdit(state.ui.error, state.ui.notice)
        || state.ui.error === 'Reset link is missing or invalid.'
        || state.ui.notice === 'Set a new password to finish the reset.'
        || state.ui.notice === 'Sending password reset email...'
        || state.ui.notice === 'Resetting password...') {
        controller.clearError();
        controller.clearNotice();
      }
    });
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.ui.busy) {
      return;
    }
    const data = new FormData(form);
    if (state.ui.pendingPasswordResetToken) {
      void controller.confirmPasswordReset(
        String(data.get('resetNewPassword') || ''),
        String(data.get('resetConfirmNewPassword') || ''),
      );
      return;
    }
    void controller.requestPasswordReset(String(data.get('resetEmail') || '').trim());
  });
}

function isConfigEnabled(state: AppState, key: string) {
  return String(state.data.configs[key] ?? 'on') !== 'off';
}

function renderOldSurgeThresholdMenu(state: AppState) {
  const value1h = Number(state.data.configs['old-alert-1h-threshold'] ?? 50);
  const value6h = Number(state.data.configs['old-alert-6h-threshold'] ?? 150);
  return `
    <div class="config-item config-item-menu">
      <label>
        <span>Surge threshold</span>
        <span class="config-help-hover" tabindex="0" aria-label="What is Surge alert?">
          <span class="config-help-trigger">?</span>
          <span class="config-help-panel">
            Surge is the alert for older routed tokens. It fires when a token in the routed old-token buckets reaches the configured 1H or 6H price-change threshold during the current session.
          </span>
        </span>
      </label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="old-surge-threshold">${Math.round(value1h)}% / ${Math.round(value6h)}%</button>
        <div class="sort-menu-dropdown config-menu-dropdown config-threshold-dropdown">
          <div class="config-threshold-grid">
            <div class="config-threshold-field">
              <span>1H</span>
              <input type="number" min="0" name="old-alert-1h-threshold" />
            </div>
            <div class="config-threshold-field">
              <span>6H</span>
              <input type="number" min="0" name="old-alert-6h-threshold" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderConfigToggleMenu(
  state: AppState,
  label: string,
  summaryLabel: string,
  fields: ReadonlyArray<{ key: string; label: string }>,
) {
  const enabledCount = fields.filter((field) => isConfigEnabled(state, field.key)).length;
  const safeLabel = escapeHtml(label);
  const safeSummaryLabel = escapeHtml(summaryLabel);
  const safeToggleKey = escapeHtml(label.toLowerCase().replace(/\s+/g, '-'));
  const isSoundAlertTypeMenu = safeToggleKey === 'sound-by-alert-type';
  const listClass = safeToggleKey === 'sound-by-alert-type'
    ? 'config-toggle-list config-toggle-list-scroll'
    : 'config-toggle-list';
  const dropdownClass = isSoundAlertTypeMenu
    ? 'sort-menu-dropdown config-menu-dropdown config-menu-dropdown-scroll'
    : 'sort-menu-dropdown config-menu-dropdown';
  return `
    <div class="config-item config-item-menu">
      <label>${safeLabel}</label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="${safeToggleKey}">${enabledCount}/${fields.length} on</button>
        <div class="${dropdownClass}">
          <div class="config-menu-summary">${safeSummaryLabel}</div>
          <div class="${listClass}">
            ${fields.map((field) => {
              const enabled = isConfigEnabled(state, field.key);
              return `
                <button
                  type="button"
                  class="config-toggle-item ${enabled ? 'active' : ''}"
                  data-config-toggle-key="${escapeHtml(field.key)}"
                  data-config-toggle-next="${enabled ? 'off' : 'on'}"
                >
                  <span>${escapeHtml(field.label)}</span>
                  <span class="config-toggle-state">${enabled ? 'ON' : 'OFF'}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSoundUploadStrip(state: AppState) {
  const scope = state.session.email || state.session.username || 'anonymous';
  const old1hThreshold = Number(state.data.configs['old-alert-1h-threshold'] ?? 50);
  const old6hThreshold = Number(state.data.configs['old-alert-6h-threshold'] ?? 150);
  const slots: Array<{ slot: CustomSoundSlot; title: string; sub: string; dot: string }> = [
    { slot: 'normal', title: 'Sound Level Normal', sub: '(+50%) / MP3/WAV/OGG', dot: 'sound-dot normal' },
    { slot: 'critical', title: 'Sound Level Critical', sub: '(+100%) / MP3/WAV/OGG', dot: 'sound-dot critical' },
    { slot: 'mega', title: 'Sound Level Mega', sub: '(+200%) / MP3/WAV/OGG', dot: 'sound-dot mega' },
    { slot: 'old1h', title: 'Surge + MET Alert 1h', sub: `(+${Math.round(old1hThreshold)}%) / MP3/WAV/OGG`, dot: 'sound-dot old1h' },
    { slot: 'old6h', title: 'Surge Alert 6h', sub: `(+${Math.round(old6hThreshold)}%) / MP3/WAV/OGG`, dot: 'sound-dot old6h' },
  ];

  return `
    <div class="legacy-sound-strip">
      ${slots.map(({ slot, title, sub, dot }) => {
        const asset = loadCustomSoundAsset(scope, slot);
        return `
          <div class="legacy-sound-item">
            <div class="legacy-sound-head"><span class="${dot}"></span><span>${escapeHtml(title)}</span></div>
            <div class="legacy-sound-sub">${escapeHtml(sub)}</div>
            <div class="legacy-sound-picker">
              <label class="legacy-file-btn">
                Escolher arquivo
                <input type="file" accept="audio/*" data-sound-slot="${escapeHtml(slot)}" />
              </label>
            </div>
            <div class="legacy-sound-meta">${escapeHtml(asset?.name || 'Default (tone)')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function bindSoundUploadStrip(section: HTMLElement, state: AppState) {
  const scope = state.session.email || state.session.username || 'anonymous';
  section.querySelectorAll<HTMLInputElement>('input[type="file"][data-sound-slot]').forEach((input) => {
    input.addEventListener('click', () => {
      input.value = '';
    });
    input.addEventListener('change', () => {
      const slot = input.dataset.soundSlot as CustomSoundSlot | undefined;
      const file = input.files?.[0];
      if (!slot || !file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        saveCustomSoundAsset(scope, slot, { name: file.name, dataUrl });
        const label = input.closest('.legacy-sound-item')?.querySelector<HTMLElement>('.legacy-sound-meta');
        if (label) label.textContent = file.name;
      };
      reader.readAsDataURL(file);
    });
  });
}

function bindConfigToggleMenus(section: HTMLElement, controller: AppController) {
  const persistWrapDraft = (wrap: HTMLElement) => {
    if (wrap.dataset.configDirty !== 'true') {
      return;
    }

    const payload: Record<string, string> = {};
    wrap.querySelectorAll<HTMLButtonElement>('[data-config-toggle-key]').forEach((button) => {
      const key = button.dataset.configToggleKey;
      if (!key) {
        return;
      }
      payload[key] = button.classList.contains('active') ? 'on' : 'off';
    });

    wrap.dataset.configDirty = 'false';
    if (Object.keys(payload).length > 0) {
      void controller.saveMonitoringConfig(payload);
    }
  };

  const updateWrapSummary = (wrap: HTMLElement) => {
    const toggleButton = wrap.querySelector<HTMLButtonElement>('.config-menu-button');
    const items = wrap.querySelectorAll<HTMLButtonElement>('[data-config-toggle-key]');
    if (!toggleButton || items.length === 0) {
      return;
    }
    const enabledCount = [...items].filter((item) => item.classList.contains('active')).length;
    toggleButton.textContent = `${enabledCount}/${items.length} on`;
  };

  section.querySelectorAll<HTMLElement>('.config-menu-wrap').forEach((wrap) => {
    const observer = new MutationObserver(() => {
      if (!wrap.classList.contains('open')) {
        persistWrapDraft(wrap);
      }
    });
    observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
  });

  section.querySelectorAll<HTMLButtonElement>('[data-config-toggle-key]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wrap = button.closest<HTMLElement>('.config-menu-wrap');
      if (!wrap) {
        return;
      }

      const isActive = button.classList.contains('active');
      button.classList.toggle('active', !isActive);
      button.dataset.configToggleNext = isActive ? 'on' : 'off';
      const stateLabel = button.querySelector<HTMLElement>('.config-toggle-state');
      if (stateLabel) {
        stateLabel.textContent = isActive ? 'OFF' : 'ON';
      }
      wrap.dataset.configDirty = 'true';
      updateWrapSummary(wrap);
    });
  });
}

async function submitLegacyConfig(section: HTMLElement, controller: AppController) {
  const inputs = section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]');
  const payload: Record<string, number | string> = {};

  for (const input of inputs) {
    const key = input.name;
    if (!key) continue;
    if (input instanceof HTMLSelectElement) {
      payload[key] = input.value;
      continue;
    }
    if (input.type === 'range' || input.type === 'number') {
      payload[key] = Number(input.value || '0');
      continue;
    }
    payload[key] = input.value;
  }

  await controller.saveMonitoringConfig(payload);
}

function renderLegacyActions(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'btn-row legacy-action-row workspace-flash-row';
  section.innerHTML = `
    ${renderDashboardFlash(state)}
  `;

  section.querySelector<HTMLButtonElement>('[data-action="dismiss-flash"]')?.addEventListener('click', () => controller.clearNotice());
  return section;
}

function renderConfigField(_state: AppState, field: { key: string; label: string; type?: 'number' | 'text'; min?: number; placeholder?: string }) {
  const type = field.type ?? 'number';
  const safeLabel = escapeHtml(field.label);
  const safeType = escapeHtml(type);
  const safeKey = escapeHtml(field.key);
  const safePlaceholder = field.placeholder ? escapeHtml(field.placeholder) : null;

  return `
    <div class="config-item">
      <label>${safeLabel}</label>
      <input type="${safeType}" name="${safeKey}" ${field.min != null ? `min="${field.min}"` : ''} ${safePlaceholder ? `placeholder="${safePlaceholder}"` : ''}>
    </div>
  `;
}

function renderAdminChainField(_state: AppState) {
  return `
    <div class="config-item">
      <label>Chain</label>
      <select name="chain">
        ${['solana', 'ethereum', 'bsc', 'base'].map((chain) => `<option value="${escapeHtml(chain)}">${escapeHtml(capitalize(chain))}</option>`).join('')}
      </select>
    </div>
  `;
}

function resolveConfigInputValue(state: AppState, field: { key: string; type?: 'number' | 'text' }) {
  const type = field.type ?? 'number';
  const value = state.data.configs[field.key];
  if (value == null || value === '') {
    return String(defaultConfigValue(field.key, type));
  }
  return String(value);
}

function hydrateLegacyConfigValues(section: HTMLElement, state: AppState) {
  for (const field of CONFIG_FIELDS) {
    const input = section.querySelector<HTMLInputElement>(`input[name="${CSS.escape(field.key)}"]`);
    if (!input) {
      continue;
    }
    input.value = resolveConfigInputValue(state, field);
  }

  const soundMode = section.querySelector<HTMLSelectElement>('select[name="sound-mode"]');
  if (soundMode) {
    soundMode.value = state.ui.soundEnabled ? 'on' : 'off';
  }

  const soundVolume = section.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  if (soundVolume) {
    soundVolume.value = String(Math.round(state.ui.soundVolume * 100));
  }

  const oldAlert1h = section.querySelector<HTMLInputElement>('input[name="old-alert-1h-threshold"]');
  if (oldAlert1h) {
    oldAlert1h.value = String(Math.round(Number(state.data.configs['old-alert-1h-threshold'] ?? 50)));
  }

  const oldAlert6h = section.querySelector<HTMLInputElement>('input[name="old-alert-6h-threshold"]');
  if (oldAlert6h) {
    oldAlert6h.value = String(Math.round(Number(state.data.configs['old-alert-6h-threshold'] ?? 150)));
  }

  const chainSelect = section.querySelector<HTMLSelectElement>('select[name="chain"]');
  if (chainSelect) {
    chainSelect.value = String(state.data.configs.chain || 'solana').trim().toLowerCase() || 'solana';
  }
}

function defaultConfigValue(key: string, type: 'number' | 'text') {
  if (type === 'text') {
    return key === 'chain' ? 'solana' : '';
  }

  const defaults: Record<string, number> = {
    threshold: 50,
    'mcap-threshold': 50,
    'min-vol': 5000,
    'min-mcap': 30000,
    'max-mcap': 0,
    'hvnc-min-vol': 300000,
    'old-alert-1h-threshold': 50,
    'old-alert-6h-threshold': 150,
    'meteora-alert-1h-threshold': 50,
    'old-mcap-max': 100000000,
    'old-week-mcap-max': 100000000,
  };
  return String(defaults[key] ?? 0);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
